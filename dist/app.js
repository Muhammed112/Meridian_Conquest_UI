import { escapeHTML } from './html.js';
import { bindAppEvents } from './controllers/events.js?v=compact-panels-20261105-1';
import { applyCommentary } from './commentary.js?v=match-commentary-20261026-1';
import { localDevelopment } from './ai-local-config.js';
import { createMultiplayerUI } from './multiplayer.js?v=opening-order-20261105-1';
import { connectCloud, cloudEnabled } from './cloud.js?v=live-presence-20261104-1';
import { firebaseConfig } from './firebase-config.js';
import { catalogue, commanders, armyValue, populationReference } from './data.js';
import {
  createPopulationStore,
  populationFetcher,
  localPopulationFetcher,
  refreshSetupPopulation,
} from './populations.js';
import { GameEngine, LocalGameRepository, mergeCampaigns } from './engine.js';

import {
  MotionDirector,
  resolveReducedMotion,
  presentationGame,
  rollPending,
} from './motion.js?v=battle-reveal-20261026-1';
import { SoundDirector } from './audio.js?v=quick-audio-20261024-1';
import { playerNickname } from './profile.js';
import { renderIcon } from './ui/components.js';
import { encodeSnapshot, decodeSnapshot } from './snapshots.js?v=compact-panels-20261105-1';
import { spectatorPayload } from './spectators.js';
import { createNavigation } from './ui/navigation.js';
import { createMapView } from './ui/map.js';
import { syncMapLabels } from './ui/map-labels.js';
import { createWelcomeDemo } from './ui/welcome-demo.js';
import { createTutorialPresentation } from './ui/tutorial-presentation.js';
import { createCampaignViews } from './ui/campaigns.js?v=opening-order-20261105-1';
import { openingDiceFrame } from './ui/opening-dice.js?v=opening-dice-20261104-2';
import { createBattleViews } from './ui/battle.js?v=compact-panels-20261105-1';
import { syncLivePresence } from './ui/live-status.js?v=live-presence-20261104-1';
import {
  updateReportsCommentary,
  syncReportsDock,
  syncReportSharing,
} from './ui/reports.js?v=compact-panels-20261105-1';
import { createNpcController } from './controllers/npcs.js';
import { TutorialSession, createTutorialProgress } from './tutorial.js';
import {
  captureTutorialGuideState,
  renderTutorialGuide,
  syncTutorialControls,
} from './ui/tutorial.js';
import { captureFocus, restoreFocus } from './ui/focus.js';
import { createCampaignController } from './controllers/campaigns.js';
import { createSettingsController } from './controllers/settings.js';
import { renderCampaignStatus } from './ui/campaign-status.js';
import { createGameSummaryDialog } from './ui/game-summary.js';

// Getters keep view dependencies current across account changes, routing and animation frames.
const viewContext = {
  get die() {
    return die;
  },
  get app() {
    return app;
  },
  get motionControl() {
    return motionControl;
  },
  get refreshSetupNickname() {
    return refreshSetupNickname;
  },
  get repository() {
    return repository;
  },
  set games(next) {
    games = next;
  },
  get campaignController() {
    return campaignController;
  },
  get campaignReady() {
    return campaignController.isReady;
  },
  get tutorial() {
    return state.view === 'tutorial' ? tutorial : null;
  },
  get finishTutorial() {
    return finishTutorial;
  },
  get multiplayer() {
    return multiplayer;
  },
  get liveShares() {
    return cloud?.spectators;
  },
  get reconnectLive() {
    return () => watchLiveGame(state.liveShareId);
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
  get gameSummary() {
    return gameSummary;
  },
  get notify() {
    return notify;
  },
};
const { nav, footer, motionControl, showHelp } = createNavigation(viewContext);
const {
  syncSettingsControls,
  syncNicknameControls,
  savePlayerNickname,
  syncAIControls,
  syncAudioControls,
} = createSettingsController(viewContext);
const { map, theatre } = createMapView(viewContext);
const welcomeDemo = createWelcomeDemo(map);
const tutorialPresentation = createTutorialPresentation();
const { welcome, filteredGames, campaignResults, dashboard, setupOptions, setup, auth } =
  createCampaignViews(viewContext);
const { die, gameView, history } = createBattleViews(viewContext);
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
  diplomacyTarget: null,
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
  setupOpening: null,
  setupRollStartedAt: null,
  replay: 0,
  reportTab: 'field',
  reportDock: { pinned: false, collapsed: false },
  stoppingShares: new Set(),
  fast: false,
  npcNote: '',
  watch: null,
  liveShareId: null,
  liveStatus: '',
  livePresence: 'unknown',
  watchNPC: false,
};
let tutorial = null,
  accountId = null,
  focusedTutorialStep = null;
let stopLiveWatch = null,
  liveRequest = 0;
let populationStorage;
try {
  populationStorage = localStorage;
} catch {
  // Optional storage or browser capability is unavailable; retain the fallback.
}
const tutorialProgress = createTutorialProgress(populationStorage);
const tutorialAccount = () => (cloudEnabled ? accountId : profile ? 'local-preview' : null);
const campaignController = createCampaignController(viewContext);
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
/** Describe the reference snapshot and any fallback used for new campaigns. */
function populationStatus() {
  return /* prettier-ignore */ `Worldometers · ${populationReference.year} estimates · ${
    populations.status === 'unavailable' ? 'Using saved data · ' : ''
  }Snapshot checked ${new Date(populationReference.fetchedAt).toLocaleDateString()}`;
}
/** Show the population year recorded by this campaign, including legacy saves. */
function campaignPopulationLabel(game) {
  return Number.isInteger(game.populationSource?.year)
    ? `Worldometers · ${game.populationSource.year} population snapshot`
    : 'Original campaign population snapshot';
}
let replayTimer = null,
  toastTimer = null;
const multiplayer = createMultiplayerUI({
  getCloud: () => cloud,
  notify: (message) => notify(message),
  changed: () => render(),
  dieView: die,
  presentGame: (g) => presentationGame(g, motionFrame),
  isRolling: () => rollPending(motionFrame),
  renderGame: (game, header) => gameView(game, { roomHeader: header }),
  getState: () => state,
});

// Practice and spectator boards take precedence so their actions never target a private save.
const currentGame = () =>
  state.view === 'tutorial'
    ? tutorial?.game
    : state.view === 'multiplayer'
      ? multiplayer.game
      : state.liveShareId
        ? state.watch
        : state.watch || games.find((g) => g.id === state.gameId);
const engine = () => new GameEngine(currentGame());
const owned = (g, player = state.view === 'multiplayer' ? multiplayer.playerSeat : 0) =>
  g.countries.filter((c) => c.owner === player);
const nameOf = (p) =>
  escapeHTML(
    (currentGame()?.playerNames ||
      (state.view === 'setup' ? state.setupGame?.playerNames : null))?.[p] || commanders[p],
  );
/** Refresh only the unsaved preview; existing campaigns retain their recorded names. */
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
const gameSummary = createGameSummaryDialog({
  getCloud: () => cloud,
  getUser: () => cloud?.user,
  notify,
  pauseReplay() {
    clearInterval(replayTimer);
    replayTimer = null;
    render();
  },
  onSelectEvent(index) {
    state.replay = index;
    render();
  },
});
/** Save playable campaigns locally first, then queue account writes without blocking play. */
function save() {
  if (state.watch || state.view === 'tutorial') return;
  if (!campaignController.persistCache())
    notify('Browser storage is unavailable. Keep this tab open to retain your progress.');
  if (cloud?.user && cloudReady)
    cloud.save(games).catch((error) => {
      notify(
        error.code === 'campaign/conflict'
          ? error.message
          : 'Cloud save failed. Progress is kept on this device; reconnect and try again.',
      );
      render();
    });
}

/** Remember practice progress before discarding its in-memory board. */
function finishTutorial(status = 'skipped', destination = 'campaigns') {
  tutorialProgress.mark(tutorialAccount(), status);
  tutorial = null;
  location.hash = destination;
}

/** Replace the public subscription; ignore callbacks belonging to an older route. */
function watchLiveGame(id) {
  stopLiveWatch?.();
  stopLiveWatch = null;
  const request = ++liveRequest;
  state.liveStatus = 'connecting';
  state.livePresence = 'unknown';
  let departureAnnounced = false;
  /** Announce each departure once, even if presence arrives before the public board. */
  function announceDeparture() {
    if (state.livePresence === 'online') departureAnnounced = false;
    if (
      state.livePresence === 'offline' &&
      state.liveStatus === 'live' &&
      state.watch &&
      !departureAnnounced
    ) {
      departureAnnounced = true;
      notify('The player has left the game.');
    }
  }
  if (!cloud?.spectators) {
    if (!cloudEnabled) state.liveStatus = 'unavailable';
    render();
    return;
  }
  try {
    stopLiveWatch = cloud.spectators.watch(
      id,
      (game, { expired = false } = {}) => {
        if (request !== liveRequest) return;
        const previous = state.watch;
        state.watch = game;
        state.liveStatus = expired ? 'expired' : game ? 'live' : 'stopped';
        if (
          game &&
          previous &&
          game.updatedAt === previous.updatedAt &&
          game.events.at(-1)?.id === previous.events.at(-1)?.id
        ) {
          updateReportsCommentary(app, presentationGame(game, motionFrame));
        } else render();
        announceDeparture();
      },
      () => {
        if (request !== liveRequest) return;
        state.watch = null;
        state.liveStatus = 'unavailable';
        render();
      },
      (presence) => {
        if (request !== liveRequest || state.livePresence === presence) return;
        state.livePresence = presence;
        syncLivePresence(app, presence);
        announceDeparture();
      },
    );
  } catch {
    state.watch = null;
    state.liveStatus = 'unavailable';
  }
  render();
}

/** Render connection or revocation status without exposing any playable board. */
function liveWatchNotice() {
  return /* prettier-ignore */ `<div class="shell">${
    nav()
  }<main><section class="panel panel-body" role="status"><h1>${
    state.liveStatus === 'connecting'
        ? 'Connecting to the live game…'
        : state.liveStatus === 'stopped'
          ? 'This game is not being shared right now.'
          : state.liveStatus === 'expired'
            ? 'This live stream ended after five minutes of inactivity.'
          : 'The live game could not connect.'
  }</h1><p>Visitors can watch shared games. Only the signed-in player can make moves.</p>${
    state.liveStatus === 'connecting'
        ? ''
        : '<button class="btn" data-action="retry-live">Reconnect</button>'
  } <a href="#signup" class="btn btn-primary">Create your own account</a></section></main>${
    footer()
  }</div>`;
}

/** Reset route-specific playback and select the local, private or public game view. */
function route() {
  gameSummary.close();
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
  stopLiveWatch?.();
  stopLiveWatch = null;
  liveRequest++;
  motionDirector.reset();
  const [view, id] = hash.split('/');
  if (!(view === 'history' && id === 'watch')) {
    state.liveShareId = null;
    state.liveStatus = '';
    state.livePresence = 'unknown';
  }
  if (view === 'tutorial') {
    document.getElementById('help-dialog').close();
  } else tutorial = null;
  multiplayer.route(view === 'multiplayer' ? id || '' : null);
  if (view !== 'history' && view !== 'watch') {
    state.watch = null;
  }
  state.view = view;
  state.gameId = id;
  state.action = 'planning';
  state.diplomacyTarget = null;
  state.selected = null;
  state.origin = null;
  state.target = null;
  state.allocations = {};
  if (view === 'live') {
    state.view = 'game';
    state.liveShareId = id || 'invalid';
    watchLiveGame(state.liveShareId);
  }
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
  void campaignController.open();
  if (state.view === 'game' && !state.watch) queueMicrotask(runNPCs);
}
/** Render a presentation copy, then reconnect DOM observers to the replacement elements. */
function render({ tutorialAction } = {}) {
  const focusedControl = captureFocus(app);
  const previousGuide = state.view === 'tutorial' ? captureTutorialGuideState(app) : null;
  if (state.view === 'tutorial' && !tutorial) {
    tutorial = new TutorialSession(profile?.name);
    tutorialProgress.mark(tutorialAccount(), 'offered');
  }
  if (
    state.view === 'campaigns' &&
    cloudReady &&
    campaignLoadState === 'ready' &&
    tutorialProgress.shouldOffer(tutorialAccount(), games)
  ) {
    tutorialProgress.mark(tutorialAccount(), 'offered');
    queueMicrotask(() => {
      // Let the current render finish and ensure navigation has not already moved elsewhere.
      if (state.view === 'campaigns') location.hash = 'tutorial';
    });
  }
  const g = currentGame();
  const awaitingCampaign =
    !state.liveShareId &&
    (state.view === 'game' || state.view === 'history') &&
    (!g || (cloudEnabled && (!cloudReady || !campaignController.isReady(g)) && !state.watch));
  if (
    awaitingCampaign &&
    !g &&
    (!cloudEnabled || cloudReady) &&
    campaignController.status(state.gameId) === 'ready'
  ) {
    state.view = 'campaigns';
    notify('This campaign is not saved on this device.');
  }
  if (g && !awaitingCampaign && ['game', 'history', 'multiplayer', 'tutorial'].includes(state.view))
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
  const setupFrame =
    state.view === 'setup' ? openingDiceFrame(state, motionDirector.reducedMotion) : null;
  app.innerHTML =
    state.liveShareId && !state.watch
      ? liveWatchNotice()
      : awaitingCampaign
        ? state.view === 'campaigns'
          ? dashboard()
          : renderCampaignStatus({
              nav,
              footer,
              status: !cloudReady ? 'loading' : campaignController.status(state.gameId),
              name: g?.name,
            })
        : state.view === 'multiplayer'
          ? multiplayer.game
            ? multiplayer.render()
            : /* HTML */ `<div class="shell"
              >${nav('multiplayer')}<main>${multiplayer.render()}</main>${footer()}</div
            >`
          : state.view === 'welcome'
            ? welcome()
            : state.view === 'campaigns'
              ? dashboard()
              : state.view === 'setup'
                ? setup(setupFrame)
                : ['signin', 'signup', 'reset'].includes(state.view)
                  ? auth(state.view)
                  : state.view === 'tutorial'
                    ? gameView(presentationGame(g, motionFrame), {
                        guide: renderTutorialGuide(tutorial, motionFrame, {
                          adviser: true,
                        }),
                        adviserGuide: true,
                        showActions: !['reports', 'settings', 'complete'].includes(tutorial.step),
                      })
                    : state.view === 'game'
                      ? gameView(presentationGame(g, motionFrame))
                      : state.view === 'history'
                        ? history(g)
                        : welcome();
  // innerHTML replaced the elements; observers and animation mounts must attach to the new DOM.
  syncReportsDock(app);
  syncLivePresence(app, state.livePresence);
  syncMapLabels(app);
  welcomeDemo.mount(app, { reducedMotion: motionDirector.reducedMotion });
  const diceFrame = setupFrame || motionFrame;
  if (diceFrame) motionDirector.mount(app, diceFrame, { onSettled: render });
  if (state.view === 'tutorial') {
    const actionPanelAnchored = syncTutorialControls(
      app,
      tutorial,
      motionFrame,
      previousGuide,
      tutorialAction,
    );
    const stepKey = tutorial.game.id + '/' + tutorial.step;
    if (!rollPending(motionFrame) && focusedTutorialStep !== stepKey) {
      focusedTutorialStep = stepKey;
      const heading = app.querySelector(
        actionPanelAnchored ? '.action-panel h2' : '#tutorial-step-title',
      );
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      if (!actionPanelAnchored)
        heading
          .closest('.tutorial-guide')
          .scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  } else focusedTutorialStep = null;
  audioDirector.observe(
    g,
    {
      view: ['multiplayer', 'tutorial'].includes(state.view) ? 'game' : state.view,
      replay: state.replay,
      fast: state.fast,
      watch: !!state.watch,
    },
    motionFrame,
  );
  syncAudioControls();
  syncAIControls();
  syncNicknameControls();
  restoreFocus(app, focusedControl);
  tutorialPresentation.mount(app, { reducedMotion: motionDirector.reducedMotion });
  syncPlayingPresence();
  document.title =
    state.view === 'game' && g
      ? `${g.name} — Meridian Conquest`
      : 'Meridian Conquest — Your world. Your next move.';
}

/** Only a shared campaign actively open in its owner's browser sends presence heartbeats. */
function syncPlayingPresence() {
  const game = currentGame();
  const playing =
    navigator.onLine && cloudReady && state.view === 'game' && !state.watch && !state.liveShareId;
  cloud?.spectators?.setPlayingGame?.(playing && game ? game.id : null);
}

/** Share finished gameplay as a public snapshot; only ongoing campaigns start a live stream. */
async function shareGame(g) {
  if (!g) return;
  if (cloud?.user && !campaignController.isReady(g)) {
    const loaded = await campaignController.load(g.id);
    if (!loaded || !campaignController.isReady(loaded))
      throw new Error('Load this campaign before sharing it.');
    g = loaded;
  }
  const completed = Number.isInteger(g.winner);
  let live = !completed && Boolean(state.liveShareId);
  // Publish only after the private save succeeds; copying a URL alone does not grant write access.
  if (!completed && cloud?.user && cloudReady && !state.watch) {
    await cloud.save([g]);
    await cloud.spectators.start(g);
    live = true;
    if (state.view === 'campaigns') render();
    else syncReportSharing(app, cloud.spectators, state.stoppingShares);
  }
  const url = /* prettier-ignore */ `${location.origin}${location.pathname}#${
    live
      ? 'live/' + (state.liveShareId || g.id)
      : 'watch/' + encodeSnapshot(JSON.parse(spectatorPayload(g)))
  }`;
  try {
    await navigator.clipboard.writeText(url);
    notify(
      live
        ? 'Live spectator link copied. Visitors can watch without signing in.'
        : completed
          ? 'Gameplay link copied. Visitors can view the recorded game.'
          : 'Read-only campaign snapshot copied.',
    );
  } catch {
    const dialog = document.getElementById('help-dialog');
    dialog.innerHTML = /* prettier-ignore */ `<div class="help-head"
        ><h2 id="help-title">${
          live ? 'Share this live game' : completed ? 'Share gameplay' : 'Share this campaign snapshot'
        }</h2
        ><button class="icon-button" data-action="close-help" aria-label="Close share dialog"
          >${renderIcon('close')}</button
        ></div
      ><div class="help-content"
        ><p class="small muted" style="margin:18px 0"
          >${
            live
              ? 'Anyone with this link can watch updates. Only you can make moves. Use Stop' +
                ' sharing in the reports header or on the campaign card to revoke access.'
              : completed
                ? 'Copy this completed gameplay link. Visitors can view the final board' +
                  ' and replay its recorded recent events.'
                : 'Copy this read-only snapshot link. It preserves the current position and recorded events.'
          }</p
        ><textarea
          class="field"
          style="height:100px"
          readonly
          aria-label="${live ? 'Live spectator URL' : completed ? 'Gameplay URL' : 'Snapshot URL'}"
        >
${escapeHTML(url)}</textarea>
      </div>`;
    dialog.showModal();
    dialog.querySelector('textarea').select();
  }
}

/** Keep roster and map hover/focus highlights in sync through their country code. */
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
window.addEventListener('offline', () => {
  syncPlayingPresence();
  notify('You are offline. The loaded demo and local saves remain available.');
});
window.addEventListener('online', () => {
  syncPlayingPresence();
  notify('Connection restored.');
});
document.getElementById('help-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.getElementById('settings-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.getElementById('settings-dialog').addEventListener('close', () => {
  if (state.view === 'tutorial' && tutorial.afterAction('close-settings')) render();
});

route();
// Reference updates run independently of sign-in, saves, dice and turn playback.
void populations.refresh();

setInterval(() => {
  if (!document.hidden) void populations.refresh();
}, 3600000);
if (cloudEnabled) {
  connectCloud({
    onShareError() {
      notify('Live sharing is unavailable. Your private campaigns are unaffected.');
    },
    onProfile(user) {
      profile = { name: playerNickname(user.displayName) };
      refreshSetupNickname();
      render();
      syncNicknameControls();
    },
    onAIStatus: syncAIControls,
    onSharingExpired() {
      if (state.view === 'game' && cloud?.spectators)
        syncReportSharing(app, cloud.spectators, state.stoppingShares);
      else if (state.view === 'campaigns') render();
      notify('Live sharing stopped after five minutes of inactivity. Share again to restart.');
    },
    onCampaignState() {
      render();
    },
    onLoadState({ status, error, issues = [] }) {
      campaignLoadState = status;
      campaignLoadError =
        status === 'partial'
          ? `${issues.length} saved campaign${issues.length === 1 ? '' : 's'} could not be read. ` +
            'Your data is kept; other campaigns remain available.'
          : error?.code === 'resource-exhausted'
            ? 'Firebase has reached its free usage limit.'
            : error?.code === 'permission-denied'
              ? 'Access was denied. Try signing out and signing in again.'
              : ['unavailable', 'deadline-exceeded'].includes(error?.code)
                ? 'Firebase could not be reached in time. Check your connection and retry.'
                : 'Please retry loading your campaigns.';
      render();
    },
    onSession(user, remote, ready) {
      if (accountId !== (user?.uid || null)) {
        state.stoppingShares = new Set();
        gameSummary.reset();
        tutorial = null;
      }
      accountId = user?.uid || null;
      cloudReady = ready;
      multiplayer.sessionChanged();
      profile = user ? { name: playerNickname(user.displayName) } : null;
      refreshSetupNickname();
      // Account-specific recovery keys prevent another signed-in user inheriting these saves.
      repository = new LocalGameRepository(
        user ? 'meridian-cloud-cache-' + user.uid : 'meridian-signed-out',
      );
      const cached = user ? repository.load() : [];
      games = mergeCampaigns(remote, cached);
      // A partial campaign list must not overwrite the cache's complete history.
      render();
      if (!ready) return;
      multiplayer.sessionChanged();
      if (user) {
        queueMicrotask(() => {
          void campaignController.open();
          save();
          if (state.view !== 'multiplayer') runNPCs();
        });
      }
    },
    onCommentary(gameId, eventId, result) {
      const game = games.find((game) => game.id === gameId),
        event = game?.events.find((event) => event.id === eventId);
      if (applyCommentary(event, result)) {
        campaignController.persistCache();
        cloud?.spectators?.publish(game).catch(() => notify('Live commentary could not update.'));
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
      if (state.liveShareId && state.view === 'game') watchLiveGame(state.liveShareId);
      multiplayer.sessionChanged();
      void campaignController.open();
      render();
    })
    .catch(() => {
      campaignLoadState = 'error';
      campaignLoadError = 'Firebase could not connect. Check your internet connection and retry.';
      render();
      notify(campaignLoadError);
    });
}
