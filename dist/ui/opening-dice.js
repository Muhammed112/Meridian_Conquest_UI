import { DICE_ROLL_DURATION } from '../motion.js?v=battle-reveal-20261026-1';

/** Present opening results on the existing dice clock without changing their recorded values. */
export function openingDiceFrame(state, reducedMotion, now = performance.now()) {
  if (!state.setupOpening || state.setupRollStartedAt == null) return null;
  return {
    reduced: reducedMotion,
    roll: {
      startedAt: state.setupRollStartedAt,
      age: Math.max(0, now - state.setupRollStartedAt),
      rollDuration: DICE_ROLL_DURATION,
      scale: 1,
    },
  };
}
