// Offline integration checks for lazy histories, recovery and keyboard focus using the real app/store.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { installCampaignFixture } from './lib/campaign-fixture.mjs';
import { GameEngine } from '../dist/engine.js';

const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const game = GameEngine.create('Slow history', 'ZA', true);
  const other = GameEngine.create('Healthy campaign', 'JP', true);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // One damaged record and one delayed history must not prevent opening the healthy campaign.
  await installCampaignFixture(page, [game, other], { damaged: true });
  await page.goto(origin + '/#campaigns');
  await page.locator('.campaign-card').first().waitFor();
  assert.equal(await page.locator('.campaign-card').count(), 2);
  assert.equal(await page.evaluate(() => window.historyReads.length), 0);
  assert.match(await page.locator('#app').innerText(), /Some campaigns need attention/);
  await page.evaluate((id) => {
    window.historyModes[id] = 'hold';
  }, game.id);
  await page.locator(`a[href="#game/${game.id}"]`).click();
  await page.getByRole('heading', { name: 'Loading this campaign…' }).waitFor();
  assert.equal(await page.evaluate(() => window.campaignWrites), 0);
  await page.evaluate((id) => {
    window.historyModes[id] = 'fail';
  }, game.id);
  await page.locator('[data-action="retry-campaign-history"]').waitFor();
  await page.locator('main a[href="#campaigns"]').click();
  await page.locator(`a[href="#game/${other.id}"]`).click();
  await page.locator('.game-heading').waitFor();
  console.log(
    'PASS: damaged and stalled histories leave other campaigns usable; no eager history reads.',
  );

  // Repeated keyboard allocation exposes focus loss when the entire action panel is rerendered.
  const plus = page.locator('[data-action="allocate-plus"]').first();
  await plus.focus();
  await plus.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'allocate-plus');
  for (let index = 1; index < other.budget; index++) await page.keyboard.press('Enter');
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.action),
    'confirm-reinforce',
  );
  await page.keyboard.press('Enter');
  await page.locator('[data-action="start-attack"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H2');
  const marker = page.locator('.map-marker[role="button"]').first();
  await marker.focus();
  const code = await marker.getAttribute('data-code');
  await marker.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.code), code);
  await page.getByRole('tab', { name: 'Field reports', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page
      .getByRole('tab', { name: 'AI commentary', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  console.log(
    'PASS: keyboard focus survives reinforcement redraws, phase changes, map selection and report tabs.',
  );

  // Retry the originally failed history, then reload to verify recovery is retained rather than partial.
  await page.goto(origin + '/#game/' + game.id);
  await page.locator('[data-action="retry-campaign-history"]').waitFor();
  await page.evaluate((id) => {
    window.historyModes[id] = 'ready';
  }, game.id);
  await page.locator('[data-action="retry-campaign-history"]').click();
  await page.locator('.game-heading').waitFor();
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
  }
  await page.reload();
  await page.locator('.game-heading').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: retry and reload retain complete histories across desktop, tablet and mobile.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
