import { chromium } from './lib/browser.mjs';
// Local-only rendering checks; no Firebase account or saved campaign is changed.
import assert from 'node:assert/strict';
import { startTestServer } from './lib/static-server.mjs';

import { GameEngine } from '../dist/engine.js';

let browser;
const server = await startTestServer();

/** Assert the map fills its card while retaining the original projection proportions. */
async function checkFullWidthMap(page, selector = '.game-theatre') {
  const dimensions = await page.locator(selector).evaluate((theatre) => {
    const map = theatre.querySelector('.world-map').getBoundingClientRect();
    return { panelWidth: theatre.clientWidth, width: map.width, height: map.height };
  });
  assert.ok(Math.abs(dimensions.width - dimensions.panelWidth) < 1, 'Fill the map panel width');
  assert.ok(Math.abs(dimensions.width / dimensions.height - 2) < 0.01, 'Preserve map proportions');
  assert.equal(
    await page
      .locator(selector)
      .locator('.theatre-head,.theatre-footer,.map-coordinate,.map-compass')
      .count(),
    0,
    'The gameplay panel contains just the map',
  );
}

/** Keep reports directly beneath the proportional map, with just the requested small gap. */
async function checkPinnedMapLayout(page, selector = '.game-theatre') {
  await page.waitForFunction((selector) => {
    const theatre = document.querySelector(selector);
    const map = theatre.getBoundingClientRect();
    const reports = document.querySelector('[data-reports-panel]').getBoundingClientRect();
    return map.top >= 0 && Math.abs(reports.top - map.bottom - 12) < 1;
  }, selector);
  await checkFullWidthMap(page, selector);
}

/** Real page scrolling must move reports with their map rather than leave an overlay behind. */
async function checkReportsMoveWithMap(page) {
  const originalScroll = await page.evaluate(() => scrollY);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const readPositions = () =>
    page.evaluate(() => ({
      map: document.querySelector('.game-theatre').getBoundingClientRect().top,
      reports: document.querySelector('[data-reports-panel]').getBoundingClientRect().top,
      scroll: scrollY,
    }));
  const before = await readPositions();
  // Keep the pointer outside the history feed so the wheel scrolls the page itself.
  await page.mouse.move(8, 8);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction((initial) => scrollY > initial + 1, before.scroll);
  const after = await readPositions();
  const distance = after.scroll - before.scroll;
  assert.ok(distance > 0, 'The browser actually scrolled the page');
  assert.ok(Math.abs(after.map - before.map + distance) < 1, 'The map moves with the page');
  assert.ok(Math.abs(after.reports - before.reports + distance) < 1, 'Reports move with the map');
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), originalScroll);
}

try {
  browser = await chromium.launch({
    headless: true,
  });
  // Fast forward is offered in the bot panel; bot timing is checked below.
  // Force a final conquest to prove already-computed ownership and victory stay hidden while dice roll.
  for (const mode of ['normal', 'reduced']) {
    const game = GameEngine.create('Battle reveal check', 'ZA', true);
    game.round = 1;
    game.position = game.order.indexOf(0);
    game.turnStarted = false;
    game.events = [];
    for (const country of game.countries) country.owner = 0;
    game.countries[0].army = 9;
    game.countries[1].owner = 1;
    game.countries[1].army = 1;
    new GameEngine(game).beginTurn();
    const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ game, mode }) => {
        localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game]));
        localStorage.setItem('meridian-motion-preference', mode === 'reduced' ? 'reduced' : 'full');
      },
      { game, mode },
    );
    await page.route('**/firebase-config.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
    );
    await page.goto('http://localhost:' + server.address().port + '/#game/' + game.id);
    // A lone enemy follows the larger owner group until its capture is visibly revealed.
    assert.equal(
      await page.locator('.country-row').last().getAttribute('data-code'),
      game.countries[1].code,
    );
    await page.locator('#attack-from').selectOption('ZA');
    await page.locator('[data-action="start-attack"]').click();
    await page.evaluate(async () => {
      const { BattleEngine } = await import('./engine.js');
      const original = BattleEngine.resolve;
      BattleEngine.resolve = (a, d) => {
        let n = 0;
        return original(a, d, () => (++n % 2 ? 6 : 1));
      };
    });
    const time = new Date('2026-10-26T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1000));
    await page.locator('[data-action="roll"]').dispatchEvent('click');
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0].winner === 0,
    );
    if (mode === 'normal') {
      await page.evaluate(() => {
        window.rollingDiceNode = document.querySelector('.dice-pairs');
      });
      await page.getByRole('button', { name: 'Pin reports', exact: true }).click();
      await page.getByRole('tab', { name: 'AI commentary', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
      await page.getByRole('tab', { name: 'Field reports', exact: true }).click();
      assert.equal(
        await page.evaluate(() => window.rollingDiceNode === document.querySelector('.dice-pairs')),
        true,
      );
      console.log(
        'PASS: pinning, collapsing and switching report tabs do not replace rolling dice',
      );
    }
    if (mode !== 'reduced') {
      assert.equal(
        await page.locator('.country-row').last().getAttribute('data-code'),
        game.countries[1].code,
        'Roster grouping must not reveal a capture while the dice are rolling.',
      );
      assert.equal(await page.locator('.result-title').count(), 0);
      assert.match(
        await page.locator('.action-panel').innerText(),
        /Results appear when they settle/,
      );
      assert.equal(
        await page.locator('[data-map-country="ZA"].country-row .army-count').innerText(),
        '9',
      );
      assert.doesNotMatch(
        await page.locator('[data-report-panel="field"] .activity-feed').innerText(),
        /loses|conquered|controls all ten/,
      );
      assert.doesNotMatch(
        await page.locator('.dice-pair').first().getAttribute('aria-label'),
        /loses/,
      );
      await page.clock.runFor(1100 - 1);
      assert.equal(await page.locator('.result-title').count(), 0);
      await page.clock.runFor(30);
    }
    assert.match(await page.locator('.result-title').innerText(), /The world is yours/);
    assert.match(
      await page.locator('[data-report-panel="field"] .activity-feed').innerText(),
      /conquered/,
    );
    assert.notEqual(
      await page.locator('[data-map-country="ZA"].country-row .army-count').innerText(),
      '9',
    );
    assert.deepEqual(
      await page.locator('.country-row').evaluateAll((rows) => rows.map((row) => row.dataset.code)),
      game.countries.map((country) => country.code),
      'The captured row rejoins its new owner group after the result appears.',
    );
    // A capture flash must return to the neutral row background after regrouping.
    await page.mouse.move(0, 0);
    await page.clock.runFor(1000);
    assert.equal(
      await page.locator(`.country-row[data-code="${game.countries[1].code}"]`).evaluate((row) => {
        // CSS animations use the document clock, separately from the simulated JS clock.
        row.getAnimations().forEach((animation) => animation.finish());
        return getComputedStyle(row).backgroundColor;
      }),
      'rgba(0, 0, 0, 0)',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        mode +
        ' playback reveals conquest, ownership, counts and victory at the correct time',
    );
    await page.close();
  }
  // Script losses, ties and conquest so every playback speed must reveal the same factual summaries.
  for (const mode of ['normal', 'fast', 'reduced']) {
    const game = GameEngine.create('Bot phase summaries', 'ZA', true);
    game.round = 1;
    game.position = game.order.indexOf(0);
    game.turnStarted = false;
    game.events = [];
    game.countries[1].army = 6;
    game.countries[2].army = 5;
    new GameEngine(game).beginTurn();
    const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ game, mode }) => {
        localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game]));
        localStorage.setItem('meridian-motion-preference', mode === 'reduced' ? 'reduced' : 'full');
      },
      { game, mode },
    );
    await page.route('**/firebase-config.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
    );
    await page.goto('http://localhost:' + server.address().port + '/#game/' + game.id);
    await page.locator('.game-heading').waitFor();
    await page.evaluate(async () => {
      const { GameEngine, BattleEngine } = await import('./engine.js'),
        original = BattleEngine.resolve;
      GameEngine.prototype.npcPlan = function () {
        return {
          from: this.game.countries[1],
          to: this.game.countries[2],
          reason: 'Bot battle display fixture.',
        };
      };
      GameEngine.prototype.npcBattleDecision = () => ({
        continue: true,
        reason: 'Continue the recorded attack.',
      });
      window.botRollTimes = [];
      const rolls = [
        [1, 6, 6, 1, 6, 1, 3, 3, 3, 3],
        [1, 6, 1, 6, 6, 1],
        [3, 3, 3, 3],
        [6, 1, 6, 1],
      ];
      BattleEngine.resolve = (a, d) => {
        const values = [...(rolls[window.botRollTimes.length] || [3, 3])];
        window.botRollTimes.push(performance.now());
        return original(a, d, () => values.shift() || 3);
      };
    });
    const time = new Date('2026-10-26T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1000));
    await page.locator('[data-action="end-turn"]').first().dispatchEvent('click');
    if (mode === 'fast') await page.locator('.action-panel [data-action="fast"]').click();
    // The first bot pause starts before its speed control becomes available.
    assert.match(await page.locator('.action-panel').innerText(), /Bot battle display fixture/);
    await page.clock.runFor(4999);
    assert.equal(await page.evaluate(() => window.botRollTimes.length), 0);
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0].battle,
      ),
      null,
    );
    await page.clock.runFor(1);
    await page.clock.runFor(mode === 'fast' ? 833 : 2500);
    const decisionDelay = mode === 'fast' ? 1667 : 5000;
    /** Prove a reading pause leaves armies untouched until its final millisecond. */
    async function finishDecision(expectedRolls) {
      assert.match(await page.locator('.action-panel').innerText(), /Continue the recorded attack/);
      const armies = await page.locator('.country-roster').innerText();
      await page.clock.runFor(decisionDelay - 1);
      assert.equal(await page.evaluate(() => window.botRollTimes.length), expectedRolls);
      assert.equal(await page.locator('.country-roster').innerText(), armies);
      await page.clock.runFor(1);
      assert.equal(await page.evaluate(() => window.botRollTimes.length), expectedRolls + 1);
    }
    await finishDecision(0);
    for (const [index, losses] of [
      [1, [1, 2]],
      [2, [2, 1]],
      [3, [0, 0]],
      [4, [0, 2]],
    ]) {
      const duration = mode === 'reduced' ? 0 : mode === 'fast' ? 550 : 1100;
      if (duration) {
        assert.match(
          await page.locator('.action-panel').innerText(),
          /Results appear when they settle/,
        );
        assert.doesNotMatch(await page.locator('.action-panel').innerText(), /Phase \d+:/);
        await page.clock.runFor(duration - 10);
        assert.doesNotMatch(await page.locator('.action-panel').innerText(), /Phase \d+:/);
        await page.clock.runFor(20);
      }
      const expected = /* prettier-ignore */ `Phase ${index}: ${game.countries[1].name} lost ${losses[0]}; ${
        game.countries[2].name
      } lost ${losses[1]}.`;
      assert.ok(
        (await page.locator('.action-panel').innerText()).includes(expected),
        'Missing settled bot result: ' + expected,
      );
      if (index === 3) assert.match(await page.locator('.action-panel').innerText(), /A stand-off/);
      if (index === 4)
        assert.match(await page.locator('.recent-conquest').innerText(), /conquered/);
      if (index < 4) {
        const remaining = await page.evaluate(
          (pause) => Math.max(0, Math.ceil(window.botRollTimes.at(-1) + pause - performance.now())),
          mode === 'fast' ? 1000 : 3000,
        );
        await page.clock.runFor(remaining);
        await finishDecision(index);
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        mode +
        ' bots pause before each decision and reveal phase losses only after dice settle',
    );
    if (mode === 'normal') {
      const saved = await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2'));
      await page.evaluate(() => {
        location.hash = 'campaigns';
      });
      await page
        .locator('.dashboard-page, .campaign-grid, [data-action="new-campaign"]')
        .first()
        .waitFor();
      await page.clock.runFor(10000);
      assert.equal(
        await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
        saved,
      );
    }
    await page.close();
  }
  // Exercise the restored transfer entry through real controls, including after a failed attack.
  // Engine-built outcomes catch broken routing that a markup-only test cannot detect.
  for (const outcome of ['planning', 'held']) {
    const game = GameEngine.create('Transfer entry check', 'ZA', true);
    const source = game.countries.find((country) => country.owner === 0 && country.code !== 'ZA');
    const destination = game.countries.find((country) => country.code === 'ZA');
    const enemy = game.countries.find((country) => country.owner !== 0);
    game.round = 1;
    game.budget = 0;
    source.army = 5;
    destination.army = 2;
    if (outcome === 'held') {
      const engine = new GameEngine(game);
      engine.startAttack(destination.code, enemy.code);
      let rollIndex = 0;
      engine.roll(() => (++rollIndex % 2 ? 1 : 6));
      assert.equal(game.lastBattle.outcome, 'held');
    }
    const transferPage = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1536, height: 728 },
    });
    const errors = [];
    transferPage.on('pageerror', (error) => errors.push(error.message));
    await transferPage.addInitScript((game) => {
      localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game]));
      localStorage.setItem('meridian-motion-preference', 'reduced');
    }, game);
    await transferPage.route('**/firebase-config.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
    );
    await transferPage.goto('http://localhost:' + server.address().port + '/#game/' + game.id);
    const transferEntry = transferPage.locator('.action-panel [data-action="transfer"]');
    await transferEntry.click();
    await transferPage.locator('#transfer-from').selectOption(source.code);
    await transferPage.locator('#transfer-to').selectOption(destination.code);
    await transferPage.locator('#transfer-count').fill('2');
    await transferPage.locator('[data-action="confirm-transfer"]').click();
    const saved = await transferPage.evaluate(
      () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0],
    );
    assert.equal(saved.countries.find((country) => country.code === source.code).army, 3);
    assert.equal(
      saved.countries.find((country) => country.code === destination.code).army,
      destination.army + 2,
    );
    assert.equal(saved.attackUsed, game.attackUsed, 'Transferring cannot grant an extra attack.');
    assert.equal(saved.events.at(-1).type, 'transfer');
    assert.equal(
      await transferEntry.count(),
      1,
      'The right panel retains a single transfer entry.',
    );
    assert.deepEqual(errors, []);
    await transferPage.close();
  }
  console.log('PASS: planning and failed battles both open and complete a soldier transfer');

  // Report controls are presentation state: switching tabs must neither rewrite facts nor lose focus.
  const tabsGame = GameEngine.create('Report tabs check', 'ZA', true);
  const savedCommentary = 'Kestrel takes the lead in the recorded match.';
  tabsGame.events.at(-1).commentary = savedCommentary;
  for (let i = 0; i < 20; i++) new GameEngine(tabsGame).event('decision', 'Recorded decision ' + i);
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const tabErrors = [];
  page.on('pageerror', (error) => tabErrors.push(error.message));
  await page.addInitScript(
    (game) => localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game])),
    tabsGame,
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.goto('http://localhost:' + server.address().port + '/#game/' + tabsGame.id);
  const fieldTab = page.getByRole('tab', { name: 'Field reports', exact: true });
  const aiTab = page.getByRole('tab', { name: 'AI commentary', exact: true });
  const fieldPanel = page.locator('[data-report-panel="field"]');
  const aiPanel = page.locator('[data-report-panel="ai"]');
  await fieldTab.waitFor();
  assert.equal(await page.locator('.board-actions').count(), 0, 'Remove the unused toolbar row');
  const savedBeforeTabs = await page.evaluate(() =>
    localStorage.getItem('meridian-conquest-ui-v2'),
  );
  assert.equal(await fieldPanel.isVisible(), true);
  assert.equal(await aiPanel.isVisible(), false);
  assert.equal(await fieldPanel.locator('.ai-commentary').count(), 0);
  await aiTab.click();
  assert.equal(await fieldPanel.isVisible(), false);
  assert.match(await aiPanel.innerText(), /Kestrel takes the lead/);
  assert.doesNotMatch(await aiPanel.innerText(), /Recorded decision/);
  await aiTab.press('ArrowLeft');
  assert.equal(await fieldTab.getAttribute('aria-selected'), 'true');
  await fieldTab.press('End');
  assert.equal(await aiTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.reportTab), 'ai');
  await aiTab.press('Home');
  await fieldTab.press('ArrowRight');
  assert.equal(await aiTab.getAttribute('aria-selected'), 'true');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
    savedBeforeTabs,
  );
  await page.locator('.country-roster [data-action="select-country"]').first().click();
  assert.equal(await aiTab.getAttribute('aria-selected'), 'true');
  assert.equal(await aiPanel.isVisible(), true);
  // Treat generated narration as untrusted text and update it without replacing active game controls.
  const incoming = 'Brazil keeps up the pressure. <img src=x onerror=alert(1)>';
  const patchedInPlace = await page.evaluate(async (text) => {
    const { updateReportsCommentary } = await import('./ui/reports.js?v=compact-panels-20261105-1');
    const game = JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0];
    game.events.at(-1).commentary = text;
    const field = document.querySelector('[data-report-panel="field"]');
    const input = document.querySelector('#attack-to');
    updateReportsCommentary(document, game);
    return (
      field === document.querySelector('[data-report-panel="field"]') &&
      input === document.querySelector('#attack-to')
    );
  }, incoming);
  assert.equal(patchedInPlace, true);
  assert.ok((await aiPanel.innerText()).includes(incoming));
  assert.equal(await aiPanel.locator('img').count(), 0);
  assert.equal(await aiTab.getAttribute('aria-selected'), 'true');
  await page
    .locator('[data-reports-panel]')
    .screenshot({ path: '.firebase/reports-tabs-desktop.png' });
  // Measure real browser geometry to catch dock overlays that string-based rendering tests cannot see.
  const reports = page.locator('[data-reports-panel]');
  const content = reports.locator('[data-report-content]');
  const worldMap = page.locator('.game-theatre .world-map');
  const originalMapHeight = (await worldMap.boundingBox()).height;
  await page.getByRole('button', { name: 'Pin reports', exact: true }).click();
  assert.equal((await worldMap.boundingBox()).height, originalMapHeight);
  await checkPinnedMapLayout(page);
  const dockLayout = await reports.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const controls = document.querySelector('.action-panel').getBoundingClientRect();
    return {
      inFlow: getComputedStyle(panel).position === 'static',
      controlsClear: rect.right <= controls.left,
      belowMap: rect.top >= document.querySelector('.game-theatre').getBoundingClientRect().bottom,
      noDockPadding: parseFloat(getComputedStyle(document.body).paddingBottom) === 0,
    };
  });
  assert.deepEqual(dockLayout, {
    inFlow: true,
    controlsClear: true,
    belowMap: true,
    noDockPadding: true,
  });
  const expandedHeight = (await reports.boundingBox()).height;
  await checkReportsMoveWithMap(page);
  await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
  assert.equal(await content.isVisible(), false);
  assert.equal((await worldMap.boundingBox()).height, originalMapHeight);
  assert.ok((await reports.boundingBox()).height < expandedHeight);
  await page.locator('.country-roster [data-action="select-country"]').first().click();
  assert.equal(await reports.getAttribute('data-reports-collapsed'), 'true');
  assert.equal(await content.isVisible(), false);
  assert.equal(await reports.evaluate((panel) => getComputedStyle(panel).position), 'static');
  await page.evaluate(async () => {
    const { updateReportsCommentary } = await import('./ui/reports.js?v=compact-panels-20261105-1');
    const game = JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0];
    game.events.at(-1).commentary = 'Brazil keeps up the pressure on the defending commander.';
    updateReportsCommentary(document, game);
  });
  assert.equal(
    await content.isVisible(),
    false,
    'Incoming AI reports must not reopen a collapsed panel',
  );
  await aiTab.click();
  assert.equal(await content.isVisible(), true);
  assert.equal(await reports.getAttribute('data-reports-collapsed'), 'false');
  assert.match(await aiPanel.innerText(), /Brazil keeps up the pressure/);
  assert.equal(
    await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
    savedBeforeTabs,
  );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.firebase/reports-pin-desktop.png' });
  console.log(
    'PASS: pinned reports stay attached below the map in normal page flow' +
      ' and retain collapse state across updates',
  );

  await page.setViewportSize({ width: 1536, height: 728 });
  await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
  const fullMapHeight = (await worldMap.boundingBox()).height;
  await page.getByRole('button', { name: 'Expand reports', exact: true }).click();
  const expandedMap = await worldMap.boundingBox();
  assert.ok(expandedMap.height < fullMapHeight);
  await checkPinnedMapLayout(page);
  // Test the short desktop window from the reported issue, where space is most restricted.
  await checkReportsMoveWithMap(page);
  await page.locator('.country-roster [data-action="select-country"]').first().click();
  await fieldTab.click();
  await aiTab.click();
  await checkPinnedMapLayout(page);
  assert.ok(
    await worldMap
      .locator('.map-marker text')
      .evaluateAll((labels) =>
        labels.every(
          (label) =>
            (parseFloat(getComputedStyle(label).fontSize) *
              label.ownerSVGElement.getBoundingClientRect().width) /
              960 >=
            7.9,
        ),
      ),
  );
  await worldMap.locator('.map-marker[data-code="ZA"] text').click();
  assert.match(await page.locator('.selected-country h3').innerText(), /South Africa/);
  await page.locator('.game-theatre').evaluate((theatre) =>
    window.scrollBy({
      top: theatre.getBoundingClientRect().top - 16,
      behavior: 'instant',
    }),
  );
  const scrollBeforeReport = await page.evaluate(() => scrollY);
  await page.evaluate(async () => {
    const { updateReportsCommentary } = await import('./ui/reports.js?v=compact-panels-20261105-1');
    const game = JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0];
    updateReportsCommentary(document, game);
  });
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeReport);
  await page.screenshot({ path: '.firebase/reports-full-map-desktop.png' });
  await page.setViewportSize({ width: 1536, height: 640 });
  await checkPinnedMapLayout(page);
  assert.ok((await worldMap.boundingBox()).height < expandedMap.height);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.firebase/reports-compact-panels-640.png' });
  console.log(
    'PASS: pinned reports leave the entire map and actions visible on short' +
      ' desktop windows, without empty strips inside the map card or scrolling for' +
      ' incoming commentary',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-reports-panel]').getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth;
  });
  assert.equal(await aiTab.isVisible(), true);
  assert.equal(await fieldTab.isVisible(), true);
  assert.equal(
    await page
      .locator('[data-reports-panel]')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await checkReportsMoveWithMap(page);
  await page
    .locator('.action-panel .btn-full')
    .last()
    .evaluate((button) => button.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const mobileControls = await page.locator('.action-panel .btn-full').last().boundingBox();
  const mobileReports = await reports.boundingBox();
  assert.ok(mobileControls.y >= 0);
  assert.ok(mobileControls.y + mobileControls.height <= 844);
  assert.ok(mobileControls.y + mobileControls.height <= mobileReports.y);
  await page.screenshot({ path: '.firebase/reports-pin-mobile.png' });
  await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
  assert.equal(await content.isVisible(), false);
  await page.getByRole('button', { name: 'Expand reports', exact: true }).click();
  assert.equal(await content.isVisible(), true);
  const mobileMap = await worldMap.boundingBox();
  const mobileRoster = await page.locator('.roster-panel').boundingBox();
  assert.ok(mobileMap.y >= mobileRoster.y + mobileRoster.height);
  await checkPinnedMapLayout(page);
  await page.screenshot({ path: '.firebase/reports-full-map-mobile.png' });
  await page.getByRole('button', { name: 'Unpin', exact: true }).click();
  assert.equal(await page.locator('.reports-map-expanded').count(), 0);
  assert.equal(await reports.evaluate((panel) => getComputedStyle(panel).position), 'static');
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('reports-docked')),
    false,
  );
  assert.equal(await content.isVisible(), true);
  console.log(
    'PASS: report tabs separate facts and AI, support keyboard navigation and' +
      ' retain selection across updates on desktop and mobile',
  );

  await page.evaluate(async () => {
    const [
      { createMultiplayerUI },
      { newRoom, joinRoom, startRoom },
      { GameEngine },
      { syncReportsDock },
      { createMapView },
      { createBattleViews },
    ] = await Promise.all([
      import('./multiplayer.js'),
      import('./rooms.js'),
      import('./engine.js'),
      import('./ui/reports.js?v=compact-panels-20261105-1'),
      import('./ui/map.js'),
      import('./ui/battle.js'),
    ]);
    const host = { uid: 'host', displayName: 'Host' };
    const friend = { uid: 'friend', displayName: 'Friend' };
    // These recorded rooms predate opening rolls; the new interface must still render them.
    window.createLegacyFixtureRoom = (code) => {
      const {
        setupVersion: _version,
        countryChoices: _choices,
        initiative: _initiative,
        ...lobby
      } = joinRoom(newRoom(code, host), friend);
      return startRoom(lobby, host.uid).room;
    };
    window.fixtureBoardOptions = (getUI, getState) => {
      const nameOf = (player) => getUI().game.playerNames[player];
      const { gameView, die } = createBattleViews({
        get multiplayer() {
          return getUI();
        },
        get state() {
          return getState();
        },
        motionFrame: null,
        owned: (game, seat = getUI().playerSeat) =>
          game.countries.filter((country) => country.owner === seat),
        nav: () => '',
        nameOf,
        theatre: createMapView({ nameOf }).theatre,
        campaignPopulationLabel: () => '',
      });
      return {
        getState,
        dieView: die,
        renderGame: (game, header) => gameView(game, { roomHeader: header }),
      };
    };
    const room = window.createLegacyFixtureRoom('ABC234');
    const game = JSON.parse(room.payload);
    game.position = game.order.indexOf(0);
    new GameEngine(game).event('decision', 'A shared factual decision.');
    room.payload = JSON.stringify(game);
    room.currentSeat = 0;
    room.controllerUid = host.uid;
    let sendReport;
    const cloud = {
      user: friend,
      ready: true,
      rooms: {
        join: async () => {},
        watch: (_, onRoom, _onError, onReport) => {
          sendReport = onReport;
          onRoom(room);
          return () => {};
        },
      },
    };
    const state = {
      allocations: {},
      reportTab: 'ai',
      reportDock: { pinned: true, collapsed: false },
    };
    const multiplayer = createMultiplayerUI({
      getCloud: () => cloud,
      ...window.fixtureBoardOptions(
        () => multiplayer,
        () => state,
      ),
      changed: () => {
        document.getElementById('app').innerHTML = multiplayer.render();
        syncReportsDock(document);
      },
    });
    multiplayer.route('ABC234');
    await multiplayer.sessionChanged();
    sendReport(game.events.at(-1).id, {
      status: 'ready',
      text: 'Atlas challenges Kestrel across the board.',
      narrationVersion: 2,
    });
    window.closeReportsRoom = () => {
      multiplayer.route(null);
      document.getElementById('app').innerHTML = '';
      syncReportsDock(document);
    };
  });
  assert.equal(await aiTab.getAttribute('aria-selected'), 'true');
  assert.match(await aiPanel.innerText(), /Atlas challenges Kestrel/);
  assert.equal(await reports.evaluate((panel) => getComputedStyle(panel).position), 'static');
  assert.equal(await fieldPanel.locator('.ai-commentary').count(), 0);
  assert.equal(await page.locator('[data-room-action="commentary"]').count(), 0);
  await page.evaluate(async () => {
    const { setReportsDock } = await import('./ui/reports.js?v=compact-panels-20261105-1');
    const panel = document.querySelector('[data-reports-panel]');
    setReportsDock(panel, { pinned: true, collapsed: true });
    setReportsDock(panel, { pinned: true, collapsed: false });
  });
  await checkPinnedMapLayout(page, '.board-grid .theatre');
  assert.equal(await page.locator('.reports-map-expanded').count(), 1);
  // The shared renderer must keep its compact controls and map gap at both desktop heights.
  for (const height of [728, 640]) {
    await page.setViewportSize({ width: 1536, height });
    // Resizing from the stacked mobile layout retains its old page scroll offset.
    await page
      .locator('.board-grid .theatre')
      .evaluate((theatre) =>
        window.scrollBy({ top: theatre.getBoundingClientRect().top - 16, behavior: 'instant' }),
      );
    await checkPinnedMapLayout(page, '.board-grid .theatre');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: `.firebase/multiplayer-compact-panels-${height}.png` });
  }
  await fieldTab.click();
  assert.match(await fieldPanel.innerText(), /A shared factual decision/);
  await page.evaluate(() => window.closeReportsRoom());
  assert.equal(await page.locator('.reports-map-expanded').count(), 0);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('reports-docked')),
    false,
  );
  assert.deepEqual(tabErrors, []);
  console.log(
    'PASS: multiplayer friends receive commentary in its own tab without host generation controls',
  );

  // Share one in-memory room between two clients to test host-only bot execution and reconnect timing.
  const clockTime = new Date('2026-10-31T12:00:00Z');
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(new Date(clockTime.getTime() + 1000));
  await page.evaluate(async () => {
    const { createMultiplayerUI } = await import('./multiplayer.js');
    const { moveRoom } = await import('./rooms.js');
    const host = { uid: 'host', displayName: 'Host' };
    const friend = { uid: 'friend', displayName: 'Friend' };
    let room = window.createLegacyFixtureRoom('BCD345');
    const game = JSON.parse(room.payload);
    game.position = game.order.indexOf(2);
    game.round = 2;
    game.budget = 4;
    game.countries[2].army = 20;
    room = { ...room, currentSeat: 2, controllerUid: host.uid, payload: JSON.stringify(game) };
    const watchers = new Map();
    const failures = [];
    document.getElementById('app').innerHTML =
      '<div id="host-room"></div><div id="friend-room"></div>';
    const createClient = (user) => {
      const cloud = {
        user,
        ready: true,
        rooms: {
          join: async () => {},
          watch: (_, onRoom) => {
            watchers.set(user.uid, onRoom);
            onRoom(structuredClone(room));
            return () => watchers.delete(user.uid);
          },
          move: async (_, revision, action, values) => {
            room = moveRoom(room, user.uid, revision, action, values).room;
            for (const onRoom of watchers.values()) onRoom(structuredClone(room));
          },
        },
      };
      const state = { allocations: {}, reportDock: {}, reportTab: 'field' };
      const ui = createMultiplayerUI({
        getCloud: () => cloud,
        ...window.fixtureBoardOptions(
          () => ui,
          () => state,
        ),
        notify: (message) => failures.push(message),
        changed: () => {
          document.getElementById(user.uid + '-room').innerHTML = ui.render();
        },
      });
      ui.route(room.code);
      return ui;
    };
    const hostUI = createClient(host),
      friendUI = createClient(friend);
    await Promise.all([hostUI.sessionChanged(), friendUI.sessionChanged()]);
    window.botPacing = { hostUI, friendUI, room: () => room, failures };
  });
  const roomState = () => page.evaluate(() => JSON.parse(window.botPacing.room().payload));
  const initialRoom = await roomState();
  await page.clock.runFor(2400);
  const announcedRoom = await roomState();
  assert.equal(announcedRoom.events.at(-1).intent.action, 'reinforce');
  assert.deepEqual(announcedRoom.countries, initialRoom.countries);
  assert.equal(
    await page.locator('#host-room [data-npc-decision]').innerText(),
    await page.locator('#friend-room [data-npc-decision]').innerText(),
  );
  await page.clock.runFor(4999);
  assert.deepEqual(await roomState(), announcedRoom);
  await page.clock.runFor(1);
  assert.equal((await roomState()).budget, 0);
  assert.equal((await roomState()).countries[2].army, 24);
  await page.clock.runFor(2400);
  const announcedAttack = await roomState();
  assert.equal(announcedAttack.events.at(-1).intent.action, 'attack');
  assert.equal(announcedAttack.battle, null);
  await page.evaluate(() => window.botPacing.hostUI.route(null));
  await page.clock.runFor(6000);
  assert.deepEqual(await roomState(), announcedAttack, 'Friends must not advance bot turns');
  await page.evaluate(async () => {
    window.botPacing.hostUI.route('BCD345');
    await window.botPacing.hostUI.sessionChanged();
  });
  await page.clock.runFor(4999);
  assert.deepEqual(await roomState(), announcedAttack);
  await page.clock.runFor(1);
  assert.equal((await roomState()).battle.phase, 0);
  await page.clock.runFor(2400);
  const announcedRoll = await roomState();
  assert.equal(announcedRoll.events.at(-1).intent.action, 'roll');
  await page.clock.runFor(4999);
  assert.deepEqual(await roomState(), announcedRoll);
  await page.clock.runFor(1);
  assert.ok((await roomState()).events.some((event) => event.type === 'dice'));
  assert.deepEqual(await page.evaluate(() => window.botPacing.failures), []);
  await page.evaluate(() => {
    window.botPacing.hostUI.route(null);
    window.botPacing.friendUI.route(null);
  });
  assert.deepEqual(tabErrors, []);
  console.log(
    'PASS: multiplayer host and friend see decisions for five seconds before' +
      ' actions, including after reconnecting',
  );
  await page.close();
} finally {
  // Release Chromium and the ephemeral HTTP port even if an animation or geometry assertion fails.
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
