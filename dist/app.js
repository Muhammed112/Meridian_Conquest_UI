import { escapeHTML } from './html.js';
import { bindAppEvents } from './controllers/events.js';
import { aiConfig } from './ai-config.js';
import { applyCommentary } from './commentary.js?v=match-commentary-20261026-1';
import { localAppCheckDebugToken, localDevelopment } from './ai-local-config.js';
import { createMultiplayerUI } from './multiplayer.js';
import { connectCloud, cloudEnabled } from './cloud.js?v=match-commentary-20261026-1';
import { firebaseConfig } from './firebase-config.js';
import { catalogue, commanders, armyValue, populationReference } from './data.js';
import {
  createPopulationStore,
  populationFetcher,
  localPopulationFetcher,
  refreshSetupPopulation,
} from './populations.js';
import { GameEngine, LocalGameRepository } from './engine.js';

import {
  MotionDirector,
  resolveReducedMotion,
  presentationGame,
  rollPending,
} from './motion.js?v=battle-reveal-20261026-1';
import { SoundDirector } from './audio.js?v=quick-audio-20261024-1';
import { normalizeNickname, playerNickname } from './profile.js';
import { renderIcon } from './ui/components.js';
import { encodeSnapshot, decodeSnapshot } from './snapshots.js';
import { createNavigation } from './ui/navigation.js';
import { createMapView } from './ui/map.js';
import { createCampaignViews } from './ui/campaigns.js';
import { createBattleViews } from './ui/battle.js';
import { updateReportsCommentary } from './ui/reports.js';
import { createNpcController } from './controllers/npcs.js';

// Getters keep view dependencies current across account changes, routing and animation frames.
const viewContext = {
  get multiplayer() {
    return multiplayer;
  },
  get audioDirector() {
    return audioDirector;
  },
  get engine() {
    return engine;
  },
  get runNPCs() {
    return runNPCs;
  },
  get syncAIControls() {
    return syncAIControls;
  },
  get syncSettingsControls() {
    return syncSettingsControls;
  },
  get syncAudioControls() {
    return syncAudioControls;
  },
  get motionChoice() {
    return motionChoice;
  },
  get motionPreference() {
    return motionPreference;
  },
  get showHelp() {
    return showHelp;
  },
  get shareGame() {
    return shareGame;
  },
  get campaignResults() {
    return campaignResults;
  },
  get filteredGames() {
    return filteredGames;
  },
  get setupOptions() {
    return setupOptions;
  },
  get savePlayerNickname() {
    return savePlayerNickname;
  },
  get populations() {
    return populations;
  },
  set motionChoice(next) {
    motionChoice = next;
  },
  set replayTimer(next) {
    replayTimer = next;
  },
  set profile(next) {
    profile = next;
  },
  get cloud() {
    return cloud;
  },
  get profile() {
    return profile;
  },
  get motionDirector() {
    return motionDirector;
  },
  get nameOf() {
    return nameOf;
  },
  get nav() {
    return nav;
  },
  get theatre() {
    return theatre;
  },
  get footer() {
    return footer;
  },
  get owned() {
    return owned;
  },
  get map() {
    return map;
  },
  get games() {
    return games;
  },
  get state() {
    return state;
  },
  get campaignLoadState() {
    return campaignLoadState;
  },
  get campaignLoadError() {
    return campaignLoadError;
  },
  get populationStatus() {
    return populationStatus;
  },
  get cloudReady() {
    return cloudReady;
  },
  get motionFrame() {
    return motionFrame;
  },
  get campaignPopulationLabel() {
    return campaignPopulationLabel;
  },
  get dashboard() {
    return dashboard;
  },
  get encodeSnapshot() {
    return encodeSnapshot;
  },
  get replayTimer() {
    return replayTimer;
  },
  get save() {
    return save;
  },
  get render() {
    return render;
  },
  get currentGame() {
    return currentGame;
  },
  get notify() {
    return notify;
  },
};
const { nav, footer, motionControl, showHelp } = createNavigation(viewContext);
const { map, theatre } = createMapView(viewContext);
const { welcome, filteredGames, campaignResults, dashboard, setupOptions, setup, auth } =
  createCampaignViews(viewContext);
const { dicePairs, gameView, history } = createBattleViews(viewContext);
const { runNPCs } = createNpcController(viewContext);

const app = document.getElementById('app');
let repository = new LocalGameRepository(),
  cloud = null,
  cloudReady = !cloudEnabled;
let campaignLoadState = cloudEnabled ? 'loading' : 'ready',
  campaignLoadError = '';
const audioDirector = new SoundDirector({ onChange: syncAudioControls });
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let motionChoice = 'full';
try {
  motionChoice = localStorage.getItem('meridian-motion-preference') || 'full';
} catch {
  // Optional storage or browser capability is unavailable; retain the fallback.
}
const motionDirector = new MotionDirector({
  reducedMotion: resolveReducedMotion(motionChoice, motionPreference.matches),
});
document.documentElement.dataset.motion = motionDirector.reducedMotion ? 'reduced' : 'full';
let motionFrame = null;
let games = cloudEnabled ? [] : repository.load();
if (!Array.isArray(games)) games = [];
let profile;
try {
  profile = JSON.parse(localStorage.getItem('meridian-ui-profile')) || null;
} catch {
  profile = null;
}
if (cloudEnabled) profile = null;
const state = {
  view: 'welcome',
  gameId: null,
  action: 'planning',
  origin: null,
  target: null,
  selected: null,
  allocations: {},
  filter: 'all',
  search: '',
  setupStart: 'ZA',
  setupDifficulty: 'medium',
  setupName: 'Southern Meridian',
  setupSearch: '',
  setupGame: null,
  replay: 0,
  reportTab: 'field',
  fast: false,
  npcNote: '',
  watch: null,
  watchNPC: false,
};
let populationStorage;
try {
  populationStorage = localStorage;
} catch {
  // Optional storage or browser capability is unavailable; retain the fallback.
}
const populations = createPopulationStore({
  catalogue,
  reference: populationReference,
  storage: populationStorage,
  fetchSnapshot: localDevelopment ? localPopulationFetcher() : populationFetcher(firebaseConfig),
  onChange({ changed }) {
    if (changed) refreshSetupPopulation(state.setupGame, catalogue, populationReference, armyValue);
    if (changed && state.view === 'setup') {
      const focused = document.activeElement,
        id = focused?.id,
        start = focused?.selectionStart,
        end = focused?.selectionEnd;
      render();
      const input = id && document.getElementById(id);
      if (input) {
        input.focus();
        if (typeof start === 'number') input.setSelectionRange(start, end);
      }
    }
    for (const node of document.querySelectorAll('[data-population-status]'))
      node.textContent = populationStatus();
  },
});
function populationStatus() {
  return `Worldometers · ${populationReference.year} estimates · ${populations.status === 'unavailable' ? 'Using saved data · ' : ''}Snapshot checked ${new Date(populationReference.fetchedAt).toLocaleDateString()}`;
}
function campaignPopulationLabel(game) {
  return Number.isInteger(game.populationSource?.year)
    ? `Worldometers · ${game.populationSource.year} population snapshot`
    : 'Original campaign population snapshot';
}
let replayTimer = null,
  toastTimer = null;
let nicknameSaving = false,
  nicknameError = '';
const multiplayer = createMultiplayerUI({
  getCloud: () => cloud,
  notify: (message) => notify(message),
  changed: () => render(),
  mapView: (countries, options) => theatre(countries, { ...options, motion: motionFrame }),
  diceView: (pairs) => dicePairs(pairs),
  presentGame: (g) => presentationGame(g, motionFrame),
  isRolling: () => rollPending(motionFrame),
  getReportTab: () => state.reportTab,
});

const currentGame = () =>
  state.view === 'multiplayer'
    ? multiplayer.game
    : state.watch || games.find((g) => g.id === state.gameId);
const engine = () => new GameEngine(currentGame());
const owned = (g, player = 0) => g.countries.filter((c) => c.owner === player);
const nameOf = (p) =>
  escapeHTML(
    (currentGame()?.playerNames ||
      (state.view === 'setup' ? state.setupGame?.playerNames : null))?.[p] || commanders[p],
  );
function refreshSetupNickname() {
  const game = state.setupGame,
    name = profile?.name ? playerNickname(profile.name) : 'You';
  if (!game || game.playerNames?.[0] === name) return;
  game.playerNames = [name, ...commanders.slice(1)];
  // This is the unsaved preview: regenerate only its initial turn report.
  game.events = [];
  game.turnStarted = false;
  new GameEngine(game).beginTurn();
}
const notify = (message) => {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 3500);
};
function save() {
  if (state.watch) return;
  if (!repository.save(games))
    notify('Browser storage is unavailable. Keep this tab open to retain your progress.');
  if (cloud?.user && cloudReady)
    cloud
      .save(games)
      .catch(() =>
        notify('Cloud save failed. Progress is kept on this device; reconnect and try again.'),
      );
}

function route() {
  clearInterval(replayTimer);
  replayTimer = null;
  state.watchNPC = false;
  state.npcNote = '';
  const hash = location.hash.slice(1) || 'welcome';
  if (hash === 'how-to-play') {
    if (!app.innerHTML) render();
    showHelp();
    return;
  }
  motionDirector.reset();
  const [view, id] = hash.split('/');
  multiplayer.route(view === 'multiplayer' ? id || '' : null);
  if (view !== 'history' && view !== 'watch') {
    state.watch = null;
  }
  state.view = view;
  state.gameId = id;
  state.action = 'planning';
  state.selected = null;
  state.origin = null;
  state.target = null;
  state.allocations = {};
  if (view === 'watch') {
    try {
      state.watch = decodeSnapshot(id);
      state.gameId = state.watch.id;
      state.view = 'game';
    } catch (error) {
      state.watch = null;
      state.view = 'welcome';
      notify(error.message);
    }
  }
  if (view === 'history') {
    state.replay = 0;
    if (id === 'watch' && !state.watch) {
      state.view = 'campaigns';
    }
  }
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (state.view === 'game' && !state.watch) queueMicrotask(runNPCs);
}
function render() {
  const g = currentGame();
  const awaitingCampaign =
    (state.view === 'game' || state.view === 'history') &&
    (!g || (cloudEnabled && !cloudReady && !state.watch));
  if (awaitingCampaign && !g && (!cloudEnabled || cloudReady)) {
    state.view = 'campaigns';
    notify('This campaign is not saved on this device.');
  }
  if (g && !awaitingCampaign && ['game', 'history', 'multiplayer'].includes(state.view))
    motionFrame = motionDirector.frame(g, {
      view: state.view,
      replay: state.replay,
      fast: state.fast,
      watch: !!state.watch,
      localPlayer: state.view === 'multiplayer' ? multiplayer.playerSeat : 0,
    });
  else {
    motionDirector.reset();
    motionFrame = null;
  }
  app.innerHTML = awaitingCampaign
    ? dashboard()
    : state.view === 'multiplayer'
      ? /* HTML */ `<div class="shell"
          >${nav('multiplayer')}<main>${multiplayer.render()}</main>${footer()}</div
        >`
      : state.view === 'welcome'
        ? welcome()
        : state.view === 'campaigns'
          ? dashboard()
          : state.view === 'setup'
            ? setup()
            : ['signin', 'signup', 'reset'].includes(state.view)
              ? auth(state.view)
              : state.view === 'game'
                ? gameView(presentationGame(g, motionFrame))
                : state.view === 'history'
                  ? history(g)
                  : welcome();
  if (motionFrame) motionDirector.mount(app, motionFrame, { onSettled: render });
  audioDirector.observe(
    g,
    {
      view: state.view === 'multiplayer' ? 'game' : state.view,
      replay: state.replay,
      fast: state.fast,
      watch: !!state.watch,
    },
    motionFrame,
  );
  syncAudioControls();
  syncAIControls();
  syncNicknameControls();
  document.title =
    state.view === 'game' && g
      ? `${g.name} — Meridian Conquest`
      : 'Meridian Conquest — Your world. Your next move.';
}

async function shareGame(g) {
  if (!g) return;
  const url = `${location.origin}${location.pathname}#watch/${encodeSnapshot(g)}`;
  try {
    await navigator.clipboard.writeText(url);
    notify('Read-only campaign snapshot copied. This link does not update live.');
  } catch {
    const dialog = document.getElementById('help-dialog');
    dialog.innerHTML = /* HTML */ `<div class="help-head"
        ><h2 id="help-title">Share this campaign snapshot</h2
        ><button class="icon-button" data-action="close-help" aria-label="Close share dialog"
          >${renderIcon('close')}</button
        ></div
      ><div class="help-content"
        ><p class="small muted" style="margin:18px 0"
          >Copy this read-only snapshot link. It preserves the current position and recorded
          events.</p
        ><textarea class="field" style="height:100px" readonly aria-label="Snapshot URL">
${escapeHTML(url)}</textarea>
      </div>`;
    dialog.showModal();
    dialog.querySelector('textarea').select();
  }
}

function highlightCountry(code) {
  for (const node of app.querySelectorAll('[data-map-country]'))
    node.classList.toggle('is-hovered', !!code && node.dataset.mapCountry === code);
}
for (const type of ['pointerover', 'focusin'])
  app.addEventListener(type, (event) =>
    highlightCountry(event.target.closest('[data-map-country]')?.dataset.mapCountry),
  );
for (const type of ['pointerout', 'focusout'])
  app.addEventListener(type, (event) =>
    highlightCountry(event.relatedTarget?.closest?.('[data-map-country]')?.dataset.mapCountry),
  );
motionPreference.addEventListener('change', (event) => {
  motionDirector.setReducedMotion(resolveReducedMotion(motionChoice, event.matches));
  document.documentElement.dataset.motion = motionDirector.reducedMotion ? 'reduced' : 'full';
  render();
});
bindAppEvents(viewContext);
window.addEventListener('hashchange', route);
window.addEventListener('offline', () =>
  notify('You are offline. The loaded demo and local saves remain available.'),
);
window.addEventListener('online', () => notify('Connection restored.'));
document.getElementById('help-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.getElementById('settings-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
function syncSettingsControls() {
  document.getElementById('settings-motion').innerHTML = motionControl();
  nicknameError = '';
  syncNicknameControls(true);
}
function syncNicknameControls(reset = false) {
  const input = document.getElementById('player-nickname'),
    button = document.querySelector('#nickname-form button'),
    status = document.getElementById('nickname-status');
  const allowed = !cloudEnabled || Boolean(cloud?.user);
  if (reset) input.value = profile?.name || '';
  input.disabled = !allowed || nicknameSaving;
  button.disabled = !allowed || nicknameSaving;
  button.textContent = nicknameSaving ? 'Saving...' : 'Save nickname';
  status.textContent =
    nicknameError ||
    (!allowed
      ? 'Sign in to save a nickname to your account.'
      : nicknameSaving
        ? 'Saving your nickname...'
        : cloudEnabled
          ? 'Your account nickname is reused automatically in new multiplayer rooms.'
          : 'Saved on this device.');
}
async function savePlayerNickname(form) {
  if (nicknameSaving) return;
  nicknameError = '';
  let nickname;
  try {
    nickname = normalizeNickname(new FormData(form).get('nickname'));
  } catch (error) {
    nicknameError = error.message;
    syncNicknameControls();
    return;
  }
  nicknameSaving = true;
  syncNicknameControls();
  try {
    if (cloudEnabled) {
      if (!cloud?.user) throw new Error('Sign in first.');
      await cloud.updateNickname(nickname);
    } else {
      const next = { ...profile, name: nickname };
      localStorage.setItem('meridian-ui-profile', JSON.stringify(next));
      profile = next;
      refreshSetupNickname();
      render();
    }
    document.getElementById('player-nickname').value = nickname;
    notify('Player nickname saved.');
  } catch {
    nicknameError = 'Your nickname could not be saved. Check your connection and try again.';
  } finally {
    nicknameSaving = false;
    syncNicknameControls();
  }
}
function syncAIControls() {
  const narrator = cloud?.commentary,
    input = document.getElementById('ai-enabled'),
    status = document.getElementById('ai-status');
  if (input) {
    input.disabled = !aiConfig.enabled || !cloud;
    input.checked = Boolean(narrator?.enabled);
  }
  const localSetupNeeded =
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
    !localAppCheckDebugToken &&
    !globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;
  const message = !aiConfig.enabled
    ? 'Gemini commentary is not connected yet.'
    : !narrator
      ? 'Connecting...'
      : !narrator.enabled
        ? 'AI commentary is off.'
        : localSetupNeeded
          ? 'For localhost commentary, run npm run dev and open the address it prints.'
          : narrator.status === 'generating'
            ? 'Gemini is writing the latest field reports...'
            : narrator.status === 'unavailable'
              ? narrator.errorMessage || 'AI commentary is temporarily unavailable.'
              : narrator.pending.length
                ? 'Commentary is queued for Gemini.'
                : 'Gemini is ready. New game events are narrated automatically.';
  if (status) status.textContent = message;
  for (const node of app.querySelectorAll('[data-ai-feed-status]')) node.textContent = message;
  for (const node of app.querySelectorAll(
    '[data-action="request-commentary"],[data-room-action="commentary"]',
  ))
    node.disabled = !cloud?.ready || Boolean(narrator?.running || narrator?.pending.length);
}
function syncAudioControls() {
  const settings = audioDirector.settings;

  for (const name of ['music', 'effects']) {
    const input = document.getElementById(`audio-${name}`),
      output = document.getElementById(`audio-${name}-value`);
    if (input) input.value = String(Math.round(settings[name] * 100));
    if (output) output.textContent = `${Math.round(settings[name] * 100)}%`;
  }
  const mute = document.getElementById('audio-muted');
  if (mute) mute.checked = settings.muted;
  const status = document.getElementById('audio-status');
  if (status)
    status.textContent = settings.muted
      ? 'All sound is muted.'
      : audioDirector.unlocked
        ? 'Audio ready · Settings saved on this device.'
        : 'Sound starts when you interact with the game.';
}
route();
// Reference updates run independently of sign-in, saves, dice and turn playback.
void populations.refresh();

setInterval(() => {
  if (!document.hidden) void populations.refresh();
}, 3600000);
if (cloudEnabled) {
  connectCloud({
    onProfile(user) {
      profile = { name: playerNickname(user.displayName) };
      refreshSetupNickname();
      render();
      syncNicknameControls();
    },
    onAIStatus: syncAIControls,
    onLoadState({ status, error }) {
      campaignLoadState = status;
      campaignLoadError =
        error?.code === 'resource-exhausted'
          ? 'Firebase has reached its free usage limit.'
          : error?.code === 'permission-denied'
            ? 'Access was denied. Try signing out and signing in again.'
            : ['unavailable', 'deadline-exceeded'].includes(error?.code)
              ? 'Firebase could not be reached in time. Check your connection and retry.'
              : 'Please retry loading your campaigns.';
      render();
    },
    onSession(user, remote, ready) {
      cloudReady = ready;
      multiplayer.sessionChanged();
      if (!ready) {
        profile = user ? { name: playerNickname(user.displayName) } : null;
        refreshSetupNickname();
        repository = new LocalGameRepository(
          user ? 'meridian-cloud-cache-' + user.uid : 'meridian-signed-out',
        );
        const cached = user ? repository.load() : [];
        const visible = new Map(remote.map((game) => [game.id, game]));
        for (const game of Array.isArray(cached) ? cached : [])
          if (!visible.has(game.id) || game.updatedAt >= visible.get(game.id).updatedAt)
            visible.set(game.id, game);
        games = [...visible.values()];
        render();
        return;
      }
      profile = user ? { name: playerNickname(user.displayName) } : null;
      refreshSetupNickname();
      repository = new LocalGameRepository(
        user ? 'meridian-cloud-cache-' + user.uid : 'meridian-signed-out',
      );
      const cached = user ? repository.load() : [];
      const merged = new Map(remote.map((game) => [game.id, game]));
      for (const game of Array.isArray(cached) ? cached : [])
        if (!merged.has(game.id) || game.updatedAt >= merged.get(game.id).updatedAt)
          merged.set(game.id, game);
      games = [...merged.values()];
      repository.save(games);
      render();
      multiplayer.sessionChanged();
      if (user) {
        queueMicrotask(() => {
          save();
          if (state.view !== 'multiplayer') runNPCs();
        });
      }
    },
    onCommentary(gameId, eventId, result) {
      const game = games.find((game) => game.id === gameId),
        event = game?.events.find((event) => event.id === eventId);
      if (applyCommentary(event, result)) {
        repository.save(games);
        // Update the feed without interrupting the dice animation or active inputs.
        updateReportsCommentary(app, presentationGame(game, motionFrame));
      }
    },
    onError() {
      notify('Firebase could not load your campaigns. Check your connection and Firebase setup.');
    },
  })
    .then((service) => {
      cloud = service;
      multiplayer.sessionChanged();
      render();
    })
    .catch(() => {
      campaignLoadState = 'error';
      campaignLoadError = 'Firebase could not connect. Check your internet connection and retry.';
      render();
      notify(campaignLoadError);
    });
}
