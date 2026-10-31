import { renderIcon, renderButton, renderDifficultyBadge } from './components.js';
import { escapeHTML } from '../html.js';
import { findCountry, catalogue, armyValue, colours, commanders } from '../data.js';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { difficultyOptions } from '../difficulty.js';
import { GameEngine } from '../engine.js';

export function createCampaignViews(context) {
  function welcome() {
    const { nav, theatre, footer } = context;

    return /* HTML */ `<div class="shell"
      >${nav()}<main
        ><section class="hero"
          ><div class="hero-copy"
            ><div class="eyebrow">A world of strategy. One commander.</div
            ><h1
              >Choose your nation.<br />Build your army.<br /><span class="outline-word"
                >Conquer the world.</span
              ></h1
            ><p
              >Ten real countries. Nine strategic opponents. A single objective: bring the entire
              board under your command.</p
            ><div class="hero-actions"
              ><a href="#campaigns" class="btn btn-primary"
                >Enter the war room ${renderIcon('arrow')}</a
              ><a href="#multiplayer" class="btn">${renderIcon('users')} Play with friends</a
              >${renderButton(`${renderIcon('play')} How to play`, 'help')}</div
            ><div class="hero-footnotes"
              ><span>${renderIcon('users')} Single player</span
              ><span>${renderIcon('save')} Persistent sessions</span
              ><span>${renderIcon('eye')} Watch the action</span></div
            ></div
          ><div
            >${theatre()}<div class="map-callout"
              >${renderIcon('globe')}<div
                >Every country is within reach.<br /><span class="caption"
                  >Your strategy sets the boundaries.</span
                ></div
              ></div
            ></div
          ></section
        ><section class="principles"
          ><article class="principle"
            ><div class="eyebrow">01 / The foothold</div><h3>Choose your beginning.</h3
            ><p>Pick your nation. Its population sets the strength of your first army.</p></article
          ><article class="principle"
            ><div class="eyebrow">02 / The strategy</div><h3>Outthink nine rivals.</h3
            ><p>Reinforce, reposition, and choose the right moment to strike.</p></article
          ><article class="principle"
            ><div class="eyebrow">03 / The objective</div><h3>Make the world yours.</h3
            ><p>Control all ten countries. Relive every turning point in battle replay.</p></article
          ></section
        ><section class="spectator-banner"
          ><div
            ><strong>Make your first move.</strong
            ><p>Choose a country and difficulty, then begin your campaign.</p></div
          ><a href="#setup" class="btn btn-sm">Start a campaign ${renderIcon('arrow')}</a></section
        ></main
      >${footer()}</div
    >`;
  }

  function gameCard(game, index) {
    const { owned, map } = context;

    const troops = owned(game).reduce((n, c) => n + c.army, 0),
      start = findCountry(game.start);
    return /* HTML */ `<article class="campaign-card"
      ><div class="campaign-art"
        >${map(game.countries, { mini: true })}<span
          class="badge ${game.status === 'won' ? 'gold' : 'live'}"
          >${game.status === 'won' ? 'World conquered' : game.status === 'lost' ? 'Viewing only' : game.battle ? 'Battle in progress' : game.order[game.position] === 0 ? 'Your move' : 'Opponent turn'}</span
        ></div
      ><div class="campaign-card-body"
        ><div class="campaign-title-row"
          ><div
            ><h2>${escapeHTML(game.name)}</h2
            ><div class="campaign-sub"
              >${start.flag} Starting country: ${start.name}
              ${renderDifficultyBadge(game.difficulty)}</div
            ></div
          ><span class="caption">0${index + 1}</span></div
        ><div class="campaign-stats"
          ><div class="campaign-stat"
            ><strong>${String(game.round).padStart(2, '0')}</strong>ROUND</div
          ><div class="campaign-stat"
            ><strong>${owned(game).length}<span class="muted small"> / 10</span></strong
            >COUNTRIES</div
          ><div class="campaign-stat"><strong>${troops}</strong>SOLDIERS</div></div
        ><div class="campaign-card-actions"
          ><a href="#game/${game.id}" class="btn btn-primary"
            >${game.winner !== null ? 'View results' : 'Resume campaign'} ${renderIcon('arrow')}</a
          ><a href="#history/${game.id}" class="btn" aria-label="Replay ${escapeHTML(game.name)}"
            >${renderIcon('history')}</a
          ><button
            class="icon-button"
            data-action="share"
            data-id="${game.id}"
            aria-label="Copy viewing-only snapshot link"
            >${renderIcon('copy')}</button
          ></div
        ></div
      ></article
    >`;
  }

  function filteredGames() {
    const { games, state } = context;

    return games.filter(
      (game) =>
        (state.filter === 'all' ||
          (state.filter === 'active' ? game.status === 'active' : game.status === state.filter)) &&
        `${game.name} ${findCountry(game.start)?.name}`
          .toLowerCase()
          .includes(state.search.toLowerCase()),
    );
  }

  function campaignLoadNotice() {
    const { campaignLoadState, campaignLoadError } = context;

    if (!cloudEnabled) return '';
    if (campaignLoadState === 'loading')
      return '<div class="notice" role="status">Loading your saved campaigns and history...</div>';
    if (campaignLoadState === 'error')
      return /* HTML */ `<div class="notice" role="alert"
        ><span
          ><strong>Your campaigns could not finish loading.</strong>
          ${escapeHTML(campaignLoadError)} Your saved data has been kept.</span
        >${renderButton('Retry loading', 'retry-campaigns', 'btn-sm')}</div
      >`;
    return '';
  }

  function campaignResults() {
    const { campaignLoadState, cloud, games } = context;

    const list = filteredGames();
    if (list.length) return list.map(gameCard).join('');
    if (cloudEnabled && campaignLoadState === 'loading')
      return '<div class="empty-state" style="grid-column:1/-1" role="status"><h2>Loading your campaigns...</h2><p>Your saved campaigns will appear here.</p></div>';
    if (cloudEnabled && campaignLoadState === 'error') return '';
    if (cloudEnabled && !cloud?.user)
      return '<div class="empty-state" style="grid-column:1/-1"><h2>Sign in to see your campaigns.</h2><p>Your saves are linked to the account you played with.</p><a href="#signin" class="btn btn-primary">Sign in</a></div>';
    if (games.length)
      return /* HTML */ `<div class="empty-state" style="grid-column:1/-1"
        ><h2>No campaigns match your filters.</h2
        ><p>Show all campaigns to include completed games.</p
        >${renderButton('Show all campaigns', 'clear-campaign-filters', 'btn-primary')}</div
      >`;
    return /* HTML */ `<div class="empty-state" style="grid-column:1/-1"
      ><div class="empty-symbol">⌖</div><h2>No campaigns in sight.</h2
      ><p
        >No campaigns are saved under this account. Sign in with the account you played with, or
        create a campaign.</p
      ><a href="#setup" class="btn btn-primary">Create a campaign ${renderIcon('plus')}</a></div
    >`;
  }

  function dashboard() {
    const { nav, state, cloud, profile, footer } = context;

    return /* HTML */ `<div class="shell"
      >${nav('campaigns')}<main
        ><div class="page-heading"
          ><div
            ><div class="eyebrow">Your command centre</div><h1>Every campaign. Your next move.</h1
            ><p>Pick up where you left off, or set your sights on a new world.</p></div
          ><div class="campaign-heading-actions"
            ><a href="#setup" class="btn btn-primary">${renderIcon('plus')} New campaign</a
            ><a href="#multiplayer" class="btn">${renderIcon('users')} Play with friends</a></div
          ></div
        ><div class="toolbar"
          ><div class="search-wrap"
            >${renderIcon('search')}<input
              type="search"
              class="field"
              id="campaign-search"
              placeholder="Search campaigns or starting countries"
              aria-label="Search campaigns"
              value="${escapeHTML(state.search)}" /></div
          ><div class="filters" aria-label="Campaign status"
            >${[
              ['all', 'All campaigns'],
              ['active', 'Active'],
              ['won', 'Won'],
              ['lost', 'Lost'],
            ]
              .map(
                ([v, t]) =>
                  /* HTML */ `<button
                    class="filter ${state.filter === v ? 'active' : ''}"
                    aria-pressed="${state.filter === v}"
                    data-action="filter"
                    data-filter="${v}"
                    >${t}</button
                  >`,
              )
              .join('')}</div
          ></div
        ><div class="section-label"
          ><span>Your campaigns</span
          ><span id="campaign-result-count">${filteredGames().length} SESSIONS</span></div
        >${campaignLoadNotice()}<div class="campaign-grid" id="campaign-results"
          >${campaignResults()}</div
        ><div class="save-note"
          >${renderIcon('save')}
          ${cloud?.user ? `Signed in as ${escapeHTML(cloud.user.email || profile?.name)}. Campaigns save to your account.` : 'Each campaign saves independently on this device, including any in-progress battle.'}</div
        ><div class="notice"
          >${renderIcon('info')}<span
            >Choose your country and difficulty to start a campaign.
            <strong>Progress saves on this device.</strong></span
          ></div
        ></main
      >${footer()}</div
    >`;
  }

  function setupOptions() {
    const { state } = context;

    return (
      catalogue
        .filter((c) => c.name.toLowerCase().includes(state.setupSearch.toLowerCase()))
        .map(
          (c) =>
            /* HTML */ `<button
              class="country-option ${state.setupStart === c.code ? 'selected' : ''}"
              data-action="setup-country"
              data-code="${c.code}"
              ><span class="flag">${c.flag}</span
              ><span class="country-option-name"
                >${c.name}<span class="country-owner"
                  >${Math.round(c.population * 1000000).toLocaleString()} people</span
                ></span
              ><span class="strength">${armyValue(c.population)} ${renderIcon('users')}</span
              >${state.setupStart === c.code ? renderIcon('check') : ''}</button
            >`,
        )
        .join('') || '<p class="muted small">No matching countries in the catalogue.</p>'
    );
  }

  function difficultyPicker() {
    const { state } = context;

    return /* HTML */ `<fieldset class="difficulty-picker"
      ><legend class="field-label">Difficulty</legend
      ><div class="difficulty-options"
        >${difficultyOptions
          .map(
            (level) =>
              /* HTML */ `<label
                class="difficulty-option ${state.setupDifficulty === level.id ? 'selected' : ''}"
                ><input
                  type="radio"
                  name="difficulty"
                  id="difficulty-${level.id}"
                  value="${level.id}"
                  ${state.setupDifficulty === level.id ? 'checked' : ''}
                  aria-describedby="difficulty-description-${level.id}"
                /><span
                  ><strong style="--difficulty-colour:${level.colour}">${level.label}</strong
                  ><small id="difficulty-description-${level.id}">${level.description}</small></span
                ></label
              >`,
          )
          .join('')}</div
      ><p class="field-help"
        >Saved with this campaign. Dice and troop rules stay the same.</p
      ></fieldset
    >`;
  }

  function setup() {
    const { state, profile, nav, populationStatus, nameOf, footer } = context;

    if (!state.setupGame)
      state.setupGame = GameEngine.create(
        state.setupName,
        state.setupStart,
        false,
        state.setupDifficulty,
        profile?.name,
      );
    const chosen = findCountry(state.setupStart),
      game = state.setupGame;
    return /* HTML */ `<div class="shell"
      >${nav('setup')}<main
        ><div class="page-heading"
          ><div
            ><div class="eyebrow">New campaign / 01</div><h1>Choose your foothold.</h1
            ><p>One nation to begin with. A world to make your own.</p></div
          ><span class="step-indicator"
            ><span class="current">01 SETUP</span> / <span>02 COMMAND</span></span
          ></div
        ><div class="setup-grid"
          ><section class="panel"
            ><div class="panel-title"><span>Campaign details</span>${renderIcon('globe')}</div
            ><div class="panel-body"
              ><div class="field-group"
                ><label class="field-label" for="session-name">Campaign name</label
                ><input
                  class="field"
                  id="session-name"
                  maxlength="50"
                  value="${escapeHTML(state.setupName)}"
                  placeholder="Name your campaign" /></div
              >${difficultyPicker()}<label class="field-label" for="country-search"
                >Starting country</label
              ><div class="search-wrap"
                >${renderIcon('search')}<input
                  class="field"
                  id="country-search"
                  type="search"
                  placeholder="Search the country catalogue"
                  value="${escapeHTML(state.setupSearch)}" /></div
              ><div class="field-help"
                >${catalogue.length} countries and territories ·
                <a
                  href="https://www.worldometers.info/world-population/population-by-country/"
                  target="_blank"
                  rel="noopener"
                  >Worldometers</a
                >
                ·
                <a href="./assets/COUNTRY_DATA_CREDITS.txt" target="_blank" rel="noopener"
                  >Country data credits</a
                ><br /><span data-population-status>${populationStatus()}</span></div
              ><div class="country-options" id="country-options">${setupOptions()}</div
              ><div class="notice teal-notice"
                >${renderIcon('shield')}<span
                  ><strong
                    >${chosen.name} selected · ${armyValue(chosen.population)} starting
                    soldiers</strong
                  ><br />Initial army strength is determined by the population band.</span
                ></div
              ><div class="section-label"><span>Population → initial soldiers</span></div
              ><div class="population-bands"
                >${['≤ 5m', '≤ 10m', '≤ 25m', '≤ 50m', '≤ 75m', '≤ 100m', '≤ 125m', '≤ 150m', '> 150m'].map((v, i) => /* HTML */ `<div class="population-band">${v} <b>${i + 1}</b></div>`).join('')}</div
              ></div
            ></section
          ><div
            ><section class="panel"
              ><div class="panel-title"
                ><span>Your world is ready</span
                >${renderButton(renderIcon('refresh'), 'redraw-roster', 'btn-ghost btn-sm', 'aria-label="Redraw random opponents"')}</div
              ><div class="panel-body"
                ><div class="caption">10 distinct countries / 9 rivals drawn</div
                ><div class="roster-list"
                  >${game.countries.map((c, i) => /* HTML */ `<div class="setup-roster-row"><span>${c.flag}</span><span>${c.name}</span><span class="who" style="color:${colours[i]}">P${i + 1} ${escapeHTML(game.playerNames?.[i] || commanders[i])}</span><span class="troop-number">${c.army}</span></div>`).join('')}</div
                ><div class="notice" style="margin-top:18px"
                  >${renderIcon('info')}<span
                    ><strong>${nameOf(game.order[0])} will take the first turn.</strong><br />The
                    first participant is chosen randomly.</span
                  ></div
                ></div
              ><div class="setup-launch"
                ><span class="small muted">Your next move awaits.</span
                >${renderButton(`Start campaign ${renderIcon('arrow')}`, 'create-game', 'btn-primary')}</div
              ></section
            ><div class="notice setup-bottom"
              >${renderIcon('users')}<span
                ><strong>Round 1 starts without reinforcements.</strong><br />From round 2, receive
                two soldiers per controlled country at the start of your turn.</span
              ></div
            ></div
          ></div
        ></main
      >${footer()}</div
    >`;
  }

  function auth(kind) {
    const { nav, map, cloud, cloudReady, footer } = context;

    const signup = kind === 'signup',
      reset = kind === 'reset';
    return /* HTML */ `<div class="shell"
      >${nav()}<main class="auth-workspace"
        ><div class="auth-copy"
          ><div class="eyebrow">Strategy has a starting point</div
          ><h1>Your world.<br /><span class="gold">Your next move.</span></h1
          ><p
            >Build a campaign worth returning to. Your countries, troops and unfinished battles,
            ready when you are.</p
          ><div class="auth-map">${map(undefined, { mini: true })}</div
          ><div class="caption">10 countries / 9 strategic rivals / 1 commander</div></div
        ><section class="panel auth-box"
          ><div class="eyebrow"
            >${signup ? 'Your first campaign awaits' : reset ? 'Recover your command' : 'Welcome back, commander'}</div
          ><h2
            >${signup ? 'Create your account.' : reset ? 'Reset your password.' : 'Take command again.'}</h2
          ><p
            >${signup ? 'Choose a player nickname for campaigns and multiplayer.' : reset ? 'Request a password reset email.' : 'Your campaigns are waiting for their next chapter.'}</p
          ><form id="auth-form" data-kind="${kind}"
            >${signup ? '<div class="field-group"><label class="field-label" for="display-name">Player nickname</label><input class="field" id="display-name" name="name" autocomplete="nickname" required minlength="2" maxlength="32" placeholder="Your player nickname"></div>' : ''}<div
              class="field-group"
              ><label class="field-label" for="email">Email address</label
              ><input
                type="email"
                class="field"
                id="email"
                name="email"
                autocomplete="email"
                required
                placeholder="commander@example.com" /></div
            >${!reset ? /* HTML */ `<div class="field-group"><label class="field-label" for="password">Password ${!signup ? '<a href="#reset" class="gold">Forgot password?</a>' : ''}</label><input type="password" class="field" id="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required placeholder="At least 8 characters" /></div>${signup ? '<div class="field-group"><label class="field-label" for="confirm-password">Confirm password</label><input type="password" class="field" id="confirm-password" name="confirm" autocomplete="new-password" minlength="8" required placeholder="Repeat your password"></div>' : ''}` : ''}<div
              class="form-error"
              id="form-error"
              role="alert"
            ></div
            ><button
              class="btn btn-primary btn-full"
              type="submit"
              ${cloudEnabled && (!cloud || !cloudReady) ? 'disabled' : ''}
              >${signup ? 'Create account' : reset ? 'Send reset email' : 'Sign in'}
              ${renderIcon('arrow')}</button
            ></form
          ><div class="auth-switch"
            >${signup ? 'Already have an account? <a href="#signin">Sign in</a>' : reset ? '<a href="#signin">Return to sign in</a>' : 'New to Meridian? <a href="#signup">Create account</a>'}</div
          ><div class="auth-note"
            >${cloudEnabled ? 'Sign in securely with Firebase. Campaigns are saved to your account.' : 'Account preview: Firebase has not been connected yet. No credentials are sent.'}</div
          ></section
        ></main
      >${footer()}</div
    >`;
  }
  return {
    welcome,
    filteredGames,
    campaignResults,
    dashboard,
    setupOptions,
    setup,
    auth,
  };
}
