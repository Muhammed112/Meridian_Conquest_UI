import { readFile, writeFile } from 'node:fs/promises';
import { geoEquirectangular, geoPath, geoTransform } from 'd3-geo';
import { feature } from 'topojson-client';
import { worldPaths } from '../dist/assets/world-paths.js';

// Preserve the existing 960x480 map and country-marker coordinates. Clip
// longitude at the antimeridian before projecting Russia and Fiji so their
// outlines cannot close through the middle of the map.
const width = 960,
  height = 480,
  north = 85,
  south = -58;
const xScale = width / 360,
  yScale = height / (north - south),
  stretchY = yScale / xScale;
const spherical = geoEquirectangular()
  .scale((xScale * 180) / Math.PI)
  .translate([width / 2, north * xScale])
  .clipExtent([
    [0, 0],
    [width, height / stretchY],
  ]);
const stretch = geoTransform({
  point(x, y) {
    this.stream.point(x, y * stretchY);
  },
});
const projected = { stream: (output) => spherical.stream(stretch.stream(output)) };
const draw = geoPath(projected).digits(1);
const topology = JSON.parse(
  await readFile(new URL('../dist/assets/world.topo.json', import.meta.url), 'utf8'),
);
const countries = feature(topology, topology.objects.countries).features;
// Only Fiji and Russia cross the seam; regenerating every outline would create unrelated map changes.
const crossing = new Set(['242', '643']);
const fixed = worldPaths.map((country) => {
  if (!crossing.has(country.id)) return country;
  const shape = countries.find((item) => String(item.id).padStart(3, '0') === country.id);
  const d = shape && draw(shape);
  if (!d) throw new Error('Missing projected geometry for ' + country.name);
  return { ...country, d };
});
await writeFile(
  new URL('../dist/assets/world-paths.js', import.meta.url),
  'export const worldPaths = ' + JSON.stringify(fixed) + ';\n',
);
console.log('Clipped Russia and Fiji at the map seam; other country paths were preserved.');
