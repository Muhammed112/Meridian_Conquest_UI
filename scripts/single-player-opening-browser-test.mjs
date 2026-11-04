import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { CAMPAIGN_STORAGE_KEY } from '../dist/engine.js';

// Exercise the actual setup controls without accounts, cloud writes or AI requests.
const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
const errors = [];
let browser;

/** Override only opening-die bytes, leaving UUIDs and unrelated randomness intact. */
async function openSetup(motion = 'full', viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((motion) => {
    localStorage.setItem('meridian-ui-profile', JSON.stringify({ name: 'Ace <Commander>' }));
    localStorage.setItem('meridian-ai-commentary', 'off');
    localStorage.setItem('meridian-motion-preference', motion);
    window.openingBytes = [];
    window.openingDraws = 0;
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (values) => {
      if (values instanceof Uint8Array && values.length === 1) {
        window.openingDraws++;
        if (!window.openingBytes.length) throw new Error('Unexpected opening-die request.');
        values[0] = window.openingBytes.shift();
        return values;
      }
      return getRandomValues(values);
    };
  }, motion);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/firebase-config.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'export const firebaseConfig = null;',
      });
    return route.continue();
  });
  await page.goto(origin + '/#setup');
  await page.locator('[data-action="setup-roll"]').waitFor();
  return page;
}

/** Read visible die faces so changes to opening state must also reach the interface. */
async function faces(page) {
  return page
    .locator('.setup-opening-die .die')
    .evaluateAll((dice) => dice.map((die) => Number(die.dataset.dieFinal)));
}

/** Desktop seats run down five rows per column so every die stays visible after rolling. */
async function checkRosterLayout(page, columns, allVisible = false) {
  const geometry = await page.locator('.setup-roster-row').evaluateAll((rows) => {
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return {
      rows: rows.map(bounds),
      dice: rows.map((row) => bounds(row.querySelector('.setup-opening-die'))),
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(geometry.rows.length, 10);
  assert.ok(geometry.documentWidth <= geometry.width + 1, 'The roster must not widen the page.');
  for (let seat = 0; seat < 10; seat++) {
    const row = geometry.rows[seat];
    const first = geometry.rows[columns === 2 && seat >= 5 ? 5 : 0];
    assert.ok(Math.abs(row.left - first.left) < 1, 'Seats must stay in their expected column.');
    if (seat % (columns === 2 ? 5 : 10) > 0)
      assert.ok(row.top >= geometry.rows[seat - 1].bottom - 1, 'Country rows must not overlap.');
    if (allVisible) {
      const die = geometry.dice[seat];
      assert.ok(die.top >= 0 && die.bottom <= geometry.height, 'All ten dice must fit in view.');
    }
  }
  if (columns === 2) {
    assert.ok(
      geometry.rows[5].left >= geometry.rows[0].right,
      'The right column follows seat five.',
    );
    for (let seat = 0; seat < 5; seat++)
      assert.ok(Math.abs(geometry.rows[seat].top - geometry.rows[seat + 5].top) < 1);
  }
}

/** Long labels must remain readable inside each country row rather than covering adjacent dice. */
async function checkLongRosterLabels(page) {
  const labels = await page
    .locator('.setup-roster-row')
    .first()
    .evaluate((row) => {
      const country = row.children[1];
      const owner = row.querySelector('.who');
      const original = { country: country.textContent, owner: owner.textContent };
      country.textContent = 'South Georgia and the South Sandwich Islands';
      owner.textContent = 'P1 ACommanderWithThirtyTwoCharacters';
      return original;
    });
  try {
    assert.equal(
      await page
        .locator('.setup-roster-row')
        .first()
        .evaluate((row) =>
          [row.children[1], row.querySelector('.who')].every((label) => {
            const rect = label.getBoundingClientRect();
            const parent = row.getBoundingClientRect();
            return (
              label.scrollWidth <= label.clientWidth + 1 &&
              label.scrollHeight <= label.clientHeight + 1 &&
              rect.left >= parent.left &&
              rect.right <= parent.right
            );
          }),
        ),
      true,
      'Long country and commander names must wrap within their cells.',
    );
    await checkRosterLayout(page, 2);
  } finally {
    await page
      .locator('.setup-roster-row')
      .first()
      .evaluate((row, labels) => {
        row.children[1].textContent = labels.country;
        row.querySelector('.who').textContent = labels.owner;
      }, labels);
  }
}

/** Supply exactly one byte per eligible player, catching accidental rerolls of other seats. */
async function roll(page, bytes, action = 'setup-roll', duringRoll = null) {
  await page.evaluate((bytes) => (window.openingBytes = bytes), bytes);
  await page.locator(`[data-action="${action}"]`).click();
  await page.waitForFunction(() => window.openingBytes.length === 0);
  if (duringRoll) await duringRoll(page);
  await page.locator('[data-setup-opening-rolling="false"]').waitFor();
}

/** Animated dice must conceal the winner and ignore extra clicks until their cosmetic roll ends. */
async function checkRolling(page, count) {
  await page.locator('[data-setup-opening-rolling="true"]').waitFor();
  const dice = page.locator('.setup-opening-die.dice-rolling .die');
  assert.equal(await dice.count(), count);
  assert.equal(
    await dice.evaluateAll((dice) =>
      dice.every((die) => getComputedStyle(die).animationName !== 'none'),
    ),
    true,
  );
  assert.equal(await page.locator('.setup-opening-die .die.winner').count(), 0);
  assert.equal(await page.locator('[data-action="create-game"]').count(), 0);
  assert.doesNotMatch(
    await page.locator('[data-setup-opening-status]').textContent(),
    /will take the first turn|highest roll is tied/,
  );
  const displayed = await dice.evaluateAll((dice) => dice.map((die) => die.dataset.displayFace));
  await page.waitForFunction(
    (previous) =>
      [...document.querySelectorAll('.setup-opening-die.dice-rolling .die')].some(
        (die, index) => die.dataset.displayFace !== previous[index],
      ),
    displayed,
  );
  const draws = await page.evaluate(() => window.openingDraws);
  await page.evaluate(() => {
    for (const action of ['setup-roll', 'setup-reroll', 'create-game']) {
      const button = document.createElement('button');
      button.dataset.action = action;
      document.body.append(button);
      button.click();
      button.remove();
    }
  });
  assert.equal(await page.evaluate(() => window.openingDraws), draws);
  assert.deepEqual(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || '[]'),
      CAMPAIGN_STORAGE_KEY,
    ),
    [],
    'Extra clicks during animation must never save or reroll a campaign.',
  );
}

/** Injecting an unavailable start action must still fail the controller guard. */
async function checkStartGuard(page) {
  assert.equal(await page.locator('[data-action="create-game"]').count(), 0);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.dataset.action = 'create-game';
    document.body.append(button);
    button.click();
    button.remove();
  });
  await page
    .getByText('Finish the opening dice rolls before starting the campaign.', { exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).hash, '#setup');
  assert.deepEqual(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || '[]'),
      CAMPAIGN_STORAGE_KEY,
    ),
    [],
    'An unfinished opening roll must not create a campaign.',
  );
}

/** Compare the saved first turn with the displayed roll winner before later NPC decisions matter. */
async function startAndRead(page, expectedSeat) {
  const selectedCountries = await page
    .locator('.setup-roster-row')
    .evaluateAll((rows) => rows.map((row) => row.textContent.replace(/\s+/g, ' ').trim()));
  assert.equal(selectedCountries.length, 10);
  await page.locator('[data-action="create-game"]').click();
  await page.locator('.board-grid').waitFor();
  const game = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key))[0],
    CAMPAIGN_STORAGE_KEY,
  );
  assert.equal(game.order[0], expectedSeat);
  assert.equal(game.events[0].type, 'turn');
  assert.equal(game.events[0].player, expectedSeat);
  assert.equal(game.playerNames[0], 'Ace <Commander>');
  assert.equal(game.countries.length, 10);
  for (const country of game.countries)
    assert.ok(selectedCountries.some((row) => row.includes(country.name)));
  return game;
}

try {
  browser = await chromium.launch({ headless: true });
  const human = await openSetup();
  await checkStartGuard(human);
  await roll(human, [5, 0, 1, 2, 3, 4, 0, 1, 2, 3], 'setup-roll', async (page) => {
    await checkRosterLayout(page, 2, true);
    await checkRolling(page, 10);
    // A settings redraw must resume the existing clock rather than restart the dice animation.
    await page.locator('#session-name').fill('Opening roll campaign');
    await page.locator('#difficulty-hard').check();
    assert.equal(await page.locator('.setup-opening-die.dice-rolling .die').count(), 10);
    assert.equal(
      await page
        .locator('.setup-opening-die.dice-rolling')
        .first()
        .evaluate((tray) => parseFloat(tray.style.getPropertyValue('--roll-offset')) < 0),
      true,
      'Redrawing settings must retain elapsed opening animation time.',
    );
  });
  assert.deepEqual(await faces(human), [6, 1, 2, 3, 4, 5, 1, 2, 3, 4]);
  await human.screenshot({ path: '.firebase/single-player-opening-two-columns.png' });
  await checkLongRosterLabels(human);
  assert.equal(await human.locator('[data-action="create-game"]').isEnabled(), true);
  const completedFaces = await faces(human);
  await human.locator('#session-name').fill('Opening roll campaign');
  await human.locator('#difficulty-hard').check();
  assert.deepEqual(
    await faces(human),
    completedFaces,
    'Editing settings must retain completed rolls.',
  );

  // Replacing the lineup mid-animation must cancel its presentation without exposing stale results.
  await human.locator('[data-action="redraw-roster"]').click();
  await roll(human, [5, 0, 1, 2, 3, 4, 0, 1, 2, 3], 'setup-roll', async (page) => {
    await page.locator('[data-setup-opening-rolling="true"]').waitFor();
    await page.locator('#country-search').fill('Brazil');
    await page.locator('#country-options [data-action="setup-country"][data-code="BR"]').click();
    assert.equal(await page.locator('.setup-opening-die.dice-rolling').count(), 0);
    assert.deepEqual(await faces(page), []);
  });
  await checkStartGuard(human);
  await roll(human, [5, 0, 1, 2, 3, 4, 0, 1, 2, 3]);
  await human.locator('[data-action="redraw-roster"]').click();
  await checkStartGuard(human);
  await roll(human, [5, 0, 1, 2, 3, 4, 0, 1, 2, 3]);
  await human.locator('.roster-list').scrollIntoViewIfNeeded();
  await human.screenshot({ path: '.firebase/single-player-opening.png', fullPage: true });
  const humanGame = await startAndRead(human, 0);
  assert.equal(humanGame.start, 'BR');
  assert.equal(humanGame.difficulty, 'hard');
  assert.equal(humanGame.name, 'Opening roll campaign');
  await human.close();

  // Only the two highest tied players reroll; the nine NPCs participate just like the human.
  const bot = await openSetup('full', { width: 1366, height: 768 });
  await roll(bot, [5, 5, 0, 1, 2, 3, 4, 0, 1, 2], 'setup-roll', (page) =>
    checkRosterLayout(page, 2, true),
  );
  const tiedFaces = await faces(bot);
  assert.deepEqual(tiedFaces, [6, 6, 1, 2, 3, 4, 5, 1, 2, 3]);
  await checkStartGuard(bot);
  await roll(bot, [1, 4], 'setup-reroll', (page) => checkRolling(page, 2));
  assert.deepEqual(await faces(bot), [2, 5, ...tiedFaces.slice(2)]);
  assert.equal(await bot.locator('[data-action="setup-reroll"]').count(), 0);
  await startAndRead(bot, 1);
  await bot.close();

  // Reduced motion reveals the same result immediately, without a forced animation delay.
  const reduced = await openSetup('reduced', { width: 390, height: 844 });
  await roll(reduced, [5, 0, 1, 2, 3, 4, 0, 1, 2, 3], 'setup-roll', async (page) => {
    await checkRosterLayout(page, 1);
    assert.equal(await page.locator('[data-setup-opening-rolling="true"]').count(), 0);
    assert.equal(await page.locator('.setup-opening-die.dice-rolling').count(), 0);
    assert.equal(await page.locator('[data-action="create-game"]').isEnabled(), true);
  });
  await reduced.close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: animated opening dice, concealed results, tied rerolls, reduced motion and saved first turn.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
