import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import { buildGameSummary } from '../dist/game-summary.js';
import { createGameSummaryDialog } from '../dist/ui/game-summary.js';

/** Model a modal without a browser so request races remain deterministic and consume no API quota. */
function fixture() {
  const listeners = new Map(),
    calls = [],
    selections = [];
  const dialog = {
    open: false,
    innerHTML: '',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    querySelector() {
      const marker = /data-game-summary="([^"]+)"/.exec(this.innerHTML);
      return marker ? { dataset: { gameSummary: marker[1] } } : null;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      for (const listener of listeners.get('close') ?? []) listener();
    },
  };
  const state = {
    user: { uid: 'owner' },
    pauses: 0,
    generate: async (game) => ({
      overview: 'A measured opening changes the balance.',
      moments: buildGameSummary(game).moments.slice(0, 2),
    }),
  };
  const controller = createGameSummaryDialog({
    document: { getElementById: () => dialog },
    getUser: () => state.user,
    getCloud: () => ({
      summarizeGame(game) {
        calls.push(game.id);
        return state.generate(game);
      },
    }),
    pauseReplay: () => state.pauses++,
    onSelectEvent: (index) => selections.push(index),
  });
  const game = GameEngine.create('Summary fixture', 'ZA', true);
  function click(attribute, dataset = {}) {
    const target = { closest: (selector) => (selector === attribute ? { dataset } : null) };
    for (const listener of listeners.get('click') ?? []) listener({ target });
  }
  return { game, controller, dialog, state, calls, selections, click };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The waiting state should stay uncluttered until the requested AI summary is ready.
test('summary shows loading status without events while one explicit AI request is pending', async () => {
  const f = fixture(),
    pending = deferred(),
    before = JSON.stringify(f.game);
  f.state.generate = () => pending.promise;
  const opening = f.controller.open(f.game);
  assert.equal(f.dialog.open, true);
  assert.match(f.dialog.innerHTML, /Generating AI summary/);
  assert.match(f.dialog.innerHTML, /available recorded events/);
  assert.doesNotMatch(f.dialog.innerHTML, /data-summary-key-events|data-summary-fact|View moment/);
  assert.equal(f.state.pauses, 1);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  pending.resolve({ overview: '<img src=x>', moments: buildGameSummary(f.game).moments });
  await opening;
  assert.match(f.dialog.innerHTML, /<h2 id="help-title">AI summary<\/h2>/);
  assert.match(f.dialog.innerHTML, /&lt;img src=x&gt;/);
  assert.match(f.dialog.innerHTML, /data-summary-key-events|View moment/);
  assert.equal(JSON.stringify(f.game), before, 'Generating must not modify the recorded campaign');
});

// Generic generated wording must never hide the concrete event the highlight links to.
test('summary presents exact key events before the AI recap instead of vague generated highlights', async () => {
  const f = fixture(),
    fact = buildGameSummary(f.game).moments.find((moment) => moment.type === 'conquest');
  assert.ok(fact, 'The recorded sample includes a conquest.');
  f.state.generate = async () => ({
    overview: 'The balance of power shifted.',
    moments: [{ eventId: fact.eventId, text: 'A commander made an important advance.' }],
  });
  await f.controller.open(f.game);
  assert.ok(f.dialog.innerHTML.includes(fact.text));
  assert.match(f.dialog.innerHTML, /Country captured/);
  assert.doesNotMatch(f.dialog.innerHTML, /A commander made an important advance/);
  assert.ok(
    f.dialog.innerHTML.indexOf('data-summary-key-events') <
      f.dialog.innerHTML.indexOf('data-summary-overview'),
    'Specific events must be visible before the general recap.',
  );
});

// Reopening the same record must share in-flight work and reuse the result, conserving model quota.
test('repeated summary opens coalesce and successful reopens use the account cache', async () => {
  const f = fixture(),
    pending = deferred();
  f.state.generate = () => pending.promise;
  const first = f.controller.open(f.game),
    second = f.controller.open(f.game);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  pending.resolve({ overview: 'A single recap.', moments: buildGameSummary(f.game).moments });
  await Promise.all([first, second]);
  f.controller.close();
  await f.controller.open(f.game);
  assert.equal(f.calls.length, 1);
  f.game.updatedAt++;
  await f.controller.open(f.game);
  assert.equal(f.calls.length, 2, 'A newer recorded campaign needs its own summary');
});

// Read-only anonymous viewing may show recorded facts, but must never spend another user's quota.
test('signed-out summary gives an honest factual fallback without requesting AI', async () => {
  const f = fixture();
  f.state.user = null;
  await f.controller.open(f.game);
  assert.match(f.dialog.innerHTML, /Sign in to generate an AI summary/);
  assert.match(f.dialog.innerHTML, /Shared replays may contain only recent events/);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.dialog.innerHTML, /<h2 id="help-title">AI summary<\/h2>/);
});

// A transient model failure must not become an automatic request loop every time the modal reopens.
test('failed requests keep factual moments and retry only on an explicit retry click', async () => {
  const f = fixture();
  f.state.generate = async () => {
    throw new Error('Quota unavailable');
  };
  await f.controller.open(f.game);
  assert.match(f.dialog.innerHTML, /AI summary is unavailable right now/);
  assert.match(f.dialog.innerHTML, /Retry AI summary/);
  await f.controller.open(f.game);
  assert.equal(f.calls.length, 1);
  f.state.generate = async () => ({ overview: 'Retry succeeded.', moments: [] });
  f.click('[data-summary-retry]');
  // Awaiting the same cache entry waits for the explicit retry without dispatching another request.
  await f.controller.open(f.game);
  assert.equal(f.calls.length, 2);
  assert.match(f.dialog.innerHTML, /Retry succeeded/);
});

// Closing or replacing the reusable help dialog must protect its new content from late AI results.
test('closed and replaced dialogs ignore late summary completions', async () => {
  for (const replace of [false, true]) {
    const f = fixture(),
      pending = deferred();
    f.state.generate = () => pending.promise;
    const opening = f.controller.open(f.game);
    await Promise.resolve();
    if (replace) f.dialog.innerHTML = '<p>Rules of engagement</p>';
    else f.dialog.close();
    const before = f.dialog.innerHTML;
    pending.resolve({ overview: 'An obsolete completion.', moments: [] });
    await opening;
    assert.equal(f.dialog.innerHTML, before);
  }
});

// The shared help modal belongs to other features too; clearing recap state must preserve their UI.
test('reset leaves an unrelated replacement dialog open', async () => {
  const f = fixture();
  await f.controller.open(f.game);
  f.dialog.innerHTML = '<p>Rules of engagement</p>';
  f.controller.reset();
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.innerHTML, '<p>Rules of engagement</p>');
});

// Account changes must discard cached summaries and prevent an old response overwriting a new user's recap.
test('reset isolates accounts even when the previous account has an outstanding request', async () => {
  const f = fixture(),
    pending = deferred();
  f.state.generate = () => pending.promise;
  const opening = f.controller.open(f.game);
  await Promise.resolve();
  f.state.user = { uid: 'different-owner' };
  f.controller.reset();
  assert.equal(f.dialog.open, false, 'Changing accounts must close the previous private recap');
  f.state.generate = async () => ({ overview: 'New account recap.', moments: [] });
  await f.controller.open(f.game);
  pending.resolve({ overview: 'Old account recap.', moments: [] });
  await opening;
  assert.equal(f.calls.length, 2);
  assert.match(f.dialog.innerHTML, /New account recap/);
  assert.doesNotMatch(f.dialog.innerHTML, /Old account recap/);
});

// Key moments should select the exact original source event, then close the modal for replay.
test('viewing a key moment selects its recorded event index and closes the summary', async () => {
  const f = fixture(),
    fact = buildGameSummary(f.game).moments[0];
  await f.controller.open(f.game);
  f.click('[data-summary-event]', { summaryEvent: fact.eventId });
  assert.deepEqual(f.selections, [f.game.events.findIndex((event) => event.id === fact.eventId)]);
  assert.equal(f.dialog.open, false);
});
