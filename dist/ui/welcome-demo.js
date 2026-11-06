import { catalogue, armyValue } from '../data.js';
import { GameEngine } from '../engine.js';
import {
  MotionDirector,
  rollPending,
  DICE_ROLL_DURATION,
} from '../motion.js?v=battle-reveal-20261026-1';

const stageDurations = {
  campaign: 1000,
  attack: 2600,
  dice: DICE_ROLL_DURATION,
  conquest: 1800,
  transfer: 3600,
};

/** Precompute a deterministic showcase using the real engine, with no persistence or AI service. */
function demoGame() {
  const game = GameEngine.create('Gameplay preview', 'CA', true);
  // This board stays in memory and never enters campaign storage or the AI queue.
  game.countries = catalogue.slice(0, 10).map((country, owner) => ({
    ...country,
    owner,
    value: armyValue(country.population),
    army: armyValue(country.population),
  }));
  game.round = 1;
  game.budget = 0;
  game.events = [];
  const engine = new GameEngine(game);
  engine.event('campaign', 'Gameplay preview');
  for (const [from, to] of [
    ['US', 'BR'],
    ['JP', 'AU'],
    ['GB', 'NO'],
  ]) {
    game.position = game.order.indexOf(
      game.countries.find((country) => country.code === from).owner,
    );
    game.turnStarted = false;
    engine.beginTurn();
    engine.startAttack(from, to);
    while (game.battle) {
      let rollIndex = 0;
      engine.roll(() => (++rollIndex % 2 ? 6 : 1));
    }
    engine.transfer(from, to, 2);
  }
  return game;
}

/** Loop recorded showcase stages only while the welcome map is visible and motion is enabled. */
export function createWelcomeDemo(mapView) {
  const director = new MotionDirector();
  let theatre = null;
  let timer;
  let ownerDocument;
  let restart;

  /** Release the stage timer, animation frame and visibility listener when leaving the preview. */
  function stop() {
    clearTimeout(timer);
    director.reset();
    ownerDocument?.removeEventListener('visibilitychange', restart);
    theatre = null;
  }

  /** Replace the old preview instance; reduced motion retains the static welcome map. */
  function mount(root, { reducedMotion = false } = {}) {
    stop();
    theatre = root.querySelector('.hero .theatre');
    if (!theatre || reducedMotion) return;
    ownerDocument = root.ownerDocument;
    const game = demoGame();
    const stages = game.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => stageDurations[event.type]);
    let cursor = 0;

    /** Present one recorded stage, keeping dice results hidden until the shared reveal finishes. */
    function advance() {
      if (!theatre?.isConnected) return stop();
      if (ownerDocument.hidden) return;
      if (cursor === 0) director.reset();
      const { event, index } = stages[cursor];
      const frame = director.frame(game, { view: 'history', replay: index });
      const board = rollPending(frame) ? frame.roll.beforeBoard : event.board;
      const countries = game.countries.map((country) => ({
        ...country,
        ...board.find((entry) => entry.code === country.code),
      }));
      theatre.querySelector('.map-viewport').outerHTML = mapView(countries, { motion: frame });
      director.animate(theatre, frame);
      cursor = (cursor + 1) % stages.length;
      timer = setTimeout(advance, stageDurations[event.type]);
    }

    // Restart on visibility changes instead of catching up a backlog of unseen demo stages.
    restart = () => {
      clearTimeout(timer);
      director.reset();
      cursor = 0;
      advance();
    };
    ownerDocument.addEventListener('visibilitychange', restart);
    advance();
  }

  return { mount };
}
