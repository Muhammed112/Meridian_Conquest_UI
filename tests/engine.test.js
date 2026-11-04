import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, BattleEngine, createRecordId } from '../dist/engine.js';
import { armyValue } from '../dist/data.js';

// HTTP previews must still create distinct valid record IDs when the secure-context UUID helper is
// absent.
test('campaign and event IDs remain valid when an HTTP preview lacks randomUUID', () => {
  let next = 0;
  const source = {
    getRandomValues(bytes) {
      bytes.fill(0);
      bytes[0] = ++next;
      return bytes;
    },
  };
  const first = createRecordId(source),
    second = createRecordId(source);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

// Population-band boundaries determine starting armies, so equality must not grant the next band
// early.
test('population bands include their upper bounds', () => {
  assert.equal(armyValue(5), 1);
  assert.equal(armyValue(5.01), 2);
  assert.equal(armyValue(150), 8);
  assert.equal(armyValue(150.01), 9);
});

// A chosen nickname must become part of the persisted roster and factual turn text from campaign
// creation.
test('a new campaign records the chosen player nickname in its roster and turn reports', () => {
  const game = GameEngine.create('Named campaign', 'ZA', false, 'medium', 'Meridian Goat');
  assert.equal(game.playerNames[0], 'Meridian Goat');
  assert.ok(game.events[0].text.startsWith(game.playerNames[game.events[0].player]));
  assert.equal(JSON.parse(JSON.stringify(game)).playerNames[0], 'Meridian Goat');
});

// Combat must follow paired roll order; sorting faces or awarding ties would change the assignment
// rules.
test('paired dice preserve roll order and ties cause no loss', () => {
  const values = [1, 2, 4, 3, 5, 5];
  const result = BattleEngine.resolve(4, 5, () => values.shift());
  assert.deepEqual(
    result.pairs.map((p) => [p.a, p.d]),
    [
      [1, 2],
      [4, 3],
      [5, 5],
    ],
  );
  assert.equal(result.attackerLoss, 1);
  assert.equal(result.defenderLoss, 1);
});

// Attacking must always leave an occupation force rather than allow an empty source country.
test('one soldier is always reserved in the attacking country', () => {
  const result = BattleEngine.resolve(2, 5, () => 3);
  assert.equal(result.pairs.length, 1);
  assert.throws(() => BattleEngine.resolve(1, 5));
});

// Invalid army or die input must fail atomically so rejected combat cannot partly change a saved
// board.
test('invalid armies and injected die faces are rejected before any board change', () => {
  for (const army of [NaN, Infinity, 0, -1, 2.5, '3'])
    assert.throws(() => BattleEngine.resolve(army, 2));
  const game = GameEngine.create('Invalid dice', 'ZA', true);
  const engine = new GameEngine(game);
  engine.reinforce({ [game.countries[0].code]: game.budget });
  engine.startAttack(game.countries[0].code, game.countries[1].code);
  const before = structuredClone(game);
  for (const face of [0, 7, 2.5, NaN, '6']) {
    assert.throws(() => engine.roll(() => face), /Dice/);
    assert.deepEqual(game, before);
  }
});

// Rejected funding and post-victory actions must leave completed or valid game state untouched.
test('invalid reinforcement input and actions after victory cannot mutate game state', () => {
  const game = GameEngine.create('Invalid allocations', 'ZA', true);
  const engine = new GameEngine(game);
  const before = structuredClone(game);
  for (const allocations of [null, [], { ZA: -1 }, { ZA: '4' }, { BR: game.budget }]) {
    assert.throws(() => engine.reinforce(allocations));
    assert.deepEqual(game, before);
  }
  game.winner = 0;
  assert.throws(() => engine.reinforce({ ZA: game.budget }));
  assert.throws(() => engine.transfer(game.countries[0].code, game.countries[4].code, 1));
});

// Repeated turn initialization must not grant the same reinforcement budget twice.
test('first round grants no reinforcements and later rounds grant two per country', () => {
  const g = GameEngine.create('Test', 'ZA');
  assert.equal(g.budget, 0);
  g.round = 2;
  g.position = g.order.indexOf(0);
  g.turnStarted = false;
  const e = new GameEngine(g);
  e.beginTurn();
  assert.equal(g.budget, 2);
  e.beginTurn();
  assert.equal(g.budget, 2);
});

// Moving troops must respect ownership and the minimum garrison rather than create an empty
// holding.
test('transfers cannot empty a country or move enemy troops', () => {
  const g = GameEngine.create('Test', 'ZA', true),
    e = new GameEngine(g);
  e.reinforce({ [g.countries[0].code]: g.budget });
  const a = g.countries[0],
    b = e.owned()[1],
    enemy = g.countries.find((c) => c.owner !== 0);
  assert.throws(() => e.transfer(a.code, b.code, a.army));
  assert.throws(() => e.transfer(a.code, enemy.code, 1));
  const previous = a.army;
  e.transfer(a.code, b.code, 2);
  assert.equal(a.army, previous - 2);
});

// Capture rewards must use the original strength and must not grant an extra attack in the same
// turn.
test('conquest reward uses original strength, adds one garrison and forbids a second attack', () => {
  const g = GameEngine.create('Test', 'ZA', true),
    e = new GameEngine(g);
  e.reinforce({ [g.countries[0].code]: g.budget });
  const a = g.countries[0],
    d = g.countries.find((c) => c.owner !== 0);
  d.army = 1;
  d.value = 9;
  const before = a.army;
  e.startAttack(a.code, d.code);
  let i = 0;
  const result = e.roll(() => (i++ % 2 === 0 ? 6 : 1));
  assert.equal(result.conquered, true);
  assert.equal(d.owner, 0);
  assert.equal(d.army, 1);
  assert.equal(a.army, before + 3);
  assert.equal(g.lastBattle.reward, 4);
  assert.throws(() => e.startAttack(a.code, g.countries.find((c) => c.owner !== 0).code));
});

// Stopping combat must release the turn to a surviving participant instead of leaving a stuck
// battle.
test('stopping an attack ends the turn and skips eliminated participants', () => {
  const g = GameEngine.create('Test', 'ZA', true),
    e = new GameEngine(g);
  e.reinforce({ [g.countries[0].code]: g.budget });
  const a = g.countries[0],
    d = g.countries.find((c) => c.owner !== 0);
  e.startAttack(a.code, d.code);
  e.stopAttack();
  assert.notEqual(e.current, 0);
  assert.equal(g.battle, null);
  assert.ok(e.owned().length > 0);
});

// Reloading mid-battle must preserve enough state to continue the same combat phase.
test('an in-progress battle survives JSON persistence', () => {
  const g = GameEngine.create('Test', 'ZA', true),
    e = new GameEngine(g);
  e.reinforce({ [g.countries[0].code]: g.budget });
  e.startAttack(g.countries[0].code, g.countries.find((c) => c.owner !== 0).code);
  const restored = new GameEngine(JSON.parse(JSON.stringify(g)));
  let i = 0;
  restored.roll(() => (i++ % 2 === 0 ? 3 : 3));
  assert.equal(restored.game.battle.phase, 1);
  assert.ok(restored.game.battle.pairs.length > 0);
});
