import { chromium } from './lib/browser.mjs';
// Local-only fixtures: country selection, markers and NPC reasoning in both speeds.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import path from 'node:path';
import { GameEngine } from '../dist/engine.js';
import { catalogue } from '../dist/data.js';

const root = path.resolve('dist');
let browser;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname,
      file = path.resolve(
        root,
        '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname),
      );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, {
        'Content-Type':
          {
            '.js': 'text/javascript',
            '.html': 'text/html',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
          }[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://localhost:' + server.address().port;
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
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const { page, errors } = await pageFor();
    await page.setViewportSize(viewport);
    await page.goto(origin + '/#setup');
    assert.equal(await page.locator('.country-option').count(), catalogue.length);
    await page.locator('#country-search').fill('Vatican');
    assert.equal(await page.locator('.country-option').count(), 1);
    await page.locator('[data-action="setup-country"][data-code="VA"]').click();
    assert.match(await page.locator('[data-code="VA"] .country-owner').innerText(), /506 people/);
    await page.locator('#session-name').fill('Vatican browser fixture');
    await page.locator('[data-action="create-game"]').click();
    await page.locator('.game-heading').waitFor();
    const saved = await page.evaluate(
      () => JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0],
    );
    assert.equal(saved.countries[0].code, 'VA');
    assert.equal(saved.countries.length, 10);
    assert.equal(saved.countries[0].value, 1);
    assert.equal(await page.locator('.country-row[data-code="VA"]').count(), 1);
    assert.equal(await page.locator('.map-marker[data-code="VA"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ' +
        viewport.width +
        'px full catalogue, Vatican selection, one starting soldier and a selectable map marker',
    );
    await page.close();
  }
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
