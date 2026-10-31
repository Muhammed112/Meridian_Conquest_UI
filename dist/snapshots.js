import { difficultyFor } from './difficulty.js';
import { findCountry } from './data.js';
import { savedCountryPopulation } from './data.js';

export function encodeSnapshot(g) {
  const clean = { ...g, events: g.events.slice(-60) };
  return btoa(unescape(encodeURIComponent(JSON.stringify(clean))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeSnapshot(text) {
  if (!text || text.length > 180000)
    throw new Error('This shared snapshot is missing or too large.');
  const data = JSON.parse(
    decodeURIComponent(escapeBinary(atob(text.replace(/-/g, '+').replace(/_/g, '/')))),
  );
  if (
    !data ||
    !Array.isArray(data.countries) ||
    data.countries.length !== 10 ||
    !Array.isArray(data.events) ||
    !Array.isArray(data.order) ||
    data.order.length !== 10 ||
    new Set(data.order).size !== 10 ||
    data.order.some((n) => !Number.isInteger(n) || n < 0 || n > 9)
  )
    throw new Error('This campaign link is invalid.');
  for (const c of data.countries) {
    const known = findCountry(c.code);
    if (
      !known ||
      !Number.isInteger(c.army) ||
      c.army < 1 ||
      c.army > 100000 ||
      !Number.isInteger(c.owner) ||
      c.owner < 0 ||
      c.owner > 9
    )
      throw new Error('Invalid country in shared snapshot.');
    Object.assign(c, {
      name: known.name,
      flag: known.flag,
      id: known.id,
      lon: known.lon,
      lat: known.lat,
      ...savedCountryPopulation(c),
    });
  }
  if (
    new Set(data.countries.map((c) => c.code)).size !== 10 ||
    !Number.isInteger(data.position) ||
    data.position < 0 ||
    data.position >= 10 ||
    !Number.isInteger(data.round) ||
    data.round < 1
  )
    throw new Error('Invalid turn in shared snapshot.');
  const allowedTypes = new Set([
    'campaign',
    'turn',
    'decision',
    'attack',
    'dice',
    'conquest',
    'reinforce',
    'transfer',
    'elimination',
    'victory',
    'retreat',
    'held',
  ]);
  data.id = /^[a-zA-Z0-9-]{1,60}$/.test(data.id) ? data.id : 'shared-campaign';
  data.name = String(data.name || 'Shared campaign').slice(0, 60);
  data.winner =
    Number.isInteger(data.winner) && data.winner >= 0 && data.winner < 10 ? data.winner : null;
  data.difficulty = difficultyFor(data.difficulty).id;
  data.events = data.events.slice(-60).map((event, i) => ({
    id: `shared-${i}`,
    type: allowedTypes.has(event?.type) ? event.type : 'campaign',
    text: String(event?.text || 'Recorded campaign event').slice(0, 500),
    round: Number.isInteger(event?.round) && event.round > 0 ? event.round : data.round,
    player: Number.isInteger(event?.player) ? event.player : 0,
    at: Number.isFinite(event?.at) ? event.at : Date.now(),
    from: data.countries.some((c) => c.code === event?.from) ? event.from : undefined,
    to: data.countries.some((c) => c.code === event?.to) ? event.to : undefined,
    amount:
      Number.isInteger(event?.amount) && event.amount > 0 && event.amount <= 100000
        ? event.amount
        : undefined,
    attackerLoss:
      Number.isInteger(event?.attackerLoss) &&
      event.attackerLoss >= 0 &&
      event.attackerLoss <= 100000
        ? event.attackerLoss
        : undefined,
    defenderLoss:
      Number.isInteger(event?.defenderLoss) &&
      event.defenderLoss >= 0 &&
      event.defenderLoss <= 100000
        ? event.defenderLoss
        : undefined,
    pairs: Array.isArray(event?.pairs)
      ? event.pairs
          .slice(0, 200)
          .filter(
            (p) =>
              Number.isInteger(p?.a) &&
              p.a >= 1 &&
              p.a <= 6 &&
              Number.isInteger(p?.d) &&
              p.d >= 1 &&
              p.d <= 6,
          )
          .map((p, j) => ({ index: j + 1, a: p.a, d: p.d }))
      : undefined,
    board: data.countries.map((c) => {
      const record = Array.isArray(event?.board)
        ? event.board.find((x) => x?.code === c.code)
        : null;
      return {
        code: c.code,
        owner:
          Number.isInteger(record?.owner) && record.owner >= 0 && record.owner < 10
            ? record.owner
            : c.owner,
        army:
          Number.isInteger(record?.army) && record.army >= 0 && record.army <= 100000
            ? record.army
            : c.army,
      };
    }),
  }));
  if (!data.events.length)
    data.events = [
      {
        id: 'snapshot',
        type: 'campaign',
        text: 'Campaign snapshot received.',
        round: data.round,
        at: Date.now(),
        board: data.countries.map((c) => ({ code: c.code, owner: c.owner, army: c.army })),
      },
    ];
  return data;
}

const escapeBinary = (text) =>
  Array.from(text, (ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
