import { buildGameSummary } from '../game-summary.js';
import { escapeHTML } from '../html.js';
import { renderIcon } from './components.js';

const cacheLimit = 8;
const eventLabels = {
  conquest: 'Country captured',
  elimination: 'Commander eliminated',
  victory: 'Victory',
  decision: 'Alliance',
  dice: 'Major battle',
  held: 'Defence held',
  retreat: 'Attack stopped',
  attack: 'Attack launched',
  turn: 'Turn started',
};

/** Show an explicitly requested replay summary without changing narration preferences or saves. */
export function createGameSummaryDialog({
  getCloud,
  getUser,
  notify,
  onSelectEvent,
  pauseReplay,
  document = globalThis.document,
}) {
  const cache = new Map();
  let current = null,
    generation = 0,
    sequence = 0,
    account = getUser()?.uid ?? null,
    attachedDialog = null;

  const dialog = () => document.getElementById('help-dialog');
  const displaysSession = (session) =>
    current === session &&
    dialog()?.open &&
    dialog().querySelector('[data-game-summary]')?.dataset.gameSummary === session.id;
  const ownsDialog = (session) =>
    displaysSession(session) &&
    session.generation === generation &&
    session.uid === (getUser()?.uid ?? null);

  /** Ignore obsolete requests when another dialog, route or account replaces this presentation. */
  function close() {
    const active = current;
    // Hide this account's content even when sign-out has already changed the current UID.
    if (active && displaysSession(active)) dialog().close();
    current = null;
  }

  function reset() {
    close();
    generation++;
    cache.clear();
    account = getUser()?.uid ?? null;
  }

  /** Use exact recorded event IDs to jump to source moments, never an invented model timestamp. */
  function handleClick(event) {
    const session = current;
    if (!session || !ownsDialog(session)) return;
    if (event.target.closest('[data-summary-retry]')) {
      void request(session, true);
      return;
    }
    const moment = event.target.closest('[data-summary-event]');
    if (!moment) return;
    const index = session.indices.get(moment.dataset.summaryEvent);
    if (!Number.isInteger(index)) return;
    close();
    onSelectEvent(index);
  }

  function attach(element) {
    if (attachedDialog === element) return;
    attachedDialog = element;
    element.addEventListener('click', handleClick);
    element.addEventListener('cancel', () => {
      current = null;
    });
    element.addEventListener('close', () => {
      // A queued close event must not invalidate an already reopened dialog.
      if (!element.open) current = null;
    });
  }

  function momentMarkup(moment, session, position) {
    const source = session.facts.moments.find((fact) => fact.eventId === moment.eventId);
    return /* HTML */ `<div class="help-step">
      <span>${String(position + 1).padStart(2, '0')}</span>
      <div>
        <h3>${
          source
            ? `Round ${escapeHTML(source.round)} · ${eventLabels[source.type] || 'Recorded event'}`
            : 'Recorded moment'
        }</h3>
        <!-- Keep the exact recorded result visible even when AI wording is vague. -->
        <p data-summary-fact>${escapeHTML(source?.text ?? moment.text)}</p>
        ${
          session.indices.has(moment.eventId)
            ? /* HTML */ `<button
                type="button"
                class="btn btn-ghost btn-sm"
                data-summary-event="${escapeHTML(moment.eventId)}"
              >View moment</button>`
            : ''
        }
      </div>
    </div>`;
  }

  /** Keep generation quiet; show concrete highlights or a factual fallback once it finishes. */
  function render(session, entry) {
    if (!ownsDialog(session)) return;
    const { facts } = session;
    const loading = entry?.state === 'loading';
    const generated = entry?.state === 'ready' ? entry.result : null;
    const moments = generated?.moments ?? facts.moments;
    let status = 'Sign in to generate an AI summary. Recorded key moments are shown below.';
    if (!facts.recordedEvents) status = 'There are no recorded events to summarise yet.';
    else if (session.uid) {
      status = generated
        ? 'AI summary based on this campaign’s recorded events.'
        : loading
          ? 'Generating AI summary…'
          : 'AI summary is unavailable right now. Recorded key moments are shown below.';
    }
    const retry = session.uid && facts.recordedEvents && entry?.state === 'error';
    const rounds = facts.recordedEvents
      ? ` · Rounds ${escapeHTML(facts.firstRound)}–${escapeHTML(facts.lastRound)}`
      : '';
    dialog().innerHTML = /* HTML */ `<section data-game-summary="${session.id}">
      <div class="help-head">
        <div>
          <div class="eyebrow">Campaign recap</div>
          <h2 id="help-title">${generated ? 'AI summary' : 'Key moments'}</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          data-action="close-help"
          aria-label="Close game summary"
        >${renderIcon('close')}</button>
      </div>
      <div class="help-content">
        <h3>${escapeHTML(facts.name)}</h3>
        <p class="small muted">${facts.recordedEvents} available recorded events${rounds}.</p>
        <div class="notice" role="status" aria-live="polite">
          ${renderIcon('info')}<span>${status}</span>
        </div>
        ${
          retry
            ? '<p><button type="button" class="btn btn-sm"' +
              ' data-summary-retry>Retry AI summary</button></p>'
            : ''
        }
        ${
          loading
            ? ''
            : /* HTML */ `<div data-summary-key-events>
                <h3>Key events</h3>
                ${
                  moments.length
                    ? moments.map((moment, index) => momentMarkup(moment, session, index)).join('')
                    : '<p>No key events are recorded yet.</p>'
                }
              </div>`
        }
        ${
          generated
            ? /* HTML */ `<div data-summary-overview>
                <h3>AI recap</h3>
                <p>${escapeHTML(generated.overview)}</p>
              </div>`
            : ''
        }
        <p class="small muted">
          Shared replays may contain only recent events; this recap covers the available record.
        </p>
      </div>
    </section>`;
  }

  /** Coalesce repeated opens and keep successful summaries only in this account's bounded cache. */
  async function request(session, retry = false) {
    if (!session.uid || !session.facts.recordedEvents) {
      render(session);
      return;
    }
    let entry = cache.get(session.key);
    if (!entry || (retry && entry.state === 'error')) {
      entry = { state: 'loading' };
      cache.set(session.key, entry);
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      entry.promise = Promise.resolve()
        .then(() => {
          const cloud = getCloud();
          if (session.generation !== generation || session.uid !== getUser()?.uid)
            throw new Error('Your account changed.');
          if (typeof cloud?.summarizeGame !== 'function')
            throw new Error('AI summary is unavailable.');
          return cloud.summarizeGame(session.game);
        })
        .then((result) => {
          entry.state = 'ready';
          entry.result = result;
        })
        .catch(() => {
          entry.state = 'error';
        });
    }
    render(session, entry);
    await entry.promise;
    render(session, entry);
  }

  async function open(game) {
    if (!game) return;
    const element = dialog();
    if (!element) {
      notify?.('Game summary is unavailable. Please reload the page.');
      return;
    }
    const uid = getUser()?.uid ?? null;
    if (uid !== account) reset();
    pauseReplay();
    const events = game.events ?? [];
    const last = events.at(-1);
    const session = {
      id: String(++sequence),
      generation,
      uid,
      game,
      facts: buildGameSummary(game),
      indices: new Map(events.map((event, index) => [event.id, index])),
      key: JSON.stringify([uid, game.id, events.length, last?.id, last?.at, game.updatedAt]),
    };
    current = session;
    attach(element);
    element.innerHTML = `<section data-game-summary="${session.id}"></section>`;
    if (!element.open) element.showModal();
    await request(session);
  }

  return { open, close, reset };
}
