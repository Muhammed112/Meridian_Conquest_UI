import {
  armyValue,
  catalogue,
  commanders,
  findCountry,
  isPlayableCountry,
  savedCountryPopulation,
} from './data.js';

/** The haversine term orders nearby candidates without changing map or combat calculations. */
function geographicDistance(origin, candidate) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  return (
    Math.sin(radians(candidate.lat - origin.lat) / 2) ** 2 +
    Math.cos(radians(origin.lat)) *
      Math.cos(radians(candidate.lat)) *
      Math.sin(radians(candidate.lon - origin.lon) / 2) ** 2
  );
}

/** Select a deterministic unused replacement while preserving the saved starting-army band. */
export function selectCompatibleCountry(country, occupiedCodes = []) {
  const origin = findCountry(country.code);
  const { value } = savedCountryPopulation(country);
  const occupied = new Set(occupiedCodes);
  const replacement = catalogue
    .filter(
      (candidate) => !occupied.has(candidate.code) && armyValue(candidate.population) === value,
    )
    .sort(
      (left, right) =>
        geographicDistance(origin, left) - geographicDistance(origin, right) ||
        left.code.localeCompare(right.code),
    )[0];
  if (!replacement) throw new Error('A compatible country is unavailable for this campaign.');
  return replacement;
}

/** Keep old campaign progress while bringing known country references into the playable catalogue. */
export function normalizeCampaignCountries(game, { newEventId } = {}) {
  if (!Array.isArray(game?.countries)) return game;
  const excluded = game.countries.filter(
    (country) => findCountry(country.code) && !isPlayableCountry(country.code),
  );
  if (!excluded.length) return game;
  const used = new Set(game.countries.map((country) => country.code));
  const replacements = new Map();
  for (const country of excluded) {
    const origin = findCountry(country.code);
    const { value } = savedCountryPopulation(country);
    const replacement = selectCompatibleCountry(country, used);
    replacements.set(country.code, { origin, replacement, value });
    used.add(replacement.code);
  }
  const codeFor = (code) => replacements.get(code)?.replacement.code || code;
  const labelFor = (label) => {
    for (const { origin, replacement } of replacements.values())
      if (label === origin.name) return replacement.name;
    return codeFor(label);
  };
  const labels = [...replacements.values()].flatMap(({ origin, replacement }) => [
    [origin.name, replacement.name],
    [origin.code, replacement.code],
  ]);
  const replaceLabels = (text) => {
    if (typeof text !== 'string') return text;
    for (const [before, after] of labels) {
      const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), () => after);
    }
    return text;
  };
  const replaceCountryText = (text) => {
    if (typeof text !== 'string') return text;
    const names = Array.isArray(game.playerNames) ? game.playerNames : commanders;
    const commander = names.find((name) => text.startsWith(`${name}: `));
    const prefix = commander === undefined ? '' : `${commander}: `;
    return prefix + replaceLabels(text.slice(prefix.length));
  };
  const references = (record) => {
    if (!record || typeof record !== 'object') return record;
    const result = { ...record };
    for (const key of ['from', 'to', 'country'])
      if (key in result) result[key] = labelFor(result[key]);
    if (typeof result.reason === 'string') result.reason = replaceCountryText(result.reason);
    return result;
  };
  const intent = (record) => {
    if (!record || typeof record !== 'object') return record;
    const result = references(record);
    if (record.values) {
      result.values = references(record.values);
      if (record.values.allocations)
        result.values.allocations = Object.fromEntries(
          Object.entries(record.values.allocations).map(([code, amount]) => [
            codeFor(code),
            amount,
          ]),
        );
    }
    return result;
  };
  const normalized = structuredClone(game);
  normalized.countries = normalized.countries.map((country) => {
    const match = replacements.get(country.code);
    return match
      ? {
          ...country,
          ...match.replacement,
          value: match.value,
          owner: country.owner,
          army: country.army,
        }
      : country;
  });
  if ('start' in normalized) normalized.start = codeFor(normalized.start);
  if (normalized.battle) normalized.battle = references(normalized.battle);
  if (normalized.lastBattle) normalized.lastBattle = references(normalized.lastBattle);
  if (normalized.botIntent) normalized.botIntent = intent(normalized.botIntent);
  if (Array.isArray(normalized.countryCodes))
    normalized.countryCodes = normalized.countryCodes.map(codeFor);
  if (normalized.origins)
    normalized.origins = Object.fromEntries(
      Object.entries(normalized.origins).map(([code, origin]) => {
        const match = replacements.get(code);
        return [
          codeFor(code),
          match ? { population: match.replacement.population, value: match.value } : origin,
        ];
      }),
    );
  normalized.events = (normalized.events || []).map((event) => {
    const result = references(event);
    // Turn, victory and diplomacy text names commanders rather than countries.
    if (!['campaign', 'turn', 'elimination', 'victory'].includes(event.type) && !event.diplomacy)
      result.text = replaceCountryText(event.text);
    if (Array.isArray(event.board))
      result.board = event.board.map((country) => ({ ...country, code: codeFor(country.code) }));
    if (event.intent) result.intent = intent(event.intent);
    delete result.commentary;
    delete result.commentaryVersion;
    if (newEventId) result.id = newEventId();
    return result;
  });
  for (const key of ['commentary', 'commentaryVersion', 'aiReports', 'aiReportsV2'])
    delete normalized[key];
  return normalized;
}
