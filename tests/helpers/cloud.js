import assert from 'node:assert/strict';
import { connectCloud } from '../../dist/cloud.js';

/**
 * Exercise the real cloud/store code against isolated documents instead of a Firebase project.
 * This fixture observes account isolation and write ordering; emulator tests verify actual rules.
 */
export async function createCloudFixture({
  persistenceError = null,
  read = async () => ({ docs: [] }),
  loadTimeout = 30000,
  aiSettings = { enabled: false },
  updateProfile = async (account, changes) => Object.assign(account, changes),
} = {}) {
  let session,
    fail = false;
  const writes = [],
    subscriptions = [],
    errors = [],
    sessions = [],
    loadStates = [],
    profiles = [];
  const documents = new Map();
  const sessionPersistence = { type: 'SESSION' },
    authInstance = {},
    db = {};
  const ref = (...segments) => ({
    path: segments
      .filter((item) => item !== db)
      .map((item) => item.path || item)
      .join('/'),
  });
  // Snapshot copies prevent a reader from modifying persisted fixture documents by reference.
  const get = (target) => ({
    exists: () => documents.has(target.path),
    data: () => structuredClone(documents.get(target.path)),
  });
  /** Stage a batch privately so simulated failure cannot leave a partially applied write. */
  function batch() {
    const entries = [];
    return {
      set: (target, value) => entries.push([target.path, value]),
      async commit() {
        if (fail) throw new Error('offline');
        for (const [path, data] of entries) documents.set(path, structuredClone(data));
        writes.push(entries);
      },
    };
  }
  const sdk = {
    initializeApp: () => ({}),
    getAuth: () => authInstance,
    getFirestore: () => db,
    browserSessionPersistence: sessionPersistence,
    async setPersistence(auth, persistence) {
      assert.equal(auth, authInstance);
      assert.equal(persistence, sessionPersistence);
      assert.equal(session, undefined, 'Account restoration must wait for session persistence');
      if (persistenceError) throw persistenceError;
    },
    onAuthStateChanged: (_, callback) => {
      // Tests deliver account changes explicitly to make late-response races reproducible.
      session = callback;
    },
    updateProfile,
    collection: ref,
    doc: ref,
    query: (value) => value,
    orderBy: () => ({}),
    where: () => ({}),
    getDoc: async (target) => get(target),
    async getDocs(target) {
      if (target.path === 'liveGames') return { docs: [] };
      const result = await read(target);
      for (const document of result.docs)
        if (document.ref) documents.set(document.ref.path, document.data());
      return result;
    },
    onSnapshot: (target) => {
      subscriptions.push(target.path);
      return () => {};
    },
    writeBatch: batch,
    async runTransaction(_db, update) {
      // Model the write boundary without claiming to simulate Firestore retry or rule behavior.
      const transaction = batch();
      await update({ get: async (target) => get(target), set: transaction.set });
      await transaction.commit();
    },
  };
  const service = await connectCloud({
    config: { projectId: 'test' },
    aiSettings,
    loadSDK: async () => sdk,
    loadTimeout,
    onSession: (user, games, ready) => sessions.push({ user, games, ready }),
    onProfile: (user) => profiles.push({ uid: user.uid, displayName: user.displayName }),
    onLoadState: (state) => loadStates.push(state),
    onCommentary: () => {},
    onError: (error) => errors.push(error),
  });
  return {
    service,
    sdk,
    documents,
    writes,
    subscriptions,
    errors,
    sessions,
    loadStates,
    profiles,
    login: (uid) => session(uid ? { uid, displayName: 'Original nickname' } : null),
    setFailure: (value) => {
      fail = value;
    },
  };
}
