import { validateGameBoard, validateGameEvent } from './game-schema.js';
import { normalizeCampaignCountries } from './country-compatibility.js';
import { createLivePresence, watchLivePresence } from './live-presence.js';
import {
  LIVE_SHARE_IDLE_MS,
  timestampMilliseconds,
  liveShareExpiresAt,
  isLiveShareFresh,
} from './live-sharing.js';

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
export function createSpectatorService({
  db,
  sdk,
  getUser,
  presenceOptions = {},
  leaseOptions = {},
  onExpired = () => {},
}) {
  const {
    now = Date.now,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
  } = leaseOptions;
  const active = new Set();
  // Keep successful remote writes separate from optimistic clicks so failures remain retryable.
  const confirmedShares = new Set();
  const sharingChanges = new Map();
  const confirmedExpiry = new Map(),
    leases = new Map(),
    lastPayload = new Map(),
    expired = new Set();
  const presence = createLivePresence({
    db,
    sdk,
    getUser,
    ...presenceOptions,
    onActivity: activity,
  });
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
  function cancelLease(id) {
    clearTimeout(leases.get(id)?.timer);
    leases.delete(id);
  }
  function expireShare(id) {
    const hadShare = active.has(id) || confirmedShares.has(id);
    cancelLease(id);
    active.delete(id);
    confirmedShares.delete(id);
    confirmedExpiry.delete(id);
    lastPayload.delete(id);
    expired.add(id);
    beginSharingChange(id);
    syncPlaying();
    if (hadShare) onExpired(id);
  }
  /** Check the shared document before ending a lease another owner tab may have renewed. */
  function armLease(id, expiresAt, session = currentSession()) {
    cancelLease(id);
    const entry = { expiresAt, session, timer: null };
    leases.set(id, entry);
    const current = () => leases.get(id) === entry && isCurrentSession(session);
    const schedule = () => {
      entry.timer = setTimeout(check, Math.max(0, entry.expiresAt - now()));
      entry.timer?.unref?.();
    };
    async function check() {
      if (!current()) return;
      if (entry.expiresAt > now()) return schedule();
      try {
        const read = sdk.getDocFromServer ?? sdk.getDoc,
          snapshot = typeof read === 'function' ? await read(target(id)) : null;
        if (!current()) return;
        const record = snapshot?.exists() ? snapshot.data() : null;
        if (record?.ownerUid === session.uid && isLiveShareFresh(record, now())) {
          confirmedExpiry.set(id, liveShareExpiresAt(record));
          armLease(id, liveShareExpiresAt(record), session);
          return;
        }
      } catch {
        // A failed freshness check cannot extend public access beyond its last known deadline.
      }
      if (current()) expireShare(id);
    }
    schedule();
  }
  const hasFreshLease = (id) => (leases.get(id)?.expiresAt ?? -Infinity) > now();
  function confirmPublication(id, session) {
    confirmedShares.add(id);
    const expiresAt = now() + LIVE_SHARE_IDLE_MS;
    confirmedExpiry.set(id, expiresAt);
    if (active.has(id)) armLease(id, expiresAt, session);
  }
  /** Only the latest action may restore controls after a failed request. */
  function restoreConfirmedShare(id, change) {
    if (!isLatestChange(id, change)) return;
    if (confirmedShares.has(id)) {
      if (!(confirmedExpiry.get(id) > now())) return expireShare(id);
      active.add(id);
      armLease(id, confirmedExpiry.get(id));
    } else {
      active.delete(id);
      cancelLease(id);
    }
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
  function publish(game, explicit = false) {
    const id = game.id,
      payload = spectatorPayload(game);
    return write(async (session) => {
      if (!active.has(id) || (!explicit && (!hasFreshLease(id) || lastPayload.get(id) === payload)))
        return;
      await sdk.setDoc(target(id), {
        version: 1,
        ownerUid: session.uid,
        gameId: id,
        payload,
        updatedAt: sdk.serverTimestamp(),
      });
      if (isCurrentSession(session) && (explicit || !expired.has(id))) {
        if (explicit) expired.delete(id);
        lastPayload.set(id, payload);
        confirmPublication(id, session);
      }
    });
  }
  /** Real owner input renews a current share without rewriting its campaign snapshot. */
  function activity(id) {
    if (
      typeof sdk.updateDoc !== 'function' ||
      playingGame !== id ||
      !active.has(id) ||
      !hasFreshLease(id)
    )
      return Promise.resolve();
    return write(async (session) => {
      if (playingGame !== id || !active.has(id) || !hasFreshLease(id)) return;
      await sdk.updateDoc(target(id), { updatedAt: sdk.serverTimestamp() });
      if (isCurrentSession(session) && !expired.has(id)) confirmPublication(id, session);
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
      for (const id of leases.keys()) cancelLease(id);
      confirmedExpiry.clear();
      lastPayload.clear();
      expired.clear();
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
        const data = record.data();
        if (
          data.ownerUid !== uid ||
          sharingChanges.has(record.id) ||
          !isLiveShareFresh(data, now())
        )
          continue;
        active.add(record.id);
        confirmedShares.add(record.id);
        if (typeof data.payload === 'string') lastPayload.set(record.id, data.payload);
        confirmedExpiry.set(record.id, liveShareExpiresAt(data));
        armLease(record.id, liveShareExpiresAt(data));
      }
      syncPlaying();
    },
    /** Opt in only if the first publication succeeds; keep existing shares retryable. */
    async start(game) {
      const id = game.id,
        change = beginSharingChange(id);
      cancelLease(id);
      active.add(id);
      try {
        await publish(game, true);
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
      return active.has(game.id) && hasFreshLease(game.id) ? publish(game) : Promise.resolve();
    },
    activity,
    /**
     * Disable automatic publication before deleting the mirror, restoring retry controls on
     * failure.
     */
    stop(id) {
      const change = beginSharingChange(id);
      // Disable publication immediately so already queued saves cannot recreate a revoked share.
      active.delete(id);
      cancelLease(id);
      syncPlaying();
      return write(async (session) => {
        await sdk.deleteDoc(target(id));
        if (isCurrentSession(session)) {
          confirmedShares.delete(id);
          confirmedExpiry.delete(id);
          lastPayload.delete(id);
        }
      }).catch((error) => {
        restoreConfirmedShare(id, change);
        throw error;
      });
    },
    /** Observe one public game; a missing document signals revoked sharing. */
    watch(id, onChange, onError, onPresence = () => {}) {
      let stopped = false,
        timer,
        newest = -Infinity,
        deadline = NaN,
        showingExpired = false;
      function showExpired() {
        if (stopped || showingExpired) return;
        showingExpired = true;
        onChange(null, { expired: true });
      }
      function scheduleExpiry() {
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            if (stopped) return;
            if (deadline > now()) scheduleExpiry();
            else showExpired();
          },
          Math.max(0, deadline - now()),
        );
        timer?.unref?.();
      }
      const stopGame = sdk.onSnapshot(
        target(id),
        (snapshot) => {
          if (stopped) return;
          try {
            if (!snapshot.exists()) {
              clearTimeout(timer);
              showingExpired = false;
              onChange(null);
              return;
            }
            const record = snapshot.data(),
              timestamp = timestampMilliseconds(record.updatedAt);
            if (!Number.isFinite(timestamp)) {
              if (newest === -Infinity) showExpired();
              return;
            }
            if (timestamp < newest) return;
            clearTimeout(timer);
            newest = timestamp;
            deadline = liveShareExpiresAt(record);
            if (!isLiveShareFresh(record, now())) return showExpired();
            const game = readSpectatorGame(record.payload);
            showingExpired = false;
            onChange(game);
            scheduleExpiry();
          } catch (error) {
            onError(error);
          }
        },
        (error) => {
          if (stopped) return;
          if (deadline <= now()) showExpired();
          else onError(error);
        },
      );
      const stopPresence = watchLivePresence({
        db,
        sdk,
        gameId: id,
        onPresence,
        ...presenceOptions,
      });
      return () => {
        stopped = true;
        clearTimeout(timer);
        stopGame();
        stopPresence();
      };
    },
  };
}
