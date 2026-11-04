// Two browsers exercise real room/game logic against an in-memory service; no cloud or AI calls.
import assert from 'node:assert/strict';
import { chromium } from './lib/browser.mjs';
import { startTestServer } from './lib/static-server.mjs';
import { BattleEngine } from '../dist/engine.js';
import { catalogue, findCountry } from '../dist/data.js';
import {
  newRoom,
  joinRoom,
  roomRecord,
  chooseRoomCountry,
  prepareRoomRolls,
  rollRoomInitiative,
  rerollRoomInitiative,
  startRoom,
  moveRoom,
} from '../dist/rooms.js';

const fakeCloud = `
export const cloudEnabled = true;
export async function connectCloud(callbacks) {
  const user = { uid: window.fixtureUid, displayName: window.fixtureUid === 'host' ? 'Mo' : 'Nova' };
  const call = (action, values = {}) => window.roomOperation({ action, uid: user.uid, ...values });
  const service = { user, ready: true, commentary: { enabled: false, status: 'off', pending: [] },
    save: async () => {}, setCommentaryEnabled() {},
    requestCommentary() { throw new Error('This test must not request AI'); },
    rooms: {
      create: options => call('create', { options }), join: () => call('join'),
      setup: (_code, action, country) => call('setup', { setupAction: action, country }),
      start: () => call('start'),
      move: (_code, revision, action, values) => call('move', { revision, move: action, values }),
      watch(_code, receive, fail) {
        let active = true, revision = -1, reading = false;
        const read = async () => {
          if (reading) return;
          reading = true;
          try {
            const room = await window.readFixtureRoom();
            if (active && room && revision !== room.revision) {
              revision = room.revision; window.fixtureRoom = room; receive(room);
            }
          } catch (error) { if (active) fail(error); }
          finally { reading = false; }
        };
        void read(); const timer = setInterval(read, 50);
        return () => { active = false; clearInterval(timer); };
      },
    },
  };
  callbacks.onSession(user, [], true);
  return service;
}`;
let room, browser;
const rollCounts = new Map();
const errors = [];
const server = await startTestServer();
const origin = 'http://localhost:' + server.address().port;
/** Keep all fixture writes inside this process; the browser still uses normal room functions. */
function operation({ action, uid, options, setupAction, country, revision, move, values }) {
  const user = { uid, displayName: uid === 'host' ? 'Mo' : 'Nova' };
  if (action === 'create') {
    room = roomRecord(newRoom('ABC234', user, options));
    return room.code;
  }
  if (action === 'join') {
    room = joinRoom(room, user);
    return room.code;
  }
  if (action === 'setup') {
    if (setupAction === 'country') room = chooseRoomCountry(room, uid, country);
    if (setupAction === 'prepare') room = prepareRoomRolls(room, uid, () => 1);
    if (setupAction === 'reroll') room = rerollRoomInitiative(room, uid, () => 1);
    if (setupAction === 'roll') {
      const count = rollCounts.get(uid) || 0;
      rollCounts.set(uid, count + 1);
      room = rollRoomInitiative(room, uid, count === 0 ? 6 : uid === 'friend' ? 5 : 2);
    }
  }
  if (action === 'start') room = roomRecord(startRoom(room, uid).room);
  if (action === 'move') {
    const resolve = BattleEngine.resolve;
    try {
      // Stable tied combat avoids randomly ending the battle before UI assertions complete.
      if (move === 'roll') BattleEngine.resolve = (a, d) => resolve(a, d, () => 3);
      room = roomRecord(moveRoom(room, uid, revision, move, values).room);
    } finally {
      BattleEngine.resolve = resolve;
    }
  }
}
/** Give each player independent browser storage while routing room operations to the shared fixture. */
async function openPlayer(uid, viewport) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((uid) => {
    window.fixtureUid = uid;
    localStorage.setItem('meridian-ai-commentary', 'off');
  }, uid);
  await page.exposeFunction('roomOperation', operation);
  await page.exposeFunction('readFixtureRoom', () => structuredClone(room));
  await page.route(/\/cloud\.js(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeCloud }),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig=null;' }),
  );
  await page.goto(origin + '/#multiplayer');
  await page.locator('[data-room-form="create"]').waitFor();
  return page;
}
try {
  browser = await chromium.launch({ headless: true });
  const host = await openPlayer('host', { width: 1440, height: 1000 });
  const friend = await openPlayer('friend', { width: 390, height: 844 });
  await host.locator('[data-room-form="create"] button').click();
  await host.locator('[data-room-form="country"]').waitFor();
  // One native autocomplete field must retain typed text/focus when another player joins.
  const hostCountry = host.locator('#room-starting-country');
  assert.equal(await host.locator('[data-room-form="country"] input').count(), 1);
  assert.equal(await host.locator('[data-room-form="country"] select').count(), 0);
  assert.equal(await hostCountry.getAttribute('list'), 'room-country-options');
  assert.equal(await host.locator('#room-country-options option').count(), catalogue.length);
  await hostCountry.fill(' aUsTraLia ');
  assert.equal(room.countryChoices?.host, undefined, 'Searching must not reserve a country.');
  await friend.locator('[data-room-form="join"] input').fill('abc234');
  await friend.locator('[data-room-form="join"] button').click();
  await host.waitForFunction(() => window.fixtureRoom?.memberIds.includes('friend'));
  assert.equal(await hostCountry.inputValue(), ' aUsTraLia ');
  assert.equal(await host.evaluate(() => document.activeElement.id), 'room-starting-country');
  // Unknown text must not reach room operations, and typing again must clear native validity errors.
  await hostCountry.fill('no-country-matches-this');
  await host.locator('[data-room-form="country"] button').click();
  assert.match(await hostCountry.evaluate((input) => input.validationMessage), /suggestions/);
  assert.equal(room.countryChoices?.host, undefined);
  // A known historical code or name must not bypass the playable suggestions through manual typing.
  assert.equal(await host.locator('#room-country-options option[label="IL"]').count(), 0);
  for (const query of ['IL', findCountry('IL').name]) {
    await hostCountry.fill(query);
    await host.locator('[data-room-form="country"] button').click();
    assert.match(await hostCountry.evaluate((input) => input.validationMessage), /suggestions/);
    assert.equal(room.countryChoices?.host, undefined);
  }
  await hostCountry.fill('AU');
  assert.equal(await hostCountry.evaluate((input) => input.validity.valid), true);
  // A friend can claim an unconfirmed draft; remove the suggestion and reject a manually typed copy.
  await friend.locator('#room-starting-country').fill('Australia');
  await friend.locator('[data-room-form="country"] button').click();
  await host.waitForFunction(
    () => !document.querySelector('#room-country-options option[label="AU"]'),
  );
  await host.locator('[data-room-form="country"] button').click();
  assert.match(await hostCountry.evaluate((input) => input.validationMessage), /already chosen/);
  assert.equal(room.countryChoices?.host, undefined);
  // Confirm distinct countries, then force an opening tie to exercise rerolls and friend-first controls.
  for (const [page, country] of [
    [host, 'ZA'],
    [friend, 'JP'],
  ]) {
    await page.locator('#room-starting-country').fill(page === host ? ' za ' : 'jApAn');
    await page.locator('[data-room-form="country"] button').click();
    await page.waitForFunction(
      ({ uid, country }) => window.fixtureRoom?.countryChoices?.[uid] === country,
      { uid: page === host ? 'host' : 'friend', country },
    );
  }
  await friend.waitForFunction(
    () => !document.querySelector('#room-country-options option[label="ZA"]'),
  );
  assert.equal(await friend.locator('#room-starting-country').inputValue(), 'Japan');
  assert.equal(await friend.locator('#room-country-options option[label="JP"]').count(), 1);
  await host.screenshot({ path: '.firebase/multiplayer-one-bar.png', fullPage: true });
  await host.locator('[data-room-action="prepare"]').click();
  await host.locator('[data-room-action="opening-roll"]').click();
  await friend.reload();
  await friend.locator('[data-room-action="opening-roll"]').click();
  await host.locator('[data-room-action="reroll"]').click();
  await host.locator('[data-room-action="opening-roll"]').click();
  await friend.locator('[data-room-action="opening-roll"]').click();
  await host.locator('[data-room-action="start"]').click();
  for (const page of [host, friend]) {
    await page.locator('.board-grid .roster-panel').waitFor();
    assert.equal(await page.locator('.room-board-grid').count(), 0);
    assert.equal(await page.locator('.action-panel').count(), 1);
    assert.equal(await page.locator('[role="tab"]').count(), 2);
  }
  assert.equal(await friend.locator('#attack-from').inputValue(), 'JP');
  assert.equal(await host.locator('[data-action="start-attack"]').count(), 0);
  await friend.locator('.country-row[data-code="ZA"]').click();
  assert.equal(await friend.locator('#attack-to').inputValue(), 'ZA');
  await friend.locator('[data-action="start-attack"]').click();
  await friend.locator('[data-action="roll"]').click();
  await friend.locator('[data-action="roll"]:enabled').waitFor();
  await host.locator('.battle-loss-summary').waitFor();
  await friend.locator('.battle-loss-summary').waitFor();
  await friend.getByRole('tab', { name: 'AI commentary', exact: true }).click();
  await friend.locator('[data-report-control="pin"]').click();
  assert.ok(await friend.locator('.world-map').isVisible());
  assert.equal(
    await friend.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  assert.deepEqual(errors, []);
  if (process.env.MERIDIAN_BROWSER_SCREENSHOTS) {
    await host.screenshot({ path: '.firebase/multiplayer-shared-desktop.png', fullPage: true });
    await friend.screenshot({ path: '.firebase/multiplayer-shared-mobile.png', fullPage: true });
  }
  console.log(
    'PASS: one-bar country search, reservations, validation, reload, opening ties, shared controls and dice.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
