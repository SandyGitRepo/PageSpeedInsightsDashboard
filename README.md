# PageSpeed Insights Dashboard

Checks a list of pages with the Google PageSpeed Insights API every hour on the hour (01:00,
02:00, …), on mobile and desktop, and shows the results on a public, read-only dashboard. See
[REQUIREMENTS.md](REQUIREMENTS.md) for the full spec.

**Free for anyone to use.** This project is open source under the [MIT License](LICENSE): anyone
can clone it and use it to monitor the speed, availability and response time of their own
websites. Add your pages to [src/config/projects.js](src/config/projects.js), bring your own free
PageSpeed Insights API key, and run it.

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

`uptimeUrls` in the same file lists the URLs that also get availability and response-time checks
from Indian cities. Every other URL gets PageSpeed checks only:

```js
export const uptimeUrls = ['https://www.example.com/'];
```

The config is validated at startup. Each URL costs 48 PSI requests/day at the default hourly
interval (24 checks × mobile and desktop), and the default quota is 25,000/day, so the limit is
about 520 URLs. The app warns if you go over.

Checks run on the clock (server local time): with `FETCH_INTERVAL_MINUTES=60` that means 00:00,
01:00, 02:00 and so on, which is 24 hits per URL and device per day. Restarting the server doesn't add
an extra check. The only exception is a fresh install with an empty database, where the first check
runs immediately.

## Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PSI_API_KEY` | — (required) | Google API key. Server-side only; never sent to the browser or logged. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen address |
| `FETCH_INTERVAL_MINUTES` | `60` | How often each URL is checked, aligned to the clock (60 = every hour on the hour) |
| `FETCH_CONCURRENCY` | `4` | Parallel PSI requests |
| `REQUEST_TIMEOUT_SECONDS` | `120` | Per-request timeout |
| `RETENTION_DAYS` | `30` | Older hits are deleted |
| `REPORT_RETENTION_DAYS` | `7` | How long each hit's full Lighthouse report is kept (≈330 KB each); `0` = never keep |
| `UPTIME_LOCATIONS` | `Mumbai,Delhi,Bengaluru,Hyderabad,Chennai,Pune` | Indian cities to check availability/response time from (empty = off) |
| `UPTIME_INTERVAL_MINUTES` | `15` | How often each `uptimeUrls` URL is checked from each city, aligned to the clock (:00, :15, …) |
| `GLOBALPING_TOKEN` | — (optional) | Free [Globalping](https://dash.globalping.io) token for a higher hourly limit (anonymous: 250 tests/hour) |
| `DB_PATH` | `./data/psi.db` | SQLite file |

`.env` and `data/` are git-ignored. Only `.env.example` is committed.

## Dashboard

- `/`: KPI tiles, latest mobile/desktop scores, a score-over-time chart (solid = mobile, dashed = desktop),
  availability and response time by Indian city (Globalping probes),
  and a paginated history of every hit, each with a **Click here to see report** link.
  You can filter by project, URL, device, metric (performance, accessibility, best practices,
  SEO) and time range. Filters are kept in the URL, so filtered views can be shared.
- **Export to Excel** (button at the top of `/`): downloads an `.xlsx` report of the current view
  (same filters and time range). It opens on an **Overview** sheet with the report scope, the key
  figures and a table of contents that links to each section sheet and to the same section on the
  live dashboard. The section sheets are **Latest scores**, **Score trend**, **Availability** and
  **Hit history**. Each one has native, editable Excel charts, color-coded score bands and a link to
  every run's report. The file is built in the browser with no extra dependencies
  ([public/xlsx.js](public/xlsx.js)).
- `/report/:id`: a permanent link to one hit's report. It shows the full Lighthouse report,
  rendered with Google's renderer (vendored in [vendor/lighthouse/](vendor/lighthouse/)), for
  `REPORT_RETENTION_DAYS`. After that it shows a stored summary.

JSON API (read-only): `/api/projects`, `/api/latest`,
`/api/runs?project=&url=&strategy=&from=&to=` (epoch ms), `/api/runs/:id`,
`/api/runs/:id/lighthouse.json`, `/api/uptime?project=&url=&from=&to=`, `/healthz`.

## Deploying publicly

The app has no write endpoints. Put it behind a reverse proxy (nginx, Caddy, Cloudflare)
for TLS and rate limiting. Keep `data/` on persistent storage.

The pages use relative URLs, so the app also works under a path prefix such as
`https://example.com/projects/psi/`. Have the proxy strip the prefix (nginx:
`location /projects/psi/ { proxy_pass http://127.0.0.1:3000/; }`) and redirect the
prefix without its trailing slash to the one with it.

## License

[MIT](LICENSE). Free to use, modify and share, including for monitoring your own or your clients'
websites.
