import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { aiConfig } from '../ai-config.js';
import { localAppCheckDebugToken } from '../ai-local-config.js';
import { normalizeNickname } from '../profile.js';

/** Own settings edits and status updates; read session-dependent services at the time of each action. */
export function createSettingsController(context) {
  let nicknameSaving = false,
    nicknameError = '';
  /** Rebuild settings when opened, clearing the previous nickname error. */
  function syncSettingsControls() {
    const { motionControl } = context;
    document.getElementById('settings-motion').innerHTML = motionControl();
    nicknameError = '';
    syncNicknameControls(true);
  }
  /** Reflect permissions and save progress without replacing an unfinished nickname edit. */
  function syncNicknameControls(reset = false) {
    const { cloud, profile } = context;
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
  /** Validate and persist a nickname once, keeping the saved profile on failure. */
  async function savePlayerNickname(form) {
    const { cloud, profile, notify, render, refreshSetupNickname } = context;
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
        context.profile = next;
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
  /** Mirror commentary availability in settings and report controls without restarting dice. */
  function syncAIControls() {
    const { cloud, app } = context;
    const narrator = cloud?.commentary,
      input = document.getElementById('ai-enabled'),
      status = document.getElementById('ai-status');
    if (input) {
      input.disabled = !aiConfig.enabled || !cloud;
      input.checked = Boolean(narrator?.enabled);
    }
    // Local debug attestation is supplied by the dev server, never embedded in hosted assets.
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
  /** Reflect effective audio settings in the dialog sliders, mute switch and status. */
  function syncAudioControls() {
    const { audioDirector } = context;
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
  return {
    syncSettingsControls,
    syncNicknameControls,
    savePlayerNickname,
    syncAIControls,
    syncAudioControls,
  };
}
