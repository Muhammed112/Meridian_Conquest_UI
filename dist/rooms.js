import { GameEngine } from './engine.js';
import { commanders } from './data.js';
import { playerNickname } from './profile.js';
import {
  RECORD_VERSION,
  validateGameBoard,
  validateGameEvent,
  eventRecord,
  encodeBoard,
  decodeBoard,
} from './game-schema.js';

export const ROOM_CAPACITY = 10;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode(source = globalThis.crypto) {
  return Array.from(
    source.getRandomValues(new Uint8Array(6)),
    (n) => alphabet[n % alphabet.length],
  ).join('');
}
export function normalizeRoomCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error('Enter a valid six-character room code.');
  return code;
}
const playerName = (user) => playerNickname(user.displayName);
const roomPlayerNames = (room) =>
  Array.from(
    { length: ROOM_CAPACITY },
    (_, seat) =>
      room.members[room.memberIds[seat]]?.name ||
      `Bot ${commanders[seat] === 'You' ? 'Meridian' : commanders[seat]}`,
  );
export function newRoom(code, user, { name = 'Friends campaign', difficulty = 'medium' } = {}) {
  const now = Date.now();
  return {
    code,
    hostUid: user.uid,
    memberIds: [user.uid],
    members: { [user.uid]: { name: playerName(user) } },
    name: String(name).trim().slice(0, 50) || 'Friends campaign',
    difficulty: ['easy', 'medium', 'hard', 'extreme'].includes(difficulty) ? difficulty : 'medium',
    status: 'lobby',
    createdAt: now,
    updatedAt: now,
    revision: 0,
    currentSeat: 0,
    controllerUid: user.uid,
    winnerSeat: -1,
    eventCount: 0,
    payload: '',
  };
}
export function joinRoom(room, user) {
  if (room.memberIds.includes(user.uid)) {
    if (room.status === 'closed') throw new Error('This room has been closed.');
    return room;
  }
  if (room.status !== 'lobby') throw new Error('This match has already started.');
  if (room.memberIds.length >= ROOM_CAPACITY) throw new Error('This room is full.');
  return {
    ...room,
    members: { ...room.members, [user.uid]: { name: playerName(user) } },
    memberIds: [...room.memberIds, user.uid],
    updatedAt: Date.now(),
    revision: room.revision + 1,
  };
}
export function leaveRoom(room, uid) {
  if (room.status !== 'lobby')
    throw new Error('Started matches keep your seat. Use the room code to reconnect.');
  if (!room.memberIds.includes(uid)) throw new Error('You are not in this room.');
  if (uid === room.hostUid)
    return { ...room, status: 'closed', updatedAt: Date.now(), revision: room.revision + 1 };
  const members = { ...room.members };
  delete members[uid];
  return {
    ...room,
    members,
    memberIds: room.memberIds.filter((id) => id !== uid),
    updatedAt: Date.now(),
    revision: room.revision + 1,
  };
}
export function startRoom(room, uid) {
  if (uid !== room.hostUid) throw new Error('Only the host can start the match.');
  if (room.status !== 'lobby') throw new Error('This match has already started.');
  const game = GameEngine.create(room.name, 'ZA', false, room.difficulty);
  game.mode = 'multiplayer';
  game.status = 'active';
  game.playerNames = roomPlayerNames(room);
  game.events = [];
  game.turnStarted = false;
  new GameEngine(game).beginTurn();
  return createRoomUpdate(room, game, game.events);
}
function createRoomUpdate(room, game, events) {
  const currentSeat = game.order[game.position];
  const recentGame = { ...game, events: game.events.slice(-80) };
  return {
    room: {
      ...room,
      status: game.winner === null ? 'playing' : 'finished',
      payload: JSON.stringify(recentGame),
      ...(room.schemaVersion === RECORD_VERSION ? { board: encodeBoard(recentGame) } : {}),
      currentSeat,
      controllerUid: room.memberIds[currentSeat] || room.hostUid,
      winnerSeat: game.winner ?? -1,
      revision: room.revision + 1,
      eventCount: room.eventCount + events.length,
      updatedAt: Date.now(),
    },
    events,
  };
}
// Shared room state comes from other browsers. Validate it before rendering
// and rebuild country labels/geometry from the trusted local catalogue.
export function readRoomGame(room) {
  try {
    return parseRoomGame(room);
  } catch (cause) {
    throw new Error('This room contains invalid game data. Ask the host to create a new room.', {
      cause,
    });
  }
}

function parseRoomGame(room) {
  if (
    room.schemaVersion !== undefined &&
    room.schemaVersion !== 1 &&
    room.schemaVersion !== RECORD_VERSION
  ) {
    throw new Error('This room uses an unsupported game data version.');
  }
  const game =
    room.schemaVersion === RECORD_VERSION
      ? decodeBoard(structuredClone(room.board))
      : validateGameBoard(JSON.parse(room.payload));
  if (
    !Array.isArray(room.memberIds) ||
    !room.members ||
    game.order[game.position] !== room.currentSeat ||
    room.controllerUid !== (room.memberIds[room.currentSeat] || room.hostUid) ||
    (game.winner ?? -1) !== room.winnerSeat ||
    !Array.isArray(game.events) ||
    game.events.length > 80
  )
    throw new Error('The room membership, turn or history does not match its game state.');
  const codes = new Set(game.countries.map((country) => country.code));
  for (const event of game.events) validateGameEvent(event, codes);
  game.playerNames = roomPlayerNames(room);
  game.mode = 'multiplayer';
  return game;
}

export function roomRecord(room) {
  const board = room.payload ? JSON.parse(room.payload) : null;
  return { ...room, schemaVersion: RECORD_VERSION, board: board ? encodeBoard(board) : null };
}
function executeNpcTransfers(engine) {
  for (const move of engine.npcTransfers()) {
    engine.event('decision', move.reason);
    engine.transfer(move.from, move.to, move.amount);
  }
}

export function moveRoom(room, uid, revision, action, values = {}) {
  if (room.status !== 'playing') throw new Error('This match is not active.');
  if (room.revision !== revision)
    throw new Error('The board changed. Review the latest move and try again.');
  if (uid !== room.controllerUid) throw new Error('Wait for your turn.');
  const game = readRoomGame(room),
    engine = new GameEngine(game),
    previousEventCount = game.events.length;
  const bot = engine.current >= room.memberIds.length;
  if (bot) {
    if (action !== 'bot' || uid !== room.hostUid) throw new Error('The host controls bot turns.');
    if (game.budget) {
      const plan = engine.npcReinforcements();
      engine.event('decision', plan.reason);
      engine.reinforce(plan.allocations);
    } else if (game.battle) {
      const plan = engine.npcBattleDecision({ phaseLimit: 30 });
      if (!plan.continue) {
        engine.event('decision', plan.reason);
        engine.stopAttack();
      } else engine.roll();
    } else if (!game.attackUsed) {
      executeNpcTransfers(engine);
      const plan = engine.npcPlan();
      engine.event('decision', plan.reason);
      if (plan.from) engine.startAttack(plan.from.code, plan.to.code);
      else engine.endTurn();
    } else {
      executeNpcTransfers(engine);
      engine.endTurn();
    }
  } else {
    switch (action) {
      case 'reinforce':
        if (!game.budget) throw new Error('There are no reinforcements to deploy.');
        engine.reinforce(values.allocations);
        break;
      case 'transfer':
        engine.transfer(values.from, values.to, values.amount);
        break;
      case 'attack':
        engine.startAttack(values.from, values.to);
        break;
      case 'roll':
        if (!game.battle) throw new Error('No battle is in progress.');
        engine.roll();
        break;
      case 'retreat':
        if (!game.battle) throw new Error('No battle is in progress.');
        engine.stopAttack();
        break;
      case 'end':
        engine.endTurn();
        break;
      default:
        throw new Error('Unknown multiplayer move.');
    }
  }
  return createRoomUpdate(room, game, game.events.slice(previousEventCount));
}
export function createRoomService({ db, sdk, getUser, onEvents = () => {} }) {
  const { doc, collection, runTransaction, onSnapshot } = sdk;
  const user = () => {
    const value = getUser();
    if (!value) throw new Error('Sign in to play with friends.');
    return value;
  };
  const ref = (code) => doc(db, 'rooms', normalizeRoomCode(code));
  const persist = (tx, target, result) => {
    const game = readRoomGame(result.room);
    tx.set(target, roomRecord(result.room));
    for (const [index, event] of result.events.entries())
      tx.set(
        doc(target, 'events', event.id),
        eventRecord(event, result.room.eventCount - result.events.length + index, game),
      );
  };
  return {
    async create(options) {
      const account = user();
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = roomCode(),
          target = ref(code);
        const created = await runTransaction(db, async (tx) => {
          if ((await tx.get(target)).exists()) return false;
          tx.set(target, roomRecord(newRoom(code, account, options)));
          return true;
        });
        if (created) return code;
      }
      throw new Error('Could not reserve a room code. Try again.');
    },
    async join(code) {
      const account = user(),
        target = ref(code);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists()) throw new Error('Room not found. Check the code.');
        const old = snap.data(),
          next = joinRoom(old, account);
        if (next !== old) tx.set(target, next);
      });
      return normalizeRoomCode(code);
    },
    async leave(code) {
      const account = user(),
        target = ref(code);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists()) return;
        tx.set(target, leaveRoom(snap.data(), account.uid));
      });
    },
    async start(code) {
      const account = user(),
        target = ref(code);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists()) throw new Error('Room not found.');
        persist(tx, target, startRoom(snap.data(), account.uid));
      });
    },
    async move(code, revision, action, values) {
      const account = user(),
        target = ref(code);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists()) throw new Error('Room not found.');
        persist(tx, target, moveRoom(snap.data(), account.uid, revision, action, values));
      });
    },
    watch(code, onChange, onError, onReport = () => {}) {
      const account = user(),
        target = ref(code);
      let previousEventCount = null;
      const roomStop = onSnapshot(
        target,
        (snap) => {
          const room = snap.exists() ? snap.data() : null;
          try {
            if (room?.payload) {
              const game = readRoomGame(room);
              if (previousEventCount !== null && room.eventCount > previousEventCount)
                onEvents(
                  code,
                  room,
                  game,
                  game.events.slice(
                    -Math.min(game.events.length, room.eventCount - previousEventCount),
                  ),
                );
              previousEventCount = room.eventCount;
            } else if (room) previousEventCount = room.eventCount;
            onChange(room);
          } catch (error) {
            onError(error);
          }
        },
        onError,
      );
      const reportStops = ['aiReports', 'aiReportsV2'].map((source) =>
        onSnapshot(
          collection(target, source),
          (snapshot) => {
            if (getUser()?.uid !== account.uid) return;
            for (const change of snapshot.docChanges())
              if (change.type !== 'removed')
                onReport(change.doc.id, {
                  ...change.doc.data(),
                  narrationVersion: source === 'aiReportsV2' ? 2 : 0,
                });
          },
          onError,
        ),
      );
      return () => {
        roomStop();
        reportStops.forEach((stop) => stop());
      };
    },
  };
}
