import { escapeHTML } from './html.js';
import { catalogue, colours, findCountry } from './data.js';
import { applyCommentary } from './commentary.js?v=match-commentary-20261026-1';
import {
  normalizeRoomCode,
  readRoomGame,
  roomPlayerNames,
} from './rooms.js?v=opening-order-20261105-1';
import { playerNickname } from './profile.js';
import { updateReportsCommentary } from './ui/reports.js?v=compact-panels-20261105-1';
import { openingLeaders, validateRoomSetup } from './room-setup.js';
import { applyBoardChoice } from './controllers/board-actions.js';
import { NPC_DECISION_DELAY } from './motion.js?v=battle-reveal-20261026-1';
import { renderOpeningTurnOrder } from './ui/opening-order.js?v=opening-order-20261105-1';

/** Own lobby/board interaction and host bot scheduling without changing the shared game rules. */
export function createMultiplayerUI({
  getCloud,
  notify,
  changed,
  renderGame,
  dieView,
  getState,
  presentGame = (game) => game,
  isRolling = () => false,
}) {
  const button = (label, action, disabled = false) => /* HTML */ `<button
      type="button"
      class="btn btn-sm"
      data-room-action="${action}"
      ${disabled ? 'disabled' : ''}
      >${label}</button
    >`;
  let room = null,
    code = '',
    stop = null,
    error = '',
    busy = false,
    attempt = '',
    timer = null,
    active = false,
    uid = null,
    countryQuery = null;
  const account = () => getCloud()?.user;
  const service = () => {
    const cloud = getCloud();
    if (!cloud?.user) throw new Error('Sign in to play with friends.');
    if (!cloud.ready) throw new Error('Your account is still loading. Please try again.');
    return cloud.rooms;
  };
  let parsedRoom = null,
    parsedGame = null;
  // Parse once per room snapshot, then attach separately arriving shared narration by event ID.
  const game = () => {
    if (!room?.payload) return null;
    if (parsedRoom !== room) {
      parsedGame = readRoomGame(room);
      for (const event of parsedGame.events)
        if (reports.has(event.id)) applyCommentary(event, reports.get(event.id));
      parsedRoom = room;
    }
    return parsedGame;
  };
  const seat = () => room?.memberIds.indexOf(account()?.uid) ?? -1;
  const reports = new Map();
  /** Only the host requests shared narration; friends receive the saved reports. */
  function requestCommentary() {
    if (!active || room?.hostUid !== account()?.uid || !game()) return 0;
    return getCloud().requestCommentary(game(), { roomCode: code });
  }
  /** Release listeners, bot timers and parsed state before leaving a room or changing accounts. */
  function disconnect() {
    reports.clear();
    parsedRoom = null;
    parsedGame = null;
    stop?.();
    stop = null;
    clearTimeout(timer);
    timer = null;
    room = null;
    attempt = '';
    countryQuery = null;
  }
  /**
   * Let the host advance bot turns after the reading pause; friends never run a second bot
   * loop.
   */
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (
      active &&
      !busy &&
      room?.status === 'playing' &&
      room.hostUid === account()?.uid &&
      room.currentSeat >= room.memberIds.length
    ) {
      const decision = game()?.events.at(-1);
      timer = setTimeout(
        () => act('bot'),
        decision?.type === 'decision' ? NPC_DECISION_DELAY : 2400,
      );
    }
  }
  /** Join once per account/room and ignore delayed updates from a previous connection. */
  async function connect() {
    const user = account();
    if (uid !== user?.uid) {
      disconnect();
      uid = user?.uid;
    }
    if (!active || !code || !user || !getCloud()?.ready) return;
    const key = user.uid + ':' + code;
    if (attempt === key) return;
    attempt = key;
    const requested = code;
    try {
      await service().join(code);
      if (!active || code !== requested || account()?.uid !== user.uid) return;
      stop = service().watch(
        code,
        (value) => {
          if (!active || code !== requested || account()?.uid !== user.uid) return;
          try {
            if (value) validateRoomSetup(value);
            if (value?.payload) readRoomGame(value);
            room = value;
            const state = getState();
            const current = game();
            if (current && room.hostUid === account()?.uid) void getCloud().prepareCommentary?.();
            // Draft allocations belong to one revision and must not survive another player's move.
            if (current && state.roomRevision !== room.revision) {
              state.allocations = {};
              // Keep the offer result open when this player's diplomacy commit arrives.
              state.action = current.battle
                ? 'battle'
                : state.action === 'diplomacy' && room.currentSeat === seat()
                  ? 'diplomacy'
                  : 'planning';
              state.roomRevision = room.revision;
            }
            error = value ? '' : 'This room no longer exists.';
            changed();
            schedule();
          } catch (failure) {
            clearTimeout(timer);
            error = failure.message;
            changed();
          }
        },
        (failure) => {
          error =
            failure.code === 'permission-denied'
              ? 'You no longer have access to this room.'
              : failure.message;
          changed();
        },
        (eventId, result) => {
          if (
            !active ||
            code !== requested ||
            account()?.uid !== user.uid ||
            result.status !== 'ready' ||
            typeof result.text !== 'string'
          )
            return;
          if ((reports.get(eventId)?.narrationVersion || 0) > (result.narrationVersion || 0))
            return;
          reports.set(eventId, result);
          const event = game()?.events.find((event) => event.id === eventId);
          if (applyCommentary(event, result))
            updateReportsCommentary(document, presentGame(game()));
        },
      );
    } catch (failure) {
      error = failure.message;
      changed();
    }
  }
  /**
   * Reset room controls only when the room route changes, preserving an active connection
   * otherwise.
   */
  function route(next) {
    const nextActive = next !== null,
      nextCode = next || '';
    if (nextActive !== active || nextCode !== code) {
      disconnect();
      error = '';
      busy = false;
    }
    active = nextActive;
    code = nextCode;
    if (active) connect();
  }
  /** Serialize room actions and block gameplay controls until the current dice reveal completes. */
  async function act(action, values = {}) {
    if (
      busy ||
      (isRolling() && !['copy', 'signin', 'retry', 'leave', 'commentary'].includes(action))
    )
      return;
    busy = true;
    changed();
    const target = code;
    try {
      if (action === 'commentary') {
        const count = requestCommentary();
        notify(
          count
            ? 'Gemini commentary requested for recent events.'
            : 'Recent events already have commentary.',
        );
      } else if (action === 'start') await service().start(code);
      else if (['country', 'prepare', 'opening-roll', 'reroll'].includes(action))
        await service().setup(
          code,
          action === 'opening-roll' ? 'roll' : action,
          values.country,
          room.initiative?.round,
        );
      else if (action === 'leave') {
        await service().leave(code);
        location.hash = 'multiplayer';
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(code);
        notify('Room code copied.');
      } else if (action === 'retry') {
        attempt = '';
        await connect();
      } else if (action === 'signin') {
        try {
          sessionStorage.setItem('meridian-room-return', 'multiplayer' + (code ? '/' + code : ''));
        } catch {
          // Optional storage or browser capability is unavailable; retain the fallback.
        }
        location.hash = 'signin';
      } else await service().move(code, room.revision, action, values);
      error = '';
    } catch (failure) {
      error = failure.message;
      notify(error);
    } finally {
      busy = false;
      if (active && code === target) {
        changed();
        schedule();
      }
    }
  }
  /** Convert lobby and move forms to validated service operations with shared busy/error state. */
  async function submit(form) {
    if (busy) return;
    const values = new FormData(form),
      kind = form.dataset.roomForm;
    if (kind === 'create' || kind === 'join') {
      busy = true;
      error = '';
      changed();
      try {
        const destination =
          kind === 'create'
            ? await service().create({
                name: values.get('name'),
                difficulty: values.get('difficulty'),
              })
            : await service().join(normalizeRoomCode(values.get('code')));
        location.hash = 'multiplayer/' + destination;
      } catch (failure) {
        error = failure.message;
      } finally {
        busy = false;
        changed();
      }
      return;
    }
    if (kind === 'country') {
      const input = form.elements.country;
      const query = input.value.trim();
      const country =
        catalogue.find((item) => item.code === query.toUpperCase()) ||
        catalogue.find((item) => item.name.toLowerCase() === query.toLowerCase());
      if (!country || isCountryTaken(country.code)) {
        input.setCustomValidity(
          country
            ? 'That country is already chosen by a friend.'
            : 'Choose a country from the suggestions.',
        );
        input.reportValidity();
        return;
      }
      countryQuery = country.name;
      await act('country', { country: country.code });
      return;
    }
  }
  /** Keep another member's reservation out of both suggestions and local confirmation. */
  function isCountryTaken(countryCode) {
    return Object.entries(room.countryChoices || {}).some(
      ([id, chosen]) => id !== account().uid && chosen === countryCode,
    );
  }

  /** Let the browser filter available suggestions inside the single country field. */
  function countryOptions() {
    return catalogue
      .filter((country) => !isCountryTaken(country.code))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (country) =>
          `<option value="${escapeHTML(country.name)}" label="${country.code}"></option>`,
      )
      .join('');
  }

  /** Display searchable reservations while keeping country confirmation explicit. */
  function countryPicker() {
    const selected = findCountry(room.countryChoices?.[account().uid]);
    return `<form data-room-form="country" class="room-action-form">
      <label for="room-starting-country">Your starting country<input
        id="room-starting-country" class="field" name="country" type="search"
        list="room-country-options" autocomplete="off" placeholder="Search or choose a country"
        value="${escapeHTML(countryQuery ?? selected?.name ?? '')}" required /></label>
      <datalist id="room-country-options">${countryOptions()}</datalist>
      <button type="submit" class="btn btn-primary" ${busy ? 'disabled' : ''}>Confirm country</button></form>`;
  }

  /** Show synchronized opening dice and keep tie breaks separate from combat dice. */
  function openingView() {
    const setup = room.initiative;
    const leaders = openingLeaders(setup);
    const playerNames = roomPlayerNames(room);
    const names = (id) => playerNames[setup.players.indexOf(id)];
    const canRoll = setup.contenders.includes(account().uid) && !setup.rolls[account().uid];
    return `<section class="panel room-opening"><div class="panel-body">
      <div class="eyebrow">Opening dice / Round ${setup.round}</div><h2>Roll for the first turn.</h2>
      <p class="muted">Highest roll starts. Tied leaders reroll; remaining turns follow lobby seat order.</p>
      <div class="room-opening-grid">${setup.players
        .map((id, seat) => {
          const country = findCountry(setup.countries[seat]);
          const face = setup.rolls[id];
          return `<div class="room-seat ${setup.winner === id ? 'opening-winner' : ''}">
          <div><strong>${escapeHTML(names(id))}${id === account().uid ? ' (you)' : ''}</strong>
          <span>${escapeHTML(country.name)}${!setup.contenders.includes(id) ? ' / Out of tie-break' : ''}</span></div>
          ${face ? dieView(face) : '<span class="badge">Waiting to roll</span>'}</div>`;
        })
        .join('')}</div>
      ${canRoll ? button('Roll my die', 'opening-roll', busy) : ''}
      ${
        setup.winner
          ? `<p role="status">${escapeHTML(names(setup.winner))} goes first.</p>`
          : leaders.length > 1
            ? '<p role="status">The highest roll is tied. Only tied leaders roll again.</p>'
            : '<p role="status">Waiting for the remaining players to roll.</p>'
      }
      ${renderOpeningTurnOrder(setup, setup.countries.map(findCountry), names)}
      ${room.hostUid === account().uid && leaders.length > 1 ? button('Begin tie-break', 'reroll', busy) : ''}
      ${room.hostUid === account().uid && setup.winner ? button('Start match', 'start', busy) : ''}
      </div></section>`;
  }
  /** Render lobby, opening rolls or the same board view used by single-player campaigns. */
  function render() {
    const user = account(),
      g = game() ? presentGame(game()) : null;
    const heading = /* HTML */ `<div class="page-heading"
      ><div
        ><div class="eyebrow">Multiplayer / Friends & rivals</div
        ><h1>Share a code. Conquer together.</h1
        ><p>Up to ten friends. Bots fill the remaining countries.</p></div
      ><a href="#campaigns" class="btn btn-sm">My campaigns</a></div
    >`;
    const message = error
      ? /* HTML */ `<div class="notice room-error" role="alert">${escapeHTML(error)}</div>`
      : '';
    if (!user)
      return (
        heading +
        message +
        /* HTML */ `<section class="panel room-signin"
          ><h2>Bring your friends into the war room.</h2
          ><p>Sign in to create a room or join with a six-character code.</p
          >${button('Sign in to play', 'signin')}</section
        >`
      );
    if (!getCloud()?.ready)
      return heading + message + '<div class="notice" role="status">Loading your account?</div>';
    if (!code)
      return (
        heading +
        message +
        /* HTML */ `<div class="notice"
            ><span
              >Playing as <strong>${escapeHTML(playerNickname(user.displayName))}</strong>. Your
              account nickname is used when you create or join a room.</span
            ><button type="button" class="btn btn-sm" data-action="account"
              >Change nickname</button
            ></div
          ><div class="room-entry-grid"
            ><section class="panel"
              ><div class="panel-body"
                ><div class="eyebrow">01 / Host a game</div><h2>Create a room.</h2
                ><p>Share your code, wait for friends, then start with bots.</p
                ><form data-room-form="create" class="room-action-form"
                  ><label
                    >Campaign name<input
                      class="field"
                      name="name"
                      maxlength="50"
                      value="Friends campaign"
                      required /></label
                  ><label
                    >Bot difficulty<select class="field" name="difficulty"
                      ><option value="easy">Easy</option
                      ><option value="medium" selected>Medium</option
                      ><option value="hard">Hard</option
                      ><option value="extreme">Extreme</option></select
                    ></label
                  ><button class="btn btn-primary" ${busy ? 'disabled' : ''}
                    >Create room</button
                  ></form
                ></div
              ></section
            ><section class="panel"
              ><div class="panel-body"
                ><div class="eyebrow">02 / Join your friends</div><h2>Enter a room code.</h2
                ><p>Get the six-character code from your host.</p
                ><form data-room-form="join" class="room-action-form"
                  ><label
                    >Room code<input
                      class="field room-code-input"
                      name="code"
                      minlength="6"
                      maxlength="6"
                      autocapitalize="characters"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="ABC234"
                      required /></label
                  ><button class="btn" ${busy ? 'disabled' : ''}>Join room</button></form
                ></div
              ></section
            ></div
          >`
      );
    if (!room)
      return (
        heading +
        message +
        /* HTML */ `<div class="notice" role="status"
          >${error ? 'Check your code or connection.' : 'Joining room ' + escapeHTML(code) + '?'}
          ${button('Retry', 'retry', busy)} <a href="#multiplayer">Back to rooms</a></div
        >`
      );
    const codeHeader = /* prettier-ignore */ `<div class="room-code-bar"
      ><div><span class="caption">Room code</span><strong>${escapeHTML(code)}</strong></div
      >${button('Copy code', 'copy', busy)}<span class="badge live"
        >${room.memberIds.length} friends / ${10 - room.memberIds.length} bots</span
      >${
        room.status === 'lobby'
            ? button(room.hostUid === user.uid ? 'Close room' : 'Leave lobby', 'leave', busy)
            : '<a href="#multiplayer" class="btn btn-sm">Back to rooms</a>'
      }</div
    >`;
    if (room.status === 'closed')
      return (
        heading +
        codeHeader +
        message +
        ('<div class="notice">The host closed this room. <a' +
          ' href="#multiplayer">Create or join another room.</a></div>')
      );
    if (room.status === 'rolling') return heading + codeHeader + message + openingView();
    if (room.status === 'lobby')
      return (
        heading +
        codeHeader +
        message +
        /* prettier-ignore */ `<div class="room-lobby-grid"
          ><section class="panel"
            ><div class="panel-body"
              ><h2>Gather your commanders.</h2
              ><p class="muted"
                >${room.memberIds.length} of 10 seats filled. Choose your country before the opening rolls.</p
              ><div class="room-seats"
                >${
                  Array.from({ length: 10 }, (_, i) => {
                    const id = room.memberIds[i];
                    return /* prettier-ignore */ `<div class="room-seat ${id ? '' : 'room-bot'}"
                    ><span class="room-seat-number" style="color:${colours[i]}"
                      >${String(i + 1).padStart(2, '0')}</span
                    ><div
                      ><strong>${id ? escapeHTML(room.members[id].name) : 'Bot seat'}</strong
                      ><span
                        >${
                                            id === room.hostUid
                                                ? 'Host'
                                                : id
                                                  ? escapeHTML(catalogue.find((c) => c.code ===
                                                    room.countryChoices?.[id])?.name || 'Choose a country')
                                                  : 'A friend can take this seat before the start'
                                          }</span
                      ></div
                    ><span class="badge">${id ? 'Human' : 'Bot'}</span></div
                  >`;
                  }).join('')
                }</div
              ></div
            ></section
          ><section class="panel"
            ><div class="panel-body"
              ><div class="eyebrow">Your shared campaign</div><h2>${escapeHTML(room.name)}</h2
              >${countryPicker()}<p>${escapeHTML(room.difficulty)} bots / ten countries / one winner</p
              ><p class="muted"
                >Once everyone has joined, the host starts the match. Empty seats become bots. New
                players cannot join after the start.</p
              ><p class="small muted"
                >Keep the host's room open to run bot turns. Rejoin with this code after signing
                back in to recover your seat.</p
              >${
                room.hostUid === user.uid
                    ? /* prettier-ignore */ `<button class="btn btn-primary btn-full" data-room-action="prepare" ${
                                busy || room.memberIds.some((id) => !room.countryChoices?.[id]) ? 'disabled' : ''
                              }>Roll for first turn / ${10 - room.memberIds.length} bots</button>`
                    : '<div class="notice" role="status">Waiting for the host to start.</div>'
              }</div
            ></section
          ></div
        >`
      );
    if (!g) return heading + message;
    return renderGame(g, codeHeader + message);
  }

  return {
    render,
    route,
    /** Preserve typed text across lobby updates; native suggestions need no separate search state. */
    handleInput(input) {
      if (!active || room?.status !== 'lobby' || input.id !== 'room-starting-country') return false;
      countryQuery = input.value;
      input.setCustomValidity('');
      return true;
    },
    requestCommentary,
    sessionChanged: connect,
    get game() {
      return active ? game() : null;
    },
    get active() {
      return active;
    },
    get playerSeat() {
      return seat();
    },
    get isHost() {
      return room?.hostUid === account()?.uid;
    },
    isHuman(player) {
      return player < (room?.memberIds.length || 0);
    },
    get decision() {
      const event = game()?.events.at(-1);
      return event?.type === 'decision' ? event.text : '';
    },
    async handleClick(event) {
      if (!active) return false;
      const shared = event.target.closest('[data-action]');
      const action = shared?.dataset.action;
      const board = game();
      const actions = [
        'select-country',
        'allocate-plus',
        'allocate-minus',
        'auto-allocate',
        'transfer',
        'planning',
        'diplomacy',
        'propose-alliance',
        'confirm-reinforce',
        'confirm-transfer',
        'start-attack',
        'roll',
        'stop-attack',
        'end-turn',
        'request-commentary',
      ];
      if (board && actions.includes(action)) {
        if (shared.disabled || busy) return true;
        if (action === 'request-commentary') {
          await act('commentary');
          return true;
        }
        const state = getState();
        // Local selection is harmless between turns; committed moves require this player's seat.
        if (
          action !== 'select-country' &&
          (room.currentSeat !== seat() || board.winner !== null || isRolling())
        )
          return true;
        try {
          if (applyBoardChoice(board, state, seat(), action, shared.dataset.code)) changed();
          else {
            const value = (id) => document.getElementById(id)?.value;
            const moves = {
              'confirm-reinforce': ['reinforce', { allocations: { ...state.allocations } }],
              'confirm-transfer': [
                'transfer',
                {
                  from: value('transfer-from'),
                  to: value('transfer-to'),
                  amount: Number(value('transfer-count')),
                },
              ],
              'start-attack': ['attack', { from: value('attack-from'), to: value('attack-to') }],
              'propose-alliance': ['alliance', { target: Number(value('diplomacy-target')) }],
              roll: ['roll'],
              'stop-attack': ['retreat'],
              'end-turn': ['end'],
            };
            if (moves[action]) await act(...moves[action]);
          }
        } catch (failure) {
          notify(failure.message);
        }
        return true;
      }
      const node = event.target.closest('[data-room-action]');
      if (!node) return false;
      if (!node.disabled) await act(node.dataset.roomAction);
      return true;
    },
    submit,
  };
}
