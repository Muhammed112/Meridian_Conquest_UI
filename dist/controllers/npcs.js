import { commanders } from '../data.js';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { GameEngine } from '../engine.js';

export function createNpcController(context) {
  let npcBusy = false;
  const wait = (duration = 2500) => {
    const { state } = context;
    return new Promise((resolve) =>
      setTimeout(resolve, state.fast ? Math.max(750, Math.round(duration / 3)) : duration),
    );
  };

  async function defendNpcHoldings(engine, active) {
    const { state, save, render } = context;

    for (const move of engine.npcTransfers()) {
      if (!active()) return false;
      state.npcNote = move.reason;
      engine.event('decision', move.reason);
      engine.transfer(move.from, move.to, move.amount);
      save();
      render();
      await wait();
    }
    return active();
  }

  async function runNPCs() {
    const { currentGame, cloud, cloudReady, state, owned, notify, save, render } = context;

    const game = currentGame();
    if (
      (cloudEnabled && (!cloud?.user || !cloudReady)) ||
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
    const active = () =>
      currentGame() === game && state.view === 'game' && !state.watch && game.winner === null;
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
          state.npcNote = plan.reason;
          engine.event('decision', state.npcNote);
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
          state.npcNote = plan.reason;
          engine.event(
            'decision',
            `${game.playerNames?.[participant] || commanders[participant]}: ${plan.reason}`,
          );
          save();
          render();
          await wait();
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
          state.npcNote = decision.reason;
          engine.event('decision', state.npcNote);
          if (!decision.continue) {
            save();
            render();
            await wait();
            if (!active()) break;
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
      if (state.view === 'game' && currentGame() && currentGame() !== game) queueMicrotask(runNPCs);
      if (currentGame() === game && state.view === 'game') render();
    }
  }
  return { runNPCs };
}
