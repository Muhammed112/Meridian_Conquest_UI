import { catalogue, armyValue, conquestReward, commanders, populationReference } from './data.js';
import { NpcStrategy } from './npc-strategy.js';
import { difficultyFor } from './difficulty.js';
import { playerNickname } from './profile.js';
import { normalizeCampaignCountries } from './country-compatibility.js';
import {
  allianceFor,
  betrayalReason,
  changeTrust,
  diplomacyState,
  evaluateAlliance,
  isDiplomacyState,
} from './diplomacy.js';

export const CAMPAIGN_STORAGE_KEY = 'meridian-conquest-ui-v2';
export const LEGACY_CAMPAIGN_STORAGE_KEY = 'meridian-conquest-ui-v1';

/** Merge account saves by ID; prefer local progress when timestamps match. */
export function mergeCampaigns(remote, cached) {
  const merged = new Map(remote.map((game) => [game.id, game]));
  for (const game of Array.isArray(cached) ? cached : [])
    if (!merged.has(game.id) || game.updatedAt >= merged.get(game.id).updatedAt)
      merged.set(game.id, game);
  return [...merged.values()];
}

// Also correct the display of older reports without rewriting saved events.
export function reportText(game, event) {
  return event.type === 'turn' &&
    event.player === 0 &&
    game.mode !== 'multiplayer' &&
    typeof event.text === 'string'
    ? event.text.replace(/^You['’]s turn\b/, 'Your turn')
    : event.text;
}

/** Create a UUID with a cryptographic fallback for HTTP previews lacking randomUUID. */
export function createRecordId(source = globalThis.crypto) {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  // Local HTTP previews may expose getRandomValues without randomUUID.
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Store only the selected campaign collection; storage failure leaves the session usable. */
export class LocalGameRepository {
  constructor(key = CAMPAIGN_STORAGE_KEY) {
    this.key = key;
  }
  load() {
    // The requested clean start removes only the previous campaign collection.
    // New campaigns use v2 and survive subsequent loads. Profile data is separate.
    if (this.key === CAMPAIGN_STORAGE_KEY) {
      try {
        localStorage.removeItem(LEGACY_CAMPAIGN_STORAGE_KEY);
      } catch {
        // Optional storage or browser capability is unavailable; retain the fallback.
      }
    }
    try {
      const games = JSON.parse(localStorage.getItem(this.key)) || null;
      // Resolve country references in memory without making the cache newer than cloud progress.
      return Array.isArray(games)
        ? games.map((game) => {
            try {
              return normalizeCampaignCountries(game);
            } catch {
              // Preserve a damaged record without preventing recovery of unrelated campaigns.
              return game;
            }
          })
        : games;
    } catch {
      return null;
    }
  }
  save(games) {
    try {
      localStorage.setItem(this.key, JSON.stringify(games));
      return true;
    } catch {
      return false;
    }
  }
}

/** Resolve one simultaneous dice phase; injected rolls support deterministic practice and tests. */
export class BattleEngine {
  static resolve(attacker, defender, roll = () => Math.floor(Math.random() * 6) + 1) {
    if (
      ![attacker, defender].every((army) => Number.isInteger(army) && army >= 1 && army <= 100000)
    )
      throw new Error('Combat requires valid whole-number armies.');
    // Both sides roll the smaller fighting force; one attacker always remains as a garrison.
    const count = Math.min(attacker - 1, defender);
    if (count < 1) throw new Error('The attacking country needs at least two soldiers.');
    const pairs = Array.from({ length: count }, (_, i) => ({ index: i + 1, a: roll(), d: roll() }));
    if (
      pairs.some(
        ({ a, d }) => ![a, d].every((face) => Number.isInteger(face) && face >= 1 && face <= 6),
      )
    )
      throw new Error('Dice must contain whole numbers from one to six.');
    return {
      pairs,
      attackerLoss: pairs.filter((p) => p.a < p.d).length,
      defenderLoss: pairs.filter((p) => p.a > p.d).length,
    };
  }
}

/** Apply game rules to one mutable board and record a factual snapshot after each action. */
export class GameEngine {
  #game;

  constructor(game) {
    this.#game = game;
  }
  get game() {
    return this.#game;
  }
  /** Create ten distinct countries and rotate the seat order to choose the first participant. */
  static create(
    name,
    start = 'ZA',
    sample = false,
    difficulty = 'medium',
    nickname = null,
    setup = null,
  ) {
    if (
      setup &&
      (!Array.isArray(setup.countries) ||
        setup.countries.length !== 10 ||
        new Set(setup.countries).size !== 10 ||
        setup.countries.some((code) => !catalogue.some((country) => country.code === code)) ||
        !Number.isInteger(setup.firstSeat) ||
        setup.firstSeat < 0 ||
        setup.firstSeat > 9)
    )
      throw new Error('Invalid multiplayer starting countries or first player.');
    const chosen = catalogue.find((x) => x.code === (setup?.countries[0] || start)) || catalogue[0];
    const others = setup
      ? setup.countries.slice(1).map((code) => catalogue.find((c) => c.code === code))
      : sample
        ? catalogue
            .slice(0, 10)
            .filter((x) => x.code !== chosen.code)
            .slice(0, 9)
        : catalogue
            .filter((x) => x.code !== chosen.code)
            .map((x) => ({ x, r: Math.random() }))
            .sort((a, b) => a.r - b.r)
            .slice(0, 9)
            .map(({ x }) => x);
    if (others.length < 9)
      others.push(
        ...catalogue
          .filter((x) => x.code !== chosen.code && !others.includes(x))
          .slice(0, 9 - others.length),
      );
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    if (!sample) {
      const first = setup?.firstSeat ?? Math.floor(Math.random() * 10);
      order.push(...order.splice(0, first));
    }
    const game = {
      id: createRecordId(),
      name: name.trim() || 'New Meridian',
      start: chosen.code,
      difficulty: difficultyFor(difficulty).id,
      round: 1,
      position: 0,
      order,
      turnStarted: false,
      budget: 0,
      attackUsed: false,
      battle: null,
      winner: null,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      countries: [chosen, ...others].map((c, i) => ({
        ...c,
        owner: i,
        value: armyValue(c.population),
        army: armyValue(c.population),
      })),
    };
    game.populationSource = { ...populationReference };
    if (nickname) game.playerNames = [playerNickname(nickname), ...commanders.slice(1)];
    const engine = new GameEngine(game);
    if (sample) {
      game.round = 3;
      game.countries[0].army = 9;
      game.countries[4].owner = 0;
      game.countries[4].army = 3;
      game.countries[1].army = 4;
      engine.event('campaign', 'A new round begins. Every decision redraws the world.');
      engine.event('conquest', `${game.countries[4].name} is now under your command.`, {
        country: game.countries[4].code,
      });
    }
    engine.beginTurn();
    return game;
  }
  get current() {
    return this.game.order[this.game.position];
  }
  /** Return the countries controlled by a seat, defaulting to the current participant. */
  owned(player = this.current) {
    return this.game.countries.filter((c) => c.owner === player);
  }
  /** Append facts and a fresh board snapshot; AI narration is stored separately. */
  event(type, text, detail = {}) {
    // Carry the latest bounded state forward so a trimmed room history keeps its pacts.
    // Legacy campaigns gain no metadata until their first diplomacy decision.
    const hasDiplomacy = this.game.events.some((entry) => entry.diplomacyState !== undefined);
    if (
      detail.diplomacyState !== undefined &&
      !isDiplomacyState(detail.diplomacyState, this.game.round)
    )
      throw new Error('Invalid diplomacy state cannot be recorded.');
    const state =
      detail.diplomacyState !== undefined
        ? structuredClone(detail.diplomacyState)
        : hasDiplomacy
          ? diplomacyState(this.game)
          : undefined;
    this.game.events.push({
      id: createRecordId(),
      type,
      text,
      round: this.game.round,
      player: this.current,
      at: Date.now(),
      ...detail,
      ...(state === undefined ? {} : { diplomacyState: state }),
      board: this.game.countries.map((c) => ({ code: c.code, owner: c.owner, army: c.army })),
    });
    this.game.updatedAt = Date.now();
  }
  /** Record one pact decision without introducing a new combat or database event type. */
  #diplomacyEvent(action, proposer, target, reason, state, expiresRound) {
    const names = this.game.playerNames || commanders;
    const descriptions = {
      accepted: `${names[target]} accepts a three-round alliance with ${names[proposer]}.`,
      declined: `${names[target]} declines an alliance offer from ${names[proposer]}.`,
      betrayed: `${names[proposer]} breaks the alliance with ${names[target]}.`,
      expired: `The alliance between ${names[proposer]} and ${names[target]} expires.`,
      ended: `The alliance between ${names[proposer]} and ${names[target]} ends.`,
    };
    this.event('decision', `${descriptions[action]} ${reason}`, {
      diplomacy: {
        action,
        proposer,
        target,
        reason,
        ...(expiresRound === undefined ? {} : { expiresRound }),
      },
      diplomacyState: state,
    });
  }
  /** Expiry, elimination and the final two commanders release pacts before the next move. */
  #settleAlliances() {
    const state = diplomacyState(this.game);
    const alive = new Set(this.game.countries.map((country) => country.owner));
    for (const pact of [...state.alliances]) {
      const expired = this.game.round >= pact.expiresRound;
      const eliminated = pact.players.some((player) => !alive.has(player));
      if (!expired && !eliminated && alive.size > 2) continue;
      state.alliances = state.alliances.filter((entry) => entry !== pact);
      const reason = expired
        ? 'The agreed three-round term is complete.'
        : eliminated
          ? 'An allied commander no longer controls a country.'
          : 'Only the allied commanders remain; one commander must control all ten countries.';
      this.#diplomacyEvent(
        expired ? 'expired' : 'ended',
        pact.players[0],
        pact.players[1],
        reason,
        state,
      );
    }
  }
  /** Offer one NPC a three-round pact during the current commander's planning time. */
  proposeAlliance(target, { humanCount = 1 } = {}) {
    const game = this.game;
    if (
      !game.turnStarted ||
      game.winner !== null ||
      game.battle ||
      game.budget ||
      !Number.isInteger(humanCount) ||
      humanCount < 1 ||
      humanCount > 10 ||
      !Number.isInteger(target) ||
      target < humanCount ||
      target > 9 ||
      target === this.current ||
      !this.owned().length ||
      !this.owned(target).length
    )
      throw new Error('Offer an alliance to an active NPC during your planning turn.');
    if (allianceFor(game, this.current) || allianceFor(game, target))
      throw new Error('Each commander can have only one ally at a time.');
    const state = diplomacyState(game);
    if (
      state.lastOffers.some((offer) => offer.player === this.current && offer.round === game.round)
    )
      throw new Error('You can propose only one alliance per turn.');
    const result = evaluateAlliance(game, this.current, target);
    state.lastOffers = state.lastOffers.filter((offer) => offer.player !== this.current);
    state.lastOffers.push({ player: this.current, round: game.round });
    if (result.accepted) {
      state.alliances.push({
        players: [this.current, target],
        startedRound: game.round,
        expiresRound: game.round + 3,
      });
      changeTrust(state, target, this.current, 3);
      changeTrust(state, this.current, target, 3);
    }
    this.#diplomacyEvent(
      result.accepted ? 'accepted' : 'declined',
      this.current,
      target,
      result.reason,
      state,
      result.accepted ? game.round + 3 : undefined,
    );
    return result;
  }
  /** Start a turn once and calculate its round-dependent reinforcement budget. */
  beginTurn() {
    const game = this.game;
    if (game.turnStarted || game.winner !== null) return;
    this.#settleAlliances();
    game.turnStarted = true;
    game.attackUsed = false;
    game.battle = null;
    game.budget = game.round > 1 ? this.owned().length * 2 : 0;
    const text = /* prettier-ignore */ `${(game.playerNames || commanders)[this.current]}'s turn${
      game.budget ? ` · ${game.budget} reinforcements available` : ''
    }.`;
    this.event('turn', reportText(game, { type: 'turn', player: this.current, text }));
  }
  /** Spend the entire reinforcement budget on owned countries before other moves. */
  reinforce(allocations) {
    const game = this.game;
    const owned = this.owned();
    if (
      !allocations ||
      typeof allocations !== 'object' ||
      Array.isArray(allocations) ||
      game.winner !== null ||
      game.battle ||
      game.budget <= 0
    )
      throw new Error('Reinforcements are available only at the start of an active turn.');
    const total = Object.values(allocations).reduce((a, b) => a + Number(b), 0);
    if (
      total !== game.budget ||
      owned.some(
        (c) =>
          !Number.isInteger(allocations[c.code] || 0) ||
          (allocations[c.code] || 0) < 0 ||
          c.army + (allocations[c.code] || 0) > 100000,
      ) ||
      Object.keys(allocations).some((code) => !owned.find((c) => c.code === code))
    )
      throw new Error('Allocate the complete reinforcement budget to your own countries.');
    for (const c of owned) c.army += allocations[c.code] || 0;
    const amount = game.budget;
    game.budget = 0;
    this.event(
      'reinforce',
      /* prettier-ignore */ `${amount} soldiers deployed across ${owned.length} controlled ${
        owned.length === 1 ? 'country' : 'countries'
      }.`,
    );
  }
  /** Move existing soldiers between owned countries while retaining the source garrison. */
  transfer(from, to, amount) {
    const game = this.game;
    const a = game.countries.find((c) => c.code === from),
      b = game.countries.find((c) => c.code === to);
    if (
      game.battle ||
      game.winner !== null ||
      game.budget ||
      !a ||
      !b ||
      a === b ||
      a.owner !== this.current ||
      b.owner !== this.current ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      a.army - amount < 1 ||
      b.army + amount > 100000
    )
      throw new Error('Choose two owned countries and leave at least one soldier behind.');
    a.army -= amount;
    b.army += amount;
    this.event('transfer', `${amount} soldiers moved from ${a.name} to ${b.name}.`, {
      from,
      to,
      amount,
    });
  }
  /** Commit the turn’s single attack target before any dice are rolled. */
  startAttack(from, to) {
    const game = this.game;
    const a = game.countries.find((c) => c.code === from),
      b = game.countries.find((c) => c.code === to);
    if (
      game.budget ||
      game.winner !== null ||
      game.attackUsed ||
      game.battle ||
      !a ||
      !b ||
      a.owner !== this.current ||
      b.owner === this.current ||
      a.army < 2
    )
      throw new Error('Choose an owned country with at least two soldiers and an enemy target.');
    const pact = allianceFor(game, this.current);
    if (pact?.ally === b.owner) {
      const state = diplomacyState(game);
      state.alliances = state.alliances.filter((entry) => !entry.players.includes(this.current));
      changeTrust(state, b.owner, this.current, -35);
      const reason =
        betrayalReason(game, this.current, b.owner) ||
        "Attacking an allied country breaks the pact and damages the defender's trust.";
      this.#diplomacyEvent('betrayed', this.current, b.owner, reason, state);
    }
    game.attackUsed = true;
    game.battle = { from, to, pairs: [], phase: 0, attackerLoss: 0, defenderLoss: 0 };
    this.event('attack', `${a.name} launches an attack on ${b.name}.`, { from, to });
  }
  /** Apply a phase, then resolve conquest, elimination or a defence holding in event order. */
  roll(roll) {
    const game = this.game;
    if (!game.battle) throw new Error('No battle is in progress.');
    const b = game.battle,
      a = game.countries.find((c) => c.code === b.from),
      d = game.countries.find((c) => c.code === b.to);
    const result = BattleEngine.resolve(a.army, d.army, roll);
    a.army -= result.attackerLoss;
    d.army -= result.defenderLoss;
    Object.assign(b, result, { phase: b.phase + 1 });
    this.event(
      'dice',
      `${a.name} loses ${result.attackerLoss}; ${d.name} loses ${result.defenderLoss}.`,
      {
        from: a.code,
        to: d.code,
        pairs: result.pairs,
        attackerLoss: result.attackerLoss,
        defenderLoss: result.defenderLoss,
      },
    );
    // Record the zero-defender dice snapshot before ownership, rewards or victory change it.
    if (d.army === 0) {
      const previous = d.owner,
        reward = conquestReward(d.value);
      d.owner = this.current;
      // The new garrison comes from the conquest reward rather than creating an extra soldier.
      d.army = 1;
      a.army += reward - 1;
      game.battle = null;
      game.lastBattle = { ...b, outcome: 'conquest', reward, country: d.name };
      this.event(
        'conquest',
        `${d.name} conquered. +${reward} soldiers earned; one garrisons the new territory.`,
        { country: d.code, reward },
      );
      if (!this.owned(previous).length)
        this.event(
          'elimination',
          `${(game.playerNames || commanders)[previous]} has been eliminated.`,
        );
      if (this.owned().length === 10) {
        game.winner = this.current;
        game.status =
          game.mode === 'multiplayer' ? 'finished' : this.current === 0 ? 'won' : 'lost';
        this.event(
          'victory',
          `${(game.playerNames || commanders)[this.current]} controls all ten countries.`,
        );
      }
      this.#settleAlliances();
      return { finished: true, conquered: true };
    }
    if (a.army === 1) {
      game.lastBattle = { ...b, outcome: 'held' };
      game.battle = null;
      this.event('held', `${d.name} holds. One soldier remains in ${a.name}.`);
      return { finished: true, conquered: false };
    }
    return { finished: false };
  }
  /** Record a retreat and end the turn while retaining both countries and surviving troops. */
  stopAttack() {
    if (!this.game.battle) return;
    this.event('retreat', 'The attack is stopped. Remaining troops hold their positions.');
    this.game.lastBattle = { ...this.game.battle, outcome: 'stopped' };
    this.game.battle = null;
    this.endTurn();
  }
  /** Advance past eliminated seats, incrementing the round only when the order wraps. */
  endTurn() {
    const game = this.game;
    if (game.winner !== null) return;
    if (game.battle || game.budget)
      throw new Error('Finish the current action before ending your turn.');
    // Eliminated seats stay in the original order but never receive another turn.
    do {
      game.position = (game.position + 1) % game.order.length;
      if (game.position === 0) game.round++;
    } while (!this.owned().length);
    game.turnStarted = false;
    game.lastBattle = null;
    this.beginTurn();
    if (game.mode !== 'multiplayer' && !this.owned(0).length) game.status = 'lost';
  }
  /** Ask the pure strategy module for an attack plan without executing it. */
  npcPlan() {
    return NpcStrategy.attack(this.game, this.current);
  }
  /** Plan a legal allocation using the current reinforcement budget. */
  npcReinforcements() {
    return NpcStrategy.reinforcements(this.game, this.current);
  }
  /** Plan defensive transfers on copied country records, leaving this board untouched. */
  npcTransfers() {
    return NpcStrategy.defenceTransfers(this.game, this.current);
  }
  /** Evaluate whether the active bot should continue its current battle. */
  npcBattleDecision(options) {
    return NpcStrategy.battleDecision(this.game, options);
  }
}
