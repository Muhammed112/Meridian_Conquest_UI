import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAppEvents } from '../dist/controllers/events.js';
import { createMultiplayerUI } from '../dist/multiplayer.js';
import { newRoom, startRoom } from '../dist/rooms.js';

function settingsFixture() {
  const preferences = [],
    requests = [],
    errors = [],
    campaign = { id: 'campaign' };
  const context = {
    state: { view: 'game', watch: null },
    currentGame: () => campaign,
    cloud: {
      ready: true,
      setCommentaryEnabled: (enabled) => preferences.push(enabled),
      requestCommentary: (game) => requests.push(game),
    },
    multiplayer: { requestCommentary: () => requests.push('room') },
    syncAIControls() {},
    notify: (message) => errors.push(message),
  };
  function toggle(enabled) {
    const previous = globalThis.document;
    let change;
    globalThis.document = {
      addEventListener(type, listener) {
        if (type === 'change') change = listener;
      },
    };
    try {
      bindAppEvents(context);
      change({ target: { id: 'ai-enabled', checked: enabled } });
    } finally {
      globalThis.document = previous;
    }
  }
  return { context, campaign, preferences, requests, errors, toggle };
}

test('enabling commentary in Settings requests recent action in the current campaign', () => {
  const f = settingsFixture();
  f.toggle(true);
  assert.deepEqual(f.preferences, [true]);
  assert.deepEqual(f.requests, [f.campaign]);
  f.toggle(false);
  assert.deepEqual(f.preferences, [true, false]);
  assert.equal(f.requests.length, 1, 'Disabling must not start another request');
});

test('enabling commentary outside live gameplay only saves the preference', () => {
  for (const view of ['welcome', 'campaigns', 'setup', 'history']) {
    const f = settingsFixture();
    f.context.state.view = view;
    f.toggle(true);
    assert.deepEqual(f.preferences, [true]);
    assert.deepEqual(f.requests, []);
  }
  const shared = settingsFixture();
  shared.context.state.watch = { id: 'read-only-snapshot' };
  shared.toggle(true);
  assert.deepEqual(shared.requests, []);
});

test('Settings waits for campaign loading and tolerates an unavailable cloud service', () => {
  const f = settingsFixture();
  f.context.cloud.ready = false;
  f.toggle(true);
  assert.deepEqual(f.requests, []);
  f.context.cloud = null;
  assert.doesNotThrow(() => f.toggle(true));
  const missing = settingsFixture();
  missing.context.currentGame = () => null;
  missing.toggle(true);
  assert.deepEqual(missing.requests, []);
});

test('Settings uses the multiplayer request path and reports a failed request without throwing', () => {
  const f = settingsFixture();
  f.context.state.view = 'multiplayer';
  f.toggle(true);
  assert.deepEqual(f.requests, ['room']);
  f.context.multiplayer.requestCommentary = () => {
    throw new Error('The room is still loading.');
  };
  assert.doesNotThrow(() => f.toggle(true));
  assert.deepEqual(f.errors, ['The room is still loading.']);
});

test('only the host starts shared commentary when enabling Settings in a multiplayer room', async () => {
  const host = { uid: 'host', displayName: 'Host' },
    room = startRoom(newRoom('ABC234', host), host.uid).room,
    requests = [],
    watched = Promise.withResolvers();
  const cloud = {
    user: host,
    ready: true,
    requestCommentary: (game, options) => {
      requests.push({ game, options });
      return 1;
    },
    rooms: {
      join: async () => {},
      watch: (_, onRoom) => {
        onRoom(room);
        watched.resolve();
        return () => {};
      },
    },
  };
  const multiplayer = createMultiplayerUI({ getCloud: () => cloud, changed() {} });
  assert.equal(multiplayer.requestCommentary(), 0);
  multiplayer.route('ABC234');
  await watched.promise;
  assert.equal(multiplayer.requestCommentary(), 1);
  assert.equal(requests[0].game.mode, 'multiplayer');
  assert.deepEqual(requests[0].options, { roomCode: 'ABC234' });
  cloud.user = { uid: 'friend' };
  assert.equal(multiplayer.requestCommentary(), 0);
  multiplayer.route(null);
  assert.equal(multiplayer.requestCommentary(), 0);
  assert.equal(requests.length, 1);
});
