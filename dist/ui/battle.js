import {
  renderButton,
  renderIcon,
  renderCountryFlag,
  renderDifficultyBadge,
} from './components.js';
import { escapeHTML } from '../html.js';
import {
  diceMotion,
  rollPending,
  countryMotion,
  casualtyMarkers,
  turnMotion,
  dicePipPositions,
} from '../motion.js?v=battle-reveal-20261026-1';
import { colours, commanders } from '../data.js';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { reportText, GameEngine } from '../engine.js';
import { difficultyFor } from '../difficulty.js';
import { renderReports } from './reports.js';
import { allianceFor } from '../diplomacy.js';
import { renderDiplomacyPanel } from './diplomacy.js';

/**
 * Build board/replay markup from current context; callers supply the concealed presentation
 * board.
 */
export function createBattleViews(context) {
  // The same board renders ownership relative to the current viewer's seat.
  const localPlayer = (game) => (game.mode === 'multiplayer' ? context.multiplayer.playerSeat : 0);
  /**
   * Draw a validated face using fixed pip positions; cosmetic rolling is attached after
   * rendering.
   */
  function die(value, result = '') {
    const points = dicePipPositions[value];
    return /* prettier-ignore */ `<span
      class="die ${result}"
      data-die-final="${value}"
      data-display-face="${value}"
      role="img"
      aria-label="Die roll ${value}"
      >${
        Array.from(
          { length: 9 },
          (_, i) =>
            /* HTML */ `<i aria-hidden="true" ${points.includes(i) ? 'style="opacity:1"' : ''}></i>`,
        ).join('')
      }</span
    >`;
  }
  /** Number pairs by display position rather than trusting an index imported from saved data. */
  function dicePairs(pairs = []) {
    const { motionFrame } = context;

    const motion = diceMotion(motionFrame, pairs);
    return /* HTML */ `<div class="dice-header"
        ><span>ATTACK</span><span></span><span>DEFEND</span></div
      ><div
        class="dice-pairs ${motion.className}"
        data-rolling="${motion.className === 'dice-rolling'}"
        style="${motion.style}"
        >${
          motion.className
            ? '<div class="dice-roll-status"><span class="dice-status-dot"></span>' +
              '<span class="dice-status-text">Rolling the dice…</span></div>'
            : ''
        }${pairs
          .map(
            (pair, index) =>
              /* prettier-ignore */ `<div class="dice-pair" aria-label="${
                rollPending(motionFrame)
                  ? `Pair ${index + 1}: rolling dice`
                  : /* prettier-ignore */ `Pair ${index + 1}: ${pair.a} versus ${pair.d}, ${
                          pair.a === pair.d
                              ? 'tie'
                              : pair.a > pair.d
                                ? 'defender loses one'
                                : 'attacker loses one'
                        }`
              }">${die(pair.a, pair.a > pair.d ? 'winner' : pair.a < pair.d ? 'loser' : '')}<span>${
                pair.a === pair.d ? '=' : 'vs'
              }</span>${
                die(
                  pair.d,
                  pair.d > pair.a ? 'winner' : pair.d < pair.a ? 'loser' : '',
                )
              }</div>`,
          )
          .join('')}</div
      >`;
  }

  /** Render selectable country rows with the same ownership and effects as the map. */
  function roster(game) {
    const { motionFrame, state, nameOf } = context;
    const local = localPlayer(game);
    const alliance = allianceFor(game, local);
    const ownerGroups = new Map();
    for (const country of game.countries) {
      if (!ownerGroups.has(country.owner)) ownerGroups.set(country.owner, []);
      ownerGroups.get(country.owner).push(country);
    }
    // Rank only the visible groups; saved country order and concealed captures stay intact.
    const rankedGroups = [...ownerGroups.entries()].sort(
      ([firstOwner, firstCountries], [secondOwner, secondCountries]) =>
        secondCountries.length - firstCountries.length || firstOwner - secondOwner,
    );

    /** Mark the viewer's current ally once for all of that commander's countries. */
    function renderAllyHeader(owner) {
      if (alliance?.ally !== owner) return '';
      const remaining = `${alliance.roundsLeft} ${alliance.roundsLeft === 1 ? 'round' : 'rounds'} remaining`;
      return /* HTML */ `<div class="country-owner-group-head">
        <span class="country-owner-title">P${owner + 1} ${nameOf(owner)}</span>
        <span class="badge gold ally-badge" title="${remaining}"
          >${renderIcon('shield')} Ally<span class="sr-only"> · ${remaining}</span></span
        >
      </div>`;
    }

    /** Keep each country's existing controls and animation effects inside its owner group. */
    function renderCountry(country) {
      const effect = countryMotion(motionFrame, country);
      return /* prettier-ignore */ `<button
        class="country-row ${state.selected === country.code ? 'selected' : ''} ${
          country.owner === local ? 'owned' : ''
        } ${effect.className}"
        style="${effect.style}"
        data-map-country="${country.code}"
        data-action="select-country"
        data-code="${country.code}"
        aria-label="${country.name}, ${country.army} soldiers, owned by ${nameOf(country.owner)}"
        ><span class="country-identity" aria-hidden="true"
          >${renderCountryFlag(country.code)}<span>${escapeHTML(country.code)}</span></span
        ><span class="country-name"
          >${country.name}<span class="country-owner" style="color:${colours[country.owner]}"
            >P${country.owner + 1} ${nameOf(country.owner)}</span
          ></span
        ><span class="army-count">${country.army}</span
        >${casualtyMarkers(motionFrame, country, { roster: true })}</button
      >`;
    }

    return /* HTML */ `<aside class="panel roster-panel"
      ><div class="roster-head">World roster <span class="badge">10 countries</span></div
      ><div class="country-roster"
        >${rankedGroups
          .map(
            ([owner, countries]) => /* HTML */ `<div
              class="country-owner-group"
              role="group"
              aria-label="Player ${owner + 1} countries"
              >${renderAllyHeader(owner)}${countries.map(renderCountry).join('')}</div
            >`,
          )
          .join('')}</div
      >${selectedDetail(game)}</aside
    >`;
  }

  /** Show current/original strength while respecting spectator ownership wording. */
  function selectedDetail(game) {
    const { nameOf, state } = context;
    const local = localPlayer(game);

    const c = game.countries.find((x) => x.code === state.selected) || game.countries[0];
    return /* prettier-ignore */ `<div class="selected-country"
      ><div class="caption">Selected country</div><h3>${c.flag} ${c.name}</h3
      ><p
        >${
          c.owner === local && !state.watch
              ? 'Under your command'
              : `Controlled by ${nameOf(c.owner)}`
        }<br />Original
        strength: ${c.value} · Current army: ${c.army}<br />${
          c.owner === local && c.army >= 2
              ? 'Can launch an attack on your turn.'
              : c.owner === local
                ? 'Reinforce to launch an attack.'
                : 'Any owned country can target this nation.'
        }</p
      ></div
    >`;
  }

  /** Render factual and AI tabs from the same visible history without requesting narration. */
  function feed(game) {
    const { state } = context;

    return renderReports(game, {
      tab: state.reportTab,
      dock: state.reportDock,
      badge: /* prettier-ignore */ `<span class="badge live">${
        state.liveShareId
          ? 'Live view'
          : state.watch
            ? 'Recorded'
            : 'Campaign log'
      }</span>`,
      live: cloudEnabled && !state.watch && state.view !== 'tutorial',
      commentaryAction:
        cloudEnabled &&
        !state.watch &&
        state.view !== 'tutorial' &&
        (game.mode !== 'multiplayer' || context.multiplayer.isHost)
          ? renderButton('Generate commentary', 'request-commentary', 'btn-sm')
          : '',
      fieldReports: game.events
        .slice(-12)
        .reverse()
        .map(
          (
            event,
          ) => /* prettier-ignore */ `<div class="activity-row"
              ><span class="activity-symbol"
                >${
                  renderIcon(
                    event.type === 'dice'
                      ? 'swords'
                      : event.type === 'reinforce'
                        ? 'users'
                        : event.type === 'transfer'
                          ? 'transfer'
                          : event.type === 'conquest'
                            ? 'shield'
                            : 'globe',
                  )
                }</span
              ><div class="activity-copy"
                >${escapeHTML(reportText(game, event))}<span class="event-meta"
                  >ROUND ${String(event.round).padStart(2, '0')} / ${event.type.toUpperCase()}</span
                ></div
              ><span class="activity-time"
                >${
                  new Date(event.at).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                }</span
              ></div
            >`,
        )
        .join(''),
    });
  }

  /** Show phase casualties only after the presentation layer has released the result. */
  function battleLossSummary(game, battle) {
    if (game.presentationPending || !battle?.pairs?.length) return '';
    const from = game.countries.find((country) => country.code === battle.from),
      to = game.countries.find((country) => country.code === battle.to);
    if (!from || !to) return '';
    // Older battles may omit casualty totals; paired dice preserve the same factual result.
    const attackerLoss =
      battle.attackerLoss ?? battle.pairs.filter((pair) => pair.a < pair.d).length;
    const defenderLoss =
      battle.defenderLoss ?? battle.pairs.filter((pair) => pair.a > pair.d).length;
    return /* HTML */ `<div class="commentary battle-loss-summary"
      >Phase ${escapeHTML(battle.phase)}: ${escapeHTML(from.name)} lost ${escapeHTML(attackerLoss)};
      ${escapeHTML(to.name)} lost ${escapeHTML(defenderLoss)}.
      ${attackerLoss === 0 && defenderLoss === 0 ? 'A stand-off. Both armies hold.' : ''}</div
    >`;
  }

  /** Select spectator, bot, reinforcement or human controls from the current game phase. */
  function actionPanel(game) {
    const { owned, state, nameOf } = context;

    const e = new GameEngine(game),
      local = localPlayer(game),
      multiplayer = game.mode === 'multiplayer',
      human = e.current === local,
      own = owned(game),
      origin = game.countries.find((c) => c.code === state.origin) || own[0],
      target = game.countries.find((c) => c.code === state.target),
      viewOnly = !!state.watch;
    const isHuman = (player) => (multiplayer ? context.multiplayer.isHuman(player) : player === 0);
    const alliance = allianceFor(game, local);
    const canNegotiate =
      (state.view !== 'tutorial' ||
        ['diplomacy', 'diplomacy-result'].includes(context.tutorial?.step)) &&
      game.countries.some((country) => country.owner !== local && !isHuman(country.owner));
    const diplomacyButton = canNegotiate
      ? renderButton(`${renderIcon('shield')} Diplomacy`, 'diplomacy', 'btn-full')
      : '';
    // Check this before victory and normal phase controls to avoid leaking the pending outcome.
    if (game.presentationPending) {
      const a = game.countries.find((c) => c.code === game.battle.from),
        d = game.countries.find((c) => c.code === game.battle.to);
      return /* HTML */ `<section class="panel action-panel"
        ><div class="eyebrow">Battle in progress</div
        ><h2>${a.name}<br /><span class="muted">vs ${d.name}</span></h2
        ><div class="battle-summary"
          ><span>${a.flag} ${a.army} soldiers</span><span>${d.flag} ${d.army} soldiers</span></div
        >${dicePairs(game.battle.pairs)}<div class="commentary" role="status"
          >Rolling dice. Results appear when they settle.</div
        ><button class="btn btn-primary btn-full" disabled>Rolling dice...</button></section
      >`;
    }
    if (viewOnly)
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">From the sidelines</div><h2>A world in motion.</h2
        ><p class="explain"
          >${
            state.liveShareId
              ? 'You are watching the shared game as its owner plays. Board changes, dice' +
                ' and reports arrive automatically.'
              : 'You are viewing a read-only snapshot of this campaign. Inspect any country' +
                ' and explore the recorded battle history.'
          }</p
        ><div class="notice"
          >${renderIcon('eye')}<span
            ><strong>Viewing only</strong><br />Campaign controls belong to the owner.</span
          ></div
        ><a href="#history/watch" class="btn btn-full">${renderIcon('history')} Battle replay</a
        ><a
          href="${state.liveShareId && !context.cloud?.user ? '#signup' : '#setup'}"
          class="btn btn-primary btn-full"
          >Start your own campaign ${renderIcon('arrow')}</a
        ><p class="action-helper"
          >${
            state.liveShareId
              ? 'The owner must keep their game open to continue playing. Visitors cannot make moves.'
              : 'Shared demo links contain a snapshot, rather than a live connection.'
          }</p
        ></section
      >`;
    if (game.winner !== null)
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">The final chapter</div
        ><div class="result-emblem">${game.winner === local ? '♜' : '⌖'}</div
        ><h2 class="result-title"
          >${
            game.winner === local
                ? 'The world is yours.'
                : `${multiplayer ? nameOf(game.winner) : commanders[game.winner]} takes the world.`
          }</h2
        ><p class="explain"
          >Ten countries. One commander. This campaign reached its conclusion in ${game.round}
          rounds.</p
        ><a href="${multiplayer ? '#multiplayer' : '#history/' + game.id}" class="btn btn-full"
          >${renderIcon('history')} ${multiplayer ? 'Back to rooms' : 'Replay the campaign'}</a
        ><a href="#setup" class="btn btn-primary btn-full"
          >A new beginning ${renderIcon('arrow')}</a
        ></section
      >`;
    if (!own.length && !state.watchNPC && !multiplayer)
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">Your campaign continues</div><h2>A final stand.</h2
        ><p class="explain"
          >Your last country has fallen. Stay to watch the remaining commanders compete for the
          world, or begin another campaign.</p
        >${
          renderButton(
            `${renderIcon('eye')} Continue watching`,
            'continue-npcs',
            'btn-primary btn-full',
          )
        }<a
          href="#setup"
          class="btn btn-full"
          >Start again</a
        ></section
      >`;
    if (!human)
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">${multiplayer && context.multiplayer.isHuman(e.current)
          ? 'Waiting for player' : 'Strategic opponent'} / P${e.current + 1}</div
        ><div class="npc-emblem"><img src="./assets/compass.svg" alt="" /></div
        ><h2>${nameOf(e.current)} is moving.</h2
        ><div class="signal-line"
          ><span class="signal-dot"></span>
          ${multiplayer ? 'LIVE MATCH' : state.fast ? 'FAST PLAYBACK' : 'SIMULATING NEXT MOVE'}</div
        ><div class="commentary" data-npc-decision
          >${
            escapeHTML(
              (multiplayer ? context.multiplayer.decision : state.npcNote) ||
                (multiplayer && context.multiplayer.isHuman(e.current)
                  ? 'Waiting for this player to make their move.'
                  : 'Surveying the board and evaluating the next opportunity.'),
            )
          }</div
        >${
          game.battle
            ? dicePairs(game.battle.pairs)
            : game.lastBattle
              ? dicePairs(game.lastBattle.pairs)
              : ''
        }${battleLossSummary(game, game.battle || game.lastBattle)}${
          game.lastBattle?.outcome === 'conquest'
              ? /* prettier-ignore */ `<div class="recent-conquest">${
                    escapeHTML(game.lastBattle.country)
                  } conquered · +${escapeHTML(game.lastBattle.reward)} soldiers earned.</div>`
              : ''
        }${
          multiplayer ? '' : renderButton(
            `${renderIcon(state.fast ? 'pause' : 'fast')} ${state.fast ? 'Normal speed' : 'Fast forward'}`,
            'fast',
            'btn-full',
          )
        }<p
          class="action-helper"
          >Every decision, dice roll and outcome remains in the campaign log.</p
        ></section
      >`;
    if (game.budget) {
      const used = Object.values(state.allocations).reduce((a, b) => a + b, 0),
        remaining = game.budget - used;
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">01 / Start of your turn</div><h2>Reinforce your position.</h2
        ><p class="explain"
          >${own.length} controlled ${own.length === 1 ? 'country grants' : 'countries grant'}
          ${game.budget} new soldiers. Place them where your next move begins.</p
        ><div class="budget"
          ><div
            ><div class="caption">Available this turn</div
            ><div class="budget-number">+${game.budget}</div></div
          ><div
            ><div class="caption">Remaining</div
            ><div class="budget-number" style="text-align:right">${remaining}</div></div
          ></div
        >${
          own
            .map(
              (c) => /* HTML */ `<div class="allocation-row"
                ><div class="allocation-name"
                  >${c.flag} ${c.name}<div class="small"
                    >${c.army} → ${c.army + (state.allocations[c.code] || 0)} soldiers</div
                  ></div
                ><div class="stepper"
                  ><button
                    data-action="allocate-minus"
                    data-code="${c.code}"
                    aria-label="Remove one reinforcement from ${c.name}"
                    title="Remove one assigned reinforcement"
                    ${(state.allocations[c.code] || 0) === 0 ? 'disabled' : ''}
                    >−</button
                  ><output>+${state.allocations[c.code] || 0}</output
                  ><button
                    data-action="allocate-plus"
                    data-code="${c.code}"
                    aria-label="Add one reinforcement to ${c.name}"
                    title="${remaining ? 'Assign one reinforcement' : 'All reinforcements are assigned'}"
                    ${remaining === 0 ? 'disabled' : ''}
                    >+</button
                  ></div
                ></div
              >`,
            )
            .join('')
        }${
          renderButton(
            'Confirm reinforcements',
            'confirm-reinforce',
            'btn-primary btn-full',
            `aria-describedby="reinforcement-help" ${remaining !== 0 ? 'disabled' : ''}`,
          )
        }${renderButton('Deploy to strongest country', 'auto-allocate', 'btn-ghost btn-full')}<p
          class="action-helper"
          id="reinforcement-help"
          >Allocate every soldier before moving or attacking.</p
        ></section
      >`;
    }
    if (game.battle) {
      const a = game.countries.find((c) => c.code === game.battle.from),
        d = game.countries.find((c) => c.code === game.battle.to);
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">04 / Battle in progress</div
        ><h2>${a.name}<br /><span class="muted">vs ${d.name}</span></h2
        ><div class="battle-summary"
          ><span>${a.flag} ${a.army} soldiers</span><span>${d.flag} ${d.army} soldiers</span></div
        >${
          game.battle.pairs.length
            ? dicePairs(game.battle.pairs)
            : '<div class="commentary">The armies face each other. Your first roll will' +
              ' decide the opening exchange.</div>'
        }${battleLossSummary(game, game.battle)}${
          renderButton(
            `${renderIcon('play')} Roll ${game.battle.phase ? 'next phase' : 'the dice'}`,
            'roll',
            'btn-primary btn-full',
          )
        }${renderButton('Stop attack & end turn', 'stop-attack', 'btn-ghost btn-full')}<p
          class="action-helper"
          >Paired dice · Ties cost no soldiers · Keep one soldier behind</p
        ></section
      >`;
    }
    if (state.action === 'diplomacy' && canNegotiate && !game.battle) {
      return renderDiplomacyPanel(game, {
        player: local,
        nameOf,
        isHuman,
        selectedPlayer: state.diplomacyTarget,
      });
    }
    if (state.action === 'transfer') {
      const destinations = own.filter((c) => c.code !== origin?.code);
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">02 / Reposition</div><h2>Strength in the right place.</h2
        ><p class="explain"
          >Move soldiers between your countries. Leave at least one soldier behind.</p
        ><div class="field-group"
          ><label for="transfer-from" class="field-label">From</label
          ><select id="transfer-from" class="field"
            >${
              own
                .map(
                  (c) =>
                    /* prettier-ignore */ `<option value="${c.code}" ${origin?.code === c.code ? 'selected' : ''}>${
                            c.flag
                          } ${c.name} · ${c.army}</option>`,
                )
                .join('')
            }</select
          ></div
        ><div class="field-group"
          ><label for="transfer-to" class="field-label">To</label
          ><select id="transfer-to" class="field"
            >${
              destinations
                .map(
                  (c) =>
                    /* HTML */ `<option value="${c.code}">${c.flag} ${c.name} · ${c.army}</option>`,
                )
                .join('')
            }</select
          ></div
        ><div class="field-group"
          ><label for="transfer-count" class="field-label">Soldiers to transfer</label
          ><input
            class="field"
            id="transfer-count"
            type="number"
            min="1"
            max="${Math.max(1, (origin?.army || 1) - 1)}"
            value="1" /></div
        >${
          renderButton(
            `${renderIcon('transfer')} Transfer soldiers`,
            'confirm-transfer',
            'btn-teal btn-full',
            !destinations.length || origin.army < 2 ? 'disabled' : '',
          )
        }${renderButton('Return to planning', 'planning', 'btn-ghost btn-full')}</section
      >`;
    }
    if (game.lastBattle) {
      const win = game.lastBattle.outcome === 'conquest';
      return /* prettier-ignore */ `<section class="panel action-panel"
        ><div class="eyebrow">${win ? 'A new foothold' : 'Battle concluded'}</div
        ><h2>${win ? 'A nation joins your command.' : 'The frontier holds.'}</h2
        >${dicePairs(game.lastBattle.pairs)}<div class="recent-conquest"
          >${
            win
              ? `${game.lastBattle.country} conquered · +${game.lastBattle.reward} soldiers earned.`
              : 'Your remaining soldiers hold their position.'
          }</div
        ><p class="explain"
          >${
            win
              ? 'One earned soldier garrisons the new territory. Transfer more soldiers to' +
                ' strengthen it, or pass command to the next participant.'
              : 'You have used your attack for this turn. Reposition your remaining troops or end your turn.'
          }</p
        >${win ? renderButton('Transfer soldiers', 'transfer', 'btn-teal btn-full') : ''}${diplomacyButton}${
          renderButton(
            `End turn ${renderIcon('arrow')}`,
            'end-turn',
            'btn-primary btn-full',
          )
        }</section
      >`;
    }
    return /* prettier-ignore */ `<section class="panel action-panel"
      ><div class="eyebrow">03 / Your next move</div><h2>The world is within reach.</h2
      ><p class="explain"
        >Choose your attacking nation, then set your sights on any rival country.</p
      ><div class="field-group"
        ><label for="attack-from" class="field-label">Your attacking country</label
        ><select id="attack-from" class="field"
          >${
            own
              .map(
                (c) =>
                  /* prettier-ignore */ `<option value="${c.code}" ${origin?.code === c.code ? 'selected' : ''}>${
                        c.flag
                      } ${c.name} · ${c.army}</option>`,
              )
              .join('')
          }</select
        ></div
      ><div class="field-group"
        ><label for="attack-to" class="field-label">Target country</label
        ><select id="attack-to" class="field"
          >${
            game.countries
              .filter((c) => c.owner !== local)
              .map(
                (
                  c,
                ) => /* HTML */ `<option value="${c.code}" ${target?.code === c.code ? 'selected' : ''}
                  >${c.flag} ${c.name} · ${c.army}${alliance?.ally === c.owner ? ' (Ally)' : ''}</option
                >`,
              )
              .join('')
          }</select
        ></div
      >${
        origin
          ? /* HTML */ `<div class="selected-unit"
              ><span class="flag">${origin.flag}</span
              ><div class="unit-meta"
                >${origin.name}<span>${Math.max(0, origin.army - 1)} available to attack</span></div
              ><span class="unit-army">${origin.army}</span></div
            >`
          : ''
      }${
        alliance && target?.owner === alliance.ally
          ? /* HTML */ `<p class="alliance-warning" role="status"
              >Attacking ${nameOf(alliance.ally)} breaks your pact and lowers their trust.</p
            >`
          : ''
      }${
        renderButton(
          `${renderIcon('swords')} Launch attack`,
          'start-attack',
          'btn-danger btn-full',
          !origin || origin.army < 2 || game.attackUsed ? 'disabled' : '',
        )
      }${diplomacyButton}${renderButton('Skip this turn', 'end-turn', 'btn-ghost btn-full')}<p
        class="action-helper"
        >${origin && origin.army < 2 ? 'This country needs at least two soldiers to attack. ' : ''}
        One target per turn. Keep rolling until you conquer, stop, or have one soldier left.</p
      ></section
    >`;
  }

  /** Compose the normal board, optional practice guide and reports without mutating gameplay. */
  function gameView(
    game,
    { guide = '', adviserGuide = false, showActions = true, roomHeader = '' } = {},
  ) {
    const { owned, motionFrame, state, nav, nameOf, theatre, campaignPopulationLabel } = context;

    const local = localPlayer(game),
      e = new GameEngine(game),
      own = owned(game),
      soldiers = own.reduce((n, c) => n + c.army, 0),
      turn = turnMotion(motionFrame);
    // Captures may invalidate the selected origin/target; recover valid UI choices only.
    if (!state.selected) state.selected = own[0]?.code || game.countries[0].code;
    if (!state.origin || !own.find((c) => c.code === state.origin))
      state.origin = own.slice().sort((a, b) => b.army - a.army)[0]?.code;
    if (!state.target || game.countries.find((c) => c.code === state.target)?.owner === local)
      state.target = game.countries
        .filter((c) => c.owner !== local)
        .sort((a, b) => a.army - b.army)[0]?.code;
    return /* prettier-ignore */ `<div class="game-shell ${guide ? 'tutorial-mode' : ''}${
      adviserGuide ? ' tutorial-adviser-mode' : ''
    }"
      >${nav('', true)}<main
        >${roomHeader}<div class="game-heading"
          ><div
            ><div class="eyebrow"
              >${
                guide
                  ? 'Interactive tutorial / Practice board'
                  : state.watch
                    ? 'Shared campaign / Viewing only'
                    : game.mode === 'multiplayer' ? 'Active campaign / Multiplayer'
                      : 'Active campaign / Single player'
              }
              ${renderDifficultyBadge(game.difficulty)}</div
            ><h1>${escapeHTML(game.name)}</h1></div
          ></div
        >${
          state.watch
            ? /* prettier-ignore */ `<div class="notice watch-notice"
                >${renderIcon('eye')}<span
                  ><strong>Viewing only.</strong>
                  ${
                              state.liveShareId
                                ? 'Live updates arrive as the owner plays. ' +
                                  'Only the signed-in owner controls this campaign.'
                                : 'This link shows a recorded snapshot. ' +
                                  'You can inspect the board and replay its history.'
                            }</span
                ></div
              >`
            : ''
        }<div class="game-stats"
          ><div class="game-stat"
            ><div class="caption">Current round</div
            ><div class="value"
              >${String(game.round).padStart(2, '0')}
              <span class="small muted">/ ongoing</span></div
            ></div
          ><div class="game-stat"
            ><div class="caption">Current turn</div
            ><div class="value"
              ><span class="dot" style="background:${colours[e.current]}"></span
              >${nameOf(e.current)}</div
            ></div
          ><div class="game-stat"
            ><div class="caption">Your countries</div
            ><div class="value">${own.length} <span class="small muted">/ 10</span></div></div
          ><div class="game-stat"
            ><div class="caption">Your army</div
            ><div class="value">${soldiers} <span class="small muted">soldiers</span></div></div
          ></div
        ><div class="turn-order"
          ><span>TURN ORDER</span
          >${
            game.order
              .map(
                (p) =>
                  /* prettier-ignore */ `<span class="turn-person ${e.current === p ? 'current' : ''} ${
                        !owned(game, p).length ? 'eliminated' : ''
                      } ${e.current === p ? turn.className : ''}" style="${e.current === p ? turn.style : ''}">P${
                        p + 1
                      } ${nameOf(p)}</span>`,
              )
              .join('')
          }</div
        ><div class="board-grid"
          >${roster(game)}<div class="map-and-activity"
            >${adviserGuide ? guide : ''}${
              theatre(game.countries, {
                interactive: true,
                selected: state.selected,
                origin: state.origin,
                target: state.target,
                motion: motionFrame,
              })
            }<div
              class="board-actions"
              >${
                renderButton(
                  `${renderIcon('transfer')} Transfer soldiers`,
                  'transfer',
                  'btn-teal',
                  e.current !== local || game.budget || game.battle || own.length < 2 || state.watch
                    ? 'disabled'
                    : '',
                )
              }${
                renderButton(
                  `${renderIcon('skip')} Skip turn`,
                  'end-turn',
                  '',
                  e.current !== local || game.budget || game.battle || state.watch ? 'disabled' : '',
                )
              }${
                cloudEnabled && context.cloud?.user && context.cloudReady &&
                !state.watch && !guide && game.mode !== 'multiplayer'
                  ? renderButton(
                      renderIcon('copy'),
                      'share',
                      'copy-live-link',
                      'aria-label="Copy live viewing link" title="Copy live viewing link"',
                    )
                  : ''
              }${renderButton(`${renderIcon('info')} Rules`, 'help', 'btn-ghost')}</div
            >${feed(game)}</div
          >${
            guide
              ? `<div class="tutorial-action-column">${adviserGuide ? '' : guide}${
                  showActions ? actionPanel(game) : ''
                }</div>`
              : actionPanel(game)
          }</div
        ><div class="game-save-line"
          ><span
            ><i class="saved-dot"></i>
            ${
              guide
                ? 'Practice board · Not a saved campaign'
                : state.liveShareId
                  ? 'Live spectator view'
                  : state.watch
                    ? 'Shared snapshot'
                    : game.mode === 'multiplayer' ? 'Live shared room' : 'Saved on this device'
            }
            · ${state.fast ? 'Fast playback' : 'Normal playback'}</span
          ><span>${campaignPopulationLabel(game)}</span
          ><span>Every country. Every decision.</span></div
        ></main
      ></div
    >`;
  }

  /** Render the selected event’s historical board, concealing losses until its dice settle. */
  function history(game) {
    const { state, dashboard, motionFrame, nav, encodeSnapshot, theatre, replayTimer, footer } =
      context;

    const events = game.events,
      index = Math.min(state.replay, events.length - 1),
      event = events[index];
    if (!event) return dashboard();
    // Replay reads snapshots; it never rewinds or mutates the campaign's actual current board.
    const rolling = rollPending(motionFrame),
      board = game.countries.map((c) => ({
        ...c,
        ...(rolling ? motionFrame.roll.beforeBoard : event.board).find((x) => x.code === c.code),
      }));
    return /* prettier-ignore */ `<div class="shell"
      >${nav()}<main
        ><div class="page-heading"
          ><div
            ><div class="eyebrow">Campaign archive / Battle replay</div
            ><h1>Every move leaves a mark.</h1
            ><p
              >${escapeHTML(game.name)} · ${difficultyFor(game.difficulty).label} difficulty ·
              Recorded decisions, dice and turning points.</p
            ></div
          ><div class="history-actions"
            ><a
              href="#${
                state.liveShareId
                  ? 'live/' + state.liveShareId
                  : state.watch
                    ? 'watch/' + encodeSnapshot(game)
                    : 'game/' + game.id
              }"
              class="btn btn-sm"
              >${renderIcon('back')} Back to board</a
            ></div
          ></div
        ><div class="history-grid"
          ><div
            >${theatre(board, { motion: motionFrame })}<input
              type="range"
              id="history-range"
              class="history-slider"
              min="0"
              max="${events.length - 1}"
              value="${index}"
              aria-label="Replay event"
            /><div class="history-controls"
              >${
                renderButton(
                  renderIcon('back'),
                  'replay-prev',
                  '',
                  `aria-label="Previous event" ${index === 0 ? 'disabled' : ''}`,
                )
              }${
                renderButton(
                  `${renderIcon(replayTimer ? 'pause' : 'play')} ${replayTimer ? 'Pause' : 'Play replay'}`,
                  'replay-play',
                  'btn-primary',
                )
              }<span
                class="counter"
                >${String(index + 1).padStart(2, '0')} /
                ${String(events.length).padStart(2, '0')}</span
              >${
                renderButton(
                  renderIcon('chevron'),
                  'replay-next',
                  '',
                  `aria-label="Next event" ${index === events.length - 1 ? 'disabled' : ''}`,
                )
              }</div
            ><div class="notice"
              >${renderIcon('lock')}<span
                >Replay explores the record. Your saved campaign stays at its current
                position.</span
              ></div
            ></div
          ><section class="panel history-event"
            ><div class="eyebrow">Round ${event.round} / ${event.type}</div
            ><h2
              >${
                rolling
                  ? 'The dice are rolling.'
                  : event.type === 'conquest'
                    ? 'A border redrawn.'
                    : event.type === 'dice'
                      ? 'The dice decide.'
                      : event.type === 'reinforce'
                        ? 'Strength takes shape.'
                        : 'A move worth remembering.'
              }</h2
            ><p
              >${
                rolling
                  ? 'Results appear when the dice settle.'
                  : escapeHTML(reportText(game, event))
              }</p
            ><p
              class="ai-commentary"
              ${rolling ? 'hidden' : ''}
              data-commentary-event="${escapeHTML(event.id)}"
              >${event.commentary ? `AI commentary: ${escapeHTML(event.commentary)}` : ''}</p
            >${event.pairs ? dicePairs(event.pairs) : ''}<div class="timeline-list"
              >${
                events
                  .map(
                    (ev, i) =>
                      /* prettier-ignore */ `<button class="timeline-event ${
                                i === index ? 'active' : ''
                              }" data-action="replay-select" data-index="${i}"><span class="event-index">${
                                String(i + 1).padStart(2, '0')
                              }</span><span>${escapeHTML(reportText(game, ev))}</span></button>`,
                  )
                  .join('')
              }</div
            ></section
          ></div
        ></main
      >${footer()}</div
    >`;
  }
  return {
    die,
    dicePairs,
    gameView,
    history,
  };
}
