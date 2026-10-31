import test from 'node:test';
import assert from 'node:assert/strict';
import { connectCloud } from '../dist/cloud.js';
import { GameEngine } from '../dist/engine.js';

async function fixture({
  persistenceError = null,
  read = async () => ({ docs: [] }),
  loadTimeout = 30000,
  updateProfile = async (account, changes) => Object.assign(account, changes),
} = {}) {
  let session,
    fail = false;
  const writes = [],
    subscriptions = [],
    errors = [],
    sessions = [],
    loadStates = [],
    profiles = [];
  const sessionPersistence = { type: 'SESSION' },
    authInstance = {};
  const ref = (...segments) => {
    const path = segments
      .filter((s) => s !== db)
      .map((s) => s.path || s)
      .join('/');
    return { path };
  };
  const db = {};
  const sdk = {
    initializeApp: () => ({}),
    getAuth: () => authInstance,
    getFirestore: () => db,
    browserSessionPersistence: sessionPersistence,
    async setPersistence(auth, persistence) {
      assert.equal(auth, authInstance);
      assert.equal(persistence, sessionPersistence);
      assert.equal(session, undefined, 'Account restoration must wait for session persistence');
      if (persistenceError) throw persistenceError;
    },
    onAuthStateChanged: (_, callback) => {
      session = callback;
    },
    updateProfile,
    collection: ref,
    doc: ref,
    query: (value) => value,
    orderBy: () => ({}),
    getDocs: read,
    onSnapshot: (target) => {
      subscriptions.push(target.path);
      return () => {};
    },
    writeBatch: () => {
      const batch = [];
      return {
        set: (target, value) => batch.push([target.path, value]),
        commit: async () => {
          if (fail) throw new Error('offline');
          writes.push(batch);
        },
      };
    },
  };
  const service = await connectCloud({
    config: { projectId: 'test' },
    aiSettings: { enabled: false },
    loadSDK: async () => sdk,
    loadTimeout,
    onSession: (user, games, ready) => sessions.push({ user, games, ready }),
    onProfile: (user) => profiles.push({ uid: user.uid, displayName: user.displayName }),
    onLoadState: (state) => loadStates.push(state),
    onCommentary: () => {},
    onError: (e) => errors.push(e),
  });
  return {
    service,
    writes,
    subscriptions,
    errors,
    sessions,
    loadStates,
    profiles,
    login: (uid) => session(uid ? { uid, displayName: 'Original nickname' } : null),
    setFailure: (value) => {
      fail = value;
    },
  };
}
const game = () => ({
  ...GameEngine.create('Save validation fixture', 'ZA', true),
  id: 'g1',
  updatedAt: 123,
  events: [
    {
      id: 'e1',
      type: 'dice',
      round: 3,
      player: 0,
      text: 'Recorded losses',
      commentary: 'Generated text',
      board: GameEngine.create('Event board fixture', 'ZA', true).countries.map(
        ({ code, owner, army }) => ({ code, owner, army }),
      ),
    },
  ],
});

test('account restoration uses tab-session persistence before accessing private campaigns', async () => {
  const f = await fixture();
  await f.login('owner');
  assert.equal(f.service.user.uid, 'owner');
  assert.equal(f.service.ready, true);
});

test('nickname changes update the account without reloading or rewriting its campaign history', async () => {
  const f = await fixture();
  await f.login('owner');
  const sessions = f.sessions.length;
  assert.equal(await f.service.updateNickname('  Meridian Goat  '), 'Meridian Goat');
  assert.equal(f.service.user.displayName, 'Meridian Goat');
  assert.deepEqual(f.profiles, [{ uid: 'owner', displayName: 'Meridian Goat' }]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.sessions.length, sessions);
  assert.equal(f.service.ready, true);
});
test('invalid and signed-out nickname updates never reach Firebase', async () => {
  let calls = 0;
  const f = await fixture({
    updateProfile: async () => {
      calls++;
    },
  });
  await assert.rejects(f.service.updateNickname('Nickname'), /Sign in/);
  await f.login('owner');
  for (const name of ['', '  ', 'x', 'a'.repeat(33), 'bad\nname'])
    await assert.rejects(f.service.updateNickname(name), /2 and 32/);
  assert.equal(calls, 0);
  assert.equal(f.profiles.length, 0);
});
test('failed nickname writes retain the old profile and do not report success', async () => {
  const f = await fixture({
    updateProfile: async () => {
      throw new Error('offline');
    },
  });
  await f.login('owner');
  await assert.rejects(f.service.updateNickname('New nickname'), /offline/);
  assert.equal(f.service.user.displayName, 'Original nickname');
  assert.equal(f.profiles.length, 0);
});
test('an old-account nickname response cannot replace the next signed-in player profile', async () => {
  let release, started;
  const pending = new Promise((resolve) => {
      release = resolve;
    }),
    writing = new Promise((resolve) => {
      started = resolve;
    });
  const f = await fixture({
    updateProfile: async (account, changes) => {
      started();
      await pending;
      Object.assign(account, changes);
    },
  });
  await f.login('old');
  const updating = f.service.updateNickname('Old player nickname');
  await writing;
  await f.login('new');
  release();
  await assert.rejects(updating, /account changed/);
  assert.equal(f.service.user.uid, 'new');
  assert.equal(f.service.user.displayName, 'Original nickname');
  assert.equal(f.profiles.length, 0);
});

test('unavailable session persistence prevents authentication startup', async () => {
  const error = new Error('Session storage unavailable');
  await assert.rejects(fixture({ persistenceError: error }), error);
});

test('signed-out clients do not write or subscribe to private campaigns', async () => {
  const f = await fixture();
  await f.login(null);
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.subscriptions.length, 0);
});
test('campaign events are saved immutably and narration is excluded from model facts', async () => {
  const f = await fixture();
  await f.login('owner');
  await f.service.save([game()]);
  assert.equal(f.writes.length, 1);
  const batch = f.writes[0];
  assert.equal(batch[0][0], 'users/owner/games/g1/events/e1');
  assert.equal(batch[1][0], 'users/owner/games/g1');
  assert.equal(JSON.parse(batch[0][1].payload).commentary, undefined);
  assert.equal(JSON.parse(batch[0][1].context).event.commentary, undefined);
  assert.equal(batch[0][1].sequence, 0);
  await f.service.save([game()]);
  assert.equal(f.writes[1].length, 1);
  assert.equal(f.subscriptions.length, 3);
});
test('a failed batch can retry its events instead of treating them as already saved', async () => {
  const f = await fixture();
  await f.login('owner');
  f.setFailure(true);
  await assert.rejects(f.service.save([game()]));
  f.setFailure(false);
  await f.service.save([game()]);
  assert.equal(f.writes[0][0][0], 'users/owner/games/g1/events/e1');
});
test('saved bot-versus-bot battles trigger commentary automatically without a manual request', async () => {
  const f = await fixture();
  await f.login('owner');
  const campaign = GameEngine.create('Bot narration', 'ZA', true),
    engine = new GameEngine(campaign),
    narrator = f.service.commentary,
    generated = [],
    reported = [];
  campaign.position = campaign.order.indexOf(1);
  campaign.round = 1;
  campaign.budget = 0;
  campaign.events = [];
  campaign.countries[1].army = 6;
  campaign.countries[2].army = 5;
  engine.event('turn', 'Kestrel begins a turn.');
  engine.startAttack(campaign.countries[1].code, campaign.countries[2].code);
  const rolls = [1, 6, 6, 1, 6, 1, 3, 3, 3, 3];
  engine.roll(() => rolls.shift());
  narrator.setTimer = () => 1;
  narrator.lookup = async () => null;
  narrator.generate = async (tasks) => {
    generated.push(...tasks);
    return JSON.stringify({
      reports: tasks.map(({ eventId }) => ({ eventId, text: 'The recorded battle continues.' })),
    });
  };
  narrator.persist = async (_, text) => ({ status: 'ready', text });
  narrator.onReport = (task) => reported.push(task.eventId);
  narrator.setEnabled(true);
  await f.service.save([campaign]);
  await narrator.drain();
  assert.equal(generated.length, 1);
  assert.equal(generated[0].context.event.type, 'dice');
  assert.equal(generated[0].context.match.actingPlayer, 1);
  assert.deepEqual(generated[0].context.match.battle.defender, { player: 2, name: 'Atlas' });
  assert.deepEqual(reported, [campaign.events.at(-1).id]);
  narrator.reset();
});

test('queued saves from an old account cannot write into a new account', async () => {
  const f = await fixture();
  await f.login('old');
  const pending = f.service.save([game()]);
  await f.login('new');
  await pending;
  assert.equal(f.writes.length, 0);
  assert.equal(f.subscriptions.length, 0);
  await f.service.save([game()]);
  assert.ok(f.writes[0].every(([path]) => path.startsWith('users/new/')));
});

const savedRecord = {
  ref: { path: 'users/owner/games/g1' },
  data: () => ({ payload: JSON.stringify(game()) }),
};
const savedHistory = { docs: [{ data: () => ({ payload: JSON.stringify(game().events[0]) }) }] };

test('campaign cards load before a long history and saving stays locked until it completes', async () => {
  let release, started;
  const pending = new Promise((resolve) => {
      release = resolve;
    }),
    loading = new Promise((resolve) => {
      started = resolve;
    });
  const f = await fixture({
    read: async (target) => {
      if (target.path.endsWith('/games')) return { docs: [savedRecord] };
      started();
      return pending;
    },
  });
  const login = f.login('owner');
  await loading;
  assert.equal(f.service.ready, false);
  assert.equal(f.sessions.at(-1).games[0].id, 'g1');
  assert.deepEqual(f.sessions.at(-1).games[0].events, []);
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  release(savedHistory);
  await login;
  assert.equal(f.service.ready, true);
  assert.equal(f.sessions.at(-1).games[0].events[0].id, 'e1');
});

test('failed history loads report an error without claiming an empty account and can be retried', async () => {
  let failed = true;
  const f = await fixture({
    read: async (target) => {
      if (target.path.endsWith('/games')) return { docs: [savedRecord] };
      if (failed) throw Object.assign(new Error('Offline'), { code: 'unavailable' });
      return savedHistory;
    },
  });
  await f.login('owner');
  assert.equal(f.service.ready, false);
  assert.equal(f.loadStates.at(-1).status, 'error');
  assert.equal(f.sessions.at(-1).games[0].id, 'g1');
  assert.equal(
    f.sessions.some((s) => s.ready),
    false,
  );
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  failed = false;
  await f.service.reload();
  assert.equal(f.loadStates.at(-1).status, 'ready');
  assert.equal(f.service.ready, true);
  await f.service.save([game()]);
  assert.equal(f.writes[0].length, 1, 'Previously saved events must not be rewritten after retry');
});

test('a late campaign response from a previous account is never displayed for the next account', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    read: async (target) => (target.path.startsWith('users/old/') ? pending : { docs: [] }),
  });
  const old = f.login('old');
  await f.login('new');
  const count = f.sessions.length;
  release({ docs: [savedRecord] });
  await old;
  assert.equal(f.sessions.length, count);
  assert.equal(f.service.user.uid, 'new');
  assert.deepEqual(f.sessions.at(-1).games, []);
});

test('a stalled campaign read becomes a retryable error and its late response cannot replace a retry', async () => {
  let release,
    blocked = true;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ loadTimeout: 5, read: async () => (blocked ? pending : { docs: [] }) });
  await f.login('owner');
  assert.equal(f.service.ready, false);
  assert.equal(f.loadStates.at(-1).error.code, 'deadline-exceeded');
  blocked = false;
  await f.service.reload();
  const count = f.sessions.length;
  release({ docs: [savedRecord] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sessions.length, count);
  assert.equal(f.service.ready, true);
  assert.deepEqual(f.sessions.at(-1).games, []);
});
