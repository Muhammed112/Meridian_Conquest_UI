import { chromium } from './lib/browser.mjs';
// Check the committed map geometry in Chrome using local game data only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { GameEngine } from '../dist/engine.js';
import { catalogue, armyValue } from '../dist/data.js';

const root = path.resolve('dist');
let browser;
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(
      root,
      '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
    );
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const target = file === root ? path.join(root, 'index.html') : file;
    res.writeHead(200, {
      'Content-Type':
        {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.html': 'text/html',
          '.svg': 'image/svg+xml',
          '.mp3': 'audio/mpeg',
          '.ogg': 'audio/ogg',
        }[path.extname(target)] || 'application/octet-stream',
    });
    res.end(await readFile(target));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

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
  assert.ok((await svg.locator('.map-label-leader:not([hidden])').count()) > 0);
  const box = await svg.boundingBox();
  assert.ok(Math.abs(box.width / box.height - 2) < 0.01, 'Keep the original map proportions');
}

async function checkOriginalLabels(page) {
  await page.waitForFunction(() => {
    const svg = document.querySelector('.world-map');
    return (
      [...svg.querySelectorAll('.map-marker text')].every(
        (text) =>
          text.getAttribute('x') === text.dataset.labelX &&
          text.getAttribute('y') === text.dataset.labelY,
      ) &&
      [...svg.querySelectorAll('.map-label-leader')].every(
        (line) => line.hasAttribute('hidden') && getComputedStyle(line).display === 'none',
      )
    );
  });
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
    await checkOriginalLabels(page);
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
  await page.close();
  for (const [region, codes] of [
    ['caribbean', ['DO', 'GD', 'TT', 'BB', 'LC', 'VC', 'DM', 'KN', 'AG', 'PR']],
    ['europe', ['VA', 'MC', 'SM', 'LI', 'AD', 'LU', 'BE', 'NL', 'CH', 'AT']],
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
    await checkOriginalLabels(page);
    await page
      .locator('.map-viewport')
      .screenshot({ path: `.firebase/map-labels-original-${region}.png` });
    const coordinates = () =>
      page
        .locator('.map-marker circle:not(.selection-ring)')
        .evaluateAll((dots) => dots.map((dot) => [dot.getAttribute('cx'), dot.getAttribute('cy')]));
    const originalPoints = await coordinates();
    const savedGame = await page.evaluate(() => localStorage.getItem('meridian-conquest-ui-v2'));
    const originalWidth = (await page.locator('.world-map').boundingBox()).width;
    await page.getByRole('button', { name: 'Pin reports', exact: true }).click();
    assert.equal((await page.locator('.world-map').boundingBox()).width, originalWidth);
    await checkLabels(page);
    await page.getByRole('button', { name: 'Collapse reports', exact: true }).click();
    await checkOriginalLabels(page);
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
    await checkOriginalLabels(page);
    assert.deepEqual(await coordinates(), originalPoints);
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${region} keeps original labels without lines at normal size; compact labels separate and select targets across desktop, tablet and mobile`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
