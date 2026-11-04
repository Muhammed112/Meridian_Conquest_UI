import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newRoom,
  joinRoom,
  leaveRoom,
  startRoom,
  readRoomGame,
  roomRecord,
  createRoomService,
  chooseRoomCountry,
  prepareRoomRolls,
  rollRoomInitiative,
  rerollRoomInitiative,
} from '../dist/rooms.js';
import { openingLeaders, openingDie, validateRoomSetup } from '../dist/room-setup.js';
import { applyBoardChoice } from '../dist/controllers/board-actions.js';

const host = { uid: 'host', displayName: 'Mo' };
const friend = { uid: 'friend', displayName: 'Nova' };
/** Run a real two-person country reservation flow before initiative and tie-break scenarios. */
function chosenRoom() {
  let room = joinRoom(newRoom('ABC234', host), friend);
  room = chooseRoomCountry(room, host.uid, 'ZA');
  return chooseRoomCountry(room, friend.uid, 'JP');
}

// No player may reserve another member's country or bypass country selection before the opening
// roll.
test('country choices are unique, member-owned, releasable, and required before dice', () => {
  let room = joinRoom(newRoom('ABC234', host), friend);
  assert.throws(() => startRoom(room, host.uid), /opening dice/);
  assert.throws(() => prepareRoomRolls(room, host.uid), /choose a country/);
  assert.throws(() => chooseRoomCountry(room, 'stranger', 'ZA'), /before/);
  assert.throws(() => chooseRoomCountry(room, host.uid, 'XX'), /valid country/);
  room = chooseRoomCountry(room, host.uid, 'ZA');
  assert.throws(() => chooseRoomCountry(room, friend.uid, 'ZA'), /already been chosen/);
  room = chooseRoomCountry(room, friend.uid, 'JP');
  assert.deepEqual(room.countryChoices, { host: 'ZA', friend: 'JP' });
  assert.deepEqual(leaveRoom(room, friend.uid).countryChoices, { host: 'ZA' });
  assert.equal(room.members.friend.name, 'Nova');
});

// New choices use the playable catalogue, while historical opening records remain readable for recovery.
test('new reservations exclude unavailable countries without invalidating historical room setup', () => {
  assert.throws(() => chooseRoomCountry(newRoom('ABC234', host), host.uid, 'IL'), /valid country/);
  const historical = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  historical.countryChoices.host = 'IL';
  historical.initiative.countries[0] = 'IL';
  assert.equal(validateRoomSetup(historical), historical);
  assert.equal(historical.initiative.countries[0], 'IL');
  assert.throws(
    () => prepareRoomRolls({ ...historical, status: 'lobby', initiative: null }, host.uid),
    /choose a country/,
  );
});

// A friend's winning roll must produce their turn and country after persistence, rather than
// default to host.
test('human opening rolls persist once, bots fill unique seats, and the winning friend starts', () => {
  let room = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  assert.equal(room.status, 'rolling');
  assert.equal(room.initiative.rolls.host, 0);
  assert.equal(room.initiative.rolls.friend, 0);
  assert.equal(new Set(room.initiative.countries).size, 10);
  assert.deepEqual(room.initiative.countries.slice(0, 2), ['ZA', 'JP']);
  assert.throws(() => chooseRoomCountry(room, friend.uid, 'BR'), /before/);
  assert.throws(() => joinRoom(room, { uid: 'late' }), /already started/);
  room = rollRoomInitiative(room, host.uid, 2);
  assert.throws(() => rollRoomInitiative(room, host.uid, 6), /already rolled/);
  assert.throws(() => startRoom(room, host.uid), /Finish/);
  room = rollRoomInitiative(room, friend.uid, 6);
  assert.throws(() => startRoom(room, friend.uid), /host/);
  const playing = roomRecord(startRoom(room, host.uid).room);
  const game = readRoomGame(playing);
  assert.equal(playing.currentSeat, 1);
  assert.equal(playing.controllerUid, friend.uid);
  assert.equal(game.order[0], 1);
  assert.equal(game.order.at(-1), 0);
  assert.equal(game.countries[1].code, 'JP');
  assert.equal(game.countries[1].owner, 1);
  assert.equal(game.playerNames[1], 'Nova');
  assert.equal(readRoomGame(JSON.parse(JSON.stringify(playing))).order[0], 1);
});

// A tie-break must reset only eligible leaders and must not allow repeated or fabricated die
// results.
test('only tied leaders reroll; rejected or repeated rolls cannot change their recorded result', () => {
  let room = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  room = rollRoomInitiative(room, host.uid, 6);
  room = rollRoomInitiative(room, friend.uid, 6);
  assert.deepEqual(openingLeaders(room.initiative), ['host', 'friend']);
  assert.throws(() => startRoom(room, host.uid), /Finish/);
  assert.throws(() => rerollRoomInitiative(room, friend.uid), /host/);
  room = rerollRoomInitiative(room, host.uid);
  assert.equal(room.initiative.round, 2);
  assert.deepEqual(room.initiative.contenders, ['host', 'friend']);
  assert.equal(room.initiative.rolls['bot:2'], 1);
  assert.throws(() => rollRoomInitiative(room, 'bot:2', 6), /not waiting/);
  assert.throws(() => rollRoomInitiative(room, host.uid, 7), /Invalid/);
  room = rollRoomInitiative(room, host.uid, 3);
  room = rollRoomInitiative(room, friend.uid, 5);
  assert.equal(room.initiative.winner, friend.uid);
  assert.throws(() => rerollRoomInitiative(room, host.uid), /completed tied/);
});

// Bot seats must participate fairly in initiative while the host retains responsibility for bot
// moves.
test('a bot can win the opening roll and its unique country is retained at start', () => {
  let index = 0;
  let room = prepareRoomRolls(chosenRoom(), host.uid, () => (++index === 1 ? 6 : 1));
  room = rollRoomInitiative(room, host.uid, 2);
  room = rollRoomInitiative(room, friend.uid, 3);
  assert.equal(room.initiative.winner, 'bot:2');
  const playing = startRoom(room, host.uid).room;
  assert.equal(playing.currentSeat, 2);
  assert.equal(playing.controllerUid, host.uid);
});

// Shared controls must resolve the viewing seat without committing board changes before
// confirmation.
test('shared UI choices resolve ownership for a friend without mutating the game', () => {
  let room = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  room = rollRoomInitiative(room, host.uid, 2);
  room = rollRoomInitiative(room, friend.uid, 6);
  const game = readRoomGame(startRoom(room, host.uid).room);
  game.budget = 4;
  const original = structuredClone(game);
  const state = { allocations: {} };
  applyBoardChoice(game, state, 1, 'select-country', 'JP');
  assert.equal(state.origin, 'JP');
  applyBoardChoice(game, state, 1, 'select-country', 'ZA');
  assert.equal(state.target, 'ZA');
  applyBoardChoice(game, state, 1, 'auto-allocate');
  assert.deepEqual(state.allocations, { JP: 4 });
  applyBoardChoice(game, state, 1, 'allocate-minus', 'JP');
  assert.equal(state.allocations.JP, 3);
  assert.equal(applyBoardChoice(game, state, 1, 'allocate-plus', 'ZA'), false);
  assert.deepEqual(game, original);
});

// Rejection sampling protects opening-roll fairness by excluding bytes outside a complete six-face
// range.
test('opening dice reject out-of-range bytes rather than biasing the six faces', () => {
  const values = [255, 252, 251];
  assert.equal(openingDie({ getRandomValues: () => new Uint8Array([values.shift()]) }), 6);
  assert.equal(values.length, 0);
});

// A malformed shared setup must fail before a fabricated country allocation or winner reaches the
// screen.
test('malformed shared setup and fabricated opening winners are rejected before display', () => {
  const room = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  for (const change of [
    (setup) => {
      setup.countries[1] = setup.countries[0];
    },
    (setup) => {
      setup.players[1] = 'stranger';
    },
    (setup) => {
      setup.rolls.friend = 7;
    },
    (setup) => {
      setup.winner = 'host';
    },
  ]) {
    const invalid = structuredClone(room);
    change(invalid.initiative);
    assert.throws(() => validateRoomSetup(invalid), /invalid opening dice/);
  }
});

// A delayed roll click must not be replayed into a later tie-break after a transaction retry.
test('an opening-roll transaction cannot apply an old click to a new tie-break round', async () => {
  let room = prepareRoomRolls(chosenRoom(), host.uid, () => 1);
  room = rollRoomInitiative(room, host.uid, 6);
  room = rollRoomInitiative(room, friend.uid, 6);
  room = rerollRoomInitiative(room, host.uid);
  let writes = 0;
  const service = createRoomService({
    db: {},
    getUser: () => friend,
    sdk: {
      doc: () => ({}),
      runTransaction: async (_db, update) =>
        update({
          get: async () => ({ exists: () => true, data: () => structuredClone(room) }),
          set: () => {
            writes++;
          },
        }),
    },
  });
  await assert.rejects(service.setup('ABC234', 'roll', undefined, 1), /round changed/);
  assert.equal(writes, 0);
  await service.setup('ABC234', 'roll', undefined, 2);
  assert.equal(writes, 1);
});
