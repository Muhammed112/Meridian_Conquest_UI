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
const db = getFirestore(),
  key = defineSecret('GEMINI_API_KEY');
const model = defineString('GEMINI_MODEL', {
  description: 'Gemini model enabled for your project; for example gemini-3.8-flash',
});
export const narrateBattle = onDocumentCreated(
  {
    document: 'users/{uid}/games/{gameId}/events/{eventId}',
    region: 'europe-west1',
    secrets: [key],
    retry: true,
    maxInstances: 2,
    concurrency: 4,
    timeoutSeconds: 90,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data || !isNarratedEventType(data.type)) return;
    const ref = event.data.ref.parent.parent.collection('commentary').doc(event.params.eventId);
    const lease = randomUUID(),
      now = Date.now();
    const claimed = await db.runTransaction(async (tx) => {
      const old = (await tx.get(ref)).data();
      if (old?.status === 'ready' || old?.status === 'fallback') return false;
      if (old?.leaseUntil > now) throw new Error('Commentary is already being processed');
      tx.set(ref, { status: 'pending', lease, leaseUntil: now + 120000 });
      return true;
    });
    if (!claimed) return;
    try {
      const context = parseCommentaryContext(data.context);
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model.value()) +
          ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.value() },
          signal: AbortSignal.timeout(45000),
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
      const result = await response.json();
      const text = cleanCommentary(
        result.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join(''),
      );
      await finish({ status: 'ready', text, model: model.value() });
    } catch (error) {
      const age = Date.now() - Date.parse(event.time);
      if (error.retryable !== false && age < 10 * 60 * 1000) {
        await finish({ status: 'retrying', leaseUntil: 0 });
        throw new Error('Commentary will retry', { cause: error });
      }
      await finish({
        status: 'fallback',
        text: '',
        reason: 'Commentary unavailable; factual report retained.',
      });
    }
    async function finish(patch) {
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.lease === lease)
          tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      });
    }
  },
);
