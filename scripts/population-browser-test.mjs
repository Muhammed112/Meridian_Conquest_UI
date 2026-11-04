import { chromium } from './lib/browser.mjs';
// Local fixtures only: no real campaign or Firebase account is changed.
import assert from 'node:assert/strict';
import { startTestServer } from './lib/static-server.mjs';

import { GameEngine } from '../dist/engine.js';
import { bundledPopulations } from '../dist/population-snapshot.js';
import { completeCampaignOpening } from './lib/setup.mjs';

let browser;
const server = await startTestServer();
try {
  browser = await chromium.launch({
    headless: true,
  });
  // Updated data affects only a new game; outages and invalid responses must keep setup playable.
  for (const scenario of ['updated', 'offline', 'malformed']) {
    const existing = GameEngine.create('Preserved campaign', 'ZA', true),
      original = JSON.stringify(existing);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((existing) => {
      localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([existing]));
      Math.random = () => 0;
    }, existing);
    await page.route('**/cloud.js?*', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'export const cloudEnabled=false;export async function connectCloud(){return null;}',
      }),
    );
    let pending;
    const requested = new Promise((resolve) => {
      pending = resolve;
    });
    // Hold the response until the player has edited setup, exposing redraws that could discard input.
    let populationRequest;
    await page.route('**/publicData/populations', (route) => {
      populationRequest = route;
      pending();
    });
    await page.goto('http://localhost:' + server.address().port + '/#setup');
    await requested;
    await page.locator('#session-name').fill('Keep this campaign name');
    const countries = await page.locator('.setup-roster-row > span:nth-child(2)').allTextContents();
    const order = await page.locator('.setup-grid .notice strong').last().textContent();
    if (scenario === 'updated') {
      const snapshot = {
        ...structuredClone(bundledPopulations),
        fetchedAt: new Date(Date.now() + 1000).toISOString(),
      };
      snapshot.populations.ZA = 76000001;
      await populationRequest.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ fields: { payload: { stringValue: JSON.stringify(snapshot) } } }),
      });
      await page.waitForFunction(
        () => document.querySelector('[data-code="ZA"] .strength')?.textContent.trim() === '6',
      );
      assert.equal(await page.locator('#session-name').inputValue(), 'Keep this campaign name');
      assert.deepEqual(
        await page.locator('.setup-roster-row > span:nth-child(2)').allTextContents(),
        countries,
      );
      assert.equal(await page.locator('.setup-grid .notice strong').last().textContent(), order);
      assert.match(await page.locator('[data-code="ZA"] .country-owner').innerText(), /76.000.001/);
    } else {
      if (scenario === 'offline') await populationRequest.abort('failed');
      else
        await populationRequest.fulfill({
          contentType: 'application/json',
          body: '{"fields":{"payload":{"stringValue":"{}"}}}',
        });
      await page.getByText(/Using saved data/).waitFor();
      assert.match(await page.locator('[data-code="ZA"] .strength').innerText(), /5/);
    }
    await completeCampaignOpening(page);
    await page.locator('[data-action="create-game"]').click();
    await page.locator('.game-heading h1').waitFor();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('meridian-conquest-ui-v2')),
    );
    assert.equal(JSON.stringify(saved.find((g) => g.id === existing.id)), original);
    assert.equal(saved[0].countries[0].value, scenario === 'updated' ? 6 : 5);
    assert.equal(saved[0].countries[0].army, scenario === 'updated' ? 6 : 5);
    assert.equal(saved[0].name, 'Keep this campaign name');
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        scenario +
        ' population source; setup remains playable and existing campaign is unchanged',
    );
    await page.close();
  }
  // An explicitly selected running site adds a read-only source check; ordinary runs remain mocked.
  if (process.env.POPULATION_TEST_ORIGIN) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.POPULATION_TEST_ORIGIN + '/#setup');
    await page.locator('[data-population-status]').waitFor();
    await page.waitForFunction(() => Boolean(localStorage.getItem('meridian-populations-v2')));
    const cached = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('meridian-populations-v2')),
    );
    assert.equal(cached.snapshot.source, bundledPopulations.source);
    assert.equal(
      Object.keys(cached.snapshot.populations).length,
      Object.keys(bundledPopulations.populations).length,
    );
    assert.match(
      await page.locator('[data-code="ZA"] .country-owner').innerText(),
      new RegExp(cached.snapshot.populations.ZA.toLocaleString('en-US').replaceAll(',', '.')),
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: running app reads its population snapshot in the browser and shows' +
        ' the dated source in setup',
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
