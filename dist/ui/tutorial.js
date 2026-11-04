import { escapeHTML } from '../html.js';
import { rollPending } from '../motion.js?v=battle-reveal-20261026-1';
import { tutorialSteps } from '../tutorial.js';
import { tutorialLessons } from './tutorial-lessons.js';

/** Present every rule and example in small dialogue pages before the practice instruction. */
export function tutorialDialogue(session) {
  const lesson = tutorialLessons[session.step];
  const nickname = session.game.playerNames?.[0];
  const greeting =
    session.step === 'welcome'
      ? [
          `Welcome, Commander${nickname && !['Commander', 'You'].includes(nickname) ? ' ' + nickname : ''}. ` +
            "I'm Captain Mara. I'll guide you through your first campaign.",
        ]
      : [];
  return [
    ...greeting,
    lesson.summary,
    ...lesson.notes,
    ...(lesson.details || []),
    `Commander, ${lesson.task[0].toLowerCase()}${lesson.task.slice(1)}`,
  ];
}

/** Remember the current lesson's reading position before the board replaces its DOM. */
export function captureTutorialGuideState(root) {
  const column = root.querySelector('.tutorial-action-column');
  const guide = root.querySelector('.tutorial-guide');
  if (!guide) return null;
  return {
    sessionId: guide.dataset.tutorialSession,
    step: guide.dataset.tutorialStep,
    scrollTop: column.scrollTop,
    detailsOpen: guide.querySelector('.tutorial-rule-details')?.open ?? false,
    actionPanelTop: column.querySelector('.action-panel')?.getBoundingClientRect().top ?? null,
  };
}

/** Show one focused lesson and conceal result details while its practice dice are rolling. */
export function renderTutorialGuide(session, motionFrame, { adviser = false } = {}) {
  // Use the same reveal guard as the real board so lesson text cannot spoil a dice result.
  const rolling = rollPending(motionFrame);
  const lesson = tutorialLessons[session.step];
  const dialogue = adviser ? tutorialDialogue(session) : [];
  const instruction = adviser ? dialogue[0] : lesson.task;
  const guide = /* prettier-ignore */ `<section
    class="panel tutorial-guide${adviser ? ' tutorial-dialogue' : ''}"
    aria-labelledby="tutorial-step-title"
    data-tutorial-session="${escapeHTML(session.game.id)}"
    data-tutorial-step="${session.step}"
  >
    <div class="tutorial-guide-head"
      ><span class="caption">${adviser ? 'Captain Mara · ' : ''}Practice ${session.stepIndex + 1} / ${
        tutorialSteps.length
      }</span
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
    ${!adviser || rolling ? `<p
      >${
        rolling
          ? 'The result will appear after the dice animation finishes.'
          : escapeHTML(lesson.summary)
      }</p>` : ''}
    ${
      !rolling
        ? /* prettier-ignore */ `<p class="tutorial-task${adviser ? ' tutorial-dialogue-copy' : ''}">${
            adviser
              ? `<span class="tutorial-dialogue-text">${escapeHTML(instruction)}</span>` +
                '<span class="tutorial-dialogue-typed" aria-hidden="true"></span>'
              : escapeHTML(instruction)
          }</p><details class="tutorial-rule-details"><summary>Rules & examples</summary>${
            [...(adviser && !lesson.next ? [lesson.summary] : []), ...lesson.notes, ...(lesson.details || [])]
              .map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`)
              .join('')
          }</details>${adviser ? /* prettier-ignore */ `<div class="tutorial-dialogue-script" hidden>${
            dialogue.map((message) => `<p>${escapeHTML(message)}</p>`).join('')
          }</div><button type="button" class="btn btn-primary" data-tutorial-dialogue-next>
            Continue
          </button>` : ''}`
        : ''
    }
    ${
      lesson.next
        ? /* prettier-ignore */ `<button type="button" class="btn btn-primary btn-full" data-action="tutorial-next" ${
            rolling ? 'disabled' : ''
          } ${
            adviser ? 'hidden' : ''
          }>${escapeHTML(lesson.next)}</button>`
        : ''
    }
    ${
      session.step === 'complete'
          ? '<button type="button" class="btn btn-primary btn-full"' +
            ` data-action="tutorial-finish" ${adviser ? 'hidden' : ''}>Create my campaign</button>` +
            '<button type="button" class="btn btn-full" data-action="tutorial-finish"' +
            ` data-destination="campaigns" ${adviser ? 'hidden' : ''}>Back to the war room</button>`
          : ''
    }
    <p class="tutorial-practice-note">Practice board · Continue at your own pace.</p>
  </section>`;
  if (!adviser) return guide;
  // The character and dialogue share ordinary layout space, leaving every game control accessible.
  return /* HTML */ `<div class="tutorial-adviser">
    <img src="./assets/tutorial-adviser.svg" alt="" width="96" height="120" />
    ${guide}
  </div>`;
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
    diplomacy: ['diplomacy', 'propose-alliance'],
    end: ['end-turn'],
    retreat: ['start-attack', 'stop-attack'],
  }[session.step]?.includes(action);
}

/** Disable unrelated actions and highlight the next permitted control after each render. */
export function syncTutorialControls(root, session, motionFrame, previousGuide, tutorialAction) {
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
  const column = root.querySelector('.tutorial-action-column');
  if (previousGuide?.sessionId !== session.game.id) return false;
  if (previousGuide.step === session.step) {
    const details = root.querySelector('.tutorial-rule-details');
    // Expand first so the restored scroll offset is not clamped to the closed guide's height.
    if (details) details.open = previousGuide.detailsOpen;
    column.scrollTop = previousGuide.scrollTop;
  }
  const panel = column.querySelector('.action-panel');
  if (tutorialAction !== 'confirm-reinforce' || previousGuide.actionPanelTop === null || !panel)
    return false;
  // A new lesson changes the guide's height. Anchor the action card instead of reusing its old offset.
  const movement = panel.getBoundingClientRect().top - previousGuide.actionPanelTop;
  if (['auto', 'scroll'].includes(getComputedStyle(column).overflowY)) column.scrollTop += movement;
  else root.ownerDocument.defaultView.scrollBy({ top: movement, behavior: 'instant' });
  return true;
}
