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
import { newRoom, startRoom, readRoomGame, roomRecord, moveRoom } from '../dist/rooms.js';

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

test('typed rooms reload and advance, ignore hostile legacy labels and keep their original population values', () => {
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
});
