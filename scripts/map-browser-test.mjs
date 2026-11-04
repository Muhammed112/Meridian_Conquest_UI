import { chromium } from './lib/browser.mjs';
// Check the committed map geometry in Chrome using local game data only.
import assert from 'node:assert/strict';
import { startTestServer } from './lib/static-server.mjs';

import os from 'node:os';
import path from 'node:path';
import { GameEngine } from '../dist/engine.js';
import { catalogue, armyValue } from '../dist/data.js';

let browser;
const server = await startTestServer();

/** Open an isolated local board with Firebase disabled and a known viewport. */
async function openGame(game) {
  const page = await browser.newPage({
    viewport: { width: 1536, height: 728 },
    ignoreHTTPSErrors: true,
  });
  await page.addInitScript(
    (game) => localStorage.setItem('meridian-conquest-ui-v2', JSON.stringify([game])),
    game,
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.goto('http://localhost:' + server.address().port + '/#game/' + game.id);
  await page.locator('.world-map .land').first().waitFor();
  return page;
}

/** Measure real SVG labels after font loading and assert they avoid each other and markers. */
async function checkLabels(page) {
  await page.waitForFunction(() => {
    const svg = document.querySelector('.world-map');
    const map = svg.getBoundingClientRect();
    const labels = [...svg.querySelectorAll('.map-marker text')].map((text) =>
      text.getBoundingClientRect(),
    );
    const dots = [...svg.querySelectorAll('.map-marker circle:not(.selection-ring)')].map((dot) =>
      dot.getBoundingClientRect(),
    );
    const overlaps = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return labels.every(
      (label, index) =>
        label.left >= map.left &&
        label.right <= map.right &&
        label.top >= map.top &&
        label.bottom <= map.bottom &&
        !labels.slice(index + 1).some((other) => overlaps(label, other)) &&
        !dots.some((dot) => overlaps(label, dot)),
    );
  });
  const svg = page.locator('.world-map');
  assert.equal(
    await svg.locator('.map-label-leader:not([hidden])').evaluateAll((lines) =>
      lines.every((line) => {
        const style = getComputedStyle(line);
        return (
          style.display !== 'none' &&
          parseFloat(style.strokeWidth) >= 2 &&
          style.strokeDasharray === 'none' &&
          style.opacity === '1'
        );
      }),
    ),
    true,
    'Moved labels use clearly visible solid connector lines at both map sizes',
  );
  const box = await svg.boundingBox();
  assert.ok(Math.abs(box.width / box.height - 2) < 0.01, 'Keep the original map proportions');
  assert.ok(
    Math.abs(box.width - (await svg.evaluate((node) => node.closest('.theatre').clientWidth))) < 1,
    'The map fills the panel width, including while reports are pinned',
  );
}

try {
  browser = await chromium.launch({
    headless: true,
  });
  const game = GameEngine.create('Map geometry check', 'CA', true);
  const page = await openGame(game);
  for (const label of ['initial', 'reload']) {
    if (label === 'reload') await page.reload();
    await page.locator('.world-map .land').first().waitFor();
    await checkLabels(page);
    // Long internal SVG segments expose antimeridian seams that can look like borders across the map.
    const crossingCount = await page.locator('.world-map').evaluate((svg) => {
      let count = 0;
      for (const node of svg.querySelectorAll('.land')) {
        let last = null;
        for (const m of node
          .getAttribute('d')
          .matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
          const p = [Number(m[2]), Number(m[3])];
          if (
            m[1] === 'L' &&
            last &&
            Math.abs(last[0] - p[0]) > 480 &&
            last[1] > 1 &&
            last[1] < 479 &&
            p[1] > 1 &&
            p[1] < 479
          )
            count++;
          last = p;
        }
      }
      return count;
    });
    assert.equal(crossingCount, 0, 'The map must have no lines joining opposite edges');
    assert.equal(await page.locator('.world-map .map-marker').count(), 10);
    assert.equal(
      await page.locator('.play-dock,.play-dialog').count(),
      0,
      'Keep the restored gameplay layout',
    );
    await page
      .locator('.map-viewport')
      .screenshot({ path: path.join(os.tmpdir(), 'meridian-map-' + label + '.png') });
    console.log(
      label + ': ' + crossingCount + ' incorrect cross-map segments; 10 country markers retained',
    );
  }
  // The welcome animation must be disposable presentation and never alter a user's saved campaign.
  const savedBeforeDemo = await page.evaluate(() =>
    localStorage.getItem('meridian-conquest-ui-v2'),
  );
  const demoTime = new Date('2026-10-31T10:00:00Z');
  await page.clock.install({ time: demoTime });
  await page.clock.pauseAt(new Date(demoTime.getTime() + 1000));
  await page.goto('http://localhost:' + server.address().port + '/#welcome');
  const preview = page.locator('.hero .theatre');
  await preview.waitFor();
  // The briefing keeps one heading and staggers its phrases without changing their final layout.
  const briefing = page.locator('.hero-copy');
  assert.deepEqual(await briefing.locator('h1 .briefing-line').allTextContents(), [
    'Choose your nation.',
    'Build your army.',
    'Conquer the world.',
  ]);
  const delays = await briefing.locator('.briefing-line').evaluateAll((lines) =>
    lines.map(
      (line) =>
        line
          .getAnimations()
          .find((animation) => animation.animationName === 'briefing-copy')
          .effect.getTiming().delay,
    ),
  );
  assert.ok(Math.abs(delays[1] - delays[0] - 150) < 1);
  assert.ok(Math.abs(delays[2] - delays[1] - 150) < 1);
  // CSS animations use the document timeline, so wait for their finite finish rather than JS timers.
  await briefing.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  assert.equal(
    await briefing
      .locator('.briefing-line,.hero-actions')
      .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === '1')),
    true,
  );
  await page.screenshot({ path: '.firebase/welcome-briefing-desktop.png', fullPage: true });
  assert.equal(await page.locator('.navbar .nav-links,.navbar .nav-demo').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible(), true);
  assert.match(await preview.locator('.theatre-head').innerText(), /Gameplay preview/i);
  await page.clock.runFor(1000);
  assert.equal(await preview.locator('.troop-movement.attack').count(), 1);
  // The distant US-to-Brazil route must show aircraft while retaining the recorded force label.
  const airAttack = preview.locator('.troop-movement.attack[data-unit-type="plane"]');
  assert.equal(await airAttack.count(), 1);
  assert.equal(await airAttack.locator('.troop-packet .unit-plane').count(), 1);
  assert.equal(await airAttack.locator('.unit-head').count(), 0);
  assert.equal(
    await airAttack.locator('.troop-count').textContent(),
    await airAttack.getAttribute('data-troop-count'),
  );
  assert.equal(await preview.locator('.missile-flight').count(), 1);
  const flight = preview.locator('.troop-packet');
  const startingPosition = await flight.getAttribute('transform');
  await page.clock.runFor(600);
  assert.notEqual(await flight.getAttribute('transform'), startingPosition);
  assert.match(await flight.getAttribute('transform'), /rotate\(0\)/, 'The count remains upright.');
  await preview.screenshot({ path: '.firebase/welcome-gameplay-preview-desktop.png' });
  await page.clock.runFor(2000);
  for (let phase = 0; phase < 4 && !(await preview.locator('.land.captured').count()); phase++)
    await page.clock.runFor(1100);
  assert.equal(await preview.locator('.land.captured').count(), 1);
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      'The headline must wrap naturally on narrower screens.',
    );
  }
  await preview.screenshot({ path: '.firebase/welcome-gameplay-preview-mobile.png' });
  assert.equal(
    await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
    savedBeforeDemo,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reduce animations', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  // A fresh reduced-motion visit must show every phrase immediately, including delayed content.
  await page.reload();
  await briefing.waitFor();
  assert.equal(
    await briefing.locator('.briefing-line,.hero-actions').evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node);
        return style.animationName === 'none' && style.opacity === '1';
      }),
    ),
    true,
  );
  assert.equal(await preview.locator('.map-effects').count(), 0);
  const staticPreview = await preview.innerHTML();
  await page.clock.runFor(10000);
  assert.equal(await preview.innerHTML(), staticPreview);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Enable full animations', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.equal(
    await briefing.evaluate((node) => node.classList.contains('briefing-reveal')),
    false,
  );
  await page.clock.runFor(1000);
  assert.equal(await preview.locator('.troop-movement.attack').count(), 1);
  await page.setViewportSize({ width: 1536, height: 728 });
  await page.getByRole('link', { name: /Enter the war room/ }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  for (const name of ['My campaigns', 'New campaign', 'Multiplayer', 'How to play'])
    assert.equal(
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name, exact: true })
        .isVisible(),
      true,
    );
  await page.goto('http://localhost:' + server.address().port + '/#game/' + game.id);
  await page.clock.runFor(10000);
  assert.equal(await page.locator('.hero,.troop-movement,.missile-flight').count(), 0);
  assert.equal(
    await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
    savedBeforeDemo,
  );
  console.log(
    'PASS: welcome preview reuses moving troops, missiles and capture effects,' +
      ' obeys animation settings, stops on navigation and never changes saved' +
      ' campaigns',
  );
  await page.close();
  // Dense island/microstate fixtures exercise general collision avoidance beyond one reported overlap.
  for (const [region, codes] of [
    ['caribbean', ['DO', 'GD', 'TT', 'BB', 'LC', 'VC', 'DM', 'KN', 'AG', 'PR']],
    ['europe', ['VA', 'MC', 'SM', 'LI', 'AD', 'LU', 'BE', 'NL', 'CH', 'AT']],
    ['monaco-italy', ['BL', 'MF', 'SR', 'MC', 'IT', 'AZ', 'BN', 'PW', 'PG', 'ZA']],
  ]) {
    const game = GameEngine.create('Crowded map labels', codes[0], true);
    game.countries = codes.map((code, owner) => {
      const country = catalogue.find((country) => country.code === code);
      assert.ok(country, 'Fixture country exists: ' + code);
      return { ...country, owner, value: armyValue(country.population), army: owner + 2 };
    });
    game.position = game.order.indexOf(0);
    game.turnStarted = false;
    new GameEngine(game).beginTurn();
    const page = await openGame(game);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-action="auto-allocate"]').click();
    await page.locator('[data-action="confirm-reinforce"]').click();
    await page.setViewportSize({ width: 900, height: 1400 });
    for (const viewport of [
      { width: 1536, height: 728 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
      { width: 900, height: 1400 },
    ]) {
      await page.setViewportSize(viewport);
      await checkLabels(page);
    }
    assert.ok((await page.locator('.map-label-leader:not([hidden])').count()) > 0);
    for (const code of codes.filter((code) => ['MC', 'IT'].includes(code))) {
      await page.locator(`.map-marker[data-code="${code}"] text`).click();
      assert.equal(await page.locator('#attack-to').inputValue(), code);
      await checkLabels(page);
    }
    await page
      .locator('.map-viewport')
      .screenshot({ path: `.firebase/map-labels-full-${region}.png` });
    const coordinates = () =>
      page
        .locator('.map-marker circle:not(.selection-ring)')
        .evaluateAll((dots) => dots.map((dot) => [dot.getAttribute('cx'), dot.getAttribute('cy')]));
    // Responsive labels may move; geographical marker anchors and the stored board must remain fixed.
    const originalPoints = await coordinates();
    const savedGame = await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2'));
    const originalWidth = (await page.locator('.world-map').boundingBox()).width;
    await page.getByRole('button', { name: 'Pin reports', exact: true }).click();
    assert.equal((await page.locator('.world-map').boundingBox()).width, originalWidth);
    await checkLabels(page);
    await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
    await checkLabels(page);
    await page.getByRole('button', { name: 'Expand reports', exact: true }).click();
    await checkLabels(page);
    for (const viewport of [
      { width: 1536, height: 728 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await checkLabels(page);
      assert.deepEqual(
        await coordinates(),
        originalPoints,
        'Labels must not move the country markers',
      );
      await page
        .locator('.map-viewport')
        .screenshot({ path: `.firebase/map-labels-${region}-${viewport.width}.png` });
    }
    const target = codes[2];
    await page.locator(`.map-marker[data-code="${target}"] text`).click();
    assert.equal(
      await page.locator('#attack-to').inputValue(),
      target,
      'Clicking a moved label selects the attack target',
    );
    await checkLabels(page);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2')),
      savedGame,
    );
    await page.getByRole('button', { name: 'Unpin', exact: true }).click();
    await checkLabels(page);
    assert.deepEqual(await coordinates(), originalPoints);
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ` +
        `${region}` +
        ` labels separate with solid connectors at normal and compact sizes across` +
        ` desktop, tablet and mobile; markers stay fixed and labels select targets`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
