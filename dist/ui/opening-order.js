import { escapeHTML } from '../html.js';
import { openingTurnOrder } from '../opening-rolls.js?v=opening-order-20261105-1';
import { renderCountryFlag } from './components.js';

/** Show the same numbered lineup in solo setup and the shared room before play begins. */
export function renderOpeningTurnOrder(initiative, countries, nameOf) {
  const order = openingTurnOrder(initiative);
  if (!order.length) return '';
  return /* HTML */ `<section class="opening-turn-order" data-opening-turn-order
    ><div class="caption">Turn order / First to last</div
    ><ol class="opening-turn-list" aria-label="Starting turn order"
      >${order
        .map((id, position) => {
          const seat = initiative.players.indexOf(id);
          const country = countries[seat];
          return /* HTML */ `<li
            class="${position === 0 ? 'opening-first-turn' : ''}"
            data-opening-player="${escapeHTML(id)}"
            data-opening-seat="${seat}"
            title="${escapeHTML(country.name)}"
            ><span class="opening-turn-number" aria-hidden="true">${position + 1}</span
            >${renderCountryFlag(country.code)}<span
              >P${seat + 1} ${escapeHTML(nameOf(id, seat))}</span
            ></li
          >`;
        })
        .join('')}</ol
    ></section
  >`;
}
