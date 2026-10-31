import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { GameEngine } from '../../dist/engine.js';
import { campaignRecord, eventRecord } from '../../dist/game-schema.js';
import {
  newRoom,
  roomRecord,
  joinRoom,
  startRoom,
  moveRoom,
  readRoomGame,
} from '../../dist/rooms.js';

let env;
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
beforeEach(async () => env.clearFirestore());
after(async () => env?.cleanup());
const db = (uid) =>
  uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const host = { uid: 'host', displayName: 'Mo' },
  friend = { uid: 'friend', displayName: 'Friend' };

test('campaigns stay private, legacy saves remain readable and new structured boards reject malformed values', async () => {
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
});

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
  return batch.commit();
}

test('friends join, host starts, bots advance and room records cannot downgrade or change saved starting values', async () => {
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
});

test('population-updater credentials cannot read private games or enter rooms', async () => {
  const updater = env.authenticatedContext('updater', { populationUpdater: true }).firestore();
  await assertFails(getDoc(doc(updater, 'users/owner/games/private')));
  await assertFails(
    setDoc(doc(updater, 'rooms/ABC234'), roomRecord(newRoom('ABC234', { uid: 'updater' }))),
  );
  await assertSucceeds(getDoc(doc(db(), 'publicData/populations')));
});

test('a complete attack, capture, transfer and extended bot playback remain valid atomic transactions', async () => {
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
  assert.ok(room.eventCount > 35, 'The rules accepted batches containing multiple factual events');
});
