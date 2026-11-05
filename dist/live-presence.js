import { createRecordId } from './engine.js';
import { timestampMilliseconds } from './live-sharing.js';

const heartbeatMilliseconds = 30000;
const expiryMilliseconds = 75000;
const observationMilliseconds = 5000;

/** Send best-effort per-tab presence only while an owner is playing an explicitly shared game. */
export function createLivePresence({
  db,
  sdk,
  getUser,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  createSessionId = createRecordId,
  eventTarget = globalThis.window,
  now = Date.now,
  onActivity = () => {},
}) {
  let current = null,
    desiredGame = null,
    hidden = false,
    listening = false;
  const supported = ['doc', 'setDoc', 'serverTimestamp', 'orderBy', 'limit'].every(
    (name) => typeof sdk[name] === 'function',
  );

  /** Each visit has its own write queue, so an offline game cannot block a later stream. */
  function sessionFor(gameId, ownerUid) {
    return {
      id: createSessionId(),
      gameId,
      ownerUid,
      pending: false,
      queue: Promise.resolve(),
      lastActivityWrite: -Infinity,
      activityPending: false,
    };
  }

  /** Batch real input into at most one lease renewal per heartbeat; idle heartbeats do not renew. */
  function renewActivity(session) {
    if (current !== session || !session.activityPending || getUser()?.uid !== session.ownerUid)
      return;
    session.activityPending = false;
    session.lastActivityWrite = now();
    Promise.resolve()
      .then(() => {
        if (current === session && getUser()?.uid === session.ownerUid)
          return onActivity(session.gameId);
      })
      .catch(() => {
        // Activity tracking is best effort and must never block a player's next move.
      });
  }

  function playerInput() {
    if (!current) return;
    current.activityPending = true;
    if (now() - current.lastActivityWrite >= heartbeatMilliseconds) renewActivity(current);
  }

  /** Keep departure after any in-flight heartbeat; obsolete queued heartbeats cannot revive a tab. */
  function write(session, online) {
    if (online && session.pending) return;
    if (online) session.pending = true;
    session.queue = session.queue
      .catch(() => {})
      .then(() => {
        if (getUser()?.uid !== session.ownerUid || (online && current !== session)) return;
        return sdk.setDoc(sdk.doc(db, 'liveGames', session.gameId, 'presence', session.id), {
          ownerUid: session.ownerUid,
          online,
          updatedAt: sdk.serverTimestamp(),
        });
      })
      .catch(() => {
        // Older rules and temporary network failures must never interrupt playing or sharing.
      })
      .finally(() => {
        if (online) session.pending = false;
      });
  }

  /** Retain an offline record so viewers can distinguish departure from unsupported presence. */
  function leave() {
    if (!current) return;
    const previous = current;
    current = null;
    clearInterval(previous.timer);
    write(previous, false);
  }

  /** A fresh session ID isolates re-entry from delayed writes belonging to an earlier visit. */
  function reconcile() {
    const uid = getUser()?.uid;
    if (current?.gameId === desiredGame && current?.ownerUid === uid && !hidden) return;
    leave();
    if (!desiredGame || !uid || hidden || !supported) return;
    try {
      current = sessionFor(desiredGame, uid);
      const session = current;
      write(session, true);
      session.timer = setInterval(() => {
        write(session, true);
        renewActivity(session);
      }, heartbeatMilliseconds);
    } catch {
      // Missing browser capabilities should degrade to unknown, without affecting the campaign.
      leave();
    }
  }

  function pageHidden() {
    hidden = true;
    leave();
  }
  function pageShown() {
    hidden = false;
    reconcile();
  }

  return {
    /** Sharing from a campaign card records inactivity without disturbing another active game. */
    markOffline(id) {
      const uid = getUser()?.uid;
      if (!supported || !uid || typeof id !== 'string' || !/^[\w-]{1,60}$/.test(id)) return;
      try {
        write(sessionFor(id, uid), false);
      } catch {
        // Public sharing stays usable when presence is unavailable in an older browser.
      }
    },
    /** Null cancels the heartbeat; pagehide also attempts a final write before browser shutdown. */
    setPlayingGame(id) {
      desiredGame = typeof id === 'string' && /^[\w-]{1,60}$/.test(id) ? id : null;
      if (eventTarget?.addEventListener && Boolean(desiredGame) !== listening) {
        const method = desiredGame ? 'addEventListener' : 'removeEventListener';
        eventTarget[method]('pagehide', pageHidden);
        eventTarget[method]('pageshow', pageShown);
        for (const name of ['pointerdown', 'keydown', 'wheel'])
          eventTarget[method](name, playerInput, { passive: true });
        listening = Boolean(desiredGame);
      }
      reconcile();
    },
  };
}

/** Observe independent tabs so leaving one browser cannot hide another active session. */
export function watchLivePresence({
  db,
  sdk,
  gameId,
  onPresence,
  now = Date.now,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
}) {
  let records = [],
    previous,
    stopped = false,
    timer,
    unsubscribe;
  function emit(status) {
    if (stopped || previous === status) return;
    previous = status;
    onPresence(status);
  }
  function evaluate() {
    const time = now();
    const valid = records.filter(
      (record) => typeof record.online === 'boolean' && Number.isFinite(record.updatedAt),
    );
    emit(
      valid.some((record) => record.online && time - record.updatedAt < expiryMilliseconds)
        ? 'online'
        : valid.length
          ? 'offline'
          : 'unknown',
    );
  }
  function failed() {
    records = [];
    emit('unknown');
    clearInterval(timer);
  }
  emit('unknown');
  try {
    if (
      ['collection', 'query', 'orderBy', 'limit', 'onSnapshot'].some(
        (name) => typeof sdk[name] !== 'function',
      )
    )
      return () => {};
    timer = setInterval(evaluate, observationMilliseconds);
    unsubscribe = sdk.onSnapshot(
      sdk.query(
        sdk.collection(db, 'liveGames', gameId, 'presence'),
        sdk.orderBy('updatedAt', 'desc'),
        sdk.limit(10),
      ),
      (snapshot) => {
        if (stopped) return;
        records = snapshot.docs.map((document) => {
          const record = document.data();
          return { online: record.online, updatedAt: timestampMilliseconds(record.updatedAt) };
        });
        evaluate();
      },
      failed,
    );
  } catch {
    failed();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
