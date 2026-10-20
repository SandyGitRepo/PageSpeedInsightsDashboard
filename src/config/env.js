import path from 'node:path';

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

export function loadConfig() {
  return Object.freeze({
    apiKey: (process.env.PSI_API_KEY ?? '').trim(),
    port: int('PORT', 3000, 1, 65535),
    host: process.env.HOST?.trim() || '0.0.0.0',
    intervalMinutes: int('FETCH_INTERVAL_MINUTES', 15, 1, 1440),
    concurrency: int('FETCH_CONCURRENCY', 4, 1, 20),
    requestTimeoutMs: int('REQUEST_TIMEOUT_SECONDS', 120, 10, 600) * 1000,
    retentionDays: int('RETENTION_DAYS', 30, 1, 3650),
    reportRetentionDays: int('REPORT_RETENTION_DAYS', 7, 0, 3650),
    dbPath: path.resolve(process.env.DB_PATH?.trim() || './data/psi.db'),
    uptime: {
      locations: (process.env.UPTIME_LOCATIONS ?? 'Mumbai,Delhi,Bengaluru,Hyderabad,Chennai,Pune')
        .split(',')
        .map((city) => city.trim())
        .filter(Boolean),
      intervalMinutes: int('UPTIME_INTERVAL_MINUTES', 15, 1, 1440),
      token: (process.env.GLOBALPING_TOKEN ?? '').trim(),
    },
  });
}
