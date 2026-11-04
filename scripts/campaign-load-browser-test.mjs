import { firebaseCliAuth } from './firebase-admin-access.mjs';
import { chromium } from './lib/browser.mjs';
// Read-only reproduction of a saved campaign in an isolated browser profile.
// Firebase administrator credentials and campaign data remain in memory.
import assert from 'node:assert/strict';

import { startTestServer } from './lib/static-server.mjs';
import { installCampaignFixture } from './lib/campaign-fixture.mjs';
import { committedHistory } from '../dist/campaign-history.js';

const cli = firebaseCliAuth();
const account = cli.getGlobalDefaultAccount(),
  token = (
    await cli.getAccessToken(account.tokens.refresh_token, [
      'https://www.googleapis.com/auth/cloud-platform',
    ])
  ).access_token;
const gamePath = process.env.CAMPAIGN_TEST_PATH;
assert.match(
  gamePath || '',
  /^users\/[A-Za-z0-9_-]+\/games\/[A-Za-z0-9_-]+$/,
  'Set CAMPAIGN_TEST_PATH to users/<owner uid>/games/<campaign id>',
);
const base =
  'https://firestore.googleapis.com/v1/projects/meridian-conquest-m112/databases/(default)/documents/' +
  gamePath;
/** Read the explicitly selected private test campaign; no administrator writes are made. */
async function read(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  assert.ok(res.ok, data.error?.message);
  return data;
}
// Fetch only the explicitly selected campaign; subsequent rendering uses a local copy of these facts.
const [document, history] = await Promise.all([
  read(base),
  read(base + ':runQuery', {
    structuredQuery: {
      from: [{ collectionId: 'events' }],
      orderBy: [{ field: { fieldPath: 'sequence' }, direction: 'ASCENDING' }],
    },
  }),
]);
const game = JSON.parse(document.fields.payload.stringValue);
const records = history
  .filter((row) => row.document)
  .map(({ document }) => {
    const fields = document.fields;
    return {
      event: JSON.parse(fields.payload.stringValue),
      sequence: Number(fields.sequence.integerValue),
      ...(fields.previousEventId
        ? { previousEventId: fields.previousEventId.stringValue || null }
        : {}),
    };
  });
// Staged or abandoned event branches are not part of the board's committed replay.
game.events = committedHistory(
  records,
  document.fields.historyHead ? document.fields.historyHead.stringValue || null : undefined,
).map((record) => record.event);
let browser;
const server = await startTestServer();
try {
  browser = await chromium.launch({
    headless: true,
  });
  const page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.addInitScript(
    (game) => localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game])),
    game,
  );
  const origin = 'http://localhost:' + server.address().port;
  await page.goto(origin + '/#campaigns');
  await page.locator('.campaign-card').waitFor();
  assert.ok((await page.locator('.campaign-card').innerText()).includes(game.name));
  await page.locator(`a[href="#game/${game.id}"]`).click();
  await page.locator('.game-heading').waitFor();
  await page.reload();
  await page.locator('.game-heading').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `PASS: existing saved campaign renders its card, board and reload with ${game.events.length} events`,
  );
  await page.close();
  // Replay the same saved data through the real lazy-loading store with a fake SDK, never live writes.
  const cloudPage = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  cloudPage.on('pageerror', (error) => errors.push(error.message));
  await installCampaignFixture(cloudPage, [game]);
  await cloudPage.goto(origin + '/#campaigns');
  await cloudPage.locator('.campaign-card').waitFor();
  assert.equal(await cloudPage.evaluate(() => window.historyReads.length), 0);
  await cloudPage.evaluate((id) => {
    window.historyModes[id] = 'hold';
  }, game.id);
  // A replay exercises lazy loading without advancing any turns in the fixture.
  await cloudPage.locator(`a[href="#history/${game.id}"]`).click();
  await cloudPage.locator('section[role="status"]').waitFor();
  assert.equal(await cloudPage.evaluate(() => window.campaignWrites), 0);
  await cloudPage.evaluate((id) => {
    window.historyModes[id] = 'fail';
  }, game.id);
  await cloudPage.locator('[data-action="retry-campaign-history"]').waitFor();
  assert.equal(await cloudPage.evaluate(() => window.campaignWrites), 0);
  await cloudPage.evaluate((id) => {
    window.historyModes[id] = 'ready';
  }, game.id);
  await cloudPage.locator('[data-action="retry-campaign-history"]').click();
  const cachedCount = () =>
    JSON.parse(localStorage.getItem('meridian-cloud-cache-quality-review'))?.[0]?.events.length;
  await cloudPage.waitForFunction(cachedCount);
  assert.equal(await cloudPage.evaluate(cachedCount), game.events.length);
  await cloudPage.reload();
  await cloudPage.waitForFunction(cachedCount);
  assert.equal(await cloudPage.evaluate(cachedCount), game.events.length);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: selected history loads on demand, retries failures and retains complete recovery data',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
