// Offline diplomacy checks use the real controls and local saves without contacting Firebase or AI.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { GameEngine, CAMPAIGN_STORAGE_KEY } from '../dist/engine.js';
import { allianceFor, trustFor } from '../dist/diplomacy.js';

const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
let browser;

/** Read the same local record the application will restore after a refresh. */
async function savedGame(page, id) {
  return page.evaluate(
    ({ key, id }) => JSON.parse(localStorage.getItem(key)).find((game) => game.id === id),
    { key: CAMPAIGN_STORAGE_KEY, id },
  );
}

try {
  browser = await chromium.launch({ headless: true });
  const game = GameEngine.create('Diplomacy browser fixture', 'ZA', true);
  const other = GameEngine.create('Unrelated campaign', 'JP', true);
  // Two smaller commanders share a dominant rival, making cooperation strategically worthwhile.
  const owners = [0, 0, 1, 1, 2, 2, 2, 2, 3, 4];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    country.army = 10;
  });
  game.round = 1;
  game.position = game.order.indexOf(0);
  game.turnStarted = true;
  game.budget = 0;
  game.attackUsed = false;
  game.battle = null;
  game.events = [];
  new GameEngine(game).event('turn', 'Your turn.');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const externalAPIRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      ['fetch', 'xhr'].includes(request.resourceType()) &&
      new URL(request.url()).origin !== origin
    )
      externalAPIRequests.push(request.url());
  });
  // Block every external resource; this regression must work without accounts or API quotas.
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.addInitScript(
    ({ games, key }) => {
      // Seed once so reload tests restore the offer and betrayal rather than resetting the fixture.
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(games));
      localStorage.setItem('meridian-motion-preference', 'reduced');
      localStorage.setItem('meridian-ai-commentary', 'off');
    },
    { games: [game, other], key: CAMPAIGN_STORAGE_KEY },
  );
  await page.goto(origin + '/#game/' + game.id);
  await page.locator('[data-action="start-attack"]').waitFor();
  const originalBoard = structuredClone(game.countries);
  const otherBefore = await savedGame(page, other.id);

  // Diplomacy replaces just the existing action card; accepting must not move or create soldiers.
  await page.locator('[data-action="diplomacy"]').click();
  assert.equal(await page.locator('.action-panel').count(), 1);
  assert.equal(await page.locator('#attack-from').count(), 0);
  await page.locator('#diplomacy-target').selectOption('1');
  await page.locator('[data-action="propose-alliance"]').click();
  await page.locator('.diplomacy-pact').waitFor();
  assert.match(await page.locator('.diplomacy-pact').innerText(), /3 rounds remaining/);
  const accepted = await savedGame(page, game.id);
  assert.ok(allianceFor(accepted, 0), 'The accepted offer must be saved.');
  assert.ok(trustFor(accepted, 1, 0) > trustFor(game, 1, 0));
  assert.deepEqual(accepted.countries, originalBoard);
  assert.equal(accepted.attackUsed, false);
  assert.equal(accepted.budget, 0);
  assert.equal(accepted.round, game.round);
  await page.locator('.action-panel').screenshot({
    path: '.firebase/diplomacy-pact.png',
    animations: 'disabled',
  });
  await page.locator('[data-action="planning"]').click();
  assert.equal(await page.locator('.action-panel').count(), 1);
  await page.locator('#attack-from').waitFor();
  console.log(
    'PASS: a strategic pact opens in the same action card and preserves the board and turn.',
  );

  // A refresh must retain the alliance; the player may still choose to attack an ally's country.
  await page.reload();
  await page.locator('[data-action="diplomacy"]').click();
  await page.locator('.diplomacy-pact').waitFor();
  assert.match(await page.locator('.diplomacy-pact').innerText(), /3 rounds remaining/);
  await page.locator('[data-action="planning"]').click();
  const allyCode = game.countries[2].code;
  assert.equal(await page.locator(`#attack-to option[value="${allyCode}"]`).count(), 1);
  await page.locator('#attack-from').selectOption(game.countries[0].code);
  await page.locator('#attack-to').selectOption(allyCode);
  await page.locator('.alliance-warning').waitFor();
  await page.locator('[data-action="start-attack"]').click();
  await page.locator('[data-action="roll"]').waitFor();
  const betrayed = await savedGame(page, game.id);
  assert.equal(allianceFor(betrayed, 0), null);
  assert.ok(trustFor(betrayed, 1, 0) < trustFor(accepted, 1, 0));
  assert.equal(betrayed.attackUsed, true);
  assert.equal(betrayed.battle.to, allyCode);
  assert.deepEqual(betrayed.countries, originalBoard, 'Choosing an attack must not roll dice.');
  console.log(
    'PASS: reloading retains pacts; allied countries remain attackable and betrayal reduces trust.',
  );

  // Loading an unfinished betrayal must preserve normal combat and leave other saves intact.
  await page.reload();
  await page.locator('[data-action="roll"]').waitFor();
  const restored = await savedGame(page, game.id);
  assert.equal(allianceFor(restored, 0), null);
  assert.equal(trustFor(restored, 1, 0), trustFor(betrayed, 1, 0));
  assert.deepEqual(await savedGame(page, other.id), otherBefore);
  assert.deepEqual(externalAPIRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: betrayal and combat survive reload without changing unrelated campaigns or calling APIs.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
