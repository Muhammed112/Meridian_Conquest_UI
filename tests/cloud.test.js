import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudFixture as fixture } from './helpers/cloud.js';
import { commentaryFacts } from '../dist/commentary-validation.js';
import { GameEngine } from '../dist/engine.js';

// Include generated text deliberately so save tests prove that factual storage strips it.
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

// Private reads must wait until tab-only persistence is configured, preventing unintended durable
// sign-in.
test('account restoration uses tab-session persistence before accessing private campaigns', async () => {
  const f = await fixture();
  await f.login('owner');
  assert.equal(f.service.user.uid, 'owner');
  assert.equal(f.service.ready, true);
});

// Editing a nickname must not reload the account or touch saved progress as a side effect.
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

// Invalid input and signed-out actions must be stopped before they reach the account write
// boundary.
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

// An offline profile write must not falsely show a nickname that Firebase has not accepted.
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

// A delayed response from a former account must not rename the player who signed in afterward.
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
  // Start a blocked write, switch accounts, then release its delayed completion below.
  const updating = f.service.updateNickname('Old player nickname');
  await writing;
  await f.login('new');
  release();
  await assert.rejects(updating, /account changed/);
  assert.equal(f.service.user.uid, 'new');
  assert.equal(f.service.user.displayName, 'Original nickname');
  assert.equal(f.profiles.length, 0);
});

// Failure to establish tab-only persistence must not silently fall back to a longer-lived session.
test('unavailable session persistence prevents authentication startup', async () => {
  const error = new Error('Session storage unavailable');
  await assert.rejects(fixture({ persistenceError: error }), error);
});

// Signed-out browser state must never create private writes or listeners using a stale account.
test('signed-out clients do not write or subscribe to private campaigns', async () => {
  const f = await fixture();
  await f.login(null);
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.subscriptions.length, 0);
});

// Recorded gameplay must remain immutable and separate from generated text so future AI input stays
// factual.
test('campaign events are saved immutably and narration is excluded from model facts', async () => {
  const f = await fixture();
  await f.login('owner');
  const campaign = game();
  await f.service.save([campaign]);
  const batch = f.writes.flat();
  assert.equal(batch[0][0], 'users/owner/games/g1/events/e1');
  assert.equal(batch[1][0], 'users/owner/games/g1');
  assert.equal(JSON.parse(batch[0][1].payload).commentary, undefined);
  assert.equal(JSON.parse(batch[0][1].context).event.commentary, undefined);
  assert.equal(batch[0][1].sequence, 0);
  assert.equal(batch[1][1].historyHead, 'e1');
  assert.equal(batch[1][1].saveRevision, 1);
  const writes = f.writes.length;
  await f.service.save([campaign]);
  assert.equal(f.writes.length, writes, 'Unchanged boards and immutable events are not rewritten');
  assert.equal(f.subscriptions.length, 3);
});

// Failed writes must remain retryable; marking them saved early would permanently lose recorded
// events.
test('a failed batch can retry its events instead of treating them as already saved', async () => {
  const f = await fixture();
  await f.login('owner');
  f.setFailure(true);
  await assert.rejects(f.service.save([game()]));
  f.setFailure(false);
  await f.service.save([game()]);
  assert.equal(f.writes[0][0][0], 'users/owner/games/g1/events/e1');
});

// Bot-versus-bot action must enter the same automatic narration path as player combat.
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
      reports: tasks.map(({ eventId, context }) => ({
        eventId,
        text: 'The recorded battle continues.',
        facts: commentaryFacts(context),
      })),
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

// Queued work must retain its original account boundary instead of using whoever is signed in at
// execution.
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

// Keep legacy loading covered alongside the newer revisioned store tests.
const savedRecord = {
  ref: { path: 'users/owner/games/g1' },
  data: () => ({ payload: JSON.stringify(game()) }),
};
const savedHistory = { docs: [{ data: () => ({ payload: JSON.stringify(game().events[0]) }) }] };

// A campaign list must stay usable while only the chosen campaign waits for its full history.
test('campaign cards load without history reads and only the selected history is locked while loading', async () => {
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
  await f.login('owner');
  assert.equal(f.service.ready, true);
  assert.equal(f.service.campaignState('g1').status, 'unloaded');
  // Hold history delivery to inspect state and attempted saves while loading remains incomplete.
  const opening = f.service.openCampaign('g1');
  await loading;
  assert.equal(f.service.campaignState('g1').status, 'loading');
  assert.equal(f.sessions.at(-1).games[0].id, 'g1');
  assert.deepEqual(f.sessions.at(-1).games[0].events, []);
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  release(savedHistory);
  const loaded = await opening;
  assert.equal(f.service.ready, true);
  assert.equal(loaded.events[0].id, 'e1');
  assert.equal(f.service.campaignState('g1').status, 'ready');
});

// A history outage must remain distinguishable from an empty account and must allow a safe retry.
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
  await assert.rejects(f.service.openCampaign('g1'), /Offline/);
  assert.equal(f.service.ready, true);
  assert.equal(f.service.campaignState('g1').status, 'error');
  assert.equal(f.sessions.at(-1).games[0].id, 'g1');
  await f.service.save([game()]);
  assert.equal(f.writes.length, 0);
  failed = false;
  await f.service.openCampaign('g1', { retry: true });
  assert.equal(f.service.ready, true);
  await f.service.save([game()]);
  assert.equal(
    f.writes.flat().filter(([path]) => path.includes('/events/')).length,
    0,
    'Previously saved events must not be rewritten after retry',
  );
});

// Late account reads must be discarded so another player's campaign names never appear after
// sign-in.
test('a late campaign response from a previous account is never displayed for the next account', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    read: async (target) => (target.path.startsWith('users/old/') ? pending : { docs: [] }),
  });
  // Finish the former account read only after the new account has completed restoration.
  const old = f.login('old');
  await f.login('new');
  const count = f.sessions.length;
  release({ docs: [savedRecord] });
  await old;
  assert.equal(f.sessions.length, count);
  assert.equal(f.service.user.uid, 'new');
  assert.deepEqual(f.sessions.at(-1).games, []);
});

// A stalled request must release the loading screen, and its late completion must not undo a newer
// retry.
test(
  'a stalled campaign read becomes a retryable error and its late response' +
    ' cannot replace a retry',
  async () => {
    let release,
      blocked = true;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      // Shorten the injected deadline to exercise recovery without a 30-second unit-test wait.
      loadTimeout: 5,
      read: async () => (blocked ? pending : { docs: [] }),
    });
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
  },
);
