/** Apply local board choices shared by single-player and multiplayer; never mutate the game. */
export function applyBoardChoice(game, state, seat, action, code) {
  // These are temporary UI choices; confirmation still goes through engine or room validation.
  const own = game.countries.filter((country) => country.owner === seat);
  if (action === 'select-country') {
    const country = game.countries.find((item) => item.code === code);
    if (country) {
      state.selected = code;
      if (!game.battle) state[country.owner === seat ? 'origin' : 'target'] = code;
    }
  } else if (action === 'allocate-plus' || action === 'allocate-minus') {
    if (!own.some((country) => country.code === code)) return false;
    const used = Object.values(state.allocations).reduce((total, amount) => total + amount, 0);
    const change = action === 'allocate-plus' ? Number(used < game.budget) : -1;
    state.allocations[code] = Math.max(0, (state.allocations[code] || 0) + change);
  } else if (action === 'auto-allocate') {
    const strongest = own.slice().sort((a, b) => b.army - a.army)[0];
    if (strongest) state.allocations = { [strongest.code]: game.budget };
  } else if (action === 'transfer') {
    if (game.budget || game.battle || own.length < 2)
      throw new Error('Transfers need two owned countries and a clear planning phase.');
    state.action = 'transfer';
  } else if (action === 'diplomacy') {
    if (game.budget || game.battle || game.winner !== null)
      throw new Error('Diplomacy is available during your planning phase.');
    state.action = 'diplomacy';
  } else if (action === 'planning') state.action = 'planning';
  else return false;
  return true;
}
