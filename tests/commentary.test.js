import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import {
  parseCommentaryContext,
  cleanCommentary,
  isNarratedEventType,
} from '../functions/commentary.js';

test('commentary context preserves actual dice losses and immutable board facts', () => {
  const game = GameEngine.create('Commentary fixture', 'ZA', true);
  const engine = new GameEngine(game);
  game.position = game.order.indexOf(0);
  game.budget = 0;
  game.battle = null;
  game.attackUsed = false;
  const attacker = game.countries[0],
    defender = game.countries.find((c) => c.owner !== 0);
  attacker.army = 5;
  defender.army = 3;
  engine.startAttack(attacker.code, defender.code);
  const before = structuredClone(
    game.countries.map((c) => ({ code: c.code, owner: c.owner, army: c.army })),
  );
  let n = 0;
  engine.roll(() => (++n % 2 ? 6 : 1));
  const event = game.events.findLast((e) => e.type === 'dice');
  const context = parseCommentaryContext(JSON.stringify({ event, previousBoard: before }));
  assert.equal(context.event.attackerLoss, 0);
  assert.equal(context.event.defenderLoss, 3);
  assert.equal(context.event.board.find((c) => c.code === defender.code).army, 0);
  assert.equal(context.previousBoard.find((c) => c.code === defender.code).army, 3);
  assert.equal(game.events.findLast((e) => e.type === 'conquest').country, defender.code);
});
test('invalid, oversized and non-narrated events cannot become LLM requests', () => {
  for (const raw of [
    undefined,
    null,
    'bad JSON',
    'null',
    'false',
    '42',
    '[]',
    '{}',
    JSON.stringify({ event: null }),
    JSON.stringify({ event: { type: 'dice', text: 42 } }),
    JSON.stringify({ event: { type: 'turn', text: 'turn' } }),
    'x'.repeat(60001),
  ])
    assert.throws(() => parseCommentaryContext(raw), /Invalid (event context|commentary event)/);
  assert.equal(isNarratedEventType('decision'), true);
});

test('server commentary accepts every supported event and contexts at the exact size limit', () => {
  for (const type of [
    'attack',
    'dice',
    'retreat',
    'held',
    'conquest',
    'elimination',
    'victory',
    'decision',
  ]) {
    const context = { event: { type, text: 'Recorded event' } };
    assert.equal(isNarratedEventType(type), true);
    assert.deepEqual(parseCommentaryContext(JSON.stringify(context)), context);
  }
  assert.equal(isNarratedEventType('unknown'), false);
  const context = { event: { type: 'dice', text: 'Recorded result' } };
  const serializedContext = JSON.stringify(context).padEnd(60_000, ' ');
  assert.deepEqual(parseCommentaryContext(serializedContext), context);
  assert.throws(() => parseCommentaryContext(serializedContext + ' '), /Invalid event context/);
});
test('empty responses fall back and commentary stays short and plain text', () => {
  assert.throws(() => cleanCommentary('  '));
  assert.throws(() => cleanCommentary(undefined));
  assert.equal(cleanCommentary('  Brazil\n holds.  '), 'Brazil holds.');
  assert.equal(cleanCommentary(Array(80).fill('word').join(' ')).split(' ').length, 35);
  assert.equal(cleanCommentary('x'.repeat(600)), 'x'.repeat(500));
});

import {
  COMMENTARY_VERSION,
  CommentaryQueue,
  commentaryContext,
  commentaryRequest,
  parseCommentaryBatch,
  recentCommentaryTasks,
  commentaryErrorMessage,
  applyCommentary,
  cleanCommentary as cleanLiveCommentary,
} from '../dist/commentary.js';
const task = (id, type = 'dice') => ({
  key: 'g/' + id,
  eventId: id,
  context: { event: { id, type, text: 'Recorded result' } },
});
const response = (tasks) =>
  JSON.stringify({
    reports: tasks.map((t) => ({ eventId: t.eventId, text: 'The recorded battle continues.' })),
  });
function queue(options = {}) {
  const writes = [],
    seen = [];
  const q = new CommentaryQueue({
    generate: async (tasks) => {
      seen.push(tasks);
      return response(tasks);
    },
    persist: async (t, text) => {
      writes.push(t.eventId);
      return { status: 'ready', text };
    },
    setTimer: () => 1,
    clearTimer: () => {},
    ...options,
  });
  return { q, writes, seen };
}
test('only fresh eligible events are generated, once, in bounded batches', async () => {
  const { q, writes, seen } = queue();
  const independentTasks = Array.from({ length: 8 }, (_, i) => ({
    ...task('n' + i),
    gameId: 'game' + i,
  }));
  q.enqueue([
    independentTasks[0],
    independentTasks[0],
    task('turn', 'turn'),
    ...independentTasks.slice(1),
  ]);
  await q.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 6);
  assert.equal(new Set(writes).size, 6);
  await q.drain();
  assert.equal(writes.length, 8);
  assert.equal(q.pending.length, 0);
});
test('saved commentary is reused without making a model request', async () => {
  const generated = [],
    reported = [];
  const { q } = queue({
    lookup: async () => ({ status: 'ready', text: 'Saved report.' }),
    generate: async () => {
      generated.push(true);
    },
    onReport: (_, result) => reported.push(result.text),
  });
  q.enqueue([task('cached')]);
  await q.drain();
  assert.equal(generated.length, 0);
  assert.deepEqual(reported, ['Saved report.']);
});
test('signing out during a model request discards its response without saving', async () => {
  let release, started;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    running = new Promise((resolve) => {
      started = resolve;
    });
  const { q, writes } = queue({
    generate: async (tasks) => {
      started();
      await gate;
      return response(tasks);
    },
  });
  q.enqueue([task('old-session')]);
  const pending = q.drain();
  await running;
  q.reset();
  release();
  await pending;
  assert.deepEqual(writes, []);
});
test('disabled commentary makes no requests and quota errors keep factual gameplay available', async () => {
  const off = queue({ enabled: false });
  off.q.enqueue([task('off')]);
  await off.q.drain();
  assert.equal(off.seen.length, 0);
  const broken = queue({
    generate: async () => {
      throw new Error('429 quota');
    },
  });
  broken.q.enqueue([task('quota')]);
  await broken.q.drain();
  assert.equal(broken.q.status, 'unavailable');
  assert.deepEqual(broken.writes, []);
  assert.equal(broken.q.running, false);
});
test('fast-forward keeps only the newest pending event at the same priority', () => {
  const { q } = queue();
  q.enqueue(Array.from({ length: 100 }, (_, i) => task('event' + i)));
  assert.equal(q.pending.length, 1);
  assert.equal(q.pending[0].eventId, 'event99');
  assert.equal(q.states.get('g/event98'), 'skipped');
  assert.equal(q.states.get('g/event99'), 'queued');
});
test('pending narration favours battle outcomes and casualties over quieter events', async () => {
  const { q, writes } = queue();
  const tiedDice = task('tie');
  Object.assign(tiedDice.context.event, { attackerLoss: 0, defenderLoss: 0 });
  q.enqueue([task('decision', 'decision'), task('attack', 'attack'), task('losses'), tiedDice]);
  assert.equal(q.pending[0].eventId, 'losses');
  q.enqueue([task('held', 'held'), task('retreat', 'retreat'), task('later-losses')]);
  assert.equal(q.pending[0].eventId, 'retreat');
  q.enqueue([task('capture', 'conquest'), task('later-attack', 'attack')]);
  assert.equal(q.pending[0].eventId, 'capture');
  q.enqueue([task('eliminated', 'elimination'), task('later-capture', 'conquest')]);
  assert.equal(q.pending[0].eventId, 'eliminated');
  q.enqueue([task('won', 'victory'), task('later-elimination', 'elimination')]);
  assert.equal(q.pending[0].eventId, 'won');
  await q.drain();
  assert.deepEqual(writes, ['won']);
  assert.equal(q.states.get('g/tie'), 'skipped');
  assert.equal(q.states.get('g/later-elimination'), 'skipped');
});

test('priority selection stays isolated by account, campaign and multiplayer room', async () => {
  const { q, writes } = queue();
  const scopes = [
    { uid: 'alice', gameId: 'one' },
    { uid: 'alice', gameId: 'two' },
    { uid: 'bob', gameId: 'one' },
    { uid: 'alice', roomCode: 'ABC123' },
    { uid: 'alice', roomCode: 'DEF456' },
    { uid: 'bob', roomCode: 'ABC123' },
  ];
  q.enqueue(scopes.map((scope, i) => ({ ...task('event' + i), ...scope })));
  q.enqueue([{ ...task('winner', 'victory'), ...scopes[0] }]);
  assert.equal(q.pending.length, scopes.length);
  await q.drain();
  assert.deepEqual(writes, ['winner', 'event1', 'event2', 'event3', 'event4', 'event5']);
});

test('pending work stays bounded across many independent matches', () => {
  const { q } = queue();
  q.enqueue(Array.from({ length: 20 }, (_, i) => ({ ...task('event' + i), gameId: 'game' + i })));
  assert.equal(q.pending.length, 12);
  assert.equal(q.pending[0].eventId, 'event8');
  assert.equal(q.states.get('g/event7'), 'skipped');
});

test('a major outcome overtakes a slower in-flight report without saving stale narration', async () => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers(),
    reported = [];
  const { q, writes } = queue({
    generate: async (tasks) => {
      started.resolve();
      await release.promise;
      return response(tasks);
    },
    onReport: (task) => reported.push(task.eventId),
  });
  q.enqueue([task('losses')]);
  const running = q.drain();
  await started.promise;
  q.enqueue([task('capture', 'conquest')]);
  release.resolve();
  await running;
  assert.deepEqual(writes, []);
  assert.deepEqual(reported, []);
  assert.equal(q.states.get('g/losses'), 'skipped');
  await q.drain();
  assert.deepEqual(writes, ['capture']);
  assert.deepEqual(reported, ['capture']);
});

test('an unusable superseded response does not put the latest outcome on an error cooldown', async () => {
  const { q, writes } = queue({
    generate: async () => {
      q.enqueue([task('capture', 'conquest')]);
      return 'invalid JSON';
    },
  });
  q.enqueue([task('losses')]);
  await q.drain();
  assert.deepEqual(writes, []);
  assert.equal(q.states.get('g/losses'), 'skipped');
  assert.equal(q.pending[0].eventId, 'capture');
  assert.equal(q.status, 'ready');
  assert.equal(q.errorMessage, '');
});

test('equal-priority updates cannot starve an in-flight report during fast-forward', async () => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const { q, writes } = queue({
    generate: async (tasks) => {
      started.resolve();
      await release.promise;
      return response(tasks);
    },
  });
  q.enqueue([task('first')]);
  const running = q.drain();
  await started.promise;
  q.enqueue([task('second'), task('latest')]);
  release.resolve();
  await running;
  assert.deepEqual(writes, ['first']);
  assert.equal(q.states.get('g/second'), 'skipped');
  await q.drain();
  assert.deepEqual(writes, ['first', 'latest']);
});

test('work superseded during cache lookup never reaches Gemini', async () => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const { q, seen } = queue({
    lookup: async () => {
      started.resolve();
      await release.promise;
      return null;
    },
  });
  q.enqueue([task('losses')]);
  const running = q.drain();
  await started.promise;
  q.enqueue([task('won', 'victory')]);
  release.resolve();
  await running;
  assert.equal(seen.length, 0);
  assert.equal(q.states.get('g/losses'), 'skipped');
  await q.drain();
  assert.equal(seen[0][0].eventId, 'won');
});

test('Gemini output is matched to requested event IDs and incomplete output is rejected', () => {
  const result = parseCommentaryBatch(
    JSON.stringify({
      reports: [
        { eventId: 'unrelated', text: 'Ignore' },
        { eventId: 'a', text: 'Valid report.' },
      ],
    }),
    [task('a')],
  );
  assert.equal(result.size, 1);
  assert.equal(result.get('a'), 'Valid report.');
  assert.throws(() => parseCommentaryBatch('{"reports":[]}', [task('a')]));
});
test('narration context excludes previous AI text and preserves the event board rather than the later board', () => {
  const game = GameEngine.create('Facts', 'ZA', true),
    event = game.events[0];
  event.commentary = 'Generated claim';
  const before = JSON.stringify(event.board);
  game.countries[0].army += 20;
  const context = commentaryContext(game, event);
  assert.equal(context.event.commentary, undefined);
  assert.equal(JSON.stringify(context.event.board), before);
});

test('commentary uses neutral names while preserving saved nicknames and factual log text', () => {
  const game = GameEngine.create('Broadcast names', 'ZA', true);
  const original = JSON.stringify(game);
  const event = game.events.at(-1);
  assert.equal(
    commentaryContext(game, event).match.standings.find((row) => row.player === 0).name,
    'Commander 1',
  );
  assert.equal(JSON.stringify(game), original);
  game.playerNames = [
    'Mo',
    'Kestrel',
    'Atlas',
    'Vesper',
    'Orion',
    'Flint',
    'Sable',
    'Rook',
    'Nova',
    'Echo',
  ];
  assert.equal(
    commentaryContext(game, event).match.standings.find((row) => row.player === 0).name,
    'Mo',
  );
  assert.equal(event.text, JSON.parse(original).events.at(-1).text);
});

test('bot battle participants retain their event-time identities after a conquest', () => {
  const game = GameEngine.create('Bot broadcast', 'ZA', true),
    engine = new GameEngine(game);
  game.round = 1;
  game.position = game.order.indexOf(1);
  game.budget = 0;
  game.events = [];
  game.countries[1].army = 6;
  game.countries[2].army = 1;
  engine.event('turn', 'Kestrel takes the turn.');
  engine.startAttack(game.countries[1].code, game.countries[2].code);
  let roll = 0;
  engine.roll(() => (++roll % 2 ? 6 : 1));
  const event = game.events.findLast((event) => event.type === 'conquest');
  const context = commentaryContext(game, event);
  const request = JSON.parse(commentaryRequest([{ eventId: event.id, context }])).events[0];
  assert.equal(request.match.actingPlayer, 1);
  assert.deepEqual(request.match.battle.attacker, { player: 1, name: 'Kestrel' });
  assert.deepEqual(request.match.battle.defender, { player: 2, name: 'Atlas' });
  assert.equal(request.countries.find((country) => country.code === event.country).owner, 1);
  assert.equal(context.previousBoard.find((country) => country.code === event.country).owner, 2);
});

test('saved campaigns can request only the latest three missing eligible reports without replaying their whole history', () => {
  const game = GameEngine.create('Saved game', 'ZA', true),
    source = game.events[0];
  game.events = Array.from({ length: 20 }, (_, i) => ({
    ...source,
    id: 'saved' + i,
    type: 'dice',
  }));
  game.events.at(-1).commentary = 'Already saved.';
  game.events.at(-1).commentaryVersion = COMMENTARY_VERSION;
  const tasks = recentCommentaryTasks(game, { uid: 'owner' });
  assert.deepEqual(
    tasks.map((task) => task.eventId),
    ['saved16', 'saved17', 'saved18'],
  );
  assert.ok(tasks.every((task) => task.uid === 'owner' && task.gameId === game.id));
});

test('match context uses the event snapshot, recorded battle totals and strictly earlier narration', () => {
  const game = GameEngine.create('Match story', 'ZA', true),
    engine = new GameEngine(game);
  game.round = 1;
  game.budget = 0;
  game.position = game.order.indexOf(0);
  game.events = [];
  game.countries[0].army = 6;
  game.countries[1].army = 5;
  engine.event('turn', 'Start of the recorded turn.');
  engine.startAttack('ZA', 'BR');
  game.events.at(-1).commentary = 'An earlier opening line.';
  const values = [1, 6, 6, 1, 6, 1, 3, 3, 3, 3];
  engine.roll(() => values.shift());
  const event = game.events.at(-1);
  engine.event('decision', 'A later decision which must not leak.');
  game.events.at(-1).commentary = 'Future commentary.';
  game.round = 99;
  game.countries[0].army = 900;
  game.countries[1].owner = 0;
  const context = commentaryContext(game, event);
  assert.equal(context.match.round, 1);
  assert.equal(context.match.battle.phase, 1);
  assert.equal(context.match.battle.attackerLoss, 1);
  assert.equal(context.match.battle.defenderLoss, 2);
  assert.equal(context.match.battle.remaining.find((c) => c.code === 'BR').army, 3);
  assert.equal(context.match.standings.find((row) => row.player === 1).countries, 1);
  assert.deepEqual(
    context.previousCommentary.map((item) => item.text),
    ['An earlier opening line.'],
  );
  assert.doesNotMatch(JSON.stringify(context), /Future commentary|later decision/);
  const snapshot = JSON.stringify(context);
  event.board[0].army = 12345;
  assert.equal(
    JSON.stringify(context),
    snapshot,
    'Queued context must remain an immutable event snapshot',
  );
});

test('territorial ties and lead changes are explicit and a new turn does not inherit the previous battle', () => {
  const game = GameEngine.create('Leader story', 'ZA', true),
    engine = new GameEngine(game);
  game.events = [];
  game.countries.forEach((c, i) => {
    c.owner = i < 4 ? i % 2 : i;
    c.army = 10 + i;
  });
  engine.event('turn', 'Before the capture.');
  game.countries[1].owner = 0;
  engine.event('conquest', 'A recorded capture.', { country: game.countries[1].code });
  const context = commentaryContext(game, game.events.at(-1));
  assert.deepEqual(context.match.previousTerritorialLeaders.sort(), [0, 1]);
  assert.deepEqual(context.match.territorialLeaders, [0]);
  engine.event('attack', 'A previous attack.', { from: 'ZA', to: 'BR' });
  engine.event('turn', 'A new commander takes over.');
  engine.event('decision', 'Planning a new move.');
  assert.equal(commentaryContext(game, game.events.at(-1)).match.battle, null);
});

test('compact requests preserve event-time losses, tied leaders and ownership without redundant snapshots', () => {
  const game = GameEngine.create('Compact facts', 'ZA', true);
  const engine = new GameEngine(game);
  game.events = [];
  game.budget = 0;
  game.countries.forEach((country, index) => {
    country.owner = index < 3 ? 0 : index < 6 ? 1 : index - 4;
    country.army = 5;
  });
  game.countries[0].army = 6;
  game.countries[3].army = 1;
  engine.event('turn', 'Two commanders have three countries each.');
  engine.startAttack(game.countries[0].code, game.countries[3].code);
  let rollIndex = 0;
  engine.roll(() => (++rollIndex % 2 ? 6 : 1));
  const dice = game.events.findLast((event) => event.type === 'dice');
  const capture = game.events.findLast((event) => event.type === 'conquest');
  const tasks = [dice, capture].map((event) => ({
    eventId: event.id,
    context: commentaryContext(game, event),
  }));
  const original = JSON.stringify(tasks);
  game.countries[0].army = 9999;
  const request = commentaryRequest(tasks);
  const [before, after] = JSON.parse(request).events;
  assert.equal(before.event.defenderLoss, 1);
  assert.equal(
    before.event.exchangeBalance,
    game.countries.find((country) => country.code === dice.to).name +
      ' lost more soldiers in this exchange.',
  );
  assert.equal(before.event.dicePairCount, 1);
  assert.equal(before.countries.find((country) => country.code === dice.to).army, 0);
  assert.equal(before.countries.find((country) => country.code === dice.to).owner, 1);
  assert.equal(after.countries.find((country) => country.code === capture.country).owner, 0);
  assert.deepEqual(before.match.territorialLeaders, [0, 1]);
  assert.deepEqual(after.match.territorialLeaders, [0]);
  assert.equal(before.match.newOutrightLeader, null);
  assert.deepEqual(after.match.newOutrightLeader, {
    name: 'Commander 1',
    countries: 4,
    change: 'Broke a territorial tie to take the outright lead.',
  });
  assert.equal(after.match.standings[0].previousCountries, 3);
  assert.equal(after.match.standings[0].countries, 4);
  assert.equal(before.event.board, undefined);
  assert.equal(before.event.pairs, undefined);
  assert.equal(before.previousBoard, undefined);
  assert.equal(before.match.previousStandings, undefined);
  assert.equal(before.countries.length, 2);
  assert.ok(before.countries.every((country) => country.name));
  assert.ok(request.length < original.length);
  assert.doesNotMatch(JSON.stringify(before), /9999|conquered/);
  assert.equal(JSON.stringify(tasks), original, 'Compaction must not mutate queued facts');
});

test('queued battle reports start within six seconds and timeouts do not block new events for a minute', async () => {
  let now = 1000;
  const delays = [];
  const { q } = queue({
    now: () => now,
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return 1;
    },
  });
  q.enqueue([task('opening')]);
  assert.ok(delays.at(-1) <= 1000, 'The first report should start promptly');
  q.timer = null;
  await q.drain();
  q.enqueue([task('dice')]);
  assert.ok(delays.at(-1) <= 6000, 'The next batch should not wait twelve seconds');

  const timeout = queue({
    now: () => now,
    generate: async () => {
      throw Object.assign(new Error('Request timed out'), { name: 'AbortError' });
    },
  }).q;
  timeout.enqueue([task('late')]);
  await timeout.drain();
  assert.equal(timeout.nextAt - now, 5000);
  assert.match(timeout.errorMessage, /took too long/);
  now += 100;
  const limited = queue({
    now: () => now,
    generate: async () => {
      throw new Error('429 quota exhausted');
    },
  }).q;
  limited.enqueue([task('quota')]);
  await limited.drain();
  assert.equal(limited.nextAt - now, 60000, 'Quota failures must retain their cooldown');
  const busy = queue({
    now: () => now,
    generate: async () => {
      throw new Error('500 This model is currently experiencing high demand.');
    },
  }).q;
  busy.enqueue([task('busy')]);
  await busy.drain();
  assert.equal(busy.nextAt - now, 5000);
  assert.match(busy.errorMessage, /busy right now/);
});

test('wording memory stays within a campaign and never exposes a later event to an earlier report', async () => {
  const { q, seen } = queue();
  const past = task('past');
  past.gameId = 'same';
  q.enqueue([past]);
  await q.drain();
  const present = task('present');
  present.gameId = 'same';
  present.context.recent = [{ id: 'past' }];
  q.enqueue([present]);
  await q.drain();
  assert.equal(seen[1][0].context.previousCommentary[0].eventId, 'past');
  const earlier = task('earlier');
  earlier.gameId = 'same';
  earlier.context.recent = [];
  q.enqueue([earlier]);
  await q.drain();
  assert.deepEqual(seen[2][0].context.previousCommentary, []);
  const other = task('other');
  other.gameId = 'different';
  other.context.recent = [{ id: 'past' }];
  q.enqueue([other]);
  await q.drain();
  assert.deepEqual(seen[3][0].context.previousCommentary, []);
  q.reset();
  assert.equal(q.memory.size, 0);
});

test('legacy reports can be upgraded while late legacy listeners cannot overwrite the new commentary', () => {
  const game = GameEngine.create('Upgrade', 'ZA', true),
    event = game.events.find((e) => e.type === 'conquest');
  event.commentary = 'Old stat summary.';
  assert.ok(
    recentCommentaryTasks(game, { uid: 'owner' }).some((task) => task.eventId === event.id),
  );
  assert.equal(
    applyCommentary(event, {
      status: 'ready',
      text: 'A new match-aware report.',
      narrationVersion: COMMENTARY_VERSION,
    }),
    true,
  );
  assert.equal(
    applyCommentary(event, { status: 'ready', text: 'A late old report.', narrationVersion: 0 }),
    false,
  );
  assert.equal(event.commentary, 'A new match-aware report.');
  assert.equal(
    recentCommentaryTasks(game, { uid: 'owner' }).some((task) => task.eventId === event.id),
    false,
  );
});

test('live narration allows two concise sentences while retaining storage limits and plain text', () => {
  const text = 'The lead changes hands. ' + Array(38).fill('word').join(' ') + '.';
  assert.equal(cleanLiveCommentary(text), text);
  const bounded = cleanLiveCommentary(Array(100).fill('longwordhere').join(' '));
  assert.ok(bounded.length <= 500);
  assert.ok(bounded.split(' ').length <= 60);
});

test('failed reports expose an actionable status and can be explicitly requested again', async () => {
  let calls = 0;
  const { q, writes } = queue({
    generate: async (tasks) => {
      if (++calls === 1)
        throw Object.assign(new Error('Local setup'), { code: 'commentary/local-setup-required' });
      return response(tasks);
    },
  });
  q.enqueue([task('retry')]);
  await q.drain();
  assert.equal(q.states.get('g/retry'), 'failed');
  assert.match(q.errorMessage, /npm run dev/);
  q.enqueue([task('retry')], { retry: true });
  await q.drain();
  assert.deepEqual(writes, ['retry']);
  assert.equal(q.states.get('g/retry'), 'ready');
  assert.equal(q.errorMessage, '');
  assert.match(commentaryErrorMessage(new Error('429 quota exhausted')), /usage limit/);
});
