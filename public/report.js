import { el, formatMs, formatTime, getJson, psiHref, scoreBadge, scoreClass, strategyLabel } from './common.js';

const FIELD_METRIC_LABELS = {
  LARGEST_CONTENTFUL_PAINT_MS: ['Largest Contentful Paint', formatMs],
  INTERACTION_TO_NEXT_PAINT: ['Interaction to Next Paint', formatMs],
  CUMULATIVE_LAYOUT_SHIFT_SCORE: ['Cumulative Layout Shift', (v) => (v / 100).toFixed(2)],
  FIRST_CONTENTFUL_PAINT_MS: ['First Contentful Paint', formatMs],
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: ['Time to First Byte', formatMs],
  FIRST_INPUT_DELAY_MS: ['First Input Delay', formatMs],
};

const root = document.getElementById('report');

function card(title, ...children) {
  return el('section', { className: 'card' }, el('h2', {}, title), ...children);
}

function scoresCard(run) {
  const items = run.details.categories.map((c) =>
    el('div', { className: 'gauge' }, el('span', { className: `gauge-value ${scoreClass(c.score)}` }, c.score ?? '–'), el('span', {}, c.title)),
  );
  return card('Scores', el('div', { className: 'gauges' }, items));
}

function metricsCard(run) {
  const rows = run.details.metrics.map((m) =>
    el('tr', {}, el('td', {}, m.title), el('td', { className: 'num' }, scoreBadge(m.score === null ? null : Math.round(m.score * 100))), el('td', { className: 'num' }, m.displayValue ?? '–')),
  );
  return card(
    'Lab metrics',
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Metric'), el('th', { className: 'num' }, 'Score'), el('th', { className: 'num' }, 'Value'))), el('tbody', {}, rows)),
  );
}

function fieldCard(title, field) {
  if (!field) return null;
  const rows = field.metrics
    .filter((m) => FIELD_METRIC_LABELS[m.id])
    .map((m) => {
      const [label, format] = FIELD_METRIC_LABELS[m.id];
      return el('tr', {}, el('td', {}, label), el('td', { className: 'num' }, format(m.percentile)), el('td', {}, m.category ?? '–'));
    });
  return card(
    title,
    el('p', { className: 'muted small' }, `Real-user data (Chrome UX Report, 75th percentile). Overall: ${field.overall ?? 'n/a'}`),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Metric'), el('th', { className: 'num' }, 'p75'), el('th', {}, 'Rating'))), el('tbody', {}, rows)),
  );
}

function issuesCard(category) {
  const body = category.issues.length
    ? el(
        'ul',
        { className: 'issues' },
        category.issues.map((issue) =>
          el(
            'li',
            {},
            el('details', {},
              el('summary', {}, scoreBadge(Math.round(issue.score * 100)), ' ', issue.title, issue.displayValue ? el('span', { className: 'muted' }, ` — ${issue.displayValue}`) : null),
              el('p', { className: 'muted small' }, issue.description),
            ),
          ),
        ),
      )
    : el('p', { className: 'muted' }, 'No failing audits.');
  return card(`${category.title}: what to improve`, body);
}

async function main() {
  const id = location.pathname.split('/').pop();
  let run;
  try {
    run = await getJson(`api/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    document.getElementById('subtitle').textContent = `Report not found (${err.message}).`;
    return;
  }

  document.title = `${strategyLabel(run.strategy)} · ${run.url} — PageSpeed Report`;
  document.getElementById('title').textContent = run.url;
  document.getElementById('subtitle').replaceChildren(
    `${run.project} · ${strategyLabel(run.strategy)} · ${formatTime(run.fetched_at)} · `,
    el('a', { href: run.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open page'),
    ' · ',
    el('a', { href: psiHref(run.url, run.strategy), target: '_blank', rel: 'noopener noreferrer' }, 'Run again on PageSpeed Insights'),
  );

  if (run.status !== 'ok') {
    root.replaceChildren(card('This check failed', el('p', { className: 'error-text' }, run.error)));
    return;
  }

  const d = run.details;
  root.replaceChildren(
    ...[
      el('p', { className: 'muted small' }, 'The full Lighthouse report for this check is no longer stored (full reports are kept for a limited time), so this is the saved summary.'),
      d.runWarnings.length ? card('Warnings', el('ul', {}, d.runWarnings.map((w) => el('li', {}, w)))) : null,
      scoresCard(run),
      metricsCard(run),
      fieldCard('Field data for this URL', d.fieldData),
      fieldCard('Field data for the whole origin', d.originFieldData),
      ...d.categories.map(issuesCard),
      el('p', { className: 'muted small' }, `Lighthouse ${d.lighthouseVersion} · tested URL: ${d.finalUrl}`),
    ].filter(Boolean),
  );
}

main();
