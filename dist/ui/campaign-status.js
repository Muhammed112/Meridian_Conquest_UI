import { escapeHTML } from '../html.js';

/** Keep history failures and conflicts scoped to one campaign, with an explicit retry route. */
export function renderCampaignStatus({ nav, footer, status, name }) {
  const waiting = ['loading', 'unloaded'].includes(status);
  const conflict = status === 'conflict';
  const heading = waiting
    ? 'Loading this campaign…'
    : conflict
      ? 'This campaign changed on another device.'
      : 'This campaign could not finish loading.';
  return `<div class="shell">${nav('campaigns')}<main><section class="panel panel-body" role="status">
    <h1>${heading}</h1>${name ? `<p>${escapeHTML(name)}</p>` : ''}
    <p>${
      waiting
        ? 'Your other campaigns are available while this history loads.'
        : 'Your saved data and browser recovery copy are kept. You can retry or open another campaign.'
    }</p>
    ${
      waiting
        ? ''
        : `<button class="btn btn-primary" data-action="retry-campaign-history">
      ${conflict ? 'Reload saved campaign' : 'Retry loading this campaign'}</button>`
    }
    <a href="#campaigns" class="btn">My campaigns</a></section></main>${footer()}</div>`;
}
