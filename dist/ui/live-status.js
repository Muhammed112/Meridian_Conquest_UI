/** Update presence in place so joining/leaving never restarts a spectator's dice or scrolling. */
export function syncLivePresence(root, status) {
  const offline = status === 'offline';
  for (const notice of root.querySelectorAll('[data-live-presence-notice]'))
    notice.hidden = !offline;
  for (const badge of root.querySelectorAll('[data-live-presence-badge]')) {
    badge.textContent = offline ? 'Player left' : 'Live view';
    badge.classList.toggle('is-offline', offline);
  }
}
