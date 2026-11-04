import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';

/** Put a bot in control of a fixed board so scenarios vary only the relevant strategic facts. */
function arena() {
  const game = GameEngine.create('Strategy regression', 'ZA', true);
  Object.assign(game, {
    round: 4,
    order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    position: 1,
    budget: 0,
    attackUsed: false,
    battle: null,
    lastBattle: null,
    events: [],
  });
  game.countries.forEach((country, index) =>
    Object.assign(country, { owner: index, army: 30, value: 4 }),
  );
  return new GameEngine(game);
}
// Apply planned transfers through legal engine actions instead of editing armies during assertions.
const applyTransfers = (e) => {
  for (const move of e.npcTransfers()) e.transfer(move.from, move.to, move.amount);
};
// Transfers must conserve this total, unlike funding and conquest rewards.
const armyTotal = (game) => game.countries.reduce((sum, country) => sum + country.army, 0);

// Bot explanations must match the action and preserve the phase limit across a saved-battle reload.
test(
  'battle decisions explain continuing and stopping, including the persisted' +
    ' phase limit after reload',
  () => {
    const e = arena(),
      from = e.game.countries[1],
      to = e.game.countries[2];
    from.army = 20;
    to.army = 5;
    e.startAttack(from.code, to.code);
    const continuing = e.npcBattleDecision();
    assert.equal(continuing.continue, true);
    assert.match(continuing.reason, /19 available attackers against 5 defenders/);
    assert.match(continuing.reason, /Continuing/);
    for (let phase = 0; phase < 20; phase++) e.roll(() => 3);
    const restored = new GameEngine(JSON.parse(JSON.stringify(e.game))),
      stopping = restored.npcBattleDecision();
    assert.equal(stopping.continue, false);
    assert.match(stopping.reason, /Stopping.*20 phases/);
    assert.doesNotMatch(stopping.reason, /Continuing|Pressing/);
    assert.equal(restored.npcBattleDecision({ phaseLimit: 30 }).continue, true);
    restored.game.battle.phase = 30;
    assert.match(restored.npcBattleDecision({ phaseLimit: 30 }).reason, /30 phases/);
  },
);

// A reinforcement plan must prepare an attack while retaining protection for its weaker owned
// holding.
test('NPC reinforcement prepares an offensive and retains troops in its other holding', () => {
  const e = arena(),
    [weak, strong] = e.game.countries;
  Object.assign(weak, { owner: 1, army: 1 });
  Object.assign(strong, { owner: 1, army: 20 });
  e.game.budget = 4;
  const { allocations } = e.npcReinforcements();
  assert.equal(
    Object.values(allocations).reduce((a, b) => a + b, 0),
    4,
  );
  assert.ok(allocations[strong.code] > allocations[weak.code]);
  e.reinforce(allocations);
  assert.ok(weak.army >= 2);
  assert.ok(strong.army > 20);
});

// Defensive transfers must conserve soldiers and settle rather than undo themselves on every pass.
test('NPC transfers support weak garrisons and conserve the army', () => {
  const e = arena(),
    [weak, strong] = e.game.countries;
  Object.assign(weak, { owner: 1, army: 1 });
  Object.assign(strong, { owner: 1, army: 20 });
  const total = armyTotal(e.game);
  applyTransfers(e);
  assert.ok(weak.army >= 2);
  assert.ok(strong.army >= 2);
  assert.equal(armyTotal(e.game), total);
  assert.deepEqual(e.npcTransfers(), [], 'a second defence pass must not undo the first');
});

// Bots must protect a newly captured country without changing the core capture reward or inventing
// troops.
test('an NPC fortifies a new conquest before passing the turn without creating soldiers', () => {
  const e = arena(),
    source = e.game.countries[1],
    target = e.game.countries[2];
  source.army = 12;
  target.army = 1;
  target.value = 9;
  const original = e.owned().reduce((sum, country) => sum + country.army, 0);
  e.startAttack(source.code, target.code);
  let index = 0;
  assert.equal(e.roll(() => (index++ % 2 === 0 ? 6 : 1)).conquered, true);
  assert.equal(target.army, 1, 'the core conquest rule is unchanged');
  const total = armyTotal(e.game);
  applyTransfers(e);
  assert.ok(target.army >= 2);
  assert.ok(source.army >= 2);
  assert.equal(armyTotal(e.game), total);
  assert.equal(
    e.owned().reduce((sum, country) => sum + country.army, 0),
    original + 4,
  );
  e.endTurn();
  assert.ok(target.army >= 2, 'the garrison remains defended when the next player starts');
});

// Resuming between conquest and fortification must still defend the captured holding legally.
test('an older saved game can recover from a conquest before the fortification step', () => {
  const e = arena(),
    source = e.game.countries[1],
    target = e.game.countries[2];
  Object.assign(source, { army: 14 });
  Object.assign(target, { army: 1 });
  e.startAttack(source.code, target.code);
  let index = 0;
  e.roll(() => (index++ % 2 === 0 ? 6 : 1));
  const restored = new GameEngine(JSON.parse(JSON.stringify(e.game)));
  const before = armyTotal(restored.game);
  applyTransfers(restored);
  assert.ok(restored.game.countries.find((country) => country.code === target.code).army >= 2);
  assert.equal(armyTotal(restored.game), before);
  assert.equal(restored.game.attackUsed, true);
});

// Repeated cheap recaptures must not trap bots in a loop when another worthwhile target exists.
test('NPCs prefer a worthwhile alternative to repeatedly exchanging the same one-soldier country', () => {
  const e = arena(),
    [source, loop, backup, alternative, otherBackup] = e.game.countries;
  Object.assign(source, { owner: 1, army: 24 });
  Object.assign(loop, { owner: 2, army: 1 });
  Object.assign(backup, { owner: 2, army: 30 });
  Object.assign(alternative, { owner: 3, army: 2 });
  Object.assign(otherBackup, { owner: 3, army: 30 });
  e.game.countries.slice(5).forEach((country) => Object.assign(country, { owner: 4, army: 30 }));
  assert.equal(
    e.npcPlan().to.code,
    loop.code,
    'without churn history, the cheaper target is preferred',
  );
  e.game.events = Array.from({ length: 3 }, () => ({
    type: 'conquest',
    country: loop.code,
    round: e.game.round - 1,
  }));
  assert.equal(e.npcPlan().to.code, alternative.code);
});

// Anti-loop penalties must not prevent taking the final country needed for victory.
test('a recently traded last enemy country can still be attacked to win', () => {
  const e = arena();
  e.game.countries.forEach((country) => Object.assign(country, { owner: 1, army: 3 }));
  const source = e.game.countries[1],
    target = e.game.countries[2];
  source.army = 14;
  Object.assign(target, { owner: 2, army: 1 });
  e.game.events = Array.from({ length: 6 }, () => ({
    type: 'conquest',
    country: target.code,
    round: e.game.round,
  }));
  assert.equal(e.npcPlan().to.code, target.code);
});

// Reserve preferences must not cause a bot to abandon a favorable final exchange unnecessarily.
test('NPCs keep fighting a winnable final exchange instead of abandoning it to preserve a reserve', () => {
  const e = arena(),
    source = e.game.countries[1],
    target = e.game.countries[2];
  Object.assign(source, { army: 3 });
  Object.assign(target, { army: 1, value: 1 });
  e.startAttack(source.code, target.code);
  source.army = 2;
  assert.equal(e.npcBattleDecision().continue, true);
});

// Bots must be able to concentrate spare troops without stripping every other country to one
// soldier.
test('NPCs combine spare troops for an attack while retaining occupation forces', () => {
  const e = arena(),
    [first, second, third] = e.game.countries;
  for (const country of [first, second, third]) Object.assign(country, { owner: 1, army: 6 });
  const before = armyTotal(e.game);
  applyTransfers(e);
  assert.ok(Math.max(...e.owned().map((country) => country.army)) > 6);
  assert.ok(e.owned().every((country) => country.army >= 2));
  assert.equal(armyTotal(e.game), before);
});

// A bot with only one holding must still consider a viable equal-sized opponent instead of always
// waiting.
test('an isolated NPC can challenge an equal-sized army', () => {
  const e = arena(),
    source = e.game.countries[1],
    target = e.game.countries[2];
  source.army = 10;
  target.army = 10;
  assert.equal(e.npcPlan().to.code, target.code);
});

// More active bots must still decline hopeless attacks and stop battles that have become
// unwinnable.
test('NPCs still avoid attacks and stop battles when clearly outmatched', () => {
  const e = arena(),
    source = e.game.countries[1],
    target = e.game.countries[2];
  source.army = 3;
  assert.equal(e.npcPlan().from, undefined);
  e.startAttack(source.code, target.code);
  assert.equal(e.npcBattleDecision().continue, false);
});

// Large empires need meaningful garrisons so a tiny exposed holding does not become an endless
// cheap target.
test('NPC occupation forces scale as armies grow rather than remaining cheap repeating targets', () => {
  const e = arena(),
    [second, first] = e.game.countries;
  Object.assign(first, { owner: 1, army: 1000 });
  Object.assign(second, { owner: 1, army: 2 });
  const before = armyTotal(e.game);
  applyTransfers(e);
  assert.ok(second.army >= 100);
  assert.ok(first.army > second.army);
  assert.equal(armyTotal(e.game), before);
});

// Target scoring must recognize a decisive large battle rather than farm an easy low-impact country
// forever.
test('NPCs can choose a decisive large battle instead of endlessly farming a small target', () => {
  const e = arena(),
    [source, small, backup, decisive] = e.game.countries;
  Object.assign(source, { owner: 1, army: 1101 });
  Object.assign(small, { owner: 2, army: 2 });
  Object.assign(backup, { owner: 2, army: 2000 });
  Object.assign(decisive, { owner: 3, army: 1000 });
  e.game.countries.slice(4).forEach((country) => Object.assign(country, { owner: 4, army: 2000 }));
  assert.equal(e.npcPlan().to.code, decisive.code);
});
