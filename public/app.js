import {
  el,
  formatCls,
  formatMs,
  formatTime,
  getJson,
  reportHref,
  scoreBadge,
  scoreClass,
  strategyLabel,
} from './common.js';

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;
const RANGES = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const RANGE_LABELS = { '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom range' };
const METRIC_LABELS = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  best_practices: 'Best practices',
  seo: 'SEO',
};
const SERIES_COUNT = 8;
// Response-time phases, in request order; colors are series slots 1-5.
const PHASES = [
  { key: 'dns_ms', label: 'DNS time' },
  { key: 'tcp_ms', label: 'Connection time' },
  { key: 'tls_ms', label: 'SSL handshake time' },
  { key: 'first_byte_ms', label: 'First byte time' },
  { key: 'download_ms', label: 'Download time' },
];

const $ = (id) => document.getElementById(id);
// Phone layout: matches the 640px breakpoint in styles.css, where .hide-sm columns are hidden.
const compactQuery = window.matchMedia('(max-width: 640px)');
const isCompact = () => compactQuery.matches;
const form = $('filters');
let meta = null;
let projects = [];
let allUrls = [];
let runs = [];
let page = 0;
let chart = null;

// ---------- filter state <-> URL query string ----------

function readFilters() {
  const data = Object.fromEntries(new FormData(form));
  return {
    project: data.project || '',
    url: data.url || '',
    strategy: data.strategy || '',
    metric: METRIC_LABELS[data.metric] ? data.metric : 'performance',
    range: data.range || '24h',
    from: data.from || '',
    to: data.to || '',
  };
}

function writeQueryString(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    // project is always written, so an explicit "All projects" survives a reload
    // instead of falling back to the default project.
    if (key === 'project') {
      if (value !== meta.defaultProject) params.set(key, value);
      continue;
    }
    if (!value) continue;
    if ((key === 'from' || key === 'to') && filters.range !== 'custom') continue;
    if ((key === 'metric' && value === 'performance') || (key === 'range' && value === '24h')) continue;
    params.set(key, value);
  }
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function applyQueryString() {
  const params = new URLSearchParams(location.search);
  form.elements.project.value = params.has('project') ? params.get('project') : meta.defaultProject;
  if (form.elements.project.selectedIndex < 0) form.elements.project.value = '';
  for (const name of ['strategy', 'metric', 'range', 'from', 'to']) {
    if (params.has(name) && form.elements[name]) form.elements[name].value = params.get(name);
  }
  populateUrlSelect();
  if (params.has('url')) form.elements.url.value = params.get('url');
  toggleCustomRange();
}

function timeWindow({ range, from, to }) {
  const now = Date.now();
  if (range === 'custom') {
    return {
      from: from ? new Date(from).getTime() : now - RANGES['24h'] * 3600_000,
      to: to ? new Date(to).getTime() : now,
    };
  }
  return { from: now - (RANGES[range] ?? 24) * 3600_000, to: now };
}

function toggleCustomRange() {
  const custom = form.elements.range.value === 'custom';
  for (const label of form.querySelectorAll('.custom-range')) label.hidden = !custom;
}

// ---------- selects ----------

function populateProjectSelect() {
  const select = form.elements.project;
  select.replaceChildren(el('option', { value: '' }, 'All projects'));
  for (const p of projects) select.append(el('option', { value: p.name }, p.name));
}

function populateUrlSelect() {
  const select = form.elements.url;
  const previous = select.value;
  const project = form.elements.project.value;
  const urls = [...new Set(projects.filter((p) => !project || p.name === project).flatMap((p) => p.urls))];
  select.replaceChildren(el('option', { value: '' }, 'All URLs'), ...urls.map((u) => el('option', { value: u }, u)));
  select.value = urls.includes(previous) ? previous : '';
}

const matchesFilters = (row, filters) =>
  (!filters.project || row.project === filters.project) && (!filters.url || row.url === filters.url);

// ---------- formatting ----------

const formatSeconds = (ms) => (ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(2)} s`);
const formatAvailability = (pct) => (pct === null ? '–' : `${pct === 100 ? '100' : pct.toFixed(2)}%`);

function formatDuration(ms) {
  if (!ms) return '0 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function scoreLabel(score) {
  return { 'score-good': ['good', 'Good'], 'score-avg': ['avg', 'Needs improvement'], 'score-poor': ['poor', 'Poor'] }[scoreClass(score)] ?? null;
}

// ---------- rendering ----------

function renderStatus() {
  const { scheduler, intervalMinutes } = meta;
  const parts = [`PageSpeed checked every ${intervalMinutes} min on mobile and desktop`];
  if (scheduler.running) parts.push('a check is running now');
  else if (scheduler.lastFinishedAt) parts.push(`last check ${formatTime(scheduler.lastFinishedAt)}`);
  if (scheduler.nextRunAt && !scheduler.running) parts.push(`next at ${formatTime(scheduler.nextRunAt)}`);
  $('status-line').textContent = parts.join(' · ');
}

function kpiTile(label, value, unit, note, status) {
  return el(
    'article',
    { className: 'kpi' },
    el('p', { className: 'kpi-label' }, label),
    el('p', { className: 'kpi-value' }, value, unit ? el('small', {}, unit) : null),
    el('p', { className: 'kpi-note' }, status ? el('span', { className: `status-dot ${status}`, 'aria-hidden': 'true' }) : null, note),
  );
}

function renderKpis(latestRuns, uptimeRows, filters) {
  const latest = latestRuns.filter((r) => matchesFilters(r, filters));
  const scoreTile = (strategy) => {
    const scores = latest.filter((r) => r.strategy === strategy && r.performance !== null).map((r) => r.performance);
    if (scores.length === 0) return kpiTile(`${strategyLabel(strategy)} performance`, '–', '', 'Waiting for first check');
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const [status, text] = scoreLabel(avg);
    const scope = scores.length > 1 ? `average of ${scores.length} pages` : 'latest check';
    return kpiTile(`${strategyLabel(strategy)} performance`, String(avg), '/100', `${text} · ${scope}`, status);
  };

  const checks = uptimeRows.reduce((sum, r) => sum + r.checks, 0);
  const upChecks = uptimeRows.reduce((sum, r) => sum + r.up_checks, 0);
  const timed = uptimeRows.filter((r) => r.total_ms !== null);
  const rangeLabel = RANGE_LABELS[filters.range];
  const availability = checks ? (upChecks / checks) * 100 : null;
  const availabilityTile = checks
    ? kpiTile(
        'Availability · India',
        formatAvailability(availability).replace('%', ''),
        '%',
        `${rangeLabel} · ${timed.length || uptimeRows.length} locations`,
        availability >= 99.9 ? 'good' : availability >= 99 ? 'avg' : 'poor',
      )
    : kpiTile('Availability · India', '–', '', 'Waiting for first check');
  // Weighted by successful checks per location.
  const upTotal = timed.reduce((sum, r) => sum + r.up_checks, 0);
  const avgResponse = upTotal ? timed.reduce((sum, r) => sum + r.total_ms * r.up_checks, 0) / upTotal : null;
  const responseTile = avgResponse === null
    ? kpiTile('Avg response time · India', '–', '', 'Waiting for first check')
    : kpiTile('Avg response time · India', (avgResponse / 1000).toFixed(2), 's', `${rangeLabel} · all locations`);

  $('kpis').replaceChildren(scoreTile('mobile'), scoreTile('desktop'), availabilityTile, responseTile);
}

function renderLatest(latestRuns, filters) {
  const byKey = new Map();
  for (const run of latestRuns) byKey.set(`${run.project}\n${run.url}\n${run.strategy}`, run);

  const cell = (run) =>
    el(
      'td',
      { className: 'num' },
      run ? el('a', { href: reportHref(run.id), title: 'Open report' }, scoreBadge(run.performance)) : scoreBadge(null),
    );

  const rows = [];
  for (const p of projects) {
    if (filters.project && p.name !== filters.project) continue;
    for (const url of p.urls) {
      if (filters.url && url !== filters.url) continue;
      const mobile = byKey.get(`${p.name}\n${url}\nmobile`);
      const desktop = byKey.get(`${p.name}\n${url}\ndesktop`);
      const last = Math.max(mobile?.fetched_at ?? 0, desktop?.fetched_at ?? 0);
      rows.push(
        el(
          'tr',
          {},
          el('td', { className: 'hide-sm' }, p.name),
          el('td', { className: 'url-cell' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, isCompact() ? shortUrl(url) : url)),
          cell(mobile),
          cell(desktop),
          el('td', { className: 'nowrap' }, last ? formatTime(last) : 'Waiting for first check'),
        ),
      );
    }
  }
  $('latest-body').replaceChildren(...rows);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const shortDateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, '');
const dayOnly = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

// Short axis labels: time of day for ranges up to a day, otherwise the date.
function formatTick(ms, span) {
  return span.to - span.from <= 24 * 3600_000 ? timeOnly.format(ms) : dayOnly.format(ms);
}

// Color follows the URL (its position in the config), never its rank in the current result.
function seriesColor(url) {
  const index = Math.max(0, allUrls.indexOf(url)) % SERIES_COUNT;
  return cssVar(`--series-${index + 1}`);
}

function renderChart(filters, span) {
  const metric = filters.metric;
  $('chart-title').textContent = `${METRIC_LABELS[metric]} score over time`;

  const series = new Map();
  for (const run of runs) {
    if (run.status !== 'ok' || run[metric] === null) continue;
    const key = `${run.project}\n${run.url}\n${run.strategy}`;
    if (!series.has(key)) series.set(key, { ...run, points: [] });
    series.get(key).points.push({ x: run.fetched_at, y: run[metric], id: run.id });
  }

  const datasets = [...series.values()]
    .sort((a, b) => allUrls.indexOf(a.url) - allUrls.indexOf(b.url) || a.strategy.localeCompare(b.strategy))
    .map((s) => {
      const color = seriesColor(s.url);
      return {
        label: `${s.url} · ${strategyLabel(s.strategy)}`,
        data: s.points.sort((a, b) => a.x - b.x),
        borderColor: color,
        backgroundColor: color,
        borderDash: s.strategy === 'desktop' ? [6, 4] : [],
        borderWidth: 2,
        pointRadius: s.points.length > 150 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.2,
      };
    });

  $('chart-empty').hidden = datasets.length > 0;
  const text = cssVar('--muted');
  const grid = cssVar('--grid');

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: {
        type: 'linear',
        min: span.from,
        max: span.to,
        ticks: { color: text, maxTicksLimit: isCompact() ? 4 : 7, callback: (v) => formatTick(v, span) },
        grid: { color: grid },
        border: { color: grid },
      },
      y: { min: 0, max: 100, ticks: { color: text, stepSize: 25 }, grid: { color: grid }, border: { display: false } },
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: cssVar('--text-2'), boxWidth: isCompact() ? 16 : 24, boxHeight: 2, font: { size: isCompact() ? 10 : 12 } },
      },
      tooltip: {
        callbacks: {
          title: (items) => formatTime(items[0].parsed.x),
          footer: () => 'Click to open report',
        },
      },
    },
    onClick: (_event, elements) => {
      const hit = elements[0];
      if (!hit) return;
      const point = chart.data.datasets[hit.datasetIndex].data[hit.index];
      location.assign(reportHref(point.id));
    },
  };

  if (chart) {
    chart.data.datasets = datasets;
    chart.options = options;
    chart.update();
  } else {
    Chart.defaults.font.family = cssVar('--font');
    chart = new Chart($('chart'), { type: 'line', data: { datasets }, options });
  }
}

// ---------- availability by location ----------

const tooltip = $('tooltip');

function showTooltip(event, title, activeKey, row) {
  tooltip.replaceChildren(
    el('p', { className: 'tooltip-title' }, title),
    ...PHASES.map((phase, i) =>
      el(
        'div',
        { className: `tooltip-row${phase.key === activeKey ? ' active' : ''}` },
        el('span', { className: `swatch seg-${i + 1}` }),
        el('span', {}, phase.label),
        el('span', {}, formatMs(row[phase.key])),
      ),
    ),
    el('div', { className: 'tooltip-row active' }, el('span', { className: 'swatch' }), el('span', {}, 'Total'), el('span', {}, formatMs(row.total_ms))),
  );
  tooltip.hidden = false;
  const x = Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function responseBar(row, maxTotal) {
  if (row.total_ms === null) return el('span', { className: 'muted' }, 'No successful checks');
  const phaseSum = PHASES.reduce((sum, p) => sum + (row[p.key] ?? 0), 0) || 1;
  const segments = PHASES.map((phase, i) => {
    const value = row[phase.key] ?? 0;
    const seg = el('span', {
      className: `rt-seg seg-${i + 1}`,
      'data-label': Math.round(value),
      'aria-hidden': 'true',
    });
    seg.style.flex = `${value / phaseSum} 1 0`;
    seg.addEventListener('mousemove', (e) => showTooltip(e, row.location, phase.key, row));
    seg.addEventListener('mouseleave', () => (tooltip.hidden = true));
    return seg;
  });
  const bar = el('div', { className: 'rt-bar' }, segments);
  bar.style.width = `${Math.max(4, (row.total_ms / maxTotal) * 100)}%`;
  const summary = PHASES.map((p) => `${p.label} ${formatMs(row[p.key])}`).join(', ');
  return el(
    'div',
    { className: 'rt', role: 'img', 'aria-label': `Average response time ${formatMs(row.total_ms)}: ${summary}` },
    el('div', { className: 'rt-track' }, bar),
    el('span', { className: 'rt-total' }, formatSeconds(row.total_ms)),
  );
}

// Direct labels only where the segment is wide enough to hold them.
function labelSegments() {
  for (const seg of document.querySelectorAll('.rt-seg')) {
    seg.textContent = seg.offsetWidth >= 30 ? seg.dataset.label : '';
  }
}

function renderUptime(uptime, filters) {
  const intervalMs = uptime.intervalMinutes * 60_000;
  $('uptime-card').hidden = uptime.locations.length === 0;
  $('uptime-sub').textContent =
    `HTTP GET from probes in ${uptime.locations.length} Indian cities every ${uptime.intervalMinutes} min · ` +
    `${RANGE_LABELS[filters.range]} · response time is the average of successful checks.`;

  const rowsByUrl = new Map();
  for (const row of uptime.rows) {
    const key = `${row.project}\n${row.url}`;
    if (!rowsByUrl.has(key)) rowsByUrl.set(key, new Map());
    rowsByUrl.get(key).set(row.location, row);
  }

  const targets = projects
    .filter((p) => !filters.project || p.name === filters.project)
    .flatMap((p) => p.urls.filter((u) => !filters.url || u === filters.url).map((url) => ({ project: p.name, url })));
  const maxTotal = Math.max(1, ...uptime.rows.map((r) => r.total_ms ?? 0));
  const columns = isCompact() ? 3 : 6;

  const body = [];
  for (const target of targets) {
    if (targets.length > 1) {
      body.push(el('tr', { className: 'group-row' }, el('td', { colspan: columns }, `${target.project} · ${target.url}`)));
    }
    const byLocation = rowsByUrl.get(`${target.project}\n${target.url}`) ?? new Map();
    for (const location of uptime.locations) {
      const row = byLocation.get(location);
      if (!row) {
        body.push(
          el('tr', {}, el('td', {}, location), el('td', { colspan: columns - 1, className: 'muted' }, 'No data yet (no probe available in this city, or waiting for first check)')),
        );
        continue;
      }
      const availability = (row.up_checks / row.checks) * 100;
      const status = availability >= 99.9 ? 'good' : availability >= 99 ? 'avg' : 'poor';
      body.push(
        el(
          'tr',
          {},
          el('td', { className: 'nowrap' }, isCompact() ? row.location : `${row.location} · IN`),
          el('td', { className: 'num' }, el('span', { className: 'avail' }, el('span', { className: `status-dot ${status}`, 'aria-hidden': 'true' }), formatAvailability(availability))),
          el('td', { className: 'num nowrap hide-sm' }, formatDuration((row.checks - row.up_checks) * intervalMs)),
          el('td', { className: 'num hide-sm' }, row.downtimes),
          el('td', { className: 'nowrap hide-sm' }, row.last_down_at ? formatTime(row.last_down_at) : '–'),
          el('td', {}, responseBar(row, maxTotal)),
        ),
      );
    }
  }
  if (body.length === 0) body.push(el('tr', {}, el('td', { colspan: columns, className: 'empty' }, 'No pages match the filters.')));
  $('uptime-body').replaceChildren(...body);
  requestAnimationFrame(labelSegments);
}

function renderLegend() {
  $('uptime-legend').replaceChildren(
    ...PHASES.map((phase, i) => el('li', {}, el('span', { className: `swatch seg-${i + 1}`, 'aria-hidden': 'true' }), phase.label)),
  );
}

// ---------- hit history ----------

function renderHistory() {
  const pages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const slice = runs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const compact = isCompact();
  // On phones the URL column is hidden; when several URLs are listed it goes under the time instead.
  const manyUrls = new Set(runs.map((r) => r.url)).size > 1;
  const rows = slice.map((run) => {
    const ok = run.status === 'ok';
    return el(
      'tr',
      { className: ok ? '' : 'row-error' },
      el(
        'td',
        { className: 'nowrap' },
        compact ? shortDateTime.format(run.fetched_at) : formatTime(run.fetched_at),
        compact && manyUrls ? el('span', { className: 'sub-line' }, shortUrl(run.url)) : null,
      ),
      el('td', { className: 'hide-sm' }, run.project),
      el('td', { className: 'url-cell hide-sm' }, el('a', { href: run.url, target: '_blank', rel: 'noopener noreferrer' }, run.url)),
      el('td', {}, strategyLabel(run.strategy)),
      ...(ok
        ? [
            el('td', { className: 'num' }, scoreBadge(run.performance)),
            el('td', { className: 'num hide-sm' }, scoreBadge(run.accessibility)),
            el('td', { className: 'num hide-sm' }, scoreBadge(run.best_practices)),
            el('td', { className: 'num hide-sm' }, scoreBadge(run.seo)),
            el('td', { className: 'num nowrap' }, formatMs(run.lcp_ms)),
            el('td', { className: 'num hide-sm' }, formatCls(run.cls)),
          ]
        : [el('td', { colspan: compact ? 2 : 6, className: 'error-text', title: run.error }, `Error: ${run.error}`)]),
      el('td', { className: 'nowrap' }, el('a', { href: reportHref(run.id) }, compact ? 'See report' : 'Click here to see report')),
    );
  });

  if (rows.length === 0) {
    rows.push(el('tr', {}, el('td', { colspan: compact ? 5 : 11, className: 'empty' }, 'No hits in the selected range yet.')));
  }
  $('history-body').replaceChildren(...rows);
  $('history-count').textContent = `${runs.length} PageSpeed checks in the selected range, newest first.`;
  $('page-info').textContent = `Page ${page + 1} of ${pages}`;
  $('prev-page').disabled = page === 0;
  $('next-page').disabled = page >= pages - 1;
}

// ---------- data loading ----------

let loadToken = 0;
let nextRefreshAt = 0;
let lastUpdatedAt = null;

function renderRefreshNote() {
  const note = $('refresh-note');
  if (readFilters().range === 'custom') {
    note.textContent = 'Auto-refresh is paused while a custom time range is selected.';
    return;
  }
  const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  if (isCompact()) {
    note.textContent = `Auto-refreshes every ${REFRESH_MS / 1000}s${lastUpdatedAt ? ` · next in ${seconds}s` : ''}`;
    return;
  }
  const parts = [`This page refreshes automatically every ${REFRESH_MS / 1000} seconds, no need to reload`];
  if (lastUpdatedAt) parts.push(`next refresh in ${seconds}s`);
  note.textContent = parts.join(' · ');
}

async function refresh() {
  const token = ++loadToken;
  nextRefreshAt = Date.now() + REFRESH_MS;
  const filters = readFilters();
  writeQueryString(filters);
  $('page-title').textContent = filters.url || filters.project || 'All projects';
  const span = timeWindow(filters);
  const params = new URLSearchParams({ from: span.from, to: span.to });
  for (const key of ['project', 'url', 'strategy']) if (filters[key]) params.set(key, filters[key]);
  const uptimeParams = new URLSearchParams({ from: span.from, to: span.to });
  for (const key of ['project', 'url']) if (filters[key]) uptimeParams.set(key, filters[key]);

  try {
    const [freshMeta, latest, result, uptime] = await Promise.all([
      getJson('/api/projects'),
      getJson('/api/latest'),
      getJson(`/api/runs?${params}`),
      getJson(`/api/uptime?${uptimeParams}`),
    ]);
    if (token !== loadToken) return;
    meta = freshMeta;
    renderStatus();
    runs = result.runs;
    renderKpis(latest.runs, uptime.rows, filters);
    renderLatest(latest.runs, filters);
    renderChart(filters, span);
    renderUptime(uptime, filters);
    renderHistory();
    lastUpdatedAt = Date.now();
    renderRefreshNote();
  } catch (err) {
    $('status-line').textContent = `Could not load data: ${err.message}`;
  }
}

async function init() {
  meta = await getJson('/api/projects');
  projects = meta.projects;
  allUrls = [...new Set(projects.flatMap((p) => p.urls))];
  populateProjectSelect();
  applyQueryString();
  renderLegend();

  form.addEventListener('change', (event) => {
    if (event.target.name === 'project') populateUrlSelect();
    if (event.target.name === 'range') toggleCustomRange();
    page = 0;
    refresh();
  });
  form.addEventListener('submit', (event) => event.preventDefault());
  $('prev-page').addEventListener('click', () => (page--, renderHistory()));
  $('next-page').addEventListener('click', () => (page++, renderHistory()));
  window.addEventListener('resize', () => requestAnimationFrame(labelSegments));
  // Colspans, labels and chart sizing depend on the layout, so re-render when it switches.
  compactQuery.addEventListener('change', () => refresh());

  await refresh();
  // Ticks every second for the countdown; data is only fetched every REFRESH_MS,
  // and not while the tab is hidden (it catches up as soon as the tab is visible again).
  setInterval(() => {
    if (!document.hidden && readFilters().range !== 'custom' && Date.now() >= nextRefreshAt) refresh();
    renderRefreshNote();
  }, 1000);
}

init().catch((err) => {
  $('status-line').textContent = `Could not load dashboard: ${err.message}`;
});
