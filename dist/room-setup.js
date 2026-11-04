import { catalogue, findCountry } from './data.js';
import {
  openingDie,
  openingLeaders,
  createOpeningRolls,
  recordOpeningRoll,
  rerollOpeningLeaders,
} from './opening-rolls.js?v=opening-dice-20261104-1';

export { openingDie, openingLeaders };

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject malformed shared setup data before it reaches lobby markup or the game engine. */
export function validateRoomSetup(room) {
  if (room.setupVersion === undefined) return room;
  const choices = room.countryChoices;
  if (
    room.setupVersion !== 1 ||
    !Array.isArray(room.memberIds) ||
    !room.memberIds.length ||
    room.memberIds.length > 10 ||
    new Set(room.memberIds).size !== room.memberIds.length ||
    !isRecord(choices) ||
    Object.entries(choices).some(
      ([id, code]) => !room.memberIds.includes(id) || !findCountry(code),
    ) ||
    new Set(Object.values(choices)).size !== Object.keys(choices).length
  )
    throw new Error('This room contains invalid country selections.');
  const setup = room.initiative;
  if (room.status === 'lobby' || room.status === 'closed') {
    if (setup !== null) throw new Error('This lobby contains invalid opening dice.');
    return room;
  }
  if (
    !isRecord(setup) ||
    !Array.isArray(setup.players) ||
    setup.players.length !== 10 ||
    setup.players.some((id, seat) => id !== (room.memberIds[seat] || 'bot:' + seat)) ||
    !Array.isArray(setup.countries) ||
    setup.countries.length !== 10 ||
    new Set(setup.countries).size !== 10 ||
    setup.countries.some(
      (code, seat) =>
        !findCountry(code) ||
        (seat < room.memberIds.length && choices[room.memberIds[seat]] !== code),
    ) ||
    !Array.isArray(setup.contenders) ||
    !setup.contenders.length ||
    new Set(setup.contenders).size !== setup.contenders.length ||
    setup.contenders.some((id) => !setup.players.includes(id)) ||
    !isRecord(setup.rolls) ||
    Object.keys(setup.rolls).length !== 10 ||
    setup.players.some(
      (id) => !Number.isInteger(setup.rolls[id]) || setup.rolls[id] < 0 || setup.rolls[id] > 6,
    ) ||
    !Number.isInteger(setup.round) ||
    setup.round < 1 ||
    setup.round > 100000 ||
    (setup.winner !== '' &&
      (openingLeaders(setup).length !== 1 || openingLeaders(setup)[0] !== setup.winner))
  )
    throw new Error('This room contains invalid opening dice.');
  return room;
}

/** Reserve one unique country through the room transaction; other members keep their choices. */
export function chooseRoomCountry(room, uid, country) {
  if (room.status !== 'lobby' || !room.memberIds.includes(uid))
    throw new Error('Choose your country before the opening rolls begin.');
  if (!catalogue.some((item) => item.code === country)) throw new Error('Choose a valid country.');
  const choices = room.countryChoices || {};
  if (Object.entries(choices).some(([member, code]) => member !== uid && code === country))
    throw new Error('That country has already been chosen.');
  return {
    ...room,
    setupVersion: 1,
    countryChoices: { ...choices, [uid]: country },
    initiative: null,
    revision: room.revision + 1,
    updatedAt: Date.now(),
  };
}

/** Lock selected countries and fill empty seats with distinct countries and automatic bot rolls. */
export function prepareRoomRolls(room, uid, roll = openingDie) {
  if (uid !== room.hostUid) throw new Error('Only the host can begin the opening rolls.');
  if (room.status !== 'lobby') throw new Error('The opening rolls have already begun.');
  const countries = room.memberIds.map((id) => room.countryChoices?.[id]);
  if (countries.some((code) => !catalogue.some((country) => country.code === code)))
    throw new Error('Every player must choose a country first.');
  if (new Set(countries).size !== countries.length) throw new Error('Countries must be unique.');
  const available = catalogue
    .filter((country) => !countries.includes(country.code))
    .map((country) => ({ code: country.code, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort);
  countries.push(...available.slice(0, 10 - countries.length).map((country) => country.code));
  const players = Array.from({ length: 10 }, (_, seat) => room.memberIds[seat] || 'bot:' + seat);
  const initiative = {
    countries,
    ...createOpeningRolls(players, room.memberIds, roll),
  };
  return {
    ...room,
    setupVersion: 1,
    status: 'rolling',
    initiative,
    revision: room.revision + 1,
    updatedAt: Date.now(),
  };
}

/** Record a member's one opening roll; a transaction retry cannot replace an existing roll. */
export function rollRoomInitiative(room, uid, face = openingDie()) {
  validateRoomSetup(room);
  const setup = room.initiative;
  if (room.status !== 'rolling' || !room.memberIds.includes(uid))
    throw new Error('You are not waiting to roll in this round.');
  return {
    ...room,
    initiative: recordOpeningRoll(setup, uid, face),
    revision: room.revision + 1,
    updatedAt: Date.now(),
  };
}

/** Only tied leaders reroll, including bots; the previous result remains visible until requested. */
export function rerollRoomInitiative(room, uid, roll = openingDie) {
  validateRoomSetup(room);
  if (room.status !== 'rolling' || room.hostUid !== uid)
    throw new Error('Only the host can open a tie-break round.');
  return {
    ...room,
    initiative: rerollOpeningLeaders(room.initiative, room.memberIds, roll),
    revision: room.revision + 1,
    updatedAt: Date.now(),
  };
}
