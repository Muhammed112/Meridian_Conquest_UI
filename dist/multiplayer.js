import { escapeHTML } from './html.js';
import { catalogue, colours } from './data.js';
import { applyCommentary } from './commentary.js?v=match-commentary-20261026-1';
import { normalizeRoomCode, readRoomGame } from './rooms.js';
import { playerNickname } from './profile.js';
import { renderReports, updateReportsCommentary } from './ui/reports.js';

export function createMultiplayerUI({
  getCloud,
  notify,
  changed,
  mapView,
  diceView,
  presentGame = (game) => game,
  isRolling = () => false,
  getReportTab = () => 'field',
}) {
  const button = (label, action, disabled = false) =>
    /* HTML */ `<button
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
    selected = '',
    from = '',
    to = '',
    uid = null;
  const account = () => getCloud()?.user;
  const service = () => {
    const cloud = getCloud();
    if (!cloud?.user) throw new Error('Sign in to play with friends.');
    if (!cloud.ready) throw new Error('Your account is still loading. Please try again.');
    return cloud.rooms;
  };
  let parsedRoom = null,
    parsedGame = null;
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
  function requestCommentary() {
    if (!active || room?.hostUid !== account()?.uid || !game()) return 0;
    return getCloud().requestCommentary(game(), { roomCode: code });
  }
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
  }
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
      timer = setTimeout(() => act('bot'), 2400);
    }
  }
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
            if (value?.payload) readRoomGame(value);
            room = value;
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
  function route(next) {
    const nextActive = next !== null,
      nextCode = next || '';
    if (nextActive !== active || nextCode !== code) {
      disconnect();
      error = '';
      busy = false;
      selected = '';
      from = '';
      to = '';
    }
    active = nextActive;
    code = nextCode;
    if (active) connect();
  }
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
    if (kind === 'reinforce') {
      const allocations = Object.fromEntries(
        [...values].map(([key, value]) => [key, Number(value)]),
      );
      await act('reinforce', { allocations });
      return;
    }
    await act(kind, {
      from: values.get('from'),
      to: values.get('to'),
      amount: Number(values.get('amount')),
    });
  }
  const options = (countries, value) =>
    countries
      .map(
        (c) =>
          /* HTML */ `<option value="${c.code}" ${c.code === value ? 'selected' : ''}
            >${escapeHTML(c.name)} (${c.army})</option
          >`,
      )
      .join('');
  function controls(g) {
    const local = seat(),
      own = g.countries.filter((c) => c.owner === local),
      isTurn = room.currentSeat === local;
    if (g.presentationPending)
      return '<h2>Rolling dice...</h2><p class="muted" role="status">Results appear when the dice settle.</p>';
    if (g.winner !== null)
      return /* HTML */ `<h2>${escapeHTML(g.playerNames[g.winner])} wins.</h2
        ><p class="muted">All ten countries are under one command.</p>`;
    if (!own.length)
      return '<h2>You have been eliminated.</h2><p class="muted">You can keep watching the match.</p>';
    if (!isTurn)
      return /* HTML */ `<h2>${escapeHTML(g.playerNames[room.currentSeat])}'s turn.</h2
        ><p class="muted">The board updates as each move happens.</p
        >${room.currentSeat >= room.memberIds.length ? '<p class="small muted">The host runs the bots. Their room must stay open.</p>' : ''}`;
    if (g.budget)
      return /* HTML */ `<h2>Deploy ${g.budget} soldiers.</h2
        ><p class="small muted">Allocate the full budget before moving.</p
        ><form data-room-form="reinforce"
          >${own.map((c) => /* HTML */ `<label class="room-allocation">${escapeHTML(c.name)}<input class="field" type="number" min="0" max="${g.budget}" name="${c.code}" value="${c.code === (own.some((c) => c.code === from) ? from : own[0].code) ? g.budget : 0}" required /></label>`).join('')}<button
            class="btn btn-primary btn-full"
            ${busy ? 'disabled' : ''}
            >Deploy reinforcements</button
          ></form
        >`;
    if (g.battle)
      return /* HTML */ `<h2>Battle in progress.</h2
        ><p class="muted"
          >${escapeHTML(catalogue.find((c) => c.code === g.battle.from)?.name)} attacks
          ${escapeHTML(catalogue.find((c) => c.code === g.battle.to)?.name)}.</p
        ><div class="room-buttons"
          >${button('Roll dice', 'roll', busy)}${button('Retreat & end turn', 'retreat', busy)}</div
        >`;
    const attackFrom = own.filter((c) => c.army >= 2),
      enemies = g.countries.filter((c) => c.owner !== local);
    if (!own.some((c) => c.code === from)) from = own[0]?.code || '';
    if (!enemies.some((c) => c.code === to)) to = enemies[0]?.code || '';
    return /* HTML */ `<h2>Your move.</h2>${
        !g.attackUsed && attackFrom.length
          ? /* HTML */ `<form data-room-form="attack" class="room-action-form"
              ><h3>Launch an attack</h3
              ><label
                >From<select class="field" name="from"
                  >${options(attackFrom, from)}</select
                ></label
              ><label
                >Target<select class="field" name="to"
                  >${options(enemies, to)}</select
                ></label
              ><button class="btn btn-primary" ${busy ? 'disabled' : ''}>Attack</button></form
            >`
          : '<p class="muted">End your turn when you are ready.</p>'
      }${
        own.length > 1
          ? /* HTML */ `<details class="room-transfer"
              ><summary>Transfer soldiers</summary
              ><form data-room-form="transfer" class="room-action-form"
                ><label
                  >From<select class="field" name="from"
                    >${options(own, from)}</select
                  ></label
                ><label
                  >To<select class="field" name="to"
                    >${options(own, own.find((c) => c.code !== from)?.code)}</select
                  ></label
                ><label
                  >Soldiers<input
                    class="field"
                    type="number"
                    name="amount"
                    min="1"
                    max="100000"
                    value="1"
                    required /></label
                ><button class="btn" ${busy ? 'disabled' : ''}>Transfer</button></form
              ></details
            >`
          : ''
      }<div class="room-buttons">${button('End turn', 'end', busy)}</div>`;
  }
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
    const codeHeader = /* HTML */ `<div class="room-code-bar"
      ><div><span class="caption">Room code</span><strong>${escapeHTML(code)}</strong></div
      >${button('Copy code', 'copy', busy)}<span class="badge live"
        >${room.memberIds.length} friends / ${10 - room.memberIds.length} bots</span
      >${room.status === 'lobby' ? button(room.hostUid === user.uid ? 'Close room' : 'Leave lobby', 'leave', busy) : '<a href="#multiplayer" class="btn btn-sm">Back to rooms</a>'}</div
    >`;
    if (room.status === 'closed')
      return (
        heading +
        codeHeader +
        message +
        '<div class="notice">The host closed this room. <a href="#multiplayer">Create or join another room.</a></div>'
      );
    if (room.status === 'lobby')
      return (
        heading +
        codeHeader +
        message +
        /* HTML */ `<div class="room-lobby-grid"
          ><section class="panel"
            ><div class="panel-body"
              ><h2>Gather your commanders.</h2
              ><p class="muted"
                >${room.memberIds.length} of 10 seats filled. Countries are assigned when the match
                begins.</p
              ><div class="room-seats"
                >${Array.from({ length: 10 }, (_, i) => {
                  const id = room.memberIds[i];
                  return /* HTML */ `<div class="room-seat ${id ? '' : 'room-bot'}"
                    ><span class="room-seat-number" style="color:${colours[i]}"
                      >${String(i + 1).padStart(2, '0')}</span
                    ><div
                      ><strong>${id ? escapeHTML(room.members[id].name) : 'Bot seat'}</strong
                      ><span
                        >${id === room.hostUid ? 'Host' : id ? 'Ready to play' : 'A friend can take this seat before the start'}</span
                      ></div
                    ><span class="badge">${id ? 'Human' : 'Bot'}</span></div
                  >`;
                }).join('')}</div
              ></div
            ></section
          ><section class="panel"
            ><div class="panel-body"
              ><div class="eyebrow">Your shared campaign</div><h2>${escapeHTML(room.name)}</h2
              ><p>${escapeHTML(room.difficulty)} bots / ten countries / one winner</p
              ><p class="muted"
                >Once everyone has joined, the host starts the match. Empty seats become bots. New
                players cannot join after the start.</p
              ><p class="small muted"
                >Keep the host's room open to run bot turns. Rejoin with this code after signing
                back in to recover your seat.</p
              >${room.hostUid === user.uid ? /* HTML */ `<button class="btn btn-primary btn-full" data-room-action="start" ${busy ? 'disabled' : ''}>Start with ${10 - room.memberIds.length} bots</button>` : '<div class="notice" role="status">Waiting for the host to start.</div>'}</div
            ></section
          ></div
        >`
      );
    if (!g) return heading + message;
    const local = seat(),
      latest = g.battle?.pairs?.length ? g.battle : g.lastBattle;
    return (
      /* HTML */ `<div class="page-heading"><div><div class="eyebrow">Live multiplayer / Round ${g.round}</div><h1>${escapeHTML(room.name)}</h1><p>${g.winner !== null ? escapeHTML(g.playerNames[g.winner]) + ' won the match' : local === room.currentSeat ? 'Your turn' : escapeHTML(g.playerNames[room.currentSeat]) + ' is playing'}</p></div></div>` +
      codeHeader +
      message +
      /* HTML */ `<div class="room-turns"
          >${g.order.map((p) => /* HTML */ `<span class="badge ${p === room.currentSeat ? 'gold' : ''}" style="border-left:3px solid ${colours[p]}">${escapeHTML(g.playerNames[p])}${p === local ? ' (you)' : ''}</span>`).join('')}</div
        ><div class="room-board-grid"
          ><div
            >${mapView(g.countries, { live: true, selected, origin: g.battle?.from, target: g.battle?.to, playerNames: g.playerNames })}<section
              class="panel room-country-panel"
              ><div class="activity-head"
                ><h3>Countries & armies</h3
                ><span class="badge">You: ${escapeHTML(g.playerNames[local])}</span></div
              ><div class="room-countries"
                >${g.countries
                  .map(
                    (c) =>
                      /* HTML */ `<button
                        type="button"
                        class="room-country ${c.code === selected ? 'selected' : ''}"
                        data-room-country="${c.code}"
                        style="--owner-colour:${colours[c.owner]}"
                        ><span>${c.flag}</span
                        ><span
                          ><strong>${escapeHTML(c.name)}</strong
                          ><small
                            >${escapeHTML(g.playerNames[c.owner])}${c.owner === local ? ' (you)' : ''}</small
                          ></span
                        ><b>${c.army}</b></button
                      >`,
                  )
                  .join('')}</div
              ></section
            >${renderReports(g, {
              tab: getReportTab(),
              badge: '<span class="badge live">Live</span>',
              live: true,
              limit: 16,
              commentaryAction:
                room.hostUid === user.uid ? button('Generate commentary', 'commentary') : '',
              fieldReports: g.events
                .slice(-16)
                .reverse()
                .map(
                  (event) =>
                    /* HTML */ `<div class="activity-row"
                      ><span class="badge">R${event.round}</span
                      ><div class="activity-copy"
                        >${escapeHTML(event.text)}<span class="event-meta"
                          >${escapeHTML(event.type.toUpperCase())}</span
                        ></div
                      ></div
                    >`,
                )
                .join(''),
            })}</div
          ><aside class="panel room-control-panel"
            ><div class="panel-body"
              >${controls(g)}${latest?.pairs?.length ? /* HTML */ `<div class="room-dice"><h3>Latest dice</h3>${diceView(latest.pairs)}</div>` : ''}<div
                class="room-selection"
                >${selected ? `Selected: ${escapeHTML(g.countries.find((c) => c.code === selected)?.name)}` : ''}</div
              ></div
            ></aside
          ></div
        >`
    );
  }
  return {
    render,
    route,
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
    async handleClick(event) {
      const country = event.target.closest('[data-room-country]');
      if (country) {
        selected = country.dataset.roomCountry;
        const c = game()?.countries.find((c) => c.code === selected);
        if (c?.owner === seat()) from = c.code;
        else to = c?.code || '';
        changed();
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
