import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import {
  armyValue,
  catalogue,
  conquestReward,
  findCountry,
  isPlayableCountry,
  legacyPopulations,
  savedCountryPopulation,
} from '../dist/data.js';
import { countryMetadata } from '../dist/country-catalogue.js';
import { bundledPopulations } from '../dist/population-snapshot.js';
import {
  decodeBoard,
  encodeBoard,
  validateGameBoard,
  validateGameEvent,
} from '../dist/game-schema.js';
import {
  normalizeCampaignCountries,
  selectCompatibleCountry,
} from '../dist/country-compatibility.js';

/** Reproduce an existing campaign with a live battle, historical decisions and saved narration. */
function existingCampaign() {
  const game = GameEngine.create('Israel United', 'ZA', true, 'medium', 'Israel');
  const original = findCountry('IL');
  game.countries[0] = {
    ...original,
    value: armyValue(original.population),
    owner: 0,
    army: 27,
  };
  Object.assign(game, {
    start: 'IL',
    round: 4,
    budget: 0,
    turnStarted: true,
    events: [],
  });
  const engine = new GameEngine(game);
  engine.event('turn', "Israel's turn.");
  engine.event('decision', 'Deploying 4 soldiers: 4 to Israel. Preparing the next offensive.', {
    reason: 'Moving soldiers from Israel to secure the next attack.',
    intent: {
      action: 'reinforce',
      values: { allocations: { IL: 4 } },
    },
  });
  engine.startAttack('IL', game.countries[1].code);
  engine.roll(() => 3);
  game.lastBattle = { ...game.battle, country: 'Israel', reward: 2, outcome: 'conquest' };
  for (const event of game.events) {
    event.commentary = 'Israel advances across the board.';
    event.commentaryVersion = 2;
  }
  return game;
}

// Filtering game choices must not destroy the reference needed to validate old saves and populations.
test('playable choices exclude unavailable countries while full legacy reference data remains readable', () => {
  assert.equal(isPlayableCountry('IL'), false);
  assert.equal(isPlayableCountry('unknown'), false);
  assert.equal(
    catalogue.some((country) => country.code === 'IL'),
    false,
  );
  assert.equal(catalogue.length, countryMetadata.length - 1);
  assert.equal(findCountry('IL').name, 'Israel');
  assert.ok(legacyPopulations.IL > 0);
  assert.ok(bundledPopulations.populations.IL > 0);
  assert.equal(savedCountryPopulation({ code: 'IL' }).value, armyValue(legacyPopulations.IL));
  assert.equal(decodeBoard(encodeBoard(existingCampaign())).countries[0].code, 'IL');
});

// A normal campaign must retain object identity, timestamps, narration and stable history IDs.
test('unaffected campaigns are returned unchanged without consuming an event ID', () => {
  const game = GameEngine.create('Unchanged', 'ZA', true);
  game.events[0].commentary = 'An existing report.';
  const before = structuredClone(game);
  let calls = 0;
  const normalized = normalizeCampaignCountries(game, {
    newEventId: () => String(++calls),
  });
  assert.equal(normalized, game);
  assert.deepEqual(game, before);
  assert.equal(calls, 0);
});

// Replacing metadata must preserve ten unique holdings and every owner, army and turn fact.
test('normalization preserves core progress and uses real same-band replacement metadata immutably', () => {
  const game = existingCampaign();
  const before = structuredClone(game);
  const normalized = normalizeCampaignCountries(game);
  const replacement = normalized.countries[0];
  const trusted = findCountry(replacement.code);
  assert.notEqual(normalized, game);
  assert.deepEqual(game, before);
  assert.equal(normalized.countries.length, 10);
  assert.equal(new Set(normalized.countries.map((country) => country.code)).size, 10);
  assert.equal(isPlayableCountry(replacement.code), true);
  for (const key of ['name', 'population', 'flag', 'id', 'lat', 'lon'])
    assert.equal(replacement[key], trusted[key]);
  assert.equal(replacement.value, before.countries[0].value);
  assert.equal(armyValue(replacement.population), replacement.value);
  assert.equal(replacement.army, 27);
  assert.equal(replacement.owner, 0);
  for (const key of [
    'id',
    'name',
    'round',
    'position',
    'order',
    'budget',
    'attackUsed',
    'turnStarted',
    'winner',
    'status',
    'createdAt',
    'updatedAt',
    'populationSource',
    'playerNames',
  ])
    assert.deepEqual(normalized[key], before[key]);
  assert.deepEqual(normalized.battle.pairs, before.battle.pairs);
  assert.equal(normalized.battle.phase, before.battle.phase);
  assert.equal(normalized.lastBattle.reward, before.lastBattle.reward);
  assert.equal(normalized.lastBattle.outcome, before.lastBattle.outcome);
  assert.deepEqual(
    normalized.events.map(({ id }) => id),
    before.events.map(({ id }) => id),
  );
  validateGameBoard(normalized);
  const codes = new Set(normalized.countries.map((country) => country.code));
  for (const event of normalized.events) validateGameEvent(event, codes);
  assert.equal(normalizeCampaignCountries(normalized), normalized, 'the operation is idempotent');
});

// Replays and delayed NPC intentions must refer to the replacement rather than a removed code.
test('all country-bearing history, battle and intention fields stay coherent', () => {
  const game = existingCampaign();
  game.events[1].intent.values.from = 'IL';
  game.events[1].intent.values.to = game.countries[4].code;
  game.events[1].country = 'IL';
  const normalized = normalizeCampaignCountries(game);
  const { code, name } = normalized.countries[0];
  assert.equal(normalized.start, code);
  assert.equal(normalized.battle.from, code);
  assert.equal(normalized.lastBattle.from, code);
  assert.equal(normalized.lastBattle.country, name);
  assert.equal(normalized.events[1].country, code);
  assert.equal(normalized.events[1].intent.values.from, code);
  assert.deepEqual(normalized.events[1].intent.values.allocations, { [code]: 4 });
  assert.match(normalized.events[1].text, new RegExp(`4 to ${name}`));
  assert.match(normalized.events[1].reason, new RegExp(`from ${name}`));
  for (let index = 0; index < normalized.events.length; index++) {
    const event = normalized.events[index];
    assert.equal(event.board[0].code, code);
    assert.equal(event.board[0].army, game.events[index].board[0].army);
    assert.equal(event.board[0].owner, game.events[index].board[0].owner);
    assert.equal(event.commentary, undefined);
    assert.equal(event.commentaryVersion, undefined);
  }
  assert.equal(normalized.name, 'Israel United');
  assert.equal(normalized.playerNames[0], 'Israel');
  assert.equal(normalized.events[0].text, "Israel's turn.");
});

// Bot reports prefix a commander nickname before a country-based reason; those labels have different roles.
test('country text replacement preserves commander prefixes matching a country name or code', () => {
  const game = existingCampaign();
  game.playerNames[1] = 'IL';
  const engine = new GameEngine(game);
  engine.event('decision', 'Israel: Attack Israel to expand our territory.');
  engine.event('decision', 'IL: Moving soldiers from Israel to secure the next attack.');
  const normalized = normalizeCampaignCountries(game);
  const name = normalized.countries[0].name;
  assert.equal(normalized.events.at(-2).text, `Israel: Attack ${name} to expand our territory.`);
  assert.equal(
    normalized.events.at(-1).text,
    `IL: Moving soldiers from ${name} to secure the next attack.`,
  );
  assert.deepEqual(normalized.playerNames, game.playerNames);
});

// Choice replacement must be deterministic and cannot select another country already on the board.
test('replacement selection respects occupied countries and legacy starting values', () => {
  const nearest = selectCompatibleCountry({ code: 'IL' });
  const occupied = new Set(['IL', nearest.code]);
  const alternative = selectCompatibleCountry({ code: 'IL' }, occupied);
  assert.notEqual(alternative.code, nearest.code);
  assert.deepEqual(selectCompatibleCountry({ code: 'IL' }, [...occupied]), alternative);
  assert.equal(armyValue(alternative.population), armyValue(legacyPopulations.IL));
  const game = existingCampaign();
  game.countries[1] = { ...nearest, owner: 1, army: 6, value: armyValue(nearest.population) };
  const normalized = normalizeCampaignCountries(game);
  assert.equal(normalized.countries[0].code, alternative.code);
  assert.equal(normalized.countries[1].code, nearest.code);
  assert.throws(() =>
    selectCompatibleCountry(
      { code: 'IL' },
      catalogue.map(({ code }) => code),
    ),
  );
});

// Cloud history can branch to fresh immutable event documents; local caches keep their existing IDs.
test('an optional event ID factory creates fresh history only for affected campaigns', () => {
  const game = existingCampaign();
  let next = 0;
  const normalized = normalizeCampaignCountries(game, {
    newEventId: () => `replacement-${++next}`,
  });
  assert.equal(next, game.events.length);
  assert.deepEqual(
    normalized.events.map(({ id }) => id),
    game.events.map((_, index) => `replacement-${index + 1}`),
  );
  assert.notEqual(normalized.events[0].id, game.events[0].id);
  assert.equal(normalized.events[0].at, game.events[0].at);
  assert.deepEqual(
    normalizeCampaignCountries(game).events.map(({ id }) => id),
    game.events.map(({ id }) => id),
  );
});

// Continuing a saved battle must still apply the original reward and the existing single-attack rule.
test('a normalized in-progress battle resolves with unchanged conquest and turn rules', () => {
  const game = existingCampaign();
  Object.assign(game, {
    position: 1,
    attackUsed: false,
    battle: null,
    events: [],
    lastBattle: null,
  });
  game.countries[0].army = 1;
  game.countries[1].army = 5;
  const engine = new GameEngine(game);
  engine.startAttack(game.countries[1].code, 'IL');
  const normalized = normalizeCampaignCountries(game);
  const restored = new GameEngine(normalized);
  let face = 0;
  const result = restored.roll(() => (face++ % 2 ? 1 : 6));
  assert.equal(result.conquered, true);
  assert.equal(normalized.countries[0].owner, 1);
  assert.equal(normalized.countries[0].army, 1);
  assert.equal(normalized.lastBattle.reward, conquestReward(game.countries[0].value));
  assert.equal(normalized.countries[1].army, 5 + normalized.lastBattle.reward - 1);
  assert.throws(() =>
    restored.startAttack(normalized.countries[1].code, normalized.countries[2].code),
  );
});
