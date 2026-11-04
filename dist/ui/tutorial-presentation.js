// Tutorial presentation only: typing and hints never dispatch actions or change the practice game.

/** Choose one useful control, including the next button within multi-action lessons. */
function nextTutorialControl(root) {
  return (
    root.querySelector('[data-tutorial-dialogue-next]:not([hidden])') ||
    root.querySelector(
      '.tutorial-guide [data-action="tutorial-next"]:not(:disabled):not([hidden])',
    ) ||
    root.querySelector('.tutorial-target[data-action="confirm-reinforce"]') ||
    root.querySelector('.tutorial-target[data-action="allocate-plus"]') ||
    root.querySelector('.tutorial-target[data-action="confirm-transfer"]') ||
    root.querySelector('.action-panel .tutorial-target') ||
    root.querySelector('.map-marker.tutorial-target') ||
    root.querySelector('.tutorial-target') ||
    root.querySelector('.tutorial-guide [data-action="tutorial-finish"]:not([hidden])')
  );
}

/** Account for both the page viewport and scrollable action panels when revealing a control. */
function controlIsVisible(control, view) {
  const bounds = control.getBoundingClientRect();
  if (
    !bounds.width ||
    !bounds.height ||
    bounds.top < -1 ||
    bounds.bottom > view.innerHeight + 1 ||
    bounds.left < 0 ||
    bounds.right > view.innerWidth
  )
    return false;
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (!['auto', 'scroll', 'hidden'].includes(style.overflowY)) continue;
    const clip = parent.getBoundingClientRect();
    if (bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1) return false;
  }
  return true;
}

/** Preserve typing across board redraws and dispose of every animation when the tutorial exits. */
export function createTutorialPresentation() {
  let instructionKey = '';
  let dialogueIndex = 0;
  let charactersShown = 0;
  let lastControlKey = '';
  let unmount = () => {};

  return {
    mount(root, { reducedMotion = false } = {}) {
      unmount();
      unmount = () => {};
      const guide = root.querySelector('.tutorial-dialogue');
      if (!guide) {
        instructionKey = '';
        dialogueIndex = 0;
        charactersShown = 0;
        lastControlKey = '';
        return;
      }
      const document = root.ownerDocument;
      const view = document.defaultView;
      const copy = guide.querySelector('.tutorial-dialogue-copy');
      const messages = Array.from(
        guide.querySelectorAll('.tutorial-dialogue-script p'),
        (paragraph) => paragraph.textContent,
      );
      const text = copy?.querySelector('.tutorial-dialogue-text');
      const typedText = copy?.querySelector('.tutorial-dialogue-typed');
      const continueButton = guide.querySelector('[data-tutorial-dialogue-next]');
      const instructionActions = guide.querySelectorAll(
        '[data-action="tutorial-next"], [data-action="tutorial-finish"]',
      );
      const key = [guide.dataset.tutorialSession, guide.dataset.tutorialStep, ...messages].join(
        '/',
      );
      if (key !== instructionKey) {
        instructionKey = key;
        dialogueIndex = 0;
        charactersShown = 0;
        lastControlKey = '';
      }
      let fullText = messages[dialogueIndex] || '';
      let frame = 0;
      let active = true;
      let target = null;
      const pointer = document.createElement('div');
      pointer.className = 'tutorial-pointer';
      pointer.setAttribute('aria-hidden', 'true');
      pointer.hidden = true;
      // The index finger sits above three visibly folded fingers and a separate thumb.
      pointer.innerHTML = /* HTML */ `<span class="tutorial-pointer-ring"></span>
        <svg viewBox="0 0 42 50" fill="currentColor" stroke="#172433" stroke-width="1.7">
          <g transform="translate(-14 0)">
            <path
              d="M14 1C11 1 9 3 9 6V28L6 24C4 21 0 22 0 25C0 26 0 27 1 28
                L10 43C12 47 15 49 21 49H29C36 49 41 44 41 37V24
                C41 21 37 19 34 22V19C34 15 29 14 26 17V15
                C26 11 21 10 19 13V6C19 3 17 1 14 1Z"
            />
            <path d="M19 14V28M26 18V29M34 23V31M9 28L15 35" fill="none" />
          </g>
        </svg>`;
      document.body.append(pointer);

      /** Follow manual/nested scrolling without repeatedly pulling the learner back. */
      function positionPointer() {
        const blocked =
          guide.getAttribute('aria-busy') === 'true' || document.querySelector('dialog[open]');
        pointer.hidden = Boolean(
          !active || !target?.isConnected || copy?.dataset.typing === 'true' || blocked,
        );
        if (pointer.hidden) return;
        const surface = target.querySelector('circle') || target;
        const bounds = surface.getBoundingClientRect();
        pointer.hidden = !controlIsVisible(surface, view);
        pointer.style.left = bounds.left + bounds.width / 2 + 'px';
        pointer.style.top = bounds.top + bounds.height / 2 + 'px';
      }

      /** Scroll once for a newly requested action; allocation redraws keep the reader's position. */
      function showNextControl() {
        if (!active || guide.getAttribute('aria-busy') === 'true') return;
        target = nextTutorialControl(root);
        if (!target) return;
        const controlKey =
          target.id ||
          (target.hasAttribute('data-tutorial-dialogue-next')
            ? 'dialogue-next'
            : [target.dataset.action, target.dataset.code].filter(Boolean).join(':'));
        pointer.dataset.target = controlKey;
        if (lastControlKey !== controlKey && !document.querySelector('dialog[open]')) {
          lastControlKey = controlKey;
          if (!controlIsVisible(target, view))
            target.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
              behavior: reducedMotion ? 'instant' : 'smooth',
            });
        }
        positionPointer();
      }

      /** Reveal letters visually while the complete instruction stays available to screen readers. */
      function updateCopy() {
        if (!copy) return;
        typedText.textContent = fullText.slice(0, charactersShown);
        copy.dataset.typing = String(charactersShown < fullText.length);
      }

      let startingCharacters = 0;
      let startedAt = 0;
      function typeInstruction(now) {
        if (!active) return;
        charactersShown = Math.min(
          fullText.length,
          startingCharacters + Math.floor((now - startedAt) / 22),
        );
        updateCopy();
        if (charactersShown < fullText.length) frame = view.requestAnimationFrame(typeInstruction);
        else showNextControl();
      }

      /** Restore the current paragraph after redraws; only deliberate Continue clicks change it. */
      function showMessage() {
        view.cancelAnimationFrame(frame);
        fullText = messages[dialogueIndex] || '';
        if (text) text.textContent = fullText;
        const explaining = dialogueIndex < messages.length - 1;
        if (continueButton) continueButton.hidden = !explaining;
        for (const button of instructionActions) button.hidden = explaining;
        guide.dataset.dialoguePage = String(dialogueIndex);
        if (reducedMotion) charactersShown = fullText.length;
        updateCopy();
        startingCharacters = charactersShown;
        startedAt = view.performance.now();
        frame = view.requestAnimationFrame(
          charactersShown < fullText.length ? typeInstruction : showNextControl,
        );
      }

      /** A click first finishes the sentence, then advances to the next rule or example. */
      function advanceDialogue(event) {
        if (!event.target.closest('[data-tutorial-dialogue-next]')) return;
        event.preventDefault();
        if (charactersShown < fullText.length) {
          view.cancelAnimationFrame(frame);
          charactersShown = fullText.length;
          updateCopy();
          showNextControl();
        } else if (dialogueIndex < messages.length - 1) {
          dialogueIndex++;
          charactersShown = 0;
          lastControlKey = '';
          pointer.hidden = true;
          showMessage();
        }
      }
      showMessage();
      root.addEventListener('click', advanceDialogue);
      document.addEventListener('scroll', positionPointer, true);
      document.addEventListener('toggle', positionPointer, true);
      view.addEventListener('resize', positionPointer);
      unmount = () => {
        active = false;
        view.cancelAnimationFrame(frame);
        root.removeEventListener('click', advanceDialogue);
        document.removeEventListener('scroll', positionPointer, true);
        document.removeEventListener('toggle', positionPointer, true);
        view.removeEventListener('resize', positionPointer);
        pointer.remove();
      };
    },
  };
}
