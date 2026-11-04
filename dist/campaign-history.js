/** Follow the committed history head; interrupted/conflicting uploads remain unreferenced. */
export function committedHistory(records, head) {
  const legacy = records.filter(({ previousEventId }) => previousEventId === undefined);
  if (head === undefined) return legacy;
  if (head === null) return [];
  const byId = new Map(records.map((record) => [record.event.id, record]));
  const seen = new Set();
  const chain = [];
  let next = head;
  while (next !== null) {
    const record = byId.get(next);
    if (!record || seen.has(next))
      throw new Error('This campaign history is incomplete or invalid.');
    seen.add(next);
    chain.unshift(record);
    // Predecessor links began after legacy histories; retain the older ordered prefix once.
    if (record.previousEventId === undefined) {
      return [...legacy.filter((item) => item.sequence < record.sequence), ...chain];
    }
    next = record.previousEventId;
  }
  return chain;
}

/** A recovery cache may extend a cloud history, but must not silently merge competing branches. */
export function extendsHistory(local, remote) {
  return (
    local.length >= remote.length && remote.every((event, index) => event.id === local[index]?.id)
  );
}
