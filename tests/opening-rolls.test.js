import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openingDie,
  openingLeaders,
  createOpeningRolls,
  recordOpeningRoll,
  rerollOpeningLeaders,
} from '../dist/opening-rolls.js';

const players = Array.from({ length: 10 }, (_, seat) => String(seat));

// Every accepted byte must contribute equally so a single-player opening has no preferred face.
test('opening dice distribute accepted byte values equally across all six faces', () => {
  const faces = Array(6).fill(0);
  for (let byte = 0; byte < 252; byte++) {
    const face = openingDie({ getRandomValues: () => new Uint8Array([byte]) });
    faces[face - 1]++;
  }
  assert.deepEqual(faces, [42, 42, 42, 42, 42, 42]);
});

// Both the player and every bot must receive one die, and either kind of seat can start.
test('automatic opening rolls include all ten seats and can select a human or bot winner', () => {
  for (const winningSeat of [0, 7]) {
    let calls = 0;
    const initiative = createOpeningRolls(players, [], () => (calls++ === winningSeat ? 6 : 1));
    assert.equal(calls, 10);
    assert.equal(initiative.winner, String(winningSeat));
    assert.deepEqual(initiative.contenders, players);
    assert.equal(initiative.round, 1);
    assert.deepEqual(openingLeaders(initiative), [String(winningSeat)]);
  }
});

// A multiplayer winner must wait for human clicks even when a bot already has a high result.
test('individually controlled seats wait for their own roll without modifying prior state', () => {
  const initial = createOpeningRolls(players, ['0', '1'], () => 1);
  const snapshot = structuredClone(initial);
  assert.deepEqual(openingLeaders(initial), []);
  assert.equal(initial.rolls['0'], 0);
  assert.equal(initial.rolls['1'], 0);
  const firstRoll = recordOpeningRoll(initial, '0', 2);
  assert.equal(firstRoll.winner, '');
  const finished = recordOpeningRoll(firstRoll, '1', 6);
  assert.equal(finished.winner, '1');
  assert.equal(firstRoll.rolls['1'], 0);
  assert.deepEqual(initial, snapshot);
  assert.notEqual(initial.players, players);
});

// An invalid or repeated click must never replace a recorded face or add an outsider to the draw.
test('opening rolls reject outsiders, duplicate rolls, and invalid die faces', () => {
  const initial = createOpeningRolls(players, ['0', '1'], () => 1);
  for (const face of [0, 7, -1, 1.5, NaN, '6', null])
    assert.throws(() => recordOpeningRoll(initial, '0', face), /Invalid opening die/);
  assert.throws(() => recordOpeningRoll(initial, 'outsider', 6), /not waiting/);
  const rolled = recordOpeningRoll(initial, '0', 4);
  assert.throws(() => recordOpeningRoll(rolled, '0', 6), /already rolled/);
  assert.equal(rolled.rolls['0'], 4);
  assert.equal(initial.rolls['0'], 0);
});

// Repeated ties must narrow the draw fairly without giving eliminated players extra attempts.
test('repeated tie-breaks roll only tied leaders and preserve eliminated results', () => {
  let seat = 0;
  const initial = createOpeningRolls(players, [], () => (seat++ < 3 ? 6 : 2));
  const snapshot = structuredClone(initial);
  let calls = 0;
  const second = rerollOpeningLeaders(initial, [], () => (++calls < 3 ? 5 : 1));
  assert.equal(calls, 3);
  assert.deepEqual(second.contenders, ['0', '1', '2']);
  assert.deepEqual(openingLeaders(second), ['0', '1']);
  assert.equal(second.rolls['3'], 2);
  calls = 0;
  const third = rerollOpeningLeaders(second, [], () => (++calls === 1 ? 3 : 4));
  assert.equal(calls, 2);
  assert.equal(third.round, 3);
  assert.equal(third.winner, '1');
  assert.equal(third.rolls['2'], 1);
  assert.equal(second.rolls['0'], 5);
  assert.deepEqual(initial, snapshot);
  assert.throws(() => recordOpeningRoll(third, '2', 6), /not waiting/);
  assert.throws(() => rerollOpeningLeaders(third), /completed tied round/);
});

// Room-specific metadata and human control must survive reuse of the same tie-break logic.
test('human tie-breaks reset only leaders and retain room country metadata', () => {
  const initial = {
    ...createOpeningRolls(players, [], () => 1),
    countries: ['ZA', 'JP'],
    rolls: Object.fromEntries(players.map((id) => [id, id === '0' || id === '2' ? 6 : 1])),
  };
  let calls = 0;
  const next = rerollOpeningLeaders(initial, ['0', '1'], () => {
    calls++;
    return 4;
  });
  assert.equal(calls, 1);
  assert.equal(next.rolls['0'], 0);
  assert.equal(next.rolls['1'], 1);
  assert.equal(next.rolls['2'], 4);
  assert.deepEqual(next.countries, initial.countries);
  assert.deepEqual(openingLeaders(next), []);
  assert.equal(recordOpeningRoll(next, '0', 5).winner, '0');
  assert.equal(initial.rolls['0'], 6);
});

// A tie-break is meaningful only after everyone rolls; it cannot bypass a waiting player.
test('tie-breaks reject incomplete rounds before drawing any new dice', () => {
  const initial = createOpeningRolls(players, ['0'], () => 6);
  let calls = 0;
  assert.throws(() => rerollOpeningLeaders(initial, [], () => ++calls), /completed tied round/);
  assert.equal(calls, 0);
  assert.deepEqual(openingLeaders(null), []);
});
