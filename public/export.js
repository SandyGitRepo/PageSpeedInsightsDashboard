// Builds the Excel report for the current dashboard view: an Overview sheet with the scope,
// key figures and a linked table of contents, then one sheet per dashboard section, with native charts.
import { formatTime, strategyLabel, uptimeTargets } from './common.js';
import { BAND, Workbook, cellRef, excelDate, rangeRef } from './xlsx.js';

const OVERVIEW = 'Overview';
// Light-theme series palette from styles.css (--series-1 … --series-8).
const SERIES = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300', '6250D6', 'E34948'];
const PHASES = [
  { key: 'dns_ms', label: 'DNS', color: SERIES[0] },
  { key: 'tcp_ms', label: 'Connection', color: SERIES[1] },
  { key: 'tls_ms', label: 'SSL handshake', color: SERIES[2] },
  { key: 'first_byte_ms', label: 'First byte', color: SERIES[3] },
  { key: 'download_ms', label: 'Download', color: SERIES[4] },
];
const SCORE_RULES = (cell) => [
  { formula: `AND(ISNUMBER(${cell}),${cell}>=90)`, band: BAND.good },
  { formula: `AND(ISNUMBER(${cell}),${cell}>=50)`, band: BAND.avg },
  { formula: `ISNUMBER(${cell})`, band: BAND.poor },
];
const AVAILABILITY_RULES = (cell) => [
  { formula: `AND(ISNUMBER(${cell}),${cell}>=0.999)`, band: BAND.good },
  { formula: `AND(ISNUMBER(${cell}),${cell}>=0.99)`, band: BAND.avg },
  { formula: `ISNUMBER(${cell})`, band: BAND.poor },
];
const HEADER_ROW = 4;

const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, '');
const round = (ms) => (ms === null || ms === undefined ? null : Math.round(ms));

function scoreStyle(score) {
  if (score === null || score === undefined) return 'kpiValue';
  return score >= 90 ? 'kpiGood' : score >= 50 ? 'kpiAvg' : 'kpiPoor';
}

// Title, one-line description and navigation links shared by every section sheet.
function sectionHeader(sheet, title, description, dashboardHref) {
  sheet.set(0, 0, title, 'title');
  sheet.height(0, 30);
  sheet.set(1, 0, description, 'subtitle');
  sheet.set(2, 0, { text: '← Back to Overview', sheet: OVERVIEW }, 'navLink');
  sheet.set(2, 1, { text: 'Open this section on the live dashboard ↗', href: dashboardHref }, 'navLink');
}

function emptyNote(sheet, row, text) {
  sheet.set(row, 0, text, 'note');
}

// ---------- sections ----------

function latestSheet(book, data) {
  const { projects, latestRuns, filters } = data;
  const sheet = book.addSheet('Latest scores', { tabColor: '2A78D6' });
  sheet.widths(24, 52, 12, 12, 22, 18, 18);
  sectionHeader(sheet, 'Latest scores', 'Most recent PageSpeed performance score per page (0–100).', data.sectionHref('latest-card'));

  const byKey = new Map(latestRuns.map((run) => [`${run.project}\n${run.url}\n${run.strategy}`, run]));
  sheet.row(HEADER_ROW, 0, ['Project', 'Page URL', 'Mobile', 'Desktop', 'Last checked', 'Mobile report', 'Desktop report'], 'header');
  let row = HEADER_ROW + 1;
  const labels = [];
  const mobile = [];
  const desktop = [];
  for (const p of projects) {
    if (filters.project && p.name !== filters.project) continue;
    for (const url of p.urls) {
      if (filters.url && url !== filters.url) continue;
      const m = byKey.get(`${p.name}\n${url}\nmobile`);
      const d = byKey.get(`${p.name}\n${url}\ndesktop`);
      const last = Math.max(m?.fetched_at ?? 0, d?.fetched_at ?? 0);
      const reportLink = (run) => (run ? { text: 'Open report', href: data.reportUrl(run.id) } : '–');
      sheet.row(row, 0, [
        p.name,
        { text: url, href: url },
        m?.performance ?? null,
        d?.performance ?? null,
        last ? { date: last } : 'Waiting for first check',
        reportLink(m),
        reportLink(d),
      ], ['text', 'link', 'int', 'int', last ? 'date' : 'text', m ? 'link' : 'text', d ? 'link' : 'text']);
      labels.push(shortUrl(url));
      mobile.push(m?.performance ?? null);
      desktop.push(d?.performance ?? null);
      row++;
    }
  }
  if (row === HEADER_ROW + 1) {
    emptyNote(sheet, row, 'No pages match the selected filters.');
    return sheet;
  }
  const last = row - 1;
  sheet.freeze(HEADER_ROW + 1);
  sheet.conditional(HEADER_ROW + 1, 2, last, 3, SCORE_RULES(cellRef(HEADER_ROW + 1, 2)));
  sheet.chart(
    {
      type: 'column',
      title: 'Latest performance score · mobile vs desktop',
      categories: { values: labels },
      series: [
        { name: 'Mobile', nameRef: rangeRef(sheet.name, HEADER_ROW, 2), color: SERIES[0], ref: rangeRef(sheet.name, HEADER_ROW + 1, 2, last, 2), values: mobile },
        { name: 'Desktop', nameRef: rangeRef(sheet.name, HEADER_ROW, 3), color: SERIES[1], ref: rangeRef(sheet.name, HEADER_ROW + 1, 3, last, 3), values: desktop },
      ],
      valueAxis: { min: 0, max: 100, majorUnit: 25, title: 'Score' },
    },
    { from: [last + 2, 0], to: [last + 22, 7] },
  );
  return sheet;
}

function trendSheet(book, data) {
  const { runs, filters, span, metricLabel } = data;
  const metric = filters.metric;
  const sheet = book.addSheet('Score trend', { tabColor: '1BAF7A' });
  sectionHeader(
    sheet,
    `${metricLabel} score over time`,
    'Solid line = mobile · dashed line = desktop. The data behind the chart is listed below it.',
    data.sectionHref('chart-card'),
  );

  const series = new Map();
  for (const run of [...runs].sort((a, b) => a.fetched_at - b.fetched_at)) {
    if (run.status !== 'ok' || run[metric] === null) continue;
    const key = `${run.project}\n${run.url}\n${run.strategy}`;
    if (!series.has(key)) series.set(key, { url: run.url, strategy: run.strategy, points: [] });
    series.get(key).points.push(run);
  }
  const list = [...series.values()].sort(
    (a, b) => data.allUrls.indexOf(a.url) - data.allUrls.indexOf(b.url) || a.strategy.localeCompare(b.strategy),
  );
  sheet.widths(...Array.from({ length: Math.max(10, list.length * 2) }, (_, i) => (i % 2 === 0 ? 19 : 14)));
  if (list.length === 0) {
    emptyNote(sheet, HEADER_ROW, 'No data for the selected filters yet.');
    return sheet;
  }

  const dataTop = 28;
  sheet.set(dataTop, 0, 'Chart data', 'heading');
  const nameRow = dataTop + 1;
  const headRow = dataTop + 2;
  const chartSeries = list.map((s, i) => {
    const col = i * 2;
    const name = `${shortUrl(s.url)} · ${strategyLabel(s.strategy)}`;
    sheet.set(nameRow, col, name, 'label');
    sheet.set(nameRow, col + 1, null, 'label');
    sheet.merge(nameRow, col, nameRow, col + 1);
    sheet.row(headRow, col, ['Time', metricLabel], 'header');
    s.points.forEach((run, k) => {
      sheet.set(headRow + 1 + k, col, { date: run.fetched_at }, 'date');
      sheet.set(headRow + 1 + k, col + 1, run[metric], 'int');
    });
    const end = headRow + s.points.length;
    sheet.conditional(headRow + 1, col + 1, end, col + 1, SCORE_RULES(cellRef(headRow + 1, col + 1)));
    const color = SERIES[Math.max(0, data.allUrls.indexOf(s.url)) % SERIES.length];
    return {
      name,
      nameRef: rangeRef(sheet.name, nameRow, col),
      color,
      dash: s.strategy === 'desktop' ? 'dash' : null,
      markers: s.points.length <= 150,
      x: { ref: rangeRef(sheet.name, headRow + 1, col, end, col), values: s.points.map((r) => excelDate(r.fetched_at)) },
      y: { ref: rangeRef(sheet.name, headRow + 1, col + 1, end, col + 1), values: s.points.map((r) => r[metric]) },
    };
  });
  sheet.freeze(headRow + 1);
  // Start the axis at the first point, so a range that is mostly empty doesn't squash the lines.
  const firstPoint = Math.min(...list.map((s) => s.points[0].fetched_at));
  const axisFrom = Math.max(span.from, firstPoint);
  const shortRange = span.to - axisFrom <= 24 * 3600_000;
  sheet.chart(
    {
      type: 'scatter',
      title: `${metricLabel} score over time`,
      series: chartSeries,
      xAxis: { min: excelDate(axisFrom), max: excelDate(span.to), format: shortRange ? 'hh:mm' : 'dd-mmm' },
      yAxis: { min: 0, max: 100, majorUnit: 25, title: 'Score' },
    },
    { from: [HEADER_ROW, 0], to: [HEADER_ROW + 22, 10] },
  );
  return sheet;
}

function availabilitySheet(book, data) {
  const { uptime, projects, filters } = data;
  const sheet = book.addSheet('Availability', { tabColor: 'EDA100' });
  sheet.widths(20, 44, 16, 14, 14, 12, 20, 11, 13, 13, 13, 13, 12, 10);
  sectionHeader(
    sheet,
    'Availability and response time by location · India',
    `HTTP GET from probes in ${uptime.locations.length} Indian cities every ${uptime.intervalMinutes} min. Timings are averages of successful checks, in milliseconds.`,
    data.sectionHref('uptime-card'),
  );
  const intervalMs = uptime.intervalMinutes * 60_000;
  const header = ['Project', 'Page URL', 'Location', 'Availability', 'Down (min)', 'Downtimes', 'Last downtime', 'DNS', 'Connection', 'SSL', 'First byte', 'Download', 'Total', 'Checks'];
  sheet.row(HEADER_ROW, 0, header, 'header');

  const byKey = new Map(uptime.rows.map((r) => [`${r.project}\n${r.url}\n${r.location}`, r]));
  const targets = uptimeTargets(projects, uptime, filters);
  const chartRows = [];
  let row = HEADER_ROW + 1;
  for (const target of targets) {
    for (const location of uptime.locations) {
      const r = byKey.get(`${target.project}\n${target.url}\n${location}`);
      if (!r) {
        sheet.row(row, 0, [target.project, { text: target.url, href: target.url }, location, 'No data yet'], ['text', 'link', 'text', 'text']);
        for (let c = 4; c < header.length; c++) sheet.set(row, c, null, 'text');
        row++;
        continue;
      }
      sheet.row(row, 0, [
        target.project,
        { text: target.url, href: target.url },
        location,
        r.up_checks / r.checks,
        Math.round(((r.checks - r.up_checks) * intervalMs) / 60_000),
        r.downtimes,
        r.last_down_at ? { date: r.last_down_at } : '–',
        ...PHASES.map((p) => round(r[p.key])),
        round(r.total_ms),
        r.checks,
      ], ['text', 'link', 'text', 'percent', 'number', 'int', r.last_down_at ? 'date' : 'text', 'number', 'number', 'number', 'number', 'number', 'number', 'int']);
      chartRows.push({ row, label: targets.length > 1 ? `${location} · ${shortUrl(target.url)}` : location, data: r });
      row++;
    }
  }
  if (row === HEADER_ROW + 1) {
    emptyNote(sheet, row, 'No pages match the selected filters.');
    return sheet;
  }
  const last = row - 1;
  sheet.freeze(HEADER_ROW + 1);
  sheet.autoFilter(HEADER_ROW, 0, last, header.length - 1);
  sheet.conditional(HEADER_ROW + 1, 3, last, 3, AVAILABILITY_RULES(cellRef(HEADER_ROW + 1, 3)));

  if (chartRows.length) {
    // Each series references its column; rows without data are simply absent from the chart.
    const ranges = (col) => chartRows.map((c) => rangeRef(sheet.name, c.row, col)).join(',');
    sheet.chart(
      {
        type: 'bar',
        stacked: true,
        title: 'Average response time by location (ms)',
        categories: { values: chartRows.map((c) => c.label) },
        series: PHASES.map((phase, i) => ({
          name: phase.label,
          nameRef: rangeRef(sheet.name, HEADER_ROW, 7 + i),
          color: phase.color,
          ref: chartRows.length === last - HEADER_ROW ? rangeRef(sheet.name, HEADER_ROW + 1, 7 + i, last, 7 + i) : `(${ranges(7 + i)})`,
          values: chartRows.map((c) => round(c.data[phase.key])),
        })),
        valueAxis: { min: 0, format: '#,##0', title: 'Milliseconds' },
      },
      { from: [last + 2, 0], to: [last + 2 + Math.max(16, Math.ceil(chartRows.length * 1.4) + 8), 9] },
    );
  }
  return sheet;
}

function historySheet(book, data) {
  const { runs } = data;
  const sheet = book.addSheet('Hit history', { tabColor: '6250D6' });
  sheet.widths(20, 20, 44, 10, 9, 13, 14, 14, 9, 11, 11, 11, 9, 15, 15, 50);
  sectionHeader(
    sheet,
    'Hit history',
    `${runs.length} PageSpeed checks in the selected range, newest first. Timings in milliseconds.`,
    data.sectionHref('history-card'),
  );
  const header = ['Time', 'Project', 'Page URL', 'Device', 'Status', 'Performance', 'Accessibility', 'Best practices', 'SEO', 'FCP', 'LCP', 'TBT', 'CLS', 'Speed Index', 'Report', 'Error'];
  sheet.row(HEADER_ROW, 0, header, 'header');
  if (runs.length === 0) {
    emptyNote(sheet, HEADER_ROW + 1, 'No hits in the selected range yet.');
    return sheet;
  }
  runs.forEach((run, i) => {
    const ok = run.status === 'ok';
    sheet.row(HEADER_ROW + 1 + i, 0, [
      { date: run.fetched_at },
      run.project,
      run.url,
      strategyLabel(run.strategy),
      ok ? 'OK' : 'Error',
      run.performance,
      run.accessibility,
      run.best_practices,
      run.seo,
      round(run.fcp_ms),
      round(run.lcp_ms),
      round(run.tbt_ms),
      run.cls,
      round(run.si_ms),
      { text: 'Open report', href: data.reportUrl(run.id) },
      run.error ?? '',
    ], ['date', 'text', 'text', 'text', ok ? 'text' : 'error', 'int', 'int', 'int', 'int', 'number', 'number', 'number', 'decimal', 'number', 'link', ok ? 'text' : 'error']);
  });
  const last = HEADER_ROW + runs.length;
  sheet.freeze(HEADER_ROW + 1, 1);
  sheet.autoFilter(HEADER_ROW, 0, last, header.length - 1);
  sheet.conditional(HEADER_ROW + 1, 5, last, 8, SCORE_RULES(cellRef(HEADER_ROW + 1, 5)));
  return sheet;
}

// ---------- overview ----------

function overviewSheet(book, data, sections) {
  const { kpis, labels, span } = data;
  const sheet = book.addSheet(OVERVIEW, { tabColor: '002953' });
  // Overview is first in the workbook but filled last, once the section sheets exist.
  book.sheets.unshift(book.sheets.pop());
  sheet.widths(30, 30, 30, 30);

  sheet.set(0, 0, 'PageSpeed Monitor · Performance report', 'title');
  sheet.height(0, 34);
  sheet.set(1, 0, `Generated ${formatTime(Date.now())} · Google PageSpeed Insights and Globalping data`, 'subtitle');

  sheet.set(3, 0, 'Report scope', 'heading');
  for (let c = 1; c < 4; c++) sheet.set(3, c, null, 'heading');
  const scope = [
    ['Project', labels.project],
    ['Page URL', labels.url],
    ['Device', labels.strategy],
    ['Trend metric', labels.metric],
    ['Time range', `${labels.range}: ${formatTime(span.from)} – ${formatTime(span.to)}`],
    ['Live dashboard', { text: 'Open the dashboard with these filters ↗', href: data.dashboardUrl }],
  ];
  scope.forEach(([label, value], i) => {
    const r = 4 + i;
    sheet.set(r, 0, label, 'label');
    sheet.set(r, 1, value, typeof value === 'object' ? 'link' : 'text');
    sheet.set(r, 2, null, 'text');
    sheet.set(r, 3, null, 'text');
    sheet.merge(r, 1, r, 3);
  });

  const kpiTop = 11;
  sheet.set(kpiTop, 0, 'Key figures', 'heading');
  for (let c = 1; c < 4; c++) sheet.set(kpiTop, c, null, 'heading');
  const perfTile = (strategy, figure) =>
    figure
      ? [`${strategyLabel(strategy)} performance`, `${figure.avg} / 100`, scoreStyle(figure.avg), figure.pages > 1 ? `Average of ${figure.pages} pages` : 'Latest check']
      : [`${strategyLabel(strategy)} performance`, '–', 'kpiValue', 'Waiting for first check'];
  const noUptime = kpis.uptimeMonitored ? 'Waiting for first check' : 'Location checks are off for these pages';
  const availabilityStyle = kpis.availability === null ? 'kpiValue' : kpis.availability >= 99.9 ? 'kpiGood' : kpis.availability >= 99 ? 'kpiAvg' : 'kpiPoor';
  const tiles = [
    perfTile('mobile', kpis.mobile),
    perfTile('desktop', kpis.desktop),
    [
      'Availability · India',
      kpis.availability === null ? '–' : `${kpis.availability === 100 ? '100' : kpis.availability.toFixed(2)}%`,
      availabilityStyle,
      kpis.availability === null ? noUptime : `${labels.range} · ${kpis.locations} locations`,
    ],
    [
      'Avg response time · India',
      kpis.avgResponseMs === null ? '–' : `${(kpis.avgResponseMs / 1000).toFixed(2)} s`,
      'kpiValue',
      kpis.avgResponseMs === null ? noUptime : `${labels.range} · all locations`,
    ],
  ];
  tiles.forEach(([label, value, style, note], c) => {
    sheet.set(kpiTop + 1, c, label, 'kpiLabel');
    sheet.set(kpiTop + 2, c, value, style);
    sheet.set(kpiTop + 3, c, note, 'kpiNote');
  });
  sheet.height(kpiTop + 1, 22);
  sheet.height(kpiTop + 2, 34);
  sheet.height(kpiTop + 3, 20);

  const tocTop = kpiTop + 5;
  sheet.set(tocTop, 0, 'Contents', 'heading');
  for (let c = 1; c < 4; c++) sheet.set(tocTop, c, null, 'heading');
  sheet.row(tocTop + 1, 0, ['Section', 'What it shows', null, 'Live dashboard'], 'header');
  sheet.merge(tocTop + 1, 1, tocTop + 1, 2);
  sections.forEach(({ sheet: target, description, anchor }, i) => {
    const r = tocTop + 2 + i;
    sheet.set(r, 0, { text: target.name, sheet: target.name }, 'link');
    sheet.set(r, 1, description, 'wrap');
    sheet.set(r, 2, null, 'wrap');
    sheet.merge(r, 1, r, 2);
    sheet.set(r, 3, { text: 'Open on dashboard ↗', href: data.sectionHref(anchor) }, 'link');
    sheet.height(r, 32);
  });

  const notesTop = tocTop + 3 + sections.length;
  sheet.set(
    notesTop,
    0,
    'Score bands: 90–100 good · 50–89 needs improvement · 0–49 poor. Availability bands: ≥ 99.9% good · ≥ 99% needs improvement · below 99% poor. ' +
      'Report links stay valid while the run is retained on the server.',
    'note',
  );
  sheet.merge(notesTop, 0, notesTop, 3);
  sheet.height(notesTop, 32);
}

// ---------- entry point ----------

export async function exportWorkbook(data) {
  const book = new Workbook({ title: 'PageSpeed Monitor report', creator: 'PageSpeed Monitor' });
  const sections = [
    { sheet: latestSheet(book, data), anchor: 'latest-card', description: 'Latest mobile and desktop performance score per page, with a comparison chart.' },
    { sheet: trendSheet(book, data), anchor: 'chart-card', description: `${data.metricLabel} score over time per page and device, as a line chart with its data.` },
  ];
  if (data.kpis.uptimeMonitored) {
    sections.push({ sheet: availabilitySheet(book, data), anchor: 'uptime-card', description: 'Availability, downtimes and response-time breakdown per Indian city, with a stacked bar chart.' });
  }
  sections.push({ sheet: historySheet(book, data), anchor: 'history-card', description: 'Every PageSpeed check in the range with all scores, Core Web Vitals and a link to its full report.' });
  overviewSheet(book, data, sections);

  const blob = await book.toBlob();
  const scope = (data.filters.project || 'all-projects').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pagespeed-report-${scope || 'export'}-${stamp}.xlsx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
