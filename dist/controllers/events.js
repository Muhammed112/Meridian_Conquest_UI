import { rollPending, resolveReducedMotion } from '../motion.js?v=battle-reveal-20261026-1';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { GameEngine } from '../engine.js';
import { difficultyFor } from '../difficulty.js';
import { normalizeNickname } from '../profile.js';
import { selectReportTab, setReportsDock } from '../ui/reports.js';
import { applyBoardChoice } from './board-actions.js';
import {
  createOpeningRolls,
  rerollOpeningLeaders,
} from '../opening-rolls.js?v=opening-dice-20261104-1';
import { openingDiceFrame } from '../ui/opening-dice.js?v=opening-dice-20261104-2';

// Register the UI actions once. The application owns state and services.
export function bindAppEvents(context) {
  // Redrawing opponents changes only the unsaved setup preview.
  function redrawSetupGame() {
    const { state } = context;
    state.setupOpening = null;
    state.setupRollStartedAt = null;
    state.setupGame = GameEngine.create(
      state.setupName,
      state.setupStart,
      false,
      state.setupDifficulty,
      context.profile?.name,
    );
    context.render();
  }

  /** Change only report controls so switching tabs does not restart an active battle reveal. */
  function activateReportTab(button) {
    const panel = button.closest('[data-reports-panel]');
    if (context.state.reportDock.pinned) {
      context.state.reportDock.collapsed = false;
      setReportsDock(panel, context.state.reportDock);
    }
    context.state.reportTab = button.dataset.reportTab;
    selectReportTab(panel, context.state.reportTab);
    if (context.tutorial?.afterAction('report-tab', { tab: context.state.reportTab }))
      context.render();
  }
  document.addEventListener('click', async (event) => {
    const reportControl = event.target.closest('[data-report-control]');
    if (reportControl) {
      const dock = context.state.reportDock;
      if (reportControl.dataset.reportControl === 'pin') {
        dock.pinned = !dock.pinned;
        dock.collapsed = false;
      } else dock.collapsed = !dock.collapsed;
      setReportsDock(reportControl.closest('[data-reports-panel]'), dock);
      return;
    }
    const reportTab = event.target.closest('[data-report-tab]');
    if (reportTab) {
      activateReportTab(reportTab);
      return;
    }
    // Shared-board actions must reach room transactions before local single-player handlers.
    if (await context.multiplayer.handleClick(event)) return;
    const button = event.target.closest('[data-action]');
    if (!button) {
      if (event.target.closest('a[href]')) context.audioDirector.cue('click');
      return;
    }
    if (button.disabled) return;
    const action = button.dataset.action,
      g = context.currentGame();
    try {
      if (action.startsWith('tutorial-')) {
        if (!context.tutorial) return;
        if (action === 'tutorial-next' && !rollPending(context.motionFrame)) {
          context.tutorial.advance();
          context.state.npcNote = '';
          context.render();
        }
        if (action === 'tutorial-skip') context.finishTutorial();
        if (action === 'tutorial-finish' && context.tutorial.step === 'complete')
          context.finishTutorial('completed', button.dataset.destination || 'setup');
        return;
      }
      if (context.tutorial && !context.tutorial.allows(action)) {
        context.notify('Follow the current tutorial step, or select Skip tutorial.');
        return;
      }
      if (
        rollPending(context.motionFrame) &&
        [
          'roll',
          'stop-attack',
          'end-turn',
          'transfer',
          'confirm-transfer',
          'start-attack',
          'confirm-reinforce',
          'propose-alliance',
          'continue-npcs',
        ].includes(action)
      )
        return;
      if (action === 'request-commentary') {
        if (context.state.watch || context.state.liveShareId) return;
        const count = context.cloud?.requestCommentary(g) || 0;
        context.notify(
          count
            ? 'Gemini commentary requested for recent events.'
            : 'Recent events already have the latest commentary.',
        );
        context.syncAIControls();
        return;
      }
      if (action === 'retry-campaigns') {
        if (!context.cloud) {
          location.reload();
          return;
        }
        await context.cloud.reload();
        return;
      }
      if (action === 'retry-campaign-history') {
        await context.campaignController.open({ retry: true });
        return;
      }
      if (action === 'retry-live') {
        context.reconnectLive();
        return;
      }
      if (action === 'stop-sharing') {
        await context.liveShares.stop(button.dataset.id);
        context.render();
        context.notify('Live sharing stopped. The old link no longer shows your game.');
        return;
      }
      if (action === 'clear-campaign-filters') {
        context.state.filter = 'all';
        context.state.search = '';
        context.render();
        return;
      }
      if (action === 'sign-out') {
        await context.cloud.signOut();
        location.hash = 'welcome';
        return;
      }
      if (
        cloudEnabled &&
        context.state.view !== 'tutorial' &&
        [
          'create-game',
          'setup-roll',
          'setup-reroll',
          'fast',
          'continue-npcs',
          'allocate-plus',
          'allocate-minus',
          'auto-allocate',
          'confirm-reinforce',
          'confirm-transfer',
          'start-attack',
          'propose-alliance',
          'roll',
          'stop-attack',
          'end-turn',
        ].includes(action) &&
        (!context.cloud?.user || !context.cloudReady || (g && !context.campaignReady(g)))
      ) {
        context.notify(
          context.cloud?.user
            ? 'Your campaigns are still loading.'
            : 'Sign in to play and save your campaigns.',
        );
        if (!context.cloud?.user) location.hash = 'signin';
        return;
      }
      if (action === 'settings') {
        await context.audioDirector.unlock();
        context.syncSettingsControls();
        context.syncAudioControls();
        context.syncAIControls();
        document.getElementById('settings-dialog').showModal();
        context.tutorial?.afterAction('settings');
        return;
      }
      if (action === 'close-settings') {
        document.getElementById('settings-dialog').close();
        return;
      }
      if (action === 'test-audio') {
        await context.audioDirector.unlock();
        context.audioDirector.cue('turn');
        return;
      }
      if (!['roll', 'start-attack', 'confirm-transfer', 'confirm-reinforce'].includes(action))
        context.audioDirector.cue('click');
      if (action === 'motion') {
        context.motionChoice = context.motionDirector.reducedMotion ? 'full' : 'reduced';
        try {
          localStorage.setItem('meridian-motion-preference', context.motionChoice);
        } catch {
          // Optional storage or browser capability is unavailable; retain the fallback.
        }
        context.motionDirector.setReducedMotion(
          resolveReducedMotion(context.motionChoice, context.motionPreference.matches),
        );
        document.documentElement.dataset.motion = context.motionDirector.reducedMotion
          ? 'reduced'
          : 'full';
        context.syncSettingsControls();
        context.render();
        context.notify(
          context.motionDirector.reducedMotion
            ? 'Reduced motion enabled.'
            : 'Full map animations enabled.',
        );
        return;
      }
      if (action === 'help') {
        context.showHelp();
        return;
      }
      if (action === 'close-help') {
        document.getElementById('help-dialog').close();
        if (location.hash === '#how-to-play')
          window.history.replaceState(
            null,
            '',
            context.state.liveShareId && context.state.view === 'game'
              ? `#live/${context.state.liveShareId}`
              : `#${context.state.view}${context.state.gameId ? '/' + context.state.gameId : ''}`,
          );
        return;
      }
      if (action === 'account') {
        context.syncSettingsControls();
        context.syncAudioControls();
        context.syncAIControls();
        document.getElementById('settings-dialog').showModal();
        document.getElementById('player-nickname').focus();
        return;
      }
      if (action === 'filter') {
        context.state.filter = button.dataset.filter;
        context.render();
        return;
      }
      if (action === 'setup-country') {
        context.state.setupStart = button.dataset.code;
        redrawSetupGame();
        return;
      }
      if (action === 'redraw-roster') {
        redrawSetupGame();
        context.notify('Nine distinct rivals redrawn.');
        return;
      }
      if (action === 'setup-roll' || action === 'setup-reroll') {
        const { state } = context;
        if (state.view !== 'setup' || !state.setupGame) return;
        if (rollPending(openingDiceFrame(state, context.motionDirector.reducedMotion))) return;
        // Each click rolls every eligible commander once; redraws never generate another result.
        if (action === 'setup-roll') {
          if (state.setupOpening) return;
          state.setupOpening = createOpeningRolls(
            state.setupGame.countries.map((_, seat) => String(seat)),
          );
        } else state.setupOpening = rerollOpeningLeaders(state.setupOpening);
        state.setupRollStartedAt = performance.now();
        context.render();
        return;
      }
      if (action === 'create-game') {
        const { state } = context;
        if (state.view !== 'setup' || !state.setupGame) return;
        if (rollPending(openingDiceFrame(state, context.motionDirector.reducedMotion))) return;
        if (!state.setupOpening?.winner) {
          context.notify('Finish the opening dice rolls before starting the campaign.');
          return;
        }
        const name = context.state.setupName.trim();
        if (name.length < 3) {
          context.notify('Give your campaign a name of at least three characters.');
          document.getElementById('session-name').focus();
          return;
        }
        // Use the existing engine setup path so the first saved turn matches the winning die.
        const created = GameEngine.create(
          name,
          state.setupStart,
          false,
          state.setupDifficulty,
          context.profile?.name,
          {
            countries: state.setupGame.countries.map((country) => country.code),
            firstSeat: Number(state.setupOpening.winner),
          },
        );
        context.games.unshift(created);
        state.setupGame = null;
        state.setupOpening = null;
        state.setupRollStartedAt = null;
        context.save();
        location.hash = `game/${created.id}`;
        return;
      }
      if (action === 'share') {
        await context.shareGame(
          context.state.watch || context.games.find((x) => x.id === button.dataset.id) || g,
        );
        return;
      }
      if (action.startsWith('replay-')) {
        const last = g.events.length - 1;
        if (action === 'replay-select') context.state.replay = Number(button.dataset.index);
        if (action === 'replay-prev') context.state.replay = Math.max(0, context.state.replay - 1);
        if (action === 'replay-next')
          context.state.replay = Math.min(last, context.state.replay + 1);
        if (action === 'replay-play') {
          if (context.replayTimer) {
            clearInterval(context.replayTimer);
            context.replayTimer = null;
          } else {
            if (context.state.replay >= last) context.state.replay = 0;
            context.replayTimer = setInterval(() => {
              if (context.state.view !== 'history') {
                clearInterval(context.replayTimer);
                context.replayTimer = null;
                return;
              }
              context.state.replay++;
              if (context.state.replay >= last) {
                context.state.replay = last;
                clearInterval(context.replayTimer);
                context.replayTimer = null;
              }
              context.render();
            }, 5000);
          }
        }
        context.render();
        return;
      }
      if (!g) return;
      if (action === 'select-country') {
        applyBoardChoice(g, context.state, 0, action, button.dataset.code);
        context.tutorial?.afterAction(action, { code: button.dataset.code });
        context.render();
        return;
      }
      // Visitors may inspect countries and reports, but never invoke the mutable game engine.
      if (context.state.watch) return;
      if (action === 'fast') {
        context.state.fast = !context.state.fast;
        context.render();
        queueMicrotask(context.runNPCs);
        return;
      }
      if (action === 'continue-npcs') {
        context.state.watchNPC = true;
        context.render();
        queueMicrotask(context.runNPCs);
        return;
      }
      const e = context.engine();
      if (e.current !== 0 || g.winner !== null) return;
      applyBoardChoice(g, context.state, 0, action, button.dataset.code);
      if (action === 'diplomacy') {
        context.render();
        return;
      }
      if (action === 'propose-alliance') {
        const result = e.proposeAlliance(
          Number(document.getElementById('diplomacy-target')?.value),
        );
        context.state.action = 'diplomacy';
        context.notify(result.accepted ? 'Alliance agreed for three rounds.' : result.reason);
      }
      if (action === 'confirm-reinforce') {
        e.reinforce(context.state.allocations);
        context.state.allocations = {};
        context.state.action = 'planning';
        context.notify('Reinforcements deployed. Your next move is ready.');
      }
      if (action === 'confirm-transfer') {
        e.transfer(
          document.getElementById('transfer-from').value,
          document.getElementById('transfer-to').value,
          Number(document.getElementById('transfer-count').value),
        );
        context.state.action = 'planning';
        context.notify('Soldiers transferred.');
      }
      if (action === 'start-attack') {
        e.startAttack(
          document.getElementById('attack-from').value,
          document.getElementById('attack-to').value,
        );
        context.state.action = 'battle';
      }
      if (action === 'roll') {
        const result = e.roll(context.tutorial?.diceRoll());
        if (result.conquered) context.notify('A new nation is under your command.');
      }
      if (action === 'stop-attack') {
        e.stopAttack();
        context.state.action = 'planning';
        context.state.allocations = {};
      }
      if (action === 'end-turn') {
        e.endTurn();
        context.state.action = 'planning';
        context.state.allocations = {};
      }
      context.tutorial?.afterAction(action);
      if (context.tutorial?.step === 'bots') context.state.npcNote = g.events.at(-1).text;
      context.save();
      context.render({ tutorialAction: action });
      if (action === 'end-turn' || action === 'stop-attack') queueMicrotask(context.runNPCs);
    } catch (error) {
      context.audioDirector.cue('invalid');
      context.notify(error.message);
    }
  });

  document.addEventListener('input', (event) => {
    const input = event.target;
    if (context.multiplayer?.handleInput?.(input)) return;
    if (input.id === 'audio-music' || input.id === 'audio-effects') {
      context.audioDirector.setSettings({
        [input.id === 'audio-music' ? 'music' : 'effects']: Number(input.value) / 100,
      });
      return;
    }
    if (input.id === 'campaign-search') {
      context.state.search = input.value;
      document.getElementById('campaign-results').innerHTML = context.campaignResults();
      document.getElementById('campaign-result-count').textContent =
        `${context.filteredGames().length} SESSIONS`;
    }
    if (input.id === 'session-name') context.state.setupName = input.value;
    if (input.id === 'country-search') {
      context.state.setupSearch = input.value;
      document.getElementById('country-options').innerHTML = context.setupOptions();
    }
    if (input.id === 'history-range') {
      context.state.replay = Number(input.value);
      context.render();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'diplomacy-target') {
      context.state.diplomacyTarget = Number(event.target.value);
      context.render();
      return;
    }
    if (event.target.id === 'ai-enabled') {
      const enabled = event.target.checked;
      context.cloud?.setCommentaryEnabled(enabled);
      if (enabled && context.cloud?.ready) {
        try {
          if (context.state.view === 'multiplayer') context.multiplayer.requestCommentary();
          else if (context.state.view === 'game' && !context.state.watch) {
            const game = context.currentGame();
            if (game) context.cloud.requestCommentary(game);
          }
        } catch (error) {
          context.notify(error.message);
        }
      }
      context.syncAIControls();
      return;
    }
    if (event.target.id === 'audio-muted') {
      context.audioDirector.setSettings({ muted: event.target.checked });
      return;
    }
    if (event.target.name === 'difficulty' && context.state.view === 'setup') {
      context.state.setupDifficulty = difficultyFor(event.target.value).id;
      if (context.state.setupGame)
        context.state.setupGame.difficulty = context.state.setupDifficulty;
      context.render();
      document
        .getElementById(`difficulty-${context.state.setupDifficulty}`)
        ?.focus({ preventScroll: true });
      return;
    }
    if (['attack-from', 'transfer-from'].includes(event.target.id)) {
      context.state.origin = event.target.value;
      context.state.selected = event.target.value;
      context.render();
    }
    if (event.target.id === 'attack-to') {
      context.state.target = event.target.value;
      context.state.selected = event.target.value;
      context.render();
    }
  });

  document.addEventListener('keydown', (event) => {
    const reportTab = event.target.closest('[data-report-tab]');
    if (reportTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...reportTab.closest('[role="tablist"]').querySelectorAll('[data-report-tab]')];
      const index = tabs.indexOf(reportTab);
      const next =
        event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs.at(-1)
            : tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
      activateReportTab(next);
      next.focus({ preventScroll: true });
      return;
    }
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      event.target.matches('.map-marker[role="button"]')
    ) {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id === 'nickname-form') {
      event.preventDefault();
      await context.savePlayerNickname(event.target);
      return;
    }
    if (event.target.matches('[data-room-form]')) {
      event.preventDefault();
      await context.multiplayer.submit(event.target);
      return;
    }
    if (event.target.id !== 'auth-form') return;
    event.preventDefault();
    const form = event.target,
      values = new FormData(form),
      kind = form.dataset.kind;
    let signupNickname;
    if (kind === 'signup') {
      try {
        signupNickname = normalizeNickname(values.get('name'));
      } catch (error) {
        document.getElementById('form-error').textContent = error.message;
        return;
      }
    }
    if (cloudEnabled) {
      const errorNode = document.getElementById('form-error'),
        submit = form.querySelector('[type="submit"]');
      if (!context.cloud) {
        errorNode.textContent = 'Firebase is still connecting. Please try again.';
        return;
      }
      if (kind === 'signup' && values.get('password') !== values.get('confirm')) {
        errorNode.textContent = 'The passwords do not match.';
        return;
      }
      submit.disabled = true;
      try {
        await context.cloud.authenticate(kind, values);
        form.reset();
        // Keep reset confirmation generic so the UI does not disclose registered addresses.
        if (kind === 'reset')
          context.notify('If this account exists, a password reset email has been requested.');
        else {
          let destination = 'campaigns';
          try {
            destination = sessionStorage.getItem('meridian-room-return') || destination;
            sessionStorage.removeItem('meridian-room-return');
          } catch {
            // Optional storage or browser capability is unavailable; retain the fallback.
          }
          location.hash = destination;
          context.notify('Signed in. Your campaigns are loading.');
        }
      } catch (error) {
        errorNode.textContent =
          error.code === 'auth/email-already-in-use'
            ? 'This email already has an account. Try signing in.'
            : error.code === 'auth/network-request-failed'
              ? 'Cannot connect. Check your internet connection.'
              : 'Unable to sign in or complete the request. Check your details and try again.';
      } finally {
        submit.disabled = false;
      }
      return;
    }
    if (kind === 'reset') {
      context.notify(
        'Reset flow previewed. Email delivery will be available once authentication is connected.',
      );
      form.reset();
      return;
    }
    if (kind === 'signup' && values.get('password') !== values.get('confirm')) {
      document.getElementById('form-error').textContent =
        'The passwords do not match. Please check both fields.';
      return;
    }
    context.profile = { name: kind === 'signup' ? signupNickname : 'Commander' };
    try {
      localStorage.setItem('meridian-ui-profile', JSON.stringify(context.profile));
    } catch {
      // Optional storage or browser capability is unavailable; retain the fallback.
    }
    form.reset();
    location.hash = 'campaigns';
    context.notify(`Welcome, ${context.profile.name}. Your preview profile is ready.`);
  });

  // Browsers require a user gesture before audio playback; startup alone cannot unlock it.
  document.addEventListener(
    'pointerdown',
    () => {
      context.audioDirector.unlock();
    },
    { passive: true },
  );

  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) context.audioDirector.unlock();
  });

  document.addEventListener('visibilitychange', () =>
    context.audioDirector.setHidden(document.hidden),
  );

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void context.populations.refresh();
  });
}
