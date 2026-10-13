# Seeded throwaway AoNarr instance

A self-contained AoNarr (the exact image that is deployed) filled with **fictional** content, so every
page of the UI renders realistic, non-empty data. It exists for the redesign test package
(screenshots, axe, Tab-walk). It never talks to the live instance or any real service.

Everything here is generated: nothing is committed except these scripts. Runtime data lives in
`web-e2e/.tmp/` and `web-e2e/.auth/`, both gitignored.

## Quick start

From the repo root, in Git Bash (or `bash web-e2e/seed/start.sh` from PowerShell):

```bash
bash web-e2e/seed/start.sh            # fresh empty config -> container -> seed -> verify   (~16 s)
bash web-e2e/seed/start.sh --no-seed  # container only, first-run state
bash web-e2e/seed/stop.sh             # remove the container (config kept)
bash web-e2e/seed/stop.sh --purge     # remove the container + generated config/credentials
node web-e2e/seed/verify.mjs          # re-run the read-only count check against the running instance
```

Open `http://127.0.0.1:8989/`. Every `start.sh` throws the old config away, so it is also the
**reset**: the fixtures are re-created byte-for-byte (except the items listed under "Host-dependent").

Restart without re-seeding (keeps data, credentials and the frozen scheduler):

```bash
docker restart aonarr-e2e      # or: docker start aonarr-e2e after a stop
```

### Equivalent plain commands

`start.sh` boils down to this (paths relative to the repo root; values in `<...>` are generated):

```bash
rm -rf web-e2e/.tmp/config && mkdir -p web-e2e/.tmp/config web-e2e/.auth/secrets
# write admin_username / admin_password (random) to web-e2e/.auth/secrets/, same values to .auth/test-creds.json
docker run -d --name aonarr-e2e --label aonarr-e2e=1 \
  --dns 127.0.0.1 \
  -p 127.0.0.1:8989:9876 \
  -v "<abs>/web-e2e/.tmp/config:/config" \
  -v "<abs>/web-e2e/.auth/secrets:/run/secrets/e2e:ro" \
  -e TZ=UTC -e PUID=99 -e PGID=100 \
  -e AONARR_ADMIN_USERNAME_FILE=/run/secrets/e2e/admin_username \
  -e AONARR_ADMIN_PASSWORD_FILE=/run/secrets/e2e/admin_password \
  -e AONARR_QUEUE_POLL_SECONDS=86400 -e AONARR_SEARCH_INTERVAL_MINUTES=43200 \
  allornothing/aonarr:combined
# wait for http://127.0.0.1:8989/api/health, then:
node web-e2e/seed/seed.mjs
```

On Git Bash set `MSYS_NO_PATHCONV=1` so container paths such as `/config` are not rewritten.
`docker rm -f aonarr-e2e` is the whole teardown.

## What runs where

| Thing | Value |
|---|---|
| Image | `allornothing/aonarr:combined` (digest `sha256:d53ba7fa...`, same as `combined-rd-w0`), never pulled |
| Container | `aonarr-e2e` (only this name is ever touched) |
| Published port | `127.0.0.1:8989` -> container **9876** (nginx: UI + `/api/` proxy) |
| Internal ports | nginx **9876** (published), node **8989** (not published; nginx proxies `/api/` to it) |
| Config volume | `web-e2e/.tmp/config` -> `/config` (SQLite WAL works on this bind mount) |
| Media / downloads mounts | none. `/media/**` and `/downloads` are plain dirs inside the container |
| Network | `--dns 127.0.0.1`: no hostname resolves, so nothing can reach a real service even if a job tried |
| Telemetry | `DO_NOT_TRACK=1` is set by every script; the app itself has none |
| Credentials | random per start in `web-e2e/.auth/test-creds.json` (`adminUsername`, `adminPassword`, `householdUsername`, `householdPassword`), never printed. The admin is bootstrapped from `AONARR_ADMIN_USERNAME_FILE` / `AONARR_ADMIN_PASSWORD_FILE` (password >= 8 chars) |
| Manifest | `web-e2e/.auth/seed-manifest.json`: ids and tokens for every dynamic route parameter |

### How tests should authenticate

The UI keeps its credential in `localStorage` (web/src/api/client.ts). For a Playwright `storageState`, log in
through the API and set:

* `aonarr_session_token` = the `token` from `POST /api/auth/login` (send header `X-Requested-With: AoNarr`)
* optional UI prefs: `aonarr_theme` (`light`), `aonarr_design` (`midnight|aurora|ember|noir|paper|terminal`),
  `aonarr_layout_width` (`full`), `aonarr_sidebar_collapsed` (`0|1`), `aonarr_nav_position` (`side|top`),
  `aonarr_recent_searches` (JSON array of strings)

`aonarr_api_key` is the other credential key; do not set both (the client removes the other one).

### Things that affect Playwright

* The container's nginx sends this CSP on every page (not on `/sw.js`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https: http:; img-src 'self' data: blob: https: http:; font-src 'self' data: https: http:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'`.
  `page.evaluate`, axe injection through `evaluate`, and storage setup are unaffected. `page.addScriptTag({ content })`
  (inline script) is blocked: use `bypassCSP: true` on the context if a tool needs it. Inline `<style>` is allowed.
  Every seeded image is a `data:` URI, which `img-src` allows.
* A service worker (`/sw.js`) is registered on load; use `serviceWorkers: "block"` so it never caches between runs.
* Dates render in the browser's zone: use `timezoneId: "UTC"` and `locale: "en-US"` (the container itself runs `TZ=UTC`).
* Text in the generated posters uses the host's generic `sans-serif` font, stable on one machine.

## What the seed does

Phase A, through the HTTP API as the test admin: freezes the scheduler (see below), creates three household
users (accounts need password hashing), four indexers and four download clients (credentials are encrypted at rest).
Phase B, direct SQLite inside the container (the container's own `better-sqlite3`; the host copy is a Linux
build): everything the API cannot create, or that would call external metadata providers if created through it.
The plan is built on the host (`lib/fixtures.mjs`, `lib/media.mjs`), copied in as `/tmp/aonarr-e2e-plan.json`
with `lib/container-apply.mjs`, applied in one transaction, then both temp files are deleted.

All dates derive from `FIXED_NOW = 2026-10-13T12:00:00Z` (`lib/util.mjs`); randomness comes from named, fixed-seed
streams. Two fresh seeds produce identical rows (checked by hashing 43 tables; see "Host-dependent").

### Seeded content (counts from the last verified run)

* **Libraries (59 items):** 26 movies (incl. a duplicate pair, an unmatched one, unmonitored, unreleased, missing,
  cutoff-unmet and 3 releasing 3/10/13 days after FIXED_NOW), 8 TV shows (162 episodes incl. complete, partial,
  airing, all-missing, daily, unmonitored, cutoff-unmet), 2 anime, 1 sports league, 1 course, 2 PPV, 4 music artists
  (11 albums, tracks), 4 authors (books with series), 2 audiobooks (multi-part), 2 comics, 1 manga, 4 ROMs (2 groups,
  one ungrouped), 1 podcast, 1 online-video channel. 249 sparse placeholder files back every downloaded item.
* **Config:** 15 root folders (fake container paths, some with quota/min-free), 3 quality profiles, custom formats and
  scores, release and delay profiles, 5 tags, 4 collections (one smart), custom columns, saved library views,
  4 indexers, 4 download clients (qBittorrent, SABnzbd, direct HTTP, disabled blackhole), remote path mapping,
  AI providers, IRC feed (disabled), 2 IPTV playlists with items and fillers, friend libraries, a remote instance.
  Every host/URL is `127.0.0.1:9`, where nothing listens.
* **Activity:** 10 queue rows (downloading, queued, completed-not-imported, failed, one stuck), 134 history events,
  10 blocklist entries, 12 watch events, 5 recycle-bin entries, 2 corrupt-media reviews, 1 duplicate group,
  3 import lists, 9 import-review items, 4 import exclusions, 3 custom calendar events, 14 calendar entries between
  2026-10-14 and 2026-10-26, 150 backdated audit rows plus the setup events, 210 disk-usage samples (15 folders x 14 days), 96 indexer-health samples, 4 placeholder backup files.
* **People:** `e2e-admin`, `e2e-household` (7 libraries, max rating TV-14, 5 pending requests allowed), `guest-alex`
  (auto-approve, movies), `guest-sam` (series/anime) with unrecorded random passwords, 3 fake sessions, 9 requests
  (pending, approved, rejected).
* **Public pages:** valid, expired and missing share tokens; valid, used, expired and missing invite tokens
  (all in the manifest under `params`).

### The scheduler is frozen on purpose

Every job is moved to `0 0 1 1 *` (next run 2027-01-01) and the queue poll to 86400 s, so nothing mutates the fixtures
or tries the network while tests run. The Jobs page therefore shows real job names with next-run times in 2027 and an
empty "last run" column. `diskUsageSamplesUsableSpace=1` is set so the app does not wipe the seeded samples on first use.

## Verification

`verify.mjs` (also run at the end of `seed.mjs`) logs in with the generated credentials and does GET requests only:
121 checks across the admin list endpoints the UI uses for counts, the per-type library endpoints, a household session
(including "a library not granted returns 0"), the public share/invite endpoints with their expected 200/404/410, and
`GET /`. It flags non-2xx responses and row counts below the expected minimum, and exits 1 if anything is flagged.
It deliberately skips `/system/update-check` (that endpoint tries the internet).

## Known gaps (pages that render empty or in an error state, and why)

| Page / panel | State | Why |
|---|---|---|
| `/people/:tmdbId` | cannot render | needs TMDB person data; no key, no network. `personTmdbId` is `null` in the manifest |
| Cast, Trailer, Alternate titles, Ratings panels on media pages | empty / error | external metadata providers |
| `/discover`, `/recommendations` | "TMDB API key is not configured" / "Nothing to suggest yet" | external providers |
| `/add`, `/add/preview`, global-search "Add new" | form only / empty results | metadata search is external; `/add/preview` also needs router state |
| `/search` | empty until a query is typed (library hits for e.g. `harbor`) | query is React state, not in the URL |
| Interactive search / "Search now" on any item | no releases | every indexer is an unreachable placeholder |
| Manual import file pickers | empty | `/downloads` has no real files |
| `/network-stats` qBittorrent row | "fetch failed" | placeholder client |
| `/remote-library`, friend library Compare | lists the seeded entry, browsing fails | placeholder URL |
| `/watchlist-import` | upload form | nothing to seed |
| `/library/adult` | empty by design | no Adult content is seeded |
| Background Jobs widget | hidden | in-memory state; empty on a fresh instance, entries expire 60 s after finishing |
| `/jobs` "Last run" / "Last result" | "Never" | no job has run (scheduler is frozen) |
| Settings -> Metadata Providers, Notifications, media-server sync | unconfigured defaults | would need keys / external services |

## Host-dependent or time-dependent output (mask these in pixel baselines)

* Root-folder free/total space, `System` memory/CPU/uptime and `disk_usage_samples` come from the live container and Docker VM.
* The calendar, the dashboard "Upcoming" widget, and the "Unreleased" poster banner compare with the **real current day**,
  not `FIXED_NOW`. The three movies releasing 2026-10-16 / 10-23 / 10-26 and the episodes airing 2026-10-15 / 10-22 flip
  state as real time passes. The full list is in the manifest under `timeSensitivePages`.
* Every test login appends an audit row, a session and an `Active Sessions` entry.
* Stuck-queue warnings on `/system` appear for queue rows older than 6 real hours (the seeded queue rows pass that by 2026-10-13T18:00Z).
