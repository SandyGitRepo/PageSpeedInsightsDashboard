import { runPagespeed } from './psi.js';

const STRATEGIES = ['mobile', 'desktop'];
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

export function startScheduler({ db, targets, config }) {
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const status = { running: false, lastStartedAt: null, lastFinishedAt: null, nextRunAt: null, lastCycle: null };
  const jobs = targets.flatMap((target) => STRATEGIES.map((strategy) => ({ ...target, strategy })));

  async function cycle() {
    status.nextRunAt = Date.now() + intervalMs;
    if (status.running) {
      console.warn('[scheduler] previous cycle still running, skipping this one');
      return;
    }
    status.running = true;
    status.lastStartedAt = Date.now();
    try {
      await runJobs();
    } catch (err) {
      console.error('[scheduler] cycle failed:', err);
    } finally {
      status.running = false;
      status.lastFinishedAt = Date.now();
    }
  }

  async function runJobs() {
    let ok = 0;
    let failed = 0;

    await runWithConcurrency(jobs, config.concurrency, async ({ project, url, strategy }) => {
      const startedAt = Date.now();
      try {
        const result = await runPagespeed({
          url,
          strategy,
          apiKey: config.apiKey,
          timeoutMs: config.requestTimeoutMs,
        });
        db.insertOk({ project, url, strategy, result, keepReport: config.reportRetentionDays > 0 });
        ok++;
      } catch (err) {
        db.insertError({ project, url, strategy, fetchedAt: startedAt, error: err.message });
        console.error(`[scheduler] ${strategy} ${url}: ${err.message}`);
        failed++;
      }
    });

    const pruned = db.pruneOlderThan(Date.now() - config.retentionDays * DAY_MS);
    db.pruneReportsOlderThan(Date.now() - config.reportRetentionDays * DAY_MS);
    status.lastCycle = { ok, failed };
    const seconds = ((Date.now() - status.lastStartedAt) / 1000).toFixed(1);
    console.log(`[scheduler] cycle done in ${seconds}s: ${ok} ok, ${failed} failed, ${pruned} pruned`);
  }

  cycle();
  setInterval(cycle, intervalMs);
  return status;
}
