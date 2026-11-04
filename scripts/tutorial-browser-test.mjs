import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { GameEngine } from '../dist/engine.js';

// Fake account service only: no Firebase accounts, campaigns or AI quota are used.
const fakeCloud = `
export const cloudEnabled = true;
export async function connectCloud(callbacks) {
  let user = null;
  window.practiceWrites = [];
  window.practiceAIRequests = 0;
  const service = {
    get user() { return user; },
    ready: true,
    commentary: { enabled: false, status: 'ready', pending: [] },
    rooms: {},
    async authenticate(_kind, values) {
      user = { uid: values.get('email'), displayName: 'Learner <Ace>' };
      callbacks.onSession(user, window.savedCampaigns || [], true);
      callbacks.onLoadState({ status: 'ready' });
    },
    async save(games) { window.practiceWrites.push(JSON.parse(JSON.stringify(games))); },
    async signOut() { user = null; callbacks.onSession(null, [], true); },
    requestCommentary() { window.practiceAIRequests++; return 0; },
    setCommentaryEnabled() {},
  };
  callbacks.onSession(null, [], true);
  return service;
}`;
const server = await startTestServer();
let browser;
const origin = 'http://localhost:' + server.address().port;
/** Mock the cloud boundary and track writes to prove practice never saves a real campaign. */
async function openPage(viewport, games = [], motion = 'full') {
  const page = await browser.newPage({ viewport, ignoreHTTPSErrors: true });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ games, motion }) => {
      window.savedCampaigns = games;
      localStorage.setItem('unrelated-save', 'keep');
      localStorage.setItem('meridian-motion-preference', motion);
    },
    { games, motion },
  );
  await page.route(/\/cloud\.js(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeCloud }),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig = null;' }),
  );
  await page.goto(origin + '/#signin');
  await page.locator('#auth-form input[name="email"]').fill('new-player@example.invalid');
  await page.locator('#auth-form input[name="password"]').fill('Tutorial-test-123!');
  await page.locator('#auth-form button[type="submit"]').click();
  return { page, errors };
}
/** Wait for the guide to enter a named lesson before interacting with its controls. */
async function step(page, name) {
  await page.locator(`[data-tutorial-step="${name}"]`).waitFor();
}
/** Wait for practice dice to release the guide’s concealed result. */
async function settled(page) {
  await page.waitForFunction(
    () => document.querySelector('.tutorial-guide')?.getAttribute('aria-busy') === 'false',
  );
}
/** Activate a visible tutorial control through the same delegated actions as normal play. */
async function clickAction(page, action) {
  await page.locator(`[data-action="${action}"]`).first().click();
}
try {
  browser = await chromium.launch({ headless: true });
  // Walk the actual delegated controls so lesson progression cannot pass while the board is unusable.
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 900, height: 850 },
    { width: 390, height: 844 },
  ]) {
    const { page, errors } = await openPage(viewport);
    await step(page, 'welcome');
    assert.equal(await page.locator('[data-action="confirm-reinforce"]').isDisabled(), true);
    const guideBox = await page.locator('.tutorial-guide').boundingBox();
    const boardBox = await page.locator('.board-grid').boundingBox();
    assert.equal(await page.locator('.tutorial-action-column .tutorial-guide').count(), 1);
    if (viewport.width > 1100) assert.ok(guideBox.width < boardBox.width / 2);
    assert.equal(await page.locator('.tutorial-visual,.tutorial-chapters').count(), 0);
    assert.equal(
      await page
        .locator('.tutorial-guide')
        .evaluate((node) => getComputedStyle(node).animationName),
      'none',
    );
    await page.screenshot({
      path: `.firebase/tutorial-welcome-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await clickAction(page, 'tutorial-next');
    await step(page, 'map');
    await page.locator('.map-marker[data-code="ZA"] text').click();
    await step(page, 'reinforce');
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const guideHeading = await page.locator('#tutorial-step-title').boundingBox();
    const guideVisible =
      guideHeading.y >= 0 && guideHeading.y + guideHeading.height <= viewport.height;
    if (!guideVisible)
      await page.screenshot({
        path: `.firebase/tutorial-focus-${viewport.width}.png`,
        fullPage: true,
      });
    assert.ok(guideVisible, JSON.stringify({ guideHeading, viewport }));
    await page.locator('.tutorial-rule-details summary').click();
    assert.match(
      await page.locator('.tutorial-rule-details').innerText(),
      /round finishes after every surviving player/,
    );
    assert.match(
      await page.locator('.tutorial-rule-details').innerText(),
      /4 in one and 2 in another/,
    );
    await page.screenshot({
      path: `.firebase/tutorial-reinforce-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    // A shorter desktop window exercises the guide's own scrollbar rather than page scrolling.
    if (viewport.width > 1100) await page.setViewportSize({ ...viewport, height: 600 });
    // Adjusting soldiers redraws the board, but must retain the learner's place in the guide.
    for (const action of ['allocate-plus', 'allocate-minus', 'allocate-plus', 'allocate-plus']) {
      const control = page.locator(`[data-action="${action}"][data-code="ZA"]`);
      await control.scrollIntoViewIfNeeded();
      const column = page.locator('.tutorial-action-column');
      const scrollBefore = await column.evaluate((node) => node.scrollTop);
      if (viewport.width > 1100) assert.ok(scrollBefore > 0, 'Exercise a scrolled guide.');
      await control.click();
      assert.equal(
        await page.locator('.tutorial-rule-details').evaluate((node) => node.open),
        true,
        'Adjusting soldiers must not close Rules & examples.',
      );
      assert.ok(
        Math.abs((await column.evaluate((node) => node.scrollTop)) - scrollBefore) <= 1,
        'Adjusting soldiers must not reset the tutorial column scroll.',
      );
    }
    if (viewport.width > 1100) await page.setViewportSize(viewport);
    await clickAction(page, 'confirm-reinforce');
    await step(page, 'attack');
    assert.equal(
      await page.locator('.tutorial-rule-details').evaluate((node) => node.open),
      false,
      'A new lesson starts with its own collapsed rules.',
    );
    await page.locator('#attack-to').selectOption('GB');
    await clickAction(page, 'start-attack');
    await step(page, 'dice');
    // The guide must wait for dice presentation before explaining losses, just like the main game.
    await clickAction(page, 'roll');
    assert.match(await page.locator('#tutorial-step-title').innerText(), /Watch the dice settle/);
    assert.equal(await page.locator('.tutorial-guide').getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(await page.locator('.tutorial-guide').innerText(), /9 against 1/);
    assert.doesNotMatch(await page.locator('.action-panel').innerText(), /Phase 1:/);
    await settled(page);
    await step(page, 'losses');
    assert.match(await page.locator('.tutorial-guide').innerText(), /9 against 1/);
    await page.screenshot({
      path: `.firebase/tutorial-dice-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    assert.match(
      await page.locator('.action-panel').innerText(),
      /South Africa lost 1; United Kingdom lost 1/,
    );
    await clickAction(page, 'tutorial-next');
    await clickAction(page, 'roll');
    await settled(page);
    await step(page, 'conquest');
    await page.screenshot({
      path: `.firebase/tutorial-conquest-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await clickAction(page, 'tutorial-next');
    await step(page, 'transfer');
    await clickAction(page, 'transfer');
    await page.locator('#transfer-from').selectOption('GB');
    assert.equal(await page.locator('[data-action="confirm-transfer"]').isDisabled(), true);
    await page.locator('#transfer-from').selectOption('ZA');
    await page.locator('#transfer-to').selectOption('GB');
    await page.locator('#transfer-count').fill('2');
    await clickAction(page, 'confirm-transfer');
    await step(page, 'end');
    await page.locator('.action-panel [data-action="end-turn"]').click();
    await step(page, 'bots');
    await clickAction(page, 'tutorial-next');
    await step(page, 'retreat');
    for (const code of ['ZA', 'GB']) {
      await page.locator(`[data-action="allocate-plus"][data-code="${code}"]`).click();
      await page.locator(`[data-action="allocate-plus"][data-code="${code}"]`).click();
    }
    await clickAction(page, 'confirm-reinforce');
    await page.locator('#attack-to').selectOption('EG');
    await clickAction(page, 'start-attack');
    await clickAction(page, 'stop-attack');
    await step(page, 'reports');
    await page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
    await step(page, 'settings');
    assert.match(
      await page.locator('[data-report-panel="ai"]').innerText(),
      /\[Tutorial example\]/,
    );
    assert.equal(await page.locator('[data-report-panel="ai"] img').count(), 0);
    assert.equal(await page.locator('[data-action="request-commentary"]').count(), 0);
    await clickAction(page, 'settings');
    await page.locator('#settings-dialog').waitFor();
    await page.locator('#settings-dialog [data-action="motion"]').click();
    await page.keyboard.press('Escape');
    await step(page, 'multiplayer');
    assert.equal(
      await page
        .locator('.tutorial-guide')
        .evaluate((node) => getComputedStyle(node).animationName),
      'none',
    );
    await page.locator('#tutorial-room-code').fill('WRONG1');
    await page.getByRole('button', { name: 'Join practice room' }).click();
    assert.match(await page.locator('#tutorial-room-error').innerText(), /ABC234/);
    await page.locator('#tutorial-room-code').fill('abc234');
    await page.getByRole('button', { name: 'Join practice room' }).click();
    await step(page, 'complete');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: `.firebase/tutorial-complete-${viewport.width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Create my campaign' }).click();
    await page.waitForURL('**/#setup');
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('meridian-tutorial-v1-new-player@example.invalid'),
      ),
      'completed',
    );
    // Practice must neither consume model quota nor leak tutorial state into real account campaigns.
    assert.equal(await page.evaluate(() => window.practiceAIRequests), 0);
    assert.equal(await page.evaluate(() => window.practiceWrites.flat().length), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('unrelated-save')), 'keep');
    await page.goto(origin + '/#campaigns');
    await page.getByRole('link', { name: 'Interactive tutorial', exact: true }).waitFor();
    assert.equal(await page.locator('.tutorial-guide').count(), 0);
    await page.goto(origin + '/#how-to-play');
    await page.getByRole('link', { name: 'Start interactive tutorial' }).click();
    await step(page, 'welcome');
    await clickAction(page, 'tutorial-skip');
    await page.waitForURL('**/#campaigns');
    assert.deepEqual(errors, []);
    console.log(
      /* prettier-ignore */ `PASS: ${
        viewport.width
      }px new-player sign-in, complete guided practice, isolated saves/AI, room-code validation, skip and replay`,
    );
    await page.close();
  }
  // Reduced motion changes presentation only; the learner must still see identical dice and losses.
  const reduced = await openPage({ width: 390, height: 844 }, [], 'reduced');
  await step(reduced.page, 'welcome');
  assert.equal(
    await reduced.page
      .locator('.tutorial-guide')
      .evaluate((node) => getComputedStyle(node).animationName),
    'none',
  );
  await clickAction(reduced.page, 'tutorial-next');
  await reduced.page.locator('.country-roster [data-code="ZA"]').click();
  await clickAction(reduced.page, 'auto-allocate');
  await clickAction(reduced.page, 'confirm-reinforce');
  await clickAction(reduced.page, 'start-attack');
  await clickAction(reduced.page, 'roll');
  await step(reduced.page, 'losses');
  assert.equal(await reduced.page.locator('.tutorial-guide').getAttribute('aria-busy'), 'false');
  assert.equal(
    await reduced.page
      .locator('.action-panel .die')
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    'none',
  );
  assert.match(await reduced.page.locator('.tutorial-guide').innerText(), /9 against 1/);
  assert.deepEqual(reduced.errors, []);
  await clickAction(reduced.page, 'tutorial-skip');
  await reduced.page.close();
  console.log(
    'PASS: reduced-motion practice shows the same dice and losses without' +
      ' decorative or battle animations',
  );
  // Returning players can opt into practice without replacing a campaign or forcing onboarding again.
  const game = GameEngine.create('Existing campaign stays safe', 'ZA', true);
  const { page, errors } = await openPage({ width: 1440, height: 1000 }, [game]);
  await page.waitForURL('**/#campaigns');
  await page.getByRole('heading', { name: game.name }).waitFor();
  assert.equal(await page.locator('.tutorial-guide').count(), 0);
  await page.getByRole('link', { name: 'Interactive tutorial', exact: true }).click();
  await step(page, 'welcome');
  await clickAction(page, 'tutorial-skip');
  await page.getByRole('heading', { name: game.name }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.practiceWrites.at(-1)), [game]);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: returning players retain their campaign and can open or skip practice' +
      ' without changing it',
  );
  await page.close();
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
