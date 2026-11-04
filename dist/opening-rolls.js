/** Draw an unbiased opening die without consuming combat or animation randomness. */
export function openingDie(source = globalThis.crypto) {
  // A complete multiple of six avoids favouring lower faces through modulo arithmetic.
  let value;
  do value = source.getRandomValues(new Uint8Array(1))[0];
  while (value >= 252);
  return (value % 6) + 1;
}

/** Wait for every eligible participant before identifying the highest opening rolls. */
export function openingLeaders(initiative) {
  if (!initiative || initiative.contenders.some((id) => !initiative.rolls[id])) return [];
  const highest = Math.max(...initiative.contenders.map((id) => initiative.rolls[id]));
  return initiative.contenders.filter((id) => initiative.rolls[id] === highest);
}

/** Preview the existing seat rotation only after the opening draw has one winner. */
export function openingTurnOrder(initiative) {
  if (!initiative?.winner) return [];
  const first = initiative.players.indexOf(initiative.winner);
  return first < 0
    ? []
    : [...initiative.players.slice(first), ...initiative.players.slice(0, first)];
}

/** Keep a tied round unresolved until its leaders have completed a tie-break. */
function finishOpeningRound(initiative) {
  const leaders = openingLeaders(initiative);
  return { ...initiative, winner: leaders.length === 1 ? leaders[0] : '' };
}

/** Roll automatic seats immediately and leave individually controlled seats waiting for a click. */
export function createOpeningRolls(players, humanPlayers = [], roll = openingDie) {
  return finishOpeningRound({
    players: [...players],
    contenders: [...players],
    rolls: Object.fromEntries(players.map((id) => [id, humanPlayers.includes(id) ? 0 : roll()])),
    round: 1,
    winner: '',
  });
}

/** Record one eligible player's die without changing an earlier result or the supplied state. */
export function recordOpeningRoll(initiative, id, face = openingDie()) {
  if (!initiative?.contenders.includes(id))
    throw new Error('You are not waiting to roll in this round.');
  if (initiative.winner || initiative.rolls[id])
    throw new Error('You have already rolled this round.');
  if (!Number.isInteger(face) || face < 1 || face > 6) throw new Error('Invalid opening die.');
  return finishOpeningRound({ ...initiative, rolls: { ...initiative.rolls, [id]: face } });
}

/** Reroll tied leaders only; eliminated participants keep their displayed result. */
export function rerollOpeningLeaders(initiative, humanPlayers = [], roll = openingDie) {
  const contenders = openingLeaders(initiative);
  if (contenders.length < 2) throw new Error('A completed tied round is required.');
  const rolls = { ...initiative.rolls };
  for (const id of contenders) rolls[id] = humanPlayers.includes(id) ? 0 : roll();
  return finishOpeningRound({
    ...initiative,
    contenders,
    rolls,
    round: initiative.round + 1,
  });
}
