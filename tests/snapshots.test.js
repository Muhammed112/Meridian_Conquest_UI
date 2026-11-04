// Legacy shared URLs remain readable after switching the codec to UTF-8 byte APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { encodeSnapshot, decodeSnapshot } from '../dist/snapshots.js';
import { findCountry } from '../dist/data.js';

// Previously shared links must remain readable and preserve non-ASCII campaign names and player
// nicknames.
test('shared snapshots preserve Unicode and remain compatible with existing URL payloads', () => {
  const game = GameEngine.create('Mo’s campaign 🌍', 'ZA', true, 'medium', 'Zoë');
  const encoded = encodeSnapshot(game);
  // This is the previous percent-encoding format, retained only as a compatibility fixture.
  const legacyBytes = encodeURIComponent(JSON.stringify(game)).replace(
    /%([0-9A-F]{2})/g,
    (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const legacyLink = btoa(legacyBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(encoded, legacyLink);
  const restored = decodeSnapshot(legacyLink);
  assert.equal(restored.name, game.name);
  assert.deepEqual(restored.playerNames, game.playerNames);
  assert.deepEqual(restored.countries, game.countries);
  assert.equal(restored.events.length, game.events.length);
  assert.match(encoded, /^[\w-]+$/);
  for (const invalid of [null, 123, '', 'a'.repeat(180001), '%%%'])
    assert.throws(() => decodeSnapshot(invalid));
});

// A previously shared link must remain usable with consistent country references and original armies.
test('old snapshot country replacements preserve turn progress and replay references', () => {
  const game = GameEngine.create('Shared campaign', 'ZA', true);
  const originalCode = game.countries[0].code;
  game.countries[0] = { ...findCountry('IL'), owner: 0, army: 17 };
  game.start = 'IL';
  game.events.forEach((event) => {
    event.board.find((country) => country.code === originalCode).code = 'IL';
  });
  new GameEngine(game).event('transfer', 'Recorded troop movement.', {
    from: 'IL',
    to: game.countries[4].code,
    amount: 1,
  });
  const restored = decodeSnapshot(encodeSnapshot(game));
  const replacement = restored.countries[0].code;
  assert.notEqual(replacement, 'IL');
  assert.equal(restored.start, replacement);
  assert.equal(restored.countries[0].army, 17);
  assert.equal(restored.countries[0].owner, 0);
  assert.deepEqual(restored.order, game.order);
  assert.equal(restored.position, game.position);
  assert.equal(restored.round, game.round);
  assert.equal(restored.events.at(-1).from, replacement);
  assert.ok(restored.events.every((event) => event.board[0].code === replacement));
  assert.equal(new Set(restored.countries.map((country) => country.code)).size, 10);
  assert.equal(game.countries[0].code, 'IL', 'Decoding cannot mutate the original saved snapshot.');
});
