import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { createSpectatorService, spectatorPayload, readSpectatorGame } from '../dist/spectators.js';
import { findCountry } from '../dist/data.js';

/** Observe sharing and account changes without publishing private gameplay to Firebase. */
function fixture() {
  let user = { uid: 'owner' },
    receive,
    failure;
  const records = new Map(),
    writes = [];
  const sdk = {
    doc: (_, ...parts) => parts.join('/'),
    collection: (_, name) => name,
    where: () => ({}),
    query: (target) => target,
    serverTimestamp: () => 123,
    getDocs: async () => ({
      docs: [...records].map(([path, value]) => ({
        id: path.split('/').at(-1),
        data: () => value,
      })),
    }),
    setDoc: async (path, value) => {
      writes.push([path, value]);
      records.set(path, value);
    },
    deleteDoc: async (path) => {
      records.delete(path);
    },
    onSnapshot: (_, callback, onError) => {
      receive = callback;
      failure = onError;
      return () => {
        receive = null;
      };
    },
  };
  const service = createSpectatorService({
    db: {},
    sdk,
    getUser: () => user,
    leaseOptions: { now: () => 123 },
  });
  return {
    service,
    records,
    writes,
    sdk,
    user: (value) => {
      user = value;
    },
    emit: (value) =>
      receive({ exists: () => Boolean(value), data: () => value && { updatedAt: 123, ...value } }),
    fail: (error) => failure(error),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

// Capture the remote snapshot when restore begins, then let the test deliver that old snapshot.
function delayRestore(f) {
  const delivery = deferred(),
    restoring = f.service.restore(() => {
      const snapshot = f.sdk.getDocs();
      return delivery.promise.then(() => snapshot);
    });
  return async () => {
    delivery.resolve();
    await restoring;
  };
}

// Sharing must expose only an intentional gameplay snapshot, with stable IDs and bounded recent
// history.
test(
  'public games contain only gameplay fields, retain stable event IDs, and' +
    ' preserve nicknames and reports',
  () => {
    const game = GameEngine.create('Public view', 'ZA', true, 'medium', 'Mo');
    game.email = 'private@example.invalid';
    game.countries[0].secret = 'private country field';
    game.populationSource.secret = 'private population field';
    game.events[0].secret = 'private event field';
    game.events[0].commentary = '<script>unsafe text</script>';
    const payload = spectatorPayload(game),
      shared = readSpectatorGame(payload);
    assert.doesNotMatch(
      payload,
      /private@example|private country|private population|private event/,
    );
    assert.equal(shared.events[0].id, game.events[0].id);
    assert.equal(shared.playerNames[0], 'Mo');
    assert.equal(shared.events[0].commentary, game.events[0].commentary);
    assert.equal(shared.countries[0].name, game.countries[0].name);
    for (let i = 0; i < 80; i++) new GameEngine(game).event('decision', 'Next decision');
    assert.equal(readSpectatorGame(spectatorPayload(game)).events.length, 60);
  },
);

// Visitors need the same recorded pact facts for the board and replay, without receiving
// arbitrary negotiation or account metadata that may be added to future internal objects.
test('spectator projection retains safe diplomacy history and rejects malformed pact data', () => {
  const game = GameEngine.create('Public diplomacy', 'ZA', true),
    engine = new GameEngine(game);
  engine.event('decision', 'Mo and Atlas agree to cooperate.', {
    diplomacy: {
      action: 'accepted',
      proposer: 0,
      target: 2,
      reason: 'A shared rival controls more countries.',
      expiresRound: game.round + 3,
    },
    diplomacyState: {
      alliances: [{ players: [0, 2], startedRound: game.round, expiresRound: game.round + 3 }],
      trust: [{ observer: 2, other: 0, value: 60 }],
      lastOffers: [{ player: 0, round: game.round }],
    },
  });
  const event = game.events.at(-1),
    shared = readSpectatorGame(spectatorPayload(game)),
    publicEvent = shared.events.at(-1);
  assert.deepEqual(publicEvent.diplomacy, event.diplomacy);
  assert.deepEqual(publicEvent.diplomacyState, event.diplomacyState);
  publicEvent.diplomacyState.alliances[0].players[0] = 9;
  assert.equal(
    event.diplomacyState.alliances[0].players[0],
    0,
    'Public copies cannot mutate saves',
  );
  const invalid = structuredClone(game);
  invalid.events.at(-1).diplomacyState.trust[0].value = 101;
  assert.throws(() => spectatorPayload(invalid), /invalid saved data/);
  assert.throws(() => readSpectatorGame(JSON.stringify(invalid)), /invalid saved data/);
});

// Invalid public data must be rejected rather than render an impossible board or ambiguous
// duplicate event.
test('malformed live boards, duplicate event IDs and impossible dice losses are rejected', () => {
  const game = GameEngine.create('Validation', 'ZA', true);
  assert.throws(() => readSpectatorGame('{broken'));
  assert.throws(() => readSpectatorGame('x'.repeat(500001)));
  for (const change of [
    (g) => {
      g.countries[0].army = -1;
    },
    (g) => {
      g.events.push(g.events[0]);
    },
    (g) => {
      g.events[0].type = 'dice';
      g.events[0].from = 'invalid';
      g.events[0].to = g.countries[1].code;
    },
    (g) => {
      g.events[0].pairs = [{ index: 1, a: 6, d: 1 }];
      g.events[0].attackerLoss = 1;
    },
  ]) {
    const copy = structuredClone(game);
    change(copy);
    assert.throws(() => readSpectatorGame(JSON.stringify(copy)));
  }
});

// Imported rendering hints and dice labels must not become an HTML-injection path for visitors.
test('untrusted public rendering flags and dice-pair labels cannot inject markup', () => {
  const game = GameEngine.create('Untrusted public content', 'ZA', true);
  game.presentationPending = true;
  game.email = 'private';
  game.events[0].pairs = [{ index: '"><script>unsafe</script>', a: 6, d: 1 }];
  const shared = readSpectatorGame(JSON.stringify(game));
  assert.equal(shared.presentationPending, undefined);
  assert.equal(shared.email, undefined);
  assert.equal(shared.events[0].pairs[0].index, 1);
});

// Existing public records must restore a valid board without losing their ongoing battle or report IDs.
test('public country replacements keep battle and replay references while stripping private fields', () => {
  const game = GameEngine.create('Public campaign', 'ZA', true);
  const originalCode = game.countries[0].code;
  game.countries[0] = { ...findCountry('IL'), owner: 0, army: 17 };
  game.start = 'IL';
  game.events.forEach((event) => {
    event.board.find((country) => country.code === originalCode).code = 'IL';
  });
  game.budget = 0;
  new GameEngine(game).startAttack('IL', game.countries[1].code);
  game.email = 'private@example.invalid';
  const shared = readSpectatorGame(JSON.stringify(game));
  const replacement = shared.countries[0].code;
  assert.notEqual(replacement, 'IL');
  assert.equal(shared.start, replacement);
  assert.equal(shared.battle.from, replacement);
  assert.equal(shared.battle.to, game.battle.to);
  assert.equal(shared.countries[0].army, 17);
  assert.deepEqual(
    shared.events.map((event) => event.id),
    game.events.map((event) => event.id),
  );
  assert.ok(shared.events.every((event) => event.board[0].code === replacement));
  assert.equal(shared.events.at(-1).from, replacement);
  assert.equal(shared.email, undefined);
  assert.equal(shared.updatedAt, game.updatedAt);
  assert.equal(game.battle.from, 'IL', 'Visitors cannot mutate the owner’s original record.');
});

// Games must stay private until explicitly shared, and revocation must prevent later automatic
// publishing.
test('publishing is opt-in, survives account restoration, and stops when sharing is revoked', async () => {
  const f = fixture(),
    game = GameEngine.create('Share lifecycle', 'ZA', true);
  await f.service.publish(game);
  assert.equal(f.writes.length, 0);
  await f.service.start(game);
  assert.equal(f.writes.length, 1);
  f.service.reset();
  await f.service.restore();
  assert.equal(f.service.isShared(game.id), true);
  new GameEngine(game).event('decision', 'A later turn');
  await f.service.publish(game);
  assert.match(f.records.get('liveGames/' + game.id).payload, /A later turn/);
  await f.service.stop(game.id);
  await f.service.publish(game);
  assert.equal(f.records.size, 0);
  assert.equal(f.service.isShared(game.id), false);
});

// Sign-in restoration can finish after the owner has already stopped one of its old shares.
test('late restoration cannot revive a revoked share and still restores unrelated games', async () => {
  const f = fixture(),
    game = GameEngine.create('Revoked during sign-in', 'ZA', true),
    unrelated = GameEngine.create('Still shared', 'ZA', true);
  await f.service.start(game);
  await f.service.start(unrelated);
  f.service.reset();
  const finishRestore = delayRestore(f);
  await f.service.start(game);
  await f.service.stop(game.id);
  await finishRestore();

  assert.equal(f.service.isShared(game.id), false);
  assert.equal(f.service.isShared(unrelated.id), true);
  const writes = f.writes.length;
  await f.service.publish(game);
  assert.equal(f.writes.length, writes, 'A normal save cannot recreate the revoked document.');
  assert.equal(f.records.has('liveGames/' + game.id), false);
  new GameEngine(unrelated).event('decision', 'The other share remains active');
  await f.service.publish(unrelated);
  assert.equal(f.writes.length, writes + 1);
});

test('the owner can explicitly share again after revocation and a delayed restore', async () => {
  const f = fixture(),
    game = GameEngine.create('Share again', 'ZA', true);
  await f.service.start(game);
  f.service.reset();
  const finishRestore = delayRestore(f);
  await f.service.start(game);
  await f.service.stop(game.id);
  await f.service.start(game);
  await finishRestore();

  assert.equal(f.service.isShared(game.id), true);
  new GameEngine(game).event('decision', 'An explicitly shared later turn');
  await f.service.publish(game);
  assert.match(f.records.get('liveGames/' + game.id).payload, /An explicitly shared later turn/);
});

for (const uid of ['owner', 'other']) {
  test(`a reset discards an old restoration before account ${uid} shares again`, async () => {
    const f = fixture(),
      oldGame = GameEngine.create('Old account game', 'ZA', true),
      currentGame = GameEngine.create('Current account game', 'ZA', true);
    await f.service.start(oldGame);
    f.service.reset();
    const finishRestore = delayRestore(f);
    f.service.reset();
    f.user({ uid });
    await f.service.start(currentGame);
    await finishRestore();

    assert.equal(f.service.isShared(oldGame.id), false);
    assert.equal(f.service.isShared(currentGame.id), true);
    const writes = f.writes.length;
    await f.service.publish(oldGame);
    assert.equal(f.writes.length, writes);
    assert.equal(f.records.get('liveGames/' + currentGame.id).ownerUid, uid);
  });
}

// An older failure must not undo a newer successful revocation of the same share.
test('an overlapping failed stop cannot re-enable sharing after a later stop succeeds', async () => {
  const f = fixture(),
    game = GameEngine.create('Overlapping stops', 'ZA', true),
    entered = deferred(),
    deletion = deferred(),
    deleteDoc = f.sdk.deleteDoc;
  await f.service.start(game);
  let deletions = 0;
  f.sdk.deleteDoc = async (path) => {
    if (++deletions === 1) {
      entered.resolve();
      return deletion.promise;
    }
    return deleteDoc(path);
  };
  const firstStop = f.service.stop(game.id),
    firstFailure = assert.rejects(firstStop, /offline/);
  await entered.promise;
  const laterStop = f.service.stop(game.id);
  deletion.reject(new Error('offline'));
  await firstFailure;
  await laterStop;

  assert.equal(f.service.isShared(game.id), false);
  const writes = f.writes.length;
  await f.service.publish(game);
  assert.equal(f.writes.length, writes);
  assert.equal(f.records.has('liveGames/' + game.id), false);
});

// Repeated clicks share one confirmed remote state; optimistic changes are not a success baseline.
test('overlapping failed starts leave an initially private game private', async () => {
  const f = fixture(),
    game = GameEngine.create('Overlapping starts fail', 'ZA', true),
    entered = deferred(),
    publication = deferred();
  let publications = 0;
  f.sdk.setDoc = async () => {
    if (++publications === 1) {
      entered.resolve();
      await publication.promise;
    }
    throw new Error('offline');
  };
  const firstFailure = assert.rejects(f.service.start(game), /offline/);
  await entered.promise;
  const laterFailure = assert.rejects(f.service.start(game), /offline/);
  publication.resolve();
  await Promise.all([firstFailure, laterFailure]);

  assert.equal(f.service.isShared(game.id), false);
  assert.equal(f.records.has('liveGames/' + game.id), false);
});

test('overlapping failed stops keep an existing share available to retry', async () => {
  const f = fixture(),
    game = GameEngine.create('Overlapping stops fail', 'ZA', true),
    entered = deferred(),
    deletion = deferred();
  await f.service.start(game);
  let deletions = 0;
  f.sdk.deleteDoc = async () => {
    if (++deletions === 1) {
      entered.resolve();
      await deletion.promise;
    }
    throw new Error('offline');
  };
  const firstFailure = assert.rejects(f.service.stop(game.id), /offline/);
  await entered.promise;
  const laterFailure = assert.rejects(f.service.stop(game.id), /offline/);
  deletion.resolve();
  await Promise.all([firstFailure, laterFailure]);

  assert.equal(f.service.isShared(game.id), true);
  assert.equal(f.records.has('liveGames/' + game.id), true);
});

// A rejected write from the previous session must not roll back the current account's opt-in.
test('a failed old-account start cannot remove a new-account share of the same game', async () => {
  const f = fixture(),
    game = GameEngine.create('Share across accounts', 'ZA', true),
    entered = deferred(),
    publication = deferred(),
    setDoc = f.sdk.setDoc;
  let publications = 0;
  f.sdk.setDoc = async (path, value) => {
    if (++publications === 1) {
      entered.resolve();
      return publication.promise;
    }
    return setDoc(path, value);
  };
  const oldStart = f.service.start(game),
    oldFailure = assert.rejects(oldStart, /offline/);
  await entered.promise;
  f.service.reset();
  f.user({ uid: 'other' });
  const currentStart = f.service.start(game);
  publication.reject(new Error('offline'));
  await oldFailure;
  await currentStart;

  assert.equal(f.service.isShared(game.id), true);
  assert.equal(f.records.get('liveGames/' + game.id).ownerUid, 'other');
});

// Watching must work without an account while distinguishing removal from invalid or failed live
// data.
test('visitors can subscribe without signing in and invalid data reaches the error callback', () => {
  const f = fixture(),
    game = GameEngine.create('Visitor', 'ZA', true),
    updates = [],
    errors = [];
  f.user(null);
  const stop = f.service.watch(
    game.id,
    (game) => updates.push(game),
    (error) => errors.push(error),
  );
  f.emit({ payload: spectatorPayload(game) });
  f.emit(null);
  f.emit({ payload: '{}' });
  assert.equal(updates[0].id, game.id);
  assert.equal(updates[1], null);
  assert.equal(errors.length, 1);
  stop();
  assert.equal(f.writes.length, 0);
});

// Delayed publishing must not borrow a different player's identity after an account switch.
test('signed-out publishing and old-account queued writes cannot publish as another account', async () => {
  const f = fixture(),
    game = GameEngine.create('Account isolation', 'ZA', true);
  f.user(null);
  await assert.rejects(f.service.start(game), /Sign in/);
  f.user({ uid: 'owner' });
  const publishing = f.service.start(game);
  f.service.reset();
  f.user({ uid: 'other' });
  await assert.rejects(publishing, /account changed/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.service.isShared(game.id), false);
});

// An offline revocation must remain visible and retryable instead of falsely telling the owner
// sharing stopped.
test('failed revocation keeps the stop-sharing control available to retry', async () => {
  const f = fixture(),
    game = GameEngine.create('Stop retry', 'ZA', true),
    deleteDoc = f.sdk.deleteDoc;
  await f.service.start(game);
  f.sdk.deleteDoc = async () => {
    throw new Error('offline');
  };
  await assert.rejects(f.service.stop(game.id), /offline/);
  assert.equal(f.service.isShared(game.id), true);
  assert.equal(f.records.has('liveGames/' + game.id), true);
  f.sdk.deleteDoc = deleteDoc;
  await f.service.stop(game.id);
  assert.equal(f.service.isShared(game.id), false);
  const writes = f.writes.length;
  await f.service.publish(game);
  assert.equal(f.writes.length, writes);
  assert.equal(f.records.has('liveGames/' + game.id), false);
});
