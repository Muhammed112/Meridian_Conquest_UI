import test from 'node:test';
import assert from 'node:assert/strict';
import { commentaryFacts, commentaryIssues } from '../dist/commentary-validation.js';
import {
  createGeminiGenerator,
  parseCommentaryBatch,
  CommentaryQueue,
} from '../dist/commentary.js';

// Fix participant identities so examples vary only the factual casualty or event claim.
const context = (attackerLoss, defenderLoss, type = 'dice') => ({
  event: { type, from: 'ZA', to: 'BR', attackerLoss, defenderLoss },
  countries: [
    { code: 'ZA', name: 'South Africa' },
    { code: 'BR', name: 'Brazil' },
  ],
  match: {
    battle: { from: 'ZA', to: 'BR', attacker: { name: 'Kestrel' }, defender: { name: 'Atlas' } },
  },
});

// Pair supported text with explicit contradictions; known guards do not cover all possible prose.
const examples = [
  [0, 2, 'South Africa loses zero soldiers as Brazil loses two soldiers.', true],
  [2, 0, 'Kestrel loses two troops as Atlas suffers zero casualties.', true],
  [1, 1, 'Both sides lose one soldier in a costly exchange.', true],
  [0, 0, 'Both sides emerge unscathed from a tense exchange.', true],
  [0, 0, 'A bloodless exchange keeps both forces on the board.', true],
  [1, 3, 'Brazil takes heavier losses while South Africa keeps the pressure on.', true],
  [3, 1, 'South Africa absorbs greater casualties during the exchange.', true],
  [0, 2, 'South Africa takes no losses while Brazil struggles under pressure.', true],
  [12, 4, 'South Africa loses 12 soldiers while Brazil loses four troops.', true],
  [1, 0, 'Brazil holds its position through the exchange.', true],
  [0, 2, 'South Africa loses two soldiers as Brazil loses zero soldiers.', false],
  [2, 0, 'Atlas loses two troops while Kestrel suffers zero casualties.', false],
  [1, 3, 'Both sides lose one soldier in the exchange.', false],
  [1, 0, 'Both sides emerge unscathed from a tense exchange.', false],
  [2, 1, 'A bloodless exchange keeps both forces on the board.', false],
  [3, 1, 'Brazil takes heavier losses while South Africa advances.', false],
  [1, 3, 'South Africa absorbs greater casualties during the exchange.', false],
  [2, 0, 'South Africa takes no losses while Brazil struggles.', false],
  [1, 0, 'Brazil is conquered as the attacking force presses on.', false],
  [0, 0, 'Your troops secure victory and eliminate Brazil.', false],
];

// Reviewed positive and negative examples guard casualty grounding without rejecting every harmless
// phrase.
test('twenty reviewed casualty examples accept supported prose and reject contradicted facts', () => {
  for (const [a, d, text, valid] of examples) {
    const facts = context(a, d);
    assert.equal(commentaryIssues(text, facts, commentaryFacts(facts)).length === 0, valid, text);
  }
});

// A strategy broadcast must not invent a completed conquest or drift into unrelated sports
// commentary.
test('strategy commentary rejects sports imagery and premature outcomes across event types', () => {
  const scenarios = [
    ['decision', 'South Africa takes position on the pitch before the opening strike.', false],
    ['attack', 'The referee signals kick-off as South Africa attacks Brazil.', false],
    ['held', 'Brazil holds while South Africa claims victory.', false],
    ['retreat', 'Atlas has been eliminated as South Africa withdraws.', false],
    ['decision', 'South Africa captures Brazil to extend the lead.', false],
    ['attack', 'Brazil is captured in the opening move.', false],
    ['conquest', 'Kestrel wins the game after taking Brazil.', false],
    ['decision', 'Kestrel plans an attack with a numerical advantage.', true],
    ['attack', 'South Africa launches an attack on Brazil with six soldiers available.', true],
    [
      'retreat',
      'South Africa stops its attack; both countries retain their surviving soldiers.',
      true,
    ],
    ['held', 'Brazil holds as South Africa is reduced to its last soldier.', true],
    ['conquest', 'Kestrel captures Brazil and earns two additional soldiers.', true],
    [
      'elimination',
      'Atlas has been eliminated after losing the last country under its command.',
      true,
    ],
    ['victory', 'Kestrel wins the game with all ten countries under its command.', true],
  ];
  for (const [type, text, valid] of scenarios) {
    const facts = context(1, 2, type);
    assert.equal(commentaryIssues(text, facts, commentaryFacts(facts)).length === 0, valid, text);
  }
  for (const text of [
    'Brazil takes only one casualty during the exchange.',
    'Brazil sustains exactly one casualty during the exchange.',
  ]) {
    const facts = context(0, 2);
    assert.ok(commentaryIssues(text, facts, commentaryFacts(facts)).length, text);
  }
});

// Correct-looking prose must still prove that it refers to the requested countries and recorded
// losses.
test('responses with missing or altered verification facts cannot reach saved AI reports', () => {
  const facts = context(1, 3);
  const task = { eventId: 'phase', context: facts };
  const report = {
    eventId: 'phase',
    text: 'Brazil loses three soldiers under sustained pressure.',
    facts: commentaryFacts(facts),
  };
  assert.equal(parseCommentaryBatch(JSON.stringify({ reports: [report] }), [task]).size, 1);
  for (const changed of [
    undefined,
    { ...report.facts, attackerLoss: 3 },
    { ...report.facts, to: 'JP' },
  ])
    assert.throws(
      () =>
        parseCommentaryBatch(JSON.stringify({ reports: [{ ...report, facts: changed }] }), [task]),
      { code: 'commentary/facts-mismatch' },
    );
});

// A valid nickname containing a flagged word must not be mistaken for an invented outcome or unsafe
// prose.
test('legal nicknames do not trigger prose checks for markup, pronouns, sports or outcomes', () => {
  for (const name of ['<Ace>', 'Your Grace', 'Captain Retreat', 'Football', 'Captain Victory']) {
    const facts = context(1, 3);
    facts.match.battle.attacker.name = name;
    assert.deepEqual(
      commentaryIssues(
        `${name} loses one soldier as Brazil loses three troops.`,
        facts,
        commentaryFacts(facts),
      ),
      [],
    );
  }
  const facts = context(0, 0, 'decision');
  facts.match.battle = null;
  facts.match.standings = [{ name: 'Your Grace' }, { name: 'Football' }];
  assert.deepEqual(
    commentaryIssues(
      'Your Grace plans an attack as Football defends its position.',
      facts,
      commentaryFacts(facts),
    ),
    [],
  );
});

// A rejected AI response must leave factual gameplay available and must never become a persisted
// report.
test('contradicted model prose is not persisted and factual gameplay can keep progressing', async () => {
  let writes = 0;
  const facts = context(1, 3);
  const queue = new CommentaryQueue({
    generate: async () =>
      JSON.stringify({
        reports: [
          {
            eventId: 'phase',
            text: 'Brazil loses one soldier while South Africa loses three soldiers.',
            facts: commentaryFacts(facts),
          },
        ],
      }),
    persist: async () => {
      writes++;
    },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  queue.enqueue([{ key: 'game/phase', eventId: 'phase', context: facts }]);
  await queue.drain();
  assert.equal(writes, 0);
  assert.equal(queue.states.get('game/phase'), 'failed');
  assert.match(queue.errorMessage, /could not be verified/);
});

// Concurrent warm-up calls must share setup work without consuming quota by generating a report.
test('preparing Gemini shares initialization and attestation without generating any reports', async () => {
  const calls = { imports: 0, appCheck: 0, tokens: 0, models: 0, reports: 0 };
  const sdk = {
    ReCaptchaEnterpriseProvider: class {},
    GoogleAIBackend: class {},
    initializeAppCheck: () => {
      calls.appCheck++;
      return {};
    },
    getToken: async () => {
      calls.tokens++;
      return {};
    },
    getAI: () => ({}),
    getGenerativeModel: () => {
      calls.models++;
      return {
        generateContent: async () => {
          calls.reports++;
          return { response: { text: () => '{}' } };
        },
      };
    },
  };
  const generate = createGeminiGenerator({
    app: {},
    base: '',
    settings: { siteKey: 'fixture', model: 'fixture' },
    loadSDK: async () => {
      calls.imports++;
      return sdk;
    },
  });
  await Promise.all([generate.prepare(), generate.prepare()]);
  assert.deepEqual(calls, { imports: 2, appCheck: 1, tokens: 1, models: 1, reports: 0 });
  await generate([]);
  assert.equal(calls.reports, 1);
  assert.equal(calls.models, 1);
});

// Read-only queue observations must not let UI code cancel work or corrupt duplicate-request
// tracking.
test('queue observers cannot change pending requests, statuses or deduplication sets', () => {
  const queue = new CommentaryQueue({
    generate: async () => '{}',
    persist: async () => {},
    setTimer: () => 1,
  });
  queue.enqueue([{ key: 'game/phase', eventId: 'phase', context: context(1, 1) }]);
  queue.pending.length = 0;
  queue.states.clear();
  queue.seen.clear();
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.states.get('game/phase'), 'queued');
  assert.equal(queue.seen.has('game/phase'), true);
});
