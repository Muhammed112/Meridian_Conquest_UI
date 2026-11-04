// Operator REST helpers keep credentials in memory and preserve untouched Firestore field types.
const invalid = () => {
  throw new Error('Invalid stored record.');
};

/** Decode the ordinary JSON-compatible values used in campaign records. */
function decodeValue(value) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('integerValue' in value) {
    const number = Number(value.integerValue);
    if (!Number.isSafeInteger(number)) invalid();
    return number;
  }
  if ('doubleValue' in value && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  invalid();
}

/** Decode stored fields without exposing document paths or values in error messages. */
export function decodeFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
  );
}

/** Encode only replacement JSON fields; untouched fields remain in the original document. */
function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number' && Number.isFinite(value))
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return { mapValue: { fields: encodeFields(value) } };
  invalid();
}

/** Omit absent optional keys exactly as the application's JSON serializers do. */
export function encodeFields(record) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)]),
  );
}

/** Patch named fields under a revision precondition, preserving every unmentioned field. */
export function patchDocument(document, changes) {
  if (typeof document.updateTime !== 'string' || !document.updateTime) invalid();
  return {
    update: { name: document.name, fields: encodeFields(changes) },
    updateMask: { fieldPaths: Object.keys(changes) },
    currentDocument: { updateTime: document.updateTime },
  };
}

/** Stage immutable event facts only when their newly generated document ID is still unused. */
export function createDocument(name, record) {
  return { update: { name, fields: encodeFields(record) }, currentDocument: { exists: false } };
}

/** Keep commits below both Firestore's write-count and request-size limits. */
export function writeBatches(writes) {
  const batches = [];
  let batch = [],
    bytes = 0;
  for (const write of writes) {
    const size = Buffer.byteLength(JSON.stringify(write));
    if (size > 900000) throw new Error('A stored event exceeds the safe document size.');
    if (batch.length && (batch.length >= 400 || bytes + size > 7000000)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(write);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Read only game collections and write only their records; no authentication/profile API is used. */
export function createFirestoreRecords({ projectId, token, fetcher = fetch }) {
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId || '') || !token)
    throw new Error('Firebase operator configuration is unavailable.');
  const root = `projects/${projectId}/databases/(default)/documents`,
    base = 'https://firestore.googleapis.com/v1/' + root;
  const scoped = (name) => {
    const relative = name?.startsWith(root + '/') ? name.slice(root.length + 1) : '';
    if (
      !/^(?:users\/[^/]+\/games\/[^/]+(?:\/events\/[^/]+)?|rooms\/[^/]+(?:\/events\/[^/]+)?|liveGames\/[^/]+)$/.test(
        relative,
      )
    )
      throw new Error('Stored record is outside the selected game collections.');
  };
  /** Bound every request and report status only, never server text containing private values. */
  async function request(url, body) {
    let response;
    try {
      response = await fetcher(url, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('Firestore request did not complete.');
    }
    if (!response.ok) throw new Error('Firestore request failed (HTTP ' + response.status + ').');
    try {
      return await response.json();
    } catch {
      throw new Error('Firestore returned an unreadable response.');
    }
  }
  return {
    /** Page game documents by their stable resource name, without reading user profiles. */
    async games() {
      const records = [];
      let cursor;
      while (true) {
        const result = await request(base + ':runQuery', {
          structuredQuery: {
            from: [{ collectionId: 'games', allDescendants: true }],
            orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
            limit: 250,
            ...(cursor ? { startAt: { values: [{ referenceValue: cursor }], before: false } } : {}),
          },
        });
        if (!Array.isArray(result)) throw new Error('Firestore returned an invalid query.');
        const page = result.flatMap((entry) => (entry.document ? [entry.document] : []));
        for (const document of page) {
          const relative = document.name?.startsWith(root + '/')
            ? document.name.slice(root.length + 1)
            : '';
          if (/^users\/[^/]+\/games\/[^/]+$/.test(relative)) records.push(document);
        }
        if (page.length < 250) break;
        const next = page.at(-1).name;
        if (next === cursor) throw new Error('Firestore query pagination did not advance.');
        cursor = next;
      }
      return records;
    },
    /** Page a permitted top-level collection or one game's immutable event subcollection. */
    async collection(relative) {
      if (
        !/^(?:rooms|liveGames|users\/[^/]+\/games\/[^/]+\/events|rooms\/[^/]+\/events)$/.test(
          relative,
        )
      )
        throw new Error('Collection is outside the selected game records.');
      const records = [],
        url = base + '/' + relative.split('/').map(encodeURIComponent).join('/');
      let cursor;
      do {
        const query = new URLSearchParams({
            pageSize: '250',
            ...(cursor ? { pageToken: cursor } : {}),
          }),
          result = await request(url + '?' + query);
        const page = result.documents || [];
        for (const document of page) scoped(document.name);
        records.push(...page);
        if (result.nextPageToken && result.nextPageToken === cursor)
          throw new Error('Firestore collection pagination did not advance.');
        cursor = result.nextPageToken;
      } while (cursor);
      return records;
    },
    /** Preconditions make concurrent moves stop the migration rather than overwrite a player. */
    async commit(writes) {
      for (const write of writes) scoped(write.update?.name);
      return request(base + ':commit', { writes });
    },
  };
}
