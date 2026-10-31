import { findCountry, savedCountryPopulation } from './data.js';

export const RECORD_VERSION = 2;
export const EVENT_TYPES = Object.freeze([
  'campaign',
  'turn',
  'decision',
  'attack',
  'dice',
  'conquest',
  'reinforce',
  'transfer',
  'elimination',
  'victory',
  'retreat',
  'held',
]);
export const integerBetween = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;
const throwInvalidSave = () => {
  throw new Error(
    'This campaign contains invalid saved data. Your original save has not been changed.',
  );
};

// Validate at storage/network boundaries. Saved populations and rewards belong
// to the campaign; only display metadata comes from the current catalogue.
export function validateGameBoard(game) {
  if (
    !game ||
    typeof game !== 'object' ||
    typeof game.id !== 'string' ||
    !/^[\w-]{1,60}$/.test(game.id) ||
    typeof game.name !== 'string' ||
    !game.name.trim() ||
    game.name.length > 60 ||
    !Array.isArray(game.countries) ||
    game.countries.length !== 10 ||
    new Set(game.countries.map((c) => c?.code)).size !== 10 ||
    !Array.isArray(game.order) ||
    game.order.length !== 10 ||
    new Set(game.order).size !== 10 ||
    game.order.some((seat) => !integerBetween(seat, 0, 9)) ||
    !integerBetween(game.position, 0, 9) ||
    !integerBetween(game.round, 1, 100000) ||
    !integerBetween(game.budget, 0, 20) ||
    typeof game.attackUsed !== 'boolean' ||
    typeof game.turnStarted !== 'boolean' ||
    !['active', 'won', 'lost', 'finished'].includes(game.status) ||
    !(game.winner === null || integerBetween(game.winner, 0, 9))
  )
    throwInvalidSave();
  const countries = game.countries.map((country) => {
    const trusted = findCountry(country.code);
    if (
      !trusted ||
      !integerBetween(country.owner, 0, 9) ||
      !integerBetween(country.army, 1, 100000)
    )
      throwInvalidSave();
    return {
      ...trusted,
      ...savedCountryPopulation(country),
      owner: country.owner,
      army: country.army,
    };
  });
  if (game.winner !== null && countries.some((c) => c.owner !== game.winner)) throwInvalidSave();
  if (game.battle) {
    const from = countries.find((c) => c.code === game.battle.from),
      to = countries.find((c) => c.code === game.battle.to);
    if (
      !from ||
      !to ||
      from === to ||
      from.owner !== game.order[game.position] ||
      to.owner === from.owner ||
      from.army < 2 ||
      !game.attackUsed ||
      !integerBetween(game.battle.phase, 0, 100000)
    )
      throwInvalidSave();
    validateDicePairs(game.battle.pairs);
  }
  if (game.lastBattle?.pairs) validateDicePairs(game.lastBattle.pairs);
  if (
    game.playerNames !== undefined &&
    (!Array.isArray(game.playerNames) ||
      game.playerNames.length !== 10 ||
      game.playerNames.some((name) => typeof name !== 'string' || !name.trim() || name.length > 32))
  )
    throwInvalidSave();
  return { ...game, countries };
}

function validateDicePairs(pairs) {
  if (
    !Array.isArray(pairs) ||
    pairs.length > 100000 ||
    pairs.some((pair) => !integerBetween(pair?.a, 1, 6) || !integerBetween(pair?.d, 1, 6))
  )
    throwInvalidSave();
}

export function validateGameEvent(event, countryCodes) {
  if (
    !event ||
    typeof event.id !== 'string' ||
    !/^[\w-]{1,60}$/.test(event.id) ||
    !EVENT_TYPES.includes(event.type) ||
    typeof event.text !== 'string' ||
    event.text.length > 2000 ||
    !integerBetween(event.round, 1, 100000) ||
    !integerBetween(event.player, 0, 9) ||
    !Array.isArray(event.board) ||
    event.board.length !== 10 ||
    new Set(event.board.map((c) => c?.code)).size !== 10 ||
    event.board.some(
      (c) =>
        !countryCodes.has(c.code) ||
        !integerBetween(c.owner, 0, 9) ||
        !integerBetween(c.army, 0, 100000),
    )
  )
    throwInvalidSave();
  if (event.pairs) {
    validateDicePairs(event.pairs);
    if (
      event.attackerLoss !== undefined &&
      event.attackerLoss !== event.pairs.filter((p) => p.a < p.d).length
    )
      throwInvalidSave();
    if (
      event.defenderLoss !== undefined &&
      event.defenderLoss !== event.pairs.filter((p) => p.a > p.d).length
    )
      throwInvalidSave();
  }
  return event;
}

export function factualEvent(event) {
  const { commentary: _commentary, commentaryVersion: _commentaryVersion, ...facts } = event;
  return facts;
}

// Dual-write the legacy payload while deployed older clients remain in use.
// New readers use the typed map. No bulk migration or history rewrite occurs.
export function encodeBoard(game) {
  return encodeValidatedBoard(validateGameBoard(game));
}

function encodeValidatedBoard(game) {
  return {
    ...game,
    countryCodes: game.countries.map((country) => country.code),
    origins: Object.fromEntries(
      game.countries.map((country) => [
        country.code,
        { population: country.population, value: country.value },
      ]),
    ),
    countries: game.countries.map(({ code, owner, army }) => ({ code, owner, army })),
  };
}
export function decodeBoard(record) {
  if (
    !record ||
    !Array.isArray(record.countryCodes) ||
    !record.origins ||
    Object.keys(record.origins).length !== 10 ||
    !Array.isArray(record.countries) ||
    record.countryCodes.length !== 10 ||
    record.countries.length !== 10 ||
    record.countries.some(
      (c, i) =>
        c?.code !== record.countryCodes[i] ||
        !record.origins[c.code] ||
        record.origins[c.code].population === undefined ||
        record.origins[c.code].value === undefined,
    )
  )
    throwInvalidSave();
  const { origins, countryCodes: _countryCodes, ...game } = record;
  return validateGameBoard({
    ...game,
    countries: game.countries.map((c) => ({ ...c, ...origins[c.code] })),
  });
}
export function campaignRecord(game) {
  const { events: _events, ...board } = validateGameBoard(game);
  return {
    schemaVersion: RECORD_VERSION,
    board: encodeValidatedBoard(board),
    name: board.name,
    status: board.status,
    round: board.round,
    payload: JSON.stringify(board),
    updatedAt: game.updatedAt,
  };
}
export function readCampaignRecord(record) {
  if (record.schemaVersion === RECORD_VERSION) return decodeBoard(record.board);
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throwInvalidSave();
  return validateGameBoard(JSON.parse(record.payload));
}
export function eventRecord(event, sequence, game, context) {
  const facts = factualEvent(event);
  validateGameEvent(facts, new Set(game.countries.map((c) => c.code)));
  return {
    schemaVersion: RECORD_VERSION,
    sequence,
    type: facts.type,
    event: facts,
    ...(context ? { context: JSON.stringify(context), facts: context } : {}),
    payload: JSON.stringify(facts),
  };
}
export function readEventRecord(record, countryCodes) {
  if (
    record.schemaVersion !== undefined &&
    record.schemaVersion !== 1 &&
    record.schemaVersion !== RECORD_VERSION
  )
    throwInvalidSave();
  const event = record.schemaVersion === RECORD_VERSION ? record.event : JSON.parse(record.payload);
  return countryCodes ? validateGameEvent(event, countryCodes) : event;
}
