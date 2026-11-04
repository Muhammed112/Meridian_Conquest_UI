import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { createSpectatorService, spectatorPayload } from '../dist/spectators.js';
import { watchLivePresence } from '../dist/live-presence.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Model time and Firestore locally so presence tests need neither Firebase nor real waiting. */
function fixture() {
  let time = 100000,
    timerId = 0,
    sessionId = 0,
    user = { uid: 'owner' };
  const timers = new Map(),
    records = new Map(),
    listeners = new Set(),
    writes = [],
    events = new Map();
  function snapshot(path, query) {
    return query
      ? {
          docs: [...records]
            .filter(([key]) => key.startsWith(path + '/') && key.split('/').length === 4)
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .slice(0, 10)
            .map(([key, value]) => ({ id: key.split('/').at(-1), data: () => value })),
        }
      : { exists: () => records.has(path), data: () => records.get(path) };
  }
  function emit() {
    for (const listener of listeners) listener.receive(snapshot(listener.path, listener.query));
  }
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    collection: (_, ...parts) => parts.join('/'),
    query: (path, ...filters) => ({ path, filters }),
    where: (...values) => values,
    orderBy: (...values) => values,
    limit: (value) => value,
    serverTimestamp: () => time,
    setDoc: async (path, value) => {
      writes.push({ path, value });
      records.set(path, value);
      emit();
    },
    deleteDoc: async (path) => {
      records.delete(path);
      emit();
    },
    getDocs: async () => ({
      docs: [...records]
        .filter(([path]) => path.split('/').length === 2)
        .map(([path, value]) => ({ id: path.split('/').at(-1), data: () => value })),
    }),
    onSnapshot: (target, receive, onError) => {
      const listener = {
        path: target.path || target,
        query: Boolean(target.path),
        receive,
        onError,
      };
      listeners.add(listener);
      receive(snapshot(listener.path, listener.query));
      return () => listeners.delete(listener);
    },
  };
  const presenceOptions = {
    now: () => time,
    createSessionId: () => 'session-' + ++sessionId,
    setInterval: (callback, period) => {
      const id = ++timerId;
      timers.set(id, { callback, period, next: time + period });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    eventTarget: {
      addEventListener: (name, callback) => {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(callback);
      },
      removeEventListener: (name, callback) => events.get(name)?.delete(callback),
    },
  };
  const createService = () =>
    createSpectatorService({ db: {}, sdk, getUser: () => user, presenceOptions });
  return {
    sdk,
    records,
    writes,
    timers,
    listeners,
    presenceOptions,
    createService,
    user: (value) => {
      user = value;
    },
    emit,
    event: (name) => [...(events.get(name) || [])].forEach((callback) => callback()),
    async advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const due = [...timers.values()].filter((timer) => timer.next <= end);
        if (!due.length) break;
        time = Math.min(...due.map((timer) => timer.next));
        for (const timer of [...timers.values()])
          if (timer.next === time) {
            timer.next += timer.period;
            timer.callback();
          }
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

// Playing a private campaign must not create public records; sharing alone must not imply activity.
test('only a currently played explicit share creates heartbeats, and departure retains a tombstone', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Presence lifecycle', 'ZA', true);
  service.setPlayingGame(game.id);
  await flush();
  assert.equal(f.writes.length, 0);
  await service.start(game);
  await flush();
  const presence = f.writes.filter((write) => write.path.includes('/presence/'));
  assert.equal(presence.length, 1);
  assert.deepEqual(presence[0].value, { ownerUid: 'owner', online: true, updatedAt: 100000 });
  service.setPlayingGame(game.id);
  await flush();
  assert.equal(f.writes.length, 2, 'Ordinary renders must not write another heartbeat.');
  await f.advance(30000);
  assert.equal(f.records.get(presence[0].path).updatedAt, 130000);
  service.setPlayingGame(null);
  await flush();
  assert.equal(f.records.get(presence[0].path).online, false);
  assert.equal(f.timers.size, 0);
  const count = f.writes.length;
  await f.advance(90000);
  assert.equal(f.writes.length, count, 'Leaving cancels all owner heartbeat work.');
  service.setPlayingGame(game.id);
  await flush();
  assert.equal(f.records.size, 3, 'Re-entry uses a new tab-session document.');
  service.reset();
  await flush();
});

// A dead tab cannot send a departure, so readers must expire its last heartbeat without new snapshots.
test('visitors detect timeout while presence changes leave game payload callbacks untouched', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Visitor timeout', 'ZA', true),
    statuses = [],
    games = [];
  f.records.set('liveGames/' + game.id, { payload: spectatorPayload(game) });
  f.user(null);
  const stop = service.watch(
    game.id,
    (value) => games.push(value),
    assert.fail,
    (value) => statuses.push(value),
  );
  // Simulate Firestore's independent query delivery rather than notifying the game subscription.
  const listener = [...f.listeners].find((entry) => entry.query);
  listener.receive({
    docs: [{ data: () => ({ online: true, updatedAt: { toMillis: () => 100000 } }) }],
  });
  assert.deepEqual(statuses, ['unknown', 'online']);
  await f.advance(75000);
  assert.deepEqual(statuses, ['unknown', 'online', 'offline']);
  assert.equal(games.length, 1, 'Heartbeats must not restart viewer board animations.');
  assert.equal(f.writes.length, 0, 'Anonymous viewers never write presence.');
  stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  listener.receive({ docs: [{ data: () => ({ online: true, updatedAt: 175000 }) }] });
  listener.onError(new Error('Late callback after unsubscribe'));
  assert.deepEqual(statuses, ['unknown', 'online', 'offline']);
});

// One owner can have several tabs open; an offline tab must not mask a still-playing tab.
test('any fresh online tab keeps the owner online, regardless of other departure records', () => {
  const f = fixture(),
    statuses = [];
  const stop = watchLivePresence({
    db: {},
    sdk: f.sdk,
    gameId: 'game',
    onPresence: (status) => statuses.push(status),
    ...f.presenceOptions,
  });
  const listener = [...f.listeners][0];
  const receive = (values) =>
    listener.receive({ docs: values.map((value) => ({ data: () => value })) });
  receive([
    { online: false, updatedAt: 100000 },
    { online: true, updatedAt: 99999 },
  ]);
  assert.equal(statuses.at(-1), 'online');
  receive([
    { online: false, updatedAt: 100000 },
    { online: false, updatedAt: 99999 },
  ]);
  assert.equal(statuses.at(-1), 'offline');
  receive([]);
  assert.equal(statuses.at(-1), 'unknown');
  receive([{ online: true, updatedAt: null }]);
  assert.equal(statuses.at(-1), 'unknown', 'An unresolved server timestamp cannot prove presence.');
  stop();
});

// Old rules and denied reads must preserve the existing spectator stream instead of reporting departure.
test('presence errors and unsupported SDKs degrade to unknown without affecting game subscriptions', async () => {
  const f = fixture(),
    statuses = [],
    errors = [],
    service = f.createService();
  const stop = service.watch(
    'game',
    () => {},
    (error) => errors.push(error),
    (status) => statuses.push(status),
  );
  const listener = [...f.listeners].find((entry) => entry.query);
  listener.receive({ docs: [{ data: () => ({ online: true, updatedAt: 100000 }) }] });
  listener.onError(new Error('permission-denied'));
  await f.advance(90000);
  assert.deepEqual(statuses, ['unknown', 'online', 'unknown']);
  assert.deepEqual(errors, []);
  stop();
  delete f.sdk.orderBy;
  const unsupported = [];
  const cleanup = service.watch(
    'game',
    () => {},
    assert.fail,
    (status) => unsupported.push(status),
  );
  assert.deepEqual(unsupported, ['unknown']);
  assert.equal(
    f.listeners.size,
    1,
    'Only the public game subscribes when presence is unsupported.',
  );
  cleanup();
  assert.equal(f.timers.size, 0);
});

// Route/account changes can race queued writes; an obsolete online write must never revive the session.
test('queued online work is invalidated by departure and account changes', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Queued departure', 'ZA', true);
  await service.start(game);
  await flush();
  const initialWrites = f.writes.length;
  service.setPlayingGame(game.id);
  service.setPlayingGame(null);
  await flush();
  const presence = f.writes
    .slice(initialWrites)
    .filter((write) => write.path.includes('/presence/'));
  assert.deepEqual(
    presence.map((write) => write.value.online),
    [false],
  );
  service.setPlayingGame(game.id);
  service.reset();
  f.user({ uid: 'other' });
  await flush();
  assert.equal(f.writes.length, initialWrites + 1);
  assert.equal(f.timers.size, 0);
});

// Offline Firestore promises can remain pending; they must not block another campaign's presence.
test('a blocked heartbeat cannot delay a new game and finishes offline after departure', async () => {
  const f = fixture(),
    service = f.createService(),
    first = GameEngine.create('First stream', 'ZA', true),
    second = GameEngine.create('Second stream', 'ZA', true),
    setDoc = f.sdk.setDoc;
  let release;
  await service.start(first);
  await service.start(second);
  f.sdk.setDoc = (path, value) =>
    path.endsWith('/presence/session-3') && value.online
      ? new Promise((resolve) => {
          release = () => setDoc(path, value).then(resolve);
        })
      : setDoc(path, value);
  service.setPlayingGame(first.id);
  await flush();
  service.setPlayingGame(second.id);
  await flush();
  assert.equal(f.records.get(`liveGames/${second.id}/presence/session-4`).online, true);
  await release();
  await flush();
  assert.equal(f.records.get(`liveGames/${first.id}/presence/session-3`).online, false);
  service.reset();
  await flush();
  assert.equal(f.timers.size, 0);
});

// Refresh/back-forward-cache restoration needs a new live session; hiding the tab alone is not departure.
test('pagehide leaves gracefully and pageshow resumes the selected shared campaign', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Browser lifecycle', 'ZA', true);
  service.setPlayingGame(game.id);
  await service.start(game);
  service.setPlayingGame(game.id);
  await flush();
  f.event('visibilitychange');
  await flush();
  assert.equal(f.writes.at(-1).value.online, true);
  f.event('pagehide');
  await flush();
  assert.equal(f.writes.at(-1).value.online, false);
  assert.equal(f.timers.size, 0);
  f.event('pageshow');
  await flush();
  assert.equal(f.writes.at(-1).value.online, true);
  assert.match(f.writes.at(-1).path, /session-2$/);
  service.reset();
  await flush();
  const count = f.writes.length;
  f.event('pageshow');
  await flush();
  assert.equal(f.writes.length, count, 'Reset removes browser lifecycle listeners too.');
});

// Presence failure must never turn a successful share or save into a failed operation.
test('failed presence writes do not interrupt sharing and failed revocation resumes tracking', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Presence compatibility', 'ZA', true),
    setDoc = f.sdk.setDoc;
  f.sdk.setDoc = (path, value) =>
    path.includes('/presence/')
      ? Promise.reject(new Error('Old rules deny presence'))
      : setDoc(path, value);
  service.setPlayingGame(game.id);
  await service.start(game);
  await flush();
  assert.equal(service.isShared(game.id), true);
  await service.publish(game);
  f.sdk.deleteDoc = async () => {
    throw new Error('offline');
  };
  await assert.rejects(service.stop(game.id), /offline/);
  assert.equal(service.isShared(game.id), true);
  assert.equal(f.timers.size, 1, 'A failed stop remains retryable and resumes the current share.');
  service.reset();
  await flush();
  assert.equal(f.timers.size, 0);
});

// Account restoration runs asynchronously; an already-open owner route should become live afterwards.
test('restoring an explicit share starts only the selected game and stop cancels its heartbeat', async () => {
  const f = fixture(),
    service = f.createService();
  f.records.set('liveGames/shared', { ownerUid: 'owner' });
  service.setPlayingGame('shared');
  await service.restore();
  await flush();
  assert.equal(f.writes.at(-1).value.online, true);
  await service.stop('shared');
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.writes.at(-1).value.online, false);
  assert.equal(service.isShared('shared'), false);
});

// Sharing from the campaign list must not claim a live player, or end another currently played game.
test('card sharing records offline presence without interrupting a different live campaign', async () => {
  const f = fixture(),
    service = f.createService(),
    first = GameEngine.create('Playing campaign', 'ZA', true),
    second = GameEngine.create('Card share', 'ZA', true),
    statuses = [];
  await service.start(first);
  await flush();
  assert.equal(f.writes.at(-1).value.online, false);
  assert.equal(f.timers.size, 0);
  service.setPlayingGame(first.id);
  await flush();
  await service.start(second);
  await flush();
  const stop = service.watch(
    second.id,
    () => {},
    assert.fail,
    (status) => statuses.push(status),
  );
  assert.equal(statuses.at(-1), 'offline');
  assert.equal(f.records.get(`liveGames/${first.id}/presence/session-2`).online, true);
  assert.equal(f.timers.size, 2, 'The active game keeps its heartbeat alongside the viewer timer.');
  stop();
  service.reset();
  await flush();
  assert.equal(f.timers.size, 0);
});
