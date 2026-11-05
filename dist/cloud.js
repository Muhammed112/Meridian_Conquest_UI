import { aiConfig } from './ai-config.js';
import {
  COMMENTARY_VERSION,
  CommentaryQueue,
  commentaryContext,
  createGeminiGenerator,
  recentCommentaryTasks,
  applyCommentary,
} from './commentary.js?v=match-commentary-20261026-1';
import { createRoomService } from './rooms.js';
import { firebaseConfig } from './firebase-config.js';
import { normalizeNickname } from './profile.js';
import { createSpectatorService } from './spectators.js?v=live-presence-20261104-1';
import { CampaignStore } from './campaign-store.js';
import { buildGameSummary } from './game-summary.js';

export const cloudEnabled = Boolean(firebaseConfig?.projectId);
/** Compose account-scoped persistence, narration and sharing using an injectable Firebase SDK. */
export async function connectCloud({
  onSession,
  onCommentary,
  onError,
  onProfile = () => {},
  onAIStatus = () => {},
  onLoadState = () => {},
  onShareError = () => {},
  onSharingExpired = () => {},
  onCampaignState = () => {},
  config = firebaseConfig,
  aiSettings = aiConfig,
  loadSDK,
  loadTimeout = 30000,
}) {
  if (!config?.projectId) return null;
  const base = 'https://www.gstatic.com/firebasejs/13.0.0/';
  const [appSDK, authSDK, dbSDK] = await Promise.all(
    ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map((file) =>
      loadSDK ? loadSDK(file) : import(base + file),
    ),
  );
  const app = appSDK.initializeApp(config),
    auth = authSDK.getAuth(app);
  // Configure persistence before restoring an account or allowing sign-in.
  // Refreshes keep the session; closing its tab/window clears the sign-in.
  await authSDK.setPersistence(auth, authSDK.browserSessionPersistence);
  const db = dbSDK.getFirestore(app);
  const { collection, doc, onSnapshot, getDoc, runTransaction, serverTimestamp } = dbSDK;
  let user = null,
    ready = false,
    queue = Promise.resolve(),
    stops = [],
    generation = 0;
  const campaigns = new CampaignStore({ db, sdk: dbSDK, timeout: loadTimeout });
  const generateCommentary = createGeminiGenerator({ app, base, settings: aiSettings, loadSDK });
  let preparation = null;
  const savedReports = new Map();
  const spectators = createSpectatorService({
    db,
    sdk: dbSDK,
    getUser: () => user,
    onExpired: onSharingExpired,
  });
  let preference = true;
  try {
    preference = globalThis.localStorage?.getItem('meridian-ai-commentary') !== 'off';
  } catch {
    // Optional storage or browser capability is unavailable; retain the fallback.
  }
  // Reports live outside immutable facts; room members read one shared report per event.
  const reportRef = (task) =>
    task.roomCode
      ? doc(db, 'rooms', task.roomCode, 'aiReportsV2', task.eventId)
      : doc(db, 'users', task.uid, 'games', task.gameId, 'aiReportsV2', task.eventId);
  const narrator = new CommentaryQueue({
    enabled: Boolean(aiSettings.enabled && preference),
    generate: generateCommentary,
    lookup: async (task) => {
      if (user?.uid !== task.uid) return null;
      const snap = await getDoc(reportRef(task));
      return snap.exists() ? snap.data() : null;
    },
    persist: async (task, text) => {
      if (user?.uid !== task.uid) return null;
      return runTransaction(db, async (tx) => {
        const ref = reportRef(task),
          snap = await tx.get(ref);
        if (user?.uid !== task.uid) return null;
        // Another request may have finished first; retain its report instead of overwriting it.
        if (snap.exists()) return snap.data();
        const result = {
          eventId: task.eventId,
          eventType: task.context.event.type,
          text,
          status: 'ready',
          source: 'gemini',
          model: aiSettings.model,
          narrationVersion: COMMENTARY_VERSION,
          authorUid: task.uid,
          createdAt: serverTimestamp(),
        };
        tx.set(ref, result);
        return result;
      });
    },
    onReport: (task, result) => {
      if (user?.uid === task.uid && !task.roomCode) onCommentary(task.gameId, task.eventId, result);
    },
    onStatus: onAIStatus,
  });
  const service = {
    get user() {
      return user;
    },
    get ready() {
      return ready;
    },
    reload: () => loadAccount(user),
    /** Use Firebase Authentication for sign-in, account creation or password-reset delivery. */
    async authenticate(kind, values) {
      const email = String(values.get('email') || '').trim(),
        password = String(values.get('password') || '');
      if (kind === 'reset') return authSDK.sendPasswordResetEmail(auth, email);
      if (kind === 'signup') {
        const nickname = normalizeNickname(values.get('name'));
        const result = await authSDK.createUserWithEmailAndPassword(auth, email, password);
        await authSDK.updateProfile(result.user, { displayName: nickname });
        if (user?.uid === result.user.uid) onProfile(result.user);
        return result;
      }
      return authSDK.signInWithEmailAndPassword(auth, email, password);
    },
    signOut: () => {
      spectators.setPlayingGame(null);
      return authSDK.signOut(auth);
    },
    /** Update only the current account profile and reject stale account-change results. */
    async updateNickname(value) {
      const nickname = normalizeNickname(value),
        account = user;
      if (!account) throw new Error('Sign in to save your player nickname.');
      await authSDK.updateProfile(account, { displayName: nickname });
      if (user?.uid !== account.uid)
        throw new Error('Your account changed. Sign in again to update your nickname.');
      onProfile(account);
      return nickname;
    },
    commentary: narrator,
    spectators,
    /** Summarise a supplied replay on demand without changing commentary settings or saved facts. */
    async summarizeGame(game) {
      if (!user || !ready) throw new Error('Sign in and wait for your campaign to load.');
      if (!aiSettings.enabled) throw new Error('AI summaries are unavailable in this setup.');
      const token = generation,
        uid = user.uid,
        facts = buildGameSummary(game);
      const summary = await generateCommentary.summarize(facts);
      if (token !== generation || uid !== user?.uid)
        throw new Error('Your account changed. Please try again.');
      return summary;
    },
    /** Queue recent unnarrated facts; callers enforce owner or multiplayer-host access. */
    requestCommentary(game, { roomCode } = {}) {
      if (!user || !ready) throw new Error('Sign in and wait for your campaign to load.');
      service.setCommentaryEnabled(true);
      const tasks = recentCommentaryTasks(game, { uid: user.uid, roomCode });
      narrator.enqueue(tasks, { retry: true });
      return tasks.length;
    },
    setCommentaryEnabled(value) {
      try {
        globalThis.localStorage?.setItem('meridian-ai-commentary', value ? 'on' : 'off');
      } catch {
        // Optional storage or browser capability is unavailable; retain the fallback.
      }
      narrator.setEnabled(Boolean(aiSettings.enabled && value));
      if (value) void service.prepareCommentary();
    },
    campaignState: (id) => campaigns.state(id),
    restoreCommentary(game) {
      for (const event of game.events)
        applyCommentary(event, savedReports.get(game.id + '/' + event.id));
    },
    /** Read only the selected history; a failure leaves every other campaign available. */
    async openCampaign(id, options) {
      const token = generation;
      const pending = campaigns.open(id, options);
      onCampaignState(id, campaigns.state(id));
      try {
        const game = await pending;
        if (token !== generation) return null;
        if (game) subscribe(id, token);
        return game;
      } finally {
        if (token === generation) onCampaignState(id, campaigns.state(id));
      }
    },
    /** Warm model/attestation and cached sign-in tokens without generating a report. */
    prepareCommentary() {
      if (!user || !ready || !narrator.enabled) return Promise.resolve();
      preparation ??= Promise.all([user.getIdToken?.(), generateCommentary.prepare()]).catch(() => {
        preparation = null;
      });
      return preparation;
    },
    /** Serialize local snapshots; compare-and-set prevents a second device overwriting a save. */
    save(games) {
      if (!user || !ready) return Promise.resolve();
      const uid = user.uid,
        token = generation;
      // Capture this save now; later game mutations must not change a queued database write.
      const snapshot = JSON.parse(JSON.stringify(games));
      const task = queue
        .catch(() => {})
        .then(async () => {
          let firstError;
          for (const game of snapshot) {
            if (token !== generation) return;
            try {
              const events = await campaigns.save(game);
              if (token !== generation) return;
              narrator.enqueue(
                events.map((event) => ({
                  key: game.id + '/' + event.id,
                  uid,
                  gameId: game.id,
                  eventId: event.id,
                  context: commentaryContext(game, event),
                })),
              );
              if (campaigns.state(game.id).status === 'ready') subscribe(game.id, token);
              await spectators.publish(game).catch(onShareError);
            } catch (error) {
              if (token !== generation) return;
              firstError ??= error;
              onCampaignState(game.id, campaigns.state(game.id));
            }
          }
          if (firstError) throw firstError;
        });
      queue = task;
      return task;
    },
  };
  const watched = new Set();
  /** Restore validated board summaries only; histories remain lazy and individually retryable. */
  async function loadAccount(next) {
    // Every account load invalidates the previous account's subscriptions and async results.
    const token = ++generation;
    ready = false;
    user = next;
    preparation = null;
    narrator.reset();
    savedReports.clear();
    campaigns.reset(next?.uid || null);
    stops.forEach((stop) => stop());
    stops = [];
    watched.clear();
    spectators.reset();
    onLoadState({ status: 'loading' });
    onSession(next, [], false);
    if (!next) {
      ready = true;
      onSession(null, [], true);
      onLoadState({ status: 'ready' });
      return;
    }
    // Sharing restores independently so a failed public-copy query never blocks private saves.
    void spectators.restore().catch(onShareError);
    try {
      const { games, issues } = await campaigns.list();
      if (token !== generation) return;
      ready = true;
      onSession(next, games, true);
      onLoadState({ status: issues.length ? 'partial' : 'ready', issues });
    } catch (error) {
      if (token !== generation) return;
      onLoadState({ status: 'error', error });
      onError(error);
    }
  }
  authSDK.onAuthStateChanged(auth, loadAccount, (error) => {
    onLoadState({ status: 'error', error });
    onError(error);
  });
  /** Subscribe once per campaign/session, retaining support for earlier narration collections. */
  function subscribe(id, token = generation) {
    const key = token + '/' + id;
    if (watched.has(key)) return;
    watched.add(key);
    for (const source of ['commentary', 'aiReports', 'aiReportsV2'])
      stops.push(
        onSnapshot(
          collection(db, 'users', user.uid, 'games', id, source),
          (snapshot) => {
            if (token !== generation) return;
            for (const change of snapshot.docChanges())
              if (change.type !== 'removed') {
                const result = {
                  ...change.doc.data(),
                  narrationVersion: source === 'aiReportsV2' ? COMMENTARY_VERSION : 0,
                };
                savedReports.set(id + '/' + change.doc.id, result);
                onCommentary(id, change.doc.id, result);
              }
          },
          onError,
        ),
      );
  }
  service.rooms = createRoomService({
    db,
    sdk: dbSDK,
    getUser: () => user,
    onEvents: (code, room, game, events) => {
      // Only the host submits model requests; friends consume the room's stored narration.
      if (user?.uid !== room.hostUid) return;
      narrator.enqueue(
        events.map((event) => ({
          key: 'room/' + code + '/' + event.id,
          uid: user.uid,
          roomCode: code,
          eventId: event.id,
          context: commentaryContext(game, event),
        })),
      );
    },
  });
  return service;
}
