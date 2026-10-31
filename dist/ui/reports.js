import { escapeHTML } from '../html.js';

function commentaryRows(game, limit) {
  const reports = game.events
    .filter((event) => typeof event.commentary === 'string' && event.commentary.trim())
    .slice(-limit)
    .reverse();
  if (!reports.length)
    return '<p class="report-empty">No AI commentary yet. Generated reports will appear here.</p>';
  return reports
    .map(
      (event) =>
        /* HTML */ `<div class="activity-row"
          ><div class="activity-copy"
            ><p class="ai-commentary" data-commentary-event="${escapeHTML(event.id)}"
              >AI commentary: ${escapeHTML(event.commentary)}</p
            ><span class="event-meta"
              >ROUND ${String(event.round).padStart(2, '0')} /
              ${escapeHTML(event.type.toUpperCase())}</span
            ></div
          ><span class="activity-time"
            >${new Date(event.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span
          ></div
        >`,
    )
    .join('');
}

export function renderReports(
  game,
  { fieldReports, tab = 'field', badge = '', commentaryAction = '', live = false, limit = 12 },
) {
  const active = tab === 'ai' ? 'ai' : 'field';
  const prefix = 'reports-' + escapeHTML(game.id);
  return /* HTML */ `<section class="panel reports-panel" data-reports-panel
    ><div class="activity-head reports-head"
      ><div class="report-tabs" role="tablist" aria-label="Battle reports"
        >${[
          ['field', 'Field reports'],
          ['ai', 'AI commentary'],
        ]
          .map(
            ([id, label]) =>
              /* HTML */ `<button
                type="button"
                class="report-tab"
                role="tab"
                id="${prefix}-tab-${id}"
                aria-controls="${prefix}-panel-${id}"
                aria-selected="${active === id}"
                tabindex="${active === id ? 0 : -1}"
                data-report-tab="${id}"
                >${label}</button
              >`,
          )
          .join('')}</div
      ><div class="commentary-actions"
        >${badge}<span data-commentary-actions ${active === 'ai' ? '' : 'hidden'}
          >${commentaryAction}</span
        ></div
      ></div
    ><div
      id="${prefix}-panel-field"
      role="tabpanel"
      tabindex="0"
      aria-labelledby="${prefix}-tab-field"
      data-report-panel="field"
      ${active === 'field' ? '' : 'hidden'}
      ><div class="activity-feed">${fieldReports}</div></div
    ><div
      id="${prefix}-panel-ai"
      role="tabpanel"
      tabindex="0"
      aria-labelledby="${prefix}-tab-ai"
      data-report-panel="ai"
      ${active === 'ai' ? '' : 'hidden'}
      >${live ? '<p class="commentary-feed-status" data-ai-feed-status role="status"></p>' : ''}<div
        class="activity-feed"
        data-commentary-feed="${escapeHTML(game.id)}"
        data-commentary-limit="${limit}"
        >${commentaryRows(game, limit)}</div
      ></div
    ></section
  >`;
}

export function selectReportTab(panel, tab) {
  const active = tab === 'ai' ? 'ai' : 'field';
  for (const button of panel.querySelectorAll('[data-report-tab]')) {
    const selected = button.dataset.reportTab === active;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const content of panel.querySelectorAll('[data-report-panel]'))
    content.hidden = content.dataset.reportPanel !== active;
  panel.querySelector('[data-commentary-actions]').hidden = active !== 'ai';
}

// Patch only commentary so incoming reports never restart dice or replace inputs.
export function updateReportsCommentary(root, game) {
  for (const feed of root.querySelectorAll('[data-commentary-feed]')) {
    if (feed.dataset.commentaryFeed !== game.id) continue;
    const scroll = feed.scrollTop;
    feed.innerHTML = commentaryRows(game, Number(feed.dataset.commentaryLimit) || 12);
    feed.scrollTop = scroll;
  }
  for (const node of root.querySelectorAll('.history-event [data-commentary-event]')) {
    const event = game.events.find((event) => event.id === node.dataset.commentaryEvent);
    if (event?.commentary) node.textContent = 'AI commentary: ' + event.commentary;
  }
}
