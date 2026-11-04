import { newRoom } from '../../dist/rooms.js';

/** Recreate a lobby saved before country reservations and opening dice were introduced. */
export function legacyRoom(...args) {
  // Remove only the newer setup fields to reproduce an older lobby without duplicating defaults.
  const {
    setupVersion: _version,
    countryChoices: _choices,
    initiative: _initiative,
    ...room
  } = newRoom(...args);
  return room;
}
