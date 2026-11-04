import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../dist/engine.js';
import {
  allianceFor,
  diplomacyState,
  evaluateAlliance,
  isDiplomacyFact,
  isDiplomacyState,
  trustFor,
} from '../dist/diplomacy.js';

/** Two small commanders can cooperate against a stronger rival on this fixed legal board. */
function arena() {
  const game = GameEngine.create('Diplomacy regression', 'ZA', true);
  Object.assign(game, {
    round: 1,
    order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    position: 0,
    turnStarted: true,
    budget: 0,
    attackUsed: false,
    battle: null,
    lastBattle: null,
    winner: null,
    status: 'active',
    events: [],
  });
  const owners = [0, 0, 1, 1, 2, 2, 2, 2, 3, 4];
  game.countries.forEach((country, index) =>
    Object.assign(country, { owner: owners[index], army: 10, value: 4 }),
  );
  return new GameEngine(game);
}

// Accepting a useful pact must change diplomatic facts, never armies, budgets or attack rights.
test('a useful three-round pact records factual decisions and preserves combat resources', () => {
  const engine = arena(),
    before = structuredClone(engine.game.countries);
  assert.equal(engine.proposeAlliance(1).accepted, true);
  assert.deepEqual(engine.game.countries, before);
  assert.equal(engine.game.budget, 0);
  assert.equal(engine.game.attackUsed, false);
  assert.equal(Object.hasOwn(engine.game, 'diplomacy'), false);
  assert.deepEqual(allianceFor(engine.game, 0), {
    ally: 1,
    startedRound: 1,
    expiresRound: 4,
    roundsLeft: 3,
  });
  assert.equal(allianceFor(engine.game, 1).ally, 0);
  const event = engine.game.events.at(-1);
  assert.equal(event.type, 'decision');
  assert.match(event.text, /accepts a three-round alliance with/);
  assert.doesNotMatch(event.text, /You's/);
  assert.equal(event.diplomacy.action, 'accepted');
  assert.equal(isDiplomacyFact(event.diplomacy), true);
  assert.equal(isDiplomacyState(event.diplomacyState), true);
  assert.equal(trustFor(engine.game, 1, 0), 53);
});

// One pact per commander prevents overlapping teams and repeated offers cannot spam an NPC.
test('each commander gets one ally and one offer per turn, including declined offers', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  assert.throws(() => engine.proposeAlliance(2), /one ally/);
  engine.game.position = 3;
  assert.throws(() => engine.proposeAlliance(1), /one ally/);
  const declined = arena();
  declined.game.countries
    .filter((country) => country.owner === 0)
    .forEach((country) => {
      country.army = 1;
    });
  assert.equal(declined.proposeAlliance(1).accepted, false);
  assert.throws(() => declined.proposeAlliance(3), /one alliance per turn/);
  assert.equal(declined.game.events.length, 1);
});

// Invalid timings and human targets must fail without changing a saved board or report history.
test('offers require an active planning turn and an alive NPC target', () => {
  for (const change of [
    { budget: 4 },
    { battle: { from: 'ZA', to: 'BR' } },
    { winner: 0 },
    { turnStarted: false },
  ]) {
    const engine = arena();
    Object.assign(engine.game, change);
    const before = structuredClone(engine.game);
    assert.throws(() => engine.proposeAlliance(1), /planning turn/);
    assert.deepEqual(engine.game, before);
  }
  const engine = arena();
  for (const target of [0, 5, -1, 10, 1.5, '1'])
    assert.throws(() => engine.proposeAlliance(target));
  assert.throws(() => engine.proposeAlliance(1, { humanCount: 2 }));
  assert.equal(engine.proposeAlliance(2, { humanCount: 2 }).accepted, true);
});

// NPC acceptance explains the common threat and rejects support too small to help survival.
test('NPC offers consider military support, common threats and past betrayal', () => {
  const engine = arena();
  assert.match(evaluateAlliance(engine.game, 0, 1).reason, /common rival/);
  engine.game.countries
    .filter((country) => country.owner === 0)
    .forEach((country) => {
      country.army = 1;
    });
  assert.equal(evaluateAlliance(engine.game, 0, 1).accepted, false);
  assert.match(evaluateAlliance(engine.game, 0, 1).reason, /too little/);
  // A large offer still cannot erase the memory of an earlier betrayal.
  engine.game.countries[0].army = 100;
  engine.event('decision', 'A saved relationship.', {
    diplomacyState: {
      alliances: [],
      trust: [{ observer: 1, other: 0, value: 15 }],
      lastOffers: [],
    },
  });
  assert.match(engine.proposeAlliance(1).reason, /Previous betrayal/);
});

// Betrayal should make negotiation harder without permanently removing all future diplomacy.
test('a betrayed NPC requires substantial support against an urgent common threat to ally again', () => {
  const engine = arena();
  engine.event('decision', 'A past betrayal is remembered.', {
    diplomacyState: {
      alliances: [],
      trust: [{ observer: 1, other: 0, value: 18 }],
      lastOffers: [],
    },
  });
  assert.equal(evaluateAlliance(engine.game, 0, 1).accepted, false);
  engine.game.countries.forEach((country) => {
    if (country.owner === 0) country.army = 20;
    if (country.owner === 2) country.army = 13;
  });
  // Support is now 40 against the NPC's 20; together they can contain the rival's 52.
  const result = engine.proposeAlliance(1);
  assert.equal(result.accepted, true);
  assert.match(result.reason, /Trust remains low.*dangerous common rival/);
  assert.equal(allianceFor(engine.game, 0).ally, 1);
  assert.equal(
    trustFor(engine.game, 1, 0),
    21,
    'acceptance does not erase the damaged relationship',
  );
});

// An NPC must not accept the same dominating commander it would immediately need to contain.
test('NPCs refuse a pact that would protect a proposer already close to winning', () => {
  const engine = arena();
  engine.game.countries.forEach((country, index) => {
    country.owner = index < 6 ? 0 : index < 8 ? 1 : 2;
  });
  const result = engine.proposeAlliance(1);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /most countries.*protect that lead/);
  assert.equal(allianceFor(engine.game, 0), null);
});

// Terms run for three full round increments; expiry is recorded before the new turn report.
test('a pact expires at its agreed round boundary without rewriting historical events', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  const accepted = structuredClone(engine.game.events[0]);
  engine.game.round = 3;
  engine.game.turnStarted = false;
  engine.beginTurn();
  assert.equal(allianceFor(engine.game, 0).roundsLeft, 1);
  engine.game.round = 4;
  engine.game.turnStarted = false;
  engine.beginTurn();
  assert.equal(allianceFor(engine.game, 0), null);
  assert.equal(engine.game.events.at(-2).diplomacy.action, 'expired');
  assert.equal(engine.game.events.at(-1).type, 'turn');
  assert.deepEqual(engine.game.events[0], accepted);
});

// Breaking a pact remains a legal attack and costs trust rather than changing dice or transfers.
test('betrayal keeps the normal attack, casualty and conquest rules while reducing trust', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  const [source, owned, target] = engine.game.countries;
  assert.throws(() => engine.transfer(source.code, target.code, 1), /two owned/);
  const troops = source.army + owned.army;
  engine.transfer(source.code, owned.code, 1);
  assert.equal(source.army + owned.army, troops);
  target.army = 1;
  const before = source.army;
  engine.startAttack(source.code, target.code);
  assert.equal(allianceFor(engine.game, 0), null);
  assert.equal(engine.game.events.at(-2).diplomacy.action, 'betrayed');
  assert.equal(trustFor(engine.game, 1, 0), 18);
  assert.equal(trustFor(engine.game, 0, 1), 53, 'trust is directional');
  let face = 0;
  engine.roll(() => (face++ % 2 ? 1 : 6));
  assert.equal(target.owner, 0);
  assert.equal(target.army, 1);
  assert.equal(source.army, before + 1, 'value four gives the normal two-soldier reward');
  assert.throws(() => engine.startAttack(source.code, engine.game.countries[4].code));
  assert.equal(evaluateAlliance(engine.game, 0, 1).accepted, false);
});

// A pact cannot prevent the required single-commander victory once all outside rivals are gone.
test('the final allied commanders and eliminated allies are released from their pact', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  engine.game.countries.forEach((country, index) => {
    country.owner = index < 5 ? 0 : 1;
  });
  engine.game.turnStarted = false;
  engine.beginTurn();
  assert.equal(engine.game.events.at(-2).diplomacy.action, 'ended');
  assert.match(engine.game.events.at(-2).diplomacy.reason, /one commander/);
  assert.equal(allianceFor(engine.game, 0), null);
  assert.equal(evaluateAlliance(engine.game, 0, 1).accepted, false);
  const eliminated = arena();
  eliminated.proposeAlliance(1);
  eliminated.game.countries
    .filter((country) => country.owner === 1)
    .forEach((country) => {
      country.owner = 2;
    });
  eliminated.game.turnStarted = false;
  eliminated.beginTurn();
  assert.match(eliminated.game.events.at(-2).diplomacy.reason, /no longer controls/);
});

// Room history trimming and JSON reload must preserve pacts without referencing mutable old events.
test('bounded snapshots survive a one-event history and returned copies cannot edit old reports', () => {
  const engine = arena();
  assert.deepEqual(diplomacyState(engine.game), { alliances: [], trust: [], lastOffers: [] });
  engine.proposeAlliance(1);
  const accepted = structuredClone(engine.game.events[0]);
  engine.transfer(engine.game.countries[0].code, engine.game.countries[1].code, 1);
  assert.deepEqual(engine.game.events[0], accepted);
  const state = diplomacyState(engine.game);
  state.alliances.length = 0;
  state.trust[0].value = 0;
  assert.equal(allianceFor(engine.game, 0).ally, 1);
  const saved = JSON.parse(JSON.stringify(engine.game));
  saved.events = saved.events.slice(-1);
  const reloaded = new GameEngine(saved);
  assert.equal(allianceFor(reloaded.game, 0).ally, 1);
  assert.equal(trustFor(reloaded.game, 1, 0), 53);
  assert.equal(isDiplomacyState(reloaded.game.events[0].diplomacyState), true);
});

// Corrupt or oversized metadata must be rejected instead of creating overlapping or permanent pacts.
test('metadata validators reject overlapping pacts, unbounded state and invalid facts', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  const valid = diplomacyState(engine.game);
  const overlap = structuredClone(valid);
  overlap.alliances.push({ players: [1, 2], startedRound: 1, expiresRound: 4 });
  assert.equal(isDiplomacyState(overlap), false);
  const permanent = structuredClone(valid);
  permanent.alliances[0].expiresRound = 100;
  assert.equal(isDiplomacyState(permanent), false);
  assert.equal(
    isDiplomacyState({ ...valid, lastOffers: Array(11).fill({ player: 0, round: 1 }) }),
    false,
  );
  const fact = engine.game.events.at(-1).diplomacy;
  assert.equal(isDiplomacyFact({ ...fact, expiresRound: undefined }), false);
  assert.equal(isDiplomacyFact({ ...fact, expiresRound: '4' }), false);
  assert.equal(isDiplomacyFact({ ...fact, target: fact.proposer }), false);
  assert.equal(isDiplomacyFact({ ...fact, reason: 'x'.repeat(401) }), false);
  assert.equal(isDiplomacyFact(fact, 2), false, 'accepted expiry belongs to the event round');
  assert.equal(isDiplomacyState(valid, 0), false);
  const future = structuredClone(valid);
  future.lastOffers[0].round = 2;
  assert.equal(isDiplomacyState(future, 1), false);
  const arrayState = Object.assign([], valid);
  assert.equal(isDiplomacyState(arrayState), false);
  engine.game.events.at(-1).diplomacyState = permanent;
  assert.deepEqual(diplomacyState(engine.game), { alliances: [], trust: [], lastOffers: [] });
});

// Event callers must not retain a mutable reference into saved diplomatic history.
test('event snapshots are independent copies and reject invalid future metadata atomically', () => {
  const engine = arena();
  const state = { alliances: [], trust: [], lastOffers: [{ player: 0, round: 1 }] };
  engine.event('decision', 'A diplomacy snapshot.', { diplomacyState: state });
  state.lastOffers[0].round = 2;
  assert.equal(engine.game.events[0].diplomacyState.lastOffers[0].round, 1);
  const before = structuredClone(engine.game);
  assert.throws(() => engine.event('decision', 'Invalid snapshot.', { diplomacyState: state }));
  assert.deepEqual(engine.game, before);
  engine.event('decision', 'Another normal planning fact.');
  assert.deepEqual(engine.game.events[1].diplomacyState, engine.game.events[0].diplomacyState);
  assert.notEqual(engine.game.events[1].diplomacyState, engine.game.events[0].diplomacyState);
});

// A useful ally is protected even if its weak country would otherwise be the best conquest target.
test('NPCs respect ordinary pacts and explain a strategic betrayal of a near-winning ally', () => {
  const engine = arena();
  engine.proposeAlliance(1);
  engine.game.position = 1;
  engine.game.countries
    .filter((country) => country.owner === 0)
    .forEach((country) => {
      country.army = 1;
    });
  let plan = engine.npcPlan();
  assert.notEqual(plan.to?.owner, 0);
  engine.game.countries.forEach((country, index) => {
    country.owner = index === 2 || index === 3 ? 1 : index < 8 ? 0 : 2;
    country.army = country.owner === 1 ? 20 : country.owner === 0 ? 1 : 1000;
  });
  plan = engine.npcPlan();
  assert.equal(plan.to.owner, 0);
  assert.match(plan.reason, /Breaking the pact.*threatens to win/);
  engine.startAttack(plan.from.code, plan.to.code);
  assert.match(engine.game.events.at(-2).diplomacy.reason, /threatens to win/);
});
