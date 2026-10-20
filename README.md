# PageSpeed Insights Dashboard

Checks a list of pages with the Google PageSpeed Insights API every 15 minutes, on mobile and
desktop, and shows the results on a public, read-only dashboard. See
[REQUIREMENTS.md](REQUIREMENTS.md) for the full spec.

## Setup

Requires Node.js 22.13 or newer (uses the built-in `fetch`, `node:sqlite` and `--env-file`).

```sh
npm install
cp .env.example .env      # then put your key in PSI_API_KEY
npm start                 # http://localhost:3000
```

Get an API key at <https://developers.google.com/speed/docs/insights/v5/get-started#APIKey>.
In Google Cloud Console, restrict the key to the **PageSpeed Insights API**.

## Configuring pages

Edit [src/config/projects.js](src/config/projects.js) and restart:

```js
export const projects = {
  'Marketing site': ['https://www.example.com/', 'https://www.example.com/pricing'],
  'Docs': ['https://docs.example.com/'],
};
```

`defaultProject` in the same file sets the project the dashboard opens on (`''` = all projects).

The config is validated at startup. Each URL costs 192 PSI requests/day at a 15-minute interval,
and the default quota is 25,000/day, so the limit is about 130 URLs. The app warns if you go over.

## Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PSI_API_KEY` | — (required) | Google API key. Server-side only; never sent to the browser or logged. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen address |
| `FETCH_INTERVAL_MINUTES` | `15` | How often each URL is checked |
| `FETCH_CONCURRENCY` | `4` | Parallel PSI requests |
| `REQUEST_TIMEOUT_SECONDS` | `120` | Per-request timeout |
| `RETENTION_DAYS` | `30` | Older hits are deleted |
| `REPORT_RETENTION_DAYS` | `7` | How long each hit's full Lighthouse report is kept (≈330 KB each); `0` = never keep |
| `UPTIME_LOCATIONS` | `Mumbai,Delhi,Bengaluru,Hyderabad,Chennai,Pune` | Indian cities to check availability/response time from (empty = off) |
| `UPTIME_INTERVAL_MINUTES` | `15` | How often each URL is checked from each city |
| `GLOBALPING_TOKEN` | — (optional) | Free [Globalping](https://dash.globalping.io) token for a higher hourly limit (anonymous: 250 tests/hour) |
| `DB_PATH` | `./data/psi.db` | SQLite file |

`.env` and `data/` are git-ignored. Only `.env.example` is committed.

## Dashboard

- `/`: KPI tiles, latest mobile/desktop scores, a score-over-time chart (solid = mobile, dashed = desktop),
  availability and response time by Indian city (Globalping probes),
  and a paginated history of every hit, each with a **Click here to see report** link.
  You can filter by project, URL, device, metric (performance, accessibility, best practices,
  SEO) and time range. Filters are kept in the URL, so filtered views can be shared.
- `/report/:id`: a permanent link to one hit's report. It shows the full Lighthouse report,
  rendered with Google's renderer (vendored in [vendor/lighthouse/](vendor/lighthouse/)), for
  `REPORT_RETENTION_DAYS`. After that it shows a stored summary.

JSON API (read-only): `/api/projects`, `/api/latest`,
`/api/runs?project=&url=&strategy=&from=&to=` (epoch ms), `/api/runs/:id`,
`/api/runs/:id/lighthouse.json`, `/api/uptime?project=&url=&from=&to=`, `/healthz`.

## Deploying publicly

The app has no write endpoints. Put it behind a reverse proxy (nginx, Caddy, Cloudflare)
for TLS and rate limiting. Keep `data/` on persistent storage.
