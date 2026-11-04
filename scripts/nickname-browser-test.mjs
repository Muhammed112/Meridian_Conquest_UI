import { firebaseCliAuth } from './firebase-admin-access.mjs';
import { chromium } from './lib/browser.mjs';
// Live integration using two temporary accounts; cleanup touches only its fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { startTestServer } from './lib/static-server.mjs';
import { firebaseConfig as config } from '../dist/firebase-config.js';

const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
const users = [],
  games = [],
  errors = [];
let browser,
  server,
  roomCode = '',
  admin;
/** Bound live fixture requests and report status/path without exposing account credentials. */
async function api(url, { method = 'GET', body, token, status = 200 } = {}) {
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
  assert.equal(
    response.status,
    status,
    `${method} ${new URL(url).pathname}: HTTP ${response.status}`,
  );
  return data;
}
const auth = (action, body) =>
  api(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`, {
    method: 'POST',
    body,
  });
try {
  const cli = firebaseCliAuth(),
    account = cli.getGlobalDefaultAccount();
  admin = (
    await cli.getAccessToken(account.tokens.refresh_token, [
      'https://www.googleapis.com/auth/cloud-platform',
    ])
  ).access_token;
  for (let i = 0; i < 2; i++) {
    const credentials = {
      email: `meridian-nickname-${randomUUID()}@example.invalid`,
      password: randomUUID() + 'Aa1!',
      returnSecureToken: true,
    };
    const user = await auth('signUp', credentials);
    users.push({ ...user, credentials });
    await auth('update', { idToken: user.idToken, displayName: 'Original nickname' });
  }
  server = await startTestServer();
  const origin = 'http://localhost:' + server.address().port;
  browser = await chromium.launch({
    headless: true,
  });
  // Markup-like punctuation must survive as the exact nickname without becoming HTML in any view.
  const names = ["Goat <Ace> & 'One'", 'Night Owl'],
    pages = [];
  let aiRequests = 0;
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({
        viewport: { width: i ? 390 : 1440, height: i ? 844 : 1000 },
        ignoreHTTPSErrors: true,
      }),
      page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('generateContent')) aiRequests++;
    });
    await page.addInitScript(() => {
      localStorage.setItem('meridian-ai-commentary', 'off');
      Math.random = () => 0;
      // One-byte opening rolls are fixed at one for bots and the friend; UUIDs and room codes stay random.
      const original = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = (bytes) => {
        if (bytes.length === 1) {
          bytes[0] = 0;
          return bytes;
        }
        return original(bytes);
      };
    });
    await page.goto(origin + '/#signin');
    await page.waitForFunction(() => {
      const button = document.querySelector('#auth-form button[type="submit"]');
      return button && !button.disabled;
    });
    await page.locator('#email').fill(users[i].credentials.email);
    await page.locator('#password').fill(users[i].credentials.password);
    await page.locator('#auth-form button[type="submit"]').click();
    await page.waitForURL(/#(?:campaigns|tutorial)/);
    // Fresh accounts enter guided practice; skip it before testing account-wide settings.
    await page.locator('[data-action="tutorial-skip"]').click();
    await page.getByRole('heading', { name: 'No campaigns in sight.', exact: true }).waitFor();
    await page.locator('[data-action="settings"]').click();
    await page.locator('#player-nickname').fill('  ');
    await page.locator('#nickname-form button').click();
    await page.locator('#nickname-status').filter({ hasText: '2 and 32' }).waitFor();
    await page.locator('#player-nickname').fill(names[i]);
    await page.locator('#nickname-form button').click();
    await page.waitForFunction(
      (name) => document.querySelector('.account-name')?.textContent === name,
      names[i],
    );
    await page.locator('[data-action="close-settings"]').click();
    await page.reload();
    await page.waitForFunction(
      (name) => document.querySelector('.account-name')?.textContent === name,
      names[i],
    );
    await page.locator('[data-action="account"]').click();
    assert.equal(await page.locator('#player-nickname').inputValue(), names[i]);
    await page.locator('[data-action="close-settings"]').click();
  }
  console.log(
    'PASS: desktop/mobile nicknames save to Firebase, validate whitespace,' +
      ' persist after reload, and open from the profile',
  );
  const [host, friend] = pages;
  // Hash navigation retains the ready cloud session while switching to campaign setup.
  await host.evaluate(() => {
    location.hash = 'setup';
  });
  await host.locator('#session-name').fill('Temporary nickname campaign');
  await host.locator('[data-action="create-game"]').click();
  await host.locator('.game-heading').waitFor();
  const gameId = new URL(host.url()).hash.split('/')[1],
    gamePath = `users/${users[0].localId}/games/${gameId}`;
  games.push(gamePath);
  await host.waitForFunction(
    (name) => document.querySelector('.turn-order')?.textContent.includes(name),
    names[0],
  );
  assert.match(await host.locator('.country-roster').innerText(), /Goat <Ace> & 'One'/);
  assert.equal(await host.locator('.country-roster ace').count(), 0);
  // Read the saved account-owned document, not just local UI text, to prove the nickname persisted.
  let record;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      record = await api(base + '/' + gamePath, { token: admin });
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.equal(JSON.parse(record.fields.payload.stringValue).playerNames[0], names[0]);
  console.log(
    'PASS: single-player roster, saved campaign and turn report use the account' +
      ' nickname as plain text',
  );
  for (const page of pages) {
    await page.goto(origin + '/#multiplayer');
    await page.locator('[data-room-form="create"]').waitFor();
  }
  assert.match(await host.locator('.notice').first().innerText(), /Goat <Ace> & 'One'/);
  await host
    .locator('[data-room-form="create"] input[name="name"]')
    .fill('Temporary nickname room');
  await host.locator('[data-room-form="create"] button').click();
  await host.locator('.room-code-bar strong').waitFor();
  roomCode = await host.locator('.room-code-bar strong').innerText();
  await friend.locator('[data-room-form="join"] input[name="code"]').fill(roomCode);
  await friend.locator('[data-room-form="join"] button').click();
  for (const page of pages) {
    await page.waitForFunction(
      (names) =>
        names.every((name) => document.querySelector('.room-seats')?.textContent.includes(name)),
      names,
    );
  }
  // Exercise current setup so nickname checks reach the same board players see after opening rolls.
  for (const [page, country] of [
    [host, 'ZA'],
    [friend, 'JP'],
  ]) {
    await page.locator('#room-starting-country').fill(country);
    await page.locator('[data-room-form="country"] button').click();
    const other = page === host ? friend : host;
    await other.waitForFunction(
      (country) => !document.querySelector(`#room-country-options option[label="${country}"]`),
      country,
    );
  }
  await host.locator('[data-room-action="prepare"]:enabled').click();
  for (const page of pages) await page.locator('.room-opening-grid').waitFor();
  // Bots have now rolled ones; force only the host's human roll to six for a deterministic turn report.
  await host.evaluate(() => {
    const original = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (bytes) => {
      if (bytes.length === 1) {
        bytes[0] = 5;
        return bytes;
      }
      return original(bytes);
    };
  });
  await host.locator('[data-room-action="opening-roll"]').click();
  // Wait for both clients to redraw each remote result before using the next player's controls.
  for (const page of pages)
    await page.locator('.room-opening-grid .room-seat').nth(0).locator('.die').waitFor();
  await friend.locator('[data-room-action="opening-roll"]').click();
  for (const page of pages)
    await page.locator('.room-opening-grid .room-seat').nth(1).locator('.die').waitFor();
  await host.locator('[data-room-action="start"]').click();
  for (const page of pages) {
    await page.locator('.turn-order').waitFor();
    assert.ok((await page.locator('.turn-order').innerText()).includes(names[0]));
    assert.ok((await page.locator('.turn-order').innerText()).includes(names[1]));
    assert.ok((await page.locator('.country-roster').innerText()).includes(names[0]));
    assert.ok(
      (await page.locator('[data-report-panel="field"] .activity-feed').innerText()).includes(
        names[0],
      ),
    );
    assert.equal(await page.locator('.turn-order ace').count(), 0);
    assert.equal(await page.locator('.country-roster ace').count(), 0);
  }
  console.log(
    'PASS: host and friend nicknames carry over automatically to both lobbies,' +
      ' turn orders, ownership labels and reports',
  );
  await host.locator('[data-action="settings"]').click();
  // A failed profile write must retain the last saved nickname instead of showing an unsaved rename.
  await host.route('**/v1/accounts:update?*', (route) => route.abort('failed'));
  await host.locator('#player-nickname').fill('Failed rename');
  await host.locator('#nickname-form button').click();
  await host.locator('#nickname-status').filter({ hasText: 'could not be saved' }).waitFor();
  assert.equal(await host.locator('.account-name').innerText(), names[0]);
  assert.deepEqual(errors, []);
  assert.equal(aiRequests, 0);
  console.log(
    'PASS: failed profile writes retain the saved nickname; no browser errors or AI requests',
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  /** Check exact fixture paths before deleting this run’s test documents. */
  async function clearFixture(target, collections) {
    for (const collection of collections) {
      const data = await api(base + '/' + target + '/' + collection, { token: admin });
      for (const document of data.documents || []) {
        assert.ok(
          document.name.startsWith(
            `projects/${config.projectId}/databases/(default)/documents/${target}/${collection}/`,
          ),
        );
        await api('https://firestore.googleapis.com/v1/' + document.name, {
          token: admin,
          method: 'DELETE',
        });
      }
    }
    await api(base + '/' + target, { token: admin, method: 'DELETE' });
  }
  try {
    if (roomCode) await clearFixture('rooms/' + roomCode, ['events', 'aiReports', 'aiReportsV2']);
    for (const game of games)
      await clearFixture(game, ['events', 'commentary', 'aiReports', 'aiReportsV2']);
  } finally {
    for (const user of users) await auth('delete', { idToken: user.idToken });
  }
  console.log('Temporary nickname accounts, campaign and room removed.');
}
