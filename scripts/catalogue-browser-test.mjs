import { chromium } from './lib/browser.mjs';
// Local-only fixtures: country selection, markers and NPC reasoning in both speeds.
import assert from 'node:assert/strict';
import { startTestServer } from './lib/static-server.mjs';
import { GameEngine } from '../dist/engine.js';
import { catalogue } from '../dist/data.js';
import { completeCampaignOpening } from './lib/setup.mjs';

let browser;
const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
/** Create a deterministic local fixture and collect uncaught browser errors. */
async function pageFor(game) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((game) => {
    Math.random = () => 0.5;
    if (game) localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game]));
  }, game);
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  return { page, errors };
}
try {
  browser = await chromium.launch({
    headless: true,
  });
  // A tiny playable territory checks catalogue completeness and marker selection without an outline.
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const { page, errors } = await pageFor();
    await page.setViewportSize(viewport);
    await page.goto(origin + '/#setup');
    assert.equal(await page.locator('.country-option').count(), catalogue.length);
    // Flags must be real local images: native flag emoji can render as letters on Windows.
    assert.equal(await page.locator('.country-option .country-flag').count(), catalogue.length);
    assert.equal(await page.locator('.setup-roster-row .country-flag').count(), 10);
    await page.locator('.roster-list').scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.setup-roster-row .country-flag')].every(
        (image) =>
          image.complete && image.naturalWidth > 0 && new URL(image.src).origin === location.origin,
      ),
    );
    await page.screenshot({
      path: `.firebase/setup-flags-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.locator('#country-search').fill('Vatican');
    assert.equal(await page.locator('.country-option').count(), 1);
    await page.locator('[data-action="setup-country"][data-code="VA"]').click();
    await page.locator('[data-code="VA"] .country-flag').evaluate((image) => image.decode());
    assert.match(await page.locator('[data-code="VA"] .country-owner').innerText(), /506 people/);
    await page.locator('#session-name').fill('Vatican browser fixture');
    await completeCampaignOpening(page);
    await page.locator('[data-action="create-game"]').click();
    await page.locator('.game-heading').waitFor();
    const saved = await page.evaluate(
      () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0],
    );
    assert.equal(saved.countries[0].code, 'VA');
    assert.equal(saved.countries.length, 10);
    assert.equal(saved.countries[0].value, 1);
    assert.equal(await page.locator('.country-row[data-code="VA"]').count(), 1);
    // Every roster row must retain its ISO code beside a real flag, including tiny territories.
    assert.equal(await page.locator('.country-row .country-flag').count(), 10);
    assert.equal(
      await page
        .locator('.country-row')
        .evaluateAll((rows) =>
          rows.every(
            (row) => row.querySelector('.country-identity').textContent.trim() === row.dataset.code,
          ),
        ),
      true,
    );
    await page
      .locator('.country-row[data-code="VA"] .country-flag')
      .evaluate((image) => image.decode());
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      'Flags and abbreviations must fit the existing roster layout.',
    );
    await page.locator('.roster-panel').screenshot({
      path: `.firebase/roster-flags-${viewport.width}.png`,
      animations: 'disabled',
    });
    assert.equal(await page.locator('.map-marker[data-code="VA"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        viewport.width +
        'px full catalogue, Vatican selection, one starting soldier and a selectable map marker',
    );
    await page.close();
  }
  // Unequal ownership checks grouping and selection while keeping the original neutral rows.
  {
    const game = GameEngine.create('Grouped roster browser fixture', 'ZA', true);
    const owners = [1, 0, 1, 2, 0, 1, 2, 0, 1, 1];
    game.countries.forEach((country, index) => {
      country.owner = owners[index];
    });
    game.position = game.order.indexOf(0);
    game.turnStarted = false;
    const { page, errors } = await pageFor(game);
    await page.goto(origin + '/#game/' + game.id);
    await page.locator('.game-heading').waitFor();
    const rows = page.locator('.country-row');
    assert.deepEqual(
      await rows.evaluateAll((rows) => rows.map((row) => row.dataset.code)),
      [0, 2, 5, 8, 9, 1, 4, 7, 3, 6].map((index) => game.countries[index].code),
    );
    // Each neutral outline must contain exactly one owner's countries, with a visible gap.
    const groups = page.locator('.country-owner-group');
    assert.deepEqual(
      await groups.evaluateAll((groups) =>
        groups.map((group) => group.querySelectorAll('.country-row').length),
      ),
      [5, 3, 2],
    );
    const outlines = await groups.evaluateAll((groups) =>
      groups.map((group) => {
        const style = getComputedStyle(group);
        const rect = group.getBoundingClientRect();
        return {
          border: style.borderTopWidth,
          colour: style.borderTopColor,
          top: rect.top,
          bottom: rect.bottom,
        };
      }),
    );
    assert.ok(outlines.every((outline) => outline.border === '1px'));
    assert.ok(outlines.every((outline) => outline.colour === outlines[0].colour));
    assert.ok(outlines[1].top > outlines[0].bottom);
    const first = rows.first();
    const background = await first.evaluate((row) => getComputedStyle(row).backgroundColor);
    assert.equal(background, 'rgba(0, 0, 0, 0)');
    assert.equal(
      await rows.nth(4).evaluate((row) => getComputedStyle(row).backgroundColor),
      background,
      'Unselected rows retain their original neutral background.',
    );
    assert.equal(
      await rows.last().evaluate((row) => getComputedStyle(row).backgroundColor),
      background,
      'Rows remain neutral regardless of their owner.',
    );
    await first.click();
    assert.equal(await first.getAttribute('data-code'), game.countries[0].code);
    assert.ok((await first.getAttribute('class')).includes('selected'));
    assert.equal(
      await page.locator('.selected-country h3').innerText(),
      game.countries[0].flag + ' ' + game.countries[0].name,
    );
    const savedCodes = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0].countries.map(
        (country) => country.code,
      ),
    );
    assert.deepEqual(
      savedCodes,
      game.countries.map((country) => country.code),
    );
    await page.locator('.roster-panel').screenshot({
      path: '.firebase/roster-grouped.png',
      animations: 'disabled',
    });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: owner groups rank by country count, retain neutral rows and stay selectable',
    );
    await page.close();
  }
  // Start at phase nineteen to verify the real twentieth-phase cap, not a randomly ended battle.
  for (const fast of [false, true]) {
    const game = GameEngine.create('NPC phase-limit fixture', 'ZA', true);
    Object.assign(game, {
      position: game.order.indexOf(1),
      budget: 0,
      attackUsed: false,
      battle: null,
      turnStarted: true,
      events: [],
    });
    const engine = new GameEngine(game),
      from = game.countries.find((country) => country.owner === 1),
      to = game.countries.find((country) => country.owner === 2);
    from.army = 20;
    to.army = 5;
    engine.startAttack(from.code, to.code);
    for (let phase = 0; phase < 19; phase++) engine.roll(() => 4);
    const { page, errors } = await pageFor(game);
    await page.goto(origin + '/#game/' + game.id);
    if (fast) await page.locator('.action-panel [data-action="fast"]').click();
    await page.waitForFunction(() =>
      JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0].events.some(
        (event) => event.type === 'decision' && /Stopping.*20 phases/.test(event.text),
      ),
    );
    const saved = await page.evaluate(
      () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0],
    );
    const decisions = saved.events.filter((event) => event.type === 'decision');
    assert.ok(
      decisions.some((event) =>
        /Continuing.*19 available attackers against 5 defenders/.test(event.text),
      ),
    );
    assert.match(
      await page.locator('[data-report-panel="field"] .activity-feed').innerText(),
      /Stopping.*20 phases/,
    );
    assert.equal(saved.events.filter((event) => event.type === 'dice').length, 20);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        (fast ? 'fast' : 'normal') +
        ' playback shows continuing rationale and the true 20-phase stopping reason',
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
