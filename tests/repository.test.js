import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalGameRepository,
  GameEngine,
  CAMPAIGN_STORAGE_KEY,
  LEGACY_CAMPAIGN_STORAGE_KEY,
  mergeCampaigns,
} from '../dist/engine.js';
import { findCountry } from '../dist/data.js';

// Merging cloud headers with local recovery must retain the newest complete history without
// cross-game loss.
test('merging account campaigns keeps the freshest complete save and isolated local campaigns', () => {
  const remote = [
    { id: 'cloud-newer', updatedAt: 5, events: ['cloud event'] },
    { id: 'local-newer', updatedAt: 1 },
    { id: 'same-time', updatedAt: 3 },
  ];
  const cached = [
    { id: 'cloud-newer', updatedAt: 2 },
    { id: 'local-newer', updatedAt: 4, events: ['unsynced event'] },
    { id: 'same-time', updatedAt: 3, events: ['cached full history'] },
    { id: 'local-only', updatedAt: 1 },
  ];
  assert.deepEqual(mergeCampaigns(remote, cached), [remote[0], ...cached.slice(1)]);
  assert.deepEqual(mergeCampaigns(remote, null), remote);
  assert.equal(remote[1].events, undefined, 'Merging does not rewrite its inputs');
});

// Local save cleanup must target only the legacy campaign key and preserve profile and unrelated
// app data.
test('old campaign saves are removed, new campaigns survive reload, and profile data stays intact', () => {
  const previous = globalThis.localStorage;
  const storage = new Map([
    [LEGACY_CAMPAIGN_STORAGE_KEY, JSON.stringify([{ id: 'old-demo' }, { id: 'old-campaign' }])],
    ['meridian-ui-profile', '{"name":"Commander"}'],
    ['unrelated-app', 'keep'],
  ]);
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  try {
    const repository = new LocalGameRepository();
    assert.equal(repository.load(), null);
    assert.equal(storage.has(LEGACY_CAMPAIGN_STORAGE_KEY), false);
    const game = GameEngine.create('Fresh Extreme campaign', 'ZA', false, 'extreme');
    assert.equal(repository.save([game]), true);
    const loaded = new LocalGameRepository().load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, game.id);
    assert.equal(loaded[0].difficulty, 'extreme');
    assert.equal(storage.get('meridian-ui-profile'), '{"name":"Commander"}');
    assert.equal(storage.get('unrelated-app'), 'keep');
    assert.ok(storage.has(CAMPAIGN_STORAGE_KEY));
  } finally {
    globalThis.localStorage = previous;
  }
});

// Corrupt or blocked storage must degrade gracefully instead of preventing the application from
// starting.
test('unavailable or malformed browser storage does not prevent a clean start', () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => '{invalid', removeItem() {} };
    assert.equal(new LocalGameRepository().load(), null);
    globalThis.localStorage = {
      getItem() {
        throw new Error('Blocked');
      },
      removeItem() {
        throw new Error('Blocked');
      },
      setItem() {
        throw new Error('Blocked');
      },
    };
    assert.equal(new LocalGameRepository().load(), null);
    assert.equal(new LocalGameRepository().save([]), false);
  } finally {
    globalThis.localStorage = previous;
  }
});

// Reading an older cache must preserve progress without overwriting a newer cloud migration.
test('local campaign recovery replaces an unavailable country without rewriting browser storage', () => {
  const previous = globalThis.localStorage;
  const game = GameEngine.create('Cached campaign', 'ZA', true);
  const originalCode = game.countries[0].code;
  game.countries[0] = { ...findCountry('IL'), owner: 0, army: 17 };
  game.start = 'IL';
  game.events.forEach((event) => {
    event.board.find((country) => country.code === originalCode).code = 'IL';
  });
  const ordinary = GameEngine.create('Ordinary campaign', 'JP', true);
  const payload = JSON.stringify([game, ordinary]);
  const writes = [];
  globalThis.localStorage = {
    getItem: () => payload,
    setItem: (...entry) => writes.push(entry),
    removeItem() {},
  };
  try {
    const [restored, unchanged] = new LocalGameRepository().load();
    assert.notEqual(restored.countries[0].code, 'IL');
    assert.equal(restored.start, restored.countries[0].code);
    assert.equal(restored.countries[0].army, 17);
    assert.equal(restored.countries[0].owner, 0);
    assert.equal(restored.updatedAt, game.updatedAt);
    assert.equal(restored.id, game.id);
    assert.deepEqual(
      restored.events.map((event) => event.id),
      game.events.map((event) => event.id),
    );
    assert.deepEqual(unchanged, ordinary);
    assert.deepEqual(writes, []);
    assert.equal(globalThis.localStorage.getItem(CAMPAIGN_STORAGE_KEY), payload);
  } finally {
    globalThis.localStorage = previous;
  }
});

// One invalid saved population must not hide another campaign when country references are restored.
test('a country normalization failure preserves the original record and unrelated cached campaigns', () => {
  const previous = globalThis.localStorage;
  const damaged = GameEngine.create('Damaged cache entry', 'ZA', true);
  damaged.countries[0] = { ...findCountry('IL'), population: -1, owner: 0, army: 17 };
  const ordinary = GameEngine.create('Recoverable campaign', 'JP', true);
  const payload = JSON.stringify([damaged, ordinary]);
  const writes = [];
  globalThis.localStorage = {
    getItem: () => payload,
    setItem: (...entry) => writes.push(entry),
    removeItem() {},
  };
  try {
    const restored = new LocalGameRepository().load();
    assert.equal(restored.length, 2);
    assert.deepEqual(restored[0], damaged);
    assert.deepEqual(restored[1], ordinary);
    assert.deepEqual(writes, []);
    assert.equal(globalThis.localStorage.getItem(CAMPAIGN_STORAGE_KEY), payload);
  } finally {
    globalThis.localStorage = previous;
  }
});
