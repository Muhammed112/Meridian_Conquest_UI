import { bundledPopulations } from './population-snapshot.js';
import { validatePopulationSnapshot, validatePopulationUpdate } from './population-schema.js';

export const POPULATION_CACHE_KEY = 'meridian-populations-v2';
const day = 86400000;
export function createPopulationStore({
  catalogue,
  reference,
  storage,
  fetchSnapshot,
  onChange = () => {},
  now = () => Date.now(),
  timeout = 8000,
}) {
  let current = validatePopulationSnapshot(bundledPopulations, now()),
    lastCheck = 0,
    retryAfter = 0,
    pending = null,
    state = 'saved';
  const apply = (snapshot) => {
    current = snapshot;
    for (const country of catalogue)
      country.population = snapshot.populations[country.code] / 1000000;
    Object.assign(reference, {
      source: snapshot.source,
      year: snapshot.year,
      fetchedAt: snapshot.fetchedAt,
    });
  };
  try {
    const cached = JSON.parse(storage?.getItem(POPULATION_CACHE_KEY) || 'null');
    if (cached) {
      current = validatePopulationUpdate(cached.snapshot, current, now());
      lastCheck =
        Number.isFinite(cached.checkedAt) && cached.checkedAt <= now() ? cached.checkedAt : 0;
    }
  } catch {
    // Optional storage or browser capability is unavailable; retain the fallback.
  }
  apply(current);
  async function refresh() {
    if (pending) return pending;
    if (!fetchSnapshot || now() < retryAfter || (lastCheck && now() - lastCheck < day))
      return false;
    pending = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const snapshot = await Promise.race([
          fetchSnapshot(controller.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Population refresh timed out.'));
            }, timeout);
          }),
        ]);
        const next = validatePopulationUpdate(snapshot, current, now());
        const changed =
          JSON.stringify(next.populations) !== JSON.stringify(current.populations) ||
          next.year !== current.year;
        apply(next);
        lastCheck = now();
        retryAfter = 0;
        state = 'ready';
        try {
          storage?.setItem(
            POPULATION_CACHE_KEY,
            JSON.stringify({ snapshot: next, checkedAt: lastCheck }),
          );
        } catch {
          // Optional storage or browser capability is unavailable; retain the fallback.
        }
        onChange({ changed, state });
        return true;
      } catch {
        state = 'unavailable';
        retryAfter = now() + 3600000;
        onChange({ changed: false, state });
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    refresh,
    get snapshot() {
      return structuredClone(current);
    },
    get status() {
      return state;
    },
  };
}
export function populationFetcher(config, fetcher = fetch) {
  if (!config?.projectId) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents/publicData/populations`;
  return async (signal) => {
    const response = await fetcher(url, { signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('Population snapshot is unavailable.');
    const document = await response.json(),
      payload = document.fields?.payload?.stringValue;
    if (typeof payload !== 'string' || payload.length > 10000)
      throw new Error('Invalid population snapshot.');
    return JSON.parse(payload);
  };
}
export function localPopulationFetcher(fetcher = fetch) {
  return async (signal) => {
    const response = await fetcher('/population-data.json', {
      signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('The local population snapshot is unavailable.');
    return response.json();
  };
}
// Called only for the unsaved setup preview, never for a campaign or room.
export function refreshSetupPopulation(game, catalogue, reference, armyValue) {
  if (!game || game.round !== 1 || game.events.some((e) => e.type !== 'turn')) return;
  for (const country of game.countries) {
    const known = catalogue.find((c) => c.code === country.code);
    country.population = known.population;
    country.value = armyValue(known.population);
    country.army = country.value;
  }
  game.populationSource = { ...reference };
  for (const event of game.events)
    event.board = game.countries.map(({ code, owner, army }) => ({ code, owner, army }));
}
