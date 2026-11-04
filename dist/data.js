import { bundledPopulations } from './population-snapshot.js';
import { validatePopulationSnapshot } from './population-schema.js';
import { countryMetadata } from './country-catalogue.js';
import { legacyCountries } from './legacy-countries.js';
export const colours = [
  '#2DD4BF',
  '#E6AE57',
  '#8C9EFF',
  '#F68FA1',
  '#A5CE72',
  '#D5A0EC',
  '#73B9E8',
  '#DCC684',
  '#E09B75',
  '#9FAABF',
];
export const commanders = [
  'You',
  'Kestrel',
  'Atlas',
  'Vesper',
  'Orion',
  'Flint',
  'Sable',
  'Rook',
  'Nova',
  'Echo',
];
const initialPopulationSnapshot = validatePopulationSnapshot(bundledPopulations);
// Gameplay population bands use millions; downloaded snapshots store whole-person counts.
const referenceCatalogue = countryMetadata.map(
  ({ populationSlug: _populationSlug, ...country }) => ({
    ...country,
    population: initialPopulationSnapshot.populations[country.code] / 1000000,
  }),
);
/** Keep selectable countries separate from the reference needed to read existing saves. */
export const isPlayableCountry = (code) =>
  code !== 'IL' && referenceCatalogue.some((country) => country.code === code);
export const catalogue = referenceCatalogue.filter((country) => isPlayableCountry(country.code));
// Preserve original figures only as fallbacks for old saves missing their own snapshot.
export const legacyPopulations = Object.freeze({
  ...Object.fromEntries(referenceCatalogue.map((country) => [country.code, country.population])),
  ...Object.fromEntries(legacyCountries.map((country) => [country.code, country.population])),
});
export const populationReference = {
  source: initialPopulationSnapshot.source,
  year: initialPopulationSnapshot.year,
  fetchedAt: initialPopulationSnapshot.fetchedAt,
};
/** Convert population in millions to the assignment’s inclusive starting-army bands. */
export const armyValue = (population) =>
  [5, 10, 25, 50, 75, 100, 125, 150, Infinity].findIndex((max) => population <= max) + 1;
/** Total conquest bonus, including the soldier that garrisons the captured country. */
export const conquestReward = (originalArmyValue) => Math.max(2, Math.floor(originalArmyValue / 2));
// Keep saved gameplay values; use trusted local metadata for labels and geometry.
export function savedCountryPopulation(country) {
  const population =
    country.population === undefined ? legacyPopulations[country.code] : country.population;
  const value = country.value === undefined ? armyValue(population) : country.value;
  if (
    !Number.isFinite(population) ||
    population <= 0 ||
    population > 2000 ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 9
  )
    throw new Error('Invalid saved country population.');
  return { population, value };
}
export const findCountry = (code) => referenceCatalogue.find((country) => country.code === code);
export const flag = (code) => findCountry(code)?.flag || '🌐';
export const initials = (name) =>
  name
    .split(' ')
    .map((x) => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
