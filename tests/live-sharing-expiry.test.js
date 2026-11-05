import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { createSpectatorService, spectatorPayload } from '../dist/spectators.js';
import {
  LIVE_SHARE_IDLE_MS,
  timestampMilliseconds,
  liveShareExpiresAt,
  isLiveShareFresh,
} from '../dist/live-sharing.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

/** Drive owner leases, visitor deadlines, and presence without Firebase or real waiting. */
function fixture() {
  let time = 1000000,
    timerId = 0,
    sessionId = 0,
    user = { uid: 'owner' };
  const timers = new Map(),
    records = new Map(),
    listeners = new Set(),
    writes = [],
    reads = [],
    expired = [];
  const snapshot = (path) => {
    const value = records.get(path);
    return { exists: () => value !== undefined, data: () => value };
  };
  const schedule = (callback, delay, period) => {
    const id = ++timerId;
    timers.set(id, { callback, next: time + delay, period });
    return id;
  };
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    collection: (_, ...parts) => parts.join('/'),
    query: (path, ...filters) => ({ path, filters }),
    where: (...values) => values,
    orderBy: (...values) => values,
    limit: (value) => value,
    serverTimestamp: () => time,
    getDocs: async () => ({
      docs: [...records]
        .filter(([path]) => path.split('/').length === 2)
        .map(([path, value]) => ({ id: path.split('/').at(-1), data: () => value })),
    }),
    getDoc: async (path) => {
      reads.push(path);
      return snapshot(path);
    },
    setDoc: async (path, value) => {
      writes.push({ kind: 'set', path, value });
      records.set(path, value);
    },
    updateDoc: async (path, value) => {
      writes.push({ kind: 'update', path, value });
      if (!records.has(path)) throw new Error('not-found');
      records.set(path, { ...records.get(path), ...value });
    },
    deleteDoc: async (path) => {
      writes.push({ kind: 'delete', path });
      records.delete(path);
    },
    onSnapshot: (target, receive, onError) => {
      const listener = {
        path: target.path || target,
        query: Boolean(target.path),
        receive,
        onError,
      };
      listeners.add(listener);
      receive(listener.query ? { docs: [] } : snapshot(listener.path));
      return () => listeners.delete(listener);
    },
  };
  const leaseOptions = {
    now: () => time,
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (id) => timers.delete(id),
  };
  const presenceOptions = {
    now: () => time,
    createSessionId: () => 'session-' + ++sessionId,
    setInterval: (callback, period) => schedule(callback, period, period),
    clearInterval: (id) => timers.delete(id),
    eventTarget: { addEventListener() {}, removeEventListener() {} },
  };
  return {
    sdk,
    records,
    listeners,
    writes,
    reads,
    expired,
    timers,
    snapshot,
    now: () => time,
    user: (value) => {
      user = value;
    },
    createService: () =>
      createSpectatorService({
        db: {},
        sdk,
        getUser: () => user,
        leaseOptions,
        presenceOptions,
        onExpired: (id) => expired.push(id),
      }),
    emit(path, value) {
      for (const listener of listeners)
        if (!listener.query && listener.path === path)
          listener.receive({ exists: () => value !== undefined, data: () => value });
    },
    jump(milliseconds) {
      time += milliseconds;
    },
    async advance(milliseconds) {
      const end = time + milliseconds;
      let iterations = 0;
      while (true) {
        const next = Math.min(...[...timers.values()].map((timer) => timer.next));
        if (next > end) break;
        assert.ok(++iterations < 10000, 'Timers must make progress.');
        time = Math.max(time, next);
        for (const [id, timer] of [...timers]) {
          if (timer.next > time || !timers.has(id)) continue;
          if (timer.period) timer.next += timer.period;
          else timers.delete(id);
          timer.callback();
        }
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

const pathFor = (game) => 'liveGames/' + game.id;
const publicRecord = (game, updatedAt) => ({
  version: 1,
  ownerUid: 'owner',
  gameId: game.id,
  payload: spectatorPayload(game),
  updatedAt,
});
const gameWrites = (f) => f.writes.filter((write) => write.path.split('/').length === 2);

test('live shares expire exactly five minutes after a valid remote timestamp', () => {
  assert.equal(LIVE_SHARE_IDLE_MS, 300000);
  for (const updatedAt of [123000, { toMillis: () => 123000 }]) {
    assert.equal(timestampMilliseconds(updatedAt), 123000);
    const record = { updatedAt };
    assert.equal(liveShareExpiresAt(record), 423000);
    assert.equal(isLiveShareFresh(record, 422999), true);
    assert.equal(isLiveShareFresh(record, 423000), false);
    assert.equal(isLiveShareFresh(record, 423001), false);
  }
  for (const updatedAt of [undefined, null, '123000', NaN, Infinity])
    assert.equal(isLiveShareFresh({ updatedAt }, 123000), false);
});

for (const departure of ['closed', 'dead']) {
  test(`${departure} browser shares stay stale across restoration and repeated anonymous visits`, async () => {
    const f = fixture(),
      owner = f.createService(),
      game = GameEngine.create('Closed browser', 'ZA', true),
      path = pathFor(game);
    await owner.start(game);
    await flush();
    if (departure === 'closed') owner.reset();
    else f.timers.clear(); // A dead process cannot run its timers or send a final departure.
    await flush();
    const before = gameWrites(f).length;
    f.jump(LIVE_SHARE_IDLE_MS);
    for (let visit = 0; visit < 3; visit++) {
      const restored = f.createService();
      await restored.restore();
      assert.equal(restored.isShared(game.id), false);
      await restored.publish(game);
      await restored.activity(game.id);
      restored.reset();
      f.user(null);
      const visitor = f.createService(),
        changes = [];
      const stop = visitor.watch(game.id, (...args) => changes.push(args), assert.fail);
      assert.deepEqual(changes, [[null, { expired: true }]]);
      stop();
      f.user({ uid: 'owner' });
      f.jump(LIVE_SHARE_IDLE_MS);
    }
    assert.equal(
      gameWrites(f).length,
      before,
      'Visits and restoration cannot renew a stale record.',
    );
    assert.equal(
      f.records.has(path),
      true,
      'Expiry does not need to delete the saved remote snapshot.',
    );
    assert.equal(f.timers.size, 0);
  });
}

test('an idle open owner tab expires despite continued presence heartbeats', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Open idle tab', 'ZA', true),
    path = pathFor(game);
  service.setPlayingGame(game.id);
  await service.start(game);
  const initialTimestamp = f.records.get(path).updatedAt;
  await f.advance(LIVE_SHARE_IDLE_MS - 1);
  assert.equal(service.isShared(game.id), true);
  assert.ok(f.writes.filter((write) => write.path.includes('/presence/')).length > 1);
  assert.equal(f.records.get(path).updatedAt, initialTimestamp);
  await f.advance(1);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
  assert.deepEqual(f.reads, [path]);
  assert.equal(
    f.writes.filter((write) => write.path.includes('/presence/')).at(-1).value.online,
    false,
  );
  const count = f.writes.length;
  await f.advance(LIVE_SHARE_IDLE_MS * 2);
  assert.equal(f.writes.length, count);
  assert.deepEqual(f.expired, [game.id], 'Expiry is reported once for the current share.');
  assert.equal(f.timers.size, 0);
});

test('unchanged ordinary publications do not renew a share before or after restoration', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Unchanged public board', 'ZA', true),
    path = pathFor(game);
  await service.start(game);
  const publishedAt = f.records.get(path).updatedAt;
  await f.advance(120000);
  await service.publish(game);
  assert.equal(gameWrites(f).length, 1);
  assert.equal(f.records.get(path).updatedAt, publishedAt);
  service.reset();
  await service.restore();
  assert.equal(service.isShared(game.id), true);
  await f.advance(120000);
  await service.publish(game);
  assert.equal(gameWrites(f).length, 1, 'Restoration retains the last published payload baseline.');
  assert.equal(f.records.get(path).updatedAt, publishedAt);
  await f.advance(59999);
  assert.equal(service.isShared(game.id), true);
  await f.advance(1);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
});

test('a changed publication only extends the campaign whose board changed', async () => {
  const f = fixture(),
    service = f.createService(),
    dormant = GameEngine.create('Dormant campaign', 'ZA', true),
    playing = GameEngine.create('Currently played campaign', 'ZA', true);
  await service.start(dormant);
  await service.start(playing);
  service.setPlayingGame(playing.id);
  const dormantTimestamp = f.records.get(pathFor(dormant)).updatedAt;
  await f.advance(240000);
  new GameEngine(playing).event('decision', 'The currently played campaign changed.');
  await service.publish(playing);
  await service.publish(dormant);
  assert.equal(gameWrites(f).length, 3);
  assert.equal(f.records.get(pathFor(dormant)).updatedAt, dormantTimestamp);
  assert.equal(f.records.get(pathFor(playing)).updatedAt, f.now());
  await f.advance(60000);
  assert.equal(service.isShared(dormant.id), false);
  assert.equal(service.isShared(playing.id), true);
  assert.deepEqual(f.expired, [dormant.id]);
  await f.advance(240000);
  assert.equal(service.isShared(playing.id), false);
  assert.deepEqual(f.expired, [dormant.id, playing.id]);
  assert.equal(f.timers.size, 0);
});

test('selected owner activity extends a fresh share without rewriting its board', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Active owner', 'ZA', true),
    path = pathFor(game);
  service.setPlayingGame(game.id);
  await service.start(game);
  const payload = f.records.get(path).payload;
  await f.advance(240000);
  await service.activity(game.id);
  const renewal = gameWrites(f).at(-1);
  assert.equal(renewal.kind, 'update');
  assert.deepEqual(renewal.value, { updatedAt: f.now() });
  assert.equal(f.records.get(path).payload, payload);
  await f.advance(60000);
  assert.equal(
    service.isShared(game.id),
    true,
    'The original deadline no longer expires the share.',
  );
  await f.advance(239999);
  assert.equal(service.isShared(game.id), true);
  await f.advance(1);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
});

test('activity only renews the currently played fresh explicit share', async () => {
  const f = fixture(),
    service = f.createService(),
    selected = GameEngine.create('Selected', 'ZA', true),
    other = GameEngine.create('Other', 'ZA', true),
    privateGame = GameEngine.create('Private', 'ZA', true);
  await service.start(selected);
  await service.start(other);
  service.setPlayingGame(selected.id);
  const before = gameWrites(f).length;
  await service.activity(other.id);
  await service.activity(privateGame.id);
  service.setPlayingGame(null);
  await service.activity(selected.id);
  assert.equal(gameWrites(f).length, before);
  service.setPlayingGame(selected.id);
  f.jump(LIVE_SHARE_IDLE_MS);
  await service.activity(selected.id);
  await service.publish(selected);
  assert.equal(
    gameWrites(f).length,
    before,
    'Suspended timers cannot let an expired share revive.',
  );
  service.reset();
  await flush();
});

test('a rejected owner activity write does not extend the last confirmed lease', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Failed activity', 'ZA', true);
  service.setPlayingGame(game.id);
  await service.start(game);
  await f.advance(240000);
  f.sdk.updateDoc = async () => {
    throw new Error('offline');
  };
  await Promise.allSettled([service.activity(game.id)]);
  await f.advance(60000);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
});

test('owner activity shares the publication queue and a later stop cannot be undone by its ack', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Queued activity and stop', 'ZA', true),
    entered = deferred(),
    delivery = deferred(),
    updateDoc = f.sdk.updateDoc;
  service.setPlayingGame(game.id);
  await service.start(game);
  await f.advance(100000);
  f.sdk.updateDoc = async (path, value) => {
    entered.resolve();
    await delivery.promise;
    return updateDoc(path, value);
  };
  const activity = service.activity(game.id);
  await entered.promise;
  const stopping = service.stop(game.id);
  await flush();
  assert.equal(
    gameWrites(f).some((write) => write.kind === 'delete'),
    false,
  );
  delivery.resolve();
  await Promise.all([activity, stopping]);
  assert.deepEqual(
    gameWrites(f).map((write) => write.kind),
    ['set', 'update', 'delete'],
  );
  assert.equal(service.isShared(game.id), false);
  await f.advance(LIVE_SHARE_IDLE_MS);
  assert.deepEqual(f.expired, []);
  assert.equal(f.records.has(pathFor(game)), false);
  assert.equal(f.timers.size, 0);
});

test('a pending activity write cannot renew before acknowledgement or revive a local expiry', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Pending activity at deadline', 'ZA', true),
    entered = deferred(),
    delivery = deferred(),
    updateDoc = f.sdk.updateDoc;
  service.setPlayingGame(game.id);
  await service.start(game);
  await f.advance(240000);
  f.sdk.updateDoc = async (path, value) => {
    entered.resolve();
    await delivery.promise;
    return updateDoc(path, value);
  };
  const activity = service.activity(game.id);
  await entered.promise;
  await f.advance(60000);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
  delivery.resolve();
  await activity;
  await f.advance(LIVE_SHARE_IDLE_MS);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
  assert.equal(f.timers.size, 0);
});

test('an explicit share restarts an expired lease and enables later publication', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Explicit share again', 'ZA', true);
  service.setPlayingGame(game.id);
  await service.start(game);
  await f.advance(LIVE_SHARE_IDLE_MS);
  const count = gameWrites(f).length;
  await service.publish(game);
  await service.activity(game.id);
  assert.equal(gameWrites(f).length, count);
  await service.start(game);
  assert.equal(service.isShared(game.id), true);
  assert.equal(f.records.get(pathFor(game)).updatedAt, f.now());
  new GameEngine(game).event('decision', 'The owner explicitly shared again.');
  await service.publish(game);
  assert.match(f.records.get(pathFor(game)).payload, /explicitly shared again/);
  assert.deepEqual(f.expired, [game.id]);
  service.reset();
  await flush();
});

test('the owner deadline adopts a fresher lease written by another owner tab', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Another active tab', 'ZA', true),
    path = pathFor(game);
  f.sdk.getDocFromServer = async (target) => {
    f.reads.push(target);
    return f.snapshot(target);
  };
  f.sdk.getDoc = () =>
    assert.fail('Deadline verification must prefer a server read over cached data.');
  await service.start(game);
  await f.advance(240000);
  const remoteTime = f.now();
  f.records.set(path, { ...f.records.get(path), updatedAt: { toMillis: () => remoteTime } });
  await f.advance(60000);
  assert.equal(service.isShared(game.id), true);
  assert.deepEqual(f.expired, []);
  assert.deepEqual(f.reads, [path]);
  await f.advance(239999);
  assert.equal(service.isShared(game.id), true);
  await f.advance(1);
  assert.equal(service.isShared(game.id), false);
  assert.deepEqual(f.expired, [game.id]);
  assert.deepEqual(f.reads, [path, path]);
});

for (const outcome of ['missing', 'failed']) {
  test(`a ${outcome} deadline read expires the local owner share`, async () => {
    const f = fixture(),
      service = f.createService(),
      game = GameEngine.create('Deadline read ' + outcome, 'ZA', true);
    await service.start(game);
    if (outcome === 'missing') f.records.delete(pathFor(game));
    else
      f.sdk.getDoc = async () => {
        throw new Error('offline');
      };
    await f.advance(LIVE_SHARE_IDLE_MS);
    assert.equal(service.isShared(game.id), false);
    assert.deepEqual(f.expired, [game.id]);
    const count = gameWrites(f).length;
    await service.publish(game);
    await service.activity(game.id);
    assert.equal(gameWrites(f).length, count);
    assert.equal(f.timers.size, 0);
  });
}

for (const action of ['stop', 'reset', 'start']) {
  test(`a delayed deadline read cannot override a newer ${action}`, async () => {
    const f = fixture(),
      service = f.createService(),
      game = GameEngine.create('Deadline race ' + action, 'ZA', true),
      delivery = deferred();
    await service.start(game);
    const oldSnapshot = f.snapshot(pathFor(game));
    f.sdk.getDoc = () => delivery.promise;
    await f.advance(LIVE_SHARE_IDLE_MS);
    if (action === 'stop') await service.stop(game.id);
    if (action === 'reset') service.reset();
    if (action === 'start') await service.start(game);
    delivery.resolve(oldSnapshot);
    await flush();
    assert.equal(service.isShared(game.id), action === 'start');
    assert.deepEqual(f.expired, [], 'An obsolete check cannot expire a newer action.');
    if (action === 'start') {
      await f.advance(LIVE_SHARE_IDLE_MS - 1);
      assert.equal(service.isShared(game.id), true);
      service.reset();
    }
    await flush();
    assert.equal(f.timers.size, 0);
  });
}

test('a failed manual stop restores controls only while the confirmed lease is still fresh', async () => {
  for (const delay of [1000, LIVE_SHARE_IDLE_MS]) {
    const f = fixture(),
      service = f.createService(),
      game = GameEngine.create('Stop failure ' + delay, 'ZA', true),
      deletion = deferred();
    await service.start(game);
    f.sdk.deleteDoc = () => deletion.promise;
    const failure = assert.rejects(service.stop(game.id), /offline/);
    await flush();
    await f.advance(delay);
    assert.equal(service.isShared(game.id), false);
    deletion.reject(new Error('offline'));
    await failure;
    assert.equal(service.isShared(game.id), delay < LIVE_SHARE_IDLE_MS);
    assert.deepEqual(f.expired, delay < LIVE_SHARE_IDLE_MS ? [] : [game.id]);
    assert.equal(f.records.has(pathFor(game)), true);
    service.reset();
    await flush();
    assert.equal(f.timers.size, 0);
  }
});

test('an anonymous visitor expires at the remote deadline without further snapshots or writes', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Visitor deadline', 'ZA', true),
    changes = [];
  const updatedAt = f.now();
  f.records.set(pathFor(game), publicRecord(game, { toMillis: () => updatedAt }));
  f.user(null);
  const stop = service.watch(game.id, (...args) => changes.push(args), assert.fail);
  assert.equal(changes[0][0].id, game.id);
  await f.advance(LIVE_SHARE_IDLE_MS - 1);
  assert.equal(changes.length, 1);
  await f.advance(1);
  assert.deepEqual(changes.at(-1), [null, { expired: true }]);
  await f.advance(LIVE_SHARE_IDLE_MS);
  assert.equal(changes.length, 2);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, [], 'Visitor deadlines need no Firestore verification reads.');
  stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('visitor deadlines follow the newest record and ignore delayed older cache snapshots', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('First public board', 'ZA', true),
    path = pathFor(game),
    changes = [],
    first = publicRecord(game, f.now());
  f.records.set(path, first);
  f.user(null);
  const stop = service.watch(game.id, (...args) => changes.push(args), assert.fail);
  await f.advance(100000);
  game.name = 'Newer public board';
  const newer = publicRecord(game, f.now());
  f.emit(path, newer);
  assert.equal(changes.at(-1)[0].name, game.name);
  const count = changes.length;
  f.emit(path, first);
  assert.equal(changes.length, count, 'Older cache data cannot replace the newer board.');
  await f.advance(200000);
  assert.equal(changes.length, count, 'The old deadline cannot expire the newer record.');
  f.emit(path, first);
  assert.equal(changes.length, count, 'A stale delayed snapshot cannot expire the newer record.');
  await f.advance(99999);
  assert.equal(changes.length, count);
  await f.advance(1);
  assert.deepEqual(changes.at(-1), [null, { expired: true }]);
  f.emit(path, newer);
  assert.equal(changes.length, count + 1, 'An expired snapshot cannot revive the visitor board.');
  stop();
  assert.deepEqual(f.writes, []);
  assert.equal(f.timers.size, 0);
});

test('a missing visitor record remains distinct from expiry and unsubscribe cancels its deadline', async () => {
  const f = fixture(),
    service = f.createService(),
    game = GameEngine.create('Visitor removal', 'ZA', true),
    path = pathFor(game),
    changes = [];
  f.user(null);
  const stop = service.watch(game.id, (...args) => changes.push(args), assert.fail);
  assert.equal(changes[0][0], null);
  assert.notDeepEqual(changes[0][1], { expired: true });
  f.emit(path, publicRecord(game, f.now()));
  assert.equal(changes.at(-1)[0].id, game.id);
  const listener = [...f.listeners].find((entry) => !entry.query);
  stop();
  const count = changes.length;
  await f.advance(LIVE_SHARE_IDLE_MS);
  listener.receive({ exists: () => true, data: () => publicRecord(game, f.now()) });
  assert.equal(changes.length, count);
  assert.deepEqual(f.writes, []);
  assert.equal(f.timers.size, 0);
});
