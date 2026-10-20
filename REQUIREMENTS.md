# PageSpeed Insights Dashboard — Requirements

## 1. Goal

Continuously monitor a configurable set of web pages, grouped by project, using the
Google PageSpeed Insights (PSI) API, and publish the results on a public, read-only
dashboard.

## 2. Functional requirements

### FR-1 Project → URL mapping (maintained in code)
- The list of monitored pages is defined in `src/config/projects.js` as a mapping of
  **project name → list of page URLs**.
- Adding/removing a project or URL is a code change + restart; no admin UI.
- Config is validated on startup (non-empty project names, valid `http(s)` URLs,
  no duplicate URL within a project). Invalid config stops the app with a clear error.

### FR-2 Scheduled fetching
- Every **15 minutes** (configurable via `FETCH_INTERVAL_MINUTES`) the app calls
  `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed` for **every URL**,
  once with `strategy=MOBILE` and once with `strategy=DESKTOP`.
- Categories requested: performance, accessibility, best-practices, seo.
- A run starts immediately on startup, then on every interval.
- If a cycle is still running when the next one is due, the new cycle is skipped
  (no overlapping cycles).
- Requests run with bounded concurrency (`FETCH_CONCURRENCY`, default 4) and a
  per-request timeout. 429/5xx responses are retried once.
- Failed requests are recorded as an **error hit** (with the error message) so gaps
  are visible on the dashboard.

### FR-3 Storage
- Every hit is stored with: project, URL, strategy, timestamp, status, the four
  category scores, lab metrics (FCP, LCP, TBT, CLS, Speed Index), and a compact
  report (failing audits per category, field/CrUX data, Lighthouse version).
- The full Lighthouse JSON of each hit is also stored, gzipped (≈330 KB per hit), for
  `REPORT_RETENTION_DAYS` (default 7). After that only the summary above is kept.
- Hits older than `RETENTION_DAYS` (default 30) are pruned automatically.

### FR-4 Public dashboard (no login)
- **Latest scores** table: one row per project/URL with the latest mobile and desktop
  performance score and links to those reports.
- **Score graph**: line chart of score over time, mobile (solid) and desktop (dashed)
  series per URL.
- **Filters**: project, URL, device (mobile / desktop / both), metric
  (performance / accessibility / best practices / SEO), time range
  (1h, 6h, 24h, 7d, 30d, custom from–to). Filters are reflected in the page URL so
  a filtered view can be shared.
- **Hit history** table: every hit in the filtered range, showing the time, the page
  URL that was tested, device, scores, and a **"Click here to see report"** link for
  that individual hit. Paginated.
- Dashboard data auto-refreshes every **30 seconds**, and the header says so with a
  countdown, so users don't need to reload the page. Refresh pauses while the browser tab
  is hidden and while a custom time range is selected.

### FR-5 Per-hit report page
- `/report/:id` is a permanent link to the report of one hit. While the full Lighthouse
  JSON is retained it shows the **full Lighthouse report** for that exact hit, rendered with
  Google's own Lighthouse report renderer (same layout as pagespeed.web.dev).
- Once the full report has expired it shows the stored summary: category scores, lab
  metrics, field data (if available), and the failing audits per category.
- Both include a link back to the dashboard and a link to re-run the analysis on
  pagespeed.web.dev.
- Note: the PSI API does not return a pagespeed.web.dev saved-report link
  (`/analysis/<site>/<id>`); those IDs only exist for tests run on that website.

### FR-6 Availability and response time by location (India)
- Every `UPTIME_INTERVAL_MINUTES` (default 15) each URL is fetched with an HTTP GET from
  probes in Indian cities (`UPTIME_LOCATIONS`, default Mumbai, Delhi, Bengaluru,
  Hyderabad, Chennai, Pune), using the free Globalping probe network.
- A check is **up** when the response status is below 400. A timeout, connection error or
  4xx/5xx counts as **down**. If no probe is available in a city, nothing is recorded
  (that is not the site's fault).
- The dashboard shows a table per location for the selected project/URL and time range:
  availability %, down duration, number of downtimes (runs of consecutive failed checks),
  last downtime, and average response time as a stacked bar (DNS, connection, SSL
  handshake, first byte, download) with the total.
- Rate limit: 250 Globalping tests/hour anonymously (1 test = 1 URL × 1 city). An optional
  `GLOBALPING_TOKEN` raises it. The app warns at startup if the configuration would exceed it.

### FR-7 Defaults and presentation
- The dashboard opens on the project named in `defaultProject` (`src/config/projects.js`).
- KPI tiles at the top: latest mobile and desktop performance score, availability across
  India, and average response time across India.
- Light and dark themes, following the OS setting.

## 3. Non-functional requirements

### NFR-1 Secret handling
- The PSI API key is read from `PSI_API_KEY` in a local `.env` file.
- `.env` is listed in `.gitignore` and must never be committed; `.env.example`
  (no real values) is committed instead.
- The key is used only server-side: it is never sent to the browser, never logged,
  and is redacted from any stored/displayed error message.
- Recommended: restrict the key in Google Cloud Console to the PageSpeed Insights API
  only.

### NFR-2 Public exposure
- The public surface is read-only: no endpoint can trigger fetches or change data.
- Only whitelisted static files are served (no directory traversal).
- Security headers: Content-Security-Policy (`'self'` only, no CDN), `nosniff`,
  `frame-ancestors 'none'`, referrer policy.
- All data rendered in the browser is inserted as text (no HTML injection).

### NFR-3 Quota
- PSI quota: 25,000 requests/day and 400 requests/100 s per project.
- 1 URL × 2 strategies × 96 cycles/day = **192 requests/day per URL**, so
  ~130 URLs is the practical maximum at a 15-minute interval. The app logs a warning
  at startup if the configured URLs would exceed the daily quota.

## 4. Tech stack
- Node.js ≥ 22.13 (built-in `fetch`, `node:sqlite`, `--env-file`).
- SQLite database file (`data/psi.db`, git-ignored).
- Plain HTML/CSS/JS frontend with Chart.js (served locally from `node_modules`).
