import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { armyValue, findCountry } from '../dist/data.js';
import {
  campaignRecord,
  eventRecord,
  readCampaignRecord,
  readEventRecord,
  encodeBoard,
} from '../dist/game-schema.js';
import {
  newRoom,
  chooseRoomCountry,
  prepareRoomRolls,
  rollRoomInitiative,
  startRoom,
  roomRecord,
  readRoomGame,
} from '../dist/rooms.js';
import { spectatorPayload } from '../dist/spectators.js';
import {
  planCampaign,
  planRoom,
  planLiveGame,
  countryRecordPlans,
  applyCountryRecordPlans,
} from '../scripts/sync-country-records.mjs';
import {
  encodeFields,
  decodeFields,
  createFirestoreRecords,
  writeBatches,
} from '../scripts/lib/firestore-records.mjs';

const root = 'projects/demo-meridian/databases/(default)/documents';
const document = (relative, data) => ({
  name: root + '/' + relative,
  fields: encodeFields(data),
  updateTime: '2026-11-04T10:00:00.000000Z',
});
const options = () => {
  let next = 0;
  return { now: 1900000000000, newEventId: () => 'synced-event-' + next++ };
};

/** Reproduce a genuine old board and events rather than weakening current selection rules. */
function existingGame(game = GameEngine.create('Operator fixture', 'ZA', true)) {
  const old = game.countries[1],
    country = findCountry('IL');
  game.countries[1] = {
    ...country,
    value: armyValue(country.population),
    owner: old.owner,
    army: old.army,
  };
  for (const event of game.events)
    event.board = event.board.map((row) => ({
      ...row,
      code: row.code === old.code ? 'IL' : row.code,
    }));
  return game;
}

/** Encode the exact original predecessor chain the operator must validate before replacing IDs. */
function historyDocuments(game, parent, { legacy = false } = {}) {
  return game.events.map((event, sequence) =>
    document(parent + '/events/' + event.id, {
      ...eventRecord(event, sequence, game),
      ...(legacy ? {} : { previousEventId: game.events[sequence - 1]?.id || null }),
    }),
  );
}

// The migration must preserve progress, leave old facts untouched, and commit the new history
// only under the exact board revision that was inspected.
test('private migration stages fresh history IDs and atomically patches only the inspected game', () => {
  const game = existingGame(),
    parent = 'users/owner/games/' + game.id,
    raw = { ...campaignRecord(game), saveRevision: 7, historyHead: game.events.at(-1).id },
    source = document(parent, { ...raw, preservedField: 'untouched' }),
    events = historyDocuments(game, parent),
    before = JSON.stringify({ source, events }),
    plan = planCampaign(source, events, options()),
    changes = decodeFields(plan.finalWrite.update.fields),
    migrated = readCampaignRecord(changes);
  assert.equal(JSON.stringify({ source, events }), before);
  assert.equal(migrated.id, game.id);
  assert.equal(
    migrated.countries.some((country) => country.code === 'IL'),
    false,
  );
  assert.deepEqual(
    migrated.countries.map(({ owner, army, value }) => ({ owner, army, value })),
    game.countries.map(({ owner, army, value }) => ({ owner, army, value })),
  );
  for (const key of ['position', 'round', 'budget', 'attackUsed', 'turnStarted', 'winner', 'order'])
    assert.deepEqual(migrated[key], game[key]);
  assert.equal(changes.saveRevision, 8);
  assert.equal(changes.historyHead, 'synced-event-' + (game.events.length - 1));
  assert.deepEqual(plan.finalWrite.currentDocument, { updateTime: source.updateTime });
  assert.equal(plan.finalWrite.updateMask.fieldPaths.includes('preservedField'), false);
  const codes = new Set(migrated.countries.map((country) => country.code));
  plan.stagedWrites.forEach((write, index) => {
    const record = decodeFields(write.update.fields),
      event = readEventRecord(record, codes);
    assert.equal(event.id, 'synced-event-' + index);
    assert.equal(
      game.events.some((old) => old.id === event.id),
      false,
    );
    assert.equal(record.previousEventId, index ? 'synced-event-' + (index - 1) : null);
    assert.deepEqual(write.currentDocument, { exists: false });
  });
});

// REST listing orders UUID names, whereas legacy event facts must retain their original sequence.
test('legacy history is sorted by sequence before creating a replacement predecessor chain', () => {
  const game = existingGame(),
    parent = 'users/owner/games/' + game.id;
  game.events.forEach((event, index) => {
    event.id = ['z-last-name', 'm-middle-name', 'a-first-name'][index];
  });
  const source = document(parent, { payload: JSON.stringify(game), updatedAt: game.updatedAt }),
    events = historyDocuments(game, parent, { legacy: true }).reverse(),
    plan = planCampaign(source, events, options());
  assert.deepEqual(
    plan.stagedWrites.map((write) => decodeFields(write.update.fields).event.type),
    game.events.map((event) => event.type),
  );
  assert.equal(decodeFields(plan.finalWrite.update.fields).saveRevision, 1);
});

// Country replacement must not reroll initiative or move a friend into a different seat.
test('playing and lobby rooms retain permissions, opening rolls and turn counters', () => {
  const host = { uid: 'host', displayName: 'Commander' };
  let room = chooseRoomCountry(newRoom('ABC234', host), host.uid, 'ZA');
  room = prepareRoomRolls(room, host.uid, () => 1);
  room = rollRoomInitiative(room, host.uid, 6);
  room = roomRecord(startRoom(room, host.uid).room);
  const game = existingGame(readRoomGame(room));
  room.initiative.countries[1] = 'IL';
  room.payload = JSON.stringify(game);
  room.board = encodeBoard(game);
  const source = document('rooms/ABC234', room),
    before = JSON.stringify(source),
    plan = planRoom(source, [], options()),
    changes = decodeFields(plan.finalWrite.update.fields),
    after = { ...room, ...changes };
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(
    readRoomGame(after).countries.map((country) => country.army),
    game.countries.map((country) => country.army),
  );
  assert.equal(after.initiative.countries.includes('IL'), false);
  assert.deepEqual(after.initiative.rolls, room.initiative.rolls);
  assert.equal(after.eventCount, room.eventCount);
  assert.equal(after.currentSeat, room.currentSeat);
  assert.equal(after.controllerUid, room.controllerUid);
  assert.equal(after.revision, room.revision + 1);
  assert.equal(plan.finalWrite.updateMask.fieldPaths.includes('members'), false);
  assert.equal(plan.finalWrite.updateMask.fieldPaths.includes('memberIds'), false);
  const lobby = newRoom('DEF234', host);
  lobby.countryChoices.host = 'IL';
  const lobbyPlan = planRoom(document('rooms/DEF234', lobby), [], options()),
    lobbyChanges = decodeFields(lobbyPlan.finalWrite.update.fields);
  assert.notEqual(lobbyChanges.countryChoices.host, 'IL');
  assert.equal(lobbyChanges.payload, undefined);
  assert.equal(lobbyPlan.stagedWrites.length, 0);
});

// The public reader already adapts old payloads; the operator must inspect raw codes so affected
// stored mirrors are still detected and their existing URLs/owners remain intact.
test('live mirror plans detect raw legacy payloads and patch payload and timestamp only', () => {
  const game = existingGame(),
    source = document('liveGames/' + game.id, {
      version: 1,
      ownerUid: 'owner',
      gameId: game.id,
      payload: spectatorPayload(game),
    }),
    before = JSON.stringify(source),
    plan = planLiveGame(source, options()),
    changes = decodeFields(plan.finalWrite.update.fields);
  assert.ok(plan);
  assert.equal(JSON.stringify(source), before);
  assert.equal(
    JSON.parse(changes.payload).countries.some((country) => country.code === 'IL'),
    false,
  );
  assert.deepEqual(plan.finalWrite.updateMask.fieldPaths, ['payload']);
  assert.deepEqual(plan.finalWrite.updateTransforms, [
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
});

// Inspection cannot write, export profiles or read unrelated event histories.
test('unaffected records produce no migration plans or event-subcollection reads', async () => {
  const game = GameEngine.create('Unchanged', 'ZA', true),
    calls = [],
    store = {
      games: async () => [document('users/owner/games/' + game.id, campaignRecord(game))],
      collection: async (name) => {
        calls.push(name);
        if (name === 'rooms') return [document('rooms/ABC234', newRoom('ABC234', { uid: 'host' }))];
        if (name === 'liveGames')
          return [document('liveGames/' + game.id, { payload: spectatorPayload(game) })];
        throw new Error('Unexpected collection read');
      },
    };
  const result = await countryRecordPlans(store, options());
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.counts, { campaigns: 1, rooms: 1, liveGames: 1 });
  assert.deepEqual(calls, ['rooms', 'liveGames']);
});

// Backup failure or a concurrent board change must stop application before it can replace facts.
test('application backs up before staging and stops at the first revision conflict', async () => {
  const game = existingGame(),
    parent = 'users/owner/games/' + game.id,
    plan = planCampaign(
      document(parent, campaignRecord(game)),
      historyDocuments(game, parent, { legacy: true }),
      options(),
    ),
    seen = [],
    store = { commit: async () => seen.push('write') };
  await assert.rejects(
    applyCountryRecordPlans([plan], store, async () => {
      throw new Error('Backup failed');
    }),
    /Backup failed/,
  );
  assert.deepEqual(seen, []);
  const conflicting = {
    commit: async (writes) => {
      seen.push(writes[0].currentDocument.exists === false ? 'stage' : 'commit');
      if (writes[0].currentDocument.updateTime) throw new Error('Revision conflict');
    },
  };
  await assert.rejects(
    applyCountryRecordPlans([plan, plan], conflicting, async () => seen.push('backup')),
    /Revision conflict/,
  );
  assert.deepEqual(seen, ['backup', 'stage', 'commit']);
});

// Firestore pages can exceed one response; stable cursors and restricted paths prevent omissions
// and stop a game-only operator from accidentally touching profile documents.
test('REST adapter pages game queries and collections while rejecting out-of-scope writes', async () => {
  const requests = [],
    page = Array.from({ length: 250 }, (_, index) => document('users/owner/games/g' + index, {}));
  const store = createFirestoreRecords({
    projectId: 'demo-meridian',
    token: 'private-token',
    fetcher: async (url, request) => {
      requests.push({ url, request });
      const body = request.body ? JSON.parse(request.body) : null;
      let result;
      if (body?.structuredQuery)
        result = body.structuredQuery.startAt
          ? [{ document: document('users/owner/games/last', {}) }]
          : page.map((document) => ({ document }));
      else if (new URL(url).searchParams.has('pageToken')) result = { documents: [] };
      else result = { documents: [document('rooms/ABC234', {})], nextPageToken: 'next-page' };
      return { ok: true, json: async () => result };
    },
  });
  assert.equal((await store.games()).length, 251);
  const secondQuery = JSON.parse(requests[1].request.body).structuredQuery;
  assert.equal(secondQuery.startAt.values[0].referenceValue, page.at(-1).name);
  assert.equal(secondQuery.startAt.before, false);
  assert.equal((await store.collection('rooms')).length, 1);
  assert.equal(new URL(requests.at(-1).url).searchParams.get('pageToken'), 'next-page');
  await assert.rejects(store.collection('users'), /outside/);
  await assert.rejects(store.commit([{ update: { name: root + '/users/owner' } }]), /outside/);
  assert.equal(requests.length, 4);
});

// Safe encoding and bounded commits must fail before an oversized or invalid event is uploaded.
test('field encoding round-trips optional game values and commit batches stay bounded', () => {
  const value = {
    integer: 7,
    decimal: 1.25,
    nested: { empty: null, bool: true, items: ['ZA', 3] },
    absent: undefined,
  };
  assert.deepEqual(decodeFields(encodeFields(value)), {
    integer: 7,
    decimal: 1.25,
    nested: value.nested,
  });
  assert.throws(() => encodeFields({ bad: NaN }), /Invalid/);
  const batches = writeBatches(Array.from({ length: 401 }, () => ({ update: { name: 'game' } })));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [400, 1],
  );
  assert.throws(() => writeBatches([{ data: 'x'.repeat(900001) }]), /safe document size/);
});
