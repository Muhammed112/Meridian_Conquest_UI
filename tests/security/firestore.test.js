import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import { spectatorPayload } from '../../dist/spectators.js';
import { GameEngine, BattleEngine } from '../../dist/engine.js';
import { catalogue } from '../../dist/data.js';
import { campaignRecord, eventRecord } from '../../dist/game-schema.js';
import {
  newRoom as createRoom,
  roomRecord,
  joinRoom,
  startRoom,
  moveRoom,
  readRoomGame,
  chooseRoomCountry,
  prepareRoomRolls,
  rollRoomInitiative,
  rerollRoomInitiative,
} from '../../dist/rooms.js';
import { legacyRoom as newRoom } from '../helpers/rooms.js';

let env;
// Refuse any other endpoint: adversarial writes must never reach a real project.
before(async () => {
  assert.equal(
    process.env.FIRESTORE_EMULATOR_HOST,
    '127.0.0.1:8180',
    'Security tests must only use the dedicated local emulator',
  );
  env = await initializeTestEnvironment({
    projectId: 'demo-meridian',
    firestore: { host: '127.0.0.1', port: 8180, rules: await readFile('firestore.rules', 'utf8') },
  });
});

// A clean database prevents permission results from depending on another scenario's documents.
beforeEach(async () => env.clearFirestore());
after(async () => env?.cleanup());
// Give each actor its own rule-evaluated client; assertions never use an admin client.
const db = (uid) =>
  uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
/** Keep setup failures attributable to the exact actor, revision and dice round. */
function writeSetupRecord(uid, path, value) {
  return setDoc(doc(db(uid), path), value).catch((error) => {
    error.message +=
      ` [actor=${uid}, status=${value.status}, revision=${value.revision}, ` +
      `round=${value.initiative?.round}, winner=${value.initiative?.winner}]`;
    throw error;
  });
}
const host = { uid: 'host', displayName: 'Mo' },
  friend = { uid: 'friend', displayName: 'Friend' };

// Diplomacy uses normal immutable decisions; current rules must accept it without new write powers.
test('NPC alliance decisions and betrayals persist with the existing room permissions', async () => {
  let room = startRoom(joinRoom(newRoom('DFG456', host), friend), host.uid).room;
  const game = readRoomGame(room);
  Object.assign(game, {
    position: game.order.indexOf(0),
    round: 1,
    budget: 0,
    turnStarted: true,
    attackUsed: false,
    events: [],
  });
  const owners = [0, 0, 2, 2, 3, 3, 3, 3, 1, 4];
  game.countries.forEach((country, index) => {
    country.owner = owners[index];
    country.army = 10;
  });
  new GameEngine(game).event('turn', 'Mo begins the turn.');
  room = roomRecord({
    ...room,
    currentSeat: 0,
    controllerUid: host.uid,
    payload: JSON.stringify(game),
    eventCount: game.events.length,
  });
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), 'rooms/DFG456'), room),
  );
  const accepted = moveRoom(room, host.uid, room.revision, 'alliance', { target: 2 });
  await assertFails(persistRoom(room, accepted, friend.uid));
  await assertSucceeds(persistRoom(room, accepted, host.uid));
  room = roomRecord(accepted.room);
  const betrayed = moveRoom(room, host.uid, room.revision, 'attack', {
    from: game.countries[0].code,
    to: game.countries[2].code,
  });
  await assertSucceeds(persistRoom(room, betrayed, host.uid));
  assert.equal(betrayed.events[0].diplomacy.action, 'betrayed');
  assert.equal(readRoomGame(betrayed.room).attackUsed, true);
  assert.deepEqual(readRoomGame(betrayed.room).countries, game.countries);
});

// Database rules must enforce each member's own country and die choices even for bypassed UI
// requests.
test('new lobbies reserve unique countries and require each member to roll their own opening die', async () => {
  const path = 'rooms/CDE456';
  const put = (uid, value) => writeSetupRecord(uid, path, value);
  let room = roomRecord(createRoom('CDE456', host));
  await assertSucceeds(put(host.uid, room));
  room = joinRoom(room, friend);
  await assertSucceeds(put(friend.uid, room));
  room = chooseRoomCountry(room, host.uid, 'ZA');
  await assertSucceeds(put(host.uid, room));
  const friendChoice = chooseRoomCountry(room, friend.uid, 'JP');
  await assertFails(
    put(friend.uid, { ...friendChoice, countryChoices: { host: 'ZA', friend: 'ZA' } }),
  );
  await assertFails(
    put(friend.uid, { ...friendChoice, countryChoices: { host: 'BR', friend: 'JP' } }),
  );
  await assertSucceeds(put(friend.uid, friendChoice));
  room = friendChoice;
  const opening = prepareRoomRolls(room, host.uid, () => 1);
  await assertFails(put(friend.uid, opening));
  await assertSucceeds(put(host.uid, opening));
  room = opening;
  const rolled = rollRoomInitiative(room, host.uid, 2);
  await assertFails(put(friend.uid, rolled));
  await assertSucceeds(put(host.uid, rolled));
  const replay = structuredClone(rolled);
  replay.revision++;
  replay.initiative.rolls.host = 5;
  await assertFails(put(host.uid, replay));
  room = rollRoomInitiative(rolled, friend.uid, 6);
  await assertSucceeds(put(friend.uid, room));
  const started = startRoom(room, host.uid);
  await assertSucceeds(put(host.uid, roomRecord(started.room)));
  const game = readRoomGame(started.room);
  assert.equal(game.countries[1].code, 'JP');
  assert.equal(started.room.currentSeat, 1);
  const mutation = structuredClone(roomRecord(started.room));
  mutation.revision++;
  mutation.countryChoices.friend = 'BR';
  await assertFails(put(friend.uid, mutation));
});

// A host may coordinate a tie-break but must not edit non-contenders or claim an unearned opening
// winner.
test('opening ties can reset only the tied leaders and cannot fabricate a winner', async () => {
  // Seed a valid rolling state outside rules; every tested mutation below still uses actor
  // permissions.
  const path = 'rooms/DEF567';
  const put = (uid, value) => writeSetupRecord(uid, path, value);
  let room = joinRoom(createRoom('DEF567', host), friend);
  room = chooseRoomCountry(room, host.uid, 'ZA');
  room = chooseRoomCountry(room, friend.uid, 'JP');
  room = roomRecord(prepareRoomRolls(room, host.uid, () => 1));
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), path), room),
  );
  room = rollRoomInitiative(room, host.uid, 6);
  await assertSucceeds(put(host.uid, room));
  room = rollRoomInitiative(room, friend.uid, 6);
  const forged = structuredClone(room);
  forged.initiative.winner = host.uid;
  await assertFails(put(friend.uid, forged));
  await assertSucceeds(put(friend.uid, room));
  const reroll = rerollRoomInitiative(room, host.uid, () => 1);
  await assertFails(put(friend.uid, reroll));
  const changedBot = structuredClone(reroll);
  changedBot.initiative.rolls['bot:2'] = 6;
  await assertFails(put(host.uid, changedBot));
  await assertSucceeds(put(host.uid, reroll));
  room = rollRoomInitiative(reroll, host.uid, 2);
  await assertSucceeds(put(host.uid, room));
  room = rollRoomInitiative(room, friend.uid, 5);
  await assertSucceeds(put(friend.uid, room));
  await assertSucceeds(put(host.uid, roomRecord(startRoom(room, host.uid).room)));
});

// Worst-case human lobbies must remain playable without exhausting Firestore's rule evaluation
// budget.
test('ten human seats can all choose, roll, tie-break and start within the rule budget', async () => {
  let room = createRoom('EFG678', host);
  for (let seat = 1; seat < 10; seat++) room = joinRoom(room, { uid: 'seat' + seat });
  for (const [seat, id] of room.memberIds.entries())
    room = chooseRoomCountry(room, id, catalogue[seat].code);
  room = roomRecord(room);
  const target = 'rooms/EFG678';
  const put = (uid, value) => writeSetupRecord(uid, target, value);
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), target), room),
  );
  room = prepareRoomRolls(room, host.uid);
  await assertSucceeds(put(host.uid, room));
  for (const id of room.memberIds) {
    room = rollRoomInitiative(room, id, 6);
    await assertSucceeds(put(id, room));
  }
  room = rerollRoomInitiative(room, host.uid);
  await assertSucceeds(put(host.uid, room));
  for (const id of room.memberIds) {
    room = rollRoomInitiative(room, id, id === 'seat9' ? 6 : 1);
    await assertSucceeds(put(id, room));
  }
  await assertSucceeds(persistRoom(room, startRoom(room, host.uid)));
});

// A public viewing link must grant no private access or write rights, and revocation must keep the
// save.
test('live links allow public viewing while only the campaign owner can publish or revoke them', async () => {
  const game = GameEngine.create('Opt-in live game', 'ZA', true),
    owner = db('owner');
  const privatePath = `users/owner/games/${game.id}`,
    path = `liveGames/${game.id}`;
  const share = {
    version: 1,
    ownerUid: 'owner',
    gameId: game.id,
    payload: spectatorPayload(game),
    updatedAt: serverTimestamp(),
  };
  await assertFails(setDoc(doc(owner, path), share));
  await assertSucceeds(setDoc(doc(owner, privatePath), campaignRecord(game)));
  await assertFails(setDoc(doc(db(), path), share));
  await assertFails(setDoc(doc(db('stranger'), path), share));
  await assertSucceeds(setDoc(doc(owner, path), share));
  await assertSucceeds(getDoc(doc(db(), path)));
  await assertSucceeds(getDoc(doc(db('stranger'), path)));
  await assertFails(getDoc(doc(db(), privatePath)));
  await assertFails(getDocs(collection(db(), 'liveGames')));
  await assertFails(getDocs(collection(db('stranger'), 'liveGames')));
  assert.equal(
    (
      await assertSucceeds(
        getDocs(query(collection(owner, 'liveGames'), where('ownerUid', '==', 'owner'))),
      )
    ).size,
    1,
  );
  for (const visitor of [db(), db('stranger')]) {
    await assertFails(updateDoc(doc(visitor, path), { payload: '{}' }));
    await assertFails(deleteDoc(doc(visitor, path)));
    await assertFails(setDoc(doc(visitor, privatePath), campaignRecord(game)));
    await assertFails(setDoc(doc(visitor, privatePath + '/events/forged'), { payload: '{}' }));
  }
  await assertFails(updateDoc(doc(owner, path), { ownerUid: 'stranger' }));
  await assertFails(updateDoc(doc(owner, path), { gameId: 'another-game' }));
  await assertFails(updateDoc(doc(owner, path), { payload: 'x'.repeat(500001) }));
  await assertSucceeds(setDoc(doc(owner, path), share));
  await assertSucceeds(deleteDoc(doc(owner, path)));
  assert.equal((await assertSucceeds(getDoc(doc(db(), path)))).exists(), false);
  assert.equal((await getDoc(doc(owner, privatePath))).data().name, game.name);
});

/** Publish through owner permissions so presence tests exercise the real sharing prerequisite. */
async function publishPresenceGame() {
  const game = GameEngine.create('Live presence', 'ZA', true);
  const owner = db('owner');
  const privatePath = `users/owner/games/${game.id}`;
  const path = `liveGames/${game.id}`;
  await assertSucceeds(setDoc(doc(owner, privatePath), campaignRecord(game)));
  await assertSucceeds(
    setDoc(doc(owner, path), {
      version: 1,
      ownerUid: 'owner',
      gameId: game.id,
      payload: spectatorPayload(game),
      updatedAt: serverTimestamp(),
    }),
  );
  return { owner, path, privatePath };
}

// Visitors need live connection state, but only the owner may announce a tab arriving or leaving.
test('live presence is publicly readable only while shared and only the owner can update it', async () => {
  const { owner, path, privatePath } = await publishPresenceGame();
  const presencePath = path + '/presence';
  const sessionPath = presencePath + '/tab-one';
  const session = doc(owner, sessionPath);
  const record = { ownerUid: 'owner', online: true, updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(session, record));
  await assertSucceeds(setDoc(doc(owner, presencePath + '/tab-two'), record));
  for (const viewer of [db(), db('stranger')]) {
    assert.equal((await assertSucceeds(getDoc(doc(viewer, sessionPath)))).data().online, true);
    assert.equal((await assertSucceeds(getDocs(collection(viewer, presencePath)))).size, 2);
    await assertFails(getDoc(doc(viewer, privatePath)));
    await assertFails(setDoc(doc(viewer, presencePath + '/forged'), record));
    await assertFails(
      updateDoc(doc(viewer, sessionPath), { online: false, updatedAt: serverTimestamp() }),
    );
    await assertFails(deleteDoc(doc(viewer, sessionPath)));
  }
  await assertFails(
    setDoc(doc(db('stranger'), presencePath + '/stranger'), { ...record, ownerUid: 'stranger' }),
  );
  await assertSucceeds(updateDoc(session, { online: false, updatedAt: serverTimestamp() }));
  assert.equal((await getDoc(doc(db(), sessionPath))).data().online, false);
  await assertSucceeds(updateDoc(session, { online: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(owner, presencePath + '/tab-two')));
  await assertSucceeds(deleteDoc(doc(owner, path)));
  for (const viewer of [db(), db('stranger'), owner]) {
    await assertFails(getDoc(doc(viewer, sessionPath)));
    await assertFails(getDocs(collection(viewer, presencePath)));
  }
  await assertFails(updateDoc(session, { online: false, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(session));
  assert.equal((await assertSucceeds(getDoc(doc(owner, privatePath)))).exists(), true);
});

// Heartbeats carry connection state only: fabricated timestamps and extra payload must be rejected.
test('presence rejects unshared campaigns, invalid sessions and malformed heartbeat records', async () => {
  const { owner, path } = await publishPresenceGame();
  const record = { ownerUid: 'owner', online: true, updatedAt: serverTimestamp() };
  const session = doc(owner, path + '/presence/tab-one');
  const unshared = GameEngine.create('Unshared campaign', 'ZA', true);
  await assertSucceeds(
    setDoc(doc(owner, `users/owner/games/${unshared.id}`), campaignRecord(unshared)),
  );
  const unsharedSession = `liveGames/${unshared.id}/presence/tab-one`;
  await assertFails(setDoc(doc(owner, unsharedSession), record));
  await assertFails(getDoc(doc(db(), unsharedSession)));
  await assertFails(getDocs(collection(db(), `liveGames/${unshared.id}/presence`)));
  for (const invalidId of ['invalid.id', 'x'.repeat(61)]) {
    await assertFails(setDoc(doc(owner, path + '/presence/' + invalidId), record));
  }
  const invalidRecords = [
    { ...record, ownerUid: 'stranger' },
    { ...record, online: 'true' },
    { ...record, updatedAt: new Date(0) },
    { ...record, extra: 'unrelated data' },
    { ownerUid: 'owner', updatedAt: serverTimestamp() },
  ];
  for (const invalid of invalidRecords) await assertFails(setDoc(session, invalid));
  await assertSucceeds(setDoc(session, record));
  for (const invalid of invalidRecords) await assertFails(setDoc(session, invalid));
  assert.equal((await getDoc(session)).data().online, true);
});

// Tighter move validation must still permit widely split legal funding and a legitimate final
// conquest.
test('split reinforcement across nine countries and the winning conquest remain valid', async () => {
  let room = startRoom(newRoom('GHJ234', host), host.uid).room;
  const game = readRoomGame(room);
  Object.assign(game, {
    order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    position: 0,
    round: 2,
    turnStarted: false,
    events: [],
  });
  game.countries.forEach((country, index) => {
    country.owner = index < 9 ? 0 : 1;
    country.army = index < 9 ? 10 : 2;
  });
  new GameEngine(game).beginTurn();
  room = roomRecord({
    ...room,
    currentSeat: 0,
    controllerUid: host.uid,
    payload: JSON.stringify(game),
    eventCount: game.events.length,
  });
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), 'rooms/GHJ234'), room),
  );
  const advance = async (action, values) => {
    const result = moveRoom(room, host.uid, room.revision, action, values);
    await assertSucceeds(persistRoom(room, result, host.uid));
    room = roomRecord(result.room);
  };
  await advance('reinforce', {
    allocations: Object.fromEntries(game.countries.slice(0, 9).map(({ code }) => [code, 2])),
  });
  await advance('attack', { from: game.countries[0].code, to: game.countries[9].code });
  const resolve = BattleEngine.resolve;
  try {
    BattleEngine.resolve = (attacker, defender) => {
      let index = 0;
      return resolve(attacker, defender, () => (++index % 2 ? 6 : 1));
    };
    await advance('roll');
  } finally {
    BattleEngine.resolve = resolve;
  }
  assert.equal(room.status, 'finished');
  assert.equal(room.winnerSeat, 0);
});

// Stored campaigns must remain owner-only while compatible legacy records and valid upgrades still
// work.
test(
  'campaigns stay private, legacy saves remain readable and new structured' +
    ' boards reject malformed values',
  async () => {
    const game = GameEngine.create('Private campaign', 'ZA', true),
      owner = db('owner');
    const target = doc(owner, 'users/owner/games/' + game.id);
    await assertSucceeds(
      setDoc(target, { payload: JSON.stringify(game), updatedAt: game.updatedAt }),
    );
    assert.equal(JSON.parse((await getDoc(target)).data().payload).name, game.name);
    await assertSucceeds(setDoc(target, campaignRecord(game)));
    await assertFails(getDoc(doc(db('stranger'), target.path)));
    await assertFails(getDoc(doc(db(), target.path)));
    await assertFails(setDoc(doc(db('stranger'), target.path), campaignRecord(game)));
    const changed = campaignRecord(game);
    changed.board.countries[0].army = -1;
    await assertFails(setDoc(target, changed));
    const duplicate = campaignRecord(game);
    duplicate.board.countries[1].code = duplicate.board.countries[0].code;
    await assertFails(setDoc(target, duplicate));
    const forged = campaignRecord(game);
    forged.round++;
    await assertFails(setDoc(target, forged));
  },
);

// Once recorded, factual events must not be rewritten or polluted by generated narrative claims.
test('factual event records are immutable and cannot contain AI text or invalid country frames', async () => {
  const game = GameEngine.create('Events', 'ZA', true),
    owner = db('owner');
  const event = game.events[0],
    record = eventRecord(event, 0, game, { event });
  const target = doc(owner, `users/owner/games/${game.id}/events/${event.id}`);
  await assertSucceeds(setDoc(target, record));
  await assertFails(updateDoc(target, { sequence: 1 }));
  const forged = structuredClone(record);
  forged.event.id = 'forged';
  forged.event.commentary = 'Invented outcome';
  await assertFails(setDoc(doc(owner, `users/owner/games/${game.id}/events/forged`), forged));
});

// AI model upgrades must keep report ownership, immutability and the approved-model allowlist
// intact.
test('fast and existing Gemini reports stay private, immutable and limited to approved models', async () => {
  const game = GameEngine.create('Commentary models', 'ZA', true);
  const engine = new GameEngine(game);
  game.events = [];
  for (let index = 0; index < 3; index++) engine.event('decision', 'Recorded decision ' + index);
  const owner = db('owner');
  const campaignPath = 'users/owner/games/' + game.id;
  await assertSucceeds(setDoc(doc(owner, campaignPath), campaignRecord(game)));
  for (const [index, event] of game.events.entries())
    await assertSucceeds(
      setDoc(
        doc(owner, campaignPath + '/events/' + event.id),
        eventRecord(event, index, game, { event }),
      ),
    );
  const report = (event, model) => ({
    eventId: event.id,
    eventType: event.type,
    text: 'A brief observation about the recorded decision.',
    status: 'ready',
    source: 'gemini',
    model,
    narrationVersion: 2,
    authorUid: 'owner',
    createdAt: serverTimestamp(),
  });
  for (const [index, model] of ['gemini-3.6-flash', 'gemini-3.5-flash-lite'].entries()) {
    const event = game.events[index];
    const target = doc(owner, campaignPath + '/aiReportsV2/' + event.id);
    await assertSucceeds(setDoc(target, report(event, model)));
    assert.equal((await getDoc(target)).data().model, model);
    await assertFails(getDoc(doc(db('stranger'), target.path)));
    await assertFails(updateDoc(target, { text: 'An overwrite must be rejected.' }));
  }
  const event = game.events[2];
  const target = doc(owner, campaignPath + '/aiReportsV2/' + event.id);
  await assertFails(setDoc(target, report(event, 'unapproved-model')));
  await assertFails(
    setDoc(target, { ...report(event, 'gemini-3.5-flash-lite'), authorUid: 'stranger' }),
  );
});

/** Commit board and facts atomically, matching production writes and getAfter rule checks. */
async function persistRoom(room, result, uid = 'host') {
  const client = db(uid),
    batch = writeBatch(client),
    next = roomRecord(result.room);
  batch.set(doc(client, 'rooms/' + room.code), next);
  for (const [index, event] of result.events.entries())
    batch.set(
      doc(client, `rooms/${room.code}/events/${event.id}`),
      eventRecord(event, next.eventCount - result.events.length + index, readRoomGame(result.room)),
    );
  return batch.commit().catch((error) => {
    error.message +=
      ` [events=${result.events.map((event) => event.type).join(',')}, ` +
      `budget=${room.board?.budget}->${next.board?.budget}]`;
    throw error;
  });
}

// Legal room play must persist while stale revisions, schema downgrades and origin-data changes are
// denied.
test(
  'friends join, host starts, bots advance and room records cannot downgrade' +
    ' or change saved starting values',
  async () => {
    let room = roomRecord(newRoom('ABC234', host));
    await assertSucceeds(setDoc(doc(db('host'), 'rooms/ABC234'), room));
    room = joinRoom(room, friend);
    await assertSucceeds(setDoc(doc(db('friend'), 'rooms/ABC234'), room));
    await assertFails(
      setDoc(doc(db('friend'), 'rooms/ABC234'), roomRecord(startRoom(room, 'host').room)),
    );
    const started = startRoom(room, 'host');
    await assertSucceeds(persistRoom(room, started)).catch((cause) => {
      throw new Error('Host start was rejected', { cause });
    });
    room = roomRecord(started.room);
    const downgrade = { ...room, revision: room.revision + 1, eventCount: room.eventCount + 1 };
    delete downgrade.schemaVersion;
    delete downgrade.board;
    await assertFails(setDoc(doc(db(room.controllerUid), 'rooms/ABC234'), downgrade));
    const legacyWrite = {
      ...room,
      revision: room.revision + 1,
      eventCount: room.eventCount + 1,
      payload: room.payload + ' ',
    };
    await assertFails(setDoc(doc(db(room.controllerUid), 'rooms/ABC234'), legacyWrite));
    const forged = structuredClone(room);
    forged.revision++;
    forged.eventCount++;
    forged.board.origins[forged.board.countryCodes[0]].population++;
    await assertFails(setDoc(doc(db(room.controllerUid), 'rooms/ABC234'), forged));
    const game = readRoomGame(room),
      seat = game.order[game.position];
    const action = seat >= room.memberIds.length ? 'bot' : game.budget ? 'reinforce' : 'end';
    const allocations = game.budget
      ? { [game.countries.find((c) => c.owner === seat).code]: game.budget }
      : {};
    const moved = moveRoom(room, room.controllerUid, room.revision, action, { allocations });
    await assertSucceeds(persistRoom(room, moved, room.controllerUid)).catch((cause) => {
      throw new Error('Normal move was rejected', { cause });
    });
    await assertFails(persistRoom(room, moved, room.controllerUid));
  },
);

// The population updater's narrow role must not grant access to private progress or multiplayer
// membership.
test('population-updater credentials cannot read private games or enter rooms', async () => {
  const updater = env.authenticatedContext('updater', { populationUpdater: true }).firestore();
  await assertFails(getDoc(doc(updater, 'users/owner/games/private')));
  await assertFails(
    setDoc(doc(updater, 'rooms/ABC234'), roomRecord(newRoom('ABC234', { uid: 'updater' }))),
  );
  await assertSucceeds(getDoc(doc(db(), 'publicData/populations')));
});

// Database-level revisions must reject stale clients even if they bypass the application's conflict
// handling.
test('campaign revisions reject stale saves and downgrade writes while staged facts stay immutable', async () => {
  const game = GameEngine.create('Versioned save', 'ZA', true);
  const record = { ...campaignRecord(game), saveRevision: 1, historyHead: game.events.at(-1).id };
  const target = doc(db('owner'), `users/owner/games/${game.id}`);
  await assertSucceeds(setDoc(target, record));
  await assertSucceeds(setDoc(target, { ...record, saveRevision: 2 }));
  await assertFails(setDoc(target, { ...record, saveRevision: 2 }));
  await assertFails(setDoc(target, campaignRecord(game)));
  await assertFails(setDoc(target, { ...record, saveRevision: 3, historyHead: '<invalid>' }));
  const event = game.events[0];
  const eventTarget = doc(target, 'events', event.id);
  const facts = { ...eventRecord(event, 0, game, { event }), previousEventId: null };
  await assertSucceeds(setDoc(eventTarget, facts));
  await assertFails(setDoc(eventTarget, facts));
  await assertFails(
    setDoc(doc(target, 'events', 'invalid'), { ...facts, previousEventId: '<invalid>' }),
  );
});

// A permitted controller must not use an otherwise valid write to mint troops or forge turn and
// winner state.
test('room moves reject unbudgeted army changes, attack resets, ownership jumps and forged victory', async () => {
  const room = roomRecord(startRoom(newRoom('DEF234', host), 'host').room);
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), 'rooms/DEF234'), room),
  );
  const forge = async (change) => {
    const record = structuredClone(room);
    record.revision++;
    record.eventCount++;
    change(record);
    await assertFails(setDoc(doc(db(room.controllerUid), 'rooms/DEF234'), record));
  };
  await forge((record) => {
    record.board.countries[room.currentSeat].army += 100;
  });
  const enemy = room.board.countries.findIndex((country) => country.owner !== room.currentSeat);
  await forge((record) => {
    record.board.countries[enemy].army = 1;
  });
  await forge((record) => {
    record.board.countries[enemy].owner = room.currentSeat;
  });
  await forge((record) => {
    record.board.position = 1;
    record.board.round++;
    record.currentSeat = record.board.order[1];
    record.controllerUid = room.memberIds[record.currentSeat] || room.hostUid;
  });
  await forge((record) => {
    record.status = 'finished';
    record.winnerSeat = room.currentSeat;
    record.board.winner = room.currentSeat;
    record.board.status = 'finished';
  });
  room.board.attackUsed = true;
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), 'rooms/DEF234'), room),
  );
  await forge((record) => {
    record.board.attackUsed = false;
  });
});

// Conserving the global army is insufficient: owned moves must also respect funding and transfer
// boundaries.
test('owned moves cannot steal enemy troops, fund rivals or disguise transfers as reinforcements', async () => {
  let room = startRoom(newRoom('JKL234', host), host.uid).room;
  const game = readRoomGame(room);
  Object.assign(game, { position: 0, round: 2, turnStarted: false, battle: null, events: [] });
  const seat = game.order[0];
  game.countries.forEach((country, index) => {
    country.owner = index < 3 ? seat : (seat + 1) % 10;
    country.army = 10;
  });
  new GameEngine(game).beginTurn();
  room = roomRecord({
    ...room,
    currentSeat: seat,
    controllerUid: room.memberIds[seat] || room.hostUid,
    payload: JSON.stringify(game),
    eventCount: game.events.length,
  });
  const target = doc(db(room.controllerUid), 'rooms/JKL234');
  const seed = () =>
    env.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), target.path), room));
  const forge = async (change) => {
    const next = structuredClone(room);
    next.revision++;
    next.eventCount++;
    next.board.budget = 0;
    change(next.board.countries);
    await assertFails(setDoc(target, next));
  };
  await seed();
  await forge((countries) => {
    countries[3].army += game.budget;
  });
  await forge((countries) => {
    countries[0].army += game.budget + 1;
    countries[1].army--;
  });
  room.board.budget = 0;
  await seed();
  await forge((countries) => {
    countries[0].army++;
    countries[3].army--;
  });
  await forge((countries) => {
    countries[0].army++;
    countries[1].army++;
    countries[2].army -= 2;
  });
  await forge((countries) => {
    countries[0].army += 0.5;
    countries[1].army -= 0.5;
  });
});

// Stronger rules must accept normal funding, capture and follow-up actions rather than block real
// players.
test('normal multiplayer reinforcement, combat, conquest, transfers and bot funding satisfy move bounds', async () => {
  let lobby = joinRoom(createRoom('FGH234', host), friend);
  lobby = chooseRoomCountry(lobby, host.uid, 'ZA');
  lobby = chooseRoomCountry(lobby, friend.uid, 'JP');
  lobby = prepareRoomRolls(lobby, host.uid, () => 1);
  lobby = rollRoomInitiative(lobby, host.uid, 6);
  lobby = rollRoomInitiative(lobby, friend.uid, 1);
  let room = startRoom(lobby, host.uid).room;
  const game = readRoomGame(room);
  game.round = 2;
  game.turnStarted = false;
  game.countries[0].army = 10;
  game.countries[1].army = 2;
  new GameEngine(game).beginTurn();
  room = roomRecord({ ...room, payload: JSON.stringify(game), eventCount: game.events.length });
  await env.withSecurityRulesDisabled(async (context) =>
    setDoc(doc(context.firestore(), 'rooms/FGH234'), room),
  );
  const move = async (action, values) => {
    const result = moveRoom(room, room.controllerUid, room.revision, action, values);
    await assertSucceeds(persistRoom(room, result, room.controllerUid));
    room = roomRecord(result.room);
  };
  await move('reinforce', { allocations: { ZA: 2 } });
  await move('attack', { from: 'ZA', to: 'JP' });
  const resolve = BattleEngine.resolve;
  try {
    BattleEngine.resolve = (attacker, defender) => {
      let index = 0;
      return resolve(attacker, defender, () => (++index % 2 ? 6 : 1));
    };
    await move('roll');
  } finally {
    BattleEngine.resolve = resolve;
  }
  assert.equal(readRoomGame(room).countries[1].owner, 0);
  await move('transfer', { from: 'ZA', to: 'JP', amount: 2 });
  await move('end');
  await move('bot');
  await move('bot');
});

// Extended atomic playback guards against protections that pass one move but fail on later bot
// event batches.
test(
  'a complete attack, capture, transfer and extended bot playback remain valid' +
    ' atomic transactions',
  async () => {
    let room = startRoom(joinRoom(newRoom('BCD345', host), friend), host.uid).room;
    const game = readRoomGame(room);
    Object.assign(game, {
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      position: 0,
      round: 1,
      budget: 0,
      events: [],
      attackUsed: false,
      battle: null,
    });
    game.countries[0].army = 8;
    game.countries[1].army = 2;
    room = roomRecord({
      ...room,
      currentSeat: 0,
      controllerUid: host.uid,
      eventCount: 0,
      payload: JSON.stringify(game),
    });
    await env.withSecurityRulesDisabled(async (context) =>
      setDoc(doc(context.firestore(), 'rooms/BCD345'), room),
    );
    const advance = async (action, values = {}) => {
      const result = moveRoom(room, room.controllerUid, room.revision, action, values);
      await assertSucceeds(persistRoom(room, result, room.controllerUid));
      room = roomRecord(result.room);
    };
    await advance('attack', { from: game.countries[0].code, to: game.countries[1].code });
    const originalRandom = Math.random;
    let roll = 0;
    try {
      // Force capture and restore global randomness even if a rule assertion fails.
      Math.random = () => (++roll % 2 ? 0.99 : 0);
      await advance('roll');
      assert.equal(readRoomGame(room).countries[1].owner, 0);
      await advance('transfer', {
        from: game.countries[0].code,
        to: game.countries[1].code,
        amount: 2,
      });
      await advance('end');
      for (let index = 0; index < 35 && room.status === 'playing'; index++) {
        const current = readRoomGame(room),
          seat = current.order[current.position];
        if (seat >= room.memberIds.length) await advance('bot');
        else if (current.budget)
          await advance('reinforce', {
            allocations: { [current.countries.find((c) => c.owner === seat).code]: current.budget },
          });
        else await advance('end');
      }
    } finally {
      Math.random = originalRandom;
    }
    assert.ok(
      room.eventCount > 35,
      'The rules accepted batches containing multiple factual events',
    );
  },
);
