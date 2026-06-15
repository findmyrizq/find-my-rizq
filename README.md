# Find My Rizq

A values-first job board that aggregates listings from 9 sources, screens out work tied to alcohol, gambling, interest-based finance, adult content, non-halal food and tobacco, and runs entirely on **Cloudflare's free tier**.

- **Backend:** Cloudflare Worker (scheduled every 10 min) + D1 (SQLite) — all free tier.
- **Frontend:** static page on Cloudflare Pages.
- **Cost:** £0 on free tier for typical volumes. No server to manage.

```
find-my-rizq/
├── src/
│   ├── worker.js        API + cron entry point
│   ├── aggregator.js    fetch cycle, dedup, upsert, expiry
│   ├── connectors.js    all 9 job sources
│   ├── categorizer.js   auto category + tags
│   ├── filter.js        halal / unwanted-job exclusion
│   └── geocode.js       location → coordinates (cached)
├── public/index.html    the website (landing + board + map)
├── migrations/0001_init.sql
├── wrangler.toml        config: cron, D1, sources, filtering
└── package.json
```

## How it works

1. Every 10 minutes the Worker's `scheduled` handler fetches fresh jobs from each configured source, normalises them to one shape, runs the halal filter, auto-categorises and tags, geocodes locations (budgeted, cached), and upserts into D1 keyed by `source:external_id` so nothing duplicates.
2. A separate pass marks jobs `expired` if they haven't been seen for `EXPIRE_AFTER_HOURS` (default 72), optionally hard-deleting old ones.
3. The static page calls `/api/jobs` for the board, `/api/meta` for categories, and links every "Apply" through `/job-go/:id`, which logs the click (bot-filtered), appends affiliate params, then redirects to the source.

---


## New in this version

- **Orange & black brand** with a flame/ember "rizq" identity — animated embers in the hero, gradient flame logo.
- **Prepopulated data** (`migrations/0002_seed.sql`) so the board is full from minute one, before any API keys.
- **Free job posting** with anti-bot protection: a signed math challenge + honeypot field + per-IP rate limit. Submissions never go live automatically.
- **Approval queue + admin panel** (`public/admin.html`): review each submission and approve/reject with one click. Approved jobs become live listings instantly.

## Admin panel

Open `admin.html` (e.g. `https://yoursite.pages.dev/admin.html`), paste your `ADMIN_TOKEN` and Worker URL, and you get:
- Pending submissions with Approve / Reject buttons
- "Run fetch now" button
- Fetch-run history and click-by-source stats

The token is stored only in that browser tab. The page is `noindex`.

## Job submission flow

1. Visitor clicks **Post a job**, fills the form, solves a simple sum (proves they're human), and submits.
2. The Worker verifies the signed challenge, drops obvious bots (honeypot), rate-limits per IP, and stores the job as `pending`.
3. You open the admin panel and **Approve** — it's now a live listing. Or **Reject** — it's gone. Nothing publishes without you.

## Deploy (one-time setup)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js](https://nodejs.org). Everything below is free tier.

### 1. Push to GitHub
Create a new GitHub repo and push this folder to it.

### 2. Install Wrangler & log in
```bash
npm install
npx wrangler login
```

### 3. Create the D1 database
```bash
npm run db:create
```
Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

### 4. Create the tables and load starter data
```bash
npm run db:init
npm run db:seed
```

### 5. Add your secrets
Each command prompts for the value (these are NOT stored in the repo):
```bash
npx wrangler secret put ADMIN_TOKEN          # any long random string
npx wrangler secret put ADZUNA_APP_ID
npx wrangler secret put ADZUNA_APP_KEY
npx wrangler secret put JOOBLE_API_KEY
npx wrangler secret put USAJOBS_API_KEY
npx wrangler secret put USAJOBS_EMAIL
npx wrangler secret put REED_API_KEY
npx wrangler secret put FINDWORK_API_KEY
# optional: MUSE_API_KEY, and *_AFFILIATE_PARAMS for affiliate tracking
```
You don't need all of them — the free no-key sources (Remotive, The Muse, Arbeitnow, Jobicy) work immediately, so you get live data even before adding paid keys.

### 6. Deploy the Worker
```bash
npm run deploy
```
Note the URL it gives you, e.g. `https://find-my-rizq.YOURNAME.workers.dev`.

### 7. Connect the front-end
In `public/index.html`, set:
```js
window.FMR_API_BASE = "https://find-my-rizq.YOURNAME.workers.dev";
```

### 8. Deploy the front-end on Cloudflare Pages
In the Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**, pick your repo, and set:
- Build command: *(none)*
- Build output directory: `public`

Pages gives you a `*.pages.dev` URL. Add your custom domain there when ready.

### 9. Pull the first batch now (don't wait for cron)
```bash
curl -X POST https://find-my-rizq.YOURNAME.workers.dev/api/admin/fetch \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```
Refresh the site — jobs appear.

---

## Where to get API keys

| Source | Key | URL | Notes |
|---|---|---|---|
| Remotive | none | — | on by default |
| The Muse | optional | themuse.com/developers/api/v2 | toggle `MUSE_ENABLED` |
| Arbeitnow | none | — | toggle `ARBEITNOW_ENABLED` |
| Jobicy | none | — | toggle `JOBICY_ENABLED` |
| Adzuna | App ID + Key | developer.adzuna.com | coords + salary |
| Reed | key | reed.co.uk/developers | UK, salary + contract type |
| Jooble | key | jooble.org/api/about | |
| USAJobs | key + email | developer.usajobs.gov | |
| Findwork | key | findwork.dev/developers | tech/remote |

## Configuration (wrangler.toml `[vars]`)

- `SEARCH_QUERIES` — newline list of `keyword | location`. Blank line = broad pull.
- `EXPIRE_AFTER_HOURS` / `DELETE_AFTER_DAYS` — expiry behaviour.
- `ENABLE_GEOCODING` / `GEOCODE_PER_RUN` — map coordinates; budgeted per run to respect OpenStreetMap limits.
- `EXCLUSION_GROUPS` — comma list of: `alcohol, gambling, riba_banking, adult, non_halal_food, tobacco`. Omit to enable all.
- `EXCLUDE_KEYWORDS` — your own block terms.
- `ALLOW_KEYWORDS` — exceptions that keep a job even if a block rule matched (pre-loaded with halal / Islamic-finance terms).
- `EXCLUDE_CATEGORIES` — raw source categories to drop.

Changing a var and re-running `npm run deploy` is all it takes; the next fetch also retroactively removes jobs that now match an exclusion.

## API reference

- `GET /api/jobs?q=&category=&type=&location=&remote=1&salaryMin=&limit=&offset=`
- `GET /api/job/:id`
- `GET /api/meta` — live categories, types, counts, last run
- `GET /job-go/:id` — tracked redirect to source
- `POST /api/admin/fetch` — manual fetch (Bearer `ADMIN_TOKEN`)
- `GET /api/admin/status` — run history + click stats (Bearer `ADMIN_TOKEN`)


## Nearest masjid on listings

For any job with known coordinates (most aggregated sources, or a postcode you can geocode), each card shows the nearest masjid and its distance. This is computed in the browser from the job's lat/lng using the free OpenStreetMap Overpass API (`amenity=place_of_worship`, `religion=muslim`, 5 km radius), and cached per location so it isn't re-queried. Remote roles show no masjid line. No API key or cost.


## Branding assets

- `public/favicon.svg` — scalable favicon (magnifying glass + crescent). Linked in both pages.
- `public/favicon-180.png` — Apple touch icon.
- `public/og-image.png` (1200×630) — social share card for Open Graph + Twitter. Meta tags are already in `index.html`; they reference root-relative paths, so they work once deployed on your domain.

To regenerate the PNGs after editing the SVGs: `pip install cairosvg` then `python3 -c "import cairosvg; cairosvg.svg2png(url='public/og-image.svg', write_to='public/og-image.png', output_width=1200, output_height=630)"`.

## Filter: near a masjid

On the board, the "Near a masjid" toggle (with a 1/2/5 km dropdown) filters to roles whose office is within that distance of a mosque. Distances are resolved per job via Overpass (cached), and remote roles are excluded from the filtered view since they have no fixed location.


## Prayer room indicator (honest data sources)

Each job card shows whether the workplace has a prayer/quiet room. **Important:** Glassdoor has no public API and prohibits scraping, and it has no structured "prayer room" field — so we do **not** use it. Instead the signal is built from sources that are actually permitted and reliable:

1. **Community reports** (primary) — users tap the badge and report Yes/No plus an optional detail (e.g. "3rd floor, wudu nearby"). Stored in your D1 `prayer_rooms` table via `POST /api/prayer-room/report` (honeypot + one-report-per-company-per-IP). Aggregated and served from `GET /api/prayer-room?company=X`.
2. **OpenStreetMap multifaith data** — `religion=multifaith` / `room=prayer` nodes within ~250 m of the office (via Overpass), which is the OSM-documented tag for workplace/airport/university prayer rooms.

Badges are confidence-labelled and never overstate: "yes (N confirmed)", "prayer/quiet room nearby (map data)", or "unconfirmed · tap to report". This grows more accurate as your community contributes.

## Cloudflare & GitHub static-site compatibility

The `public/` folder is a **pure static site** — no build step, no server-side code, no `localStorage`/`sessionStorage`. It runs flawlessly on:
- **Cloudflare Pages** — drag-drop `public/` or connect the repo; `_headers` is applied automatically.
- **GitHub Pages** — push `public/` (a `.nojekyll` file is included so `_headers`/underscore files are served). Note GitHub Pages ignores `_headers`; set headers via Cloudflare if you proxy.

All asset paths are root-relative. The frontend reaches the Worker API purely through `fetch(window.FMR_API_BASE + ...)`, so the static site and the API deploy independently. Every external call (Leaflet, OSM tiles, Overpass, Google favicons, Google Fonts) is HTTPS, CORS-enabled and keyless, and each has a graceful fallback if blocked (SVG map, initials avatar, "unconfirmed" badge), so the page never breaks.

## 10 performance & quality optimisations applied

1. `dns-prefetch` for the map tile + Overpass hosts (faster first map/lookup).
2. `defer` on the Leaflet script so it never blocks page render.
3. `decoding="async"` on company logo images.
4. In-memory API response cache — re-filtering to a previous query is instant, no refetch.
5. Faith lookups (masjid + prayer room) deferred to `requestIdleCallback` so they don't delay first paint.
6. `content-visibility:auto` + `contain-intrinsic-size` on job cards — cheaper rendering of long lists.
7. `color-scheme: dark` meta so native form controls/scrollbars theme correctly.
8. Explicit map container sizing to prevent layout shift (better CLS).
9. JSON-LD structured data (WebSite + SearchAction) for richer search results.
10. Skip-to-content link and focus-visible styles for keyboard/screen-reader accessibility.

## Monetisation notes

- **AdSense** and most job-PPC/affiliate networks require original content and traffic before approval; a pure redirect aggregator can be rejected. Add category/landing copy and useful content around the listings.
- Confirm each source's API terms allow redirecting users and showing ads alongside their data. Put any affiliate/publisher params in `<SOURCE>_AFFILIATE_PARAMS` (e.g. `ADZUNA_AFFILIATE_PARAMS = "subid={job_id}"`).
- Click logs in `click_stats` are yours for reporting; payouts come from whatever programme you join per source.

## A note on the filtering

Keyword screening is a strong first pass, not a fatwa. A role's permissibility can hinge on details no keyword can see, so review listings yourself and treat the allow-list as your main tuning tool.
