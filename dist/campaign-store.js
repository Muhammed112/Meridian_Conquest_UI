import {
  campaignRecord,
  readCampaignRecord,
  eventRecord,
  readEventRecord,
  factualEvent,
} from './game-schema.js';
import { committedHistory } from './campaign-history.js';

const failure = (code, message) => Object.assign(new Error(message), { code });
// Legacy saves have no revision, so timestamp and payload remain part of conflict detection.
const sameVersion = (left, right) =>
  !left || !right
    ? left === right
    : (left.saveRevision || 0) === (right.saveRevision || 0) &&
      left.updatedAt === right.updatedAt &&
      left.payload === right.payload;

/** Own account-scoped database records, lazy history reads and optimistic save preconditions. */
export class CampaignStore {
  #db;
  #sdk;
  #timeout;
  #uid = null;
  #session = 0;
  #entries = new Map();
  #storedEvents = new Set();

  constructor({ db, sdk, timeout = 30000 }) {
    this.#db = db;
    this.#sdk = sdk;
    this.#timeout = timeout;
  }

  /** Invalidate unfinished reads/writes before assigning the next account's record cache. */
  reset(uid) {
    this.#uid = uid;
    this.#session++;
    this.#entries.clear();
    this.#storedEvents.clear();
  }

  state(id) {
    const entry = this.#entries.get(id);
    return Object.freeze({ status: entry?.status || 'ready', error: entry?.error || null });
  }

  // Promises cannot be cancelled reliably; a generation check prevents stale cache updates.
  #current(session) {
    if (session !== this.#session)
      throw failure('campaign/session-changed', 'The signed-in account changed.');
  }

  /** Bound a database read without treating a timeout as permission to overwrite saved data. */
  async #read(target, read = this.#sdk.getDocs) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(failure('deadline-exceeded', 'Campaign loading timed out.')),
        this.#timeout,
      );
    });
    return Promise.race([read(target), deadline]).finally(() => clearTimeout(timer));
  }

  /** Validate each board independently; keep malformed records untouched and report their IDs. */
  async list() {
    const session = this.#session;
    const result = await this.#read(this.#sdk.collection(this.#db, 'users', this.#uid, 'games'));
    this.#current(session);
    const games = [],
      issues = [];
    for (const record of result.docs) {
      const id = record.id || record.ref.path.split('/').at(-1);
      const raw = record.data();
      try {
        const game = { ...readCampaignRecord(raw), events: [] };
        if (game.id !== id) throw new Error('The campaign ID does not match its saved document.');
        this.#entries.set(id, { ref: record.ref, raw, game, status: 'unloaded' });
        games.push(game);
      } catch (error) {
        this.#entries.set(id, { ref: record.ref, raw, status: 'error', error });
        issues.push(id);
      }
    }
    return { games: games.sort((a, b) => b.updatedAt - a.updatedAt), issues };
  }

  /** Read bounded history pages only when a campaign is opened. */
  async #history(entry, session) {
    const sdk = this.#sdk;
    const records = [];
    let cursor;
    do {
      const constraints = [sdk.orderBy('sequence')];
      const paged = typeof sdk.limit === 'function' && typeof sdk.startAfter === 'function';
      if (paged) constraints.push(sdk.limit(250));
      if (cursor) constraints.push(sdk.startAfter(cursor));
      const page = await this.#read(sdk.query(sdk.collection(entry.ref, 'events'), ...constraints));
      this.#current(session);
      for (const document of page.docs) {
        const record = document.data();
        // Resolve the committed branch before parsing payloads from interrupted uploads.
        const id = document.id || record.event?.id || readEventRecord(record).id;
        records.push({ ...record, event: { id }, source: record });
      }
      if (!paged || page.docs.length < 250) break;
      cursor = page.docs.at(-1);
    } while (cursor);
    const codes = new Set(entry.game.countries.map((country) => country.code));
    const selected = committedHistory(records, entry.raw.historyHead);
    const ids = new Set();
    const events = selected.map((record) => {
      const event = readEventRecord(record.source, codes);
      if (event.id !== record.event.id)
        throw new Error('This campaign event does not match its saved document.');
      if (ids.has(event.id)) throw new Error('This campaign history contains repeated events.');
      ids.add(event.id);
      return event;
    });
    for (const record of records) this.#storedEvents.add(entry.game.id + '/' + record.event.id);
    entry.ids = ids;
    return events;
  }

  /** Share an in-flight read and keep failures local to the selected campaign. */
  async open(id, { retry = false } = {}) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (entry.status === 'ready') return structuredClone(entry.game);
    if (entry.status === 'loading') return entry.promise;
    if (entry.status === 'error' && !retry) throw entry.error;
    const session = this.#session;
    entry.status = 'loading';
    entry.promise = (async () => {
      try {
        if (retry) {
          const snapshot = await this.#read(entry.ref, this.#sdk.getDoc);
          this.#current(session);
          if (!snapshot.exists()) throw new Error('This campaign is no longer available.');
          const raw = snapshot.data();
          entry.raw = raw;
          entry.game = { ...readCampaignRecord(raw), events: [] };
        }
        const events = await this.#history(entry, session);
        entry.game = { ...entry.game, events };
        entry.status = 'ready';
        entry.error = null;
        return structuredClone(entry.game);
      } catch (error) {
        if (session === this.#session) {
          entry.status = 'error';
          entry.error = error;
        }
        throw error;
      }
    })();
    return entry.promise;
  }

  /** Stage immutable facts, then atomically commit their head only if the board is unchanged. */
  async save(game) {
    const session = this.#session;
    const sdk = this.#sdk;
    const entry = this.#entries.get(game.id);
    if (entry && entry.status !== 'ready') return [];
    const expected = entry?.raw || null;
    const pending = game.events.filter((event) => !entry?.ids?.has(event.id));
    const board = campaignRecord(game);
    if (expected && board.payload === expected.payload && !pending.length) return [];
    if (expected?.historyHead && !game.events.some((event) => event.id === expected.historyHead))
      throw failure(
        'campaign/conflict',
        'This campaign changed elsewhere. Reload its saved version.',
      );
    const target = sdk.doc(this.#db, 'users', this.#uid, 'games', game.id);
    const uploads = game.events.flatMap((event, index) => {
      const key = game.id + '/' + event.id;
      if (this.#storedEvents.has(key)) return [];
      const context = {
        event: factualEvent(event),
        previousBoard: game.events[index - 1]?.board || null,
        countries: game.countries.map(({ code, name }) => ({ code, name })),
        recent: game.events
          .slice(Math.max(0, index - 3), index)
          .map(({ type, text }) => ({ type, text })),
      };
      return [
        {
          key,
          event,
          data: {
            ...eventRecord(event, index, game, context),
            previousEventId: game.events[index - 1]?.id || null,
          },
        },
      ];
    });
    // Stage below Firestore's batch limit. An interrupted upload does not advance historyHead.
    for (let offset = 0; offset < uploads.length; offset += 400) {
      this.#current(session);
      const batch = sdk.writeBatch(this.#db);
      const part = uploads.slice(offset, offset + 400);
      for (const item of part) batch.set(sdk.doc(target, 'events', item.event.id), item.data);
      await batch.commit();
      this.#current(session);
      for (const item of part) this.#storedEvents.add(item.key);
    }
    const record = {
      ...board,
      saveRevision: (expected?.saveRevision || 0) + 1,
      historyHead: game.events.at(-1)?.id || null,
    };
    // The board and its committed event head advance together, after every event is durable.
    try {
      await sdk.runTransaction(this.#db, async (transaction) => {
        const snapshot = await transaction.get(target);
        this.#current(session);
        if (!sameVersion(expected, snapshot.exists() ? snapshot.data() : null))
          throw failure(
            'campaign/conflict',
            'This campaign changed elsewhere. Reload its saved version.',
          );
        transaction.set(target, record);
      });
    } catch (error) {
      if (error.code === 'campaign/conflict' && session === this.#session)
        this.#entries.set(game.id, {
          ...entry,
          ref: target,
          raw: expected,
          status: 'conflict',
          error,
        });
      throw error;
    }
    this.#current(session);
    this.#entries.set(game.id, {
      ref: target,
      raw: record,
      game: structuredClone(game),
      status: 'ready',
      ids: new Set(game.events.map((event) => event.id)),
    });
    return pending;
  }
}
