// Availability + response-time checks from Indian cities via Globalping (https://globalping.io),
// a free network of community-hosted probes. One HTTP GET per URL per city per cycle.
import { runWithConcurrency } from './scheduler.js';

const API = 'https://api.globalping.io/v1/measurements';
const POLL_MS = 1000;
const MAX_WAIT_MS = 30_000;
const ANONYMOUS_TESTS_PER_HOUR = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiHeaders(token) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function requestBody(pageUrl, city) {
  const url = new URL(pageUrl);
  return {
    type: 'http',
    target: url.hostname,
    locations: [{ country: 'IN', city, limit: 1 }],
    measurementOptions: {
      protocol: url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
      ...(url.port ? { port: Number(url.port) } : {}),
      request: { method: 'GET', path: url.pathname, ...(url.search ? { query: url.search.slice(1) } : {}) },
    },
  };
}

// Returns null when no probe was available in that city (not the site's fault, so not stored).
export async function measureFromCity({ url, city, token }) {
  const headers = apiHeaders(token);
  const res = await fetch(API, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody(url, city)),
    signal: AbortSignal.timeout(15_000),
  });
  const created = await res.json().catch(() => null);
  if (res.status === 422) return null;
  if (!res.ok) throw new Error(created?.error?.message || `Globalping HTTP ${res.status}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  let measurement;
  do {
    await sleep(POLL_MS);
    const poll = await fetch(`${API}/${created.id}`, { headers, signal: AbortSignal.timeout(15_000) });
    measurement = await poll.json();
  } while (measurement.status === 'in-progress' && Date.now() < deadline);

  const probe = measurement.results?.[0];
  const result = probe?.result;
  if (!result || result.status === 'in-progress' || result.status === 'offline') return null;

  const timings = result.timings ?? {};
  const base = { network: probe.probe?.network ?? null, statusCode: result.statusCode ?? null, timings };
  if (result.status === 'finished' && result.statusCode) {
    const up = result.statusCode < 400;
    return { ...base, up, error: up ? null : `HTTP ${result.statusCode} ${result.statusCodeName ?? ''}`.trim() };
  }
  const reason = (result.rawOutput ?? '').split('\n').find((line) => line.trim()) || 'Request failed';
  return { ...base, up: false, error: reason.slice(0, 300) };
}

export function startUptimeScheduler({ db, targets, config }) {
  const { locations, intervalMinutes, token } = config.uptime;
  if (locations.length === 0) return null;

  const testsPerHour = targets.length * locations.length * Math.ceil(60 / intervalMinutes);
  if (!token && testsPerHour > ANONYMOUS_TESTS_PER_HOUR) {
    console.warn(
      `[uptime] ${testsPerHour} Globalping tests/hour exceeds the anonymous limit of ${ANONYMOUS_TESTS_PER_HOUR}; ` +
        'set GLOBALPING_TOKEN, use fewer locations, or a longer UPTIME_INTERVAL_MINUTES.',
    );
  }

  const jobs = targets.flatMap((target) => locations.map((location) => ({ ...target, location })));
  let running = false;

  async function cycle() {
    if (running) {
      console.warn('[uptime] previous cycle still running, skipping this one');
      return;
    }
    running = true;
    let stored = 0;
    let skipped = 0;
    try {
      await runWithConcurrency(jobs, 4, async ({ project, url, location }) => {
        const checkedAt = Date.now();
        try {
          const result = await measureFromCity({ url, city: location, token });
          if (!result) {
            skipped++;
            return;
          }
          db.insertUptime({ project, url, location, checkedAt, ...result });
          stored++;
        } catch (err) {
          // API/network problem on our side; not evidence the site is down.
          skipped++;
          console.error(`[uptime] ${location} ${url}: ${err.message}`);
        }
      });
      db.pruneUptimeOlderThan(Date.now() - config.retentionDays * DAY_MS);
      console.log(`[uptime] cycle done: ${stored} stored, ${skipped} skipped`);
    } catch (err) {
      console.error('[uptime] cycle failed:', err);
    } finally {
      running = false;
    }
  }

  cycle();
  setInterval(cycle, intervalMinutes * 60 * 1000);
  return { locations, intervalMinutes };
}
