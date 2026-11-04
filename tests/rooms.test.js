import test from 'node:test';
import assert from 'node:assert/strict';
import {
  joinRoom,
  leaveRoom,
  startRoom,
  moveRoom,
  roomCode,
  normalizeRoomCode,
  readRoomGame,
  roomRecord,
} from '../dist/rooms.js';
import { GameEngine } from '../dist/engine.js';
import { allianceFor, trustFor } from '../dist/diplomacy.js';
import { legacyRoom as newRoom } from './helpers/rooms.js';
const host = { uid: 'host', displayName: 'Host' },
  friend = { uid: 'friend', displayName: 'Friend' };
// Existing saved rooms need the legacy lobby path to remain playable.
const lobby = () => joinRoom(newRoom('ABC234', host), friend);
/** Pin the controller seat in a started legacy room so permission checks do not depend on initiative. */
function started(seat = 0) {
  const result = startRoom(lobby(), 'host');
  const game = JSON.parse(result.room.payload);
  game.position = game.order.indexOf(seat);
  game.budget = 0;
  game.battle = null;
  game.attackUsed = false;
  return {
    ...result.room,
    currentSeat: seat,
    controllerUid: seat < 2 ? ['host', 'friend'][seat] : 'host',
    payload: JSON.stringify(game),
  };
}

// Room codes must be easy to copy and type while rejecting characters that could alter a document
// path.
test('room codes are six unambiguous characters and pasted codes normalize', () => {
  assert.match(roomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(normalizeRoomCode(' abc234 '), 'ABC234');
  for (const code of ['ABCD', 'ABC01I', 'ABC234/other', '<html>'])
    assert.throws(() => normalizeRoomCode(code));
});

// A profile rename must affect future rooms without rewriting the names already recorded in a
// match.
test('account nicknames carry over to the lobby, started game and room reload for hosts and friends', () => {
  const namedHost = { uid: 'host', displayName: 'Meridian Goat' },
    namedFriend = { uid: 'friend', displayName: 'Night Owl' };
  const room = joinRoom(newRoom('ABC234', namedHost), namedFriend);
  assert.equal(room.members.host.name, 'Meridian Goat');
  assert.equal(room.members.friend.name, 'Night Owl');
  const started = startRoom(room, 'host').room,
    game = readRoomGame(started);
  assert.deepEqual(game.playerNames.slice(0, 2), ['Meridian Goat', 'Night Owl']);
  assert.ok(game.events[0].text.startsWith(game.playerNames[game.events[0].player]));
  namedFriend.displayName = 'Future nickname';
  assert.equal(
    readRoomGame(started).playerNames[1],
    'Night Owl',
    'Existing matches retain the recorded nickname',
  );
  assert.equal(
    joinRoom(newRoom('BCD345', namedHost), namedFriend).members.friend.name,
    'Future nickname',
  );
});

// Joining must be idempotent and fill only spare seats with bots while keeping ten unique
// countries.
test('friends join once, capacity is ten, and host start fills remaining countries with bots', () => {
  let room = newRoom('ABC234', host);
  for (let n = 1; n < 10; n++) room = joinRoom(room, { uid: 'p' + n, displayName: 'Player ' + n });
  assert.equal(joinRoom(room, host), room);
  assert.throws(() => joinRoom(room, friend), /full/);
  const full = startRoom(room, host.uid),
    g = JSON.parse(full.room.payload);
  assert.equal(full.room.memberIds.length, 10);
  assert.equal(g.countries.length, 10);
  assert.equal(new Set(g.countries.map((c) => c.code)).size, 10);
  assert.ok(g.playerNames.every((name) => !name.startsWith('Bot ')));
  const partial = startRoom(lobby(), host.uid),
    partialGame = JSON.parse(partial.room.payload);
  assert.equal(partialGame.playerNames.filter((name) => name.startsWith('Bot ')).length, 8);
  assert.equal(partialGame.playerNames[1], 'Friend');
  assert.equal(partialGame.mode, 'multiplayer');
});

// Host-only start and fixed membership protect an in-progress match from late joins or duplicate
// starts.
test('only the host starts a lobby and already-started rooms admit only existing players', () => {
  assert.throws(() => startRoom(lobby(), friend.uid), /host/);
  const room = started();
  assert.equal(joinRoom(room, friend), room);
  assert.throws(() => joinRoom(room, { uid: 'stranger' }), /already started/);
  assert.throws(() => startRoom(room, host.uid), /already started/);
});

// Leaving must preserve other members, and a closed lobby must never accept new arrivals.
test('leaving a lobby removes only that player; host closure prevents further joining', () => {
  const room = leaveRoom(lobby(), friend.uid);
  assert.deepEqual(room.memberIds, ['host']);
  assert.equal(room.members.friend, undefined);
  const closed = leaveRoom(lobby(), host.uid);
  assert.equal(closed.status, 'closed');
  assert.throws(() => joinRoom(closed, friend), /closed/);
  assert.throws(() => leaveRoom(started(), friend.uid), /keep your seat/);
});

// Revision and actor checks must prevent stale clicks or human attempts to impersonate automated
// bot moves.
test('stale, out-of-turn and bot-impersonation moves cannot modify the shared game', () => {
  const room = started(1),
    original = JSON.stringify(room);
  assert.throws(() => moveRoom(room, 'host', room.revision, 'end'), /Wait/);
  assert.throws(() => moveRoom(room, 'friend', room.revision - 1, 'end'), /changed/);
  assert.throws(() => moveRoom(room, 'friend', room.revision, 'bot'), /Unknown/);
  assert.equal(JSON.stringify(room), original);
  const bots = started(2);
  assert.throws(() => moveRoom(bots, 'host', bots.revision, 'roll'), /host controls/);
  const result = moveRoom(bots, 'host', bots.revision, 'bot');
  assert.equal(result.room.revision, bots.revision + 1);
  assert.ok(result.events.length > 0);
});

// Multiplayer actions must use the friend's seat, not accidentally apply the single-player host
// perspective.
test('a friend can reinforce and attack using their own country rather than host seat zero', () => {
  let room = started(1);
  const game = JSON.parse(room.payload);
  game.budget = 2;
  room = { ...room, payload: JSON.stringify(game) };
  const own = game.countries.find((c) => c.owner === 1),
    enemy = game.countries.find((c) => c.owner !== 1);
  let result = moveRoom(room, 'friend', room.revision, 'reinforce', {
    allocations: { [own.code]: 2 },
  });
  room = result.room;
  assert.equal(
    JSON.parse(room.payload).countries.find((c) => c.code === own.code).army,
    own.army + 2,
  );
  result = moveRoom(room, 'friend', room.revision, 'attack', { from: own.code, to: enemy.code });
  assert.equal(JSON.parse(result.room.payload).battle.from, own.code);
  assert.equal(result.events[0].player, 1);
  assert.throws(
    () => moveRoom(room, 'friend', room.revision, 'attack', { from: enemy.code, to: own.code }),
    /owned country/,
  );
});

// Friends negotiate as their own seat; room transactions still reject human targets and stale actors.
test('multiplayer NPC pacts preserve room permissions and normal betrayal attacks', () => {
  let room = started(1);
  const game = readRoomGame(room);
  const owners = [1, 1, 2, 2, 3, 3, 3, 3, 0, 4];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    country.army = 10;
  });
  room = roomRecord({ ...room, payload: JSON.stringify(game) });
  const source = JSON.stringify(room);
  assert.throws(() => moveRoom(room, 'host', room.revision, 'alliance', { target: 2 }), /Wait/);
  assert.throws(
    () => moveRoom(room, 'friend', room.revision - 1, 'alliance', { target: 2 }),
    /changed/,
  );
  assert.throws(() => moveRoom(room, 'friend', room.revision, 'alliance', { target: 0 }), /NPC/);
  assert.equal(JSON.stringify(room), source);
  const accepted = moveRoom(room, 'friend', room.revision, 'alliance', { target: 2 });
  const allied = readRoomGame(accepted.room);
  assert.equal(allianceFor(allied, 1).ally, 2);
  assert.equal(allianceFor(allied, 0), null);
  assert.deepEqual(allied.countries, game.countries);
  assert.equal(allied.attackUsed, false);
  assert.equal(accepted.room.controllerUid, 'friend');
  assert.equal(accepted.events[0].diplomacy.action, 'accepted');
  const betrayed = moveRoom(accepted.room, 'friend', accepted.room.revision, 'attack', {
    from: game.countries[0].code,
    to: game.countries[2].code,
  });
  const after = readRoomGame(betrayed.room);
  assert.equal(allianceFor(after, 1), null);
  assert.ok(trustFor(after, 2, 1) < trustFor(allied, 2, 1));
  assert.equal(after.attackUsed, true);
  assert.equal(after.battle.to, game.countries[2].code);
  assert.deepEqual(after.countries, game.countries);
});

// The reading pause must publish a persisted intent before any troop movement or dice result is
// committed.
test(
  'bot plans leave troops and dice unchanged until a separate move, including' +
    ' after a room reload',
  () => {
    let room = started(2);
    const game = readRoomGame(room);
    game.round = 2;
    game.budget = 4;
    for (const country of game.countries) country.army = 2;
    game.countries[2].army = 20;
    game.countries[3].owner = 2;
    game.countries[3].army = 1;
    // Exercise the persisted plan when appending a decision trims older history.
    game.events = Array.from({ length: 80 }, (_, i) => ({ ...game.events[0], id: 'old-' + i }));
    room = roomRecord({ ...room, payload: JSON.stringify(game) });
    const announcedActions = new Set();
    for (let step = 0; step < 10; step++) {
      const before = readRoomGame(room);
      const announced = moveRoom(room, 'host', room.revision, 'bot');
      assert.equal(announced.events.length, 1);
      const decision = announced.events[0];
      assert.equal(decision.type, 'decision');
      const waiting = readRoomGame(announced.room);
      assert.deepEqual(waiting.countries, before.countries);
      assert.deepEqual(waiting.battle, before.battle);
      assert.equal(waiting.budget, before.budget);
      assert.equal(waiting.events.length, 80);
      announcedActions.add(decision.intent.action);

      room = JSON.parse(JSON.stringify(roomRecord(announced.room)));
      assert.deepEqual(readRoomGame(room).events.at(-1).intent, decision.intent);
      const acted = moveRoom(room, 'host', room.revision, 'bot');
      assert.equal(
        acted.events[0].type,
        decision.intent.action === 'roll' ? 'dice' : decision.intent.action,
      );
      if (decision.intent.action === 'attack') {
        assert.equal(readRoomGame(acted.room).battle.from, decision.intent.values.from);
        assert.equal(readRoomGame(acted.room).battle.to, decision.intent.values.to);
      }
      room = acted.room;
      if (decision.intent.action === 'roll') break;
    }
    assert.deepEqual(announcedActions, new Set(['reinforce', 'transfer', 'attack', 'roll']));
  },
);

// A retreat announcement must leave time to read before the following move actually ends the
// battle.
test('bots announce a retreat without ending the battle or changing turns until the next move', () => {
  const room = started(2),
    game = readRoomGame(room);
  game.countries[2].army = 20;
  new GameEngine(game).startAttack(game.countries[2].code, game.countries[3].code);
  game.battle.phase = 30;
  const announced = moveRoom(
    { ...room, payload: JSON.stringify(game) },
    'host',
    room.revision,
    'bot',
  );
  assert.equal(announced.events.at(-1).intent.action, 'retreat');
  assert.equal(readRoomGame(announced.room).battle.phase, 30);
  assert.equal(announced.room.currentSeat, 2);
  const acted = moveRoom(announced.room, 'host', announced.room.revision, 'bot');
  assert.equal(acted.events[0].type, 'retreat');
  assert.equal(readRoomGame(acted.room).battle, null);
  assert.notEqual(acted.room.currentSeat, 2);
});

// A defeated host must remain able to coordinate bots while surviving friends continue their match.
test('host elimination does not end a multiplayer match with other surviving friends', () => {
  const room = started(1),
    game = JSON.parse(room.payload);
  for (const country of game.countries) if (country.owner === 0) country.owner = 1;
  const result = moveRoom(
    { ...room, payload: JSON.stringify(game) },
    'friend',
    room.revision,
    'end',
  );
  assert.equal(result.room.status, 'playing');
  assert.equal(JSON.parse(result.room.payload).status, 'active');
});

// Bounded room snapshots must not lose the total event sequence needed for new immutable event
// writes.
test('event history in the room stays bounded while total sequence advances', () => {
  const room = started(1),
    game = JSON.parse(room.payload),
    event = game.events[0];
  game.events = Array.from({ length: 80 }, (_, i) => ({ ...event, id: 'old-' + i }));
  const source = { ...room, payload: JSON.stringify(game), eventCount: 100 };
  const result = moveRoom(source, 'friend', source.revision, 'end');
  assert.equal(JSON.parse(result.room.payload).events.length, 80);
  assert.equal(result.room.eventCount, 101);
  assert.equal(result.events.length, 1);
});

// Room-supplied presentation metadata must not override trusted country names, flags or
// coordinates.
test('shared country flags, names and geometry come from the local catalogue', () => {
  const room = started(),
    g = JSON.parse(room.payload);
  g.countries[0].flag = '<img src=x onerror=alert(1)>';
  g.countries[0].name = 'Fake country';
  g.countries[0].lon = 'bad coordinates';
  const safe = readRoomGame({ ...room, payload: JSON.stringify(g) });
  assert.equal(safe.countries[0].name, 'South Africa');
  assert.equal(safe.countries[0].lon, 25);
  assert.ok(!safe.countries[0].flag.includes('<'));
});

// Malformed armies or mismatched controller state must fail before shared game data reaches the
// view.
test('malformed shared armies and controller/board mismatches are rejected before display', () => {
  const room = started(),
    g = JSON.parse(room.payload);
  g.countries[0].army = '<img src=x onerror=alert(1)>';
  assert.throws(() => readRoomGame({ ...room, payload: JSON.stringify(g) }), /invalid game/);
  assert.throws(() => readRoomGame({ ...room, currentSeat: 9 }), /invalid game/);
});
