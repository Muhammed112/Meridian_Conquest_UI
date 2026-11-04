import { allianceFor, diplomacyState, trustFor } from '../diplomacy.js';
import { escapeHTML } from '../html.js';
import { renderButton, renderIcon } from './components.js';

/** Show one pact or one offer inside the normal action card, without changing the board. */
export function renderDiplomacyPanel(game, { player, nameOf, isHuman, selectedPlayer }) {
  const alliance = allianceFor(game, player);
  const candidates = [...new Set(game.countries.map((country) => country.owner))]
    .filter((owner) => owner !== player && !isHuman(owner))
    .sort((first, second) => first - second);
  const selected = candidates.includes(Number(selectedPlayer))
    ? Number(selectedPlayer)
    : candidates[0];
  const counterpart = alliance?.ally ?? selected;
  const trust = counterpart === undefined ? null : trustFor(game, counterpart, player);
  const alreadyOffered = diplomacyState(game).lastOffers.some(
    (offer) => offer.player === player && offer.round === game.round,
  );
  const targetHasAlly = selected !== undefined && allianceFor(game, selected);
  const lastOutcome = game.events.findLast(
    (event) =>
      event.diplomacy && [event.diplomacy.proposer, event.diplomacy.target].includes(player),
  );
  const trustLabel = trust >= 70 ? 'High' : trust >= 40 ? 'Cautious' : 'Low';

  return /* HTML */ `<section class="panel action-panel diplomacy-panel"
    ><div class="eyebrow">Diplomacy / Temporary pacts</div><h2>Negotiate a pact.</h2
    ><p class="explain">One ally. Three rounds. One eventual winner.</p
    >${
      alliance
        ? /* HTML */ `<div class="diplomacy-pact"
            ><span class="badge">Active alliance</span><h3>${nameOf(alliance.ally)}</h3
            ><p>${alliance.roundsLeft} rounds remaining</p
            ><p class="small muted">Expires at the start of round ${alliance.expiresRound}.</p></div
          >`
        : /* HTML */ `<p class="small muted">You have no active alliance.</p>`
    }${
      !alliance && candidates.length
        ? /* HTML */ `<div class="field-group"
            ><label class="field-label" for="diplomacy-target">NPC commander</label
            ><select id="diplomacy-target" class="field"
              >${candidates
                .map(
                  (owner) => /* HTML */ `<option
                    value="${owner}"
                    ${owner === selected ? 'selected' : ''}
                    >P${owner + 1} ${nameOf(owner)}</option
                  >`,
                )
                .join('')}</select
            ></div
          >`
        : ''
    }${
      trust === null
        ? ''
        : /* HTML */ `<div class="diplomacy-trust"
            ><span>Their trust in you</span><strong>${trustLabel} · ${trust}/100</strong></div
          >`
    }<p class="explain"
      >A pact covers every country both commanders own. Each keeps their armies and normal turns.</p
    >${
      alliance
        ? /* HTML */ `<p class="action-helper"
            >Attacking an ally breaks the pact and lowers their trust. It also ends when only
            the two allies remain.</p
          >`
        : candidates.length
          ? /* HTML */ `${renderButton(
              'Offer three-round pact',
              'propose-alliance',
              'btn-primary btn-full',
              alreadyOffered || targetHasAlly ? 'disabled' : '',
            )}<p class="action-helper"
              >${
                alreadyOffered
                  ? 'You have made your offer this turn. Negotiate again on your next turn.'
                  : targetHasAlly
                    ? 'This commander already has an ally. Choose another commander.'
                    : 'They consider your strength, common threats and previous betrayals.'
              }</p
            >`
          : /* HTML */ `<p class="action-helper">No NPC commanders remain to negotiate with.</p>`
    }${
      lastOutcome
        ? /* HTML */ `<div class="diplomacy-result" role="status"
            ><span class="caption">Round ${lastOutcome.round} / Latest diplomacy</span
            ><p>${escapeHTML(lastOutcome.text)}</p></div
          >`
        : ''
    }${renderButton(
      `${renderIcon('back')} Battle planning`,
      'planning',
      'btn-ghost btn-full',
    )}</section
  >`;
}
