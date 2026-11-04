// Every tutorial entry must keep the adviser while practice stays separate from account campaigns.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { prepareInstruction } from './lib/tutorial-browser.mjs';
import { GameEngine } from '../dist/engine.js';

const fakeCloud = `
export const cloudEnabled = true;
export async function connectCloud(callbacks) {
  window.adviserWrites = [];
  window.adviserAIRequests = 0;
  const user = { uid: 'adviser-review', displayName: 'Practice commander' };
  const service = {
    user, ready: true, rooms: {},
    commentary: { enabled: false, pending: [], status: 'off' },
    async save(games) { window.adviserWrites.push(structuredClone(games)); },
    requestCommentary() { window.adviserAIRequests++; return 0; },
    setCommentaryEnabled() {},
  };
  callbacks.onSession(user, window.fixtureCampaigns, true);
  callbacks.onLoadState({ status: 'ready' });
  return service;
}`;
const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
const existing = GameEngine.create('Existing campaign', 'ZA', true);
let browser;

/** Restore a fake signed-in account without allowing Firebase, model calls or real save writes. */
async function openPage(viewport, route = '', { reducedMotion = false } = {}) {
  const page = await browser.newPage({
    viewport,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.route(/\/cloud\.js(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeCloud }),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.addInitScript(
    ({ game, reducedMotion }) => {
      window.fixtureCampaigns = [game];
      localStorage.setItem('unrelated-save', 'keep');
      localStorage.setItem('meridian-motion-preference', reducedMotion ? 'reduced' : 'full');
    },
    { game: existing, reducedMotion },
  );
  await page.goto(origin + '/#tutorial' + (route ? '/' + route : ''));
  await page.waitForFunction(() => Array.isArray(window.adviserWrites));
  return { page, errors };
}

/** Check the actual lesson rather than inferring progress from button visibility. */
async function checkStep(page, step) {
  await page.locator(`[data-tutorial-step="${step}"]`).waitFor();
  assert.equal(await page.locator('.tutorial-guide').count(), 1);
}

/** Reserved layout space must keep the portrait and speech clear of the map and action controls. */
async function checkAdviserLayout(page) {
  const layout = await page.locator('.tutorial-adviser').evaluate((adviser) => {
    const bounds = adviser.getBoundingClientRect();
    const map = document.querySelector('.world-map').getBoundingClientRect();
    const action = document.querySelector('.action-panel').getBoundingClientRect();
    return {
      outsideActionColumn: !adviser.closest('.tutorial-action-column'),
      inMapColumn: Boolean(adviser.closest('.map-and-activity')),
      position: getComputedStyle(adviser).position,
      fitsWidth: bounds.left >= 0 && bounds.right <= innerWidth,
      aboveMap: bounds.bottom <= map.top + 1,
      clearOfAction:
        bounds.right <= action.left + 1 ||
        bounds.left >= action.right - 1 ||
        bounds.bottom <= action.top + 1 ||
        bounds.top >= action.bottom - 1,
    };
  });
  assert.equal(layout.outsideActionColumn, true);
  assert.equal(layout.inMapColumn, true);
  assert.ok(
    !['fixed', 'absolute'].includes(layout.position),
    'Reserve space for the speech bubble.',
  );
  assert.equal(layout.fitsWidth, true);
  assert.equal(layout.aboveMap, true, 'The adviser must not cover map markers.');
  assert.equal(layout.clearOfAction, true, 'The adviser must not cover the action sidebar.');
  await page.locator('.tutorial-adviser img').evaluate((image) => image.decode());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

/** Practice records onboarding progress without modifying campaigns or requesting model output. */
async function checkIsolation(page, errors, progress = 'offered') {
  const state = await page.evaluate(() => ({
    writes: window.adviserWrites,
    requests: window.adviserAIRequests,
    campaigns: window.fixtureCampaigns,
    progress: localStorage.getItem('meridian-tutorial-v1-adviser-review'),
    unrelated: localStorage.getItem('unrelated-save'),
  }));
  assert.deepEqual(state.writes, []);
  assert.equal(state.requests, 0);
  assert.deepEqual(state.campaigns, [existing]);
  assert.equal(state.progress, progress);
  assert.equal(state.unrelated, 'keep');
  assert.deepEqual(errors, []);
}

/** Observe real intermediate text so a completed, instant instruction cannot pass as typing. */
async function readTyping(page) {
  const sample = await page.waitForFunction(() => {
    const copy = document.querySelector('.tutorial-dialogue-copy');
    const typed = copy?.querySelector('.tutorial-dialogue-typed')?.textContent.length ?? 0;
    // Return the observed state atomically: another frame can run before a separate DOM read.
    return copy?.dataset.typing === 'true' && typed > 0
      ? {
          length: typed,
          fullLength: copy.querySelector('.tutorial-dialogue-text').textContent.length,
          height: copy.getBoundingClientRect().height,
        }
      : false;
  });
  try {
    return await sample.jsonValue();
  } finally {
    await sample.dispose();
  }
}

/** A redraw must preserve the sentence even when its first frame started before the click. */
async function checkAllocationTyping(plus) {
  const state = await plus.evaluate(async (button) => {
    const previousCopy = document.querySelector('.tutorial-dialogue-copy');
    const read = () => {
      const copy = document.querySelector('.tutorial-dialogue-copy');
      return {
        typed: copy.querySelector('.tutorial-dialogue-typed').textContent,
        full: copy.querySelector('.tutorial-dialogue-text').textContent,
        typing: copy.dataset.typing,
        paragraph: document.querySelector('.tutorial-guide').dataset.dialoguePage,
        allocation: document.querySelector('.allocation-row output').textContent,
      };
    };
    const before = read();
    const requestFrame = window.requestAnimationFrame;
    const frameStartedAt = performance.now() - 1;
    const afterFrames = [];
    // Chromium may deliver a frame-start timestamp older than the synchronous board mount.
    // Force that ordering and sample inside the callback so later typing cannot hide a rewind.
    window.requestAnimationFrame = (callback) =>
      requestFrame.call(window, (timestamp) => {
        callback(Math.min(timestamp, frameStartedAt));
        afterFrames.push(read());
      });
    let afterRender;
    try {
      afterRender = await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.tutorial-dialogue-copy') === previousCopy) return;
          observer.disconnect();
          resolve(read());
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // The click handler awaits the shared-game guard before replacing the board DOM.
        button.click();
      });
    } finally {
      window.requestAnimationFrame = requestFrame;
    }
    // This observer is queued after the mount's callbacks in the same frame.
    return new Promise((resolve) =>
      requestFrame.call(window, () => resolve({ before, afterRender, afterFrames })),
    );
  });
  assert.equal(state.before.typing, 'true', 'Allocate while the sentence is still typing.');
  assert.ok(state.before.typed.length > 0, 'The sentence must already have a visible prefix.');
  assert.equal(state.before.allocation, '+0');
  assert.equal(state.afterRender.allocation, '+1', 'The click must redraw the allocation.');
  assert.ok(state.afterFrames.length > 0, 'Exercise the first frame after the board redraw.');
  for (const after of [state.afterRender, ...state.afterFrames]) {
    assert.equal(after.full, state.before.full);
    assert.equal(after.paragraph, state.before.paragraph);
    assert.ok(
      after.typed.startsWith(state.before.typed),
      'Allocating a soldier rerenders the board without restarting the adviser sentence.',
    );
  }
}

/** The hand must identify an actual clickable control without covering its pointer hit target. */
async function checkPointer(page, control) {
  await page.waitForFunction(
    () => document.querySelector('.tutorial-dialogue-copy')?.dataset.typing !== 'true',
  );
  const pointer = page.locator('.tutorial-pointer');
  await pointer.waitFor({ state: 'visible', timeout: 10000 });
  const bounds = await control.boundingBox();
  assert.ok(bounds, 'The indicated control must exist on the practice board.');
  const cue = await pointer.evaluate((hand) => {
    const bounds = hand.getBoundingClientRect();
    return {
      x: bounds.left,
      y: bounds.top,
      hiddenFromReaders: hand.getAttribute('aria-hidden'),
      pointerEvents: getComputedStyle(hand).pointerEvents,
      target: hand.dataset.target,
    };
  });
  assert.equal(cue.hiddenFromReaders, 'true');
  assert.equal(cue.pointerEvents, 'none');
  assert.ok(cue.target, 'The cue identifies the current expected action.');
  assert.ok(cue.x >= bounds.x && cue.x <= bounds.x + bounds.width);
  assert.ok(cue.y >= bounds.y && cue.y <= bounds.y + bounds.height);
  assert.equal(
    await control.evaluate((button, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit === button || button.contains(hit);
    }, cue),
    true,
    'The animated hand must allow the player to click the indicated button.',
  );
}

try {
  browser = await chromium.launch({ headless: true });
  // Typing should explain the instruction without moving its card or performing the action for us.
  {
    const { page, errors } = await openPage({ width: 1440, height: 900 });
    const first = await readTyping(page);
    assert.ok(first.length < first.fullLength);
    assert.equal(
      await page.locator('.tutorial-dialogue-typed').getAttribute('aria-hidden'),
      'true',
    );
    assert.equal(await page.locator('.tutorial-pointer:visible').count(), 0);
    await page.waitForTimeout(200);
    const later = await page.locator('.tutorial-dialogue-typed').textContent();
    assert.ok(
      later.length > first.length,
      'The instruction must reveal additional letters over time.',
    );
    assert.match(await page.locator('.tutorial-dialogue-text').textContent(), /hello|welcome/i);
    assert.match(await page.locator('.tutorial-dialogue-text').textContent(), /Practice commander/);
    await checkPointer(page, page.locator('[data-tutorial-dialogue-next]'));
    await page.screenshot({
      path: '.firebase/tutorial-typing-pointer.png',
      animations: 'disabled',
    });
    assert.equal(
      await page
        .locator('.tutorial-dialogue-copy')
        .evaluate((copy) => copy.getBoundingClientRect().height),
      first.height,
      'Reserve full text height while the adviser types.',
    );
    await prepareInstruction(page);
    await checkPointer(page, page.locator('[data-action="tutorial-next"]'));
    await checkStep(page, 'welcome');
    await page.locator('[data-action="tutorial-next"]').click();
    await page.locator('.map-marker[data-code="ZA"] text').click();
    await checkStep(page, 'reinforce');
    await readTyping(page);
    const plus = page.locator('[data-action="allocate-plus"][data-code="ZA"]');
    await checkAllocationTyping(plus);
    await prepareInstruction(page);
    await checkPointer(page, plus);
    await plus.click();
    await checkPointer(page, page.locator('[data-action="confirm-reinforce"]'));
    await page.locator('[data-action="confirm-reinforce"]').click();
    await checkStep(page, 'attack');
    await readTyping(page);
    await page.locator('[data-action="tutorial-skip"]').click();
    await page.waitForURL('**/#campaigns');
    // Hash navigation updates the URL before the route handler disposes of the adviser DOM.
    await page.locator('.tutorial-guide').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.tutorial-pointer').count(), 0);
    assert.equal(await page.locator('[data-typing="true"]').count(), 0);
    await checkIsolation(page, errors, 'skipped');
    await page.close();
    console.log(
      'PASS: instructions type without layout shifts or replaying on allocation; ' +
        'the hand stays clickable and cleans up.',
    );
  }

  // An offscreen action needs one helpful reveal, rather than forcing the player to hunt for it.
  {
    const { page, errors } = await openPage({ width: 390, height: 600 });
    await prepareInstruction(page);
    await page.locator('[data-action="tutorial-next"]').click();
    await page.locator('.map-marker[data-code="ZA"] text').click();
    await checkStep(page, 'reinforce');
    await prepareInstruction(page);
    await readTyping(page);
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    );
    const plus = page.locator('[data-action="allocate-plus"][data-code="ZA"]');
    assert.equal(
      await plus.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.bottom > 0 && bounds.top < innerHeight;
      }),
      false,
      'This test must start with the expected action outside the viewport.',
    );
    await checkPointer(page, plus);
    await checkStep(page, 'reinforce');
    await checkIsolation(page, errors);
    await page.close();
    console.log(
      'PASS: completing an instruction scrolls an offscreen target into view without taking a turn.',
    );
  }

  // Players who disable movement still need the complete instruction and a stable next-action cue.
  {
    const { page, errors } = await openPage({ width: 1440, height: 900 }, '', {
      reducedMotion: true,
    });
    await checkStep(page, 'welcome');
    assert.equal(await page.locator('[data-typing="true"]').count(), 0);
    assert.equal(await page.locator('.tutorial-dialogue-typed').isVisible(), false);
    await checkPointer(page, page.locator('[data-tutorial-dialogue-next]'));
    assert.equal(
      await page
        .locator('.tutorial-pointer > svg')
        .evaluate((hand) => getComputedStyle(hand).animationName),
      'none',
    );
    await checkIsolation(page, errors);
    await page.close();
    console.log(
      'PASS: reduced motion reveals the complete instruction immediately and keeps the hand still.',
    );
  }

  // Replaying through the real menu and refreshing must keep the approved adviser presentation.
  {
    const { page, errors } = await openPage({ width: 1440, height: 900 });
    await checkStep(page, 'welcome');
    await checkAdviserLayout(page);
    await page.locator('[data-action="tutorial-skip"]').click();
    await page.waitForURL('**/#campaigns');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('meridian-tutorial-v1-adviser-review')),
      'skipped',
    );
    await page.getByRole('link', { name: 'Interactive tutorial', exact: true }).click();
    await checkStep(page, 'welcome');
    await checkAdviserLayout(page);
    await page.reload();
    await checkStep(page, 'welcome');
    await checkAdviserLayout(page);
    await checkIsolation(page, errors);
    await page.close();
    console.log('PASS: the normal tutorial, replay link and reload all retain the adviser.');
  }

  // Older preview bookmarks must show the same adviser as the normal tutorial route.
  const { page, errors } = await openPage({ width: 1440, height: 900 }, 'adviser');
  await checkStep(page, 'welcome');
  await checkAdviserLayout(page);
  await prepareInstruction(page);
  await page.locator('[data-action="tutorial-next"]').click();
  await checkStep(page, 'map');
  // Clicking another country is useful exploration, but must not complete the requested ZA action.
  await page.locator('.map-marker[data-code="EG"] text').click();
  await checkStep(page, 'map');
  await page.locator('.map-marker[data-code="ZA"] text').click();
  await checkStep(page, 'reinforce');
  const plus = page.locator('[data-action="allocate-plus"][data-code="ZA"]');
  await plus.click();
  await checkStep(page, 'reinforce');
  assert.equal(await page.locator('[data-action="confirm-reinforce"]').isDisabled(), true);
  await plus.click();
  const confirm = page.locator('[data-action="confirm-reinforce"]');
  assert.match(await confirm.getAttribute('class'), /tutorial-target/);
  await confirm.click();
  await checkStep(page, 'attack');
  await page.locator('#attack-to').selectOption('GB');
  await checkStep(page, 'attack');
  const launch = page.locator('[data-action="start-attack"]');
  assert.match(await launch.getAttribute('class'), /tutorial-target/);
  await checkAdviserLayout(page);
  await page.locator('.board-grid').evaluate((board) => {
    window.scrollTo({ top: board.getBoundingClientRect().top + scrollY - 12, behavior: 'instant' });
  });
  await page.screenshot({ path: '.firebase/tutorial-adviser-preview.png', animations: 'disabled' });
  await launch.click();
  await checkStep(page, 'dice');
  const roll = page.locator('[data-action="roll"]');
  assert.match(await roll.getAttribute('class'), /tutorial-target/);
  await roll.click();
  await page.waitForFunction(
    () => document.querySelector('.tutorial-guide')?.getAttribute('aria-busy') === 'false',
  );
  await checkStep(page, 'losses');
  assert.match(await page.locator('.action-panel').innerText(), /South Africa lost 1/);
  await checkIsolation(page, errors);
  await page.close();
  console.log(
    'PASS: the adviser guides real map, reinforcement, attack and dice actions without saving.',
  );

  // The reserved card must also fit a narrow viewport instead of overlaying the map or controls.
  const narrow = await openPage({ width: 390, height: 844 }, 'adviser');
  await checkStep(narrow.page, 'welcome');
  await checkAdviserLayout(narrow.page);
  await checkIsolation(narrow.page, narrow.errors);
  await narrow.page.close();
  console.log('PASS: the adviser fits narrow layouts and the older preview bookmark still works.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
