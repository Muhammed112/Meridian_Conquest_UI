import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { campaignRecord, eventRecord } from '../dist/game-schema.js';
import { committedHistory } from '../dist/campaign-history.js';
import { createCloudFixture } from './helpers/cloud.js';

/** Use the real cloud/store boundary with an isolated document map, never a Firebase project. */
async function savedFixture(games, { broken = false } = {}) {
  const paths = games.map((game) => `users/owner/games/${game.id}`);
  const reads = [];
  const fixture = await createCloudFixture({
    read: async (target) => {
      reads.push(target.path);
      if (target.path.endsWith('/games'))
        return {
          docs: [
            ...games.map((game, index) => ({
              id: game.id,
              ref: { path: paths[index] },
              data: () => fixture.documents.get(paths[index]),
            })),
            ...(broken
              ? [
                  {
                    id: 'damaged',
                    ref: { path: 'users/owner/games/damaged' },
                    data: () => ({ payload: '{broken' }),
                  },
                ]
              : []),
          ],
        };
      const events = [...fixture.documents]
        .filter(([path]) => path.startsWith(target.path + '/'))
        .map(([path, data]) => ({
          id: path.split('/').at(-1),
          order: data.sequence,
          data: () => data,
        }))
        .sort((left, right) => left.order - right.order);
      return {
        docs: events
          .filter((event) => event.order > (target.cursor?.order ?? -1))
          .slice(0, target.maximum ?? Infinity),
      };
    },
  });
  // Seed a committed predecessor chain; each scenario adds any orphaned uploads separately.
  for (const [index, game] of games.entries()) {
    fixture.documents.set(paths[index], {
      ...campaignRecord(game),
      saveRevision: 1,
      historyHead: game.events.at(-1)?.id || null,
    });
    game.events.forEach((event, sequence) =>
      fixture.documents.set(paths[index] + '/events/' + event.id, {
        ...eventRecord(event, sequence, game),
        previousEventId: game.events[sequence - 1]?.id || null,
      }),
    );
  }
  return { ...fixture, reads, paths };
}

// One damaged save must remain isolated so a player can still see and open healthy campaigns
// safely.
test('one malformed campaign cannot hide valid boards or overwrite the malformed record', async () => {
  const game = GameEngine.create('Healthy save', 'ZA', true);
  const fixture = await savedFixture([game], { broken: true });
  await fixture.login('owner');
  assert.equal(fixture.service.ready, true);
  assert.deepEqual(
    fixture.sessions.at(-1).games.map((item) => item.id),
    [game.id],
  );
  assert.equal(fixture.loadStates.at(-1).status, 'partial');
  assert.equal(
    fixture.reads.some((path) => path.endsWith('/events')),
    false,
  );
  await fixture.service.openCampaign(game.id);
  assert.equal(fixture.service.campaignState(game.id).status, 'ready');
  assert.equal(fixture.documents.get('users/owner/games/damaged').payload, '{broken');
  assert.equal(fixture.writes.length, 0);
});

// A long match must not make every campaign expensive to open; only selected history is paged in.
test('opening one large history reads bounded pages and never downloads another campaign history', async () => {
  const game = GameEngine.create('Long history', 'ZA', true);
  const engine = new GameEngine(game);
  for (let index = 0; index < 620; index++) engine.event('decision', 'Reviewing the board.');
  const other = GameEngine.create('Unopened', 'JP', true);
  const fixture = await savedFixture([game, other]);
  fixture.sdk.limit = (maximum) => ({ maximum });
  fixture.sdk.startAfter = (cursor) => ({ cursor });
  fixture.sdk.query = (target, ...constraints) => Object.assign({}, target, ...constraints);
  await fixture.login('owner');
  const loaded = await fixture.service.openCampaign(game.id);
  assert.equal(loaded.events.length, game.events.length);
  assert.equal(fixture.reads.filter((path) => path === fixture.paths[0] + '/events').length, 3);
  assert.equal(fixture.reads.includes(fixture.paths[1] + '/events'), false);
  assert.equal(fixture.service.campaignState(other.id).status, 'unloaded');
});

// Interrupted uploads are not committed history and must not make a healthy campaign unreadable.
test('a malformed uncommitted upload cannot prevent a valid saved history from opening', async () => {
  const game = GameEngine.create('Committed history', 'ZA', true);
  const fixture = await savedFixture([game]);
  fixture.documents.set(fixture.paths[0] + '/events/interrupted', {
    sequence: game.events.length,
    previousEventId: game.events.at(-1).id,
    payload: '{broken',
  });
  await fixture.login('owner');
  const loaded = await fixture.service.openCampaign(game.id);
  assert.deepEqual(loaded.events, game.events);
  assert.equal(fixture.writes.length, 0);
});

// Two devices must not silently overwrite each other or mix abandoned events into the winning
// replay.
test('a competing device save is not overwritten, and staged branch events do not enter replay', async () => {
  const original = GameEngine.create('Two devices', 'ZA', true);
  const fixture = await savedFixture([original]);
  await fixture.login('owner');
  const local = await fixture.service.openCampaign(original.id);
  new GameEngine(local).event('decision', 'Local branch.');
  const remote = structuredClone(original);
  new GameEngine(remote).event('decision', 'Other device branch.');
  const head = remote.events.at(-1);
  fixture.documents.set(fixture.paths[0] + '/events/' + head.id, {
    ...eventRecord(head, remote.events.length - 1, remote),
    previousEventId: original.events.at(-1).id,
  });
  // Change the remote revision after local loading to reproduce two-device contention.
  fixture.documents.set(fixture.paths[0], {
    ...campaignRecord(remote),
    saveRevision: 2,
    historyHead: head.id,
  });
  await assert.rejects(fixture.service.save([local]), { code: 'campaign/conflict' });
  assert.equal(fixture.documents.get(fixture.paths[0]).historyHead, head.id);
  assert.equal(fixture.service.campaignState(original.id).status, 'conflict');
  const loaded = await fixture.service.openCampaign(original.id, { retry: true });
  assert.equal(loaded.events.at(-1).text, 'Other device branch.');
  assert.equal(
    loaded.events.some((event) => event.id === local.events.at(-1).id),
    false,
  );
});

// Retrying a partial upload must finish the save without attempting forbidden rewrites of immutable
// facts.
test('an interrupted history upload can retry more than one batch without repeating immutable writes', async () => {
  const fixture = await savedFixture([]);
  const game = GameEngine.create('Offline backlog', 'ZA', true);
  for (let index = 0; index < 450; index++)
    new GameEngine(game).event('decision', 'Offline decision.');
  await fixture.login('owner');
  const originalBatch = fixture.sdk.writeBatch;
  let commits = 0;
  fixture.sdk.writeBatch = (...args) => {
    const batch = originalBatch(...args);
    const commit = batch.commit;
    batch.commit = async () => {
      // The first batch really commits before the connection fails, exercising a partial upload.
      if (++commits === 2) throw new Error('Connection interrupted.');
      return commit();
    };
    return batch;
  };
  await assert.rejects(fixture.service.save([game]), /Connection interrupted/);
  assert.equal(fixture.documents.has(`users/owner/games/${game.id}`), false);
  await fixture.service.save([game]);
  const writes = fixture.writes.flat().filter(([path]) => path.includes('/events/'));
  assert.equal(writes.length, game.events.length);
  assert.equal(new Set(writes.map(([path]) => path)).size, game.events.length);
  assert.equal(
    fixture.documents.get(`users/owner/games/${game.id}`).historyHead,
    game.events.at(-1).id,
  );
});

// History links must fail safely on corruption while preserving compatibility with pre-link saves.
test('missing or cyclic committed history is rejected while legacy history remains readable', () => {
  const legacy = [{ sequence: 0, event: { id: 'old' } }];
  const linked = { sequence: 1, event: { id: 'new' }, previousEventId: 'old' };
  const staged = { sequence: 1, event: { id: 'staged' }, previousEventId: 'old' };
  assert.deepEqual(committedHistory([...legacy, linked, staged], undefined), legacy);
  assert.deepEqual(committedHistory([...legacy, linked, staged], 'new'), [...legacy, linked]);
  assert.throws(() => committedHistory([linked], 'new'), /incomplete or invalid/);
  assert.throws(
    () => committedHistory([{ ...linked, previousEventId: 'new' }], 'new'),
    /incomplete or invalid/,
  );
});
