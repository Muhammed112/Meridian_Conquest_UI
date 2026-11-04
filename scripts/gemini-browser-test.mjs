import { firebaseCliAuth } from './firebase-admin-access.mjs';
import { chromium } from './lib/browser.mjs';
// Real Gemini integration check with one temporary user and a short-lived
// App Check debug attestation. No key or token is printed or saved to disk.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { startTestServer } from './lib/static-server.mjs';
import { firebaseConfig as config } from '../dist/firebase-config.js';
import { aiConfig } from '../dist/ai-config.js';
import { GameEngine } from '../dist/engine.js';
import { completeCampaignOpening } from './lib/setup.mjs';
const cli = firebaseCliAuth();

const account = cli.getGlobalDefaultAccount(),
  admin = (
    await cli.getAccessToken(account.tokens.refresh_token, [
      'https://www.googleapis.com/auth/cloud-platform',
    ])
  ).access_token;
const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
const appCheck = /* prettier-ignore */ `https://firebaseappcheck.googleapis.com/v1/projects/126865630748/apps/${
  encodeURIComponent(config.appId)
}`;
// These fixture fields are deliberately simple legacy scalars, encoded as Firestore REST values.
const fields = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v },
    ]),
  );
let user, browser, server, debugName, gamePath;
const debugToken = randomUUID(),
  errors = [];
let requests = 0;
const gamePaths = new Set();
/** Assert live API responses while restricting fixtures to this test’s temporary account. */
async function api(url, { method = 'GET', token, body, status = 200 } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  const accepted = Array.isArray(status) ? status : [status];
  assert.ok(
    accepted.includes(response.status),
    `${new URL(url).pathname}: ${data.error?.message || response.status} (HTTP ${response.status})`,
  );
  return data;
}
/** Confirm the asynchronous save reached Firestore rather than a browser's local view. */
async function waitForSavedCampaign(path) {
  const deadline = Date.now() + 30000;
  do {
    const record = await api(base + '/' + path, { token: user.idToken, status: [200, 404] });
    if (record.fields) return record;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.fail('The new campaign did not reach Firestore within thirty seconds.');
}
const auth = (action, body) =>
  api(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`, {
    method: 'POST',
    body,
  });
try {
  // Temporary debug attestation avoids headless reCAPTCHA trust issues without disabling enforcement.
  if (!process.env.GEMINI_TEST_STANDARD_APPCHECK) {
    const debug = await api(appCheck + '/debugTokens', {
      method: 'POST',
      token: admin,
      body: { displayName: 'Temporary Gemini integration check', token: debugToken },
    });
    debugName = debug.name;
  }
  const credentials = {
    email: `meridian-gemini-${randomUUID()}@example.invalid`,
    password: randomUUID() + 'Aa1!',
    returnSecureToken: true,
  };
  user = await auth('signUp', credentials);
  const game = GameEngine.create('Gemini integration check', 'ZA', true);
  game.round = 1;
  game.position = game.order.indexOf(0);
  game.turnStarted = false;
  game.events = [];
  const engine = new GameEngine(game);
  engine.beginTurn();
  engine.event('decision', 'South Africa prepares to challenge an opposing country.');
  const { events, ...board } = game;
  gamePath = `users/${user.localId}/games/${game.id}`;
  gamePaths.add(gamePath);
  await api(base + '/' + gamePath, {
    method: 'PATCH',
    token: user.idToken,
    body: { fields: fields({ payload: JSON.stringify(board), updatedAt: game.updatedAt }) },
  });
  for (const [sequence, event] of events.entries())
    await api(base + '/' + gamePath + '/events/' + event.id, {
      method: 'PATCH',
      token: user.idToken,
      body: {
        fields: fields({
          sequence,
          type: event.type,
          context: JSON.stringify({ event }),
          payload: JSON.stringify(event),
        }),
      },
    });
  // Seed an older report to verify new narration can coexist with saved history without rewriting it.
  const legacyText = 'South Africa prepares an attack.',
    legacyEvent = events.at(-1);
  await api(base + '/' + gamePath + '/aiReports/' + legacyEvent.id, {
    method: 'PATCH',
    token: admin,
    body: {
      fields: fields({
        eventId: legacyEvent.id,
        eventType: legacyEvent.type,
        text: legacyText,
        status: 'ready',
        source: 'gemini',
        model: 'gemini-3.5-flash-lite',
        authorUid: user.localId,
      }),
    },
  });
  server = await startTestServer();
  browser = await chromium.launch({
    headless: true,
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript(
    (token) => {
      if (token) window.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
      if (localStorage.getItem('meridian-ai-commentary') === null)
        localStorage.setItem('meridian-ai-commentary', 'off');
      Math.random = () => 0.01;
    },
    process.env.GEMINI_TEST_STANDARD_APPCHECK ? null : debugToken,
  );
  page.on('request', async (request) => {
    if (
      request.url().includes('firebasevertexai.googleapis.com') &&
      request.url().includes('generateContent')
    ) {
      console.log('Gemini request started.');
      const headers = await request.allHeaders().catch(() => null);
      if (!headers) return;
      if (!headers['x-firebase-appcheck'] || !headers.authorization?.startsWith('Firebase '))
        errors.push({ request: 'Missing AI request attestation or sign-in' });
    }
  });
  page.on('response', async (response) => {
    if (
      [
        'firebasevertexai.googleapis.com',
        'firebaseappcheck.googleapis.com',
        'firebaseinstallations.googleapis.com',
      ].includes(new URL(response.url()).host)
    ) {
      if (response.status() >= 400) {
        const data = await response.json().catch(() => ({}));
        errors.push({ status: response.status(), message: data.error?.message });
        console.log('Gemini/Firebase request error:', response.status(), data.error?.message);
      }
    }
    if (
      response.url().includes('firebasevertexai.googleapis.com') &&
      response.url().includes('generateContent')
    )
      requests++;
  });
  page.on('pageerror', (error) => errors.push({ browser: error.message }));
  page.on('requestfailed', (request) => {
    if (request.url().includes('gstatic.com/firebasejs'))
      errors.push({
        request: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      });
  });
  const origin = process.env.GEMINI_TEST_ORIGIN || 'http://localhost:' + server.address().port;
  await page.goto(origin + '/#signin');
  try {
    await page.waitForFunction(() => {
      const submit = document.querySelector('#auth-form button[type="submit"]');
      return submit && !submit.disabled;
    });
  } catch (error) {
    const detail = await page.evaluate(async () => {
      try {
        const { connectCloud } = await import('./cloud.js');
        await connectCloud({ onSession() {}, onCommentary() {}, onError() {} });
        return 'connected';
      } catch (error) {
        return error.message;
      }
    });
    console.log('Sign-in initialization:', JSON.stringify(errors), detail);
    throw error;
  }
  await page.locator('#email').fill(credentials.email);
  await page.locator('#password').fill(credentials.password);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.waitForURL('**/#campaigns');
  await page.locator(`a[href="#game/${game.id}"]`).first().waitFor();
  await page.goto(origin + '/#game/' + game.id);
  try {
    await page.locator('[data-action="start-attack"]').waitFor();
  } catch (error) {
    console.log(
      'Campaign display:',
      await page.locator('#app').innerText(),
      JSON.stringify(errors),
    );
    throw error;
  }
  assert.equal(requests, 0);
  console.log('PASS: loading a saved campaign does not generate historical commentary');
  await page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
  await page.locator('.activity-copy .ai-commentary').filter({ hasText: legacyText }).waitFor();
  await page.locator('[data-action="settings"]').click();
  assert.equal(await page.locator('#ai-enabled').isChecked(), false);
  await page.locator('#ai-enabled').check();
  await page.locator('[data-action="close-settings"]').click();
  try {
    await page.waitForFunction(
      ({ uid, eventId }) =>
        JSON.parse(localStorage.getItem('meridian-cloud-cache-' + uid))?.some((game) =>
          game.events.some((event) => event.id === eventId && event.commentaryVersion === 2),
        ),
      { uid: user.localId, eventId: legacyEvent.id },
      { timeout: 120000 },
    );
  } catch (error) {
    console.log('Gemini response errors:', JSON.stringify(errors));
    await page.locator('[data-action="settings"]').click();
    console.log('AI status:', await page.locator('#ai-status').textContent());
    throw error;
  }
  const legacy = await api(base + '/' + gamePath + '/aiReports/' + legacyEvent.id, {
    token: user.idToken,
  });
  assert.equal(legacy.fields.text.stringValue, legacyText);
  console.log(
    'PASS: enabling commentary in Settings starts narration and preserves the legacy report',
  );
  await page.getByRole('tab', { name: 'Field reports', exact: true }).click();
  await page.locator('[data-action="start-attack"]').click();
  await page.evaluate(async () => {
    const { BattleEngine } = await import('./engine.js');
    const original = BattleEngine.resolve;
    BattleEngine.resolve = (attacker, defender) => {
      BattleEngine.resolve = original;
      const values = [1, 6, 6, 1, 6, 1, 3, 3];
      return original(attacker, defender, () => values.shift() || 3);
    };
  });
  await page.locator('[data-action="roll"]').click();
  assert.match(await page.locator('.action-panel').innerText(), /Results appear when they settle/);
  assert.doesNotMatch(
    await page.locator('[data-report-panel="field"] .activity-feed').innerText(),
    /loses 1|loses 2/,
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.action-panel .commentary')
      ?.textContent.includes('South Africa lost 1'),
  );
  console.log('PASS: army losses and field reports reveal only after the dice settle');
  const diceEventId = await page.evaluate(
    ({ uid, gameId }) =>
      JSON.parse(localStorage.getItem('meridian-cloud-cache-' + uid))
        ?.find((game) => game.id === gameId)
        ?.events.findLast((event) => event.type === 'dice')?.id,
    { uid: user.localId, gameId: game.id },
  );
  assert.ok(diceEventId, 'The battle must save its factual dice event');
  await page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
  const waitForDiceCommentary = () =>
    page.waitForFunction(
      (eventId) =>
        [...document.querySelectorAll('[data-commentary-event]')].some(
          (node) =>
            node.dataset.commentaryEvent === eventId && node.textContent.includes('AI commentary:'),
        ),
      diceEventId,
      { timeout: 90000 },
    );
  try {
    await waitForDiceCommentary();
  } catch (error) {
    console.log('Gemini response errors:', JSON.stringify(errors));
    await page.locator('[data-action="settings"]').click();
    console.log('AI status:', await page.locator('#ai-status').textContent());
    throw error;
  }
  const reports = await api(base + '/' + gamePath + '/aiReportsV2', { token: user.idToken });
  for (const eventId of [legacyEvent.id, diceEventId])
    assert.ok(
      reports.documents.some((doc) => doc.fields.eventId.stringValue === eventId),
      'The upgraded legacy report and priority-selected dice report must both be saved',
    );
  assert.ok(
    reports.documents.every(
      (doc) =>
        doc.fields.model.stringValue === aiConfig.model &&
        doc.fields.narrationVersion.integerValue === '2',
    ),
  );
  console.log(
    'PASS: real Gemini narrates the selected battle event and saves it separately from the game',
  );
  const committed = await api(base + '/' + gamePath, { token: user.idToken });
  assert.ok(Number(committed.fields.saveRevision.integerValue) >= 1);
  assert.ok(committed.fields.historyHead.stringValue);
  const lastFact = await api(
    base + '/' + gamePath + '/events/' + committed.fields.historyHead.stringValue,
    { token: user.idToken },
  );
  assert.ok(lastFact.fields.previousEventId);
  console.log('PASS: live saves upgrade legacy history to a revision and committed event chain');
  for (const doc of reports.documents)
    console.log(
      'New commentary [' + doc.fields.eventType.stringValue + ']:',
      doc.fields.text.stringValue,
    );
  // Removing the recovery cache proves report reuse comes from Firestore, not a stale in-memory page.
  const previous = requests;
  await page.evaluate(
    (uid) => localStorage.removeItem('meridian-cloud-cache-' + uid),
    user.localId,
  );
  await page.reload();
  await page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
  await waitForDiceCommentary();
  assert.equal(requests, previous);
  console.log('PASS: reload reuses saved Gemini reports without new generation');
  await page.locator('[data-action="settings"]').click();
  await page.locator('#ai-enabled').uncheck();
  await page.locator('[data-action="close-settings"]').click();
  await page.locator('[data-action="roll"]').click();
  assert.equal(requests, previous);
  console.log('PASS: commentary can be turned off while battle controls keep working');

  await page.goto(origin + '/#campaigns');
  await page.locator(`[data-action="share"][data-id="${game.id}"]`).click();
  const stopSharing = page.locator(`[data-action="stop-sharing"][data-id="${game.id}"]`);
  await stopSharing.waitFor();
  // Anonymous viewing must expose the published copy only, with neither move controls nor AI requests.
  const guestContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const guest = await guestContext.newPage();
  let guestModelRequests = 0;
  guest.on('request', (request) => {
    if (request.url().includes('generateContent')) guestModelRequests++;
  });
  await guest.goto(origin + '/#live/' + game.id);
  await guest.locator('.country-row').first().waitFor();
  assert.equal(await guest.locator('.country-row').count(), 10);
  assert.equal(await guest.locator('[data-action="roll"],[data-action="start-attack"]').count(), 0);
  assert.equal(guestModelRequests, 0);
  if (await page.locator('#help-dialog[open]').count())
    await page.locator('[data-action="close-help"]').click();
  await stopSharing.click();
  await guest.waitForFunction(() => document.querySelectorAll('.country-row').length === 0);
  await guestContext.close();
  console.log(
    'PASS: anonymous live viewing has no move controls or AI requests; revocation removes access',
  );

  await page.goto(origin + '/#setup');
  await page.locator('#session-name').fill('New save release check');
  await completeCampaignOpening(page);
  await page.locator('[data-action="create-game"]').click();
  await page.waitForURL(/#game\//);
  const createdId = new URL(page.url()).hash.split('/')[1];
  const createdPath = `users/${user.localId}/games/${createdId}`;
  gamePaths.add(createdPath);
  // Wait for a server-confirmed save before clearing local recovery; optimistic SDK state is insufficient.
  const created = await waitForSavedCampaign(createdPath);
  assert.ok(Number(created.fields.saveRevision.integerValue) >= 1);
  await page.evaluate(
    (uid) => localStorage.removeItem('meridian-cloud-cache-' + uid),
    user.localId,
  );
  await page.reload();
  await page.locator('.game-heading').waitFor();
  assert.match(await page.locator('.game-heading').innerText(), /New save release check/);
  console.log(
    'PASS: a new campaign saves and resumes from Firebase with its browser cache removed',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  // Delete only tracked fixture paths, then revoke the disposable user and temporary attestation.
  // Independently attempt credential cleanup even when a document deletion fails.
  let failure;
  try {
    for (const gamePath of gamePaths) {
      await api(base + '/liveGames/' + gamePath.split('/').at(-1), {
        method: 'DELETE',
        token: admin,
      });
      for (const group of ['events', 'aiReports', 'aiReportsV2', 'commentary']) {
        const result = await api(base + '/' + gamePath + '/' + group + '?pageSize=100', {
          token: admin,
        });
        for (const doc of result.documents || [])
          await api('https://firestore.googleapis.com/v1/' + doc.name, {
            method: 'DELETE',
            token: admin,
          });
      }
      await api(base + '/' + gamePath, { method: 'DELETE', token: admin });
    }
  } catch (error) {
    failure = error;
  }
  if (user)
    try {
      await auth('delete', { idToken: user.idToken });
    } catch (error) {
      failure ??= error;
    }
  if (debugName)
    try {
      await api('https://firebaseappcheck.googleapis.com/v1/' + debugName, {
        method: 'DELETE',
        token: admin,
      });
    } catch (error) {
      failure ??= error;
    }
  if (failure) {
    console.error('Test fixture cleanup failed:', failure.message);
    process.exitCode = 1;
  }
  console.log('Temporary campaign, reports, account and test attestation removed.');
}
