/** Public links expire five minutes after their last owner activity. */
export const LIVE_SHARE_IDLE_MS = 5 * 60 * 1000;

export function timestampMilliseconds(value) {
  const milliseconds = typeof value?.toMillis === 'function' ? value.toMillis() : value;
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : NaN;
}

export function liveShareExpiresAt(record) {
  return timestampMilliseconds(record?.updatedAt) + LIVE_SHARE_IDLE_MS;
}

export function isLiveShareFresh(record, now = Date.now()) {
  return liveShareExpiresAt(record) > now;
}
