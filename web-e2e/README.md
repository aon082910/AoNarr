# web-e2e: the redesign sweep package

A self-contained Playwright package (own `package.json` + `package-lock.json`) that sweeps the AoNarr web app on a
**seeded throwaway instance**: route manifest, smoke checks, Classic pixel baselines, an axe ratchet, a keyboard
Tab-walk, and a self-test that proves the judge can fail. It is Phase 0, item 5 of
`reports/AoNarr six concept redesign plan.md`.

> **Rule: tooling never goes into `web/package.json`** (or `server/`). Everything here installs and runs inside
> `web-e2e/`. Nothing in this package writes under `web/`, `server/`, a Dockerfile, `combined/` or `.github/`.

## Layout

```
web-e2e/
  package.json / package-lock.json      exact pins (see "Versions")
  playwright.config.ts                  the 28-project sweep
  playwright.meta.config.ts             judge self-test (1 Classic project)
  playwright.drift.config.ts            route drift only (no browser, no server)
  config/shared.ts, config/base.ts      designs, themes, viewports, paths, context options, webServer
  scripts/build-web.mjs, serve-web.mjs  build + serve the CURRENT web/ working tree into .tmp/ (no web/ output touched)
  scripts/static-server.mjs             the plain node:http static server + /api proxy that serve-web.mjs starts
  scripts/update-baselines.mjs          the only way baselines get (re)written
  scripts/matrix-report.mjs             .tmp/matrix-findings.md from a full 28-project run
  scripts/contact-sheet.mjs             .tmp/contact-sheet.html (route x design grid, theme/viewport selectable)
  scripts/readonly-proof.mjs            counts the requests that reached the container (docker logs of aonarr-e2e only)
  tests/routes.ts                       route manifest (ids, params from the seed manifest, roles, masks, known gaps)
  tests/*.spec.ts                       routes-drift, smoke, screenshots, a11y, tabwalk, judge-selftest
  tests/lib/*                           helpers shared by the specs AND the self-test
  tests/lib/browser-helpers.js          the in-page measurements (window.__e2e)
  baselines/                            committed-by-the-owner results (screens/, axe, tab-walk, allow-list, APPROVALS.md)
  seed/                                 the seeded instance (see seed/README.md)
  tools/                                the three zero-install before-numbers scripts (separate from this package's tests)
  .auth/  .tmp/                         generated, gitignored (credentials/state, build, captures, reports)
```

## Setup (once)

```bash
bash seed/start.sh                      # or: npm run seed:start   (fresh seeded container on 127.0.0.1:8989, ~17 s)
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  # PowerShell: $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --ignore-scripts            # exact pins, lockfile committed
```

The Chromium build (revision 1243 for Playwright 1.63.0) is already in `D:\AI Tools\_cache\playwright`
(`PLAYWRIGHT_BROWSERS_PATH`). **No browser is ever downloaded**: if a different revision is needed the run fails
instead; do not let it fetch onto C:. Telemetry: `DO_NOT_TRACK=1` is set by the scripts; set it in your shell too.

### Versions

| Package | Version | Unpacked | Why |
|---|---|---|---|
| `@playwright/test` | 1.63.0 | 28.5 kB (+ `playwright` 5.09 MB) | owner decision; uses the cached Chromium 1243 |
| `playwright-core` | 1.63.0 | 13.45 MB | pinned explicitly: `@axe-core/playwright` has a peer `playwright-core >= 1.0.0` and npm otherwise installs the newest (1.64.0, which wants Chromium 1248) next to 1.63.0 |
| `@axe-core/playwright` | 4.13.0 | 47 kB | newest stable whose peer range (`playwright-core >= 1.0.0`) includes 1.63.0 |
| `axe-core` | 4.13.0 | 3.11 MB | what `@axe-core/playwright` 4.13.0 depends on (`~4.13.0`; only 4.13.0 exists in that range) |

Bump the Playwright pin in its own commit, never mixed with redesign work (engine changes move pixels).

## Commands

| Command | What it does |
|---|---|
| `npm run seed:start` / `seed:stop` | start (fresh reset + seed) / remove the `aonarr-e2e` container (see `seed/README.md`) |
| `npm run build` | build the working-tree `web/` into `.tmp/web-dist` (skipped when sources are unchanged; `node scripts/build-web.mjs --force`) |
| `npm run serve` | serve that build on `http://127.0.0.1:4173` with `/api` proxied to the seeded instance (Playwright starts it for you) |
| `npm run test:drift` | route drift only: fails if `App.tsx` / `main.tsx` has a `<Route path>` missing from `tests/routes.ts` (and vice versa). No browser, no server |
| `npm run test:selftest` | the judge self-test (below). ~35 s |
| `npm run test:classic` | drift, then every spec on the 4 `classic-*` projects (the blocking gate) |
| `npm run test:matrix` | drift, then all 28 projects |
| `npm run list` | list all tests (4,872 for the full manifest) |
| `npm run update:baselines` | re-record Classic screenshots + axe + tab-walk baselines (see "Baselines") |
| `npm run report` | open the last HTML report (`.tmp/report`) |

Slices: `npx playwright test --project=midnight-light-mobile`, `--project="*-dark-desktop"`, `smoke`, `a11y`, ...
Environment variables (on Windows cmd use `set NAME=value&& npm run ...`, in PowerShell `$env:NAME="value"`):

| Variable | Effect |
|---|---|
| `E2E_ROUTES=a,b,tabwalk` | run only these route ids (`tabwalk` = the 12 tab-walk routes). Drift ignores it |
| `E2E_WORKERS=n` | parallel workers (default 4) |
| `E2E_UPDATE_RATCHETS=1` | record axe / tab-walk results into the baselines instead of comparing (used by `update:baselines`) |
| `E2E_STRICT_RATCHETS=1` | make the redesign projects block on the ratchets too (default: Classic blocks, redesigns report) |
| `E2E_RETRIES=n` | re-run a failed test up to n times; a test that passes on a retry is reported as "flaky" with its first error kept in `.tmp/results.json` (default 0). Use 2 for long runs: see "Environment stalls" |
| `E2E_INJECT_BREAKAGE=name` | JUDGE PROOF ONLY: injects a broken stylesheet into every page (`hide-sidebar`, `wrong-accent`, `overflow`, `low-contrast`, `no-focus-ring`; see `tests/lib/breakage.ts`). Refuses to run together with a baseline-writing flag |
| `AONARR_E2E_API` | backend origin, must be loopback (default `http://127.0.0.1:8989`) |

## How the app under test is served

`webServer` runs `node scripts/build-web.mjs && node scripts/serve-web.mjs`:

1. `build-web.mjs` runs Vite's JS API with `root: web/`, `outDir: web-e2e/.tmp/web-dist`, `emptyOutDir` (equivalent to
   `web/node_modules/.bin/vite build --outDir ../web-e2e/.tmp/web-dist --emptyOutDir`). It borrows `web/node_modules` read-only,
   skips `tsc -b` (which writes `tsbuildinfo` into `web/`), checks that `git status` of `web/` and `server/` did not change,
   and stamps `build-info.json` with the source hash and git commit. ~4 s.
2. `serve-web.mjs` starts `scripts/static-server.mjs` (plain `node:http`) on `127.0.0.1:4173`: files from `.tmp/web-dist` (read into
   memory once; SPA fallback to `index.html`) and `/api/*` proxied to the seeded container (`http://127.0.0.1:8989`) through a keep-alive
   agent. The prefix is `/api/` with the slash, like `combined/nginx.conf`: `web/vite.config.ts` proxies the bare prefix `/api`, which also
   swallows the SPA route `/api-docs`. (It replaced `vite preview` because that froze in sweeps; see "Environment stalls".) It checks
   `GET /api/health` through the proxy before reporting ready and refuses to start unless the backend is loopback and answers.
3. `reuseExistingServer` is `false` on purpose: a stale server would serve an old build and invalidate baselines.

The sweep therefore tests the working-tree web code against the **deployed server image** (`allornothing/aonarr:combined`),
not the container's own nginx UI (that one adds a CSP; the preview server does not).

## Determinism

| Setting | Value |
|---|---|
| Browser | Chromium 153.0.8010.12 (rev 1243), **`headless: true` = the Chromium headless shell** (`chromium_headless_shell-1243/.../chrome-headless-shell.exe`, verified from the process list). Same everywhere; do not mix with new-headless or headed |
| Desktop / mobile | 1440x900 / 390x844 with `isMobile` + `hasTouch`; `deviceScaleFactor: 1` for both |
| Locale / timezone / colour scheme | `en-US` / `UTC` / matches the theme (`dark` or `light`) |
| Motion | `reducedMotion: "reduce"`, screenshots with `animations: "disabled"`, `caret: "hide"`, `scale: "css"` |
| Service worker | `serviceWorkers: "block"` (the app registers `/sw.js`) |
| Clock | `context.clock.setFixedTime("2026-10-13T12:00:00Z")` (= the seed's FIXED_NOW). Date is frozen, timers keep running. **Observed:** with the clock installed, an exception thrown inside a `setTimeout` callback is NOT a `pageerror`; Playwright logs it as `console.error` (the smoke console check still catches it) |
| Chromium flags | `--force-color-profile=srgb --disable-lcd-text` |
| Pixel tolerance | `maxDiffPixelRatio 0.0005`, `threshold 0.15` (`config/base.ts`) |
| Dynamic regions | `volatile` + `pixel: "capture-only"` + `maskText` in `tests/routes.ts`; those routes are captured (unmasked), not compared. Observed live values: /system CPU load and uptime, /users session count, /audit-log newest rows (each login adds one) |
| Floating scroll buttons | The app's `.scroll-buttons` show/hide and enable/disable from a 1 s poll, so for up to a second after load they were missing or in the wrong state; this changed text inventories, screenshots and the Tab-walk (`unreachable`, `obscuredByFixed`). `settle()` now fires the component's own resize listener and waits until the DOM agrees with the page geometry (`__e2e.syncScrollButtons`) |
| Unbounded pages | `/changelog` is 141,133 px tall: full-page capture times out. `maxHeight: 3600` in the manifest clips the capture to the top 3,600 px |
| Network-level failures | `settle()` fails the route when a same-origin request failed at the network level (a page left in its empty state is not a baseline). The dashboard and library home also wait for their real counts (`expectText`): they render "0 item(s)" before data arrives |
| Axe jitter | a result that would fail the blocking ratchet, or is being recorded as a baseline, is measured up to 2 more times and the pass with the fewest nodes is kept (`runAxeStable`); a real regression reproduces and still fails |
| Data that grows with every login | `/audit-log` and `/users` are `ratchet: "report-only"`: their layout moves with the data (a mobile table column slid in and out of view, axe flagged 4 or 5 nodes), so their axe/Tab-walk results are recorded but never ratcheted |
| Blocked requests the app makes by itself | `/activity` POSTs for an SSE stream ticket and retries every 5 s+. The guard still aborts it (it never reaches the instance); the route lists it in `expectedBlocked`, and the Tab-walk does not count it (the count depended on how long the walk took) |

**Fonts.** Windows renders with the host fonts (the page's font stack resolved on this machine);
a Linux container renders with whatever fonts the image ships (not measured here). Text metrics differ, so pixel baselines are **not
portable between machines or OSes**. The seeded posters are `data:` SVGs that use the generic `sans-serif`, so they change with
the host font too.

## Environment stalls (host loopback), and what the harness does about them

Observed on this Windows 11 machine, in the Phase 0 runs only (inferred, not a property of the app): every few minutes of a sweep, **all new TCP connections
to 127.0.0.1 hang for 1-5 minutes and then recover**: the app origin (4173) and the container's published port (8989), and also `curl` and a raw
`net.connect`. The container itself keeps answering its own health checks and the node server's event loop is not blocked (an event-loop heartbeat in
`static-server.mjs` logged nothing). It happened with `vite preview` and with the plain node server that replaced it. Windows 11 has Avast installed here
(`AvastUI` is running); that is only a suspect, nothing was changed or proven (security settings are out of scope). A stall fails the 4 tests that happen to be
navigating at that moment (page.goto ERR_CONNECTION_RESET / timeout, or a fetch that failed), all at once.

What the harness does: each test, and every navigation attempt, first waits (bounded: 20 min) until `GET /api/health` through the origin answers, and the
test timeout is extended by the time waited (`tests/lib/origin.ts`; annotation `app-gate`); `page.goto` is retried (6 x 45 s; annotation
`navigation-retry`); `settle()` refuses a page whose fetches failed at the network level; `E2E_RETRIES=2` re-runs a test that still failed and reports it as
**flaky** with the first error kept. Use `E2E_RETRIES=2` for long runs: in the final matrix run, 10 of 4,872 tests needed a retry, all with the network-level
failure above, and none had a pixel diff. If you see flaky tests that are NOT network-level, that is a real flake: look at it.
Probes used to find this (the loop that curls the origin every few seconds, the TCP-state counts) are not part of the package.

## Projects, design/theme, public routes

28 projects named `${design}-${theme}-${viewport}`: designs `classic midnight aurora ember noir paper terminal`, themes
`dark light`, viewports `desktop mobile`. `tests/global-setup.ts` logs in **once** through the API as the seeded admin
(`.auth/test-creds.json`, never printed) and writes `.auth/state/<project>.admin.json` (token key `aonarr_session_token`
from `web/src/api/client.ts`, plus `aonarr_theme=light` for light and `aonarr_design=<id>` for every design except classic)
and `<project>.public.json` (design/theme keys only, **no session**) for `/share/:token` and `/invite/:token`.
The fixture `role` (set per route with `test.use`) picks the file. Dark and Classic are expressed as an absent key, exactly
as `web/public/theme-init.js` reads them. The sidebar-collapsed default is left alone (expanded on desktop, collapsed on mobile).

## What each spec fails on

| Spec | Fails when |
|---|---|
| `routes-drift` | a `<Route path>` in `App.tsx`/`main.tsx` is not in the manifest, or the manifest keeps a path the source dropped |
| `smoke` | console error, uncaught exception, failed request, 4xx/5xx response, a request leaving 127.0.0.1, horizontal overflow (`scrollWidth > innerWidth`), `html[data-design]`/`[data-theme]` not as the project says, an unexpected redirect, the page not settling, or **any non-GET `/api` request (the GET-only guard)**. Also writes the text inventory (`.tmp/inventory/<project>/<route>.json`, attached to the test) |
| `screenshots` | Classic only: full-page `toHaveScreenshot` against `baselines/screens/<platform>/<project>/<route>.png` (blocking). Other designs, and Classic `capture-only` routes, write `.tmp/captures/<project>/<route>.png` (non-blocking) |
| `a11y` | the axe fingerprint `{ruleId: nodes}` is worse than `baselines/axe-baseline.json` (Classic), or has no baseline entry yet. Tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa best-practice`; `target-size` (off by default in axe) is enabled explicitly |
| `tabwalk` | the 12 routes: Tab up to 120 times; counters `noIndicator`, `bgOnlyIndicator`, `obscuredByFixed`, `coveredOrClipped`, `trap`, `unreachable`, `focusedNotInteractive`, `positiveTabindex`, `clickOnly`, `blockedMutations` are worse than `baselines/tabwalk-baseline.json` (Classic) |
| `judge-selftest` | the judge fails to flag a deliberately broken page, or flags the clean page (see below) |

**Settled** = shell mounted, no leaf element reading `Loading...`/`Fetching...`/etc., no non-stream `/api` request in flight
for 400 ms (SSE responses stop counting once their headers arrive, so the Activity page can settle), fonts and images decoded,
DOM quiet for 300 ms (bounded: live pages may never be quiet), optional `expectText` present, no error boundary.

**Allow-list policy: fail closed.** A finding is allowed only by (1) `baselines/smoke-allowlist.json` (empty today), (2) the
route's `expectedApi` (an exact status on a path pattern, with a reason), or (3) the route's `knownGap` (request/console
failures only, never overflow or exceptions). Every allowed finding is attached to the test as an annotation. Entries written
from documentation rather than a run carry `verified: false`.

**Tab-walk caveats.** `outline: auto` counts as a visible indicator; background/colour-only changes are counted separately
(`bgOnlyIndicator`) and still count as "no strong indicator". Obscuring is judged at the centre of the focused element's visible part with
`elementFromPoint`: covered by something that is neither the element, its descendant nor its ancestor. `fixed` means the covering element sits in a fixed/sticky box (counted as `obscuredByFixed`), anything else is `coveredOrClipped`. Dialog focus-trap/restore and
`Escape` handling are **not** covered (axe cannot, and this walk does not open dialogs). Interactive elements inside
`role=status|alert|aria-live` (toasts) are ignored. The tab-walk runs with the guard in *observe* mode (it still blocks every
mutation) because tabbing alone can fire saves; see findings below.

## Judge self-test (`npm run test:selftest`)

Proves the judge can fail, without touching source. Each check runs the **same helper the sweep uses** on the clean page
(must not be flagged) and on the same page with damage injected in the browser (must be flagged):

| Damage | Helper that must flag it | Seen |
|---|---|---|
| `body{overflow-x:visible;width:200vw}` | `measureOverflow` | overflow 0 -> 1440 px, offenders listed |
| `.sidebar{display:none}` | `diffInventory` | drops 26 controls and 29 text lines |
| injected `console.error`, unhandled rejection, 404 fetch, request to an outside host | `Collector` + `judge` | console, pageerror, http, external all violations; clean page has none |
| POST/PUT/PATCH/DELETE to `/api` | GET-only guard | all four blocked and recorded, GET passes, enforce mode throws |
| `#root *{color:#777;background:#808080}` | axe ratchet (`compareToRatchet`) | `color-contrast` 22 -> 114 nodes = `worse` |
| two adjacent 6 px targets | axe `target-size` | 0 -> 2 nodes (and the rule is proven to have run) |
| `outline:none; box-shadow:none; border-color:currentColor` | tab-walk | `noIndicator` 0 -> 40 |
| a transparent fixed overlay | tab-walk | `obscuredByFixed` 0 -> 40 |
| a capturing `keydown` Tab handler | tab-walk | trap detected |
| `.sidebar{display:none}` | `toHaveScreenshot` with the sweep's options | the clean page matches its golden, the broken one does not |
| `/api/media*` never answered | `settle` | `SettleError`: placeholder still visible, network never quiet |
| a new `<Route path>`, a removed route | drift | reported as unlisted / stale |
| allow-list entries, ratchet maths, baseline file writes | pure logic | covered |

The screenshot golden of the self-test lives in `.tmp/selftest-snapshots/`, never in `baselines/`.

## Baselines

* **Windows-native first.** Screenshots go to `baselines/screens/<platform>/<project>/<route>.png` (`win32` today);
  `baselines/screens/<platform>/ENVIRONMENT.json` records OS, Playwright, Chromium version, headless mode, viewports and the
  web build hash whenever baselines are written. A baseline is only valid for that renderer. Moving to the pinned Linux
  container (`mcr.microsoft.com/playwright:v1.63.0-noble`) is a later owner decision and means re-recording from scratch
  into `screens/linux/`; never copy PNGs between platforms.
* `npm run update:baselines` runs the drift check, then `playwright test --project=classic-* --update-snapshots=changed`
  with `E2E_UPDATE_RATCHETS=1`: screenshots are written by Playwright, axe/tab-walk numbers are merged into the two JSON
  files by `tests/global-teardown.ts`. A plain `playwright test` never writes baselines (`updateSnapshots: "none"`).
* Run the Classic set **twice** before approving, to catch flaky regions: a route that differs between two runs on an
  unchanged build must be demoted to `pixel: "capture-only"` or masked.
* **Approval is the owner's, not the generating agent's.** The agent that records a baseline leaves its row in
  `baselines/APPROVALS.md` with `Approved by` empty; the owner reviews the PNG/JSON diff and signs. Update with
  `--update-snapshots=changed --project=<design>-*`, never `all`.
* Ratchets can only improve: a Classic run fails if any axe node count or tab-walk counter is above the committed number;
  until the first approved baseline exists, Classic fails with "no baseline". Redesign projects compare against Classic of
  the same theme and viewport and only report (unless `E2E_STRICT_RATCHETS=1`).

## Guardrails this package enforces

* Only the seeded instance on `127.0.0.1:8989` (container `aonarr-e2e`) is a backend; the serve script refuses non-loopback.
  Smoke fails if a page requests any non-127.0.0.1 host.
* After login every test page runs behind the **GET-only guard**: non-GET `/api/**` requests are aborted in the browser and
  recorded; recording one fails the test (tab-walk counts them instead, see above). The one login in `global-setup` happens
  outside the browser, before the guard exists.
* Credentials: random per seed, read from the gitignored `.auth/test-creds.json`, never printed. The session token lives only
  in the gitignored `.auth/state/*.json` because the app keeps it in `localStorage`.
* No git writes, no pushes, no docker commands from any script here except `seed/start.sh` / `stop.sh` and the read-only `docker logs aonarr-e2e` in `scripts/readonly-proof.mjs`.

## Observed on the seeded app (Phase 0 runs)

* Classic baselines recorded 2026-10-13 (win32, Chromium 153.0.8010.12 headless shell, Playwright 1.63.0): 192 screenshots, 32 MB; two consecutive full Classic runs
  (696 tests each) with zero screenshot diffs in any attempt. A 4-route spot check of baselines recorded before and after 18:00Z (the time the seeded queue rows turn "stuck",
  6 real hours after FIXED_NOW) differed by at most 34 pixels with a channel delta of at most 6 (4 of 192 files), far under the tolerance.
* The "Unreleased"/"Missing" poster banner is computed in the browser (`isAfterToday` in `LibraryType.tsx`, `new Date()`), so the frozen clock protects it (code reading, inferred); the
  seed README's statement that it uses the real day is out of date for that component. Server-computed time still shows on /system (stuck-queue warning), the dashboard "Upcoming"
  widget and similar: those routes are capture-only.
* Early notes from the first proof-of-life runs (kept):

* `/media/:id` (movie): `GET /api/media/:id/{cast,alternate-titles,ratings,collection}` answer **400** (no metadata provider on
  the seed); allowed with a reason in the route's `expectedApi`. Nothing else failed on `library-type`, `media-detail`, `settings`.
* Tabbing through `/settings` makes the page fire `PUT /api/settings/{externalUrl,customThemeCss,corsAllowedOrigins,kindleEmailAddress,recycleBinRetentionDays,recycleBinDir}`
  on blur even though nothing was edited. The guard blocked all six (the page shows six error toasts). Real Classic behaviour
  that a keyboard user triggers; it is why tab-walk counts `blockedMutations`.
* axe on `/library/movie` (Classic dark desktop): `color-contrast` 22, `label-title-only` 2, `select-name` 2. On `/settings`: `color-contrast` 4.
* Tab-walk on `/settings`: 52 stops = 52 visible interactive controls, every stop has an outline, "Skip to main content" is the
  first stop and the floating "Scroll to bottom" button is the second (before the sidebar), 4 click-only sidebar group headers
  (`<a>` without `href`).

## Not covered yet

Household role routes (only admin and public are stored), dialogs/menus opened by interaction, Settings and System sub-tabs
(state-only, no URL), `/people/:tmdbId` (no TMDB data offline), real hover/active states, any run on Linux.
