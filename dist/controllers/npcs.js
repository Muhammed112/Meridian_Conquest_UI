import { commanders } from '../data.js';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { GameEngine } from '../engine.js';
import { NPC_DECISION_DELAY } from '../motion.js?v=battle-reveal-20261026-1';

/** Run one local bot loop and abandon it when navigation or the active game changes. */
export function createNpcController(context) {
  let npcBusy = false;
  const wait = (duration = 2500) => {
    const { state } = context;
    return new Promise((resolve) =>
      setTimeout(resolve, state.fast ? Math.max(750, Math.round(duration / 3)) : duration),
    );
  };

  /** Persist the explanation before the reading pause so reports and AI see it before the move. */
  async function pauseForDecision(engine, reason, logText = reason) {
    context.state.npcNote = reason;
    engine.event('decision', logText);
    context.save();
    context.render();
    await wait(NPC_DECISION_DELAY);
  }

  /** Apply planned transfers one by one, rechecking the active session after every pause. */
  async function defendNpcHoldings(engine, active) {
    const { save, render } = context;

    for (const move of engine.npcTransfers()) {
      if (!active()) return false;
      await pauseForDecision(engine, move.reason);
      if (!active()) return false;
      engine.transfer(move.from, move.to, move.amount);
      save();
      render();
      await wait();
    }
    return active();
  }

  /**
   * Execute legal bot turns with reading/reveal pauses, stopping for the human or a safety
   * limit.
   */
  async function runNPCs() {
    const { currentGame, cloud, cloudReady, state, owned, notify, save, render } = context;

    const game = currentGame();
    if (
      (cloudEnabled && (!cloud?.user || !cloudReady)) ||
      (context.campaignReady && !context.campaignReady(game)) ||
      !game ||
      npcBusy ||
      state.watch ||
      state.view !== 'game' ||
      game.winner !== null ||
      new GameEngine(game).current === 0 ||
      (!owned(game).length && !state.watchNPC)
    )
      return;
    npcBusy = true;
    // Recheck after each delay: navigation can replace the board while this loop is suspended.
    const active = () =>
      currentGame() === game &&
      state.view === 'game' &&
      !state.watch &&
      game.winner === null &&
      (!context.campaignReady || context.campaignReady(game));
    try {
      let turns = 0;
      while (
        active() &&
        new GameEngine(game).current !== 0 &&
        (owned(game).length || state.watchNPC) &&
        turns++ < 200
      ) {
        const engine = new GameEngine(game),
          participant = engine.current;
        engine.beginTurn();
        if (game.budget) {
          const plan = engine.npcReinforcements();
          await pauseForDecision(engine, plan.reason);
          if (!active()) break;
          engine.reinforce(plan.allocations);
          save();
          render();
          await wait();
          if (!active()) break;
        }
        if (!game.battle && engine.owned().length > 1 && !(await defendNpcHoldings(engine, active)))
          break;
        if (!game.battle && !game.attackUsed) {
          const plan = engine.npcPlan();
          await pauseForDecision(
            engine,
            plan.reason,
            `${game.playerNames?.[participant] || commanders[participant]}: ${plan.reason}`,
          );
          if (!active()) break;
          if (plan.from) {
            engine.startAttack(plan.from.code, plan.to.code);
            state.npcNote = `${plan.from.name} is preparing to attack ${plan.to.name}. The opening dice roll is next.`;
            save();
            render();
            await wait();
            if (!active()) break;
          }
        }
        while (active() && game.battle && engine.current === participant) {
          const decision = engine.npcBattleDecision();
          await pauseForDecision(engine, decision.reason);
          if (!active()) break;
          if (!decision.continue) {
            engine.stopAttack();
            state.npcNote = '';
            save();
            render();
            await wait();
            break;
          }
          const outcome = engine.roll();
          save();
          render();
          await wait(outcome.finished ? 3500 : 3000);
          if (outcome.conquered && active() && !(await defendNpcHoldings(engine, active))) break;
        }
        if (!active()) break;
        if (engine.current === participant && !game.battle) {
          engine.endTurn();
          state.npcNote = '';
          save();
          render();
          await wait();
        }
      }
      if (turns >= 200) notify('Playback paused after 200 turns. Continue watching to resume.');
    } catch (error) {
      notify(error.message);
    } finally {
      npcBusy = false;
      state.npcNote = '';
      if (new GameEngine(game).current === 0) state.fast = false;
      // Navigation may have opened another bot turn while the previous loop still held its lock.
      if (state.view === 'game' && currentGame() && currentGame() !== game) queueMicrotask(runNPCs);
      if (currentGame() === game && state.view === 'game') render();
    }
  }
  return { runNPCs };
}
