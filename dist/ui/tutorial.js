import { escapeHTML } from '../html.js';
import { rollPending } from '../motion.js?v=battle-reveal-20261026-1';
import { tutorialSteps } from '../tutorial.js';
import { tutorialLessons } from './tutorial-lessons.js';

/** Remember the current lesson's reading position before the board replaces its DOM. */
export function captureTutorialGuideState(root) {
  const column = root.querySelector('.tutorial-action-column');
  const guide = column?.querySelector('.tutorial-guide');
  if (!guide) return null;
  return {
    sessionId: guide.dataset.tutorialSession,
    step: guide.dataset.tutorialStep,
    scrollTop: column.scrollTop,
    detailsOpen: guide.querySelector('.tutorial-rule-details')?.open ?? false,
  };
}

/** Show one focused lesson and conceal result details while its practice dice are rolling. */
export function renderTutorialGuide(session, motionFrame) {
  // Use the same reveal guard as the real board so lesson text cannot spoil a dice result.
  const rolling = rollPending(motionFrame);
  const lesson = tutorialLessons[session.step];
  return /* prettier-ignore */ `<section
    class="panel tutorial-guide"
    aria-labelledby="tutorial-step-title"
    data-tutorial-session="${escapeHTML(session.game.id)}"
    data-tutorial-step="${session.step}"
  >
    <div class="tutorial-guide-head"
      ><span class="caption">Practice ${session.stepIndex + 1} / ${tutorialSteps.length}</span
      ><button type="button" class="link-button" data-action="tutorial-skip"
        >Skip tutorial</button
      ></div
    >
    <progress
      max="${tutorialSteps.length}"
      value="${session.stepIndex + 1}"
      aria-label="Tutorial progress"
    ></progress>
    <h2 id="tutorial-step-title" tabindex="-1"
      >${rolling ? 'Watch the dice settle.' : escapeHTML(lesson.title)}</h2
    >
    <p
      >${
        rolling
          ? 'The result will appear after the dice animation finishes.'
          : escapeHTML(lesson.summary)
      }</p
    >
    ${
      !rolling
        ? /* prettier-ignore */ `<p class="tutorial-task">${
            escapeHTML(lesson.task)
          }</p><details class="tutorial-rule-details"><summary>Rules & examples</summary>${
            [...lesson.notes, ...(lesson.details || [])]
              .map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`)
              .join('')
          }</details>`
        : ''
    }
    ${
      lesson.next
        ? /* prettier-ignore */ `<button type="button" class="btn btn-primary btn-full" data-action="tutorial-next" ${
            rolling ? 'disabled' : ''
          }>${escapeHTML(lesson.next)}</button>`
        : ''
    }
    ${
      session.step === 'multiplayer'
          ? `<form id="tutorial-room-form">` +
            `<label class="field-label" for="tutorial-room-code">Practice room` +
            ` code</label><input id="tutorial-room-code" class="field" name="code"` +
            ` maxlength="6" autocomplete="off" spellcheck="false" required` +
            ` aria-describedby="tutorial-room-error" />` +
            `<p id="tutorial-room-error" class="form-error" role="alert"></p>` +
            `<button class="btn btn-primary btn-full" type="submit">Join practice` +
            ` room</button></form>`
          : ''
    }
    ${
      session.step === 'complete'
          ? '<button type="button" class="btn btn-primary btn-full"' +
            ' data-action="tutorial-finish">Create my campaign</button>' +
            '<button type="button" class="btn btn-full" data-action="tutorial-finish"' +
            ' data-destination="campaigns">Back to the war room</button>'
          : ''
    }
    <p class="tutorial-practice-note">Practice board · Continue at your own pace.</p>
  </section>`;
}

/** Identify the useful next control for the current practice step and game phase. */
function isNextControl(button, session) {
  const action = button.dataset.action;
  if (session.step === 'map') return button.dataset.code === session.game.start;
  if (session.step === 'settings') return action === 'settings';
  if (['reinforce', 'retreat'].includes(session.step) && session.game.budget)
    return ['allocate-plus', 'auto-allocate', 'confirm-reinforce'].includes(action);
  return {
    attack: ['start-attack'],
    dice: ['roll'],
    conquer: ['roll'],
    transfer: ['transfer', 'confirm-transfer'],
    end: ['end-turn'],
    retreat: ['start-attack', 'stop-attack'],
  }[session.step]?.includes(action);
}

/** Disable unrelated actions and highlight the next permitted control after each render. */
export function syncTutorialControls(root, session, motionFrame, previousGuide) {
  const rolling = rollPending(motionFrame);
  for (const button of root.querySelectorAll('[data-action]')) {
    const allowed = session.allows(button.dataset.action);
    if (!allowed && button.tagName === 'BUTTON') button.disabled = true;
    button.classList.toggle(
      'tutorial-target',
      allowed && !button.disabled && !rolling && Boolean(isNextControl(button, session)),
    );
  }
  root
    .querySelector('[data-report-tab="ai"]')
    ?.classList.toggle('tutorial-target', session.step === 'reports');
  root.querySelector('.tutorial-guide')?.setAttribute('aria-busy', String(rolling));
  if (previousGuide?.sessionId === session.game.id && previousGuide.step === session.step) {
    const column = root.querySelector('.tutorial-action-column');
    const details = column.querySelector('.tutorial-rule-details');
    // Expand first so the restored scroll offset is not clamped to the closed guide's height.
    if (details) details.open = previousGuide.detailsOpen;
    column.scrollTop = previousGuide.scrollTop;
  }
}
