import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { CAMPAIGN_STORAGE_KEY, GameEngine } from '../dist/engine.js';

// Exercise real replay controls and the real dialog with no accounts, cloud writes or model calls.
const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
const errors = [];
const modelRequests = [];
const game = GameEngine.create('Summary browser check', 'ZA', true, 'medium', 'Mo');
let browser;

/** Keep every fixture local, including pages whose AI transport is deliberately stubbed. */
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || /generateContent/i.test(url.pathname))
      modelRequests.push(url.pathname);
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/firebase-config.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'export const firebaseConfig = null;',
      });
    if (url.pathname === '/summary-fixture.html')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head>
          <meta charset="utf-8"><link rel="stylesheet" href="./styles.css">
          <title>Offline summary fixture</title></head><body>
          <button id="fixture-open">Open summary</button>
          <dialog id="help-dialog" aria-labelledby="help-title"></dialog></body></html>`,
      });
    return route.continue();
  });
  return page;
}

/** A summary must pause playback and leave the existing source record unchanged. */
async function checkReplayIntegration() {
  const page = await openPage();
  await page.addInitScript(
    ({ key, game }) => {
      localStorage.setItem(key, JSON.stringify([game]));
      localStorage.setItem('meridian-motion-preference', 'reduced');
      localStorage.setItem('meridian-ai-commentary', 'off');
    },
    { key: CAMPAIGN_STORAGE_KEY, game },
  );
  await page.goto(origin + '/#history/' + game.id);
  const controls = page.locator('.history-controls');
  const button = page.getByRole('button', { name: 'AI summary', exact: true });
  await button.waitFor();
  await controls.scrollIntoViewIfNeeded();
  const layout = await controls.evaluate((element) => {
    const controls = element.getBoundingClientRect();
    const summary = element.querySelector('[data-action="replay-summary"]').getBoundingClientRect();
    const play = element.querySelector('[data-action="replay-play"]').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      summaryVisible: summary.left >= 0 && summary.right <= innerWidth,
      inControls: summary.left >= controls.left && summary.right <= controls.right,
      besidePlay: Math.abs(summary.top - play.top) < 2,
    };
  });
  assert.deepEqual(layout, {
    overflow: false,
    summaryVisible: true,
    inControls: true,
    besidePlay: true,
  });
  const savedBefore = await page.evaluate((key) => localStorage.getItem(key), CAMPAIGN_STORAGE_KEY);
  await page.clock.install();
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await button.click();
  const dialog = page.locator('#help-dialog');
  await page.waitForFunction(() => document.getElementById('help-dialog').open);
  assert.match(await dialog.innerText(), /Sign in to generate an AI summary/);
  assert.ok((await dialog.locator('[data-summary-event]').count()) > 0);
  const pausedEvent = await page.locator('#history-range').inputValue();
  await page.clock.runFor(6000);
  assert.equal(await page.locator('#history-range').inputValue(), pausedEvent);
  assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).count(), 0);

  // Source links use real event indices, then return keyboard and pointer access to replay.
  const source = await dialog
    .locator('[data-summary-event]')
    .last()
    .getAttribute('data-summary-event');
  const expectedIndex = game.events.findIndex((event) => event.id === source);
  await dialog.locator('[data-summary-event]').last().click();
  assert.equal(await dialog.evaluate((element) => element.open), false);
  assert.equal(Number(await page.locator('#history-range').inputValue()), expectedIndex);
  await button.click();
  await page.getByRole('button', { name: 'Close game summary', exact: true }).click();
  assert.equal(await dialog.evaluate((element) => element.open), false);
  await button.click();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.evaluate((element) => element.open), false);
  await page.getByRole('button', { name: 'Previous event', exact: true }).click();
  assert.equal(Number(await page.locator('#history-range').inputValue()), expectedIndex - 1);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), CAMPAIGN_STORAGE_KEY),
    savedBefore,
    'Summaries and source navigation must not rewrite the saved campaign.',
  );
  await mkdir('.firebase', { recursive: true });
  await page.screenshot({ path: '.firebase/game-summary-browser.png', fullPage: true });
  await page.close();
  console.log(
    'PASS: replay summary is beside playback; signed-out facts pause replay and preserve saves.',
  );
}

/** Install a controllable transport while retaining the production dialog, rendering and events. */
async function installDialogFixture(page) {
  await page.goto(origin + '/summary-fixture.html');
  await page.evaluate(async (game) => {
    const { createGameSummaryDialog } = await import('./ui/game-summary.js');
    const fixture = {
      user: { uid: 'summary-player' },
      game,
      requests: [],
      selected: [],
      pauses: 0,
    };
    fixture.controller = createGameSummaryDialog({
      getCloud: () => ({
        summarizeGame(record) {
          return new Promise((resolve, reject) => {
            fixture.requests.push({ record: JSON.stringify(record), resolve, reject });
          });
        },
      }),
      getUser: () => fixture.user,
      notify: (message) => {
        throw new Error(message);
      },
      pauseReplay: () => fixture.pauses++,
      onSelectEvent: (index) => fixture.selected.push(index),
    });
    document.getElementById('fixture-open').addEventListener('click', () => {
      void fixture.controller.open(fixture.game);
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="close-help"]'))
        document.getElementById('help-dialog').close();
    });
    window.summaryFixture = fixture;
  }, game);
}

async function requestCount(page, count) {
  await page.waitForFunction((count) => window.summaryFixture.requests.length === count, count);
}

/** Complete a transport promise with plain text that would be unsafe if inserted as HTML. */
async function completeRequest(page, index, overview = 'The recorded campaign has changed hands.') {
  await page.evaluate(
    ({ index, overview }) => {
      const fixture = window.summaryFixture;
      fixture.requests[index].resolve({
        overview,
        moments: [
          { eventId: fixture.game.events[1].id, text: 'A decisive <b>recorded</b> conquest.' },
        ],
      });
    },
    { index, overview },
  );
}

/** Reopening should reuse successful work; failures and account changes must remain isolated. */
async function checkGeneratedSummary() {
  const page = await openPage();
  await installDialogFixture(page);
  const dialog = page.locator('#help-dialog');
  const before = await page.evaluate(() => JSON.stringify(window.summaryFixture.game));
  await page.locator('#fixture-open').click();
  await requestCount(page, 1);
  assert.match(await dialog.innerText(), /Generating AI summary/);
  assert.equal(await dialog.locator('[data-summary-event]').count(), 0);
  assert.equal(await dialog.locator('[data-summary-key-events]').count(), 0);
  const unsafeOverview = '<img src=x onerror="window.summaryInjected=true"> Mo gained territory.';
  await completeRequest(page, 0, unsafeOverview);
  await page.getByRole('heading', { name: 'AI summary', exact: true }).waitFor();
  assert.ok((await dialog.innerText()).includes(unsafeOverview));
  const recordedFact = await page.evaluate(async () => {
    const { buildGameSummary } = await import('./game-summary.js');
    const fixture = window.summaryFixture;
    return buildGameSummary(fixture.game).moments.find(
      (moment) => moment.eventId === fixture.game.events[1].id,
    ).text;
  });
  assert.equal(await dialog.locator('[data-summary-fact]').innerText(), recordedFact);
  assert.match(await dialog.locator('[data-summary-key-events]').innerText(), /Country captured/);
  assert.equal(
    await dialog
      .locator('[data-summary-key-events]')
      .evaluate(
        (events) =>
          events.getBoundingClientRect().top <
          document.querySelector('[data-summary-overview]').getBoundingClientRect().top,
      ),
    true,
    'Specific key events must appear before the general recap.',
  );
  assert.equal(
    await dialog.locator('img,b').count(),
    0,
    'Model text must stay escaped in the dialog.',
  );
  assert.equal(await page.evaluate(() => window.summaryInjected), undefined);
  await page.screenshot({ path: '.firebase/game-summary-key-events.png', fullPage: true });
  await dialog.getByRole('button', { name: 'View moment', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.summaryFixture.selected), [1]);
  await page.locator('#fixture-open').click();
  await page.getByRole('heading', { name: 'AI summary', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.summaryFixture.requests.length), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(window.summaryFixture.game)), before);
  assert.equal(await page.evaluate(() => window.summaryFixture.requests[0].record), before);
  await page.keyboard.press('Escape');

  // A failed request keeps factual moments, while Retry performs exactly one fresh request.
  await page.evaluate(() => window.summaryFixture.game.updatedAt++);
  await page.locator('#fixture-open').click();
  await requestCount(page, 2);
  await page.evaluate(() => window.summaryFixture.requests[1].reject(new Error('Fixture failure')));
  await dialog.getByRole('button', { name: 'Retry AI summary', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /Recorded key moments are shown below/);
  assert.ok((await dialog.locator('[data-summary-event]').count()) > 0);
  await dialog.getByRole('button', { name: 'Retry AI summary', exact: true }).click();
  await requestCount(page, 3);
  await completeRequest(page, 2, 'Retry produced a summary of the recorded campaign.');
  await page.getByRole('heading', { name: 'AI summary', exact: true }).waitFor();
  await page.keyboard.press('Escape');

  // A finished request must not overwrite another help panel after its own dialog has closed.
  await page.evaluate(() => window.summaryFixture.game.updatedAt++);
  await page.locator('#fixture-open').click();
  await requestCount(page, 4);
  await page.evaluate(() => {
    window.summaryFixture.controller.close();
    const dialog = document.getElementById('help-dialog');
    dialog.innerHTML = '<h2 id="help-title">Other help remains open</h2>';
    dialog.showModal();
  });
  await completeRequest(page, 3, 'An obsolete summary must stay out of the replacement dialog.');
  assert.equal(await dialog.innerText(), 'Other help remains open');
  await page.keyboard.press('Escape');

  // Changing accounts clears cached work and makes the previous account's completion harmless.
  await page.evaluate(() => window.summaryFixture.game.updatedAt++);
  await page.locator('#fixture-open').click();
  await requestCount(page, 5);
  await page.evaluate(() => {
    const fixture = window.summaryFixture;
    fixture.user = { uid: 'another-summary-player' };
    fixture.controller.reset();
    void fixture.controller.open(fixture.game);
  });
  await requestCount(page, 6);
  await completeRequest(page, 4, 'Previous account summary');
  assert.match(await dialog.innerText(), /Generating AI summary/);
  assert.doesNotMatch(await dialog.innerText(), /Previous account summary/);
  await completeRequest(page, 5, 'Current account summary');
  await page.getByRole('heading', { name: 'AI summary', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /Current account summary/);
  assert.doesNotMatch(await dialog.innerText(), /Previous account summary/);
  await page.keyboard.press('Escape');
  await page.locator('#fixture-open').click();
  await page.getByRole('heading', { name: 'AI summary', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.summaryFixture.requests.length), 6);
  await page.close();
  console.log(
    'PASS: AI loading, escaping, source jumps, cached reopen, retry and stale-account guards.',
  );
}

try {
  browser = await chromium.launch({ headless: true });
  await checkReplayIntegration();
  await checkGeneratedSummary();
  assert.deepEqual(errors, []);
  assert.deepEqual(modelRequests, [], 'Offline summary checks must never call a model endpoint.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
