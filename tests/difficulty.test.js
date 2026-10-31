import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { difficultyFor, difficultyOptions } from '../dist/difficulty.js';

function arena(difficulty) {
  const game = GameEngine.create('Difficulty test', 'ZA', true, difficulty);
  Object.assign(game, {
    position: 1,
    order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    budget: 0,
    battle: null,
    lastBattle: null,
    attackUsed: false,
    events: [],
  });
  game.countries.forEach((country, i) =>
    Object.assign(country, { owner: i, army: 1000, value: 4 }),
  );
  return new GameEngine(game);
}
function canAttack(level, available) {
  const engine = arena(level);
  engine.game.countries[1].army = available + 1;
  engine.game.countries[2].army = 18;
  return engine.npcPlan().to?.code === engine.game.countries[2].code;
}

test('each campaign persists its chosen difficulty and unknown levels use Medium', () => {
  for (const level of difficultyOptions) {
    const game = GameEngine.create('Saved setting', 'ZA', true, level.id);
    assert.equal(JSON.parse(JSON.stringify(game)).difficulty, level.id);
  }
  for (const invalid of [undefined, null, 'legendary', '__proto__'])
    assert.equal(difficultyFor(invalid).id, 'medium');
});

test('the four levels accept progressively closer small battles', () => {
  assert.equal(canAttack('easy', 21), true);
  assert.equal(canAttack('easy', 17), false);
  assert.equal(canAttack('medium', 17), true);
  assert.equal(canAttack('medium', 16), false);
  assert.equal(canAttack('hard', 16), true);
  assert.equal(canAttack('hard', 15), false);
  assert.equal(canAttack('extreme', 15), true);
});

test('reinforcement priorities differ while every level spends the exact normal budget', () => {
  const offensive = [];
  for (const level of difficultyOptions) {
    const engine = arena(level.id);
    engine.game.countries.forEach((c) => Object.assign(c, { owner: 1, army: 1 }));
    const strong = engine.game.countries[1];
    strong.army = 100;
    engine.game.budget = 20;
    const plan = engine.npcReinforcements();
    offensive.push(plan.allocations[strong.code]);
    assert.equal(
      Object.values(plan.allocations).reduce((sum, n) => sum + n, 0),
      20,
    );
    const before = engine.owned().reduce((sum, c) => sum + c.army, 0);
    engine.reinforce(plan.allocations);
    assert.equal(
      engine.owned().reduce((sum, c) => sum + c.army, 0),
      before + 20,
    );
  }
  assert.deepEqual(offensive, [10, 13, 16, 18]);
});

test('every difficulty conserves transferred troops and avoids one-soldier occupation loops', () => {
  for (const level of difficultyOptions) {
    const engine = arena(level.id),
      [weak, strong] = engine.game.countries;
    Object.assign(weak, { owner: 1, army: 1 });
    Object.assign(strong, { owner: 1, army: 81 });
    const before = engine.game.countries.reduce((sum, c) => sum + c.army, 0);
    for (const move of engine.npcTransfers()) engine.transfer(move.from, move.to, move.amount);
    assert.ok(weak.army >= 2, level.label);
    assert.ok(strong.army > weak.army, level.label);
    assert.equal(
      engine.game.countries.reduce((sum, c) => sum + c.army, 0),
      before,
    );
    assert.deepEqual(engine.npcTransfers(), [], `${level.label} transfers must settle`);
  }
});

test('retreat decisions become less forgiving across difficulty levels', () => {
  const continues = (level, available, defenders, eliminates = true) => {
    const engine = arena(level),
      from = engine.game.countries[1],
      to = engine.game.countries[2];
    from.army = available + 1;
    to.army = defenders;
    if (!eliminates) engine.game.countries[3].owner = to.owner;
    engine.startAttack(from.code, to.code);
    return engine.npcBattleDecision().continue;
  };
  assert.equal(continues('easy', 4, 5), false);
  assert.equal(continues('medium', 4, 5), true);
  assert.equal(continues('medium', 3, 5, false), false);
  assert.equal(continues('hard', 3, 5, false), true);
  assert.equal(continues('hard', 2, 5), false);
  assert.equal(continues('extreme', 2, 5), true);
});

test('Hard and Extreme recognise hopeless large battles despite a superficially close ratio', () => {
  for (const level of ['hard', 'extreme']) {
    const engine = arena(level),
      source = engine.game.countries[1],
      target = engine.game.countries[2];
    source.army = 801;
    target.army = 1000;
    assert.equal(engine.npcPlan().from, undefined);
  }
});

test('higher levels put more pressure on a strong player instead of farming a cheaper target', () => {
  const targetFor = (level) => {
    const engine = arena(level),
      [reserve, source, leader, leaderArmy, cheap, backup] = engine.game.countries;
    Object.assign(reserve, { owner: 1, army: 2 });
    Object.assign(source, { owner: 1, army: 20 });
    Object.assign(leader, { owner: 0, army: 4 });
    Object.assign(leaderArmy, { owner: 0, army: 400 });
    Object.assign(cheap, { owner: 2, army: 3 });
    Object.assign(backup, { owner: 2, army: 30 });
    engine.game.countries.slice(6).forEach((c) => Object.assign(c, { owner: 3, army: 1000 }));
    return { code: engine.npcPlan().to?.code, leader: leader.code, cheap: cheap.code };
  };
  const medium = targetFor('medium');
  assert.equal(medium.code, medium.cheap);
  for (const level of ['hard', 'extreme']) {
    const plan = targetFor(level);
    assert.equal(plan.code, plan.leader);
  }
});

test('Easy gives the player breathing room when another worthwhile target is available', () => {
  const targetFor = (level) => {
    const engine = arena(level),
      [reserve, source, human, humanBackup, rival, rivalBackup] = engine.game.countries;
    Object.assign(reserve, { owner: 1, army: 2 });
    Object.assign(source, { owner: 1, army: 20 });
    Object.assign(human, { owner: 0, army: 2 });
    Object.assign(humanBackup, { owner: 0, army: 30 });
    Object.assign(rival, { owner: 2, army: 3 });
    Object.assign(rivalBackup, { owner: 2, army: 30 });
    engine.game.countries.slice(6).forEach((c) => Object.assign(c, { owner: 3, army: 1000 }));
    return { selected: engine.npcPlan().to?.code, human: human.code, rival: rival.code };
  };
  const easy = targetFor('easy');
  assert.equal(easy.selected, easy.rival);
  const medium = targetFor('medium');
  assert.equal(medium.selected, medium.human);
});

test('Easy still attacks the player when that is the only remaining rival', () => {
  const engine = arena('easy');
  engine.game.countries.forEach((c) => Object.assign(c, { owner: 1, army: 4 }));
  const source = engine.game.countries[1],
    target = engine.game.countries[2];
  source.army = 20;
  Object.assign(target, { owner: 0, army: 1 });
  assert.equal(engine.npcPlan().to?.code, target.code);
});

test('difficulty never changes the result of identical dice rolls', () => {
  const outcomes = difficultyOptions.map((level) => {
    const engine = arena(level.id),
      source = engine.game.countries[1],
      target = engine.game.countries[2];
    source.army = 4;
    target.army = 4;
    engine.startAttack(source.code, target.code);
    const values = [1, 6, 4, 4, 6, 2];
    engine.roll(() => values.shift());
    return { pairs: engine.game.battle.pairs, attacker: source.army, defender: target.army };
  });
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
});
