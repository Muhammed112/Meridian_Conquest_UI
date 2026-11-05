// Local-only owner and visitor browsers; no real account, email, AI or cloud writes.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { GameEngine } from '../dist/engine.js';
import { decodeSnapshot } from '../dist/snapshots.js';
import { spectatorPayload } from '../dist/spectators.js';
import { LIVE_SHARE_IDLE_MS } from '../dist/live-sharing.js';

// Keep the real spectator service, substituting only its Firestore transport with in-memory records.
const fakeCloud = `
import { createSpectatorService } from './spectators.js';
export const cloudEnabled = true;
export async function connectCloud(callbacks) {
  const user = window.fixtureOwner
    ? { uid: 'owner', displayName: 'Mo', email: 'private@example.invalid' } : null;
  window.privateWrites = 0; window.aiRequests = 0;
  let nextSubscription = 0;
  const listeners = new Map();
  const snapshot = (target, value) => typeof target === 'string'
    ? { exists: () => Boolean(value), data: () => value }
    : { docs: value.map(record => ({ id: record.id, data: () => record.data })) };
  window.receiveLive = (subscription, value) => listeners.get(subscription)?.(value);
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    collection: (_, ...parts) => parts.join('/'),
    query: (path, ...constraints) => ({ path, constraints }),
    where: (field, operator, value) => ({ type: 'where', field, operator, value }),
    orderBy: (field, direction = 'asc') => ({ type: 'order', field, direction }),
    limit: count => ({ type: 'limit', count }),
    serverTimestamp: () => Date.now(),
    getDocs: async target => snapshot(target, await window.readShares(target)),
    getDoc: async path => snapshot(path, await window.readShares(path)),
    updateDoc: async (path, record) => {
      const existing = await window.readShares(path);
      if (!existing) throw new Error('Missing public share');
      return window.publishShare(path, { ...existing, ...record });
    },
    setDoc: (path, record) => {
      if (path.includes('/presence/')) window.fixturePresenceOnline = record.online;
      return window.publishShare(path, record);
    },
    async deleteDoc(path) {
      window.fixtureDeleteRequests = (window.fixtureDeleteRequests || 0) + 1;
      if (window.fixtureHoldDelete)
        await new Promise((resolve, reject) => {
          window.fixturePendingDelete = { path, resolve, reject };
        });
      return window.removeShare(path);
    },
    onSnapshot: (target, receive, fail) => {
      const subscription = ++nextSubscription;
      let active = true;
      listeners.set(subscription, value => {
        if (active) receive(snapshot(target, value));
      });
      window.subscribeShare(subscription, target).then(value => {
        if (active) receive(snapshot(target, value));
      }).catch(fail);
      return () => {
        active = false;
        listeners.delete(subscription);
        void window.unsubscribeShare(subscription);
      };
    },
  };
  const spectators = createSpectatorService({
    db: {}, sdk, getUser: () => user, onExpired: callbacks.onSharingExpired,
  });
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
    requestCommentary() { window.aiRequests++; return 0; },
    setCommentaryEnabled() {},
  };
  window.fixtureService = service;
  window.deliverCommentary = (game, event, text) =>
    callbacks.onCommentary(game, event, { status: 'ready', text, narrationVersion: 2 });
  callbacks.onSession(user, user ? window.fixtureGames : [], true);
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

/** Resolve collection filters locally so presence and board listeners stay independent. */
function readRecords(target) {
  if (typeof target === 'string') return records.get(target) || null;
  let matches = [...records]
    .filter(
      ([path]) =>
        path.startsWith(target.path + '/') &&
        path.split('/').length === target.path.split('/').length + 1,
    )
    .map(([path, data]) => ({ id: path.split('/').at(-1), data }));
  for (const constraint of target.constraints) {
    if (constraint.type === 'where')
      matches = matches.filter((record) => record.data[constraint.field] === constraint.value);
    if (constraint.type === 'order')
      matches.sort(
        (left, right) =>
          (left.data[constraint.field] - right.data[constraint.field]) *
          (constraint.direction === 'desc' ? -1 : 1),
      );
    if (constraint.type === 'limit') matches = matches.slice(0, constraint.count);
  }
  return matches;
}

/** Connect an isolated owner/visitor browser to the shared in-memory document fixture. */
async function openPage(owner, path, viewport, fixtureGame = game, controlledClock = false) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage(),
    errors = [];
  if (controlledClock) await page.clock.install({ time: new Date() });
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
    { owner, game: fixtureGame },
  );
  const subscriptions = new Map();
  watchers.set(page, subscriptions);
  await page.exposeFunction('readShares', readRecords);
  await page.exposeFunction('subscribeShare', (subscription, target) => {
    subscriptions.set(subscription, target);
    return readRecords(target);
  });
  await page.exposeFunction('unsubscribeShare', (subscription) =>
    subscriptions.delete(subscription),
  );
  /** Deliver fixture snapshots to subscribed browser pages without contacting Firebase. */
  async function notify(path) {
    for (const [visitor, watched] of watchers) {
      if (visitor.isClosed()) continue;
      for (const [subscription, target] of watched) {
        const matches =
          typeof target === 'string' ? target === path : path.startsWith(target.path + '/');
        if (matches)
          await visitor.evaluate(
            ({ subscription, value }) => window.receiveLive(subscription, value),
            { subscription, value: readRecords(target) },
          );
      }
    }
  }
  await page.exposeFunction('publishShare', async (path, record) => {
    assert.equal(owner, true);
    records.set(path, record);
    await notify(path);
  });
  await page.exposeFunction('removeShare', async (path) => {
    assert.equal(owner, true);
    records.delete(path);
    await notify(path);
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

/** Active cards stay focused on resuming; completed cards retain their named replay/share actions. */
async function checkCampaignCardActions(page, campaign) {
  const card = page.locator('.campaign-card').filter({
    has: page.locator(`a[href="#game/${campaign.id}"]`),
  });
  const replay = card.locator(`a[href="#history/${campaign.id}"]`);
  const share = card.locator('[data-action="share"]');
  const primary = card.locator(`a[href="#game/${campaign.id}"]`);
  const completed = Number.isInteger(campaign.winner);
  await primary.waitFor();
  assert.match(await primary.innerText(), completed ? /View results/ : /Resume campaign/);
  if (!completed) {
    assert.equal(await replay.count(), 0);
    assert.equal(await share.count(), 0);
    return;
  }
  await share.waitFor();
  assert.equal(await replay.innerText(), 'Replay');
  assert.equal(await share.innerText(), 'Share gameplay');
  assert.equal(
    await card.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const primary = element.querySelector('a[href^="#game/"]').getBoundingClientRect();
      const secondary = [
        element.querySelector('a[href^="#history/"]'),
        element.querySelector('[data-action="share"]'),
      ];
      return secondary.every((action) => {
        const bounds = action.getBoundingClientRect();
        return (
          bounds.bottom <= primary.top + 1 && bounds.left >= card.left && bounds.right <= card.right
        );
      });
    }),
    true,
    'Replay and the correct share action should fit above the main campaign action.',
  );
}

/** Release a held server acknowledgment, preserving the public record when the delete fails. */
async function settleHeldDeletion(page, failed = false) {
  await page.waitForFunction(() => Boolean(window.fixturePendingDelete));
  await page.evaluate((failed) => {
    const pending = window.fixturePendingDelete;
    window.fixturePendingDelete = null;
    window.fixtureHoldDelete = false;
    if (failed) pending.reject(new Error('Fixture deletion failed.'));
    else pending.resolve();
  }, failed);
}

try {
  browser = await chromium.launch({ headless: true });
  const owner = await openPage(true, '/#campaigns', { width: 1440, height: 1000 });
  // Active cards omit replay/sharing shortcuts; the game retains its reports-header controls.
  await checkCampaignCardActions(owner.page, game);
  await owner.page.screenshot({ path: '.firebase/campaign-button-labels.png' });
  assert.equal(
    await owner.page.getByRole('button', { name: 'Share live link', exact: true }).count(),
    0,
  );
  await owner.page.getByRole('link', { name: 'Resume campaign', exact: false }).click();
  const ownerReports = owner.page.locator('[data-reports-panel]');
  const shareLink = ownerReports.getByRole('button', { name: 'Share live link', exact: true });
  const stopSharing = ownerReports.getByRole('button', { name: 'Stop sharing', exact: true });
  await shareLink.waitFor();
  assert.equal(await stopSharing.count(), 0);
  await shareLink.scrollIntoViewIfNeeded();
  await owner.page.evaluate(() => {
    window.originalOwnerMap = document.querySelector('.world-map');
    window.originalOwnerScroll = window.scrollY;
  });
  await shareLink.click();
  await owner.page.waitForFunction(() => Boolean(window.copiedUrl));
  const link = await owner.page.evaluate(() => window.copiedUrl);
  assert.equal(link, origin + '/#live/' + game.id);
  await stopSharing.waitFor();
  assert.equal(
    await owner.page.evaluate(
      () => window.originalOwnerMap === document.querySelector('.world-map'),
    ),
    true,
  );
  assert.equal(
    await owner.page.evaluate(() => window.scrollY === window.originalOwnerScroll),
    true,
  );
  await owner.page.waitForFunction(() => window.fixturePresenceOnline === true);
  assert.doesNotMatch(records.get('liveGames/' + game.id).payload, /private@example/);
  // The added actions must leave both report tabs readable at the tester's desktop size.
  await owner.page.setViewportSize({ width: 1536, height: 728 });
  await ownerReports.getByRole('button', { name: 'Pin reports', exact: true }).click();
  assert.equal(
    await ownerReports.locator('.reports-head').evaluate((header) => {
      const bounds = header.getBoundingClientRect();
      return (
        header.scrollWidth <= header.clientWidth + 1 &&
        [...header.querySelectorAll('button')].every((button) => {
          if (!button.checkVisibility()) return true;
          const rect = button.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right;
        })
      );
    }),
    true,
  );
  await owner.page.screenshot({ path: '.firebase/reports-header-sharing-desktop.png' });
  // A fresh visitor context must not inherit the owner's session or private write permissions.
  const visitor = await openPage(false, '/#live/' + game.id, { width: 1440, height: 1000 });
  await visitor.page.locator('.watch-notice').waitFor();
  // Spectators must never receive owner controls for publishing or revoking a live campaign.
  assert.equal(
    await visitor.page.locator('[data-action="share"],[data-action="stop-sharing"]').count(),
    0,
  );
  const presenceNotice = visitor.page.locator('[data-live-presence-notice]');
  const departureToast = visitor.page.locator('#toast.visible');
  assert.equal(await presenceNotice.isVisible(), false);
  assert.equal(await departureToast.count(), 0);

  // Leaving the board must notify viewers while keeping the final public position readable.
  await visitor.page.evaluate(() => {
    window.originalLiveMap = document.querySelector('.world-map');
    window.originalLiveReports = document.querySelector('[data-reports-panel]');
  });
  const originalPosition = await visitor.page.locator('.world-map').innerHTML();
  await owner.page.evaluate(() => {
    location.hash = 'campaigns';
  });
  await presenceNotice.waitFor({ state: 'visible' });
  await departureToast.waitFor({ state: 'visible' });
  assert.equal(await departureToast.innerText(), 'The player has left the game.');
  await checkCampaignCardActions(owner.page, game);
  assert.equal(
    await owner.page.getByRole('button', { name: 'Stop sharing', exact: true }).count(),
    1,
    'An existing active stream must still be revocable from its campaign card.',
  );
  assert.equal(
    await presenceNotice.innerText(),
    'The player has left the game. Showing the last saved position.',
  );
  assert.equal(await presenceNotice.getAttribute('role'), 'status');
  assert.equal(await visitor.page.locator('.world-map').innerHTML(), originalPosition);
  assert.equal(
    await visitor.page.evaluate(
      () =>
        window.originalLiveMap === document.querySelector('.world-map') &&
        window.originalLiveReports === document.querySelector('[data-reports-panel]'),
    ),
    true,
  );
  // Redrawing the board or receiving the same offline snapshot must not repeat the popup.
  await visitor.page.evaluate(() => document.getElementById('toast').classList.remove('visible'));
  await visitor.page.locator('[data-action="select-country"]').first().click({ force: true });
  for (const [subscription, target] of watchers.get(visitor.page)) {
    if (typeof target !== 'string' && target.path === `liveGames/${game.id}/presence`)
      await visitor.page.evaluate(
        ({ subscription, value }) => window.receiveLive(subscription, value),
        { subscription, value: readRecords(target) },
      );
  }
  assert.equal(await departureToast.count(), 0, 'An offline period should produce one popup.');
  await owner.page.evaluate((id) => {
    location.hash = 'game/' + id;
  }, game.id);
  await presenceNotice.waitFor({ state: 'hidden' });

  // Browsing another tab is not leaving a campaign; do not falsely interrupt its stream.
  await owner.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await owner.page.evaluate(() => window.fixturePresenceOnline), true);
  assert.equal(await presenceNotice.isVisible(), false);
  assert.equal(await departureToast.count(), 0, 'Switching tabs must not show a departure popup.');
  await owner.page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Browser pagehide attempts departure before shutdown; a restored page must resume its stream.
  await owner.page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await presenceNotice.waitFor({ state: 'visible' });
  await departureToast.waitFor({ state: 'visible' });
  assert.equal(await departureToast.innerText(), 'The player has left the game.');
  await owner.page.evaluate(() => dispatchEvent(new Event('pageshow')));
  await presenceNotice.waitFor({ state: 'hidden' });
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
  // Pending revocation remains visible through a full page redraw, and failure permits a retry.
  await owner.page.evaluate(() => {
    window.fixtureHoldDelete = true;
  });
  await stopSharing.click();
  const pendingStop = ownerReports.getByRole('button', { name: 'Stopping…', exact: true });
  await pendingStop.waitFor();
  assert.equal(await pendingStop.isDisabled(), true);
  assert.equal(await shareLink.isDisabled(), true);
  assert.equal(records.has('liveGames/' + game.id), true);
  await owner.page.evaluate(() => {
    location.hash = 'campaigns';
  });
  const pendingCardStop = owner.page
    .locator('.campaign-card')
    .getByRole('button', { name: 'Stopping…', exact: true });
  await pendingCardStop.waitFor();
  assert.equal(await pendingCardStop.isDisabled(), true);
  await settleHeldDeletion(owner.page, true);
  const cardStop = owner.page
    .locator('.campaign-card')
    .getByRole('button', { name: 'Stop sharing', exact: true });
  await cardStop.waitFor();
  assert.equal(await cardStop.isDisabled(), false);
  assert.equal(records.has('liveGames/' + game.id), true);
  await owner.page.evaluate((id) => {
    location.hash = 'game/' + id;
  }, game.id);
  await stopSharing.waitFor();
  assert.equal(await stopSharing.isDisabled(), false);
  assert.equal(await shareLink.isDisabled(), false);

  // Successful acknowledgment removes access without rebuilding the owner's map while waiting.
  await owner.page.evaluate(() => {
    window.fixtureHoldDelete = true;
    window.originalOwnerMap = document.querySelector('.world-map');
  });
  await stopSharing.click();
  await pendingStop.waitFor();
  assert.equal(await pendingStop.isDisabled(), true);
  assert.equal(await shareLink.isDisabled(), true);
  assert.equal(records.has('liveGames/' + game.id), true);
  assert.equal(
    await owner.page.evaluate(
      () => window.originalOwnerMap === document.querySelector('.world-map'),
    ),
    true,
  );
  await settleHeldDeletion(owner.page);
  await pendingStop.waitFor({ state: 'detached' });
  await stopSharing.waitFor({ state: 'detached' });
  assert.equal(await shareLink.count(), 1);
  assert.equal(await shareLink.isDisabled(), false);
  assert.equal(
    await owner.page.evaluate(
      () => window.originalOwnerMap === document.querySelector('.world-map'),
    ),
    true,
  );
  await visitor.page
    .getByRole('heading', { name: 'This game is not being shared right now.' })
    .waitFor();
  assert.equal(records.has('liveGames/' + game.id), false);
  await owner.page.evaluate(() => window.fixtureService.spectators.publish(window.fixtureGames[0]));
  assert.equal(records.has('liveGames/' + game.id), false);
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(visitor.errors, []);

  // A completed win or loss is a fixed public record, independent of the owner's presence.
  for (const winner of [0, 2]) {
    const completed = structuredClone(game);
    completed.id = 'completed-game-' + winner;
    completed.name = 'Completed gameplay ' + winner;
    completed.winner = winner;
    completed.status = winner === 0 ? 'won' : 'lost';
    completed.budget = 0;
    completed.battle = null;
    completed.countries.forEach((country) => {
      country.owner = winner;
    });
    completed.events = [];
    new GameEngine(completed).event('victory', 'The winning commander controls all ten countries.');
    completed.events[0].commentary = 'A decisive finish brings the campaign to a close.';
    completed.events[0].commentaryVersion = 2;
    completed.privateAccountEmail = 'private@example.invalid';
    completed.privateCredential = 'keep-private';
    // Previously published streams must retain their revoke control after the game ends.
    const existingLivePath = 'liveGames/' + completed.id;
    if (winner === 2)
      records.set(existingLivePath, {
        version: 1,
        ownerUid: 'owner',
        gameId: completed.id,
        payload: spectatorPayload(completed),
        updatedAt: Date.now(),
      });
    const completedOwner = await openPage(
      true,
      '/#game/' + completed.id,
      { width: 1440, height: 1000 },
      completed,
    );
    const completedReports = completedOwner.page.locator('[data-reports-panel]');
    const recordedShare = completedReports.getByRole('button', {
      name: 'Share gameplay',
      exact: true,
    });
    await recordedShare.waitFor();
    const writesBeforeShare = await completedOwner.page.evaluate(() => window.privateWrites);
    const livePayloadBeforeShare = records.get(existingLivePath)?.payload;
    assert.equal(
      await completedReports
        .getByRole('button', { name: 'Stop live sharing', exact: true })
        .count(),
      winner === 2 ? 1 : 0,
    );
    await recordedShare.click();
    await completedOwner.page.waitForFunction(() => Boolean(window.copiedUrl));
    const recordedUrl = new URL(await completedOwner.page.evaluate(() => window.copiedUrl));
    assert.equal(recordedUrl.hash.startsWith('#watch/'), true);
    const restored = decodeSnapshot(recordedUrl.hash.slice('#watch/'.length));
    assert.equal(restored.winner, winner);
    assert.equal(
      restored.countries.every((country) => country.owner === winner),
      true,
    );
    assert.doesNotMatch(JSON.stringify(restored), /private@example|keep-private/);
    assert.equal(await completedOwner.page.evaluate(() => window.privateWrites), writesBeforeShare);
    assert.equal(records.get(existingLivePath)?.payload, livePayloadBeforeShare);

    const recordedVisitor = await openPage(false, '/' + recordedUrl.hash, {
      width: 1440,
      height: 1000,
    });
    await recordedVisitor.page.locator('.watch-notice').waitFor();
    assert.match(await recordedVisitor.page.locator('.watch-notice').innerText(), /Viewing only/);
    assert.equal(await recordedVisitor.page.locator('[data-live-presence-badge]').count(), 0);
    assert.equal(await recordedVisitor.page.locator('[data-action="share"]').count(), 0);
    assert.equal(await recordedVisitor.page.locator('[data-action="stop-sharing"]').count(), 0);
    assert.equal(await recordedVisitor.page.locator('[data-action="start-attack"]').count(), 0);
    await recordedVisitor.page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
    assert.match(
      await recordedVisitor.page.locator('[data-report-panel="ai"]').innerText(),
      /A decisive finish/,
    );
    await recordedVisitor.page.getByRole('link', { name: 'Battle replay', exact: true }).click();
    await recordedVisitor.page.getByRole('link', { name: 'Back to board', exact: true }).click();
    const returnedHash = new URL(recordedVisitor.page.url()).hash;
    assert.equal(returnedHash.startsWith('#watch/'), true);
    // Replay may re-encode trusted country metadata; its recorded board must stay the same.
    const returnedGame = decodeSnapshot(returnedHash.slice('#watch/'.length));
    assert.equal(returnedGame.winner, winner);
    assert.deepEqual(returnedGame.countries, restored.countries);
    assert.equal(await recordedVisitor.page.evaluate(() => window.privateWrites), 0);
    assert.equal(await recordedVisitor.page.evaluate(() => window.aiRequests), 0);
    if (winner === 2) {
      await completedReports
        .getByRole('button', { name: 'Stop live sharing', exact: true })
        .click();
      assert.equal(records.has(existingLivePath), false);
      await recordedVisitor.page.locator('.watch-notice').waitFor();
    }
    await completedOwner.page.goto(origin + '/#campaigns');
    await checkCampaignCardActions(completedOwner.page, completed);
    assert.equal(
      await completedOwner.page
        .getByRole('button', { name: 'Share gameplay', exact: true })
        .count(),
      1,
    );
    assert.deepEqual(completedOwner.errors, []);
    assert.deepEqual(recordedVisitor.errors, []);
    await completedOwner.context.close();
    await recordedVisitor.context.close();
  }
  // Advancing isolated browser clocks proves expiry without a real five-minute wait or cloud writes.
  const idleGame = structuredClone(game);
  idleGame.id = 'idle-expiry-browser';
  const idleOwner = await openPage(
    true,
    '/#game/' + idleGame.id,
    { width: 1440, height: 1000 },
    idleGame,
    true,
  );
  const idleShare = idleOwner.page.getByRole('button', { name: 'Share live link', exact: true });
  await idleShare.click();
  await idleOwner.page.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor();
  const idleVisitor = await openPage(
    false,
    '/#live/' + idleGame.id,
    { width: 1440, height: 1000 },
    idleGame,
    true,
  );
  await idleVisitor.page.locator('.watch-notice').waitFor();
  const idleCards = await openPage(
    true,
    '/#campaigns',
    { width: 1440, height: 1000 },
    idleGame,
    true,
  );
  const idleCardStop = idleCards.page.getByRole('button', { name: 'Stop sharing', exact: true });
  await idleCardStop.waitFor();
  const originalPayload = records.get('liveGames/' + idleGame.id).payload;
  await idleOwner.page.clock.runFor(LIVE_SHARE_IDLE_MS + 2000);
  await idleOwner.page.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor({
    state: 'detached',
  });
  await idleVisitor.page.clock.runFor(LIVE_SHARE_IDLE_MS + 2000);
  await idleCards.page.clock.runFor(LIVE_SHARE_IDLE_MS + 2000);
  await idleCardStop.waitFor({ state: 'detached' });
  await idleCards.page.getByRole('link', { name: /Resume campaign/ }).waitFor();
  assert.deepEqual(idleCards.errors, []);
  await idleCards.context.close();
  const expiredHeading = idleVisitor.page.getByRole('heading', {
    name: 'This live stream ended after five minutes of inactivity.',
    exact: true,
  });
  await expiredHeading.waitFor();
  assert.equal(await idleVisitor.page.locator('.world-map').count(), 0);
  assert.equal(records.get('liveGames/' + idleGame.id).payload, originalPayload);
  // An explicit reshare resumes viewing, while closing that owner still permits automatic expiry.
  await idleShare.click();
  await idleVisitor.page.locator('.watch-notice').waitFor();
  await idleOwner.context.close();
  await idleVisitor.page.clock.runFor(LIVE_SHARE_IDLE_MS + 2000);
  await expiredHeading.waitFor();
  assert.equal(await idleVisitor.page.evaluate(() => window.privateWrites), 0);
  assert.equal(await idleVisitor.page.evaluate(() => window.aiRequests), 0);
  assert.deepEqual(idleOwner.errors, []);
  assert.deepEqual(idleVisitor.errors, []);
  await idleVisitor.context.close();
  console.log(
    'PASS: anonymous visitors see live moves, delayed dice results and escaped' +
      ' AI reports; departure/rejoin updates the stream without rebuilding the board;' +
      ' switching tabs stays online; pagehide/pageshow updates presence; replay returns live;' +
      ' no visitor writes or AI requests;' +
      ' pending revocation survives redraws, disables repeated actions and recovers on failure;' +
      ' reports-header sharing copies the live link and revokes access without rebuilding the map;' +
      ' idle and closed-owner streams expire after five minutes and require explicit resharing;' +
      ' completed games share private-field-free recorded links with replay and AI reports.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
