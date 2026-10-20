import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

const SUMMARY_COLUMNS = `id, project, url, strategy, fetched_at, status, error,
  performance, accessibility, best_practices, seo, fcp_ms, lcp_ms, tbt_ms, cls, si_ms`;

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project        TEXT    NOT NULL,
      url            TEXT    NOT NULL,
      strategy       TEXT    NOT NULL CHECK (strategy IN ('mobile', 'desktop')),
      fetched_at     INTEGER NOT NULL,
      status         TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
      error          TEXT,
      performance    INTEGER,
      accessibility  INTEGER,
      best_practices INTEGER,
      seo            INTEGER,
      fcp_ms         REAL,
      lcp_ms         REAL,
      tbt_ms         REAL,
      cls            REAL,
      si_ms          REAL,
      details        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_fetched_at ON runs (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_runs_target ON runs (project, url, strategy, fetched_at);
    -- Full Lighthouse result per hit, gzipped JSON; pruned sooner than runs.
    CREATE TABLE IF NOT EXISTS reports (
      run_id   INTEGER PRIMARY KEY,
      lhr_gzip BLOB    NOT NULL
    );
    -- Availability/response-time checks from probe locations (Globalping).
    CREATE TABLE IF NOT EXISTS uptime_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project       TEXT    NOT NULL,
      url           TEXT    NOT NULL,
      location      TEXT    NOT NULL,
      checked_at    INTEGER NOT NULL,
      up            INTEGER NOT NULL,
      status_code   INTEGER,
      error         TEXT,
      dns_ms        REAL,
      tcp_ms        REAL,
      tls_ms        REAL,
      first_byte_ms REAL,
      download_ms   REAL,
      total_ms      REAL,
      network       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_uptime_target ON uptime_checks (project, url, location, checked_at);
    CREATE INDEX IF NOT EXISTS idx_uptime_checked_at ON uptime_checks (checked_at);
  `);

  const insert = db.prepare(`
    INSERT INTO runs (project, url, strategy, fetched_at, status, error,
      performance, accessibility, best_practices, seo, fcp_ms, lcp_ms, tbt_ms, cls, si_ms, details)
    VALUES (:project, :url, :strategy, :fetchedAt, :status, :error,
      :performance, :accessibility, :bestPractices, :seo, :fcpMs, :lcpMs, :tbtMs, :cls, :siMs, :details)
  `);
  const insertReport = db.prepare('INSERT INTO reports (run_id, lhr_gzip) VALUES (?, ?)');
  const getReport = db.prepare('SELECT lhr_gzip FROM reports WHERE run_id = ?');
  const getById = db.prepare(`
    SELECT ${SUMMARY_COLUMNS}, details,
      EXISTS (SELECT 1 FROM reports WHERE run_id = runs.id) AS has_full_report
    FROM runs WHERE id = ?
  `);
  const latest = db.prepare(`
    SELECT ${SUMMARY_COLUMNS} FROM runs r
    WHERE status = 'ok' AND fetched_at = (
      SELECT MAX(fetched_at) FROM runs
      WHERE project = r.project AND url = r.url AND strategy = r.strategy AND status = 'ok'
    )
  `);
  const insertUptime = db.prepare(`
    INSERT INTO uptime_checks (project, url, location, checked_at, up, status_code, error,
      dns_ms, tcp_ms, tls_ms, first_byte_ms, download_ms, total_ms, network)
    VALUES (:project, :url, :location, :checkedAt, :up, :statusCode, :error,
      :dns, :tcp, :tls, :firstByte, :download, :total, :network)
  `);
  const pruneUptime = db.prepare('DELETE FROM uptime_checks WHERE checked_at < ?');
  const pruneRuns = db.prepare('DELETE FROM runs WHERE fetched_at < ?');
  const pruneReports = db.prepare(
    'DELETE FROM reports WHERE run_id IN (SELECT id FROM runs WHERE fetched_at < ?)',
  );

  return {
    insertOk({ project, url, strategy, result, keepReport }) {
      const lhrGzip = keepReport ? gzipSync(JSON.stringify(result.lhr)) : null;
      db.exec('BEGIN');
      try {
        const { lastInsertRowid } = insert.run({
          project,
          url,
          strategy,
          fetchedAt: result.fetchedAt,
          status: 'ok',
          error: null,
          ...result.scores,
          ...result.metrics,
          details: JSON.stringify(result.details),
        });
        if (lhrGzip) insertReport.run(lastInsertRowid, lhrGzip);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    insertError({ project, url, strategy, fetchedAt, error }) {
      insert.run({
        project,
        url,
        strategy,
        fetchedAt,
        status: 'error',
        error,
        performance: null,
        accessibility: null,
        bestPractices: null,
        seo: null,
        fcpMs: null,
        lcpMs: null,
        tbtMs: null,
        cls: null,
        siMs: null,
        details: null,
      });
    },

    listRuns({ project, url, strategy, from, to, limit }) {
      const where = ['fetched_at >= :from', 'fetched_at <= :to'];
      const params = { from, to, limit };
      if (project) (where.push('project = :project'), (params.project = project));
      if (url) (where.push('url = :url'), (params.url = url));
      if (strategy) (where.push('strategy = :strategy'), (params.strategy = strategy));
      return db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM runs WHERE ${where.join(' AND ')}
           ORDER BY fetched_at DESC, id DESC LIMIT :limit`,
        )
        .all(params);
    },

    getRun(id) {
      const row = getById.get(id);
      if (!row) return null;
      const { has_full_report: hasFullReport, ...rest } = row;
      return { ...rest, hasFullReport: Boolean(hasFullReport), details: row.details ? JSON.parse(row.details) : null };
    },

    // Gzipped Lighthouse JSON for a run, or null if it was never kept / already pruned.
    getReportGzip: (runId) => getReport.get(runId)?.lhr_gzip ?? null,

    latestRuns: () => latest.all(),

    pruneReportsOlderThan: (cutoff) => pruneReports.run(cutoff).changes,

    insertUptime({ project, url, location, checkedAt, up, statusCode, error, timings, network }) {
      const t = (key) => (Number.isFinite(timings?.[key]) ? timings[key] : null);
      insertUptime.run({
        project,
        url,
        location,
        checkedAt,
        up: up ? 1 : 0,
        statusCode,
        error,
        dns: t('dns'),
        tcp: t('tcp'),
        tls: t('tls'),
        firstByte: t('firstByte'),
        download: t('download'),
        total: t('total'),
        network,
      });
    },

    // Per project/URL/location: availability, outage count (runs of consecutive down checks),
    // last outage, and average timings of successful checks.
    uptimeSummary({ project, url, from, to }) {
      const where = ['checked_at >= :from', 'checked_at <= :to'];
      const params = { from, to };
      if (project) (where.push('project = :project'), (params.project = project));
      if (url) (where.push('url = :url'), (params.url = url));
      return db
        .prepare(
          `SELECT project, url, location,
             COUNT(*) AS checks,
             SUM(up) AS up_checks,
             SUM(CASE WHEN up = 0 AND (prev_up IS NULL OR prev_up = 1) THEN 1 ELSE 0 END) AS downtimes,
             MAX(CASE WHEN up = 0 THEN checked_at END) AS last_down_at,
             MAX(checked_at) AS last_checked_at,
             AVG(CASE WHEN up = 1 THEN dns_ms END) AS dns_ms,
             AVG(CASE WHEN up = 1 THEN tcp_ms END) AS tcp_ms,
             AVG(CASE WHEN up = 1 THEN tls_ms END) AS tls_ms,
             AVG(CASE WHEN up = 1 THEN first_byte_ms END) AS first_byte_ms,
             AVG(CASE WHEN up = 1 THEN download_ms END) AS download_ms,
             AVG(CASE WHEN up = 1 THEN total_ms END) AS total_ms
           FROM (
             SELECT *, LAG(up) OVER (PARTITION BY project, url, location ORDER BY checked_at) AS prev_up
             FROM uptime_checks WHERE ${where.join(' AND ')}
           )
           GROUP BY project, url, location`,
        )
        .all(params);
    },

    pruneUptimeOlderThan: (cutoff) => pruneUptime.run(cutoff).changes,

    pruneOlderThan(cutoff) {
      pruneReports.run(cutoff);
      return pruneRuns.run(cutoff).changes;
    },
  };
}
