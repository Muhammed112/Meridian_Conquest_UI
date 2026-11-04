// Audio is presentation only. It never calls the combat RNG or changes a save.
export const AUDIO_STORAGE_KEY = 'meridian-audio-settings-v1';
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({ muted: false, music: 0.22, effects: 0.6 });
/** Normalize optional persisted settings, clamping volume to the supported range. */
export function audioSettings(value = {}) {
  const volume = (key) =>
    typeof value?.[key] === 'number' && Number.isFinite(value[key])
      ? Math.max(0, Math.min(1, value[key]))
      : DEFAULT_AUDIO_SETTINGS[key];
  return { muted: value?.muted === true, music: volume('music'), effects: volume('effects') };
}

/** Map factual events to sound timings, placing result cues after the visual dice reveal. */
export function soundCuesFor(event, { fast = false, rollDuration = 1100 } = {}) {
  const scale = fast ? 0.5 : 1;
  switch (event.type) {
    case 'attack':
      return [
        { sound: 'march', delay: 0 },
        { sound: 'missile', delay: 180 * scale },
      ];
    case 'transfer':
      return [{ sound: 'march', delay: 0 }];
    case 'dice':
      return [
        ...(rollDuration > 0 ? [{ sound: 'dice', delay: 0, duration: rollDuration }] : []),
        { sound: 'missile', delay: 0 },
        { sound: 'landing', delay: Math.max(0, rollDuration - 70) },
        ...(event.attackerLoss || event.defenderLoss || event.pairs?.some((p) => p.a !== p.d)
          ? [{ sound: 'impact', delay: rollDuration }]
          : []),
      ];
    case 'conquest':
      return [{ sound: 'capture', delay: rollDuration + 100 * scale }];
    case 'reinforce':
      return [{ sound: 'reinforce', delay: 0 }];
    case 'turn':
      return event.player === 0 ? [{ sound: 'turn', delay: 0 }] : [];
    case 'victory':
      return [
        { sound: event.player === 0 ? 'victory' : 'defeat', delay: rollDuration + 350 * scale },
      ];
    default:
      return [];
  }
}

// Consume new events once. Opening a save never plays its old sound history.
export class SoundEventCursor {
  reset() {
    this.key = null;
    this.count = 0;
    this.last = null;
    this.index = null;
  }
  constructor() {
    this.reset();
  }
  /** Return only newly observed events; loading a save must not replay its entire audio history. */
  read(game, { view = 'game', replay = 0, watch = false } = {}) {
    if (!game || !['game', 'history'].includes(view)) {
      this.reset();
      return [];
    }
    const key = `${view}:${watch ? 'watch' : 'live'}:${game.id}`,
      events = game.events;
    if (
      key !== this.key ||
      events.length < this.count ||
      (this.count && events[this.count - 1]?.id !== this.last)
    ) {
      this.key = key;
      this.count = events.length;
      this.last = events.at(-1)?.id;
      this.index = replay;
      return [];
    }
    const incoming =
      view === 'history'
        ? replay !== this.index && events[replay]
          ? [events[replay]]
          : []
        : events.slice(this.count);
    this.count = events.length;
    this.last = events.at(-1)?.id;
    this.index = replay;
    return incoming;
  }
}

const FILES = {
  click: 'click.ogg',
  dice: 'dice-shake.ogg',
  landing: 'dice-land.ogg',
  left: 'step-left.ogg',
  right: 'step-right.ogg',
  impact: 'impact.ogg',
};
const TRACKS = { menu: 'decisions.mp3', planning: 'lost-frontier.mp3', battle: 'mechanolith.mp3' };
const asset = (name) => {
  const url = new URL(`./assets/audio/${name}`, import.meta.url);
  if (name.endsWith('.mp3')) url.searchParams.set('v', 'quick-start-20261024-1');
  return url.href;
};

/** Manage optional audio resources, scene changes and cancellation independently of gameplay. */
export class SoundDirector {
  constructor({ storage, onChange = () => {} } = {}) {
    if (storage === undefined) {
      try {
        storage = globalThis.localStorage;
      } catch {
        // Optional storage or browser capability is unavailable; retain the fallback.
      }
    }
    this.storage = storage;
    this.onChange = onChange;
    let stored;
    try {
      stored = JSON.parse(storage?.getItem(AUDIO_STORAGE_KEY) || '{}');
    } catch {
      // Optional storage or browser capability is unavailable; retain the fallback.
    }
    this.settings = audioSettings(stored);
    this.cursor = new SoundEventCursor();
    this.context = null;
    this.unlocked = false;
    this.hidden = false;
    this.pending = new Set();
    this.voices = new Set();
    this.buffers = new Map();
    this.tracks = {};
    this.scene = 'menu';
    this.baseScene = 'menu';
    this.battleUntil = 0;
    this.lastClick = 0;
    this.generation = 0;
    this.activeMusic = null;
    this.prepareMusic();
  }
  prepareMusic() {
    // Buffer local music while the menu is visible. Playback still requires a gesture.
    if (typeof Audio !== 'function' || typeof document === 'undefined') return;
    for (const [name, file] of Object.entries(TRACKS)) {
      if (this.tracks[name]) continue;
      const element = new Audio();
      element.loop = true;
      element.preload = 'auto';
      element.src = asset(file);
      element.dataset.music = name;
      element.className = 'game-music';
      element.hidden = true;
      element.addEventListener('playing', () => this.activateMusic(name));
      document.body.append(element);
      this.tracks[name] = { element, gain: null };
      element.load();
    }
  }
  /** Apply normalized preferences immediately; persistence failure never prevents muting. */
  setSettings(patch) {
    this.settings = audioSettings({ ...this.settings, ...patch });
    try {
      this.storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Optional storage or browser capability is unavailable; retain the fallback.
    }
    if (this.settings.muted) this.cancelEffects();
    this.applyVolumes();
    this.syncMusic();
    this.onChange();
  }
  /** Coalesce gesture-triggered initialization and resume a suspended audio context. */
  async unlock() {
    if (this.unlocked) {
      if (!this.hidden && this.context?.state === 'suspended') {
        await this.context.resume().catch(() => {});
        this.syncMusic();
      }
      return;
    }
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.startAudio().finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }
  /** Create the audio graph once; unsupported or blocked audio leaves the game playable. */
  async startAudio() {
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return;
      this.context ??= new Context();
      const ctx = this.context;
      if (!this.master) {
        this.master = ctx.createGain();
        this.musicBus = ctx.createGain();
        this.effectsBus = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -12;
        limiter.ratio.value = 5;
        this.musicBus.connect(this.master);
        this.effectsBus.connect(this.master);
        this.master.connect(limiter);
        limiter.connect(ctx.destination);
        this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        // A deterministic noise bed keeps sound design separate from game randomness.
        const data = this.noise.getChannelData(0);
        let seed = 8171;
        for (let i = 0; i < data.length; i++) {
          seed = (seed * 16807) % 2147483647;
          data[i] = seed / 1073741823.5 - 1;
        }
      }
      this.prepareMusic();
      for (const track of Object.values(this.tracks))
        if (!track.gain) {
          const source = ctx.createMediaElementSource(track.element),
            gain = ctx.createGain();
          gain.gain.value = 0;
          source.connect(gain);
          gain.connect(this.musicBus);
          track.gain = gain;
        }
      await ctx.resume();
      this.unlocked = ctx.state === 'running';
      this.applyVolumes();
      this.syncMusic();
      this.onChange();
      if (this.unlocked) for (const file of Object.values(FILES)) this.load(file).catch(() => {});
    } catch {
      this.unlocked = false;
      this.onChange();
    }
  }
  /** Smoothly apply master/music/effect gains to avoid clicks when settings change. */
  applyVolumes() {
    if (!this.context || !this.master) return;
    const at = this.context.currentTime;
    for (const [node, value] of [
      [this.master, this.settings.muted || this.hidden ? 0 : 1],
      [this.musicBus, this.settings.music],
      [this.effectsBus, this.settings.effects],
    ]) {
      node.gain.cancelScheduledValues(at);
      node.gain.setTargetAtTime(value, at, 0.035);
    }
  }
  /** Share one decoding promise per asset and allow a failed asset to be retried later. */
  async load(file) {
    if (!this.context) return null;
    if (!this.buffers.has(file))
      this.buffers.set(
        file,
        fetch(asset(file))
          .then((r) => {
            if (!r.ok) throw new Error('Audio file unavailable');
            return r.arrayBuffer();
          })
          .then((data) => this.context.decodeAudioData(data))
          .catch(() => {
            this.buffers.delete(file);
            return null;
          }),
      );
    return this.buffers.get(file);
  }
  /** Check visibility, mute and browser playback state before scheduling an effect. */
  allowed() {
    return (
      this.unlocked &&
      !this.hidden &&
      !this.settings.muted &&
      this.settings.effects > 0 &&
      this.context?.state === 'running'
    );
  }
  /** Limit simultaneous effects and disconnect each source when playback ends. */
  trackVoice(source, gain) {
    if (this.voices.size >= 10) {
      try {
        source.stop();
      } catch {
        // A source may already have ended; releasing the remaining audio resources is still safe.
      }
      source.disconnect();
      gain?.disconnect();
      return false;
    }
    this.voices.add(source);
    source.onended = () => {
      this.voices.delete(source);
      source.disconnect();
      gain?.disconnect();
    };
    return true;
  }
  /** Play a decoded effect only if its request still belongs to the active audio generation. */
  async sample(name, { volume = 1, rate = 1, maxDuration = 0 } = {}) {
    if (!this.allowed()) return;
    const generation = this.generation,
      buffer = await this.load(FILES[name]);
    if (!buffer || generation !== this.generation || !this.allowed()) return;
    const ctx = this.context,
      source = ctx.createBufferSource(),
      gain = ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const duration = Math.min(buffer.duration / rate, maxDuration || Infinity),
      at = ctx.currentTime;
    gain.gain.setValueAtTime(volume, at);
    gain.gain.setValueAtTime(volume, at + Math.max(0, duration - 0.04));
    gain.gain.linearRampToValueAtTime(0, at + duration);
    source.connect(gain);
    gain.connect(this.effectsBus);
    if (!this.trackVoice(source, gain)) return;
    source.start();
    source.stop(at + duration);
  }
  /** Track delayed cues so navigation, mute and backgrounding can cancel them. */
  later(callback, delay) {
    const timer = setTimeout(
      () => {
        this.pending.delete(timer);
        if (!this.hidden) callback();
      },
      Math.max(0, delay),
    );
    this.pending.add(timer);
    return timer;
  }
  /** Synthesize a short note with an envelope rather than loading another recording. */
  tone(
    frequency,
    { delay = 0, duration = 0.2, volume = 0.12, type = 'sine', end = frequency } = {},
  ) {
    if (!this.allowed()) return;
    const ctx = this.context,
      at = ctx.currentTime + delay,
      osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    osc.frequency.exponentialRampToValueAtTime(end, at + duration);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain);
    gain.connect(this.effectsBus);
    if (!this.trackVoice(osc, gain)) return;
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }
  /** Synthesize a filtered whoosh from the deterministic noise buffer. */
  missile(volume) {
    if (!this.allowed()) return;
    const ctx = this.context,
      at = ctx.currentTime,
      source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter(),
      gain = ctx.createGain();
    source.buffer = this.noise;
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(250, at);
    filter.frequency.exponentialRampToValueAtTime(2600, at + 0.28);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16 * volume, at + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.48);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effectsBus);
    if (!this.trackVoice(source, gain)) return;
    source.onended = () => {
      this.voices.delete(source);
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    source.start();
    source.stop(at + 0.5);
  }
  /** Compose recorded and synthesized sounds for a semantic cue, throttling repeated clicks. */
  cue(name, { fast = false, duration = 1100 } = {}) {
    if (!this.allowed()) return;
    const volume = fast ? 0.55 : 1;
    if (name === 'click') {
      const now = performance.now();
      if (now - this.lastClick < 65) return;
      this.lastClick = now;
      this.sample('click', { volume: 0.28 });
    }
    if (name === 'march')
      for (let i = 0; i < (fast ? 2 : 4); i++)
        this.later(
          () => this.sample(i % 2 ? 'right' : 'left', { volume: 0.2 * volume, rate: 1.05 }),
          i * (fast ? 150 : 220),
        );
    if (name === 'dice') {
      this.sample('dice', {
        volume: 0.65 * volume,
        rate: fast ? 1.4 : 1,
        maxDuration: duration / 1000,
      });
      if (duration > 700)
        this.later(
          () => this.sample('dice', { volume: 0.3, rate: 1.3, maxDuration: 0.25 }),
          duration - 320,
        );
    }
    if (name === 'landing') this.sample('landing', { volume: 0.5 * volume, maxDuration: 0.22 });
    if (name === 'impact') {
      this.sample('impact', { volume: 0.45 * volume, maxDuration: 0.35 });
      this.tone(95, { duration: 0.22, volume: 0.12 * volume, end: 40 });
    }
    if (name === 'missile') this.missile(volume);
    const notes = {
      turn: [523, 659],
      capture: [392, 523, 659],
      reinforce: [330, 440],
      victory: [392, 523, 659, 784],
      defeat: [330, 262, 196],
      invalid: [185, 155],
    }[name];
    if (notes)
      notes.forEach((note, i) =>
        this.tone(note, {
          delay: i * (name === 'victory' ? 0.25 : 0.13),
          duration: name === 'victory' ? 0.8 : 0.3,
          volume: (name === 'victory' ? 0.13 : 0.08) * volume,
          type: name === 'victory' ? 'triangle' : 'sine',
        }),
      );
    if (['missile', 'impact', 'capture', 'victory'].includes(name))
      this.duckMusic(name === 'victory' ? 2400 : 700);
  }
  /** Temporarily lower music beneath important effects, replacing any older restore timer. */
  duckMusic(duration) {
    if (!this.musicBus) return;
    clearTimeout(this.duckTimer);
    const at = this.context.currentTime;
    this.musicBus.gain.cancelScheduledValues(at);
    this.musicBus.gain.setTargetAtTime(this.settings.music * 0.55, at, 0.06);
    this.duckTimer = setTimeout(() => this.applyVolumes(), duration);
  }
  /** Select the scene’s track while respecting mute, backgrounding and browser autoplay rules. */
  syncMusic() {
    if (!this.unlocked) return;
    const audible = !this.hidden && !this.settings.muted && this.settings.music > 0;
    if (!audible) {
      this.activeMusic = null;
      for (const track of Object.values(this.tracks)) {
        clearTimeout(track.pauseTimer);
        track.element.pause();
        track.gain?.gain.cancelScheduledValues(this.context.currentTime);
        track.gain?.gain.setTargetAtTime(0, this.context.currentTime, 0.025);
      }
      return;
    }
    const desired = this.scene,
      track = this.tracks[desired];
    if (!track) return;
    clearTimeout(track.pauseTimer);
    // Keep the outgoing track audible until the incoming recording actually plays.
    if (track.element.paused)
      track.element
        .play()
        .then(() => this.activateMusic(desired))
        .catch(() => {});
    else if (track.element.readyState >= 3) this.activateMusic(desired);
  }
  /** Fade only once the desired track is actually playing, then pause outgoing recordings. */
  activateMusic(name) {
    const track = this.tracks[name];
    if (!this.unlocked || !track?.gain) return;
    const audible = !this.hidden && !this.settings.muted && this.settings.music > 0;
    if (!audible || name !== this.scene) {
      if (!audible || name !== this.activeMusic) track.element.pause();
      return;
    }
    const at = this.context.currentTime;
    this.activeMusic = name;
    for (const [key, item] of Object.entries(this.tracks)) {
      clearTimeout(item.pauseTimer);
      item.gain.gain.cancelScheduledValues(at);
      item.gain.gain.setTargetAtTime(key === name ? (name === 'battle' ? 0.58 : 1) : 0, at, 0.08);
      if (key !== name && !item.element.paused)
        item.pauseTimer = setTimeout(() => {
          if (key !== this.activeMusic) item.element.pause();
        }, 400);
    }
  }
  /**
   * Invalidate pending decodes and cancel scheduled/playing effects without changing game
   * state.
   */
  cancelEffects() {
    this.generation++;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    for (const source of this.voices) {
      try {
        source.stop();
      } catch {
        // A source may already have ended; releasing the remaining audio resources is still safe.
      }
    }
    this.voices.clear();
  }
  /** Consume new facts and align sound cues with the current visual reveal timing. */
  observe(game, options = {}, frame = null) {
    const key = this.cursor.key,
      incoming = this.cursor.read(game, options);
    if (key !== this.cursor.key) {
      this.cancelEffects();
      clearTimeout(this.sceneTimer);
      this.battleUntil = 0;
      this.hadCountries = game?.countries?.some((c) => c.owner === 0);
    }
    // Scrubbing replay replaces queued cues from the previous event instead of overlapping them.
    if (options.view === 'history' && incoming.length) this.cancelEffects();
    const visualRoll = frame?.roll,
      rollDuration = frame?.reduced ? 0 : (visualRoll?.rollDuration ?? (options.fast ? 550 : 1100));
    const time = performance.now(),
      battle = incoming.some((event) => ['attack', 'dice'].includes(event.type));
    // Briefly retain battle music after a phase so quick state changes do not thrash tracks.
    if (battle) this.battleUntil = time + 3000;
    this.baseScene = game && ['game', 'history'].includes(options.view) ? 'planning' : 'menu';
    if (this.baseScene === 'menu') this.battleUntil = 0;
    const scene =
      this.baseScene === 'menu'
        ? 'menu'
        : (options.view === 'game' && game?.battle) || battle || this.battleUntil > time
          ? 'battle'
          : 'planning';
    if (scene !== this.scene) {
      this.scene = scene;
      this.syncMusic();
    }
    if (battle) {
      clearTimeout(this.sceneTimer);
      this.sceneTimer = setTimeout(() => {
        if (!game?.battle) {
          this.scene = this.baseScene;
          this.syncMusic();
        }
      }, 3100);
    }
    const hasCountries = game?.countries?.some((c) => c.owner === 0),
      eliminated = this.hadCountries && !hasCountries && options.view === 'game';
    this.hadCountries = hasCountries;
    if (!this.allowed()) return;
    if (eliminated) this.later(() => this.cue('defeat'), rollDuration + 200);
    for (const event of incoming) {
      for (const cue of soundCuesFor(event, {
        ...options,
        rollDuration:
          event.type === 'conquest' || event.type === 'victory'
            ? visualRoll
              ? rollDuration
              : 0
            : rollDuration,
      })) {
        this.later(
          () => this.cue(cue.sound, { fast: options.fast, duration: cue.duration }),
          cue.delay,
        );
      }
    }
  }
  /** Stop effects and suspend hidden-tab audio; resume music after the browser permits it. */
  setHidden(hidden) {
    this.hidden = hidden;
    this.cancelEffects();
    this.applyVolumes();
    if (hidden) {
      for (const track of Object.values(this.tracks)) track.element.pause();
      this.context?.suspend().catch(() => {});
    } else if (this.unlocked)
      this.context
        .resume()
        .then(() => {
          this.applyVolumes();
          this.syncMusic();
        })
        .catch(() => {});
  }
}
