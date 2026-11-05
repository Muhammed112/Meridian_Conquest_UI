import { validateGameBoard, validateGameEvent } from './game-schema.js';
import { normalizeCampaignCountries } from './country-compatibility.js';
import { createLivePresence, watchLivePresence } from './live-presence.js';

const gameFields = [
  'id',
  'name',
  'start',
  'difficulty',
  'round',
  'position',
  'order',
  'turnStarted',
  'budget',
  'attackUsed',
  'winner',
  'status',
  'createdAt',
  'updatedAt',
  'playerNames',
];
const eventFields = [
  'id',
  'type',
  'text',
  'round',
  'player',
  'at',
  'from',
  'to',
  'country',
  'phase',
  'amount',
  'reward',
  'attackerLoss',
  'defenderLoss',
  'commentary',
  'commentaryVersion',
];
const battleFields = [
  'from',
  'to',
  'phase',
  'outcome',
  'country',
  'reward',
  'attackerLoss',
  'defenderLoss',
];
const pick = (source, fields) =>
  Object.fromEntries(
    fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
const board = (countries) => countries.map((country) => pick(country, ['code', 'owner', 'army']));
const pairs = (values) => values.map((pair, index) => ({ index: index + 1, a: pair.a, d: pair.d }));
const battle = (value) =>
  value ? { ...pick(value, battleFields), pairs: pairs(value.pairs || []) } : null;

/** Copy public pact history explicitly so future private negotiation fields never leak. */
function publicDiplomacy(event) {
  const state = event.diplomacyState;
  return {
    ...(state
      ? {
          diplomacyState: {
            alliances: state.alliances.map((alliance) => ({
              ...pick(alliance, ['startedRound', 'expiresRound']),
              players: [...alliance.players],
            })),
            trust: state.trust.map((entry) => pick(entry, ['observer', 'other', 'value'])),
            lastOffers: state.lastOffers.map((entry) => pick(entry, ['player', 'round'])),
          },
        }
      : {}),
    ...(event.diplomacy
      ? {
          diplomacy: pick(event.diplomacy, [
            'action',
            'proposer',
            'target',
            'reason',
            'expiresRound',
          ]),
        }
      : {}),
  };
}

// An explicit public projection prevents account details or future private fields leaking.
function publicGame(game) {
  return {
    ...pick(game, gameFields),
    ...(game.populationSource
      ? {
          populationSource: {
            ...(typeof game.populationSource.source === 'string'
              ? { source: game.populationSource.source }
              : {}),
            ...(Number.isInteger(game.populationSource.year)
              ? { year: game.populationSource.year }
              : {}),
            ...(typeof game.populationSource.fetchedAt === 'string'
              ? { fetchedAt: game.populationSource.fetchedAt }
              : {}),
          },
        }
      : {}),
    countries: game.countries.map((country) =>
      pick(country, ['code', 'owner', 'army', 'population', 'value']),
    ),
    battle: battle(game.battle),
    lastBattle: battle(game.lastBattle),
    events: game.events.slice(-60).map((event) => ({
      ...pick(event, eventFields),
      ...publicDiplomacy(event),
      at: Number.isFinite(event.at) ? event.at : 0,
      board: board(event.board),
      ...(event.pairs ? { pairs: pairs(event.pairs) } : {}),
    })),
  };
}

/** Encode a public allowlist and trim older events to fit the shared-document size limit. */
export function spectatorPayload(game) {
  validateGameBoard(game);
  const codes = new Set(game.countries.map((country) => country.code));
  // Validate nested facts before projecting; stripping fields must not disguise malformed state.
  for (const event of game.events) validateGameEvent(event, codes);
  const shared = publicGame(game);
  let payload = JSON.stringify(shared);
  while (new TextEncoder().encode(payload).length > 500000 && shared.events.length > 1) {
    shared.events.shift();
    payload = JSON.stringify(shared);
  }
  readSpectatorGame(payload);
  return payload;
}

/** Validate public facts and strip arbitrary fields before any visitor renders the board. */
export function readSpectatorGame(payload) {
  if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > 500000)
    throw new Error('This live game is too large or invalid.');
  const game = validateGameBoard(JSON.parse(payload));
  if (!Array.isArray(game.events) || game.events.length > 60)
    throw new Error('Invalid live game history.');
  const codes = new Set(game.countries.map((country) => country.code));
  for (const event of game.events) {
    validateGameEvent(event, codes);
    for (const field of ['from', 'to', 'country'])
      if (event[field] !== undefined && !codes.has(event[field]))
        throw new Error('Invalid country in live event.');
    if (
      ['attack', 'dice'].includes(event.type) &&
      (!codes.has(event.from) || !codes.has(event.to) || event.from === event.to)
    )
      throw new Error('Invalid live battle.');
    if (event.type === 'dice' && (!Array.isArray(event.pairs) || !event.pairs.length))
      throw new Error('Invalid live dice.');
  }
  if (new Set(game.events.map((event) => event.id)).size !== game.events.length)
    throw new Error('Invalid live game history.');
  // Rendering flags and arbitrary fields from public documents are never trusted.
  return normalizeCampaignCountries(validateGameBoard(publicGame(game)));
}

/** Publish owner-authorized copies and provide read-only subscriptions for anonymous visitors. */
export function createSpectatorService({ db, sdk, getUser, presenceOptions = {} }) {
  const active = new Set();
  // Keep successful remote writes separate from optimistic clicks so failures remain retryable.
  const confirmedShares = new Set();
  const sharingChanges = new Map();
  const presence = createLivePresence({ db, sdk, getUser, ...presenceOptions });
  let playingGame = null;
  let generation = 0,
    queue = Promise.resolve();
  const syncPlaying = () => presence.setPlayingGame(active.has(playingGame) ? playingGame : null);
  const target = (id) => {
    if (!/^[\w-]{1,60}$/.test(id || '')) throw new Error('Invalid live game link.');
    return sdk.doc(db, 'liveGames', id);
  };
  const currentSession = () => ({ generation, uid: getUser()?.uid });
  const isCurrentSession = (session) =>
    session.generation === generation && session.uid === getUser()?.uid;
  /** Retain explicit intent until reset so a delayed restoration cannot undo it. */
  function beginSharingChange(id) {
    const change = currentSession();
    sharingChanges.set(id, change);
    return change;
  }
  const isLatestChange = (id, change) =>
    isCurrentSession(change) && sharingChanges.get(id) === change;
  /** Only the latest action may restore controls after a failed request. */
  function restoreConfirmedShare(id, change) {
    if (!isLatestChange(id, change)) return;
    if (confirmedShares.has(id)) active.add(id);
    else active.delete(id);
    syncPlaying();
  }
  /** Serialize sharing/revocation and reject queued work from an earlier account session. */
  function write(task) {
    const session = currentSession();
    if (!session.uid) return Promise.reject(new Error('Sign in to share your campaign.'));
    const next = queue
      .catch(() => {})
      .then(() => {
        if (!isCurrentSession(session)) throw new Error('Your account changed. Please try again.');
        return task(session);
      });
    queue = next;
    return next;
  }
  /** Capture this public board before queueing so later gameplay cannot alter the pending copy. */
  function publish(game) {
    const id = game.id,
      payload = spectatorPayload(game);
    return write(async (session) => {
      if (!active.has(id)) return;
      await sdk.setDoc(target(id), {
        version: 1,
        ownerUid: session.uid,
        gameId: id,
        payload,
        updatedAt: sdk.serverTimestamp(),
      });
      if (isCurrentSession(session)) confirmedShares.add(id);
    });
  }
  return {
    isShared: (id) => active.has(id),
    /** Route changes report owner activity without making private games publicly visible. */
    setPlayingGame(id) {
      playingGame = id;
      syncPlaying();
    },
    /** Forget this account’s opt-ins and invalidate queued writes without deleting shared games. */
    reset() {
      generation++;
      active.clear();
      confirmedShares.clear();
      sharingChanges.clear();
      playingGame = null;
      syncPlaying();
    },
    /** Restore only this owner’s explicit shares after sign-in, ignoring stale reads. */
    async restore(read = sdk.getDocs) {
      const uid = getUser()?.uid,
        token = generation;
      if (!uid) return;
      const records = await read(
        sdk.query(sdk.collection(db, 'liveGames'), sdk.where('ownerUid', '==', uid)),
      );
      if (token !== generation || uid !== getUser()?.uid) return;
      for (const record of records.docs) {
        if (record.data().ownerUid !== uid || sharingChanges.has(record.id)) continue;
        active.add(record.id);
        confirmedShares.add(record.id);
      }
      syncPlaying();
    },
    /** Opt in only if the first publication succeeds; keep existing shares retryable. */
    async start(game) {
      const id = game.id,
        change = beginSharingChange(id);
      active.add(id);
      try {
        await publish(game);
        if (!isLatestChange(id, change)) return;
        syncPlaying();
        if (playingGame !== id) presence.markOffline(id);
      } catch (error) {
        restoreConfirmedShare(id, change);
        throw error;
      }
    },
    /** Update an already shared campaign; ordinary saves never opt a new game in. */
    async publish(game) {
      return active.has(game.id) ? publish(game) : Promise.resolve();
    },
    /**
     * Disable automatic publication before deleting the mirror, restoring retry controls on
     * failure.
     */
    stop(id) {
      const change = beginSharingChange(id);
      // Disable publication immediately so already queued saves cannot recreate a revoked share.
      active.delete(id);
      syncPlaying();
      return write(async (session) => {
        await sdk.deleteDoc(target(id));
        if (isCurrentSession(session)) confirmedShares.delete(id);
      }).catch((error) => {
        restoreConfirmedShare(id, change);
        throw error;
      });
    },
    /** Observe one public game; a missing document signals revoked sharing. */
    watch(id, onChange, onError, onPresence = () => {}) {
      const stopGame = sdk.onSnapshot(
        target(id),
        (snapshot) => {
          try {
            onChange(snapshot.exists() ? readSpectatorGame(snapshot.data().payload) : null);
          } catch (error) {
            onError(error);
          }
        },
        onError,
      );
      const stopPresence = watchLivePresence({
        db,
        sdk,
        gameId: id,
        onPresence,
        ...presenceOptions,
      });
      return () => {
        stopGame();
        stopPresence();
      };
    },
  };
}
