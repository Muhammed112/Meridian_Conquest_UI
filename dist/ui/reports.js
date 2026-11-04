import { escapeHTML } from '../html.js';
import { renderIcon } from './components.js';

let dockObserver;

/** Reserve the sticky roster’s height only when it is stacked above the map. */
function mapTopInset(column) {
  const roster = column.closest('.board-grid')?.querySelector('.roster-panel');
  if (roster && roster.getBoundingClientRect().right > column.getBoundingClientRect().left)
    return roster.offsetHeight + 12;
  return 16;
}

/** Render escaped recent narration in reverse order within the bounded report feed. */
function commentaryRows(game, limit) {
  const reports = game.events
    .filter((event) => typeof event.commentary === 'string' && event.commentary.trim())
    .slice(-limit)
    .reverse();
  if (!reports.length)
    return '<p class="report-empty">No AI commentary yet. Generated reports will appear here.</p>';
  return reports
    .map(
      (
        event,
      ) => /* prettier-ignore */ `<div class="activity-row"
          ><div class="activity-copy"
            ><p class="ai-commentary" data-commentary-event="${escapeHTML(event.id)}"
              >AI commentary: ${escapeHTML(event.commentary)}</p
            ><span class="event-meta"
              >ROUND ${String(event.round).padStart(2, '0')} /
              ${escapeHTML(event.type.toUpperCase())}</span
            ></div
          ><span class="activity-time"
            >${
              new Date(event.at).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              })
            }</span
          ></div
        >`,
    )
    .join('');
}

/** Render accessible report tabs and optional pin/collapse controls without attaching listeners. */
export function renderReports(
  game,
  {
    fieldReports,
    tab = 'field',
    badge = '',
    commentaryAction = '',
    live = false,
    limit = 12,
    dock = {},
  },
) {
  const active = tab === 'ai' ? 'ai' : 'field';
  const prefix = 'reports-' + escapeHTML(game.id);
  const collapsed = Boolean(dock.pinned && dock.collapsed);
  return /* prettier-ignore */ `<section
    class="panel reports-panel ${dock.pinned ? 'is-pinned' : ''}"
    data-reports-panel
    data-reports-collapsed="${collapsed}"
    ><div class="activity-head reports-head"
      ><div class="report-tabs" role="tablist" aria-label="Battle reports"
        >${
          [
            ['field', 'Field reports'],
            ['ai', 'AI commentary'],
          ]
            .map(
              ([id, label]) => /* HTML */ `<button
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
            .join('')
        }</div
      ><div class="commentary-actions"
        >${badge}<span data-commentary-actions ${active === 'ai' ? '' : 'hidden'}
          >${commentaryAction}</span
        ><button
          type="button"
          class="btn btn-sm"
          data-report-control="pin"
          aria-pressed="${Boolean(dock.pinned)}"
          >${dock.pinned ? 'Unpin' : 'Pin reports'}</button
        ><span data-report-collapse-control ${dock.pinned ? '' : 'hidden'}
          ><button
            type="button"
            class="btn btn-sm reports-collapse"
            data-report-control="collapse"
            aria-expanded="${!collapsed}"
            aria-controls="${prefix}-content"
            aria-label="${collapsed ? 'Expand reports' : 'Collapse reports'}"
            title="${collapsed ? 'Expand reports' : 'Collapse reports'}"
            >${renderIcon('chevron')}</button
          ></span
        ></div
      ></div
    ><div id="${prefix}-content" data-report-content ${collapsed ? 'hidden' : ''}
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
        >${
          live
            ? '<p class="commentary-feed-status" data-ai-feed-status role="status"></p>'
            : ''
        }<div
          class="activity-feed"
          data-commentary-feed="${escapeHTML(game.id)}"
          data-commentary-limit="${limit}"
          >${commentaryRows(game, limit)}</div
        ></div
      ></div
    ></section
  >`;
}

/** Replace the dock observer and fit the whole map and actions above expanded pinned reports. */
export function syncReportsDock(root) {
  dockObserver?.disconnect();
  dockObserver = null;
  const ownerDocument = root.ownerDocument || root;
  const panel = root.querySelector('[data-reports-panel].is-pinned');
  const column = panel?.parentElement;
  const theatre = column?.querySelector('.theatre');
  const expandedMapColumn = panel?.dataset.reportsCollapsed === 'false' && theatre ? column : null;
  for (const previous of ownerDocument.querySelectorAll('.reports-map-expanded')) {
    if (previous === expandedMapColumn) continue;
    previous.classList.remove('reports-map-expanded');
    previous.style.removeProperty('--reports-map-width');
    previous.style.removeProperty('--reports-map-font-size');
  }
  expandedMapColumn?.classList.add('reports-map-expanded');
  ownerDocument.documentElement.classList.toggle('reports-docked', Boolean(panel));
  if (!panel) {
    ownerDocument.documentElement.style.removeProperty('--reports-dock-height');
    return;
  }
  // Measure actual panel height so expanded reports reserve space rather than cover controls.
  const alignDock = () => {
    const bounds = column.getBoundingClientRect();
    panel.style.setProperty('--reports-dock-left', Math.max(12, bounds.left) + 'px');
    panel.style.setProperty(
      '--reports-dock-width',
      Math.min(bounds.width, ownerDocument.documentElement.clientWidth - 24) + 'px',
    );
    const dockHeight = panel.getBoundingClientRect().height;
    ownerDocument.documentElement.style.setProperty(
      '--reports-dock-height',
      Math.ceil(dockHeight) + 24 + 'px',
    );
    if (expandedMapColumn) {
      const availableHeight =
        ownerDocument.documentElement.clientHeight -
        dockHeight -
        (column.querySelector('.board-actions')?.offsetHeight || 0) -
        mapTopInset(column) -
        24;
      const mapWidth = Math.min(column.clientWidth - 2, Math.max(1, availableHeight) * 2);
      // Fit the whole card above reports without leaving empty strips beside the map.
      column.style.setProperty('--reports-map-width', mapWidth + 2 + 'px');
      // Keep country labels readable when the pinned map needs to become smaller.
      column.style.setProperty(
        '--reports-map-font-size',
        Math.max(9.5, (8 * 960) / mapWidth) + 'px',
      );
    }
  };
  alignDock();
  dockObserver = new ResizeObserver(alignDock);
  dockObserver.observe(panel);
  dockObserver.observe(panel.parentElement);
}

/** Update pin/collapse state in place and scroll the map into view only when newly expanded. */
export function setReportsDock(panel, dock) {
  const wasExpanded =
    panel.classList.contains('is-pinned') && panel.dataset.reportsCollapsed === 'false';
  const collapsed = Boolean(dock.pinned && dock.collapsed);
  panel.classList.toggle('is-pinned', dock.pinned);
  panel.dataset.reportsCollapsed = String(collapsed);
  panel.querySelector('[data-report-content]').hidden = collapsed;
  const pin = panel.querySelector('[data-report-control="pin"]');
  pin.setAttribute('aria-pressed', String(dock.pinned));
  pin.textContent = dock.pinned ? 'Unpin' : 'Pin reports';
  panel.querySelector('[data-report-collapse-control]').hidden = !dock.pinned;
  const collapse = panel.querySelector('[data-report-control="collapse"]');
  const label = collapsed ? 'Expand reports' : 'Collapse reports';
  collapse.setAttribute('aria-expanded', String(!collapsed));
  collapse.setAttribute('aria-label', label);
  collapse.title = label;
  syncReportsDock(panel.ownerDocument);
  if (dock.pinned && !collapsed && !wasExpanded) {
    const theatre = panel.parentElement.querySelector('.theatre');
    if (!theatre) return;
    const bounds = theatre.getBoundingClientRect();
    const top = mapTopInset(panel.parentElement);
    if (bounds.top < top || bounds.bottom > panel.getBoundingClientRect().top - 8)
      panel.ownerDocument.defaultView.scrollBy({ top: bounds.top - top, behavior: 'instant' });
  }
}

/** Switch accessible tabs in place, preserving gameplay controls and animation clocks. */
export function selectReportTab(panel, tab) {
  const active = tab === 'ai' ? 'ai' : 'field';
  // Keep one tab in the keyboard sequence, matching the arrow-key handler in the controller.
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
