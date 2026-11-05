import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeminiGenerator,
  commentaryInstructions,
  recentCommentaryTasks,
} from '../dist/commentary.js';
import { buildGameSummary, summaryInstructions } from '../dist/game-summary.js';
import { GameEngine } from '../dist/engine.js';
import { createCloudFixture } from './helpers/cloud.js';

/** A local SDK records preparation and requests without contacting Gemini or consuming quota. */
function modelFixture(generate) {
  const configurations = [],
    requests = [],
    checks = [];
  const sdk = {
    GoogleAIBackend: class {},
    ReCaptchaEnterpriseProvider: class {},
    initializeAppCheck: () => {
      checks.push('initialize');
      return {};
    },
    getToken: async () => checks.push('token'),
    getAI: () => ({}),
    getGenerativeModel: (_ai, configuration) => {
      configurations.push(configuration);
      return {
        async generateContent(request, options) {
          requests.push({ request, options, instructions: configuration.systemInstruction });
          return { response: { text: () => generate(JSON.parse(request)) } };
        },
      };
    },
  };
  return { sdk, configurations, requests, checks };
}

const response = (facts) =>
  JSON.stringify({
    overview: 'The commanders begin their campaign.',
    moments: facts.moments.slice(0, 5).map(({ eventId, text }) => ({ eventId, text })),
  });

// Summary and live narration must share App Check setup while retaining different model prompts.
test('replay summaries reuse Gemini preparation without generating live commentary', async () => {
  const f = modelFixture((facts) => (facts.events ? '{"reports":[]}' : response(facts))),
    generator = createGeminiGenerator({
      app: {},
      base: '',
      settings: { model: 'fixture-model', siteKey: 'fixture-site' },
      loadSDK: async () => f.sdk,
    }),
    facts = buildGameSummary(GameEngine.create('Replay fixture', 'ZA', true));
  await generator.prepare();
  assert.equal(f.requests.length, 0, 'Preparing never generates a report.');
  await generator.summarize(facts);
  await generator.summarize(facts);
  assert.deepEqual(f.checks, ['initialize', 'token']);
  assert.equal(f.configurations.length, 2, 'One model configuration per purpose.');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every((request) => request.instructions === summaryInstructions));
  assert.equal(f.requests[0].options.timeout, 30000);
  assert.deepEqual(JSON.parse(f.requests[0].request), JSON.parse(f.requests[1].request));
  const liveGame = GameEngine.create('Live narration fixture', 'ZA', true);
  await generator(recentCommentaryTasks(liveGame, { uid: 'owner' }));
  assert.equal(f.requests[2].instructions, commentaryInstructions);
  assert.equal(f.configurations.length, 2, 'Summary generation must not replace the live model.');
  assert.deepEqual(f.checks, ['initialize', 'token']);
});

// A malformed model result must reach the factual fallback and remain retryable.
test('invalid summary output is rejected without poisoning a later request', async () => {
  let raw = '{}';
  const f = modelFixture((facts) => raw ?? response(facts)),
    generator = createGeminiGenerator({
      app: {},
      base: '',
      settings: { model: 'fixture-model' },
      loadSDK: async () => f.sdk,
    }),
    facts = buildGameSummary(GameEngine.create('Summary retry', 'ZA', true));
  await assert.rejects(generator.summarize(facts));
  raw = null;
  assert.equal((await generator.summarize(facts)).overview, 'The commanders begin their campaign.');
  assert.equal(f.checks.filter((entry) => entry === 'initialize').length, 1);
});

// Signed-out and disabled projects must fail before any attestation or model request begins.
test('summary generation requires a ready signed-in account and an enabled AI setup', async () => {
  const f = await createCloudFixture(),
    game = GameEngine.create('Private summary', 'ZA', true);
  await assert.rejects(f.service.summarizeGame(game), /Sign in/);
  await f.login('owner');
  await assert.rejects(f.service.summarizeGame(game), /unavailable/);
  assert.deepEqual(f.writes, []);
});

// A deliberate recap must not enable live commentary or write derived prose into the saved game.
test('cloud summaries leave commentary preferences and campaign storage untouched', async () => {
  const model = modelFixture(response),
    f = await createCloudFixture({ aiSettings: { enabled: true, model: 'fixture-model' } }),
    game = GameEngine.create('Read-only summary', 'ZA', true),
    original = structuredClone(game);
  Object.assign(f.sdk, model.sdk);
  await f.login('owner');
  f.service.setCommentaryEnabled(false);
  const summary = await f.service.summarizeGame(game);
  assert.equal(summary.overview, 'The commanders begin their campaign.');
  assert.equal(f.service.commentary.enabled, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(game, original);
});

// A model result from an earlier account must not appear in the newly signed-in account.
test('account changes invalidate an in-flight replay summary', async () => {
  const entered = Promise.withResolvers(),
    released = Promise.withResolvers(),
    model = modelFixture(response),
    f = await createCloudFixture({ aiSettings: { enabled: true, model: 'fixture-model' } });
  const getModel = model.sdk.getGenerativeModel;
  model.sdk.getGenerativeModel = (...args) => {
    const instance = getModel(...args);
    return {
      async generateContent(...values) {
        entered.resolve();
        await released.promise;
        return instance.generateContent(...values);
      },
    };
  };
  Object.assign(f.sdk, model.sdk);
  await f.login('old');
  const summary = f.service.summarizeGame(GameEngine.create('Old account', 'ZA', true)),
    rejected = assert.rejects(summary, /account changed/);
  await entered.promise;
  await f.login('new');
  released.resolve();
  await rejected;
  assert.deepEqual(f.writes, []);
});
