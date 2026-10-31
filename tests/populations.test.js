import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledPopulations } from '../dist/population-snapshot.js';
import {
  populationCountries,
  validatePopulationSnapshot,
  validatePopulationUpdate,
} from '../dist/population-schema.js';
import { legacyCountries } from '../dist/legacy-countries.js';
import {
  createPopulationStore,
  POPULATION_CACHE_KEY,
  refreshSetupPopulation,
  populationFetcher,
} from '../dist/populations.js';
import { parsePopulationTable, fetchPopulations } from '../scripts/update-populations.mjs';
import {
  catalogue,
  populationReference,
  armyValue,
  savedCountryPopulation,
  legacyPopulations,
} from '../dist/data.js';
import { GameEngine, BattleEngine } from '../dist/engine.js';
import { newRoom, startRoom, readRoomGame, moveRoom } from '../dist/rooms.js';
import { createLocalPopulationSource } from '../scripts/local-populations.mjs';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const time = () => Math.max(Date.now(), Date.parse(bundledPopulations.fetchedAt) + 1000);
const newer = (overrides = {}) => ({
  ...structuredClone(bundledPopulations),
  fetchedAt: new Date(time()).toISOString(),
  ...overrides,
});
function memory(value) {
  return {
    getItem: (key) => (key === POPULATION_CACHE_KEY ? value : null),
    setItem: (key, next) => {
      assert.equal(key, POPULATION_CACHE_KEY);
      value = next;
    },
    get value() {
      return value;
    },
  };
}
const table = (snapshot = bundledPopulations) =>
  '<table><thead><tr><th>#</th><th>Country (or dependency)</th><th>Population ' +
  snapshot.year +
  '</th><th>Change</th></tr></thead><tbody>' +
  Object.entries(populationCountries)
    .map(
      ([code, slug], i) =>
        `<tr><td>${i + 1}</td><td><a href="/world-population/${slug}-population/">${slug}</a></td><td data-order="${snapshot.populations[code] * 10000}"><b>${snapshot.populations[code].toLocaleString('en-US')}</b></td><td>1%</td></tr>`,
    )
    .join('') +
  '</tbody></table>';

test('Worldometers parser reads visible counts, year and country links rather than scaled sorting attributes', () => {
  const result = parsePopulationTable('<script>ignore()</script>' + table(), time());
  assert.deepEqual(result.populations, bundledPopulations.populations);
  assert.equal(result.year, bundledPopulations.year);
  assert.equal(Object.keys(result.populations).length, catalogue.length);
});
test('changed HTML, missing countries, duplicate rows and nonnumeric counts are rejected as a whole', () => {
  assert.throws(() => parsePopulationTable('<html>Service unavailable</html>'));
  assert.throws(
    () => parsePopulationTable(table().replace('south-africa-population', 'unknown-population')),
    /missing/,
  );
  const row = table().match(/<tr><td>1<\/td>.*?<\/tr>/)[0];
  assert.throws(
    () => parsePopulationTable(table().replace('</tbody>', row + '</tbody>')),
    /duplicate/,
  );
  assert.throws(
    () => parsePopulationTable(table().replace(/<b>[\d,]+<\/b>/, '<b>Unavailable</b>')),
    /Invalid/,
  );
  assert.throws(() =>
    parsePopulationTable(
      table().replace('Population ' + bundledPopulations.year, 'Population 2001'),
    ),
  );
});
test('source, future timestamps, missing totals, implausible changes and year rollbacks cannot replace a snapshot', () => {
  assert.throws(() => validatePopulationSnapshot(newer({ source: 'https://example.com' })));
  assert.throws(() =>
    validatePopulationSnapshot(newer({ fetchedAt: new Date(time() + 86400000).toISOString() })),
  );
  for (const count of [null, -1, NaN, '65453084', 65453084.5, 654530840000])
    assert.throws(() =>
      validatePopulationSnapshot(
        newer({ populations: { ...bundledPopulations.populations, ZA: count } }),
      ),
    );
  assert.throws(() =>
    validatePopulationUpdate(newer({ year: bundledPopulations.year - 1 }), bundledPopulations),
  );
  assert.throws(
    () =>
      validatePopulationUpdate(
        newer({ populations: { ...bundledPopulations.populations, ZA: 200000000 } }),
        bundledPopulations,
      ),
    /25%/,
  );
});
test('the complete catalogue supports microstates with one soldier and exactly ten countries per game', () => {
  assert.equal(catalogue.length, 234);
  assert.equal(new Set(catalogue.map((country) => country.code)).size, 234);
  assert.equal(new Set(catalogue.map((country) => country.id)).size, 234);
  const vatican = catalogue.find((country) => country.code === 'VA');
  assert.match(vatican.name, /Vatican/);
  assert.equal(armyValue(vatican.population), 1);
  assert.equal(bundledPopulations.populations.VA, 506);
  for (const country of catalogue) {
    const game = GameEngine.create('Full catalogue check', country.code, false);
    assert.equal(game.countries[0].code, country.code);
    assert.equal(game.countries.length, 10);
    assert.equal(new Set(game.countries.map((country) => country.code)).size, 10);
    for (const participant of game.countries)
      assert.equal(participant.army, armyValue(participant.population));
  }
  assert.equal(GameEngine.create('Microstate fixture', 'VA', true).countries.length, 10);
  for (const old of legacyCountries) {
    const current = catalogue.find((country) => country.code === old.code);
    for (const key of ['id', 'name', 'flag', 'lon', 'lat']) assert.equal(current[key], old[key]);
  }
});
test('population publication can migrate the original complete 24-country snapshot without losing validation', () => {
  const old = {
    ...structuredClone(bundledPopulations),
    version: 1,
    populations: Object.fromEntries(
      legacyCountries.map((country) => [
        country.code,
        bundledPopulations.populations[country.code],
      ]),
    ),
  };
  assert.throws(() => validatePopulationSnapshot(old));
  assert.equal(validatePopulationUpdate(newer(), old).version, 2);
  const incomplete = structuredClone(old);
  delete incomplete.populations.ZA;
  assert.throws(() => validatePopulationUpdate(newer(), incomplete));
  assert.equal(validatePopulationSnapshot(bundledPopulations).populations.VA, 506);
});
test('offline, malformed and stalled updates preserve the complete working catalogue and cached snapshot', async () => {
  for (const fetchSnapshot of [
    async () => {
      throw new Error('offline');
    },
    async () => ({}),
    () => new Promise(() => {}),
  ]) {
    const countries = structuredClone(catalogue),
      original = structuredClone(countries),
      storage = memory(null),
      reference = {};
    const store = createPopulationStore({
      catalogue: countries,
      reference,
      storage,
      fetchSnapshot,
      timeout: 5,
    });
    assert.equal(await store.refresh(), false);
    assert.deepEqual(countries, original);
    assert.equal(storage.value, null);
    assert.equal(store.status, 'unavailable');
  }
});
test('a valid update is cached, checks are bounded, and blocked or corrupt storage never prevents startup', async () => {
  const countries = structuredClone(catalogue),
    storage = memory(null);
  let calls = 0;
  const snapshot = newer({ populations: { ...bundledPopulations.populations, ZA: 76000001 } });
  const store = createPopulationStore({
    catalogue: countries,
    reference: {},
    storage,
    fetchSnapshot: async () => {
      calls++;
      return snapshot;
    },
    now: time,
  });
  assert.equal(await store.refresh(), true);
  await store.refresh();
  assert.equal(calls, 1);
  assert.equal(countries.find((c) => c.code === 'ZA').population, 76.000001);
  assert.equal(armyValue(76.000001), 6);
  const restored = structuredClone(catalogue);
  createPopulationStore({ catalogue: restored, reference: {}, storage, now: time });
  assert.equal(restored[0].population, 76.000001);
  for (const broken of [
    memory('{bad'),
    {
      getItem() {
        throw new Error('blocked');
      },
    },
  ])
    assert.doesNotThrow(() =>
      createPopulationStore({
        catalogue: structuredClone(catalogue),
        reference: {},
        storage: broken,
      }),
    );
  const blocked = createPopulationStore({
    catalogue: structuredClone(catalogue),
    reference: {},
    storage: {
      setItem() {
        throw new Error('quota');
      },
    },
    fetchSnapshot: async () => snapshot,
    now: time,
  });
  assert.equal(await blocked.refresh(), true);
});
test('a delayed older response and corrupt cache cannot roll back newer bundled or saved figures', async () => {
  const countries = structuredClone(catalogue),
    snapshot = newer(),
    storage = memory(JSON.stringify({ snapshot, checkedAt: 0 }));
  const store = createPopulationStore({
    catalogue: countries,
    reference: {},
    storage,
    fetchSnapshot: async () => bundledPopulations,
    now: time,
  });
  assert.equal(await store.refresh(), false);
  assert.deepEqual(store.snapshot, snapshot);
});
test('new games use updated figures while an existing campaign and its saved rewards remain untouched', async () => {
  const original = structuredClone(catalogue),
    reference = { ...populationReference };
  try {
    const existing = GameEngine.create('Existing', 'ZA', true),
      before = JSON.stringify(existing);
    const store = createPopulationStore({
      catalogue,
      reference: populationReference,
      fetchSnapshot: async () =>
        newer({ populations: { ...bundledPopulations.populations, ZA: 76000001 } }),
      now: time,
    });
    await store.refresh();
    const next = GameEngine.create('New', 'ZA', false);
    assert.equal(next.countries[0].value, 6);
    assert.equal(next.countries[0].army, 6);
    assert.equal(JSON.stringify(existing), before);
    assert.equal(next.populationSource.source, bundledPopulations.source);
  } finally {
    for (let i = 0; i < catalogue.length; i++) Object.assign(catalogue[i], original[i]);
    Object.assign(populationReference, reference);
  }
});
test('updating an unsaved setup preserves opponents, order and identity and updates its first event board', () => {
  const preview = GameEngine.create('Preview', 'ZA', false, 'hard'),
    codes = preview.countries.map((c) => c.code),
    order = [...preview.order],
    id = preview.id;
  const countries = structuredClone(catalogue);
  countries[0].population = 76.000001;
  refreshSetupPopulation(preview, countries, populationReference, armyValue);
  assert.equal(preview.countries[0].army, 6);
  assert.deepEqual(
    preview.countries.map((c) => c.code),
    codes,
  );
  assert.deepEqual(preview.order, order);
  assert.equal(preview.id, id);
  assert.equal(preview.events[0].board[0].army, 6);
  assert.equal(preview.difficulty, 'hard');
});
test('room reloads and conquest preserve the original population and reward despite newer catalogue values', () => {
  let room = startRoom(newRoom('ABC234', { uid: 'host' }), 'host').room,
    g = JSON.parse(room.payload);
  const target = g.countries[0],
    origin = g.countries[1];
  target.population = 126;
  target.value = 8;
  target.army = 1;
  target.owner = 1;
  origin.owner = 0;
  origin.army = 10;
  g.position = g.order.indexOf(0);
  g.budget = 0;
  g.attackUsed = false;
  g.battle = null;
  room = { ...room, currentSeat: 0, controllerUid: 'host', payload: JSON.stringify(g) };
  const restored = readRoomGame(room);
  assert.equal(restored.countries[0].population, 126);
  assert.equal(restored.countries[0].value, 8);
  room = moveRoom(room, 'host', room.revision, 'attack', {
    from: origin.code,
    to: target.code,
  }).room;
  const resolve = BattleEngine.resolve;
  let n = 0;
  try {
    BattleEngine.resolve = (a, d) => resolve(a, d, () => (++n % 2 ? 6 : 1));
    const result = moveRoom(room, 'host', room.revision, 'roll');
    assert.equal(JSON.parse(result.room.payload).lastBattle.reward, 4);
  } finally {
    BattleEngine.resolve = resolve;
  }
});
test('older saved values have a fixed legacy fallback and malformed population fields are rejected', () => {
  assert.deepEqual(savedCountryPopulation({ code: 'ZA' }), {
    population: legacyPopulations.ZA,
    value: armyValue(legacyPopulations.ZA),
  });
  assert.deepEqual(savedCountryPopulation({ code: 'ZA', population: 65, value: 6 }), {
    population: 65,
    value: 6,
  });
  for (const value of [NaN, 0, -1, '65', Infinity])
    assert.throws(() => savedCountryPopulation({ code: 'ZA', population: value }));
});
test('public snapshot fetch rejects error responses and oversized payloads; source outages fail without publishing', async () => {
  const config = { projectId: 'test' };
  await assert.rejects(populationFetcher(config, async () => ({ ok: false }))());
  await assert.rejects(
    populationFetcher(config, async () => ({
      ok: true,
      json: async () => ({ fields: { payload: { stringValue: 'x'.repeat(10001) } } }),
    }))(),
  );
  await assert.rejects(
    fetchPopulations(async () => ({ ok: false, status: 503 })),
    /503/,
  );
});
test('local updater saves a validated response atomically, deduplicates checks and restores its cache offline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meridian-populations-')),
    file = path.join(directory, 'snapshot.json');
  let clock = time(),
    calls = 0;
  try {
    const snapshot = newer({ populations: { ...bundledPopulations.populations, ZA: 76000001 } });
    const source = await createLocalPopulationSource({
      file,
      now: () => clock,
      fetchSnapshot: async () => {
        calls++;
        return snapshot;
      },
    });
    await Promise.all([source.refresh(), source.refresh()]);
    assert.equal(calls, 1);
    assert.equal(source.snapshot.populations.ZA, 76000001);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).snapshot, snapshot);
    clock += 86400001;
    const offline = await createLocalPopulationSource({
      file,
      now: () => clock,
      fetchSnapshot: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(await offline.refresh(), false);
    assert.deepEqual(offline.snapshot, snapshot);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).snapshot, snapshot);
  } finally {
    await unlink(file).catch(() => {});
    await unlink(file + '.tmp').catch(() => {});
    await rmdir(directory);
  }
});
test('local source validation failures keep both the persisted snapshot and the served response intact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meridian-populations-')),
    file = path.join(directory, 'snapshot.json');
  try {
    const saved = { snapshot: bundledPopulations, checkedAt: 0 };
    await writeFile(file, JSON.stringify(saved));
    const source = await createLocalPopulationSource({
      file,
      fetchSnapshot: async () => ({ populations: { ZA: 1 } }),
    });
    assert.equal(await source.refresh(), false);
    assert.deepEqual(source.snapshot, bundledPopulations);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  } finally {
    await unlink(file).catch(() => {});
    await unlink(file + '.tmp').catch(() => {});
    await rmdir(directory);
  }
});
