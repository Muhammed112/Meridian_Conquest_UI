// Diplomacy belongs to factual event history so old boards need no migration and room
// history trimming can retain the latest bounded snapshot without adding a board field.
const isSeat = (value) => Number.isInteger(value) && value >= 0 && value < 10;
const isRound = (value) => Number.isInteger(value) && value >= 1 && value <= 100000;
const hasKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const emptyState = () => ({ alliances: [], trust: [], lastOffers: [] });

/** Validate bounded, disjoint pacts and directed trust before reading saved metadata. */
export function isDiplomacyState(state, round = 100000) {
  if (
    !isRound(round) ||
    !hasKeys(state, ['alliances', 'trust', 'lastOffers']) ||
    !Array.isArray(state.alliances) ||
    state.alliances.length > 5 ||
    !Array.isArray(state.trust) ||
    state.trust.length > 90 ||
    !Array.isArray(state.lastOffers) ||
    state.lastOffers.length > 10
  )
    return false;
  const allied = new Set(),
    relationships = new Set(),
    offerers = new Set();
  for (const pact of state.alliances) {
    if (
      !hasKeys(pact, ['players', 'startedRound', 'expiresRound']) ||
      !Array.isArray(pact.players) ||
      pact.players.length !== 2 ||
      pact.players.some((player) => !isSeat(player) || allied.has(player)) ||
      pact.players[0] === pact.players[1] ||
      !isRound(pact.startedRound) ||
      pact.startedRound > round ||
      pact.expiresRound !== pact.startedRound + 3
    )
      return false;
    pact.players.forEach((player) => allied.add(player));
  }
  for (const relationship of state.trust) {
    if (
      !hasKeys(relationship, ['observer', 'other', 'value']) ||
      !isSeat(relationship.observer) ||
      !isSeat(relationship.other) ||
      relationship.observer === relationship.other ||
      !Number.isInteger(relationship.value) ||
      relationship.value < 0 ||
      relationship.value > 100
    )
      return false;
    const pair = `${relationship.observer}:${relationship.other}`;
    if (relationships.has(pair)) return false;
    relationships.add(pair);
  }
  for (const offer of state.lastOffers) {
    if (
      !hasKeys(offer, ['player', 'round']) ||
      !isSeat(offer.player) ||
      !isRound(offer.round) ||
      offer.round > round ||
      offerers.has(offer.player)
    )
      return false;
    offerers.add(offer.player);
  }
  return true;
}

/** Keep diplomacy facts small and explicit enough for saves, spectators and narration. */
export function isDiplomacyFact(fact, round) {
  return Boolean(
    hasKeys(fact, ['action', 'proposer', 'target', 'reason', 'expiresRound']) &&
    ['accepted', 'declined', 'betrayed', 'expired', 'ended'].includes(fact.action) &&
    isSeat(fact.proposer) &&
    isSeat(fact.target) &&
    fact.proposer !== fact.target &&
    typeof fact.reason === 'string' &&
    fact.reason.trim() &&
    fact.reason.length <= 400 &&
    (fact.expiresRound === undefined
      ? fact.action !== 'accepted'
      : Number.isInteger(fact.expiresRound) &&
        fact.expiresRound >= 4 &&
        fact.expiresRound <= 100003) &&
    (round === undefined ||
      (isRound(round) && (fact.action !== 'accepted' || fact.expiresRound === round + 3))),
  );
}

/** Copy the latest event snapshot; never mutate historical reports or trust records. */
export function diplomacyState(game) {
  const event = (game.events || []).findLast((entry) => entry.diplomacyState !== undefined);
  return event && isDiplomacyState(event.diplomacyState, Math.min(event.round, game.round))
    ? structuredClone(event.diplomacyState)
    : emptyState();
}

/** Find an active commander-wide pact without treating eliminated seats as allies. */
export function allianceFor(game, player) {
  const alive = new Set(game.countries.map((country) => country.owner));
  const pact = diplomacyState(game).alliances.find(
    (entry) =>
      entry.players.includes(player) &&
      entry.expiresRound > game.round &&
      entry.players.every((seat) => alive.has(seat)) &&
      alive.size > 2,
  );
  return pact
    ? {
        ally: pact.players.find((seat) => seat !== player),
        startedRound: pact.startedRound,
        expiresRound: pact.expiresRound,
        roundsLeft: pact.expiresRound - game.round,
      }
    : null;
}

/** Trust is directional: a betrayed commander remembers who broke their agreement. */
export function trustFor(game, observer, other) {
  return (
    diplomacyState(game).trust.find((entry) => entry.observer === observer && entry.other === other)
      ?.value ?? 50
  );
}

/** Update one relationship in a copied state, keeping the complete history bounded. */
export function changeTrust(state, observer, other, amount) {
  let relationship = state.trust.find(
    (entry) => entry.observer === observer && entry.other === other,
  );
  if (!relationship) {
    relationship = { observer, other, value: 50 };
    state.trust.push(relationship);
  }
  relationship.value = Math.max(0, Math.min(100, relationship.value + amount));
}

/** Compare useful military support and common threats without consuming combat randomness. */
export function evaluateAlliance(game, proposer, target) {
  const trust = trustFor(game, target, proposer);
  const strength = (seat) =>
    game.countries
      .filter((country) => country.owner === seat)
      .reduce((total, country) => total + country.army, 0);
  const ownStrength = strength(target),
    support = strength(proposer);
  const outsiders = [...new Set(game.countries.map((country) => country.owner))].filter(
    (seat) => seat !== proposer && seat !== target,
  );
  const threat = Math.max(0, ...outsiders.map(strength));
  const commonThreat = threat > Math.max(ownStrength, support) * 1.25;
  if (!outsiders.length)
    return { accepted: false, reason: 'Only these commanders remain; one must win alone.', trust };
  const threatFromProposer = betrayalReason(game, target, proposer);
  if (threatFromProposer)
    return {
      accepted: false,
      reason:
        'The proposer already controls most countries and threatens to win; a pact would protect that lead.',
      trust,
    };
  if (trust < 30) {
    // A betrayal raises the acceptance bar; overwhelming shared danger can still justify a pact.
    const urgentCooperation =
      commonThreat && support >= ownStrength * 2 && support + ownStrength >= threat * 1.1;
    return {
      accepted: urgentCooperation,
      reason: urgentCooperation
        ? 'Trust remains low, but a dangerous common rival and substantial military support justify a temporary pact.'
        : 'Previous betrayal makes another pact too risky.',
      trust,
    };
  }
  if (support < ownStrength * 0.35)
    return { accepted: false, reason: 'The offer provides too little military support.', trust };
  if (commonThreat || support + ownStrength >= threat * 1.25)
    return {
      accepted: true,
      reason: commonThreat
        ? 'A stronger common rival makes cooperation useful.'
        : 'Combined strength offers useful support against the remaining rivals.',
      trust,
    };
  return { accepted: false, reason: 'This pact would not improve our position enough.', trust };
}

/** Bots break a pact only to contain an ally close to controlling the whole board. */
export function betrayalReason(game, player, ally) {
  const ownCount = game.countries.filter((country) => country.owner === player).length;
  const alliedCount = game.countries.filter((country) => country.owner === ally).length;
  return alliedCount >= 6 && alliedCount > ownCount * 2
    ? 'The ally now controls most countries and threatens to win; contain that expansion.'
    : null;
}
