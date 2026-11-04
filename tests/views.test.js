// Render helpers must not trust optional labels carried by imported game data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleViews } from '../dist/ui/battle.js';
import { GameEngine } from '../dist/engine.js';
import { colours } from '../dist/data.js';

// Imported dice metadata must not inject HTML or mislabel the accessible order of displayed pairs.
test('dice pair labels use their display position instead of untrusted saved indices', () => {
  const { dicePairs } = createBattleViews({ motionFrame: null });
  const markup = dicePairs([
    { index: '" onmouseover="alert(1)', a: 2, d: 5 },
    { index: 99, a: 4, d: 4 },
  ]);
  assert.ok(!markup.includes('onmouseover'));
  assert.match(markup, /Pair 1: 2 versus 5, attacker loses one/);
  assert.match(markup, /Pair 2: 4 versus 4, tie/);
});

// Old save fields still pass through the view and must be escaped even when their types are
// unexpected.
test('legacy battle-summary values are escaped before rendering', () => {
  const game = GameEngine.create('Imported summary', 'ZA', true);
  game.position = game.order.indexOf(1);
  game.budget = 0;
  game.lastBattle = {
    from: game.countries[1].code,
    to: game.countries[0].code,
    pairs: [{ a: 2, d: 5 }],
    phase: '<img src=x>',
    attackerLoss: '<img src=x>',
    defenderLoss: '<img src=x>',
    reward: '<img src=x>',
    outcome: 'conquest',
    country: '<img src=x>',
  };
  const { gameView } = createBattleViews({
    state: { view: 'game', allocations: {}, reportDock: {} },
    motionFrame: null,
    owned: (board, player = 0) => board.countries.filter((country) => country.owner === player),
    nav: () => '',
    nameOf: () => 'Commander',
    theatre: () => '',
    campaignPopulationLabel: () => '',
  });
  const markup = gameView(game);
  assert.ok(!markup.includes('<img src=x>'));
  assert.ok(markup.includes('&lt;img src=x&gt;'));
});

// The shared board must enable only the viewing player's own controls and hide host-only actions
// from friends.
test('the shared multiplayer board shows controls and countries relative to the viewer seat', () => {
  const game = GameEngine.create('Friends', 'ZA', true);
  game.mode = 'multiplayer';
  game.position = game.order.indexOf(1);
  game.budget = 2;
  game.playerNames = ['Mo', 'Nova', ...Array(8).fill('Bot')];
  let seat = 1;
  const { gameView } = createBattleViews({
    state: { view: 'multiplayer', allocations: {}, reportDock: {} },
    motionFrame: null,
    owned: (board, player = seat) => board.countries.filter((country) => country.owner === player),
    multiplayer: {
      get playerSeat() {
        return seat;
      },
      isHuman: (player) => player < 2,
      get isHost() {
        return seat === 0;
      },
      decision: '',
    },
    nav: () => '',
    nameOf: (player) => game.playerNames[player],
    theatre: () => '',
    campaignPopulationLabel: () => '',
  });
  const friendMarkup = gameView(game);
  assert.match(friendMarkup, /class="board-grid"/);
  assert.match(friendMarkup, /Reinforce your position/);
  assert.match(friendMarkup, /data-action="confirm-reinforce"/);
  assert.doesNotMatch(friendMarkup, /Generate commentary/);
  seat = 0;
  const hostMarkup = gameView(game);
  assert.match(hostMarkup, /Nova is moving/);
  assert.doesNotMatch(hostMarkup, /data-action="confirm-reinforce"/);
  assert.doesNotMatch(hostMarkup, /data-action="fast"/);
});

// Conquests should regroup visible rows by territory count without changing saved order or selection.
test('the roster groups owners by country count and preserves each country row', () => {
  const game = GameEngine.create('Grouped roster', 'ZA', true);
  const owners = [2, 1, 2, 0, 1, 2, 3, 4, 5, 6];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    // The largest army belongs to a small owner so troop totals cannot determine group rank.
    country.army = index === 3 ? 100 : index + 1;
  });
  const state = {
    view: 'game',
    selected: game.countries[3].code,
    allocations: {},
    reportDock: {},
  };
  const { gameView } = createBattleViews({
    state,
    motionFrame: null,
    owned: (board, player = 0) => board.countries.filter((country) => country.owner === player),
    nav: () => '',
    nameOf: (player) => `Commander ${player}`,
    theatre: () => '',
    campaignPopulationLabel: () => '',
  });
  const savedCountries = structuredClone(game.countries);
  const rows = [
    ...gameView(game).matchAll(/<button\s+class="country-row[\s\S]*?<\/button\s*>/g),
  ].map((match) => match[0]);
  const expectedIndices = [0, 2, 5, 1, 4, 3, 6, 7, 8, 9];
  assert.equal(rows.length, 10);
  expectedIndices.forEach((countryIndex, rowIndex) => {
    const country = game.countries[countryIndex];
    const row = rows[rowIndex];
    assert.ok(row.includes(`data-code="${country.code}"`));
    assert.ok(row.includes(`assets/flags/${country.code.toLowerCase()}.svg`));
    assert.ok(row.includes(`<span>${country.code}</span>`));
    assert.ok(row.includes(`--country-fill:${colours[country.owner]}28`));
    assert.ok(row.includes(`P${country.owner + 1} Commander ${country.owner}`));
    assert.equal(Number(row.match(/class="army-count">(\d+)<\/span/)[1]), country.army);
  });
  assert.match(rows[5], /class="country-row selected/);
  assert.deepEqual(game.countries, savedCountries);

  // Recount each render: a new capture can change the leader; tied owners use their seat order.
  game.countries[7].owner = 1;
  const codesAfterCapture = [
    ...gameView(game).matchAll(/data-action="select-country"\s+data-code="(\w+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    codesAfterCapture,
    [1, 4, 7, 0, 2, 5, 3, 6, 8, 9].map((index) => game.countries[index].code),
  );
  assert.deepEqual(
    game.countries.map((country) => country.code),
    savedCountries.map((country) => country.code),
  );
  assert.equal(state.selected, game.countries[3].code);
});

/** Render diplomacy against real engine state without requiring browser or cloud services. */
function diplomacyView(game, state, { seat = 0, nameOf = (player) => `Commander ${player}` } = {}) {
  const { gameView } = createBattleViews({
    state,
    motionFrame: null,
    owned: (board, player = game.mode === 'multiplayer' ? seat : 0) =>
      board.countries.filter((country) => country.owner === player),
    multiplayer: { playerSeat: seat, isHuman: (player) => player < 2, isHost: seat === 0 },
    nav: () => '',
    nameOf,
    theatre: () => '',
    campaignPopulationLabel: () => '',
  });
  return gameView(game);
}

/** An accepted pact between two smaller commanders, with a stronger outside rival. */
function alliedGame() {
  const game = GameEngine.create('Diplomacy targets', 'ZA', true);
  const owners = [0, 0, 1, 1, 2, 2, 2, 2, 3, 4];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    country.army = 10;
  });
  game.round = 1;
  game.budget = 0;
  game.position = game.order.indexOf(0);
  assert.equal(new GameEngine(game).proposeAlliance(1).accepted, true);
  return game;
}

// Rendering a remembered diplomacy tab must never bypass spectator, tutorial or game-phase guards.
test('diplomacy controls are available only during a human turn with an NPC to negotiate with', () => {
  const game = GameEngine.create('Diplomacy guards', 'ZA', true);
  game.round = 1;
  game.budget = 0;
  game.position = game.order.indexOf(0);
  const state = { view: 'game', action: 'diplomacy', allocations: {}, reportDock: {} };
  const initial = diplomacyView(game, state);
  assert.match(initial, /id="diplomacy-target"/);
  assert.match(initial, /data-action="propose-alliance"/);
  assert.equal([...initial.matchAll(/class="[^"]*\baction-panel\b/g)].length, 1);

  state.watch = true;
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
  state.watch = false;
  state.view = 'tutorial';
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
  state.view = 'game';
  game.budget = 2;
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
  game.budget = 0;
  game.position = game.order.indexOf(1);
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
  game.position = game.order.indexOf(0);
  new GameEngine(game).startAttack(game.countries[0].code, game.countries[1].code);
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
  game.battle = null;
  game.winner = 0;
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);

  // Human friends cannot receive an automatic NPC response when only human-owned countries remain.
  game.winner = null;
  game.mode = 'multiplayer';
  game.countries.forEach((country, index) => {
    country.owner = index % 2;
  });
  state.view = 'multiplayer';
  assert.doesNotMatch(diplomacyView(game, state), /id="diplomacy-target"|data-action="diplomacy"/);
});

// An alliance warns about betrayal but must preserve the ordinary ability to choose any rival target.
test('allied countries remain target options and the pact appears in the same action panel', () => {
  const game = alliedGame();
  const state = {
    view: 'game',
    action: 'planning',
    target: game.countries[2].code,
    allocations: {},
    reportDock: {},
  };
  const original = structuredClone(game);
  const planning = diplomacyView(game, state);
  assert.match(planning, /class="alliance-warning"/);
  assert.match(planning, /breaks your pact/);
  assert.match(
    planning,
    new RegExp(`<option value="${game.countries[2].code}"[^>]*>[\\s\\S]*?\\(Ally\\)`),
  );
  assert.match(planning, /data-action="start-attack"/);

  state.action = 'diplomacy';
  const diplomacy = diplomacyView(game, state);
  assert.match(diplomacy, /class="diplomacy-pact"/);
  assert.match(diplomacy, /Commander 1/);
  assert.match(diplomacy, /3 rounds remaining/);
  assert.doesNotMatch(diplomacy, /id="attack-from"|data-action="propose-alliance"/);
  assert.equal([...diplomacy.matchAll(/class="[^"]*\baction-panel\b/g)].length, 1);
  assert.deepEqual(
    game,
    original,
    'Switching action cards must not change the game or its events.',
  );
});

// Roster badges identify the player's current ally and show the live pact duration on hover.
test('only the allied roster group has a named header and a remaining-rounds badge', () => {
  const game = alliedGame();
  const state = { view: 'game', allocations: {}, reportDock: {} };
  const original = structuredClone(game);
  const markup = diplomacyView(game, state, { seat: 1 });
  const groupHeaders = [
    ...markup.matchAll(/aria-label="Player (\d+) countries"([\s\S]*?)(?=<button)/g),
  ];
  assert.deepEqual(
    groupHeaders.map((match) => Number(match[1])),
    [3, 1, 2, 4, 5],
  );
  for (const [, player, header] of groupHeaders) {
    if (player === '2') {
      assert.match(header, /class="country-owner-group-head"/);
      assert.match(header, /Commander 1/);
      assert.match(header, /class="badge gold ally-badge"[^>]*title="3 rounds remaining"/);
      assert.match(header, />\s*Ally\s*</);
    } else {
      assert.doesNotMatch(header, /country-owner-group-head|ally-badge/);
    }
  }
  assert.equal([...markup.matchAll(/class="badge gold ally-badge"/g)].length, 1);
  assert.deepEqual(game, original, 'Rendering a badge must not modify the game.');

  // The app's nameOf callback already escapes commander names before returning markup.
  const escaped = diplomacyView(game, state, { nameOf: () => '&lt;Commander &amp; Ally&gt;' });
  const header = escaped.match(/class="country-owner-group-head"([\s\S]*?)(?=<button)/)[1];
  assert.match(header, /&lt;Commander &amp; Ally&gt;/);
  assert.doesNotMatch(header, /<Commander/);
  game.round = 3;
  assert.match(
    diplomacyView(game, state),
    /class="badge gold ally-badge"[^>]*title="1 round remaining"/,
  );
});

// Old accepted events must not keep the badge after the canonical pact has ended.
test('the roster ally badge disappears on expiry, betrayal and elimination', () => {
  const state = { view: 'game', allocations: {}, reportDock: {} };
  for (const ending of ['expiry', 'betrayal', 'elimination']) {
    const game = alliedGame();
    assert.match(diplomacyView(game, state), /ally-badge/);
    if (ending === 'expiry') game.round = 4;
    if (ending === 'betrayal')
      new GameEngine(game).startAttack(game.countries[0].code, game.countries[2].code);
    if (ending === 'elimination')
      game.countries.forEach((country) => {
        if (country.owner === 1) country.owner = 2;
      });
    assert.doesNotMatch(diplomacyView(game, state), /ally-badge|country-owner-group-head/, ending);
  }
});

// A friend's NPC pact belongs to their viewer seat and must not label an uninvolved host's roster.
test('multiplayer roster ally badges are relative to the viewer rather than the host', () => {
  const game = GameEngine.create('Friends with an ally', 'ZA', true);
  const owners = [1, 1, 2, 2, 3, 3, 3, 3, 0, 4];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    country.army = 10;
  });
  game.mode = 'multiplayer';
  game.round = 1;
  game.budget = 0;
  game.position = game.order.indexOf(1);
  const state = { view: 'multiplayer', allocations: {}, reportDock: {} };
  assert.doesNotMatch(diplomacyView(game, state, { seat: 1 }), /ally-badge/);
  assert.equal(new GameEngine(game).proposeAlliance(2, { humanCount: 2 }).accepted, true);

  const friendMarkup = diplomacyView(game, state, { seat: 1 });
  const allyHeader = friendMarkup.match(/aria-label="Player 3 countries"([\s\S]*?)(?=<button)/)[1];
  assert.match(allyHeader, /country-owner-group-head/);
  assert.match(allyHeader, /Commander 2/);
  assert.match(allyHeader, /class="badge gold ally-badge"[^>]*title="3 rounds remaining"/);
  assert.equal([...friendMarkup.matchAll(/class="badge gold ally-badge"/g)].length, 1);
  assert.doesNotMatch(
    diplomacyView(game, state, { seat: 0 }),
    /ally-badge|country-owner-group-head/,
  );
});
