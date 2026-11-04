import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { randomUUID } from 'node:crypto';
import {
  isNarratedEventType,
  COMMENTARY_INSTRUCTIONS,
  parseCommentaryContext,
  cleanCommentary,
} from './commentary.js';
initializeApp();
// Optional paid-backend alternative; the Spark browser app does not deploy this trigger.
const LEASE_DURATION_MS = 120_000;
const RETRY_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45_000;
const db = getFirestore(),
  geminiApiKey = defineSecret('GEMINI_API_KEY');
const geminiModel = defineString('GEMINI_MODEL', {
  description: 'Gemini model enabled for your project; for example gemini-3.8-flash',
});
export const narrateBattle = onDocumentCreated(
  {
    document: 'users/{uid}/games/{gameId}/events/{eventId}',
    region: 'europe-west1',
    secrets: [geminiApiKey],
    retry: true,
    maxInstances: 2,
    concurrency: 4,
    timeoutSeconds: 90,
  },
  async function narrateSavedEvent(event) {
    // Trigger delivery is not proof of a valid game move; this worker only narrates stored facts.
    const eventData = event.data?.data();
    if (!eventData || !isNarratedEventType(eventData.type)) return;
    const commentaryRef = event.data.ref.parent.parent
      .collection('commentary')
      .doc(event.params.eventId);
    const leaseId = randomUUID(),
      now = Date.now();
    // Firestore triggers can be delivered more than once. Only one worker holds the lease.
    const claimed = await db.runTransaction(async (tx) => {
      const previousReport = (await tx.get(commentaryRef)).data();
      if (previousReport?.status === 'ready' || previousReport?.status === 'fallback') return false;
      if (previousReport?.leaseUntil > now)
        throw new Error('Commentary is already being processed');
      tx.set(commentaryRef, {
        status: 'pending',
        lease: leaseId,
        leaseUntil: now + LEASE_DURATION_MS,
      });
      return true;
    });
    if (!claimed) return;
    try {
      const context = parseCommentaryContext(eventData.context);
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(geminiModel.value()) +
          ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey.value() },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: COMMENTARY_INSTRUCTIONS }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }],
            generationConfig: { maxOutputTokens: 512, temperature: 0.6 },
          }),
        },
      );
      if (!response.ok) {
        const error = new Error('Gemini request failed');
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      // Thinking parts are internal model output and must never become visible commentary.
      const result = await response.json();
      const text = cleanCommentary(
        result.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join(''),
      );
      await finishReport({ status: 'ready', text, model: geminiModel.value() });
    } catch (error) {
      // Retry transient failures for a bounded period, then leave the factual report available.
      const age = Date.now() - Date.parse(event.time);
      if (error.retryable !== false && age < RETRY_WINDOW_MS) {
        await finishReport({ status: 'retrying', leaseUntil: 0 });
        throw new Error('Commentary will retry', { cause: error });
      }
      await finishReport({
        status: 'fallback',
        text: '',
        reason: 'Commentary unavailable; factual report retained.',
      });
    }
    // A delayed worker must not overwrite the report after another worker claims its lease.
    async function finishReport(patch) {
      await db.runTransaction(async (tx) => {
        const currentReport = (await tx.get(commentaryRef)).data();
        if (currentReport?.lease === leaseId)
          tx.update(commentaryRef, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      });
    }
  },
);
