import test from 'node:test';
import assert from 'node:assert/strict';
import { TutorialSession, createTutorialProgress, tutorialSteps } from '../dist/tutorial.js';
import { validateGameBoard } from '../dist/game-schema.js';
import { tutorialLessons } from '../dist/ui/tutorial-lessons.js';
import { renderTutorialGuide } from '../dist/ui/tutorial.js';

// A learner must finish the full guided flow using real rules in a fresh isolated practice
// campaign.
test('practice uses the normal game rules and completes without editing another campaign', () => {
  const session = new TutorialSession('Learner <Ace>');
  const { game } = session;
  const engine = session.engine;
  const act = (action, move) => {
    assert.equal(session.allows(action), true);
    move();
    session.afterAction(action);
    validateGameBoard(game);
  };
  assert.equal(game.playerNames[0], 'Learner <Ace>');
  assert.equal(game.budget, 2);
  assert.equal(game.countries.filter((country) => country.owner === 0).length, 1);
  assert.equal(session.allows('request-commentary'), false);
  assert.equal(session.allows('roll'), false);
  session.advance();
  assert.equal(session.afterAction('select-country', { code: 'GB' }), false);
  session.afterAction('select-country', { code: 'ZA' });
  act('confirm-reinforce', () => engine.reinforce({ ZA: 2 }));
  assert.equal(session.step, 'attack');
  act('start-attack', () => engine.startAttack('ZA', 'GB'));
  act('roll', () => engine.roll(session.diceRoll()));
  assert.equal(session.step, 'losses');
  assert.equal(game.battle.attackerLoss, 1);
  assert.equal(game.battle.defenderLoss, 1);
  assert.equal(game.countries.find((country) => country.code === 'ZA').army, 9);
  assert.equal(game.countries.find((country) => country.code === 'GB').army, 1);
  assert.deepEqual(
    game.battle.pairs.map(({ a, d }) => [a, d]),
    [
      [1, 2],
      [4, 3],
    ],
  );
  assert.equal(session.allows('roll'), false);
  session.advance();
  act('roll', () => engine.roll(session.diceRoll()));
  assert.equal(session.step, 'conquest');
  const captured = game.countries.find((country) => country.code === 'GB');
  assert.equal(captured.owner, 0);
  const reward = game.events.find((event) => event.type === 'conquest').reward;
  assert.equal(reward, Math.max(2, Math.floor(captured.value / 2)));
  session.advance();
  act('confirm-transfer', () => engine.transfer('ZA', 'GB', 2));
  assert.equal(captured.army, 3);
  act('end-turn', () => engine.endTurn());
  assert.equal(session.step, 'bots');
  assert.equal(game.events.at(-1).type, 'decision');
  session.advance();
  assert.equal(session.step, 'retreat');
  assert.equal(engine.current, 0);
  assert.equal(game.budget, 4);
  act('confirm-reinforce', () => engine.reinforce({ ZA: 4 }));
  act('start-attack', () => engine.startAttack('ZA', 'EG'));
  act('stop-attack', () => engine.stopAttack());
  assert.equal(session.step, 'reports');
  assert.match(
    game.events.find((event) => event.type === 'conquest').commentary,
    /^\[Tutorial example\]/,
  );
  assert.equal(session.afterAction('report-tab', { tab: 'field' }), false);
  session.afterAction('report-tab', { tab: 'ai' });
  assert.equal(session.step, 'settings');
  assert.equal(session.afterAction('close-settings'), false);
  session.afterAction('settings');
  session.afterAction('close-settings');
  assert.equal(session.step, 'multiplayer');
  assert.throws(() => session.joinPracticeRoom('WRONG1'), /ABC234/);
  session.joinPracticeRoom(' abc234 ');
  assert.equal(session.step, 'complete');
  assert.equal(new TutorialSession().step, 'welcome');
});

// Instruction coverage must remain complete without making each visible tutorial task overwhelming.
test('every supplied instruction has a lesson, while the visible task stays concise', () => {
  assert.deepEqual(Object.keys(tutorialLessons), tutorialSteps);
  const covered = new Set();
  for (const lesson of Object.values(tutorialLessons)) {
    assert.ok(lesson.summary.length < 200);
    assert.ok(lesson.task.length < 150);
    for (const instruction of lesson.covers) covered.add(instruction);
  }
  assert.deepEqual(
    [...covered].sort((a, b) => a - b),
    Array.from({ length: 26 }, (_, index) => index + 1),
  );
});

// Tutorial wording must not spoil losses or rewards before the dice presentation has revealed them.
test('the tutorial conceals recorded losses and rewards until dice settle', () => {
  const session = new TutorialSession();
  session.stepIndex = tutorialSteps.indexOf('conquest');
  const html = renderTutorialGuide(session, {
    reduced: false,
    roll: { age: 50, rollDuration: 1100 },
  });
  assert.match(html, /Watch the dice settle/);
  assert.doesNotMatch(
    html,
    /capture bonus|tutorial-rule-details|tutorial-visual|tutorial-chapters/,
  );
});

// One account's tutorial choice must not affect another account or downgrade an already completed
// tutorial.
test('tutorial offers are scoped to accounts and completion survives reload and replay', () => {
  const saved = new Map();
  const storage = {
    getItem: (key) => saved.get(key),
    setItem: (key, value) => saved.set(key, value),
  };
  const progress = createTutorialProgress(storage);
  assert.equal(progress.shouldOffer(null, []), false);
  assert.equal(progress.shouldOffer('returning', [{ id: 'existing-campaign' }]), false);
  assert.equal(progress.shouldOffer('new', []), true);
  progress.mark('new', 'offered');
  assert.equal(progress.shouldOffer('new', []), false);
  assert.equal(progress.shouldOffer('another', []), true);
  progress.mark('new', 'completed');
  const reloaded = createTutorialProgress(storage);
  assert.equal(reloaded.shouldOffer('new', []), false);
  reloaded.mark('new', 'offered');
  reloaded.mark('new', 'skipped');
  assert.equal(saved.get('meridian-tutorial-v1-new'), 'completed');
});

// Storage restrictions must not break practice or repeatedly interrupt the same session with
// tutorial offers.
test('blocked browser storage does not prevent practice or repeat the offer within a session', () => {
  const progress = createTutorialProgress({
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  });
  assert.equal(progress.shouldOffer('new', []), true);
  progress.mark('new', 'skipped');
  assert.equal(progress.shouldOffer('new', []), false);
});
