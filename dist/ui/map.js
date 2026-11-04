import { renderIcon } from './components.js';
import { escapeHTML } from '../html.js';
import { catalogue, armyValue, colours } from '../data.js';
import {
  victoryMotion,
  mapEffects,
  mapOverlay,
  countryPoint,
  connectionPath,
  countryMotion,
} from '../motion.js?v=battle-reveal-20261026-1';
import { worldPaths } from '../assets/world-paths.js?v=map-seam-20261026-1';

/** Render trusted map geometry with selectable markers and presentation-only effects. */
export function createMapView(context) {
  /** Render the fixed-aspect map; country markers stay at their geographic coordinates. */
  function map(
    countries = catalogue
      .slice(0, 10)
      .map((c, i) => ({ ...c, owner: i, army: armyValue(c.population) })),
    {
      interactive = false,
      mini = false,
      selected = null,
      origin = null,
      target = null,
      motion = null,
      showDetails = true,
    } = {},
  ) {
    const { nameOf } = context;

    // Geometry comes from trusted bundled paths; game records supply ownership and troop values.
    const set = new Map(countries.map((c) => [c.id, c]));
    const markers = countries
      .map((c, i) => {
        const [x, y] = countryPoint(c);
        const dx = c.code === 'GB' ? -29 : c.code === 'NO' ? 16 : c.code === 'JP' ? 12 : 0,
          dy =
            c.code === 'CA'
              ? -11
              : c.code === 'GB'
                ? 15
                : c.code === 'NO'
                  ? -14
                  : c.code === 'EG'
                    ? -12
                    : 17;
        const colour = colours[c.owner ?? i];
        return /* prettier-ignore */ `<g
          class="map-marker ${interactive ? 'interactive' : ''} ${
            selected === c.code ? 'selected' : ''
          }"
          style="--marker:${colour}"
          ${
            interactive
              ? /* prettier-ignore */ `data-map-country="${c.code}" data-action="select-country" data-code="${
                        c.code
                      }" role="button" tabindex="0" aria-label="${escapeHTML(c.name)}, ${c.army} soldiers, ${
                        nameOf(c.owner)
                      }"`
              : ''
          }
          >${
            !mini
              ? /* prettier-ignore */ `<line class="map-label-leader" x1="${x}" y1="${y}" x2="${x}" y2="${
                        y
                      }" aria-hidden="true" hidden />`
              : ''
          }${
            selected === c.code && !mini
                ? /* HTML */ `<circle class="selection-ring" cx="${x}" cy="${y}" r="11" />`
                : ''
          }<circle
            cx="${x}"
            cy="${y}"
            r="${mini ? 3 : 5}"
          />${
            !mini
              ? /* HTML */ `<text x="${x + dx}" y="${y + dy}" text-anchor="middle">${c.code} · ${c.army}</text>`
              : ''
          }</g
        >`;
      })
      .join('');
    const a = countries.find((c) => c.code === (motion?.route?.from || origin || selected)),
      b = countries.find((c) => c.code === (motion?.route?.to || target));
    // Distinct SVG identifiers prevent mini-map patterns from clashing with the active board.
    const suffix = mini ? 'mini' : interactive ? 'game' : 'hero',
      arrowId = `attack-arrow-${suffix}`,
      routeType = motion?.route?.kind === 'transfer' ? 'transfer' : '',
      routeColour = routeType ? '#2DD4BF' : '#E9CD76';
    let connection = '';
    if (a && b && a !== b) {
      const path = connectionPath(a, b);
      connection = motion?.route?.active
        ? /* HTML */ `<path class="map-attack-glow ${routeType}" d="${path}" /><path
              class="map-attack-route ${routeType}"
              marker-end="url(#${arrowId})"
              d="${path}"
            />`
        : /* HTML */ `<path class="map-line" d="${path}" />`;
    }
    const zoom = victoryMotion(motion);
    const land = worldPaths
      .map((p) => {
        const c = set.get(p.id),
          effect = c ? countryMotion(motion, c) : null;
        return /* prettier-ignore */ `<path
          d="${p.d}"
          class="land ${c ? 'active' : ''} ${c && interactive ? 'interactive' : ''} ${
            selected === c?.code ? 'selected' : ''
          } ${effect?.className || ''}"
          ${c ? `style="${effect.style}"` : ''}
          ${
            c && interactive
                ? `data-map-country="${c.code}" data-action="select-country" data-code="${c.code}"`
                : ''
          }
        />`;
      })
      .join('');
    return /* HTML */ `<div class="map-viewport"
      ><svg
        class="world-map ${zoom.className}"
        style="${zoom.style}"
        viewBox="0 0 960 480"
        role="${interactive ? 'group' : 'img'}"
        aria-label="World map showing the ten participating countries and their soldier counts"
      >
        <defs>
          <pattern id="grid-${suffix}" width="80" height="80" patternUnits="userSpaceOnUse">
            <path d="M80 0H0V80" class="map-grid" fill="none" />
          </pattern>
          <marker
            id="${arrowId}"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8L2 4Z" fill="${routeColour}" />
          </marker>
        </defs>
        <rect width="960" height="480" fill="url(#grid-${suffix})" />
        ${land}${connection}${markers}${mapEffects(motion, countries)}</svg
      >${mapOverlay(motion)}${
        !mini && showDetails
          ? /* HTML */ `<span class="map-coordinate"
                >WORLD THEATRE / ${interactive ? 'LIVE BOARD' : 'GLOBAL VIEW'}</span
              ><span class="map-compass"
                >N<svg viewBox="0 0 30 30"><path d="M15 2v26M2 15h26m-13-9 3 9-3 9-3-9z" /></svg
              ></span>`
          : ''
      }</div
    >`;
  }

  /** Wrap the map, retaining explanatory chrome only for the welcome demo. */
  function theatre(countries, options = {}) {
    const showDetails = Boolean(options.demo);
    return /* HTML */ `<section class="theatre ${options.interactive ? 'game-theatre' : ''}"
      >${
        showDetails
          ? /* HTML */ `<div class="theatre-head"
              ><span class="eyebrow">Your next campaign</span
              ><span class="badge live">Gameplay preview</span></div
            >`
          : ''
      }${map(countries, { ...options, showDetails })}${
        showDetails
          ? /* HTML */ `<div class="theatre-footer"
              ><span class="caption">Global range · Every enemy is within reach</span
              ><span class="badge">${renderIcon('globe')} No borders</span></div
            >`
          : ''
      }</section
    >`;
  }
  return { map, theatre };
}
