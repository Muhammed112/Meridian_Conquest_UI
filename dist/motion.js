import { escapeHTML } from './html.js';
import { colours, commanders } from './data.js';

const latest = (effects, kind) => effects.filter((effect) => effect.kind === kind).at(-1);
const changes = (before, after) =>
  after
    .map((country) => ({
      code: country.code,
      amount: country.army - (before.find((c) => c.code === country.code)?.army ?? country.army),
    }))
    .filter((change) => change.amount !== 0);

export const countryPoint = (country) => [
  ((country.lon + 180) * 960) / 360,
  ((85 - country.lat) * 480) / 143,
];
export const resolveReducedMotion = (choice, systemReduced) =>
  choice === 'full' ? false : choice === 'reduced' ? true : !!systemReduced;
export const DICE_ROLL_DURATION = 1100;
export const rollPending = (frame) =>
  Boolean(frame?.roll && !frame.reduced && frame.roll.age < frame.roll.rollDuration);
// Keep calculated results in the engine, but present the preceding board until
// the cosmetic dice finish. This copy is never saved or passed to game actions.
export function presentationGame(game, frame) {
  if (!rollPending(frame)) return game;
  const roll = frame.roll,
    index = game.events.findIndex((event) => event.id === roll.id);
  return {
    ...game,
    presentationPending: true,
    winner: null,
    lastBattle: null,
    countries: game.countries.map((country) => ({
      ...country,
      ...roll.beforeBoard?.find((item) => item.code === country.code),
    })),
    events: index < 0 ? game.events : game.events.slice(0, index),
    battle: {
      ...(game.battle || game.lastBattle),
      from: roll.from,
      to: roll.to,
      pairs: roll.pairs,
    },
  };
}
export const dicePipPositions = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
// Cosmetic faces use a clock, never random numbers from the battle engine.
export function diceFaceAt(final, age, duration, index = 0) {
  return age >= duration ? final : 1 + ((Math.floor(Math.max(0, age) / 75) * 5 + index * 3) % 6);
}
export function routeGeometry(from, to) {
  const [x1, y1] = countryPoint(from),
    [x2, y2] = countryPoint(to);
  const lift = Math.min(95, 30 + Math.abs(x2 - x1) * 0.08);
  return { x1, y1, cx: (x1 + x2) / 2, cy: Math.max(18, Math.min(y1, y2) - lift), x2, y2 };
}
export function connectionPath(from, to) {
  const { x1, y1, cx, cy, x2, y2 } = routeGeometry(from, to);
  return `M${x1} ${y1}Q${cx} ${cy} ${x2} ${y2}`;
}

// Both moving units and casualty labels use SVG transforms rather than CSS
// motion paths. The same event clock is retained when the board redraws.
export function motionPose(item, time) {
  const progress = Math.max(0, Math.min(1, (time - item.start) / item.duration));
  const visible =
    time >= item.start && time < Math.min(item.start + item.duration, item.until ?? Infinity);
  const opacity = visible ? Math.max(0, Math.min(1, progress / 0.08, (1 - progress) / 0.18)) : 0;
  if (item.kind === 'flight') {
    const t = item.rotate
      ? progress
      : progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const u = 1 - t,
      x = u * u * item.x1 + 2 * u * t * item.cx + t * t * item.x2,
      y = u * u * item.y1 + 2 * u * t * item.cy + t * t * item.y2;
    const angle = item.rotate
      ? (Math.atan2(
          u * (item.cy - item.y1) + t * (item.y2 - item.cy),
          u * (item.cx - item.x1) + t * (item.x2 - item.cx),
        ) *
          180) /
        Math.PI
      : 0;
    return { progress, opacity, x, y, angle, scale: 1 };
  }
  return {
    progress,
    opacity,
    x: item.x || 0,
    y: (item.y || 0) - 24 * progress,
    angle: 0,
    scale: 1 + 0.14 * Math.sin(Math.min(1, progress * 4) * Math.PI),
  };
}

function lossesFor(event, previous) {
  const pairs = event.pairs || [];
  const loss = (field, code, comparison) => {
    if (Number.isInteger(event[field]) && event[field] >= 0) return event[field];
    const before = previous.find((country) => country.code === code),
      after = event.board.find((country) => country.code === code);
    if (before && after) return Math.max(0, before.army - after.army);
    return pairs.filter(comparison).length;
  };
  return {
    attackerLoss: loss('attackerLoss', event.from, (p) => p.a < p.d),
    defenderLoss: loss('defenderLoss', event.to, (p) => p.a > p.d),
  };
}

// Presentation state stays outside the game and its saved event history.
export class MotionDirector {
  constructor({ now = () => performance.now(), reducedMotion = false } = {}) {
    this.now = now;
    this.reducedMotion = reducedMotion;
    this.reset();
  }
  reset() {
    clearTimeout(this.unlockTimer);
    clearTimeout(this.announcementTimer);
    if (this.animationFrame != null) globalThis.cancelAnimationFrame?.(this.animationFrame);
    this.animationFrame = null;
    this.key = null;
    this.cursor = 0;
    this.cursorId = null;
    this.board = [];
    this.replayIndex = null;
    this.effects = [];
    this.lastAnnouncement = null;
  }
  setReducedMotion(value) {
    this.reducedMotion = value;
    if (value) this.effects = [];
  }
  frame(game, { view = 'game', replay = 0, fast = false, watch = false, localPlayer = 0 } = {}) {
    const time = this.now(),
      scale = fast ? 0.5 : 1,
      events = game.events;
    const key = `${view}:${watch ? 'watch' : 'live'}:${game.id}`;
    this.effects = this.effects.filter((effect) => time - effect.startedAt < effect.duration);
    let incoming = [],
      previous = this.board;
    const cursorIndex = this.cursorId
      ? events.findIndex((event) => event.id === this.cursorId)
      : -1;
    const reset = key !== this.key || (view !== 'history' && this.cursorId && cursorIndex < 0);
    if (reset) {
      this.reset();
      this.key = key;
      this.replayIndex = replay;
    } else if (view === 'history' && replay !== this.replayIndex) {
      this.effects = [];
      this.replayIndex = replay;
      incoming = events[replay] ? [events[replay]] : [];
      previous = events[replay - 1]?.board || events[replay]?.board || [];
    } else if (view !== 'history') {
      incoming = events.slice(cursorIndex + 1);
    }
    if (!this.reducedMotion) {
      for (const event of incoming) {
        const base = { id: event.id, startedAt: time, scale };
        const add = (kind, detail, duration) =>
          this.effects.push({ ...base, kind, ...detail, duration });
        if (event.type === 'attack') {
          const origin = event.board.find((country) => country.code === event.from);
          if (origin && origin.army > 1)
            add(
              'attack',
              { from: event.from, to: event.to, amount: origin.army - 1, owner: origin.owner },
              2900 * scale,
            );
        }
        if (event.type === 'dice')
          add(
            'roll',
            {
              from: event.from,
              to: event.to,
              pairs: event.pairs,
              beforeBoard: previous.map((country) => ({ ...country })),
              ...lossesFor(event, previous),
              rollDuration: DICE_ROLL_DURATION * scale,
            },
            DICE_ROLL_DURATION * scale + Math.max(1100, 1700 * scale) + 100,
          );
        if (event.type === 'transfer') {
          const movement = changes(previous, event.board),
            from = movement.find((c) => c.amount < 0),
            to = movement.find((c) => c.amount > 0);
          const source = event.from || from?.code,
            destination = event.to || to?.code;
          const amount =
            Number.isInteger(event.amount) && event.amount > 0 ? event.amount : to?.amount;
          if (source && destination && amount > 0)
            add(
              'transfer',
              {
                from: source,
                to: destination,
                amount,
                owner: event.board.find((country) => country.code === source)?.owner,
              },
              3450 * scale,
            );
        }
        if (event.type === 'reinforce')
          add(
            'reinforce',
            { changes: changes(previous, event.board).filter((c) => c.amount > 0) },
            1400 * scale,
          );
        if (event.type === 'conquest') {
          const roll = latest(this.effects, 'roll');
          const delay =
            roll && roll.to === event.country
              ? Math.max(0, roll.startedAt + roll.rollDuration - time)
              : 0;
          add(
            'capture',
            {
              code: event.country,
              previousOwner: previous.find((c) => c.code === event.country)?.owner,
              owner: event.board.find((c) => c.code === event.country)?.owner,
              delay,
              changes: changes(previous, event.board).filter((c) => c.amount > 0),
            },
            delay + 1400 * scale,
          );
        }
        if (event.type === 'turn')
          add('turn', { player: event.player, round: event.round }, 1650 * scale);
        if (event.type === 'victory') {
          const capture = latest(this.effects, 'capture');
          const delay = capture
            ? Math.max(0, capture.startedAt + capture.delay + 350 * scale - time)
            : 0;
          add('victory', { player: event.player, delay }, delay + 2800 * scale);
        }
        previous = event.board;
      }
    }
    this.cursor = events.length;
    this.cursorId = events.at(-1)?.id;
    this.board =
      events.at(-1)?.board ||
      game.countries.map(({ code, owner, army }) => ({ code, owner, army }));
    const effects = this.effects.map((effect) => ({ ...effect, age: time - effect.startedAt }));
    const event = view === 'history' ? events[replay] : null;
    const recentMovement = effects
      .filter((effect) => ['roll', 'attack', 'transfer'].includes(effect.kind))
      .at(-1);
    const movementRoute = recentMovement
      ? {
          from: recentMovement.from,
          to: recentMovement.to,
          kind: recentMovement.kind === 'transfer' ? 'transfer' : 'attack',
          active: true,
        }
      : null;
    const route =
      view === 'history'
        ? event?.from && event?.to && ['attack', 'dice', 'transfer'].includes(event.type)
          ? {
              from: event.from,
              to: event.to,
              kind: event.type === 'transfer' ? 'transfer' : 'attack',
              active: true,
            }
          : movementRoute
        : game.battle
          ? { from: game.battle.from, to: game.battle.to, kind: 'attack', active: true }
          : movementRoute;
    return {
      effects,
      route,
      roll: latest(effects, 'roll'),
      turn: latest(effects, 'turn'),
      victory: latest(effects, 'victory'),
      reduced: this.reducedMotion,
      playerNames: game.playerNames,
      localPlayer,
    };
  }
  mount(root, frame, { onSettled } = {}) {
    clearTimeout(this.unlockTimer);
    clearTimeout(this.announcementTimer);
    this.animate(root, frame);
    const roll = frame.roll;
    if (rollPending(frame)) {
      const buttons = Array.from(
        root.querySelectorAll(
          '.action-panel button,.board-actions button,.room-control-panel button',
        ),
      );
      const enabled = buttons.filter((button) => !button.disabled);
      for (const button of enabled) button.disabled = true;
      this.unlockTimer = setTimeout(
        () => {
          if (onSettled) onSettled();
          else for (const button of enabled) if (root.contains(button)) button.disabled = false;
        },
        Math.max(1, roll.rollDuration - roll.age),
      );
    }
    const announcement = frame.victory || frame.turn;
    if (announcement && announcement.id !== this.lastAnnouncement) {
      const announce = () => {
        this.lastAnnouncement = announcement.id;
        const node = root.ownerDocument.getElementById('game-announcer');
        const local = announcement.player === (frame.localPlayer ?? 0),
          name = frame.playerNames?.[announcement.player] || commanders[announcement.player];
        if (node)
          node.textContent =
            announcement.kind === 'victory'
              ? `${local ? 'You' : name} ${local ? 'control' : 'controls'} all ten countries.`
              : local
                ? 'Your turn.'
                : `${name}'s turn.`;
      };
      const delay = Math.max(0, (announcement.delay || 0) - (announcement.age || 0));
      if (delay) this.announcementTimer = setTimeout(announce, delay);
      else announce();
    }
  }
  animate(root, frame = null) {
    if (this.animationFrame != null) globalThis.cancelAnimationFrame?.(this.animationFrame);
    this.animationFrame = null;
    const items = Array.from(root.querySelectorAll('[data-motion-kind]')).map((node) => {
      const read = (name, fallback = 0) =>
        node.hasAttribute(`data-motion-${name}`)
          ? Number(node.getAttribute(`data-motion-${name}`))
          : fallback;
      return {
        node,
        kind: node.getAttribute('data-motion-kind'),
        start: read('start'),
        duration: read('duration', 1),
        until: read('until', Infinity),
        html: node.hasAttribute('data-motion-html'),
        rotate: node.hasAttribute('data-motion-rotate'),
        x: read('x'),
        y: read('y'),
        x1: read('x1'),
        y1: read('y1'),
        cx: read('cx'),
        cy: read('cy'),
        x2: read('x2'),
        y2: read('y2'),
      };
    });
    const roll = frame?.roll;
    const dice =
      roll && !frame.reduced
        ? Array.from(root.querySelectorAll('.dice-rolling [data-die-final]')).slice(0, 24)
        : [];
    const trays = roll && !frame.reduced ? Array.from(root.querySelectorAll('.dice-rolling')) : [];
    if (!items.length && !dice.length) return;
    const tick = () => {
      const time = this.now();
      let pending = false;
      if (dice.length) {
        const age = time - roll.startedAt,
          rolling = age < roll.rollDuration;
        dice.forEach((node, index) => {
          const final = Number(node.getAttribute('data-die-final')),
            face = diceFaceAt(final, age, roll.rollDuration, index);
          node.dataset.displayFace = String(face);
          node.setAttribute('aria-label', rolling ? 'Rolling die' : `Die roll ${final}`);
          Array.from(node.querySelectorAll('i')).forEach(
            (pip, i) => (pip.style.opacity = dicePipPositions[face].includes(i) ? '1' : '0'),
          );
        });
        for (const tray of trays) {
          tray.dataset.rolling = String(rolling);
          const status = tray.querySelector('.dice-status-text');
          if (status) status.textContent = rolling ? 'Rolling the dice…' : 'Roll complete';
        }
        if (rolling) pending = true;
      }
      for (const item of items) {
        if (!root.contains(item.node)) continue;
        const pose = motionPose(item, time);
        item.node.style.opacity = String(pose.opacity);
        if (item.html) item.node.style.transform = `translateY(${pose.y}px) scale(${pose.scale})`;
        else
          item.node.setAttribute(
            'transform',
            `translate(${pose.x} ${pose.y}) rotate(${pose.angle}) scale(${pose.scale})`,
          );
        if (time < Math.min(item.start + item.duration, item.until)) pending = true;
      }
      this.animationFrame =
        pending && typeof globalThis.requestAnimationFrame === 'function'
          ? globalThis.requestAnimationFrame(tick)
          : null;
    };
    tick();
  }
}

export function countryMotion(frame, country) {
  const capture = frame?.effects.findLast(
    (effect) => effect.kind === 'capture' && effect.code === country.code,
  );
  const roll = frame?.roll,
    hit =
      roll &&
      ((roll.from === country.code && roll.attackerLoss > 0) ||
        (roll.to === country.code && roll.defenderLoss > 0));
  const style = `--country-fill:${colours[country.owner]}28;--country-stroke:${colours[country.owner]}90;`;
  if (capture)
    return {
      className: 'captured',
      style: `${style}--capture-from:${colours[capture.previousOwner ?? country.owner]}28;--capture-to:${colours[capture.owner ?? country.owner]}28;--capture-delay:${capture.delay - capture.age}ms;--capture-duration:${700 * capture.scale}ms;`,
    };
  if (hit)
    return {
      className: 'impacted',
      style: `${style}--impact-delay:${roll.rollDuration - roll.age}ms;--impact-duration:${420 * roll.scale}ms;`,
    };
  return { className: '', style };
}

export function diceMotion(frame, pairs) {
  const roll = frame?.roll;
  const samePairs =
    roll &&
    (roll.pairs === pairs ||
      (roll.pairs?.length === pairs?.length &&
        roll.pairs.every((pair, index) => pair.a === pairs[index].a && pair.d === pairs[index].d)));
  if (!roll || frame.reduced || !samePairs || roll.age >= roll.rollDuration + 240 * roll.scale)
    return { className: '', style: '' };
  return {
    className: 'dice-rolling',
    style: `--roll-duration:${roll.rollDuration}ms;--roll-offset:${-roll.age}ms;--result-delay:${roll.rollDuration - roll.age}ms;--reveal-duration:${240 * roll.scale}ms;`,
  };
}

function numberLabel(country, amount, delay, scale, offset = 0) {
  if (!country || !amount) return '';
  const [x, y] = countryPoint(country);
  return `<text class="map-delta ${amount > 0 ? 'positive' : 'negative'}" x="${x}" y="${y - 16 - offset}" style="--event-delay:${delay}ms;--float-duration:${1000 * scale}ms">${amount > 0 ? '+' : '−'}${Math.abs(amount)}</text>`;
}

export function casualtyMarkers(frame, country, { roster = false } = {}) {
  if (!frame || frame.reduced) return '';
  const rolls = frame.effects.filter((effect) => effect.kind === 'roll');
  return rolls
    .map((roll, index) => {
      const loss =
        roll.from === country.code
          ? roll.attackerLoss
          : roll.to === country.code
            ? roll.defenderLoss
            : 0;
      if (!loss) return '';
      const next = rolls
        .slice(index + 1)
        .find((effect) => effect.from === country.code || effect.to === country.code);
      const start = roll.startedAt + roll.rollDuration,
        duration = Math.max(1100, 1700 * roll.scale);
      const until = next ? `data-motion-until="${next.startedAt + next.rollDuration}"` : '';
      const timing = `data-motion-kind="label" data-motion-start="${start}" data-motion-duration="${duration}" ${until} data-country="${country.code}" data-loss="${loss}"`;
      if (roster)
        return `<span class="country-loss" ${timing} data-motion-html aria-hidden="true">−${loss}</span>`;
      const [x, y] = countryPoint(country),
        dx = country.code === 'GB' ? -32 : country.lon > 145 ? -30 : 28,
        width = 34 + String(loss).length * 16;
      return `<g class="casualty-marker" ${timing} data-motion-x="${x + dx}" data-motion-y="${y - 25}" transform="translate(${x + dx} ${y - 25})"><rect x="${-width / 2}" y="-15" width="${width}" height="30" rx="10"/><text text-anchor="middle" dominant-baseline="middle" y="1">−${loss}</text></g>`;
    })
    .join('');
}

function flightAttributes(effect, from, to, delay, duration, rotate = false) {
  const geometry = routeGeometry(from, to);
  return `data-motion-kind="flight" data-motion-start="${effect.startedAt + delay}" data-motion-duration="${duration}" ${rotate ? 'data-motion-rotate' : ''} ${Object.entries(
    geometry,
  )
    .map(([key, value]) => `data-motion-${key}="${value}"`)
    .join(' ')} transform="translate(${geometry.x1} ${geometry.y1})"`;
}

function missileMovement(effect, from, to) {
  const duration = effect.kind === 'roll' ? Math.max(350, 550 * effect.scale) : 1000 * effect.scale;
  const delay = effect.kind === 'roll' ? 0 : 180 * effect.scale;
  return `<g class="missile-flight" data-from="${from.code}" data-to="${to.code}" ${flightAttributes(effect, from, to, delay, duration, true)}><path class="missile-trail" d="M-18 0H-65"/><path class="missile-flame" d="M-13-4L-31 0L-13 4Z"/><path class="missile-fins" d="M-9-3L-16-10L-13 0L-16 10L-9 3Z"/><path class="missile-body" d="M-12-4H3L16 0L3 4H-12Z"/><path class="missile-band" d="M2-4V4"/></g>`;
}

function troopMovement(effect, from, to) {
  const { age, scale, amount } = effect;
  if (!Number.isInteger(amount) || amount < 1) return '';
  const attack = effect.kind === 'attack',
    path = connectionPath(from, to);
  const colour = colours[effect.owner ?? from.owner] || colours[0];
  const width = 58 + String(amount).length * 12;
  const soldier = `<circle class="unit-head" cx="0" cy="-6" r="3.1"/><path class="unit-helmet" d="M-4-6a4 4 0 0 1 8 0M-5-5H5"/><path class="unit-body" d="M0-2v7M-5 1l5-2 5 3M-3 4h6"/><path class="unit-step unit-step-left" d="M-1 5l-3 6"/><path class="unit-step unit-step-right" d="M1 5l4 5"/>`;
  const followers = Array.from(
    { length: Math.min(3, amount - 1) },
    (_, i) =>
      `<g class="travelling-unit troop-scout" ${flightAttributes(effect, from, to, (i + 1) * 100 * scale, 2000 * scale)}><g class="unit-symbol"><circle class="unit-disc" r="17"/>${soldier}</g></g>`,
  ).join('');
  const packet = `<g class="travelling-unit troop-packet" ${flightAttributes(effect, from, to, 0, 2000 * scale)}><g class="unit-count-body"><rect class="unit-count-back" x="${-width / 2}" y="-20" width="${width}" height="40" rx="19"/><g class="unit-count-icon" transform="translate(${-width / 2 + 19} 0)">${soldier}</g><text class="troop-count" x="${-width / 2 + 38}" y="7">${amount}</text></g></g>`;
  return `<g class="troop-movement ${attack ? 'attack' : 'transfer'}" data-troop-count="${amount}" data-from="${from.code}" data-to="${to.code}" style="--unit-colour:${colour};--march-duration:${300 * scale}ms;--march-delay:${-age}ms"><path class="troop-route" d="${path}" style="--event-delay:${-age}ms;--flight-duration:${2400 * scale}ms"/>${followers}${packet}</g>`;
}

export function mapEffects(frame, countries) {
  if (!frame || frame.reduced) return '';
  const country = (code) => countries.find((c) => c.code === code);
  const markup = frame.effects
    .map((effect) => {
      const { age, scale } = effect;
      if (effect.kind === 'roll')
        return (
          (country(effect.from) && country(effect.to)
            ? missileMovement(effect, country(effect.from), country(effect.to))
            : '') +
          [
            [effect.from, effect.attackerLoss],
            [effect.to, effect.defenderLoss],
          ]
            .map(([code, loss]) => {
              const c = country(code);
              if (!c || !loss) return '';
              const [x, y] = countryPoint(c),
                delay = effect.rollDuration - age;
              return `<circle class="battle-impact-ring" cx="${x}" cy="${y}" r="8" style="--event-delay:${delay}ms;--impact-duration:${460 * scale}ms"/>`;
            })
            .join('')
        );
      if (effect.kind === 'transfer' || effect.kind === 'attack') {
        const from = country(effect.from),
          to = country(effect.to);
        if (!from || !to) return '';
        const labels =
          effect.kind === 'transfer'
            ? `<g class="transfer-deltas" style="--movement-colour:${colours[effect.owner ?? from.owner]}">${numberLabel(from, -effect.amount, -age, scale)}${numberLabel(to, effect.amount, 1850 * scale - age, scale)}</g>`
            : '';
        return `${troopMovement(effect, from, to)}${effect.kind === 'attack' ? missileMovement(effect, from, to) : ''}${labels}`;
      }
      if (effect.kind === 'reinforce')
        return effect.changes
          .map((change) => numberLabel(country(change.code), change.amount, -age, scale))
          .join('');
      if (effect.kind === 'capture') {
        const c = country(effect.code);
        if (!c) return '';
        const [x, y] = countryPoint(c),
          delay = effect.delay - age;
        return `<circle class="capture-ring" cx="${x}" cy="${y}" r="8" style="--event-delay:${delay}ms;--capture-duration:${1000 * scale}ms"/>${effect.changes.map((change) => numberLabel(country(change.code), change.amount, delay + 250 * scale, scale, 14)).join('')}`;
      }
      return '';
    })
    .join('');
  return `<g class="map-effects" aria-hidden="true">${markup}${countries.map((c) => casualtyMarkers(frame, c)).join('')}</g>`;
}

export function mapOverlay(frame) {
  if (!frame || frame.reduced) return '';
  const turn = frame.turn,
    victory = frame.victory,
    local = frame.localPlayer ?? 0;
  const name = (player) => escapeHTML(frame.playerNames?.[player] || commanders[player]);
  const turnBanner =
    turn && !victory
      ? `<div class="turn-banner ${turn.player === local ? 'human-turn' : ''}" style="--banner-duration:${turn.duration}ms;--event-delay:${-turn.age}ms" aria-hidden="true"><span class="turn-banner-dot" style="background:${colours[turn.player]}"></span>${turn.player === local ? 'Your turn' : `${name(turn.player)} takes command`}<span class="turn-round">ROUND ${turn.round}</span></div>`
      : '';
  if (!victory) return turnBanner;
  const delay = victory.delay - victory.age;
  const confetti = Array.from(
    { length: 30 },
    (_, i) =>
      `<i style="left:${5 + ((i * 37) % 90)}%;--drift:${((i * 43) % 150) - 75}px;--twist:${(i % 2 ? 1 : -1) * (180 + i * 29)}deg;--confetti-delay:${delay + (i % 6) * 35 * victory.scale}ms;--confetti-duration:${2100 * victory.scale}ms;background:${[colours[victory.player], '#D4AF37', '#E9CD76'][i % 3]}"></i>`,
  ).join('');
  return `<div class="victory-overlay" style="--victory-delay:${delay}ms;--victory-duration:${2800 * victory.scale}ms" aria-hidden="true"><div class="victory-halo"></div><div class="confetti-field">${confetti}</div><div class="victory-banner"><span>Meridian Conquest</span><strong>${victory.player === local ? 'The world is yours.' : `${name(victory.player)} prevails.`}</strong><span>10 countries · 1 commander</span></div></div>`;
}

export function turnMotion(frame) {
  const turn = frame?.turn;
  return turn && !frame.reduced
    ? {
        className: 'turn-enter',
        style: `--turn-duration:${550 * turn.scale}ms;--turn-offset:${-turn.age}ms;`,
      }
    : { className: '', style: '' };
}

export function victoryMotion(frame) {
  const victory = frame?.victory;
  return victory && !frame.reduced
    ? {
        className: 'victory-map',
        style: `--victory-delay:${victory.delay - victory.age}ms;--zoom-duration:${1600 * victory.scale}ms;`,
      }
    : { className: '', style: '' };
}
