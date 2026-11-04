import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import {
  campaignRecord,
  readCampaignRecord,
  eventRecord,
  readEventRecord,
  validateGameBoard,
} from '../dist/game-schema.js';
import { startRoom, readRoomGame, roomRecord, moveRoom } from '../dist/rooms.js';
import { legacyRoom as newRoom } from './helpers/rooms.js';

// Save upgrades must preserve existing campaigns while keeping generated prose outside immutable
// event facts.
test('structured saves and old payload-only saves retain campaign identity, populations and history', () => {
  const game = GameEngine.create('Preserve my campaign', 'ZA', true, 'hard', 'Mo');
  const record = campaignRecord(game);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.name, game.name);
  assert.equal(record.round, game.round);
  assert.equal(record.board.events, undefined);
  assert.deepEqual(readCampaignRecord(record).countries, game.countries);
  assert.deepEqual(readCampaignRecord({ payload: JSON.stringify(game) }), game);
  assert.equal(game.events.length, 3, 'Encoding never removes original history');
  const event = { ...game.events[0], commentary: 'Narration', commentaryVersion: 2 };
  const encoded = eventRecord(event, 0, game, { event: game.events[0] });
  assert.equal(encoded.event.commentary, undefined);
  assert.deepEqual(readEventRecord(encoded), JSON.parse(encoded.payload));
  assert.deepEqual(readEventRecord({ payload: encoded.payload }), encoded.event);
});

// Untrusted storage must not restore impossible armies, turn state or dice results into the live
// engine.
test('invalid boards, unknown schemas, duplicate countries and impossible dice losses are rejected', () => {
  const game = GameEngine.create('Validation', 'ZA', true);
  for (const mutate of [
    (g) => {
      g.countries[0].army = -1;
    },
    (g) => {
      g.countries[1].code = g.countries[0].code;
    },
    (g) => {
      g.position = 10;
    },
    (g) => {
      g.budget = 21;
    },
    (g) => {
      g.order[1] = g.order[0];
    },
    (g) => {
      g.winner = 0;
    },
  ]) {
    const changed = structuredClone(game);
    mutate(changed);
    assert.throws(() => validateGameBoard(changed), /invalid saved data/);
  }
  assert.throws(() => readCampaignRecord({ schemaVersion: 99 }), /invalid saved data/);
  const dice = { ...game.events[0], type: 'dice', pairs: [{ a: 1, d: 6 }], attackerLoss: 0 };
  assert.throws(() => eventRecord(dice, 0, game), /invalid saved data/);
  assert.equal(game.countries[0].army, 9);
});

// Typed rooms must remain authoritative and preserve frozen country values across reload and legal
// moves.
test(
  'typed rooms reload and advance, ignore hostile legacy labels and keep their' +
    ' original population values',
  () => {
    const host = { uid: 'host', displayName: 'Mo' };
    const room = roomRecord(newRoom('ABC234', host));
    const started = startRoom(room, host.uid).room;
    const typed = roomRecord(started),
      original = readRoomGame(typed);
    typed.payload = JSON.stringify({ invalid: true });
    assert.deepEqual(readRoomGame(typed), original, 'Typed state is authoritative for new clients');
    const clean = roomRecord(started),
      game = readRoomGame(clean);
    const savedRoom = structuredClone(clean);
    const displayedGame = readRoomGame(clean);
    displayedGame.countries[0].army++;
    displayedGame.events[0].text = 'Local display change';
    assert.deepEqual(clean, savedRoom, 'Reading or presenting a room never mutates its saved data');
    if (game.order[game.position] !== 0) {
      const next = moveRoom(clean, host.uid, clean.revision, 'bot').room;
      assert.equal(next.revision, clean.revision + 1);
      assert.deepEqual(
        readRoomGame(next).countries.map((c) => c.population),
        game.countries.map((c) => c.population),
      );
    }
    clean.board.countries[0].army = 0;
    assert.throws(() => readRoomGame(clean), /invalid/);
  },
);

// Optional diplomacy lives in immutable history, so saves retain agreements without changing
// the board schema or requiring a migration of existing campaigns.
test('diplomacy event facts and bounded state round-trip while legacy events stay unchanged', () => {
  const game = GameEngine.create('Diplomatic history', 'ZA', true),
    codes = new Set(game.countries.map((country) => country.code)),
    legacy = structuredClone(game.events[0]);
  const event = {
    ...legacy,
    type: 'decision',
    diplomacy: {
      action: 'accepted',
      proposer: 0,
      target: 2,
      reason: 'A stronger shared rival threatens both commanders.',
      expiresRound: legacy.round + 3,
    },
    diplomacyState: {
      alliances: [{ players: [0, 2], startedRound: legacy.round, expiresRound: legacy.round + 3 }],
      trust: [{ observer: 2, other: 0, value: 60 }],
      lastOffers: [{ player: 0, round: legacy.round }],
    },
  };
  const original = structuredClone(event);
  for (const record of [eventRecord(event, 0, game), { payload: JSON.stringify(event) }])
    assert.deepEqual(readEventRecord(record, codes), original);
  assert.deepEqual(event, original, 'Encoding must never rewrite the recorded agreement');
  assert.deepEqual(readEventRecord(eventRecord(legacy, 0, game), codes), legacy);
  assert.equal(campaignRecord(game).board.diplomacyState, undefined);
});

// Malformed relationship data must fail at the same boundary as impossible armies and dice.
test('invalid diplomacy facts, repeated relationships and unbounded state are rejected', () => {
  const game = GameEngine.create('Invalid diplomacy', 'ZA', true),
    source = game.events[0],
    state = { alliances: [], trust: [], lastOffers: [] },
    fact = { action: 'declined', proposer: 0, target: 1, reason: 'No shared threat.' };
  for (const metadata of [
    { diplomacy: { ...fact, action: 'invented' } },
    { diplomacy: { ...fact, target: 0 } },
    { diplomacy: { ...fact, proposer: 10 } },
    { diplomacy: { ...fact, reason: 'x'.repeat(5000) } },
    { diplomacy: { ...fact, action: 'accepted', expiresRound: source.round + 4 } },
    { diplomacyState: { ...state, trust: [{ observer: 0, other: 1, value: 101 }] } },
    { diplomacyState: { ...state, lastOffers: [{ player: 0, round: -1 }] } },
    { diplomacyState: { ...state, lastOffers: [{ player: 0, round: source.round + 1 }] } },
    {
      diplomacyState: {
        ...state,
        alliances: [
          {
            players: [0, 1],
            startedRound: source.round + 1,
            expiresRound: source.round + 4,
          },
        ],
      },
    },
    {
      diplomacyState: {
        ...state,
        alliances: [
          { players: [0, 1], startedRound: 1, expiresRound: 4 },
          { players: [1, 2], startedRound: 1, expiresRound: 4 },
        ],
      },
    },
    {
      diplomacyState: {
        ...state,
        trust: [
          { observer: 0, other: 1, value: 50 },
          { observer: 0, other: 1, value: 60 },
        ],
      },
    },
  ])
    assert.throws(
      () => eventRecord({ ...source, type: 'decision', ...metadata }, 0, game),
      /invalid saved data/,
    );
  assert.throws(
    () => eventRecord({ ...source, type: 'attack', diplomacy: fact }, 0, game),
    /invalid saved data/,
    'Recorded diplomacy outcomes use decision events; combat facts keep their own types',
  );
});
