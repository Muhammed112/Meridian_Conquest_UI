const identityAttributes = [
  'id',
  'name',
  'data-action',
  'data-code',
  'data-room-action',
  'data-report-tab',
  'data-report-control',
  'data-map-country',
  'href',
];

/** Remember an interactive control across redraws without retaining or logging its value. */
export function captureFocus(root) {
  const element = root.ownerDocument.activeElement;
  if (!root.contains(element) || element === root) return null;
  const attributes = identityAttributes
    .filter((name) => element.hasAttribute(name))
    .map((name) => [name, element.getAttribute(name)]);
  if (!attributes.length) return null;
  return {
    tag: element.tagName,
    attributes,
    selection:
      typeof element.selectionStart === 'number'
        ? [element.selectionStart, element.selectionEnd]
        : null,
  };
}

/** Restore the same usable control; keep a surviving control's focus and selection untouched. */
export function restoreFocus(root, saved) {
  if (!saved || root.contains(root.ownerDocument.activeElement)) return;
  const controls = root.querySelectorAll('button,input,select,textarea,a,[tabindex]');
  const matching = [...controls].find(
    (element) =>
      element.tagName === saved.tag &&
      saved.attributes.every(([name, value]) => element.getAttribute(name) === value),
  );
  // After a confirmed action its button may become disabled; move to the next useful control.
  let target = matching?.disabled
    ? matching.closest('.action-panel')?.querySelector('button.btn-primary:not(:disabled)') ||
      matching.closest('.stepper')?.querySelector('button:not(:disabled)')
    : matching;
  if (!target && saved.attributes.some(([name]) => name === 'data-action')) {
    target = root.querySelector('.action-panel h2');
    if (target) target.setAttribute('tabindex', '-1');
  }
  if (target?.closest('[hidden],[inert]')) return;
  target?.focus({ preventScroll: true });
  if (target && saved.selection && typeof target.setSelectionRange === 'function') {
    try {
      target.setSelectionRange(...saved.selection);
    } catch {
      // Number and email inputs expose no selectable text range.
    }
  }
}
