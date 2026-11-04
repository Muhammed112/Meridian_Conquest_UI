// Local-only owner and visitor browsers; no real account, email, AI or cloud writes.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { GameEngine } from '../dist/engine.js';

// Keep the real spectator service, substituting only its Firestore transport with in-memory records.
const fakeCloud =
  `
import { createSpectatorService } from './spectators.js';
export const cloudEnabled = true;
export async function connectCloud(callbacks) {
` +
  `  const user = window.fixtureOwner ? { uid: 'owner', displayName: 'Mo',` +
  ` email: 'private@example.invalid' } : null;
` +
  `  window.privateWrites = 0; window.aiRequests = 0;
  const sdk = {
    doc: (_, ...parts) => parts.join('/'), collection: (_, name) => name,
    query: target => target, where: () => ({}), serverTimestamp: () => 1,
` +
  `    getDocs: async () => ({ docs: (await window.listShares()).map(record =>` +
  ` ({ id: record.gameId, data: () => record })) }),
` +
  `    setDoc: (path, record) => window.publishShare(path, record),
    deleteDoc: path => window.removeShare(path),
    onSnapshot: (path, receive, fail) => {
      let active = true;
` +
  `      window.receiveLive = record => { if (active) receive({ exists: () =>` +
  ` Boolean(record), data: () => record }); };
` +
  `      window.subscribeShare(path).then(record =>` +
  ` window.receiveLive(record)).catch(fail);
` +
  `      return () => { active = false; };
    },
  };
  const spectators = createSpectatorService({ db: {}, sdk, getUser: () => user });
  if (user) await spectators.restore();
  const service = {
    user, ready: true, spectators,
    commentary: { enabled: false, pending: [], status: 'idle' },
    rooms: {},
    async save(games) {
      if (!user) throw new Error('Visitors cannot save.');
      window.privateWrites++;
      window.lastSaved = games[0];
      for (const game of games) await spectators.publish(game);
    },
` +
  `    requestCommentary() { window.aiRequests++; return 0; },` +
  ` setCommentaryEnabled() {},
` +
  `  };
  window.fixtureService = service;
` +
  `  window.deliverCommentary = (game, event, text) =>` +
  ` callbacks.onCommentary(game, event, { status: 'ready', text,` +
  ` narrationVersion: 2 });
` +
  `  callbacks.onSession(user, user ? window.fixtureGames : [], true);
  return service;
}`;

const game = GameEngine.create('Live visitor test', 'ZA', true, 'medium', 'Mo');
game.round = 1;
game.position = game.order.indexOf(0);
game.turnStarted = false;
game.events = [];
game.countries[0].army = 9;
game.countries[1].army = 1;
new GameEngine(game).beginTurn();
const records = new Map(),
  watchers = new Map();
const server = await startTestServer();
let browser;
const origin = 'http://localhost:' + server.address().port;
/** Connect an isolated owner/visitor browser to the shared in-memory document fixture. */
async function openPage(owner, path, viewport) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.addInitScript(
    ({ owner, game }) => {
      window.fixtureOwner = owner;
      window.fixtureGames = [game];
      localStorage.setItem('unrelated-save', 'keep');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (value) => {
            window.copiedUrl = value;
          },
        },
      });
    },
    { owner, game },
  );
  await page.exposeFunction('listShares', () => (owner ? [...records.values()] : []));
  await page.exposeFunction('subscribeShare', (path) => {
    watchers.set(page, path);
    return records.get(path) || null;
  });
  /** Deliver fixture snapshots to subscribed browser pages without contacting Firebase. */
  async function notify(path, record) {
    for (const [visitor, watched] of watchers)
      if (watched === path && !visitor.isClosed())
        await visitor.evaluate((value) => window.receiveLive(value), record || null);
  }
  await page.exposeFunction('publishShare', async (path, record) => {
    assert.equal(owner, true);
    records.set(path, record);
    await notify(path, record);
  });
  await page.exposeFunction('removeShare', async (path) => {
    assert.equal(owner, true);
    records.delete(path);
    await notify(path, null);
  });
  await page.route(/\/cloud\.js(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeCloud }),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig = null;' }),
  );
  await page.goto(origin + path);
  return { page, errors, context };
}

try {
  browser = await chromium.launch({ headless: true });
  const owner = await openPage(true, '/#game/' + game.id, { width: 1440, height: 1000 });
  await owner.page.getByRole('button', { name: 'Copy live viewing link', exact: true }).click();
  await owner.page.waitForFunction(() => Boolean(window.copiedUrl));
  const link = await owner.page.evaluate(() => window.copiedUrl);
  assert.equal(link, origin + '/#live/' + game.id);
  assert.doesNotMatch(records.get('liveGames/' + game.id).payload, /private@example/);
  // A fresh visitor context must not inherit the owner's session or private write permissions.
  const visitor = await openPage(false, '/#live/' + game.id, { width: 1440, height: 1000 });
  await visitor.page.locator('.watch-notice').waitFor();
  await visitor.page.evaluate(() => {
    location.hash = 'how-to-play';
  });
  await visitor.page.getByRole('button', { name: 'Close instructions', exact: true }).click();
  assert.equal(new URL(visitor.page.url()).hash, '#live/' + game.id);
  assert.equal(
    await visitor.page
      .locator(
        '[data-action="start-attack"],[data-action="roll"],[data-action="confirm-rei' +
          'nforce"],[data-action="request-commentary"]',
      )
      .count(),
    0,
  );
  assert.equal(
    await visitor.page.getByRole('link', { name: /Start your own campaign/ }).getAttribute('href'),
    '#signup',
  );
  await owner.page.goto(origin + '/#game/' + game.id);
  await owner.page.locator('#attack-to').selectOption(game.countries[1].code);
  await owner.page.locator('[data-action="start-attack"]').click();
  await visitor.page.waitForFunction(() =>
    document.querySelector('.activity-feed')?.textContent.includes('launches an attack'),
  );
  await owner.page.evaluate(async () => {
    const { BattleEngine } = await import('./engine.js');
    const original = BattleEngine.resolve;
    BattleEngine.resolve = (a, d) => {
      let index = 0;
      return original(a, d, () => (++index % 2 ? 6 : 1));
    };
  });
  await owner.page.locator('[data-action="roll"]').click();
  await visitor.page.locator('.dice-rolling').waitFor();
  assert.doesNotMatch(
    await visitor.page.locator('[data-report-panel="field"]').innerText(),
    /conquered/,
  );
  await visitor.page.waitForFunction(() =>
    document.querySelector('[data-report-panel="field"]')?.textContent.includes('conquered'),
  );
  await visitor.page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
  // Model output remains untrusted even when forwarded by the owner's public spectator snapshot.
  await owner.page.evaluate(
    ({ gameId }) => {
      window.deliverCommentary(
        gameId,
        window.lastSaved.events.at(-1).id,
        'Mo claims a new foothold. <script>unsafe</script>',
      );
    },
    { gameId: game.id },
  );
  await visitor.page.waitForFunction(() =>
    document.querySelector('[data-report-panel="ai"]')?.textContent.includes('new foothold'),
  );
  assert.equal(await visitor.page.locator('[data-report-panel="ai"] script').count(), 0);
  await visitor.page.getByRole('link', { name: 'Battle replay', exact: true }).click();
  await visitor.page.getByRole('link', { name: 'Back to board', exact: true }).click();
  assert.equal(new URL(visitor.page.url()).hash, '#live/' + game.id);
  await visitor.page.locator('.watch-notice').waitFor();
  await visitor.page.setViewportSize({ width: 390, height: 844 });
  await visitor.page.getByRole('button', { name: 'Pin reports', exact: true }).click();
  await visitor.page.screenshot({ path: '.firebase/live-spectator-mobile.png' });
  assert.equal(await visitor.page.evaluate(() => window.privateWrites), 0);
  assert.equal(await visitor.page.evaluate(() => window.aiRequests), 0);
  assert.equal(await visitor.page.evaluate(() => localStorage.getItem('unrelated-save')), 'keep');
  await owner.page.goto(origin + '/#campaigns');
  // Revocation must remove the live board and prevent subsequent saves from silently republishing it.
  await owner.page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await visitor.page
    .getByRole('heading', { name: 'This game is not being shared right now.' })
    .waitFor();
  assert.equal(records.size, 0);
  await owner.page.evaluate(() => window.fixtureService.spectators.publish(window.fixtureGames[0]));
  assert.equal(records.size, 0);
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(visitor.errors, []);
  console.log(
    'PASS: anonymous visitors see live moves, delayed dice results and escaped' +
      ' AI reports; replay returns live; no visitor writes or AI requests; owner' +
      ' revocation removes access.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
