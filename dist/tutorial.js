import { GameEngine } from './engine.js';
import { catalogue, armyValue } from './data.js';

export const tutorialSteps = [
  'welcome',
  'map',
  'reinforce',
  'attack',
  'dice',
  'losses',
  'conquer',
  'conquest',
  'transfer',
  'end',
  'bots',
  'retreat',
  'reports',
  'settings',
  'multiplayer',
  'complete',
];

// Reuse real board controls, but allow only the actions needed for the current practice lesson.
const stepActions = {
  map: ['select-country'],
  reinforce: ['allocate-plus', 'allocate-minus', 'auto-allocate', 'confirm-reinforce'],
  attack: ['select-country', 'start-attack'],
  dice: ['roll'],
  conquer: ['roll'],
  transfer: ['select-country', 'transfer', 'planning', 'confirm-transfer'],
  end: ['end-turn'],
  retreat: [
    'select-country',
    'allocate-plus',
    'allocate-minus',
    'auto-allocate',
    'confirm-reinforce',
    'start-attack',
    'stop-attack',
  ],
};
const gameActions = new Set([
  ...Object.values(stepActions).flat(),
  'fast',
  'continue-npcs',
  'request-commentary',
]);

// A disposable practice game. Nothing here enters a campaign repository or AI queue.
export class TutorialSession {
  constructor(nickname = 'Commander') {
    this.stepIndex = 0;
    this.settingsOpened = false;
    this.game = GameEngine.create('Your first command · Practice', 'ZA', true, 'easy', nickname);
    const codes = ['ZA', 'GB', 'EG', 'CA', 'US', 'BR', 'IN', 'JP', 'AU', 'NO'];
    this.game.countries = codes.map((code, owner) => {
      const country = catalogue.find((item) => item.code === code);
      return { ...country, owner, value: armyValue(country.population), army: owner === 0 ? 8 : 2 };
    });
    this.game.round = 2;
    this.game.position = 0;
    this.game.events = [];
    this.game.turnStarted = false;
    this.engine.beginTurn();
  }
  get step() {
    return tutorialSteps[this.stepIndex];
  }
  get engine() {
    return new GameEngine(this.game);
  }
  /** Gate real game controls to the current lesson while leaving navigation available. */
  allows(action) {
    return !gameActions.has(action) || (stepActions[this.step] || []).includes(action);
  }
  /** Supply the lesson’s repeatable dice faces without changing the normal battle resolver. */
  diceRoll() {
    const values = this.game.battle.phase === 0 ? [1, 2, 4, 3] : [6, 1];
    let index = 0;
    return () => values[index++ % values.length];
  }
  /** Advance reading-only lessons; practice bot turns remain in memory and incur no AI requests. */
  advance() {
    if (!['welcome', 'losses', 'conquest', 'bots'].includes(this.step)) return false;
    if (this.step === 'bots') {
      const engine = this.engine;
      // Let the learner read one real bot decision, then resume their own practice.
      do {
        if (this.game.budget) engine.reinforce(engine.npcReinforcements().allocations);
        engine.endTurn();
      } while (engine.current !== 0);
    }
    this.stepIndex++;
    return true;
  }
  /** Advance only after the learner performs the expected action and update practice examples. */
  afterAction(action, { code, tab } = {}) {
    const next = {
      map: action === 'select-country' && code === this.game.start,
      reinforce: action === 'confirm-reinforce',
      attack: action === 'start-attack',
      dice: action === 'roll',
      conquer: action === 'roll' && !this.game.battle,
      transfer: action === 'confirm-transfer',
      end: action === 'end-turn',
      retreat: action === 'stop-attack',
      reports: action === 'report-tab' && tab === 'ai',
      settings: action === 'close-settings' && this.settingsOpened,
    }[this.step];
    if (this.step === 'settings' && action === 'settings') this.settingsOpened = true;
    if (!next) return false;
    this.stepIndex++;
    if (this.step === 'bots') this.engine.event('decision', this.engine.npcReinforcements().reason);
    // Label this fixed example explicitly; tutorial practice must not consume a Gemini request.
    if (this.step === 'reports') {
      const conquest = this.game.events.find((event) => event.type === 'conquest');
      const captured = this.game.countries.find((country) => country.code === conquest.country);
      conquest.commentary = /* prettier-ignore */ `[Tutorial example] ${this.game.playerNames[0]} captures ${
        captured.name
      }, gaining a second foothold.`;
    }
    return true;
  }
  /** Check the lesson’s example code without joining or creating a real multiplayer room. */
  joinPracticeRoom(code) {
    if (this.step !== 'multiplayer') return;
    if (String(code).trim().toUpperCase() !== 'ABC234')
      throw new Error('For this practice room, enter ABC234.');
    this.stepIndex++;
  }
}

// Remember the offer separately for each account on this browser, including
// a memory fallback when storage is blocked. Never infer progress from nicknames.
export function createTutorialProgress(storage) {
  const remembered = new Map();
  const key = (uid) => 'meridian-tutorial-v1-' + uid;
  const read = (uid) => {
    if (remembered.has(uid)) return remembered.get(uid);
    try {
      return storage?.getItem(key(uid));
    } catch {
      return null;
    }
  };
  return {
    shouldOffer(uid, games) {
      return Boolean(uid && !games.length && !read(uid));
    },
    mark(uid, status) {
      // A later skipped/offered update must never undo an account's completed tutorial.
      if (!uid || read(uid) === 'completed') return;
      remembered.set(uid, status);
      try {
        storage?.setItem(key(uid), status);
      } catch {
        /* Optional browser storage. */
      }
    },
  };
}
