import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadConfig } from './config/env.js';
import { defaultProject, listTargets, projects, uptimeUrls, validateProjects } from './config/projects.js';
import { openDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { startUptimeScheduler } from './uptime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSI_DAILY_QUOTA = 25_000;
const MAX_RUNS_PER_REQUEST = 20_000;

// Only these files are served; nothing else on disk is reachable.
const STATIC_FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/report.js': ['public/report.js', 'text/javascript; charset=utf-8'],
  '/lighthouse-report.js': ['public/lighthouse-report.js', 'text/javascript; charset=utf-8'],
  '/vendor/lighthouse/standalone.js': ['vendor/lighthouse/standalone.js', 'text/javascript; charset=utf-8'],
  '/common.js': ['public/common.js', 'text/javascript; charset=utf-8'],
  '/export.js': ['public/export.js', 'text/javascript; charset=utf-8'],
  '/xlsx.js': ['public/xlsx.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/lighthouse.css': ['public/lighthouse.css', 'text/css; charset=utf-8'],
  '/vendor/chart.umd.js': ['node_modules/chart.js/dist/chart.umd.js', 'text/javascript; charset=utf-8'],
  ...Object.fromEntries(
    [400, 500, 600, 700].map((weight) => [
      `/fonts/rubik-${weight}.woff2`,
      [`node_modules/@fontsource/rubik/files/rubik-latin-${weight}-normal.woff2`, 'font/woff2'],
    ]),
  ),
};
const SUMMARY_REPORT_PAGE = ['public/report.html', 'text/html; charset=utf-8'];
const FULL_REPORT_PAGE = ['public/lighthouse.html', 'text/html; charset=utf-8'];
// The Lighthouse renderer injects <style> elements, so this page alone allows inline styles.
const FULL_REPORT_CSP = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

const config = loadConfig();
if (!config.apiKey) {
  console.error('PSI_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}
const configErrors = validateProjects(projects, uptimeUrls);
if (configErrors.length) {
  console.error(`Invalid src/config/projects.js:\n  ${configErrors.join('\n  ')}`);
  process.exit(1);
}

const targets = listTargets(projects);
const dailyRequests = targets.length * 2 * Math.floor((24 * 60) / config.intervalMinutes);
if (dailyRequests > PSI_DAILY_QUOTA) {
  console.warn(
    `[config] ${targets.length} URLs every ${config.intervalMinutes} min = ${dailyRequests} PSI requests/day, ` +
      `above the default quota of ${PSI_DAILY_QUOTA}.`,
  );
}

const db = openDb(config.dbPath);
const schedulerStatus = startScheduler({ db, targets, config });
const uptimeTargets = targets.filter((t) => uptimeUrls.includes(t.url));
const uptimeStatus = startUptimeScheduler({ db, targets: uptimeTargets, config });

function send(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, ...extraHeaders });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'Cache-Control': 'no-cache' });
}

// no-cache + ETag: browsers revalidate on every load and get 304 until the file changes,
// so a deploy never leaves stale CSS/JS behind.
async function sendFile(req, res, [relativePath, contentType], extraHeaders = {}) {
  const filePath = path.join(ROOT, relativePath);
  const info = await stat(filePath);
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const headers = {
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    ...extraHeaders,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
    return res.end();
  }
  send(res, 200, await readFile(filePath), contentType, headers);
}

function sendLighthouseJson(req, res, runId) {
  const gzipped = db.getReportGzip(runId);
  if (!gzipped) return sendJson(res, 404, { error: 'Full report not available' });
  const headers = { 'Cache-Control': 'public, max-age=86400, immutable', Vary: 'Accept-Encoding' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    return send(res, 200, gzipped, 'application/json; charset=utf-8', { ...headers, 'Content-Encoding': 'gzip' });
  }
  send(res, 200, gunzipSync(gzipped), 'application/json; charset=utf-8', headers);
}

function parseTime(value, fallback) {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function handleApi(url, req, res) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/projects') {
    return sendJson(res, 200, {
      projects: Object.entries(projects).map(([name, urls]) => ({ name, urls })),
      defaultProject: projects[defaultProject] ? defaultProject : '',
      uptime: uptimeStatus,
      intervalMinutes: config.intervalMinutes,
      retentionDays: config.retentionDays,
      scheduler: schedulerStatus,
    });
  }

  if (pathname === '/api/uptime') {
    const now = Date.now();
    return sendJson(res, 200, {
      intervalMinutes: config.uptime.intervalMinutes,
      locations: uptimeStatus?.locations ?? [],
      urls: uptimeStatus?.urls ?? [],
      // Checks stored before a URL was removed from uptimeUrls are left out.
      rows: db.uptimeSummary({
        project: searchParams.get('project') || null,
        url: searchParams.get('url') || null,
        from: parseTime(searchParams.get('from'), now - 24 * 60 * 60 * 1000),
        to: parseTime(searchParams.get('to'), now),
      }).filter((row) => uptimeStatus?.urls.includes(row.url)),
    });
  }

  if (pathname === '/api/latest') {
    return sendJson(res, 200, { runs: db.latestRuns() });
  }

  if (pathname === '/api/runs') {
    const strategy = searchParams.get('strategy') || null;
    if (strategy && !['mobile', 'desktop'].includes(strategy)) {
      return sendJson(res, 400, { error: 'strategy must be mobile or desktop' });
    }
    const now = Date.now();
    const runs = db.listRuns({
      project: searchParams.get('project') || null,
      url: searchParams.get('url') || null,
      strategy,
      from: parseTime(searchParams.get('from'), now - 24 * 60 * 60 * 1000),
      to: parseTime(searchParams.get('to'), now),
      limit: Math.min(parseTime(searchParams.get('limit'), MAX_RUNS_PER_REQUEST), MAX_RUNS_PER_REQUEST),
    });
    return sendJson(res, 200, { runs, truncated: runs.length === MAX_RUNS_PER_REQUEST });
  }

  const runMatch = pathname.match(/^\/api\/runs\/(\d+)$/);
  if (runMatch) {
    const run = db.getRun(Number(runMatch[1]));
    return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: 'Run not found' });
  }

  const lhrMatch = pathname.match(/^\/api\/runs\/(\d+)\/lighthouse\.json$/);
  if (lhrMatch) return sendLighthouseJson(req, res, Number(lhrMatch[1]));

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return handleApi(url, req, res);
    if (STATIC_FILES[url.pathname]) return await sendFile(req, res, STATIC_FILES[url.pathname]);

    // Full Lighthouse report while it is retained, otherwise the stored summary.
    const reportMatch = url.pathname.match(/^\/report\/(\d+)$/);
    if (reportMatch) {
      return db.getRun(Number(reportMatch[1]))?.hasFullReport
        ? await sendFile(req, res, FULL_REPORT_PAGE, FULL_REPORT_CSP)
        : await sendFile(req, res, SUMMARY_REPORT_PAGE);
    }

    send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) send(res, 500, 'Internal Server Error', 'text/plain; charset=utf-8');
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `Dashboard on http://localhost:${config.port} — monitoring ${targets.length} URLs ` +
      `every ${config.intervalMinutes} min`,
  );
});
