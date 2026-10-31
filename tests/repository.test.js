import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalGameRepository,
  GameEngine,
  CAMPAIGN_STORAGE_KEY,
  LEGACY_CAMPAIGN_STORAGE_KEY,
} from '../dist/engine.js';

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
