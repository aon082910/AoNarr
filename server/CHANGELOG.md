# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

## Round 130 — minimum availability (1st of the Starr feature-gap list)
- Added Radarr-style "minimum availability" gating for single-file libraries (Movies, ROMs,
  Adult — Movies is the real driving case): `announced` (default, today's behavior) searches as
  soon as an item is added; `inCinemas` waits until its release date has passed; `released` waits
  release date plus a configurable delay (default 90 days). Since AoNarr only tracks one release
  date per item rather than TMDB's separate theatrical/digital/physical dates the way Radarr's own
  four-tier version does, `released` is an approximation of a digital/home-release window rather
  than a real digital-release-date lookup — disclosed in the Settings tile's own description.
  Gates the scheduled auto-search only; manual search is never blocked, same convention as Quiet
  Hours/Search Window.
- New `minimum_availability` column on `media_items`, set per item (editable on its detail page,
  defaulting to a new `defaultMinimumAvailability` setting when added) and a `minimumAvailability
  ReleasedDelayDays` setting (default 90) — both configured from a new "Minimum Availability" tile
  under Settings → Media Management.
- Verified live: seeded a movie with a future release date and `inCinemas` via direct DB insert,
  confirmed the API round-trips both new fields correctly; changed it to `released` through a real
  UI click on the media detail page's new "Minimum availability" selector and confirmed it
  persisted; set and confirmed the new Settings tile's default-availability field via a real UI
  interaction. The actual auto-search skip itself is a straightforward date-comparison function
  verified by code review (no indexers/download clients configured in this dev environment to
  drive a full scheduler run against).

## Round 129 — SABnzbd premature-completion bug + manual import
- Fixed a SABnzbd download getting marked as failed and never imported despite completing fine.
  `getStatus` (`server/src/services/downloadClient.ts`) reported "completed" the moment a job's
  queue percentage hit 100 — but SABnzbd still has to verify/repair/extract/move the result after
  that, all while sitting in the queue at 100% with a status like "Extracting" or "Repairing". The
  importer raced that post-processing, didn't find the final file yet, and the queue item got
  marked failed on the very first (premature) attempt — never retried, since a failed import moves
  on to searching for a different release instead of re-trying the same one. Real completion (and
  real failure) can only be told apart once a job actually leaves the queue and lands in SABnzbd's
  history, so `getStatus` now checks the queue first and, for any id that's disappeared from it,
  looks it up in history instead of guessing from percentage alone.
- Added manual-import to the Activity page for exactly this kind of case (or any other reason the
  automatic matcher can't find/place a file on its own): a "Retry import" button re-runs the
  automatic matcher against a `failed`/`completed` queue row, and a "Manual import..." button opens
  a picker listing every file in the downloads directory matching that library's file types
  (newest first) so the admin can point AoNarr at the right one directly, bypassing the fuzzy
  title-match entirely. New `POST /api/activity/queue/:id/retry-import`, `GET
  /api/activity/queue/:id/import-candidates`, and `POST /api/activity/queue/:id/manual-import`
  routes; the last two reuse `importer.ts`'s existing placement logic via a new optional
  `manualSourceFile` argument on `importQueueItem`, with a path-traversal guard confirming the
  picked file is actually inside the downloads directory.
- Verified live end-to-end against a real SQLite instance: seeded a failed queue item plus a
  correctly-named file, confirmed "Retry import" found it via the existing fuzzy matcher and
  imported it; seeded a second failed item with a deliberately unrelated filename the fuzzy matcher
  would never pick, confirmed "Manual import..." lists it and importing it via a real UI click
  works; confirmed the path-traversal guard rejects a file outside the downloads directory (tried
  `/etc/passwd`). No live SABnzbd instance available to reproduce the original race directly — the
  `getStatus` fix is verified by code inspection and against SABnzbd's documented API behavior
  (queue percentage reaching 100% while `status` is still a post-processing stage, then the job
  disappearing from the queue into history on true completion).

## Round 128 — AllDebrid grabs hanging forever (4th pass on #1)
- Found a second, independent bug in the same `/magnet/status` polling loop the previous round's
  fix touched: AllDebrid's `data.magnets` is **always an array** — even filtered down to a single
  `id` — never a bare object. The code read it as a single object (`magnet.statusCode`), which was
  always `undefined`, so neither the "Ready" check (`=== 4`) nor the failure check (`>= 5`) ever
  fired. The loop just polled every 5 seconds forever, never erroring and never completing — the
  exact "grab started but stuck" symptom from the reporter's Unraid throughput screenshot on
  https://github.com/aon082910/AoNarr/issues/1, which predates the previous round's fix and was
  never actually explained by it. Fixed by indexing `magnets[0]` (`server/src/services/
  downloadClient.ts`), confirmed against AllDebrid's own documented `/v4.1/magnet/status` response
  shape.
- Double-checked the other two AllDebrid response readers this round touches indirectly
  (`/magnet/files`, `/link/unlock`) against AllDebrid's docs — both already match the documented
  shape, no further bugs found there.
- Still no live AllDebrid premium account to test end-to-end against; this fix is verified against
  documented API shapes and by inspection of the polling loop's control flow, same disclosed
  limitation as the previous three rounds on this issue.

## Round 127 — tile+popup pattern rolled out to remaining settings pages
- Following confirmation on the Notifications template, applied the same tile-grid + popup pattern
  to the rest of the punch-list's 12 pages. Settings.tsx's other six tabs (Metadata Providers,
  Media Management, Indexer Options, Library Sync, Quality, Import & Subtitles) now render each
  logical section as a tile that opens a `Modal` popup, instead of one long unbroken vertical page.
- New `SettingsSectionTiles` component (`components/SettingsSectionTiles.tsx`) generalizes last
  round's `SettingsProviderTiles` for sections whose content isn't a flat key/value field list —
  Root Folders, Quality Profiles, Custom Formats, and similar sections keep their own existing
  table/CRUD UI verbatim inside the tile's popup; only the entry point changed, not the section's
  own logic.
- Metadata Providers additionally got a `SettingsProviderTiles` instance (13 providers: TMDB, OMDb,
  TVDB, Trakt, Discogs, Google Books, Last.fm, Fanart.tv, Comic Vine, RAWG, IGDB, YouTube Data API,
  ThePornDB) — same pattern as Notifications, since it's a flat provider-key list.
- Download Clients, Users, Remote Library, and Friend Libraries pages converted from an "+Add"
  modal plus a table of existing entries to a tile grid where each existing entry is itself a tile;
  clicking one opens a full edit popup (pre-filled, Save/Delete) instead of the previous
  add-only-with-inline-delete pattern — Remote Library and Friend Libraries needed new `PATCH
  /api/remote-instances/:id` and `PATCH /api/friend-libraries/:id` routes added server-side since
  only create/delete existed before. Users' Active Sessions and Request Stats tables became their
  own tiles via `SettingsSectionTiles` for consistency with the rest of the page. System page's
  Backups tab (Backup & Restore, Scheduled Backups) converted the same way.
- Verified live in-browser end-to-end: all converted pages render their tiles with correct
  labels/descriptions/badges; a metadata provider tile (TMDB) saves correctly through a real
  click+type+Tab flow; Root Folders' full add-form+table renders intact inside its popup; a
  download client's full add → edit (pre-filled) → delete cycle round-trips correctly against the
  live API.

## Round 126 — tile+popup settings pattern (Notifications template)
- Long settings pages with many similar "provider" integrations (Notifications had 9: Discord,
  Slack, Generic Webhook, Telegram, Pushover, SMTP, Matrix, Twilio, Custom Script) used to be one
  unbroken vertical form. Added a reusable `SettingsProviderTiles` component — a tile grid with a
  "Configured"/"Not configured" badge per provider, click a tile to open a `Modal` with just that
  provider's own fields, saved through the same `saveSetting` path every other settings field
  already uses. Applied it to the Notifications page as the first instance of the pattern.
- This is a template: the other tile-view candidates from the same request (Metadata Providers,
  Media Management, Indexer Options, Library Sync, Quality, Import & Subtitles, Backups, Remote
  Library, Friend Libraries, Download Clients, Users) are intentionally not converted yet, pending
  confirmation that this first page looks/feels right.
- Verified live in-browser: all 9 tiles render with correct labels/descriptions/configured-state
  badges; opening a tile's popup, editing a field, and blurring it persists through `PUT
  /api/settings/:key` exactly as before, and the tile's badge updates to "Configured" once saved.
  (An earlier round of manual testing looked like a broken save path, but was two compounding test
  artifacts, not a real bug: a stale browser session token left over from a prior container
  rebuild was causing background 401s, and a synthetic `blur` event doesn't bubble the way React's
  delegated `focusout` listener expects — a real click+type+Tab flow saves correctly.)

## Round 125 — Jackett indexer sync
- Added a Jackett equivalent of the existing Prowlarr indexer sync — new `services/jackettSync.ts`,
  mirroring `prowlarrSync.ts`'s pattern (pull the configured-indexer list, mirror into AoNarr's
  `indexers` table via each indexer's own Torznab proxy URL, match existing rows on a stashed
  provider id so re-running updates rather than duplicates) but adapted to Jackett's real
  differences: string slug ids instead of Prowlarr's integers, no protocol field since Jackett is
  torrent-only (no Usenet), and a different per-indexer Torznab proxy path
  (`/api/v2.0/indexers/{id}/results/torznab`, `/configured=true` on the list endpoint, `X-Api-Key`
  header instead of Prowlarr's own header name).
- New `POST /api/indexers/jackett-sync` route, "Sync from Jackett" button on the Indexers page, a
  scheduled `jackettSync` job (every 6 hours, same cadence as Prowlarr's), and a "Jackett Sync"
  settings panel (URL + API key) next to the existing Prowlarr one.
- Verified live against both SQLite and Postgres: confirmed the missing-config error ("Jackett URL
  and API key must both be set") from both the manual sync button and the scheduled job, and the
  unreachable-host error ("Failed to reach Jackett: fetch failed") from the manual sync route —
  identical on both dialects, and both Sync buttons render correctly on the Indexers page.

## Round 124 — media server sync options decoupled from auto-archival
- Watch status previously only got refreshed on a schedule as a side effect of the auto-archival
  job (`archiveEnabled`) — an admin who wanted AoNarr to track what's been watched (e.g. to feed
  the Dashboard's Recently Watched widget) without wanting files auto-archived had no recurring
  sync, only the on-demand dashboard fetch or webhook events. Added an independent
  `watchStatusSyncEnabled` setting + new `watchStatusSync` job (every 30 minutes) that polls the
  media server and records new watch events on its own schedule, entirely decoupled from archival.
- Added a second new sync option, `mediaServerScanSyncEnabled` + `mediaServerScanSync` job (every 6
  hours): a genuine full media-server library scan, distinct from the existing per-import targeted
  refresh (`refreshMediaServerLibrary`, still fires on every import regardless of this setting) —
  useful when files land outside AoNarr's own import path and need the media server to notice them.
- New `triggerFullMediaServerScan()` in `services/mediaServer.ts` (Plex: refresh each movie/show
  section with no path param — a whole-section scan, not `refreshMediaServerLibrary`'s per-path
  targeted one; Jellyfin/Emby: the same `/Library/Refresh` call, already a full scan regardless of
  path). New `syncWatchStatusFromMediaServer()` in `services/mediaServerWebhook.ts` — fetches the
  three lookup tables (media_items/episodes/sub_items) once and matches every watched file in
  memory, rather than the existing per-webhook-event `recordWatchEvent`'s fresh 3-table-scan-per-call
  pattern, which would be wasteful called in a loop over potentially hundreds of watched titles. A
  new `watchStatusSyncLastRunAt` setting acts as a cursor so already-recorded watches aren't
  reinserted into `watch_events` every single 30-minute cycle.
- Settings page: renamed the old "Watch-status Auto-Archival" panel to "Media Server Sync" with the
  two new toggles up top and auto-archival now clearly presented as one of several independent sync
  options underneath, not the panel's sole purpose.
- Verified live against both SQLite and Postgres: confirmed both new jobs appear on the Jobs page,
  enabled both settings via the API, and confirmed both jobs run cleanly with no error when no
  media server is actually configured (correctly no-op via `getMediaServerConfig()` returning null)
  — identical behavior on both dialects.

## Round 123 — Recommendations view-more, calendar day pages, Duplicates dismiss + richer info
- Recommendations page: each section (Movies/TV Shows/Music) now shows 12 items initially with a
  "View more" button revealing the rest — the backend already returns up to ~25 per section (5
  library items × 5 similar results each), the UI just dumped all of them in one unbounded grid.
- Added a real, bookmarkable/shareable per-day calendar page (`/calendar/:date`) alongside the
  existing month view's click-to-expand inline panel — "Open day page" link added to that panel.
  Every entry now gets a clear description via a new shared `describeCalendarEntry()` (e.g. "New
  episode — S01E05 - Title", "Album release — Title", "Book release — Title", vs. the old generic
  label), used by both the month view's panel and the new day page so they stay consistent. Note:
  AoNarr stores one `release_date` per movie/collection-child, not a theatrical/digital/physical
  split — TMDB does expose per-region/type release dates via a separate endpoint, but wiring that
  in needs a schema change and is scoped as follow-up work, not attempted here.
- Duplicates page: added a "Not a duplicate — keep both" action (new `POST /api/duplicates/dismiss`)
  — marks a group's identity as dismissed so `findDuplicateGroups()` stops returning it (and the
  Round 118 scheduled notification job stops flagging it too) without touching either item, unlike
  Merge. New `duplicate_group_seen.dismissed` column (added via the established `ensureColumn`/
  `ADD COLUMN IF NOT EXISTS` pattern, not a fresh table, since Round 118's table already exists).
  Also added more per-item info to the comparison table: quality, monitored status, and which
  metadata providers each item is actually matched to (the clearest signal for telling a genuine
  duplicate — both matched the same tmdb id — from two different works that just share a
  title/year).
- Added 2 new automated tests (`dismissDuplicateGroup` hides a group without touching either item;
  dismissing twice doesn't error) to the existing `duplicateCheck.test.ts` suite — full suite (13
  tests) passes identically on both SQLite and Postgres, confirming the `ON CONFLICT ... DO UPDATE`
  dismiss upsert (valid standard syntax on both dialects, no branch needed) works on both.

## Round 122 — nav reorder, topbar dropdown fixes, library tile-view width, cast photo crop bug
- Reordered top-level nav: Dashboard, Search, Library, Account — Search now renders as its own
  hardcoded link between Dashboard and Library (previously after Library along with everything
  else). Moved Requests and Collections into the Manage group, What's New into System. Every admin
  group's links (Manage/Configuration/System) now sort alphabetically via `.sort()` on the array,
  not just a one-time manual reorder — stays alphabetical if a page is ever added to a group later.
- Fixed two real, precisely-diagnosed topbar bugs (live-measured via computed styles, not guessed):
  the "Library ▾" dropdown trigger sat 8px lower than its sibling `<a>` nav links — root cause was
  the base `button` rule's `margin-top: 16px` (meant for a button under a stacked label) still
  applying inside the topbar's flex-centered row, which `align-items: center` then split in half
  visually. The trigger also had a distinctly darker background than its siblings — it inherited
  `.select-like`'s `background: var(--input-bg)` (near-black, designed for toolbar select/input
  contexts), while plain nav links are transparent over the topbar's own lighter `--panel` grey.
  New `.topbar-trigger` class resets both; verified live the trigger is now pixel-identical in
  height/top position to a sibling link and matches its transparent background.
- Library pages (poster/list view) now stretch to the full available width instead of being capped
  at the app-wide 1200px `.content` max-width (meant for text-heavy pages) — verified at 1920px
  viewport: grid width went from a 1200px cap to 1848px.
- Fixed the poster-size `<select>`'s text being clipped by its own dropdown arrow (`maxWidth: 140`
  wasn't wide enough for "X-large posters" plus the arrow's reserved padding) — widened to 190px.
- Added a "N per page" dropdown (30/60/100/250, namespaced per library type like the sort/status
  fix in Round 121) to the library pagination bar — now shown whenever a library has at least one
  item, not only once already paginated, so it's actually discoverable.
- Fixed a real, previously-unnoticed bug: cast photos on Media Detail and the Person page rendered
  zoomed into a small top-left corner instead of the whole photo. Root cause: both used
  `className="poster"` without the `.card` ancestor the shared `.card .poster` CSS rule requires to
  apply its `background-size: cover; background-position: center` — outside that ancestor, the rule
  never applied at all, so a real photo (typically several hundred px) rendered at native resolution
  anchored top-left, showing only a small crop. Fixed by setting the same background properties
  inline directly on the two affected divs. Audited every other `className="poster"` site in the
  codebase (8 more files) — all already sit inside a proper `.card` ancestor, so this was isolated
  to exactly these two spots.
- Frontend-only round — no server/DB changes, so no dual-dialect verification needed this time.

## Round 121 — library filter/pagination regressions, AllDebrid "no files" fix
- Fixed a real regression from Round 113's pagination work: the status filter's `localStorage` key
  (`aonarr_library_status`) was global, not per library type — picking "Downloaded" on Movies
  silently made every other library (Series, Music, ...) load with the same `has_file = 1` filter
  applied, since they all read/wrote the same key. Namespaced per type
  (`aonarr_library_status_${type}`/`aonarr_library_sort_${type}`), plus a re-sync effect for the
  case where the component doesn't remount when switching type on the same route.
- Fixed a second regression from the same round: pagination's `page` lived in plain React state,
  invisible to the URL — navigating to a media item and back reset the library to page 1 no matter
  which page was actually being browsed. `page` now lives in the URL (`?page=N`) via
  `useSearchParams`, so browser back/forward restores it like any other navigable state. Verified
  live: set Movies to "Downloaded" (correctly showed only the 1 downloaded item), navigated to
  Series (correctly showed all 65 unfiltered), paged to page 2, opened an item, pressed back —
  landed back on `?page=2`, not page 1.
- Fixed GitHub issue #1's third recurrence (AllDebrid grabs failing) — the real root cause this
  time: AllDebrid's `/magnet/status` endpoint stopped including a `links` field entirely as of
  their v4.1 API (file/link data moved to a dedicated `POST /v4/magnet/files` endpoint) — the
  adapter was still reading `magnet.links` from the v4.1 status response, which had already gone
  from "has the wrong shape" (the previous two fixes) to "doesn't exist there at all", producing
  "AllDebrid reported no files" on every grab that actually finished caching successfully. Added
  `callFiles()`, which calls the dedicated endpoint and recursively flattens its file-tree response
  (files carry `n`/`s`/`l`; folders carry `n`/`e` with nested children) into the flat link list the
  rest of the download loop already expects.
- Verified the fix against AllDebrid's documented v4/v4.1 API response shapes (via their published
  docs, since testing requires a live premium account this environment doesn't have) — commented on
  the issue explaining the root cause and asking the reporter to confirm against their real setup
  before closing, rather than claiming it's resolved a third time without their confirmation.

## Round 120 — accessibility pass
- `Modal.tsx` (used by every "Add X" flow across the app) now: traps Tab/Shift+Tab focus within the
  dialog instead of letting it escape to inert page content behind the overlay, closes on Escape,
  restores focus to whatever triggered it on close, has `role="dialog"`/`aria-modal="true"`/
  `aria-labelledby`, and its close button has `aria-label="Close dialog"`. Caught and fixed a real
  bug while building this: initial autofocus first landed on the header's own "✕" close button
  (earlier in the DOM than any form field) instead of the modal's first real field — fixed by
  searching only within the content area, not the whole panel.
- `DropdownMenu.tsx` (used by every "View"/"Columns"/menu-style control) now closes on Escape and
  returns focus to its trigger button, and the trigger has `aria-haspopup="true"`/
  `aria-expanded={open}`; the menu itself has `role="menu"`.
- Fixed three genuinely keyboard-inaccessible controls — not just missing labels, but controls a
  keyboard/screen-reader user could not activate at all, since they were `onClick` handlers on a
  plain `<div>`/`<h2>`/`<span>` rather than a real `<button>`: the Missing page's per-series
  disclosure toggle, the Recycle Bin's per-type disclosure toggle, and Media Detail's per-season
  episode disclosure toggle. All three are now real `<button>`s with `aria-expanded`, visually
  unchanged (background/border/padding reset inline) but keyboard-operable and correctly announced.
- Added `aria-label`s to icon-only buttons that had none: the sidebar/dashboard-widget reorder
  ↑/↓ buttons and the library group delete "✕" button (the sidebar's own "☰" and "⚙" toggles
  already had a `title`, so weren't touched).
- Added a "Skip to main content" link — off-screen until keyboard-focused, the first focusable
  element on every page — so a keyboard/screen-reader user can jump past the sidebar/topbar nav
  instead of tabbing through every nav link on every single page.
- **Known gap, deliberately out of scope this round**: `<label>` elements across the app (~193
  instances) are visually adjacent to their `<input>` but not explicitly associated via
  `htmlFor`/`id` — a screen reader can't reliably tell which label goes with which field. Fixing
  this properly requires touching each of ~193 sites individually (generating a stable id per
  field, many inside `.map()` loops needing a per-iteration id) — a mechanical sweep at that scale
  risked more from rushed/inconsistent edits than it was worth in one pass. Flagging as known
  follow-up work rather than claiming it's fixed.
- Verified live in-browser: confirmed initial modal focus lands on the first real field (not the
  close button) after the fix, confirmed Escape closes the modal, confirmed the DropdownMenu's
  `aria-haspopup`/`aria-expanded` attributes are present and toggle correctly, and confirmed the
  skip link and its `#main-content` target both exist and are wired correctly.

## Round 119 — real-time queue updates (Server-Sent Events)
- The Activity page's queue table used to poll every 10s. Added a Server-Sent Events channel
  (`GET /api/activity/stream`) that pushes a lightweight "queue changed" signal the moment a grab,
  progress update, import, retry, stall-cleanup, priority change, or removal happens anywhere in
  the app — the page re-fetches its existing `/activity/queue`/`/activity/timeline` endpoints
  immediately on that signal instead of waiting for the next poll tick. The 10s poll is kept as a
  30s fallback safety net (a proxy that blocks/buffers `text/event-stream`, or a dropped connection
  EventSource's own auto-reconnect doesn't catch), not removed outright.
- Chose SSE over a WebSocket specifically because it needed zero HTTP-server restructuring — it's
  just another Express route, unlike `ws`, which would require rebuilding `index.ts` around
  `http.createServer`+`WebSocketServer` instead of a plain `app.listen()`. Round 114's `app.ts`/
  `index.ts` split (originally done for testability) made this a clean addition either way.
- New `server/src/services/realtime.ts`: a small SSE client registry plus a throttled
  `notifyQueueChanged()` (coalesced to at most one broadcast per 1.5s) — deliberately a "something
  changed, go re-fetch" signal rather than trying to stream hand-serialized row diffs from the
  9 different call sites that mutate the `queue` table (routes/media.ts, routes/search.ts,
  services/scheduler.ts's `grab()` — the single choke point shared by manual/auto-search, retries,
  and bulk-search/auto-upgrade — services/importer.ts, and routes/activity.ts itself).
- Found and fixed a real auth gap while wiring the frontend: an `EventSource` can't set the
  `X-Api-Key`/`X-Session-Token` headers the rest of the app's auth relies on, so the browser client
  passes whichever credential the session actually has as a query param instead. `requireAuth`
  already had a query-param fallback for the instance API key (`?apikey=`) but NOT for session
  tokens — meaning an admin logged in normally via username/password (session token, not the
  instance API key) would have silently gotten no live updates at all, only the fallback poll.
  Added the matching `?sessionToken=` fallback in `middleware/auth.ts`.
- Verified live against both SQLite and Postgres: opened the Activity page in-browser (confirmed
  via network inspection that the SSE connection opens with `?sessionToken=` for a normal logged-in
  admin session), inserted a queue row, deleted it through the now-instrumented `DELETE
  /activity/queue/:id` route, and confirmed the page's queue table updated to "Nothing in the
  queue" with no reload/manual refresh — genuine live push, not a coincidental poll tick — on both
  dialects.

## Round 118 — scheduled duplicate detection with notification
- The duplicate-merge tool (Round 107) was manual-only — an admin had to remember to check the
  Duplicates page. Added a daily scheduled job ("Duplicate Check", 5am, admin-configurable/run-now
  via the existing Jobs page — registering it in `services/jobRegistry.ts` gets those controls for
  free, no frontend changes needed) that runs the same `findDuplicateGroups()` sweep and sends a
  notification through whichever channels are already configured (Discord/Slack/webhook/Telegram/
  Pushover/...) when it finds a group that hasn't been notified about before.
- New `duplicate_group_seen` table gates re-notification: a still-unmerged duplicate group keeps
  showing on the Duplicates page (unchanged — that page is deliberately a live, stateless sweep,
  merging is the only thing that actually resolves a duplicate) but won't notify again on every
  daily run, only the first time it's seen. `DuplicateGroup` now carries a stable `key`
  (`type::normalizedTitle::year`) used as that identity.
- New `notifyDuplicatesFound(count, sampleTitles)` in `services/notifications.ts`, following the
  exact same template/fanOut pattern as the existing `notifyGrabbed`/`notifyImported`/`notifyFailed`
  — no new notification-channel plumbing needed, just one more thin wrapper.
- Verified live against both SQLite and Postgres: seeded a duplicate pair via the API, ran the job
  via `POST /api/jobs/duplicateCheck/run`, confirmed the "1 new duplicate group(s) found" log line
  on the first run and confirmed a second run produced no further log/notification — identical
  behavior on both dialects.

## Round 117 — health page: config-completeness warnings, historical indexer stats
- Extended (rather than duplicated) the existing System → Health tab: it already covered live
  reachability/disk-space/stuck-queue checks, but assumed the instance was already configured and
  had no way to tell an admin "you never actually finished setup" once the onboarding checklist was
  dismissed. `GET /api/system/health` now also returns `configWarnings` — flags no root folder, no
  enabled indexer, and no enabled download client — rendered as a red banner at the top of the tab.
- Wired Round 116's new per-indexer historical success-rate data (`indexer_health`) into the same
  endpoint: the indexer table's existing "Status" column (a live reachability check) now sits next
  to a "Recent success rate" column ("92% (50) · 340ms" style, with the last error on hover) — an
  indexer can pass a live check while having failed most of its last 50 real searches, which the
  old live-only check had no way to surface.
- Verified live against both SQLite and Postgres: confirmed all three config warnings fire on a
  fresh, fully-unconfigured instance, confirmed adding a root folder makes exactly that one warning
  disappear (the other two persist correctly), and confirmed a test indexer's live/historical
  health both render correctly and identically on both dialects.

## Round 116 — per-indexer health tracking
- Added Sonarr/Radarr-style per-indexer health tracking: every real search attempt through
  `searchIndexer()` — manual "Search", scheduled auto-search, the wanted-list cycle, and the
  Indexers page's own "Test" button, every call site funneled through this one choke point — now
  records success/failure, response time, and the error (if any) to a new rolling `indexer_health`
  table, pruned to the most recent 50 attempts per indexer.
- The Indexers page now shows a "Health" column: success rate + check count + average response
  time (e.g. "92% (50) · 340ms avg"), colored green/red by rate, with the last error as a hover
  tooltip on a failing indexer — surfaces a dying indexer immediately instead of it silently
  contributing nothing to search results until someone notices.
- New `server/src/services/indexerHealth.ts`: `recordIndexerHealth()` (best-effort, never throws —
  a health-logging failure can't mask the real search result/error) and `attachIndexerHealth()`
  (one grouped query for the whole indexer list, mirroring Round 111's `attachChildCounts()`
  pattern rather than one query per indexer).
- Verified live against both SQLite and Postgres: created an indexer pointed at a URL that
  reliably 404s, ran the "Test" button and confirmed the health summary (success rate, avg
  response time, last error) appeared correctly and identically on both dialects; bulk-inserted 60
  health rows directly and confirmed pruning correctly capped the table at 50 rows for that
  indexer.

## Round 115 — mobile-responsive layout pass (item #4 of the scoped improvement list)
- Found and fixed a real, app-wide mobile bug: `.content` (a flex child of `.app`) has no
  `min-width: 0`, so it defaults to `min-width: auto` — meaning it never shrinks below the
  intrinsic width of whatever's inside it (a toolbar row, a table), forcing the whole `.app` wider
  than the viewport instead of letting the sidebar+content fit. Measured directly on a 375px-wide
  viewport: sidebar (220px, fixed) + content (317px, refusing to shrink) = 537px, causing
  page-wide horizontal scroll on every single page in the app. One-line fix (`min-width: 0` on
  `.content`) plus a `overflow-x: auto` safety net so any page with an unusually wide table/row
  scrolls internally instead of forcing the layout wider again in the future.
- The sidebar now defaults to collapsed on a first visit from a narrow (≤768px) viewport — a fixed
  220px column left almost no room for content on a phone-sized screen otherwise. This only affects
  a device's *first* visit (no saved preference yet); an existing collapsed/expanded choice is
  never overridden. While expanded on a narrow viewport, the sidebar renders as a full-screen
  overlay (`position: fixed; inset: 0`) instead of squeezing content into a ~150px sliver next to
  it, dismissed the same way it's opened.
- Bumped the sidebar's mobile "☰" show/hide toggle from a ~28px tap target to a proper 40×40px one.
- Reduced `.content`'s padding on screens ≤640px (28px/36px down to 16px) so more of a small
  screen's width goes to actual content.
- Verified live in-browser at a 375×812 mobile viewport (with Chrome/Android UA emulation) across
  Dashboard, Settings, and the Movies library (both poster-grid and list/table views, both the
  sidebar and top-bar nav layouts): confirmed zero horizontal overflow on every page checked
  (`window.innerWidth` now genuinely matches the viewport, versus 537px of forced overflow before
  the fix), the sidebar auto-collapses on a fresh mobile visit and opens as a full-screen overlay,
  and re-verified desktop (1280px) is completely unaffected — sidebar still defaults expanded, no
  overflow, existing behavior unchanged.

## Round 114 — automated test suite (item #1 of the scoped improvement list)
- Added a real automated test suite (vitest + supertest) for the server, starting with the highest-
  risk paths per the earlier scoping note: the duplicate-merge tool (`services/duplicateCheck.ts`)
  and the pagination/filtering work from Round 113 (`GET /api/media`, `GET /api/media/stats`).
  Deliberately not aiming for full coverage in one round — this establishes the harness and pattern
  for tests to keep accumulating against, same as this session's own manual practice of verifying
  everything against real backends rather than mocks.
- Split `server/src/index.ts` into `src/app.ts` (a `createApp()` that does all DB/settings/route
  init and returns the Express app, but never calls `.listen()` or starts the cron scheduler) and a
  now-thin `index.ts` that just calls `createApp()` then listens — this is what makes the routes
  actually testable with supertest without a real running server or background jobs firing during
  tests. No behavior change for production; same init order, same listen call.
- New `server/tests/helpers/testDb.ts`: gives every test file a real, fully-isolated database —
  SQLite gets a fresh temp-dir file per test file; Postgres (when `AONARR_DATABASE_DRIVER=postgres`
  is set, e.g. in CI) gets its `public` schema dropped and recreated before that file's app startup
  runs, so the normal schema-create + default-seed path runs against a genuinely clean database
  every time, matching first-boot production behavior exactly.
- New GitHub Actions workflow (`.github/workflows/server-tests.yml`, only in this branch/PR — not
  something Claude Code can trigger) runs typecheck plus the full test suite against BOTH a fresh
  SQLite file and a live Postgres service container on every push/PR touching `server/**`, so future
  rounds get automatic dual-dialect regression coverage instead of relying solely on manual `docker
  compose` verification.
- A real dialect bug was caught while building this: one of the new tests used SQLite-only
  `datetime('now')` in a raw INSERT, which failed against Postgres with `function datetime(unknown)
  does not exist` — fixed by using the existing portable `nowExpr(db)` helper instead. The bug was
  in the new test code, not the app itself, but it's exactly the kind of dialect-drift mistake this
  suite exists to catch before it reaches app code.
- Verified live: ran the full 11-test suite via `npm test` inside a Node 20 container (matching the
  Docker image's pinned Node version, since the local host's Node 26 has no prebuilt `better-sqlite3`
  binary yet) against both SQLite and a real Postgres 16 container — all 11 pass on both after the
  `datetime()` fix above.

## Round 113 — server-side library pagination
- Item #2 of the previously-scoped improvement list: `GET /api/media` (the Library page's main
  fetch) now returns `{ items, total }` with real `limit`/`offset`/`sort`/`status`/`contentRating`
  query params instead of a bare array of every item of a type — a large library (thousands of
  albums/books/ROMs) no longer pulls its entire contents into the browser just to show, filter, and
  sort one page of tiles. Sort and every status filter (including "Unmatched") now run as SQL
  conditions server-side; the Library page's local `.filter()`/`.sort()` over the full array is
  gone.
- Added `GET /api/media/stats` — a separate, lightweight aggregate endpoint (item/child totals, the
  distinct content-rating list for the type's filter dropdown) that stays correct independent of
  which page you're viewing, since the header "N have / N missing / N total" badges shouldn't
  change just because you paged forward.
- Added Prev/Next pagination controls to the Library page (60 items/page), shown only when a
  filtered result set actually exceeds one page.
- New shared `server/src/services/mediaQuery.ts` builds the WHERE/ORDER BY/params once for both the
  list and stats routes, so they can't silently drift on what counts as "in scope" (type/tag/group
  scoping, the per-user content-rating restriction, household `allowedTypes`).
- Known, intentional behavior change: "Select all" (the bulk-select toolbar) now selects only the
  current page's items rather than every item matching the current filter across the whole type —
  renamed to "Select all on page" to make the new scope explicit, matching how paginated bulk
  actions work elsewhere.
- Verified live against both SQLite and Postgres: seeded 75 synthetic movies (25 flagged
  downloaded), confirmed page 1/2 boundaries, title-sort ordering, the "Downloaded" status filter
  (25 results, correctly collapsing to zero pagination controls since they fit on one page — caught
  and fixed a real bug here where the pagination math was using the unfiltered stats total instead
  of the filtered list's own total, which showed "Page 1 of 2" for a 25-item filtered result), and
  the "Unmatched" filter (all 75, since none had external ids) — identical results on both dialects.

## Round 112 — "Recently Changed" dashboard widget
- Added a "Recently Changed" Dashboard widget (item #5 of the previously-scoped improvement list):
  a table of the most recent grab/import/auto-archive/subtitle events across the whole library,
  each row linking straight to the affected item. Reuses the existing `history` table (already
  populated by `importer.ts`/`scheduler.ts`/`archival.ts`) rather than adding new tracking — no
  schema change needed.
- New `GET /api/dashboard/recent` (server/src/routes/dashboard.ts): a smaller, household-account-safe
  sibling of `activity.ts`'s admin-only `/timeline` — same `history` join, capped to 15 rows, no
  Requests merged in (this widget is about library content changes, not request activity).
  Filtered by `allowedTypesFor(req)` like every other dashboard endpoint.
- Slots into the existing widget/layout-customization system with no extra wiring — adding the
  `recentlyChanged` entry to `widgetDefs` automatically made it reorderable/hideable/resizable via
  the Dashboard's existing "Customize layout" panel.
- Verified live against both SQLite and Postgres: seeded `history` rows directly (grabbed/imported
  events against the Daft Punk artist added in Round 110's verification), confirmed the widget
  renders the correct title/type/event/timestamp on both dialects and that its row navigates to the
  right media item.

## Round 111 — Starr-style per-item and library download progress
- Added Sonarr/Radarr-style progress to episodic (TV, Anime) and collection (Music, Books,
  Audiobooks, Comics, Manga, Online Videos, Courses) library types: each media tile (poster and
  list view) now shows a progress bar and an "X/Y" count of how many of its episodes/albums/issues
  are actually downloaded versus missing, not just the item-level "has at least one file" badge
  that already existed. "single"-shape types (Movies, ROMs, Adult) are unaffected — one file per
  item means their existing Downloaded/Missing badge is already the full picture.
- Added the same child-level rollup to each library's header stats: alongside the existing
  item-level "N have / N missing / N total" badges, episodic/collection libraries now also show a
  library-wide "N episodes/albums/... downloaded" / "N missing" total — the library-level aggregate
  Sonarr/Radarr both surface, which AoNarr's per-item-only counts couldn't answer before (e.g. "3/10
  episodes" per show doesn't tell you how many episodes are missing across the whole library).
- New shared `attachChildCounts()` (server/src/services/childCounts.ts) computes these via one
  grouped aggregate query per shape (`episodes`/`sub_items`, chunked by 500 ids) rather than one
  query per item, and is attached to every `GET /api/media` response.
- Verified live against both SQLite and Postgres: imported artists via search (Daft Punk/Deezer,
  38 albums; Radiohead/MusicBrainz, 100 albums), confirmed the Music library's poster tiles, list
  view, and header stats all render the correct per-item and library-wide "0/38"/"0/100"/"138
  albums missing" figures on both dialects, and confirmed a single-shape library (Movies) shows
  neither the progress bar nor the child-count header badge.

## Round 110 — music library auto track-matching
- Fixed a real bug: adding an artist (via search or an import list) fetched and created its albums
  but never fetched their tracks, so a newly-added artist's albums sat with an empty track list
  until an admin opened each one and clicked "Fetch tracks" by hand. Both album-creation paths
  (`POST /api/metadata/import`'s eager child-fetch, and the Trakt/IMDb/Last.fm import-list sync's
  `insertArtistAlbums`) now call a new shared `insertTracksForAlbum()` helper for every album that
  has a provider external id, right after its album row is committed.
- Track fetches run *after* the album-insert transaction commits, not inside it — holding a
  Postgres connection open across a whole artist's worth of sequential network calls would have
  blocked other queries needing that same connection for as long as the slowest artist add took.
- Found and fixed two real issues surfaced only by calling this fetch in a tight per-album loop
  (previously it only ran one album at a time, from a manual button click): (1) MusicBrainz's
  fetch calls had no timeout, so a single stalled request could hang an entire artist's import
  indefinitely — added a 10s `AbortSignal.timeout` to the MusicBrainz and Deezer track-fetch
  requests; (2) MusicBrainz enforces roughly 1 request/second and this loop was issuing 2 requests
  per album back-to-back with no pause, producing a wall of HTTP 503s partway through any
  multi-album artist — added a ~1.1s pause between MusicBrainz album fetches. A single album's
  fetch failure (unsupported provider, timeout, rate limit) is still best-effort and doesn't block
  the rest of the artist's albums or the add itself.
- Verified live against both SQLite and Postgres backends: imported "Daft Punk" via the Deezer
  provider on each, confirmed all 38 albums were created and all 266 of their tracks were
  automatically populated with no manual "Fetch tracks" click, on both dialects identically. Also
  confirmed against MusicBrainz (via a large-discography artist) that the new timeout aborts
  cleanly instead of hanging, and that a run of provider errors no longer stalls the request.

## Round 109 — top-bar nav layout, dashboard widget resizing
- Added a top-bar layout as an alternative to the left sidebar, toggled per-browser from the same
  "Layout options" panel Round 108 added: Library and the admin-only Manage/Configuration/System
  sections render as click-to-open dropdowns instead of the sidebar's inline accordion, since a
  horizontal bar has no room to expand a section in place. The section reorder/hide customization
  from Round 108 applies to both layouts — the same saved order/visibility, just rendered
  differently depending on which one is active.
- Added per-widget sizing to the Dashboard's "Customize layout" panel: each widget can be set to
  full-width or half-width, with two half-width widgets sitting side by side (collapsing back to
  one column under 900px so a half-width table/grid never gets squeezed unreadable). Extended the
  shared layout-customization hook with a `sizes` map alongside the existing order/hidden state.
- Fixed a real bug caught while building the top-bar layout's own settings panel: embedding the
  reorder/hide/resize controls inside the existing `DropdownMenu` component closed the whole menu
  on the *first* click inside it (checkbox, ↑/↓ button, or select), since that component closes on
  any click bubbling up from its contents — fine for a menu of one-shot actions, unusable for a
  multi-step settings panel. Built a plain toggle + positioned panel for this one case instead,
  confirmed live that clicking a reorder button now keeps the panel open.
- Verified live in-browser: switching to the top bar renders correctly (dropdowns open, Library
  shows every media type, admin groups show their links) and switching back to the sidebar is
  clean; a reorder click inside the top bar's settings panel applies immediately without closing
  it; two widgets set to half-width render side by side and a reload keeps both the layout mode
  and the widget sizes.

## Round 108 — UI polish: layout bugs, layout options, metadata merge
- Fixed a real navigation bug: switching from a grouped library (Online Videos, ROMs, Adult) to a
  flat one (Music, Movies, ...) left the previous type's group state sitting around, so the flat
  library's page kept showing the old type's group in its breadcrumb (e.g. "Music / Youtube" after
  visiting Online Videos → Youtube then navigating to Music) — confirmed via a real client-side
  navigation, not just a fresh page load, which is what the bug actually required to reproduce.
- Fixed the per-library "on disk" size figure: switching libraries quickly could let an earlier,
  slower-to-resolve request overwrite a later, faster one's correct size — the page would show
  whichever library's request happened to finish last, not necessarily the one being viewed.
- Fixed several button/input misalignments on the Activity, Settings, and System pages where a
  button sat visibly lower than its row-mates (an input, a label, or another cell in the same
  table row) — all traced to the same cause: the default button's `margin-top: 16px` (meant for a
  button following a stacked label+input) leaking into flex rows that were never meant to have it.
- Fixed select/dropdown text reading as cut off by the arrow: widened the reserved arrow padding
  and added ellipsis truncation so a select that's narrower than its longest option now shows
  "..." instead of a letter just vanishing at the box edge; also stopped toolbar buttons/selects
  from being flex-compressed below their own content width before wrapping to a new line.
- Added a side-by-side metadata-merge tool to the media detail page: fetch from 2+ providers, then
  pick which source (current value or any fetched provider) to use per field — poster/title/year/
  overview — and apply the merged result in one PATCH. Added `year` to the item PATCH endpoint's
  supported fields, needed for the merge to actually apply a picked year.
- Added layout customization, saved per-browser: the Dashboard's widgets (Library Size, Recently
  Added, Recently Watched, Upcoming) can now be reordered and hidden via a "Customize layout"
  panel; the sidebar's admin-only sections (Manage, Configuration, System) can be reordered and
  hidden the same way; the whole sidebar can be collapsed to reclaim screen width, with a floating
  toggle to bring it back. Also widened the library poster-size picker from 3 sizes to 5
  (X-small/Small/Medium/Large/X-large).
- Verified live against both Postgres and SQLite (the `year` PATCH field) and in-browser against
  SQLite: the breadcrumb fix confirmed via an actual client-side sidebar-link navigation (not a
  fresh page load, which wouldn't have reproduced the bug); the metadata-merge tool confirmed
  end-to-end with real MusicBrainz/Deezer fetches, picking a mixed poster+year combination and
  confirming the applied result matched exactly; the dashboard/sidebar customization confirmed
  persisting across a reload.

## Round 107 — add a duplicate-merge tool
- New "Duplicates" page (System nav group) for cleaning up the duplicate rows that predate Round
  106's import-matching fix, or anything else that ends up looking like a duplicate later: sweeps
  the whole library for items sharing an exact (normalized title, year), lets an admin pick which
  one to keep per group, and merges the rest into it in one click.
- Merging adopts the file/metadata the keeper is missing from whichever duplicate has it,
  reassigns everything meaningful pointing at the removed rows instead of silently losing it to
  cascade-delete — episodes/sub-items (skipping anything that would collide with what the keeper
  already has), tags, collection membership, grab history, the active download queue, blocklist
  entries, watch status, share links, and household requests. A colliding child or an unadopted
  extra file is left alone by default; check "Recycle files that aren't kept" to send those to the
  Recycle Bin instead of leaving them on disk untracked.
- New `GET /api/duplicates` and `POST /api/duplicates/merge` endpoints; the tag/collection-
  membership reassign uses the same dialect-conditional `INSERT ... ON CONFLICT`/`INSERT OR IGNORE`
  pattern established for other upsert-shaped writes, since both have a composite primary key a
  loser and keeper could collide on.
- Verified live against both Postgres and SQLite: a 3-way movie duplicate (one with a file, two
  without) merges to one row with the file and a tag from a different duplicate both preserved; a
  TV show duplicate with an overlapping episode keeps the keeper's copy and still picks up the
  loser's non-overlapping episode; two duplicates sharing the identical tag merge without a
  constraint error on either backend.

## Round 106 — fix movie import duplicates (#10)
- Fixed #10: movies (and only movies/ROMs/Adult — the "single" shape) could get duplicated by
  every import path (Scan & Import, and Plex/Jellyfin/Emby/Radarr media-server import) because
  each one matched a candidate file/item against *only currently-missing* movies (`has_file = 0`)
  instead of every movie of that type — the same title/episodic/collection import paths already
  matched against everything, this was the one place that didn't. Once a movie had a file, it
  became invisible to future matching, so a second copy, a re-scan, or a later media-server sync
  seeing the same movie again always created a brand new row instead of recognizing it.
  Newly-created movies were also never added back to the in-memory list a scan matches new files
  against, so two files for the same brand-new movie in one scan (a sample + the real file, two
  quality variants) each created their own row too.
- Now matches against every movie of the type regardless of file status; a match on an
  already-has-a-file movie is recognized (not duplicated) without overwriting its existing file —
  the extra file is left on disk and reported in the scan's skip log instead. Audited every other
  import path (import lists, watchlist CSV import, Starr's Lidarr/Readarr collection import, Add
  Media search) for the same class of bug — all of them already matched correctly (by external id,
  or via a fresh per-item duplicate check), this was isolated to the two single-shape paths.
- Existing duplicate rows from before this fix aren't automatically merged — use the Library page's
  multi-select "Remove" action (added in Round 103) to manually clean those up.
- Verified live against both Postgres and SQLite: two files for one new movie in one scan now
  create exactly one row; a later scan/import seeing an already-imported movie again also stays at
  one row, with its original file path preserved.

## Round 105 — surface why Scan & Import skips files, retry flaky ffprobe reads
- Scan & Import previously logged only a bare `skipped: N` count with no indication of which
  files were skipped or why — a file with an unparseable filename, wrong folder depth, or outside
  every root folder simply vanished from view with nothing to diagnose. Every skip site now
  records a specific reason (e.g. "couldn't guess a title from the filename", "sits directly in
  the root folder with no parent folder"), and both the manual scan-import route and the scheduled
  library-scan job log each skipped file's path and reason (capped at 20 per run so a systemic
  naming mismatch across hundreds of files doesn't flood the log).
- `probeMediaInfo` (ffprobe) now retries once, after a short delay, when the failure looks like a
  transient read issue ("moov atom not found", "invalid data found", "could not find codec
  parameters") rather than a genuinely corrupt file — these are the exact errors a network-mounted
  file (NFS/SMB share, a cache-to-array move still settling) throws when read mid-flux by one
  process while playing back fine moments later in another. A file that fails identically on both
  attempts is still reported as unprobed (never blocks the import itself, unchanged from before).
- Verified live: an unparseable filename now logs its exact path and reason instead of a silent
  count; a file that fails ffprobe still imports correctly with `has_file` set, matching the
  existing "probe failure never blocks import" behavior.

## Round 104 — fix AllDebrid grabs failing on every .torrent-byte upload
- Fixed #1 (reopened): every grab that resolved to raw `.torrent` bytes (rather than a magnet URI)
  was silently treated as "AllDebrid rejected the magnet," even when AllDebrid had accepted it
  fine — `/magnet/upload/file`'s response nests its result under `data.files[]`, not
  `data.magnets[]` like `/magnet/upload` does, and the code always read `magnets[]` regardless of
  which endpoint was actually called. This was the follow-up bug behind "the error has changed"
  after the earlier redirect/torrent-bytes resolution fix: that fix correctly started resolving
  proxy URLs to real magnets/torrent bytes and reaching AllDebrid successfully, but then
  misparsed the file-upload response and reported a false failure on every one.
- Verified against a local mock AllDebrid API server matching the documented response shapes for
  both `/magnet/upload` (redirect-to-magnet case) and `/magnet/upload/file` (raw torrent-bytes
  case, the actual bug) — both now report their grab as completed.

## Round 103 — GitHub issue fixes: music tracks/artwork, bulk remove, manga chapters
- Fixed #9 (no track data): Scan & Import never created individual `tracks` rows for a Music
  album folder, only the album-level has_file/file_path — the album detail page showed "0 have /
  0 total, no track data available" forever even with every file on disk. Now parses a track
  number/title per file during scan (same "01 - Song" convention the download-import path already
  assumed) and upserts a `tracks` row for each one, via a portable `ON CONFLICT ... DO UPDATE` that
  works unchanged on both SQLite and Postgres. Added a startup backfill
  (`backfillMissingAlbumTracks()`) so already-scanned albums self-heal on the next restart instead
  of needing a full library re-scan (which wouldn't have picked them up anyway — known album
  folders are skipped on re-scan).
- Fixed #7 (no artist poster artwork): MusicBrainz — the default artist metadata provider, kept
  for its authoritative id — never returns artist artwork at all, so every scan-imported/refreshed
  artist stayed posterless regardless of which of Discogs/Last.fm keys were configured. Now
  opportunistically backfills a MusicBrainz result's missing poster from Deezer's public,
  keyless API by name match.
- Implemented #8 (album artwork): added a `poster_url` column to `sub_items`; Deezer/Discogs/
  Last.fm album-listing fetches now capture cover art automatically when an artist is added via
  search or an import list; added a manual "click to add/change cover art" affordance (Library
  page's album table and the album detail page) for scan-imported albums or any provider that
  doesn't have art.
- Added #6 (bulk remove): a `POST /media/bulk/delete` endpoint and a "Remove" button in the
  Library page's multi-select toolbar, alongside the existing Monitor/Unmonitor/Search actions —
  supports the same untrack-only vs. also-delete-files choice as the single-item delete.
- Investigated #5 (manga management): the media type, search providers, and frontend nav already
  existed, but manga's default provider (AniList) has no per-chapter listing API, so every manga
  added through the normal flow sat at "0 total" chapters forever — the same class of gap as #9.
  Added a MangaDex chapter-feed fetcher and switched manga's default provider to MangaDex (which
  has one), matching how Comics already defaults to ComicVine for the same reason.
- Verified live against both a real Postgres 16 container and SQLite: scan-imported a multi-track
  album and confirmed all tracks appear with correct numbers/titles; confirmed the startup backfill
  recovers a previously-scanned album's tracks after clearing them; confirmed a MusicBrainz artist
  search result gets backfilled with a real Deezer poster; confirmed manual and automatic album
  artwork both persist; confirmed bulk delete removes multiple items in one call; confirmed adding
  a manga via MangaDex populates a full real chapter list.

## Round 102 — PostgreSQL migration complete
- Converted the last 3 files: `services/scheduler.ts` (auto-search/grab, queue polling, stalled-
  download cleanup, retry logic, video-channel checks), `routes/search.ts` (manual/bulk search and
  grab), and `services/scheduledBackup.ts` — **all 80 files converted**, `AONARR_DATABASE_DRIVER=
  postgres` now runs the complete app
- Designed and implemented real per-dialect database backup/restore, closing the one deferred
  design question from earlier rounds: SQLite keeps `better-sqlite3`'s own backup API; Postgres now
  uses `pg_dump --format=custom`/`pg_restore --clean --if-exists`, shared between the scheduled
  backup job and the manual `/system/backup`/`/system/backup/restore` routes
- Added `postgresql-client-17` (from the official PGDG apt repo, not Debian bookworm's own v15
  package) to both Docker images — a same-version client refuses to dump servers newer than itself,
  which is now the common case
- Fixed a live-discovered `pg_restore` compatibility issue: `--single-transaction` aborted an entire
  restore over one cosmetic `SET transaction_timeout` statement unsupported on older servers;
  dropped the flag and added targeted error-inspection so a restore that only skipped that one
  harmless statement is correctly reported as successful
- Added `nowOffsetHoursExpr()` for `cleanupStalledDownloads()`'s hour-granularity threshold
- Verified live against a real Postgres 16 container (deliberately one version behind the Postgres
  17 client, to actually exercise the compatibility fix): manual/bulk search and grab, and a full
  backup → mutate → restore roundtrip with a real downloaded dump file — regression-checked against
  SQLite, including a full backup/restore roundtrip there too

## Round 101
- PostgreSQL support: converted `routes/media.ts` — the largest remaining file (~40 routes: item
  CRUD, tags, bulk monitor/tag, CSV export/import, metadata export, corrupt-file check, rematch,
  watch-state, episodes, sub-items/tracks, yt-dlp direct download) — 77 files converted so far, 3
  remain
- Converted `bulk/monitor` and `bulk/tag`'s better-sqlite3 synchronous transaction-closure pattern to
  the async `db.transaction(async () => {...})` pattern used since Round 90
- Converted 2 `INSERT OR IGNORE` call sites (`media_item_tags`) to the dialect-conditional
  `ON CONFLICT DO NOTHING` pattern
- Verified live against a real Postgres container: full CRUD across movie/series/artist shapes, tags
  (single-item and bulk), episodes, sub-items, watch-state, and CSV export — same sequence
  regression-checked against SQLite

## Round 100
- PostgreSQL support: converted `routes/system.ts` (`/network-stats`, `/status`, `/health`,
  `/orphaned-scan`) — 76 files converted so far, 4 remain
- `/backup` and `/backup/restore` deliberately stay on the raw SQLite handle (`Database.backup()`,
  file-swap restore) — no Postgres equivalent exists yet, tracked as the same open design question as
  `services/scheduledBackup.ts`
- Fixed a camelCase SQL alias (`AS totalBytes` → `AS "totalBytes"`) in `/network-stats` that would
  have silently folded to lowercase and broken the JSON response under Postgres
- Added `nowOffsetHoursExpr()` next to the existing day-granularity `nowOffsetExpr()` for `/health`'s
  6-hour stuck-queue threshold
- Verified live against a real Postgres container: a stuck queue item and a low-disk-space sample
  correctly surfaced in `/system/health`'s warnings, cross-checked against `/metrics`'s Prometheus
  counters — same sequence regression-checked against SQLite, including a real backup download

## Round 99
- PostgreSQL support: converted `routes/importLists.ts`, `routes/metrics.ts`,
  `services/starrImport.ts` (Radarr/Sonarr/Lidarr/Readarr library migration), and
  `services/importer.ts` (post-download file placement/manual import) — 75 files converted so far, 5
  remain
- Fixed `routes/metrics.ts`'s Prometheus counters to wrap raw `pg`-driver `COUNT(*)` string results
  in `Number(...)` so they render as real numeric metric values instead of string literals
- Verified live against a real Postgres container: import-list CRUD, the Prometheus metrics scrape,
  and an end-to-end manual movie import (file move, has_file/path/quality update, history row) — same
  sequence regression-checked against SQLite on the same build

## Round 98
- PostgreSQL support: converted `services/mediaServerImport.ts` (Plex/Jellyfin/Emby movie + series
  library import), `services/importLists.ts` (Trakt/IMDb/Last.fm list syncing), and
  `services/libraryScan.ts` (filesystem scan-and-import for movies, episodic shows, and
  collection/artist items, including the has_file rollup and concurrency lock) — 71 files converted
  so far, 9 remain
- Fixed one call site in `services/starrImport.ts` to await the now-async `defaultQualityProfileId()`,
  without converting the rest of that file
- Widened `insertSeriesEpisodes()`/`insertArtistAlbums()`'s `mediaItemId` parameter type in
  `importLists.ts` to accept `null`, matching the async DB driver's nullable `lastInsertRowid`
- Verified live against a real Postgres container: TV episode, music album track, and movie file
  scan-imports all correctly matched/created their `media_items` rows with the right has_file rollups
  and child rows (`episodes`/`sub_items`) — same sequence regression-checked against SQLite on the
  same build

## Round 97
- PostgreSQL support: converted `services/traktSync.ts`, `routes/metadata.ts`,
  `services/recommendations.ts`, and `routes/watchlistImport.ts` — 68 files converted so far, 12 remain
- `routes/metadata.ts`'s `/import` route had 3 better-sqlite3-style synchronous
  `db.transaction(fn)(rows)` calls (episode/album/child batch inserts) — converted to the async
  transaction pattern established in earlier rounds
- Closed a small ordering gap: `queueForReview()` in the watchlist-import "not found" path is now
  correctly `await`-ed inline instead of fire-and-forget
- Verified live against a real Postgres container: manual media import including the
  transaction-based child-episode insert, Trakt sync's no-op-when-unconfigured path,
  recommendations' DB-backed queries running cleanly ahead of the key-gated external API calls, and
  watchlist import's full duplicate-skip → not-found → import-review-queue flow — same sequence
  regression-checked against SQLite on the same build

## Round 96
- PostgreSQL support: converted `services/storageForecast.ts`, `services/duplicates.ts`,
  `services/upgradeCandidates.ts`, and `services/cleanupSuggestions.ts` (the first Tier 1 batch of a
  newly-written conversion plan for the remaining files) — 64 files converted so far, 16 remain
- **Found and fixed a serious, previously-latent Postgres bug unrelated to this migration's own async
  conversion work**: the schema translation mapped SQLite's `INTEGER` (already 64-bit) to Postgres's
  `INTEGER` (32-bit, max ~2.1GB) literally for 4 byte-count columns — `queue.size`,
  `recycle_bin.size_bytes`, `disk_usage_samples.free_bytes`/`total_bytes`. Any real download or file
  over ~2GB (a routine 4K remux) would silently overflow on every Postgres deployment doing real
  downloads. Caught live when disk-usage sampling failed against a real ~1TB test filesystem. Fixed
  the fresh-install schema (`BIGINT` on all 4 columns) and added a startup migration that safely
  widens existing installs' columns on next restart, verified to correctly recover real data with no
  loss and to be idempotent across repeated restarts
- Quoted several more unquoted camelCase SQL aliases found along the way
- Verified live against a real Postgres container: simulated an existing pre-fix install, confirmed
  the predicted overflow error, then confirmed the startup migration fixes it; exercised disk usage
  sampling (a real ~1TB value that would have overflowed pre-fix), repeated-import detection,
  upgrade-candidate detection, and both cleanup-suggestion routes end to end — same sequence
  regression-checked against SQLite, where this bug class doesn't exist at all

## Round 95
- PostgreSQL support: converted `services/customFormatScoring.ts` (deferred since Round 85 as
  "called from deep within the search/grab pipeline") — 60 files converted so far, 20 remain
- Its 2 call sites (`routes/search.ts`'s manual-search annotation, `services/scheduler.ts`'s
  `chooseBestResult()`) turned out to be the same tractable shape Round 93 found repeatedly: a plain
  synchronous `.map()` callback, fixed with the same `Promise.all(items.map(async ...))`
  restructuring already used twice last round
- Verified live end to end against SQLite with a real search (not mocked): created a movie, a custom
  format matching a release title pattern, a scored quality profile, and a local mock RSS indexer,
  then confirmed a real manual search correctly returned the configured `formatScore`/`formatMatches`
- Postgres verification this round was necessarily lighter: `search.ts`/`scheduler.ts` (both still
  unconverted) read what a search needs through the Round 80 shadow-SQLite path, so a live
  end-to-end search can't be driven from outside the app under Postgres the way it can under
  SQLite's single database — `scoreRelease()`'s own queries are unchanged from already
  Postgres-verified patterns from Round 85, and typecheck + the alias-risk grep both passed clean

## Round 94 — GitHub issue fixes + Soulseek support
- **Fixed #1 — AllDebrid grabs failing with "Magnet is not valid"**: the `alldebrid` client passed
  an indexer's raw Torznab "get"/proxy `downloadUrl` straight to AllDebrid's magnet-upload endpoint
  instead of resolving it first. Added a shared `resolveDownloadSource()` helper that follows a
  redirect to a real `magnet:` URI (fetch can't follow a redirect to a non-http(s) scheme itself,
  so this is done by hand with `redirect: "manual"`) or reads raw `.torrent` bytes when the proxy
  serves the file directly instead of redirecting; `.torrent` bytes now upload via AllDebrid's
  multipart `/magnet/upload/file` endpoint rather than the URI endpoint. Also fixed the same latent
  issue in the `realdebrid` client, which had the same "not every proxy URL is a magnet" gap.
  Verified against a local mock server covering direct magnet, single/multi-hop redirect-to-magnet,
  and raw `.torrent` bytes.
- **Fixed #2 — duplicate TV shows after scanning**: `POST /media/scan-import` had no guard against
  two overlapping scans of the same type — a scheduled "Library Import" job firing while a manual
  scan (or a duplicate click) was still in flight would race, both loading their own snapshot of
  existing shows before either had inserted anything, both concluding "no match" for the same new
  series, and both inserting their own duplicate row. `probeMediaInfo`'s per-file ffprobe subprocess
  call is slow enough that this was an easy real-world race, not just a theoretical window. Fixed
  with an in-process per-type lock in `scanAndImportLibrary` — a second overlapping call for the
  same type now skips instead of racing. Verified live by firing two concurrent scan-import requests
  against the same library type and confirming no duplicate rows resulted.
- **Fixed #3 — TV shows shown as "Missing" despite having every episode**: the Library page's
  "Missing" badge reads `hasFile` on the top-level media_items row, but `scanAndImportLibrary`'s
  episodic/collection branches only ever set `has_file` on the *child* episode/sub_item row they
  matched or created — never rolling it up to the parent series/collection, unlike
  `mediaServerImport.ts`/`starrImport.ts`'s import paths, which already did this correctly. Added
  the same rollup (`UPDATE media_items SET has_file = 1 WHERE ... id IN (SELECT DISTINCT
  media_item_id FROM episodes/sub_items WHERE has_file = 1)`) to Scan & Import, plus a one-time
  startup backfill (`backfillEpisodicAndCollectionHasFile()`, safe to run unconditionally on every
  boot — each UPDATE is a no-op once already-fixed) so existing installs' already-affected shows get
  corrected without needing a fresh re-scan. Verified live: scanned in a two-episode show and
  confirmed `hasFile` flipped to `true` on the parent series row.
- **Added #4 — Soulseek (via slskd) as a download client**: Soulseek has no Torznab indexer and no
  real "download URL" — files are only (username, remote filename) pairs from Soulseek's own
  search. Added a `slskd` download client type (host/port/API key, same shape as qBittorrent/
  SABnzbd — a real external client AoNarr tracks progress on, not a debrid-style pull-to-self
  client) plus `services/soulseek.ts`, which queries a configured slskd daemon's own search API
  directly for Music-library searches and encodes each result's (username, filename, size) into a
  `slskd://` pseudo-URI riding through AoNarr's existing "grab posts a downloadUrl back" contract
  unchanged — no changes needed to the indexer/scheduler pipeline itself. Verified the URL encode/
  decode round-trip and the search-response parsing against a local mock slskd server (covering
  multiple peers, a peer with no free upload slot, and Windows-style remote paths); verified live
  that creating a client, its host/port validation, and the search route's graceful failure when
  slskd is unreachable all work correctly end to end.

## Round 93
- PostgreSQL support: converted `services/blocklist.ts`, `services/rootFolderSelect.ts`,
  `services/releaseGroupStats.ts`, `services/duplicateCheck.ts`, and `services/importExclusions.ts` —
  59 files converted so far, 21 remain
- Corrected an overly pessimistic assessment from Round 92: re-checked every one of these 5 services'
  ~25 call sites individually instead of assuming from their role in "the pipeline," and found only 2
  genuinely needed control-flow restructuring — the rest were plain `for` loops or values computed
  before a `.map()`, trivially `await`-able with no surrounding rewrite
- Restructured `scheduler.ts`'s `chooseBestResult()`: `getGroupReputation()` was called directly
  inside a `.sort()` comparator (which can't `await`) — fixed by precomputing every release group's
  reputation into a `Map` before sorting, then doing synchronous lookups in the comparator
- Restructured `recommendations.ts`'s exclusion filter (`isExcluded()` as an `Array.filter()`
  predicate) with a small local `filterAsync()` helper
- Updated every other call site (in `search.ts`, `media.ts`, `metadata.ts`, `watchlistImport.ts`,
  `importLists.ts`, `traktSync.ts`, `importer.ts`, `scheduler.ts`, `system.ts`) with just `await` —
  without converting those files' own other database calls, the same surgical pattern Round 90 used
- Verified live against a real Postgres container: blocklist-grab rejection, duplicate-detection 409s,
  root-folder auto-select, and per-group release stats all work correctly; ruled out an unrelated
  pre-existing bug (adding media with a root folder 500s under Postgres, reproducing even with an
  explicit `rootFolderId`) as the known "`media.ts` still writes to the orphaned shadow SQLite"
  Round 80 caveat, not something introduced this round — confirmed working correctly on SQLite, where
  there's no database split — full flow regression-checked against SQLite on the same build

## Round 92
- PostgreSQL support: converted `services/mediaAnalysis.ts` + `routes/mediaAnalysis.ts` (the Library
  Analysis page) — 54 files converted so far, 26 remain
- Found and fixed a real, pre-existing bug unrelated to database portability: the episodes query in
  `getLibraryAnalysis()` never selected `e.media_item_id`, but its row mapper read it anyway — every
  episode analysis item's `mediaItemId` was silently `undefined` in the API response, on both
  backends, since this feature shipped
- Documented why the remaining 26 files (the media-add pipeline and the search/grab/scoring pipeline)
  don't decompose into further small batches: their helper functions are called inline from
  synchronous `.filter()`/`.sort()`/`.some()` predicates in the big route/service files, not from
  simple `await`-able call sites — converting them needs restructuring the surrounding control flow,
  not just adding `await`
- Verified live against a real Postgres container: seeded real `media_info` JSON and confirmed the
  instant analysis route's summary and the episode mediaItemId fix, then generated a real playable
  file with `ffmpeg` and ran the full-library re-probe job against it with real `ffprobe`, confirming
  the result correctly persisted via the new async UPDATE — regression-checked against SQLite on the
  same build

## Round 91
- PostgreSQL support: converted `routes/settings.ts` (instance settings, API key regen, TOTP 2FA,
  config-template export/import) and `services/importReview.ts` + `routes/importReview.ts` — 52 files
  converted so far, ~18 remain
- Found and fixed a real, pre-existing bug that affected SQLite too, not just Postgres: several
  `settings.ts` routes wrote the `settings` table via raw SQL instead of `setSetting()`, silently
  bypassing the in-memory settings cache `requireAuth` reads on every request. In practice this meant
  a freshly regenerated API key didn't work until the next server restart, and disabling TOTP 2FA
  didn't take effect until restart either. Fixed by routing every settings write through
  `setSetting()`/a new `deleteSetting()`, and added `getAllSettings()` so reads use the cache too
- Found and fixed a genuine SQL portability bug: `queueForReview()`'s dedup check used SQLite's
  `col IS ?` null-safe-equality-with-a-parameter syntax, which is a straight syntax error on Postgres
  (its `IS` only accepts literal `NULL`/`TRUE`/`FALSE`). Fixed with the standard-SQL
  `IS NOT DISTINCT FROM`, which both backends support with identical semantics
- Verified live against a real Postgres container: confirmed both settings bugs existed pre-fix and
  are gone post-fix (immediate API-key and TOTP-disable effect, no restart needed), a full
  config-template export → import → export round-trip, and the import-review queue's list/counts/
  resolve/dismiss routes — same sequence regression-checked against SQLite, where the pre-fix bugs
  reproduced identically before the fix resolved them there too

## Round 90
- PostgreSQL support: converted the recycle-bin/corrupt-media cluster deferred since Round 86/88 —
  `services/recycleBin.ts` + `routes/recycleBin.ts`, `services/corruptMediaCheck.ts` +
  `routes/corruptMediaReview.ts`, and `services/archival.ts` (auto-archival) — 49 files converted so
  far, ~21 remain
- Unblocked by recognizing the only thing standing in the way was `recycleFile()`'s 3 call sites in
  the still-unconverted `routes/media.ts`, all already inside `async` handlers — adding `await` to
  those 3 lines was enough to convert the whole cluster without touching `media.ts`'s own (much
  larger) set of database calls
- `recycleBin.ts`'s scheduled-purge query was one of the 5 files flagged in the original SQL-
  portability audit for SQLite's `datetime('now', ?)` syntax — now using the `nowOffsetExpr()` helper
  added in Round 86
- Verified live against a real Postgres container: full delete-with-recycle → restore → re-delete →
  purge lifecycle through `media.ts`'s converted call sites, confirming the file actually moves and
  moves back on disk each time, plus the corrupt-media-review confirm/dismiss routes — same sequence
  regression-checked against SQLite on the same build

## Round 89
- PostgreSQL support: converted `services/push.ts` + `routes/push.ts`, `services/mediaServerWebhook.ts`
  + `routes/mediaServerWebhook.ts`, `services/libraryValidation.ts`, and `routes/requests.ts` to the
  async DB interface — 44 files converted so far, ~26 remain
- Confirmed `sendPush()`'s existing callers already treated it as a Promise before converting its DB
  calls to genuinely async, avoiding the "unconverted caller doesn't await" risk that's blocked
  several other small services in recent rounds
- Replaced two inline `datetime('now')` UPDATEs in `requests.ts` with the `nowExpr(db)` helper, and
  proactively applied `Number(...)` to two more `COUNT(*)` results per the established Round 84/86
  aggregate-as-string bug class
- Verified live against a real Postgres container: round-tripped a push subscription, confirmed a
  Jellyfin-style watch webhook resolved to a seeded media item and immediately appeared in the
  already-converted dashboard (a genuine cross-file check), and exercised the full request lifecycle
  including auto-approval's named-parameter insert and per-user storage stats — same sequence
  regression-checked against SQLite on the same build

## Round 88
- PostgreSQL support: converted `routes/activity.ts`, `routes/calendarFeed.ts` (both the admin token
  router and public `.ics` feed), `routes/dashboard.ts`, `routes/subtitles.ts`, and `routes/wanted.ts`
  to the async DB interface — 38 files converted so far, ~32 remain
- Quoted a large batch of unquoted camelCase SQL aliases, especially in `wanted.ts` and
  `calendarFeed.ts`'s hand-built multi-column SELECTs — same bug class as every prior round
- Proactively wrapped `dashboard.ts`'s `COUNT(*) AS count` in `Number(...)` before verification could
  catch it live, since Postgres returning aggregates as strings is now an established bug class from
  Round 84/86
- Surveyed and deliberately left `metrics.ts`, `metadata.ts`, and `watchlistImport.ts` unconverted —
  all three call into services used by the still-unconverted media-add/search pipeline; that cluster
  (duplicate/exclusion checks, media creation, `media.ts` itself) is better tackled as one dedicated
  round than piecemeal
- Verified live against a real Postgres container: dashboard counts came back as real numbers (not
  Postgres's string-typed `COUNT` result), the full activity queue lifecycle including its "no
  download client" 400 path, wanted/missing and calendar views with all aliased columns intact, and
  the calendar token + public `.ics` feed including its 401-on-wrong-token path — same sequence
  regression-checked against SQLite on the same build

## Round 87
- PostgreSQL support: converted `routes/blocklist.ts`, `routes/importExclusions.ts` (CRUD route
  only), `routes/artwork.ts`, `routes/librarySearch.ts`, and `routes/shareLinks.ts` to the async DB
  interface — 33 files converted so far, ~37 remain
- Found and fixed a real cross-dialect behavior difference: SQLite's `LIKE` is case-insensitive for
  ASCII by default, Postgres's is case-sensitive. `librarySearch.ts`'s global search now uses a
  dialect-conditional operator (`ILIKE` on Postgres) so search results stay identical across both
  backends instead of Postgres silently missing case-mismatched matches
- Quoted several more unquoted camelCase SQL aliases across this batch (same bug class as Round 80),
  including in a `UNION ALL` query where only the first branch's aliases needed it
- Deliberately left several small services unconverted (`blocklist.ts`, `importExclusions.ts`,
  `releaseGroupStats.ts`, `rootFolderSelect.ts`, `duplicateCheck.ts` services, plus
  `storageForecast.ts`/`duplicates.ts`) — all are called synchronously from the still-unconverted
  search/import pipeline or from `system.ts`/`scheduler.ts`, so converting them now would leave those
  callers unawaited on Postgres
- Verified live against a real Postgres container: case-insensitive search in both directions,
  artwork selection, full blocklist/import-exclusion/share-link CRUD (including the public
  token-based share fetch) — same sequence regression-checked against SQLite on the same build

## Round 86
- PostgreSQL support: converted `routes/collections.ts` (all 9 routes, including its smart-filter
  query builder and item-reorder transaction) and `routes/tracks.ts` (both routes) to the async DB
  interface — 28 files converted so far, ~42 remain
- Added `nowOffsetExpr(db, days)` to the async DB layer for SQLite's `datetime('now', ?)` relative-
  offset syntax (used by `collections.ts`'s "added in the last N days" smart filter) — translates to
  Postgres interval arithmetic; 4 more files flagged in the original SQL-portability audit can reuse
  it when they're converted
- Found and fixed two more instances of known migration bug classes: an unquoted `AS itemCount` SQL
  alias (Postgres folds it to lowercase, same class as Round 80's bug) and an un-coerced `COUNT(...)`
  aggregate read as a raw driver value (Postgres returns bigints as strings, same class as Round 84's
  `libraryGroups.ts` fix)
- Found a genuine Postgres incompatibility (not just a folding/type issue): SQLite's `INSERT OR
  IGNORE` has no Postgres equivalent at all. Fixed `collections.ts`'s add-item route with a dialect-
  conditional statement; `media.ts` has 2 more call sites using the same syntax for later
- Deliberately left `recycleBin.ts` (route + service) and `corruptMediaReview.ts` +
  `corruptMediaCheck.ts` unconverted — `recycleFile()` is called synchronously from 3 sites in the
  still-unconverted 947-line `media.ts` plus one in `archival.ts`; converting it now would leave those
  unawaited on Postgres. Deferred to a future round bundled with `media.ts`/`archival.ts`
- Verified live against a real Postgres container: full collection CRUD, item add/dedupe via `ON
  CONFLICT DO NOTHING`, reorder, `m3u`/`json` export (including the skip-fileless-item path), a smart
  collection's `addedAfterDays` filter, and both track routes — same sequence regression-checked
  against SQLite on the same build

## Round 85
- PostgreSQL support: converted `routes/customFormats.ts` (all 8 routes) and its backing
  `services/trashSync.ts` to the async DB interface — 26 files converted so far, ~44 remain
- The scores upsert route (`PUT /custom-formats/scores/:qualityProfileId/:customFormatId`) uses
  `ON CONFLICT ... DO UPDATE` — ported unchanged, Postgres supports the same upsert syntax
- Deliberately left `services/customFormatScoring.ts` unconverted — it's called from the actual
  search/grab pipeline (search, importer, upgrade candidates, scheduler), a much larger and riskier
  surface than custom-formats CRUD; confirmed nothing converted this round calls into it
- Verified live against a real Postgres container: created/renamed/deleted a custom format, set and
  re-read a quality-profile format score, and ran a real `trash-sync` against the live TRaSH-Guides
  GitHub repo (234 Radarr formats synced, 8 unsupported) — same sequence regression-checked against
  SQLite on the same build with identical results

## Round 84
- PostgreSQL support: converted `people.ts`, `calendarEvents.ts`, `libraryViews.ts`,
  `remoteInstances.ts`, `friendLibraries.ts` (route + service), and `libraryGroups.ts` to the async
  DB interface — 24 files converted so far, ~46 remain
- `libraryGroups.ts` carries the app's `WITH RECURSIVE` query (the nested-group item-count rollup)
  — ported with no changes beyond the standard `await` treatment, no new translation gaps found
- Verified live against a real Postgres container: custom calendar events, a saved library view, a
  remote instance, a friend library, and a two-level library group hierarchy — including confirming
  the recursive-CTE count rollup, breadcrumb resolution, and deepest-level detection all work
  correctly — with the same sequence regression-checked against SQLite on the same build

## Round 83
- PostgreSQL support: converted `indexers.ts`, `downloadClients.ts`, and `prowlarrSync.ts` to the
  async DB interface — 18 files converted so far, ~52 remain
- Extended the async DB layer to support better-sqlite3's named-parameter binding style
  (`.run({ name: "x", ... })` against SQL with `@name` tokens), used in 6 files for longer INSERTs —
  Postgres's driver only supports positional `$1, $2, ...` params, so this translates automatically
  rather than requiring every such query to be rewritten
- Found and fixed a real, pre-existing bug (surfaced by testing more thoroughly, not caused by this
  migration): `indexers.ts`'s PATCH route bound boolean fields (`enabled`, `useFlareSolverr`)
  without coercing them to 1/0 first. Both better-sqlite3 and Postgres reject a raw boolean bound to
  an INTEGER column, so `PATCH /indexers/:id` with `{"enabled": true}` would have thrown on either
  backend — nothing had tested that exact input before. Also fixed `downloadClients.ts`'s create
  route, which used `b.enabled ?? 1` (silently wrong specifically for an explicit `enabled: false`,
  since `??` doesn't treat real `false` as nullish)
- Verified live against a real Postgres container: full CRUD on indexers and download clients
  including the named-parameter inserts and the boolean edge cases on both create and patch, plus
  `prowlarr-sync` failing gracefully when unconfigured. Regression-checked the identical sequence —
  including the exact payloads that had been broken — against SQLite on the same build

## Round 82
- PostgreSQL support: converted the quality/library config slice (`tags.ts`, `rootFolders.ts`,
  `qualities.ts`, `qualityProfiles.ts`, `services/quality.ts`) to the async DB interface — 15 files
  converted so far, ~55 remain
- Found and fixed a critical gap: first-boot seeding (default qualities, the default "Any" quality
  profile, and — the one that actually matters — generating the instance API key) only ever existed
  for SQLite. **A fresh Postgres-backed install would have had no API key generated at all — nobody
  could have authenticated into it, not even to reach initial setup.** Added `db/postgresSeed.ts` to
  close this, and silenced a confusing side effect it surfaced along the way: the old SQLite-only
  seeding still runs even in postgres mode (every not-yet-converted file importing `db/client.ts`
  directly triggers it) and was printing its own "generated API key" banner for a key that lives in
  an orphaned, unused shadow database — actively misleading rather than just redundant. Suppressed
  specifically in postgres mode
- Verified live against a real Postgres container with a **completely fresh database and no
  admin-bootstrap env vars set** — the realistic case for most Postgres users — confirming exactly
  one (correct) API key gets generated and logged, qualities/quality-profile seeding works, and
  every converted route (including the quality-reorder transaction's negative-rank staging trick)
  behaves correctly, with the same sequence regression-checked against SQLite on the same build

## Round 81
- PostgreSQL support: converted `routes/users.ts` (household account management — create/list/patch
  users, per-user library permissions, session listing and force-revocation) to the async DB
  interface, the natural next slice after Round 80's auth/login path since it's the other half of
  "who can log in and what can they see." 10 files converted so far; ~60 remain
- Verified live against a real Postgres container: created a household user with library
  permissions, listed users, patched permissions (including the delete-then-reinsert pattern for
  changing allowed libraries), logged in as that user, listed active sessions, force-revoked one,
  deleted the user, and confirmed every one of those actions recorded correctly in the audit log —
  all passed, plus the same sequence regression-checked against SQLite on the same build

## Round 80
- PostgreSQL support: converted the first real vertical slice of the app — the entire auth/login/
  session path (`db/index.ts` new driver dispatcher, `settingsStore.ts`, `auth.ts`,
  `middleware/auth.ts`, `bootstrapAdmin.ts`, `authRoutes.ts`, `audit.ts`, `auditLog.ts`) — to the
  async DB interface from Round 79. **`AONARR_DATABASE_DRIVER=postgres` now boots a real, working
  app for this slice**, the first round that's been true; most of the app (~61 files) still isn't
  converted and would still misbehave under Postgres today
- Kept `getSetting`/`setSetting` and `logAuditEvent` synchronous on purpose (an in-memory cache for
  settings, fire-and-forget writes for both) specifically to avoid cascading `await` through the 24
  files/101 call sites that read settings and the ~20 that log audit events — a deliberate, scoped
  exception to "convert everything," justified by both being small, read-heavy, low-write tables
  where the old synchronous-in-effect behavior is easy to preserve without threading async through
  code that has nothing else to do with the DB
- Found and fixed two real bugs the Postgres verification pass caught that plain `tsc -b` couldn't:
  (1) a converted file calling into a not-yet-converted one (`logAuditEvent`, before this round)
  silently wrote to an orphaned shadow SQLite database instead of Postgres, crashing every login on
  a foreign-key violation — invisible until actually tested against Postgres; (2) Postgres folds
  unquoted SQL identifiers to lowercase, so `auditLog.ts`'s `user_id AS userId` alias came back as
  `userid` on Postgres while working fine on SQLite — every camelCase alias needs explicit quoting
  going forward, documented in DATABASE_MIGRATION.md as a systemic risk for the rest of the
  conversion, not just this one file
- Also fixed a latent bug this conversion surfaced in `routes/users.ts`: `res.json(listActiveSessions())`
  was passing a Promise straight to `res.json()` without awaiting it — TypeScript never flagged this
  because `res.json(x: any)` doesn't care what `x` used to be
- Verified live end-to-end against a real `postgres:16` container on the same build as the SQLite
  regression check: setup-status, admin bootstrap from env vars, login, session-validated requests,
  logout, session revocation, a rejected bad-password login, and the audit log correctly recording
  all of it — all passed on both backends

## Round 79
- Started PostgreSQL support (MariaDB deferred to a later phase per user decision — see
  DATABASE_MIGRATION.md). This round is foundation only: **the running app is unaffected and still
  only runs against SQLite** — nothing in this round is wired into any route yet
- Added `server/src/db/asyncDb.ts` — a dual-dialect async DB interface (SQLite and PostgreSQL) that
  the ~70 route/service files touching data will be converted to use, file by file, in future
  rounds. Callers keep writing plain `?` positional parameters and reading `.lastInsertRowid` off
  `.run()`'s result on both backends — the wrapper handles placeholder translation and Postgres's
  lack of a native rowid (via `RETURNING id`, applied automatically to every INSERT except the
  handful of tables that don't have a plain `id` column, which needed a static exception list after
  a first attempt discovered blindly appending it can poison an in-progress Postgres transaction)
- Added `schema.postgres.sql` (mechanical translation of the existing SQLite schema — only two real
  substitutions needed, `AUTOINCREMENT`→`SERIAL` and `datetime('now')`→an explicit UTC-text
  equivalent) and `postgresSchema.ts` (applies it plus a Postgres port of every existing
  `ensureColumn` retrofit, using Postgres's native `ADD COLUMN IF NOT EXISTS` instead of SQLite's
  introspect-then-ALTER workaround)
- Verified against a real `postgres:16` container (not mocked): full schema migration including an
  idempotent second run, insert/select/update/delete, the `ON CONFLICT ... DO UPDATE` upsert pattern
  used throughout the codebase (ported verbatim, confirmed no duplication on a repeat upsert),
  transaction commit and rollback, and the codebase's one `WITH RECURSIVE` query — all passed
- Updated DATABASE_MIGRATION.md with what actually happened vs. what was originally scoped —
  notably, ended up hand-writing a thin async wrapper instead of adopting Kysely as originally
  recommended, once the SQL-portability audit showed how much of the existing raw SQL already
  ports to Postgres unchanged

## Round 78
- No code changes — scoped the deferred "external database support" (MariaDB/PostgreSQL as an
  alternative to SQLite) request instead of implementing it, per the user's explicit choice to defer
  it until everything else in the original batch shipped. Wrote
  [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md): a concrete accounting of what it would actually
  touch (70 files, 444 `db.prepare()` call sites, a fully-synchronous DB layer with no existing
  abstraction, 48 accumulated ad-hoc SQLite migrations, several SQLite-only SQL constructs in active
  use), the options considered (a multi-dialect query builder vs. a full ORM vs. hand-writing every
  query three times vs. not doing live dual-backend support at all), a recommendation (Kysely,
  Postgres before MariaDB, phased so the abstraction layer lands and stabilizes against SQLite
  itself before a second engine is introduced), and the decision the user still needs to make before
  work starts (commit to the size of this, and whether Postgres-only is an acceptable scope cut).
  Linked from README.md's Architecture section

## Round 77
- Rebuilt the Calendar page as a real month grid — the same view Sonarr/Radarr/Lidarr/Readarr each
  show by default — with Prev/Next/Today navigation, a day cell per date showing up to 3 entries
  plus a "+N more," and a click-through detail panel for the selected day. The previous scrolling
  day-by-day list is still there as an "Agenda" mode (useful for a quick scan of what's coming),
  just no longer the only option
- Closed a real gap in what the calendar could show: it only ever pulled from episode air dates and
  album/book release dates, so movies never appeared on it at all — there was nowhere in the
  schema to even put a movie's release date. Added a `release_date` column to media_items (populated
  from TMDB's own release date on search-select, rematch, and Refresh, the same three moments
  title/overview/poster already get filled in) and wired it into the calendar query — this is the
  same per-type date source each real Starr app's own calendar uses: Sonarr → episode air date,
  Radarr → movie release date, Lidarr/Readarr → album/book release date
- Added custom calendar dates — "+ Add custom date" on the Calendar page lets an admin mark any day
  with a title and optional note (a watch party, a reminder, anything), shown alongside the regular
  entries with a 📌 marker and removable from the day's detail panel. Included in the .ics
  subscription feed too, not just the in-app view
- Verified live: seeded a movie/episode/album all dated today plus a custom event, confirmed all
  four appear correctly in the month grid's today cell (including the "+1 more" overflow), confirmed
  clicking the day opens the detail panel, confirmed removing the custom event actually removes it,
  confirmed Agenda mode still works, and confirmed the movie shows up in the .ics feed

## Round 76
- Added saved, reusable library views — a "Views" dropdown plus "Save view..."/"Delete view" on
  every library page lets you name and reuse a specific combination of sort, status filter, tag
  filter, content-rating filter, poster/list mode, poster size, and visible columns (e.g. "4K
  Missing"), instead of only ever remembering your last-used state (the existing per-browser
  localStorage behavior from Round 64, which this doesn't replace — applying a saved view still
  updates that same local "last used" state). Saved instance-wide, the same sharing model as
  quality profiles and custom formats, rather than locked to one browser; saving/deleting is
  admin-only, viewing/applying isn't
- Added an "Unmatched" status filter to every library page — items with no external provider ids at
  all (almost always a Scan & Import guess or a manual add that's never been searched/refreshed),
  so a library can be filtered down to exactly the items still waiting on a real metadata match
  instead of hunting for them by eye
- Verified live: created a matched and an unmatched movie, confirmed the Unmatched filter shows
  only the right one; created a saved view via the API, confirmed selecting it in the browser
  correctly switched every one of its settings (including actually flipping poster view to list
  view), confirmed "Save view..." and "Delete view" both work end-to-end in the browser

## Round 75
- Added an option to review corrupted media before it's recycled (Settings → Recycle Bin →
  "Corrupt media") — previously the corrupt-media check (ffprobe validation, weekly by default)
  always recycled and marked-missing anything it flagged, fully automatically. With review turned
  on, a flagged file is instead held in a new "Pending Corrupt Media Review" queue at the top of
  the Recycle Bin page — the item keeps showing as present in the library, the file stays exactly
  where it was, until an admin either confirms it (Recycle — runs the exact same recycle-and-
  mark-missing logic the automatic path always used) or dismisses it (false positive — a network
  hiccup, a file that was still being written when checked; leaves everything untouched). Off by
  default, so upgrading changes nothing for anyone who hasn't turned it on
- Verified live: a genuinely unreadable file correctly landed in the review queue (not recycled)
  with the item still showing has_file, confirming Recycle from the queue correctly recycles and
  marks it missing, confirming Dismiss correctly leaves the file and item alone, and confirming both
  actions render correctly and log to the Audit Log

## Round 74
- Fixed Recycle Bin restore freezing the whole app for however long a large file took to move.
  Restoring used `fs.copyFileSync` (needed when the recycle bin and the original location are on
  different Docker volumes — a plain rename fails with EXDEV there) synchronously on the request
  thread, which blocks Node's single event loop for the entire copy — not just that one request,
  every request the server was handling. Restore is now fire-and-forget like every other slow job
  in this app, using real async file I/O (`fs.promises`) so the event loop stays free while a big
  file moves. New `restoring`/`restoreError` columns track progress so the Recycle Bin page can
  show "Restoring..." on the affected row (disabling that row's buttons) and poll until it either
  disappears (done) or shows a retryable error, instead of the button just doing nothing for a long
  stretch. Purging an entry that's mid-restore is now rejected with a clear error instead of racing
  the in-flight move
- Fixed a real title-accuracy bug: the "Refresh" button (and the scheduled Library Refresh job)
  re-pulled overview/poster/year from each item's metadata provider but deliberately never touched
  `title` — meaning an item Scan & Import created from a guessed filename (its whole point being "no
  rich metadata yet") kept that guessed title forever, even after Refresh had already found and
  applied the correct overview/poster/year from the real match. Refresh now also corrects title/
  external ids, but only for items with no external ids yet — i.e. items that were never actually
  matched to real metadata in the first place. An item that's already matched (has external ids)
  keeps its title exactly as-is, since a fuzzy title-only search could occasionally land on the
  wrong result and this shouldn't silently rename something already correct
- Verified both live: the title fix was confirmed with a real (unmocked) AniList lookup — a
  guessed-title unmatched item got corrected to AniList's real title/casing/overview/external id,
  while a deliberately custom-titled already-matched item was correctly left untouched by the same
  Refresh run

## Round 73
- Add Media's "Import from a course page URL" (Round 70) now auto-selects the Courses library's
  "Site" group from the scraped URL's hostname (coursera.org/udemy.com/edx.org → Coursera/Udemy/
  edX) instead of leaving the group picker on "Select Site..." — finds the existing group by name
  if one's already there, creates it on first use otherwise, so scraping several courses from the
  same platform doesn't mean re-picking (or worse, duplicating) the same Site every time
- Widened `pathTail`'s cross-mount-point file-matching heuristic (used throughout media-server
  sync/import and Starr-app import) from the last two path segments to the last three. Two segments
  alone can collide across two *different* shows when episodes are generically named ("Season 01/
  S01E01.mkv" under a season folder with no show name in the filename) — this is exactly what
  produced a false-positive collision in a Round 67 test fixture, previously written off as an
  accepted tradeoff. The third segment reaches up to the item's own folder name (the show, or a
  movie's release folder), which is what actually disambiguates one item from another; a
  mount-point prefix difference never touches these trailing segments, so this is strictly more
  specific than before with no loss of legitimate matches — confirmed with a standalone test script
  covering the exact Round 67 collision (no longer collides), ordinary cross-mount-point movie and
  season-folder episode matches (still match), two different movies sharing everything but their
  own folder name (still don't match), and a shallow 2-segment path with no season folder (unchanged
  behavior, since `slice(-3)` degrades gracefully on shorter paths)
- Verified live: fetching two different Coursera course URLs correctly reused the same "Coursera"
  group (confirmed via the API — no duplicate created) and the group picker's Site dropdown showed
  it pre-selected in the browser both times

## Round 72
- Extended the Audit Log to cover 9 more event types beyond its existing login/request/user/media
  coverage: user permission changes (auto-approve, allowed libraries, max pending requests, max
  content rating — one combined `user_permissions_changed` entry summarizing whatever actually
  changed), force-logging-out a session, enabling/disabling two-factor auth, regenerating the API
  key, downloading a database backup, and adding/removing an indexer or download client. These are
  the security- and administratively-significant actions that weren't attributed to anyone before —
  Audit Log's own scope (who changed account/security/config state) is deliberately kept distinct
  from the existing History page (which already covers grabs/imports/upgrades), so this doesn't
  duplicate that
- Database restore is deliberately NOT logged to the audit table: a restore replaces the entire DB
  file, audit_log included, so an entry written just before the swap wouldn't exist in whatever
  database anyone actually looks at afterward — logged to the server log instead, which is a
  separate, durable store the restore doesn't touch
- Centralized the `auditActor` helper (session user, or "admin" for a bare-API-key request) into
  `services/audit.ts` — it previously lived only in media.ts's own file; now every route file adding
  audit coverage shares one definition instead of copy-pasting it
- Pagination and add/delete/rematch media coverage were already in place from an earlier round of
  this project; this round's news is entirely the additional event types above
- Verified live: exercised all 9 new actions end-to-end (real TOTP setup/verify/disable with a
  correctly-computed code, not a stub) against a running instance, confirmed each produced exactly
  the expected audit_log row with an accurate detail string, and confirmed the Audit Log page
  renders each with its new human-readable label

## Round 71
- Added "Import from Lidarr"/"Import from Readarr" (Music/Books library pages) — extends Round 68's
  Radarr/Sonarr import to the two remaining Starr apps, migrating an already-organized Lidarr artist
  library or Readarr author library into AoNarr. Same one-time-use model as Radarr/Sonarr: URL and
  API key are supplied once in the import dialog and never saved
- Structurally different from movies/series: artists/authors are "collection" shape (an open-ended
  list of albums/books, not a fixed season/episode grid), so this is new matching logic rather than
  a third reuse of Round 68's episodic core — parent matched by external id (MusicBrainz artist id
  for Lidarr; Readarr's Goodreads author id is recorded too, though no existing AoNarr provider key
  overlaps with it yet) then title, child (album/book) matched by path tail then title. An album's
  file_path is its folder (matching how Scan & Import already treats multi-file-per-child music, not
  a specific track), a book's is its one file. Lidarr's own API doesn't return an album's folder
  path, only its track files — derived from the first track file's own directory instead
- Verified live against real mock Lidarr and Readarr servers, mirroring Round 68's three-case matrix
  one level deeper: a pre-existing artist/author matched via external id (artist) or title fallback
  (author, deliberately seeded with no matching id to test that path) with one album/book already
  tracked correctly left untouched and a second created fresh, plus an entirely new artist/author
  created along with its one album/book — confirmed exact counts via the log summary, confirmed the
  resulting database rows including the Readarr author's newly-captured Goodreads id, and confirmed
  "Import from Lidarr"/"Import from Readarr" render correctly on the Music/Books library pages

## Round 70
- Added "Import from a course page URL" (Add Media → Courses) — pulls title/description/thumbnail
  from a Coursera/edX/Udemy (or any) course landing page to prefill the manual Add Media form, the
  last of the deferred items from the original request list. Courses has no metadata-provider API
  (there's no viable public search API for arbitrary course platforms — see mediaTypes.ts), so this
  was previously typing everything in by hand
- Deliberately scoped to Open Graph tags (`og:title`/`og:description`/`og:image`) rather than each
  platform's own internal curriculum/lesson data. During development, Coursera's server-rendered
  HTML did contain a syllabus (an Apollo GraphQL normalized cache blob with week/lecture names),
  but Udemy's didn't expose any curriculum data in its raw HTML at all — its lesson list loads via
  a separate, undocumented internal API call. Building on either would mean silently working for
  one platform and not another, and breaking without warning on the next front-end redesign of
  whichever platform it did work on. Open Graph tags, by contrast, are meant to be publicly scraped
  (that's their purpose — link-preview cards) and were present and stable on all three real pages
  tested. The lesson-by-lesson breakdown still has to be added by hand after creating the entry,
  same as before this round
- Verified live against real Coursera, edX, and Udemy course pages (not mocks) — confirmed correct
  title/overview/poster extraction for each, confirmed edX's " | edX" title suffix and HTML entities
  (`&#x27;` → `'`) are handled, confirmed a friendly error for both an invalid URL and an unreachable
  domain rather than a raw fetch exception, and confirmed the new "Import from a course page URL"
  section on Add Media (Courses only) actually populates the Title/Overview fields end-to-end in
  the browser

## Round 69
- Added "Sync from TRaSH-Guides" (Settings → Quality → Custom Formats) — pulls every custom format
  TRaSH-Guides publishes for Radarr or Sonarr straight from their public GitHub repo and syncs it
  into AoNarr's own custom-format table, closing the "syncing (not just importing)" gap left by the
  existing paste-JSON import: re-running the sync updates formats already pulled in (matched by
  TRaSH's own stable `trash_id`, stored in a new `custom_formats.trash_id` column) rather than
  duplicating them, so it stays current as TRaSH's guides evolve instead of being a one-time copy
- Extracted the specification-to-condition-group translation (title/release-group/size, now also
  resolution — TRaSH's `ResolutionSpecification` uses a plain pixel-height value, not a Radarr/
  Sonarr-internal id, so it's safe to map) into a shared `trashFormats.ts` used by both the sync and
  the existing paste-JSON import, so the two paths can't drift on what counts as translatable.
  Anything else (quality-modifier, language, indexer-flag, source specs — all keyed to Radarr/
  Sonarr's own internal enums) is still reported back as unsupported rather than silently dropped
- Newly-synced formats are scoped to the syncing app's own library types (Radarr → Movies, Sonarr →
  Series/Anime) rather than left unrestricted, since a resolution/size-tier format has no reason to
  also apply to unrelated libraries; a user can broaden the scope afterward like any other format.
  Fire-and-forget, same reasoning as the media-server/Starr-app imports (Rounds 66-68) — fetching
  200+ format files from GitHub can outrun an HTTP/gateway timeout
- Verified live against the real TRaSH-Guides repo (not a mock): synced Sonarr's 236 published
  formats (226 translated and added, 10 correctly reported unsupported), confirmed individual
  translations in the database (e.g. `1080p` → a resolution condition, `x265` → its title-regex
  condition with the internal quality-modifier spec correctly skipped), re-ran the same sync and
  confirmed it reported "added 0, updated 226" with the total format count unchanged (no
  duplication), and confirmed the paste-JSON import still works unchanged (regression check on the
  now-shared translation code) and the new Sync buttons render correctly in Settings

## Round 68
- Added "Import from Radarr"/"Import from Sonarr" (Movies/Series/Anime library pages) — migrates an
  already-organized Radarr or Sonarr library straight into AoNarr, closing the last of the three
  deferred migration paths flagged back in Round 65 (media server was Rounds 66-67; this is "import
  from other Starr programs"). Unlike the media server connection, this isn't a standing setting:
  the Radarr/Sonarr URL and API key are supplied once in the import dialog and used only for that
  one request, never saved, since there's no ongoing reason for AoNarr to keep talking to a
  Radarr/Sonarr instance once its library has been pulled in
- Reuses the exact match-or-create logic already shipped and verified for Plex/Jellyfin/Emby import
  (Rounds 66-67) — refactored `importMoviesFromMediaServer`/`importSeriesFromMediaServer` into
  fetch-then-import pairs so both the media-server path and the new Radarr/Sonarr path share one
  `importMovieItems`/`importSeriesData` core, rather than duplicating the matching precedence (path,
  then external id, then title/year(/season/episode)) a second time
- Sonarr's v3 API has no bulk "every episode" endpoint — episodes and episode-files are fetched
  per-series (N+1 requests), which is fine for a one-time migration but wouldn't be for a repeated
  sync; noted in code rather than treated as something to optimize away in a job that only runs once
  per library
- Verified live against real mock Radarr and Sonarr servers: for movies, three cases (already
  tracked and correctly skipped, tracked under a wrong guessed title with no file and correctly
  matched via its tmdb id, never seen and correctly created) plus a fourth case confirming a movie
  with no file yet in Radarr is correctly excluded entirely rather than imported as empty; for
  series, the same three-case matrix one level deeper (show matched via tvdb id with one episode
  already tracked left untouched and its sibling episode created fresh, a second show created along
  with both its episodes) — confirmed exact match/create counts via the log summary, confirmed the
  resulting rows in the database, and confirmed the "Import from Radarr"/"Import from Sonarr"
  buttons and modals render with the correct app name and copy on both library types

## Round 67
- Extended "Import from Media Server" (Round 66, movies-only) to TV Shows and Anime libraries —
  the deferred "larger job" from last round: matching/creating individual episodes under the right
  parent show, not just a flat list of files. Fetches every show and every episode from the
  configured Plex/Jellyfin/Emby server in two bulk passes (all shows, then all episodes), joins
  episodes to their parent show in memory via Plex's `grandparentRatingKey` or Jellyfin/Emby's
  `SeriesId`, then for each show matches or creates the AoNarr media_item (by external id, then
  title+year — same precedence as the movie importer) and for each of its episodes matches or
  creates the episode row by season+episode number, filling in has_file/file_path/title/overview
  from the media server's own data. A show's own has_file flag is set once any of its episodes has
  a file, matching how every other import path already treats episodic items
- "Import from Media Server" button and modal (built in Round 66) now also appear on the Series and
  Anime library pages, with type-aware copy describing the show/episode matching precedence
- Verified live end-to-end against a real mock Plex TV server with three cases: a show and episode
  AoNarr already had tracked (correctly skipped, left untouched), a show AoNarr knew under the
  wrong guessed title with one episode already tracked (correctly matched via tmdb id rather than
  duplicated, existing episode left alone, its other episodes created fresh with real Plex
  metadata), and a show AoNarr had never seen at all (correctly created along with all its
  episodes) — confirmed exact expected counts via the structured log summary, confirmed the
  resulting media_items/episodes rows in the database, and confirmed the button/modal render
  correctly on the Series library page in the browser. (First test pass used file paths that
  happened to share a last-two-path-segment across two different shows — e.g. both named
  `Season 01/S01E01.mkv` — which the existing pathTail cross-mount-point matching heuristic
  treated as identical files; this is a known, pre-existing tradeoff already relied on everywhere
  else in the codebase, not a bug, and the fixture was corrected to use distinct filenames.)

## Round 66
- Added "Import from Media Server" (Movies library page, when a media server is configured) —
  pulls an already-organized Plex/Jellyfin/Emby movie library straight into AoNarr with its real
  title/year/overview/poster/external ids, instead of requiring Scan & Import (filename-guessing
  only, no rich metadata) or adding everything one-by-one through Add Media. Matches against
  anything already in AoNarr first — by path, then external id (tmdb/imdb/tvdb), then title+year —
  before falling back to creating a new entry, so a library that's partially already tracked
  doesn't get duplicated
- Required actually extracting the metadata Plex/Jellyfin's APIs already return but the existing
  polling code discarded (it only ever kept path+id, enough for watch-state matching but nothing
  else): Plex's `Guid` array (current agents) and legacy `guid` string (older agents still seen on
  long-running servers that haven't re-matched) for external ids, `summary`/`thumb` for overview/
  poster; Jellyfin/Emby's `ProviderIds`/`Overview`/`ImageTags`. TV shows aren't included this round
  — matching/creating individual episodes under the right parent show is a larger job on its own
- Fire-and-forget the same way Scan & Import already is, for the same reason (fetching and
  matching an entire library can easily outrun an HTTP/gateway timeout)
- Verified live against a real mock Plex server with three deliberately distinct cases in one
  library: a movie already tracked by AoNarr (correctly skipped, left untouched), a movie only
  known to AoNarr under a wrong guessed title with no file (correctly matched via its tmdb id
  rather than duplicated, and filled in with Plex's real overview/path/poster), and a movie AoNarr
  had never seen at all (correctly created fresh with full metadata) — confirmed all three outcomes
  in the actual database afterward, confirmed the poster URL was built correctly with the Plex
  token, and confirmed the "Import from Media Server" button and its root-folder-picker modal
  render correctly in the browser

## Round 65
- Added Plex/Jellyfin/Emby as a notification target (Sonarr/Radarr's "Connect" feature) — a real,
  total gap before this: AoNarr already had polling-based watch-state sync and an incoming webhook
  for Plex/Jellyfin/Emby, but never told the media server about a newly-imported file, so it sat
  invisible until the media server's own scan interval got to it. New opt-in setting ("Refresh
  media server library after each import", off by default so upgrading changes nothing for anyone
  who only has a media server configured for watch-sync). Plex gets a targeted refresh scoped to
  just the new file's folder (`PUT /library/sections/{key}/refresh?path=...`, fired against every
  movie/show section since there's no cheap way to know in advance which one a given path belongs
  to — Plex just no-ops for the wrong ones); Jellyfin/Emby have no equivalent lightweight per-path
  endpoint, so they get a full `POST /Library/Refresh` instead — heavier, but still faster than
  waiting for their own scan interval. Never blocks or fails the import itself — best-effort,
  logged on failure rather than thrown
- Verified live against real mock Plex and Jellyfin servers (not just reading the code): ran a real
  manual import with the setting on, confirmed Plex received the exact expected `GET
  /library/sections` enumeration followed by two `PUT .../refresh?path=<url-encoded-path>` calls
  (one per movie/show section) with the correct destination path; confirmed Jellyfin received a
  `POST /Library/Refresh` with the correct `X-Emby-Token` auth header; confirmed a second import
  with the setting off produced zero additional requests, proving the opt-in gate actually gates

## Round 64
- Added three new sort options (Monitored, Quality, Content rating) and a Content Rating filter
  (dynamically populated from whatever ratings are actually present in the library, same pattern
  the existing Tags filter already uses) to every library's toolbar
- Added column customization to the list view and info-line customization to the poster view —
  previously both were hardcoded (list: Title/Year/Status/Monitored always, no way to add or
  remove any; poster: Year/Status/Monitored always, same). New "Columns" (list view) / "Poster
  info" (poster view) dropdown with a checkbox per available field (Year, Status, Monitored,
  Quality, Content rating, Added date) — pick whichever combination is actually useful for that
  library type. Persists per-browser via localStorage, same as the sort/status/view choices
  Round 59 already made sticky
- Verified live end-to-end: sorted by Quality and confirmed correct alphabetical ordering
  (Bluray-1080p before Remux-2160p); filtered by a specific content rating and confirmed only the
  matching item showed; toggled Quality on in the poster-info picker and confirmed it appeared in
  the poster sub-line without the dropdown closing on each checkbox click; reloaded the page and
  confirmed the poster-field choice persisted; switched to list view and added Quality + Content
  rating columns, confirmed both rendered with correct per-item data

## Round 63
- Added four new custom format condition types, closing most of the gap versus real Sonarr/
  Radarr's condition set: **Source** (Remux/Bluray/WEBDL/WEBRip/HDTV/DVD), **Resolution**
  (2160p/1080p/720p — split out from the combined `quality` string as their own conditions),
  **Year** (min/max range), and **Release Flags** (proper/repack/extended/unrated/directorscut/
  imax — newly parsed from the release title; nothing detected these before). Previously only
  Title/Size/Language/ReleaseGroup existed. New syntax lines in the Custom Formats textarea:
  `SOURCE:`, `RESOLUTION:`, `YEAR:`, `FLAGS:`, alongside the existing `SIZE:`/`LANG:`/`GROUP:`
- Added per-library scoping to custom formats — "Giving the option to set custom format by
  library" was a real, total gap: a custom format applied to every media type indiscriminately
  with no way to restrict it. New `mediaTypes` field (empty = every library, the previous
  behavior, so nothing existing changes); a multi-select per format in the table, and checkboxes
  on the add form. `scoreRelease()` now takes the searching item's type and skips any format
  that's restricted to other types — threaded through all 6 call sites (search route + 5 inside
  the scheduler's auto-search/retry paths)
- Added "Preferred size" to Quality Definitions — previously min/max size only *rejected*
  releases outside a range; there was no way to express "closer to this size wins" between two
  releases that are otherwise tied. Now a genuine tiebreaker: after format score, seeders, and
  release-group reputation, whichever candidate's size is closest to its quality's configured
  preferred size wins. No preferred size configured (the default) is a neutral tie, same as before
- Verified live end-to-end: created a `movie`-scoped "Remux Boost" format and confirmed it scores
  for a movie search but correctly scores 0 for a series search with the identical release title;
  created unrestricted Resolution/Year/ReleaseFlags formats and confirmed correct AND/OR/negate
  behavior across realistic release titles (a clean 2024 4K release matched all three; the same
  release with a PROPER tag correctly lost only the negated "avoid proper/repack" format; an old
  1080p release matched only that one); set a preferred size and confirmed the distance
  calculation correctly favors the closer release; confirmed the per-format media-type multi-select
  round-trips through a real PATCH request in the browser

## Round 62
- Added a per-library enable/disable toggle for naming (Settings → Media → Naming) — previously
  every import always renamed a file via its type's template unconditionally, with no way to keep
  files as originally downloaded. When disabled for a type, the template's folder structure still
  applies (so files stay organized and episodes stay grouped by season — the whole reason renaming
  exists in the first place isn't just cosmetic), only the filename itself is left as-downloaded
  instead of templated. Applies to every shape: single (Movies/ROMs/Adult), episodic (TV/Anime),
  and collection (Books/Comics/etc, and Music's album *folder* specifically — track filenames were
  already always kept as-downloaded there)
- Replaced the naming section's flat list of plain text inputs with a proper "Naming setup..."
  popup per library type: the enable/disable toggle, a template field, buttons that insert the
  tokens actually available for that type's shape at the cursor position, a live preview rendered
  with example values, and a one-click reset to the shape's default — instead of a wall of
  unlabeled tokens in a paragraph above a dozen bare `<input>`s
- Verified live end-to-end: toggled naming off for Movies via the new popup, confirmed the setting
  persisted (`namingEnabledMovie: 0`), then ran a real manual import of a file named
  `My.Weird.Release.Name.2020.1080p.WEB-DL.mkv` — confirmed it landed at
  `Test Naming Disabled Movie (2020)/My.Weird.Release.Name.2020.1080p.WEB-DL.mkv` (templated
  folder, original filename kept exactly). Verified the reverse case too: ROMs (left at its
  untouched default) still fully templates both folder and filename as before

## Round 61
- Added a manual-match fallback for titles Watchlist Import and Import Lists' recurring sync
  couldn't confidently match — previously a "no metadata result found" title (both flows take the
  provider's own top result with no confidence threshold) was silently discarded with no record
  anywhere, a dead end with no way to ever recover it. New Import Review page (nav: Manage → Import
  Review) queues every unmatched title instead, with a "Match..." action reusing the same
  interactive-search flow Add Media already has, and a "Dismiss" action for ones you don't want —
  dismissed titles are deduped against on future syncs so they don't get silently re-queued forever.
  Watchlist Import's results table now links to Import Review when it has unmatched rows; the
  Import Lists page shows a per-list "N need review" badge. New `import_review_items` table;
  Trakt and Last.fm import-list syncs don't do provider-search matching at all (Trakt trusts its
  own tmdb id, Last.fm adds every returned artist), so only Watchlist Import and Import Lists'
  IMDb sync — the two paths that actually have a "no match" branch — feed this queue
- Added a "Browse..." folder picker to the Scheduled Backups directory setting (System → Backups)
  — it was a plain text input with no way to browse the container's filesystem, unlike every other
  path field in the app. Turned out a full directory browser + "New folder" endpoint
  (`/api/system/browse-directory`) and a reusable `FolderPicker` component already existed (used
  for root folders) — this just wires the same component into the one remaining path field that
  didn't have it yet, no new backend needed
- Verified live end-to-end: browsed into a real container directory, created a subfolder, selected
  it, confirmed the setting saved correctly; ran a fake title through Watchlist Import, confirmed
  it appeared in Import Review, resolved it (created the media item, cleared the queue entry), ran
  a second fake title through, dismissed it, and confirmed re-running the same import doesn't
  re-queue the dismissed title

## Round 60
- Added a read-only Media Analyzer (System → Media Analyzer) covering every library — a
  library-wide breakdown (video codec, HDR format, audio codec, resolution, subtitle language
  coverage) plus a per-file table with rule-based playback-compatibility notes for common
  hardware/software gotchas (an AV1 file that needs a fairly recent device to decode, single-layer
  Dolby Vision with no HDR10 fallback, DTS/TrueHD needing an AVR with passthrough, image-based PGS/
  VobSub subtitles that can't be resized or styled, 10-bit color needing Main10 decode support,
  etc.). Nothing here moves, renames, or modifies any media file — ffprobe only ever reads
- Widened what `ffprobe.ts` actually captures to make the analyzer possible: HDR signaling
  (color transfer/primaries/space, bit depth), Dolby Vision detection (reading the DOVI
  configuration record ffprobe surfaces in a stream's side_data_list, with a codec-tag fallback
  for older ffmpeg builds), frame rate, and — a real gap in the old capture — every audio and
  subtitle track instead of just the first of each (a file with a commentary track or 5 dub
  languages only ever showed its first audio stream before this)
- Files imported before this shipped only have the old narrower MediaInfo shape and show as "not
  yet analyzed" until re-probed — added an "Analyze now" action (per-library or everything) that
  re-probes with the new capture and updates the stored data, fire-and-forget the same way Scan &
  Import already is for large libraries
- Verified live end-to-end: generated a real HDR10-tagged HEVC file with ffmpeg (genuine
  `smpte2084`/`bt2020` color metadata, not mocked) and confirmed the analyzer correctly detected
  "HDR10" with accurate compatibility notes; generated a real AV1+FLAC file and confirmed both
  correctly triggered "caution" notes; verified the caution/incompatible filter dropdown narrows
  the table correctly. Dolby Vision's signaling couldn't be reproduced with a genuine encode (it
  needs source RPU metadata a synthetic test clip doesn't have) — verified the detection logic
  instead against 7 cases of realistic mock ffprobe output modeled on documented DV signaling
  conventions (profile 5, profile 8.1 dual-layer, HDR10+, HLG, plain HDR10, plain SDR, and a file
  with no color tags at all), all passing

## Round 59
- Fixed "API Definition fetch error unauthorized" on the API Docs page: Swagger UI's request
  interceptor only ever attached `X-Api-Key`, never `X-Session-Token` — any admin logged in via a
  normal session (not the raw admin API key) sent a fully anonymous request to `/api/openapi.json`
  and got 401'd. Now sends whichever credential the current login actually populated
- Fixed clicking any link/media row landing scrolled partway down the new page instead of at the
  top — a plain `<BrowserRouter>` never resets scroll position on navigation on its own; added a
  small `ScrollToTop` component that does
- Fixed the ffprobe "Invalid data found when processing input" / "EBML header" corrupt-file
  detection being trigger-happy: a single ffprobe failure for *any* reason (a genuinely corrupt
  file, but equally a file still mid-write, a network/SMB mount hiccup, or a brief lock) was
  unconditionally treated as "corrupt, recycle it" with zero retry. Now checks whether the file's
  size is still changing (a dead giveaway it's still being written) before trusting a failure, and
  gives ffprobe one retry a few seconds later before concluding anything is actually broken.
  Verified against both a real corrupt file (garbage bytes saved as `.mkv`, reproducing the exact
  "EBML header parsing failed" error from the bug report — still correctly caught after the retry)
  and a file actively growing mid-write (correctly spared, not flagged corrupt)
- Implemented Scan & Import for "collection"-shape libraries (Music, Books, Audiobooks, Comics,
  Manga, Online Videos, Courses) — previously an intentional stub that always returned "isn't
  supported yet." Follows the same folder-convention approach Sonarr/etc. use: the file's immediate
  parent folder becomes the parent item (Artist/Author/Creator, matched or created), and the child
  (Album/Book/Issue) is either the next folder down for `multiFilePerChild` types like Music (a
  whole album folder becomes one child, matching how normal album grabs already work) or the file's
  own name for everything else. Verified live: scanned a real `Radiohead/OK Computer/*.mp3`
  structure, confirmed "Radiohead" was auto-created and "OK Computer" correctly registered as its
  album; re-ran the scan and confirmed already-known albums are correctly skipped, not re-processed
- Added pagination to the Audit Log (previously a flat unpaginated list capped at 500 rows total,
  no way to see anything older) — `page`/`pageSize` query params server-side, Previous/Next controls
  in the UI, and the effective total no longer capped at all (just paginated)
- Added audit logging for adding, deleting, and rematching media — previously the audit log only
  covered logins/requests/account changes, not the actual library-changing actions most worth
  reviewing later. Verified live: added, rematched, and deleted a test item, confirmed all three
  showed up correctly with the right before/after detail
- Moved the poster-size dropdown into the same toolbar row as Sort/Status/Tags (previously in a
  separate row with View), and made Sort and Status selections persist across visits the same way
  View and poster size already did (all four now save to localStorage) — verified live: changed
  Sort to "Title" and Status to "Missing" on Movies, navigated to a completely different library,
  confirmed both choices carried over
- Added a "Select" toggle to every library's toolbar (previously the bulk-selection checkboxes were
  always visible for every admin, cluttering the view when you're not trying to bulk-act on
  anything) plus "Select all"/"Select none" buttons that appear once selection mode is on. Verified
  live: toggled Select on, confirmed checkboxes appear, confirmed Select all correctly selects every
  currently-visible item

**Scoped for later rounds** — the rest of this request is several genuinely separate large features,
each comparable in scope to a full subsystem (a read-only media analyzer with HDR/Dolby
Vision/hardware-compatibility detection; per-library naming setup UI; fully custom/filterable
sorting across every metadata field; list/poster view column customization; a real per-library
custom-formats + quality-definitions system like Sonarr/Radarr's; Plex/Jellyfin/Emby as
notification *and* library-import targets; importing config/libraries from other Starr apps;
Coursera/edX/Udemy course-page scraping; TRaSH-Guides format *sync* rather than one-time import;
manual-match fallback UI for Watchlist Import and Import Lists; a file-path browser for the backup
directory setting; "search all missing" bulk actions). Tackling these next, starting with whichever
you'd like prioritized first.

## Round 58
- Continued the audit series onto the security-critical files: `auth.ts`, `totp.ts`,
  `rateLimiter.ts`, `middleware/auth.ts`, and `releaseParser.ts` (release-title matching, used
  everywhere search results get matched against wanted episodes). Password hashing, session token
  generation, session expiry enforcement, and rate-limit logic all checked out clean — no fail-open
  paths, no weak entropy sources
- Fixed two non-constant-time credential comparisons: the TOTP code check (`totp.ts`) and the
  instance-wide admin API key check (`middleware/auth.ts`) both used plain `===`/`string` equality
  instead of `crypto.timingSafeEqual`, theoretically leaking per-character timing info about the
  correct value. Practical exploitability was already low given the existing rate limiter's
  10-attempts/15-minute cap, but fixed anyway since it's the credential guarding the highest-privilege
  surface in the app. Applied the same fix to the calendar-feed and media-server-webhook tokens for
  consistency, via a shared `safeEqual()` helper. Verified live: session-token auth, correct and
  wrong API keys (including a same-length wrong guess to actually exercise the constant-time compare
  path rather than the length-mismatch shortcut), and a full TOTP enroll-with-a-real-computed-code
  flow all behave identically to before the fix
- Reviewed TOTP replay protection (a code can be reused within its ~90s validity window) and decided
  not to implement it this round — doing so properly requires threading per-user identity through
  five call sites plus a schema change, for a narrow attack window that requires an attacker to
  already be intercepting the victim's traffic in real time, at which point TOTP replay is a minor
  concern next to that
- Fixed two real gaps in `releaseParser.ts`'s season/episode extraction found by the audit: the
  `1x01` scene/P2P notation (an extremely common convention, already supported by the filename-based
  scan-import detector but missing entirely from the search-result matcher) had no pattern at all, so
  a release using it could never match a wanted episode and would silently never get grabbed. Added
  it as a fallback behind the unambiguous `SxxExx` pattern. Also fixed hyphen-less chained
  multi-episode packs (`S01E01E02E03`, distinct from the already-supported `S01E01-E03`/`S01E01-03`
  hyphenated form) being parsed as only the first episode. Verified against a 10-case battery
  covering both fixes plus regression checks confirming `x264`/`x265`/`4K` codec and resolution tags
  don't false-match as `1x01`-style season/episode markers

## Round 57
- Continued the audit series onto `scheduler.ts`, `duplicateCheck.ts`, `customFormatScoring.ts`,
  `notifications.ts`, and the Plex/Jellyfin/Emby webhook handler. Found and fixed a real bug: Plex's
  webhook payload does not carry a file path anywhere in its `Metadata` object (confirmed against
  Plex's real wire format, not just assumed — its webhook `Metadata` is a much lighter subset of
  its API's response shape, with no `Media`/`Part`/`file` fields at all, only `ratingKey`/`title`/
  `GUID`/etc.), so `parsePlexPayload` reading `Metadata.Media[0].Part[0].file` always got
  `undefined` and silently returned null for every real Plex webhook — meaning Plex's watch-state
  webhook (the "instant update" path the Dashboard's Recently Watched widget and auto-archival's
  webhook signal both rely on) has never actually fired for any Plex user, full stop, with nothing
  logged to indicate why. Jellyfin/Emby were unaffected — their webhook plugins do send a `Path`
  field directly
- Fixed by resolving the webhook's `ratingKey` through a follow-up call to Plex's own
  `/library/metadata/{ratingKey}` API (new exported `resolvePlexFilePath()` in `mediaServer.ts`,
  reusing the server URL/token config the polling-based watch sync already has), the same way a
  real Plex API client would — `parsePlexPayload` is now async to accommodate the extra round-trip
- Verified live end-to-end with a mock Plex server: configured AoNarr to point at it, sent a real
  multipart `media.scrobble` webhook body with a `ratingKey`, confirmed the mock's file path
  resolved correctly and the matching library item flipped to `watched: true` — something that
  could never have happened with the pre-fix code no matter how correct the rest of the pipeline
  was. Also confirmed the failure path stays graceful when Plex is unreachable: the existing
  route-level try/catch already covers the new async call, responds 200 (so Plex doesn't
  retry-storm), and logs a visible warning instead of crashing
- `scheduler.ts`, `duplicateCheck.ts`, `customFormatScoring.ts`, `notifications.ts`, and the
  Jellyfin/Emby half of the webhook handler all checked out clean — no other bugs found

## Round 56
- Continued the audit series onto `importer.ts`, `naming.ts`, and `mediaServer.ts`. Found and fixed
  one real bug: `{absoluteEpisode}` (the anime-style running episode count naming templates can use
  instead of `{season}`/`{episode}`) was counting season 0 specials into the total, so any show with
  specials had every real episode's absolute number inflated by however many specials sorted before
  it. Real absolute-numbering conventions (AniDB, TVDB's absolute order, most anime release groups)
  start counting from season 1 episode 1 and exclude specials entirely — fixed both `placeFile()`
  and `placeSeasonPackFiles()`'s identical count query to do the same. Verified against a simulated
  12-episode-per-season show with 2 specials: S1E1/S2E1/S2E12 now correctly compute as 1/13/24
  instead of 3/15/26
- Reviewed two other candidates and concluded neither needs a change this round: `importer.ts`
  moves a file to its final destination before writing `has_file`/`path` to the DB in all three
  place* functions — on a crash between those two steps the file sits correctly placed but
  untracked, which is actually the *safer* of the two possible orderings (the reverse would leave
  the DB pointing at a file that doesn't exist) and self-heals on the next Scan & Import since the
  file is already sitting in the root folder in its final form. Separately, `mediaServer.ts`'s
  Jellyfin/Emby watch-state push only targets the first user returned by `/Users` — a real scope
  limit on multi-user instances, but consistent with the feature's existing "low-frequency manual
  admin action" framing rather than an oversight
- Confirmed `naming.ts`'s template token replacement (single regex pass, exact-case tokens, correct
  zero-padding) and `mediaServer.ts`'s Plex vs. Jellyfin vs. Emby API differences (auth header
  names, the `/emby` path prefix Emby needs that Jellyfin dropped) are both handled correctly —
  nothing else to fix in either file

## Round 55
- Continued the provider-audit pass from Round 54 onto the indexer/download-client integrations
  (`indexerClient.ts`, `downloadClient.ts` — Torznab/Newznab, qBittorrent, SABnzbd, Real-Debrid,
  AllDebrid, FlareSolverr, and the http/ytdlp/blackhole adapters). Found one real bug: Torznab's
  `peers` attribute is the release's *total* peer count (seeders + leechers combined), not the
  leecher count on its own — the parser was assigning the raw `peers` value straight into
  `leechers`, so a release with 10 seeders and 5 real leechers (`seeders=10, peers=15` on the wire)
  would report 15 leechers instead of 5. Fixed to derive leechers as peers minus seeders, matching
  how Sonarr/Radarr's own Torznab parsers handle the same attribute, and to prefer an explicit
  `leechers` attr when an indexer happens to emit one directly. Currently has no live UI impact —
  `leechers` is stored and exposed via the API but nothing in the app renders or sorts on it yet —
  fixed anyway since it's real stored/API data with the wrong value. Verified the fix against a
  realistic Torznab XML fixture (seeders=10, peers=15 → correctly derives leechers=5)
- Everything else in both files checked out against the real documented protocol for each client
  (qBittorrent Web API v2, SABnzbd's mode=/apikey params, Real-Debrid and AllDebrid's REST APIs,
  Torznab/Newznab's t=/cat=/apikey= search params)

## Round 54
- Audited every external-provider URL builder in `metadata.ts` (46 functions across TMDB, TVDB,
  TVmaze, Trakt, AniList, MusicBrainz, Deezer, Discogs, Last.fm, Open Library, Google Books,
  ComicVine, MangaDex, RAWG, IGDB, YouTube, ThePornDB, Fanart.tv) for the same class of bug as the
  Open Library fix in Round 52 — a malformed path/param silently 404ing with the failure caught and
  never surfacing anywhere. Nothing else was broken; everything else checked out against each
  provider's real documented API shape
- Routed every remaining `console.warn`/`console.error` in the request-handling path through the
  same `log` service the rest of the app already uses, so failures that used to be visible only via
  `docker logs` now show up on the in-app Logs page too: the metadata child-import failure warning
  (the exact failure mode that hid the Open Library bug from view for however long it had been
  broken), two grab-notification failure warnings, and — the most consequential one — the top-level
  Express error handler that catches every route's unhandled exception app-wide. That last one had
  never gone through `log` at all, meaning any unexpected 500 anywhere in the app was invisible in
  the UI no matter how much of Round 51's logging work covered specific features
- Verified live: sent a deliberately malformed request body to force a real (non-`HttpError`)
  exception through the top-level handler, confirmed it now appears via `GET
  /api/system/logs?level=error`; separately imported an artist with a bogus MusicBrainz id and
  confirmed the child-fetch failure appears via `?level=warn`

## Round 53
- Added have/missing/total counts to every level of the nested-group library browsers (ROMs'
  System → Maker, Online Videos/Courses' Site → Creator, Adult's Site → Maker → Series) — each
  group card now shows a rolled-up `have/total` (e.g. a System's count includes every game under
  every Maker beneath it, not just games attached to the System directly), and the current group's
  own page shows the same as have/missing/total badges, matching every other library page. One
  recursive CTE (`WITH RECURSIVE`) walks arbitrarily many levels of `parent_group_id` per query
  rather than N+1 per-group lookups
- Added an optional, admin-editable description ("metadata for that page") to every group level —
  new `library_groups.overview` column, editable inline on the group's own browse page. Answers
  the "each layer having metadata" half of the ROMs/Online Videos ask that counts alone didn't cover
- Confirmed the Games list under a Maker (and every other grouped type's leaf-level item list) was
  already listing every item regardless of downloaded status, not just downloaded ones — no change
  needed there, just verified live
- Verified this round live end-to-end in a running test container: built a real System → Maker →
  3 Games hierarchy, confirmed the recursive count correctly rolled up through both levels
  (1 have / 3 total at both the System and the Maker), confirmed the description saves and
  persists across a reload, and confirmed the Games list under the Maker still shows all three
  games including the two missing ones

## Round 52
- Added dedicated detail pages for every "collection"-shape library's children (Album, Book,
  Audiobook, Issue, Chapter, Lesson, Video) — new `SubItemDetail.tsx` page at
  `/media/:mediaId/item/:subItemId`, new `GET /media/:id/subitems/:subItemId` endpoint. Clicking
  a child row on an Artist/Author/etc. page now opens its own page with full metadata (release
  date, monitored/file/quality status, file path, external id), instead of the old inline-only
  row. For Music specifically (the only type with a third level), the album page also shows its
  track list and each track links to its own new detail page (`TrackDetail.tsx` at
  `/media/:mediaId/item/:subItemId/track/:trackId`, new `GET
  /media/:id/subitems/:subItemId/tracks/:trackId` endpoint) — completing the requested
  Band → Album → Track drill-down
- Added have/missing/total count badges to the top of every collection-shape parent page (Artist,
  Author, etc.), matching what Round 51 already added for TV Shows and library list pages
- Fixed Books/Audiobooks import silently returning zero books for every author: Open Library's
  author→works URL was being built without the required `/authors/` path segment
  (`https://openlibrary.org${key}/works.json` instead of
  `https://openlibrary.org/authors/${key}/works.json`), so every lookup 404'd, was caught, and
  silently left the library empty — nothing in the UI signaled this had happened. Found while
  verifying the "Author page lists all books" requirement live: a real author import kept coming
  back with `childCount: 0`. Also hardened the general collection-children insert path (used by
  every collection-shape type, not just Books) against a *single* title-less entry from a provider
  aborting the *entire* batch — Open Library's own works list turned out to include one such
  malformed entry even after the URL fix, and since the insert ran as one all-or-nothing
  transaction, that one bad record was silently discarding every good one alongside it
- Verified this round live end-to-end in a running test container: imported a real 100-album
  Radiohead artist (MusicBrainz) and a real Stephen King author (Open Library, 49 of 50 works
  correctly imported, the one title-less entry correctly skipped instead of blocking the batch);
  confirmed the per-parent have/missing/total badges, confirmed clicking an album opens its detail
  page, confirmed a manually-seeded track list renders with its own have/total badge and links to
  a working track detail page with the full Artist / Album breadcrumb, and confirmed a Book child
  (a collection type with no `multiFilePerChild`) opens its detail page correctly with no
  Tracks section shown

## Round 51
- Added per-library have/missing/total count badges to the top of every library list page
  (`LibraryType.tsx`), computed from the already-loaded item list
- Import operations (single-file, music album, and the new TV season-pack path) now log an
  info-level line on success, not just on failure — visible both in `docker logs` and the
  in-app Logs page, since every prior round only logged warnings/errors and gave no visibility
  into what actually happened during a scan-import run
- Added a dedicated episode detail page (`web/src/pages/EpisodeDetail.tsx`, new route
  `/media/:mediaId/episode/:episodeId`, new `GET /media/:id/episodes/:episodeId` endpoint) showing
  full metadata (air date, overview, quality, file info, file path) for a single episode, reachable
  by clicking any episode row on a show's page
- Added the ability to search for a full season at once rather than one episode at a time: the
  search route now accepts a `seasonNumber` with no `episodeId` and matches releases by season only,
  and grabbing such a release now imports the whole season pack (new `placeSeasonPackFiles` in
  `importer.ts`, which walks the sibling files next to the downloaded anchor file and maps each to
  the matching episode by parsing season/episode out of its own name — the same pattern the existing
  music album importer already used for multi-file placement). Needed a new `queue.season_number`
  column to track season-only grabs through the download queue
- Rebuilt the TV Shows (and Anime, which shares the same episodic show shape) metadata page:
  seasons are now closeable/expandable sections like Sonarr, seeded open on first load; each season
  header shows its own have/total badges plus per-season Search/Monitor/Unmonitor actions; the page
  header shows the whole show's have/missing/total counts; episode titles now show the real fetched
  title instead of a bare "EPISODE 1" (falls back to an italic "Episode N" placeholder only when no
  title was ever fetched). Episode metadata fetches (TMDB/TVDB/TVmaze/Trakt/AniList) now also pull
  each episode's overview text, needed a new `episodes.overview` column
- Hardened the scan-import title guesser against dangling-parenthesis titles (e.g. "45 Years (")
  reported on some movies beyond the specific case fixed in Round 49: broadened the cut-pattern list
  to recognize more release-metadata markers (resolution, codec, audio format, edition tags, and
  imdb/tmdb/tvdb id tags) as places to stop, and broadened the trailing-punctuation strip to catch
  more leftover separators. Could not reproduce a fresh failure against the current build with
  realistic test filenames, so this is defensive hardening rather than a confirmed root-cause fix —
  worth watching for a recurrence with a concrete example if it still happens
- Verified this round's TV Shows work live end-to-end in a running test container: imported a real
  62-episode show, confirmed the per-show and per-season count badges, confirmed season sections
  collapse/expand correctly, confirmed clicking an episode navigates to its detail page with full
  metadata, confirmed the "Search season" button reaches the season-only search endpoint and returns
  results, and confirmed the library list page shows the new have/missing/total header

## Round 50
- Fixed TV Shows Scan & Import skipping everything: the episodic branch only ever *matched*
  against an existing series, it never created one — a fresh TV library with nothing pre-added
  in AoNarr yet skipped every single file. Now creates a new series (mirroring what the movie/
  single-shape branch already did) when nothing matches. Also made season/episode + series-title
  detection folder-aware: real TV libraries very often only carry the series name in the folder
  structure (`Series Name/Season 01/S01E01.mkv`, sometimes just `Series Name/Season 01/01.mkv`)
  rather than repeating it in every episode's filename, which the filename-only detection used
  before this couldn't handle at all. Found and fixed a second bug surfaced while verifying
  this: files named just `01x02.mkv`/`E03.mkv` (with the series name only in the folder) were
  getting used as literal series titles instead of falling back to the folder, since the title
  guesser only recognized `SxxExx` as a marker to strip, not the other formats it was actually
  being asked to detect season/episode from. Verified against three episodes of the same series
  using three different naming conventions (`S01E01`, `01x02`, `E03`, series name only in the
  folder) — all three now land under one correctly-created series with the right episode numbers
- Added the ability to search with a custom query and pick a different metadata match for an
  existing item — a Radarr/Sonarr-style "interactive search" popup (new `SearchMatchModal`
  component, `POST /media/:id/rematch`), for exactly the situation a bug report surfaced: an item
  whose title got garbled by an old scan-import bug, where every "Fetch from X" button and Library
  Refresh could only ever search using that same broken stored title and would always come back
  empty. Verified end-to-end in the actual browser: opened the modal, searched a real provider,
  picked a result, and confirmed the item's title/year/overview/poster/externalIds updated

## Round 49
- Fixed the Scan & Import 504: it probed every matched/created file with ffprobe (up to a 30s
  timeout each) synchronously inside the HTTP request, so a library with even a few slow or
  unreadable files could easily exceed any reasonable gateway timeout even though the scan itself
  kept working fine in the background. Both `/media/scan-import` and `/media/refresh` are now
  fire-and-forget — same pattern the scheduled job registry already uses for exactly this reason —
  responding immediately and logging the real result (matched/created/skipped, or updated/failed)
  once it finishes. Verified: the request now returns in ~70ms regardless of library size
- Fixed a real diagnostic dead-end while investigating the above: ffprobe was invoked with `-v
  quiet`, which suppresses its own explanation of *why* a file failed to probe along with the
  routine info it's meant to silence — a genuinely corrupt file logged nothing but "Command
  failed: ffprobe ...", repeating the command back with no reason. Changed to `-v error`; the
  exact same corrupt-file scenario now logs the real cause (e.g. "Failed to read frame size:
  Could not seek to 3071. Invalid argument") instead
- Fixed a title-guessing bug this surfaced: cutting a filename at its year marker left a dangling
  separator behind — "45 Years (2015).wmv" guessed a title of "45 Years (" instead of "45 Years".
  Strips trailing separator punctuation after the cut now; reverified the same file produces a
  clean title

## Round 48
- App icon now appears in the sidebar next to the "AoNarr" wordmark, not just the browser tab
- Default WebUI port changed from 7878 to 9876, everywhere it's referenced: nginx (both the
  combined image's static config and the split web image's template), both Dockerfiles'
  `EXPOSE`/`HEALTHCHECK`, `docker-compose.yml`, the `aonarr`/`aonarr-web` Unraid templates'
  `WebUI`/`Config` port entries, the Remote Library page's example URL placeholder, and the
  current-instructions parts of the README (a historical log entry describing a past port-7878
  bug was left as-is, since rewriting history there would be inaccurate). `aonarr-server.xml`'s
  8989 API port is unrelated to this and wasn't touched. Verified against a real container mapped
  to the new port: root page, `/icon.svg`, and `/api/health` all 200, and Docker's own
  `HEALTHCHECK` (which hits the port internally, not through the host mapping) reports `healthy`
- Removed the default Media/Downloads path values from the two Unraid templates that have them
  (`aonarr.xml`, `aonarr-server.xml` — `aonarr-web.xml` has no path config at all) — previously
  pre-filled with `/mnt/user/media`/`/mnt/user/downloads`, which could look like a working default
  and get skipped past rather than pointed at the user's actual shares; now blank so the field has
  to be deliberately filled in

## Round 47
- Fixed the last of the toolbar height discrepancy: the dropdown trigger's height was set on the
  wrapping `.dropdown` div and inherited by its inner button via `height: 100%` — a percentage
  chain through an inline-flex wrapper that doesn't reliably compute to the exact same pixel value
  as a plain sibling button/select in every browser. Set the height directly and unconditionally
  on the trigger button itself instead, with nothing to inherit through, and let the wrapper
  shrink-wrap to match it exactly
- Widened the Sort select (160px → 210px) — its longest option ("Sort: Recently added") was being
  clipped by the dropdown-arrow padding added in Round 45. Verified via scrollWidth vs clientWidth
  that it no longer clips, and reconfirmed every toolbar control still sits at identical
  top/height pixel values

## Round 46
- Fixed a real bug in Round 45's own fix: the hand-drawn caret background-image on `<select>` had
  no `background-size` set, so it rendered oversized (a giant chevron overlapping the option
  text) instead of the intended small 12×8px arrow — a mistake `getBoundingClientRect()` alone
  couldn't have caught, since box height was already correct; only visually apparent. Added
  `background-size: 12px 8px`, confirmed via computed styles this time (not just element bounds)

## Round 45
- Toolbar `<select>` elements now have their native OS dropdown-arrow chrome stripped entirely
  (`appearance: none` + a hand-drawn caret background image) instead of relying on an explicit
  `height` override to fight it — some browsers keep their own intrinsic sizing around that native
  arrow area regardless of CSS height/padding, which can still show as a shorter/taller control
  next to a plain button even when computed styles look identical in devtools. This is a stricter
  fix than Round 44's, verified again with getBoundingClientRect() (still pixel-identical) plus
  now robust against the browsers where the height-only approach wasn't enough
- Icon v2, per feedback on the first design: the play-mark center is now a hand-drawn geometric
  "A" monogram (three strokes — two diagonals, one crossbar — no font dependency so it renders
  identically everywhere including Docker Hub/Unraid CA), and the single orbiting dot is now 8
  small stars spaced evenly every 45° around the ring

## Round 44
- Found and fixed the actual remaining cause of the Library toolbar misalignment: a `<select>`
  carries its own native intrinsic sizing around the dropdown-arrow area that identical
  padding/border CSS can't fully override, so it still rendered a couple of px taller than a
  `<button>` with pixel-identical box properties. Pinned an explicit height on every `.toolbar`
  child instead of relying on padding/border alone, and split the Library page's single crowded
  toolbar row (9 controls) into two purposeful rows — filters, then view/export/job actions — so
  wrapping on a narrower window happens at a clean boundary instead of mid-row. Verified via
  getBoundingClientRect() on a live page: every control in each row now sits at the exact same
  `top`/`height` pixel values
- Found and fixed a real, previously-undetected bug while wiring up a new app icon: neither
  `web/Dockerfile` nor `Dockerfile.combined` ever copied `web/public/` into the build stage, so
  Vite had nothing to copy into `dist/` — every image built and shipped this entire session was
  silently serving no favicon, no PWA manifest, and no service worker. Added `COPY web/public
  ./public` to both. Verified against a real container: `icon.svg`/`manifest.json`/`sw.js` all
  returned 404 (served the SPA's `index.html` fallback instead) before the fix, all correctly
  return 200 after
- Replaced the placeholder icon (a rounded square with a plain "A") with a custom design — a ring
  around a play mark, in the app's own accent-blue gradient — referenced by a single source file
  (`web/public/icon.svg`) that every required location already pointed at (browser tab favicon,
  PWA manifest, and all four Unraid template/`ca_profile.xml` `<Icon>` tags), so no other file
  needed updating to pick it up

## Round 43
- Library page toolbar buttons (the new "View"/"Export & Bulk" dropdowns, "Scan & Import",
  "Refresh") were using `button.secondary`'s lighter gray instead of matching the black
  `<select>` boxes sitting right next to them in the same row — added a `.select-like` class
  (same background/border/padding as input/select) and applied it to all four, confirmed via
  computed styles that background color, border, and box height now match the selects exactly
- Added the Unraid Community Applications submission files at the repo root: `LICENSE` (MIT),
  `ca_profile.xml`, and moved the existing templates from `unraid-templates/` to `templates/`
  (the layout CA's own starter repo and submission scanner expect), updating each template's
  `TemplateURL` to match and adding a `<License>` tag now that one exists

## Round 42
- Fixed another alignment bug from the same root cause as Round 41's sidebar fix: `button` has a
  global `margin-top: 16px` (meant for a button following a stacked label+input), which also
  pushed toolbar buttons down out of line with the select/input sitting next to them — visible on
  the Logs page's "Load logs" row and every Library page's toolbar. Added a `.toolbar` class that
  resets it, used consistently everywhere a row of controls needs to sit flush on one baseline
- Consolidated each Library page's five export/bulk-edit buttons (Export CSV, .nfo, JSON, Plex,
  Calibre, Bulk edit via CSV) into one "Export & Bulk" dropdown, and the Posters/List view toggle
  into a "View" dropdown — a new reusable `DropdownMenu` component, since nothing like it existed
- Two new jobs, each with a per-library "Scan & Import" / "Refresh" button placed in the same
  toolbar row: **Library Scan & Import** walks a library type's root folder(s) for media files not
  already tracked, matches them into an existing "missing" item by filename-guessed title where
  possible (has_file + path, same as a normal import) or creates a new item outright when nothing
  matches — scoped to single/episodic shapes (Movies, TV, Anime, ROMs, Adult) since collection
  shapes (Books, Comics, Music, Online Videos, Courses) need an existing parent to file a new child
  under, so those report a clear "not supported yet" instead of guessing at structure. **Library
  Refresh** re-pulls overview/poster/year from the type's metadata provider for every existing
  item. Verified scan & import against real files in a running container: matched an existing
  "missing" item by parsed title, correctly parsed quality from the filename for both the matched
  and newly-created item, and a second run against the same files found nothing new (idempotent)

## Round 41
- Fixed a real sidebar layout bug: `.sidebar a` had no `display` set, so nav links defaulted to
  `display: inline` and wrapped like text instead of stacking one per line — visible as staggered,
  out-of-line text any time a dropdown (Library, Manage, Configuration, System) had more than a
  couple of items open

## Round 40
- Plex-specific metadata export: the existing .nfo export only ever covered Kodi/Jellyfin/Emby —
  Plex's own local-media agents don't read .nfo sidecars at all. Added `.plexmatch` (Plex's own
  match-override text format, since PMS 1.25) as a new export option, both individually and in
  bulk (as `.plexmatch` + `poster.jpg` inside each item's own folder, since it has to be named
  exactly that to be picked up — never per-title-named like the other sidecar formats)

## Round 39
- Watch-state sync now flows both ways — previously only the media server could tell AoNarr
  something was watched (via the webhook or the periodic poll behind auto-archival). A "Mark
  watched"/"Mark unwatched" button on the media detail page writes AoNarr's own watch_events
  *and* best-effort pushes the same state to the configured Plex/Jellyfin/Emby server (resolved by
  file-path match, same tail-matching heuristic library validation already uses); a media-server
  push failure is reported but never rolls back AoNarr's own local state. Jellyfin/Emby's
  PlayedItems endpoint was verified live against a public Jellyfin demo server (both a real 401
  from a fake token and full round-trip through the actual UI); Plex's long-stable :/scrobble
  endpoint is implemented per its documented contract but has no public demo server to verify
  against the same way

## Round 38
- Bulk metadata export now includes the actual poster image, not just a remote URL reference
  inside the .nfo/.opf sidecar — `poster.jpg` alongside each item in the Kodi/Jellyfin/Emby-style
  bulk export, `cover.jpg` (Calibre's own convention) in the Calibre export, so the exported
  package is genuinely self-contained instead of needing internet access later to resolve it

## Round 37
- AllDebrid support as a second "debrid" download client type alongside Real-Debrid — same shape
  (grab a magnet/torrent, wait for their servers to cache it, pull the unlocked link(s) directly),
  different provider and API. Unlike Real-Debrid, AllDebrid's upload endpoint accepts a magnet URI
  or a .torrent URL through the same parameter, so no separate code path per input shape was
  needed

## Round 36
- Blackhole download client type — for a torrent/usenet client with no usable HTTP API, AoNarr
  drops the release as a .magnet/.torrent/.nzb file into a watch folder for that client to pick
  up on its own, the oldest and most universal *Starr integration pattern. Fire-and-forget by
  design (documented clearly in the UI): AoNarr can't track an unknown external client's progress,
  so the queue entry stays "downloading" — point the client's own completed output at a root
  folder to get files into the library

## Round 35
- Import Lists finally got a UI (Manage → Import Lists) — the recurring Trakt/IMDb auto-add
  backend has existed since Round 27's generalization from the old single Trakt-sync setting, but
  had no page to manage it from; found while adding a new source type and not wanting to add a
  UI-less feature on top of another UI-less feature
- Last.fm added as a third import list source type — imports a Last.fm profile's all-time top
  artists into Music (Last.fm has no user-playlist concept of its own, so top artists is the
  closest equivalent); required dropping the `import_lists.type` CHECK constraint the same way
  indexers/download_clients did previously, verified against a real pre-existing database that
  the migration preserves existing rows and unlocks the new type
- Logs page: filter by level, search by text, and a "Download .log" export button; bumped the
  in-memory log buffer from 500 to 2000 lines

## Round 34
- Video Channel Check: a scheduled job that re-lists every monitored Online Videos channel's
  current uploads, adds any video not already known as a new sub-item, and — if a yt-dlp download
  client is configured — auto-grabs it immediately, closing the gap where channels previously
  only ever got their video list populated once at add time with no way to pick up new uploads
  short of manually re-adding the channel

## Round 33
- Friend Libraries (Manage → Friend Libraries) — connect a friend's own Plex/Jellyfin/Emby server
  (shared with you, separate from the media server AoNarr manages its own library against) and
  compare their library against yours by title/year to see what they have that you're missing,
  with a one-click "Add" straight into the existing Add Media flow, pre-filled and auto-searched

## Round 32
- Auto Upgrade: an opt-in scheduled job (Settings → General, off by default) that finds every
  item currently below its quality profile's cutoff and runs it back through search-and-grab, so
  raising a cutoff actually gets enforced over time instead of just being a report an admin has
  to act on by hand
- "Create new folder" in the folder-browser picker (Settings → Root Folders → Browse...) — create
  a subfolder on disk from the picker itself, instead of only being able to select folders that
  already exist

## Round 31
- Real-Debrid support as a new download client type — grabbed magnet/torrent links are sent to
  Real-Debrid's API, AoNarr polls until they're cached, then unrestricts and downloads the
  resulting link(s) directly; no host/port to configure, just an API token from Real-Debrid's
  account page
- Custom theme support — a raw-CSS field in Settings → General, served publicly at
  `/api/theme.css` (no login needed, same as the stylesheet itself) and loaded for everyone on
  next page load; documents the app's CSS variables (`--accent`, `--bg`, etc.) so an admin can
  reskin the instance without editing source

Found and fixed a real bug while building the theme feature: a static `<link>` tag in
`index.html` had no guaranteed position relative to Vite's build-injected bundled stylesheet, so
on a `:root { --accent: ... }` specificity tie the wrong one could win depending on injection
order. Fixed by fetching and appending the custom CSS as a `<style>` tag at runtime instead,
which guarantees it lands after the bundled stylesheet in the DOM.

## Round 30
- Corrupt media detection: a scheduled job (+ an on-demand "Check for corruption" button on media
  detail pages) validates every file with ffprobe, moving anything that fails — including a real
  video-library file that ffprobe reads fine but has no video stream at all, a classic sign of a
  fake/mislabeled release — to the Recycle Bin and marking it missing so auto-search retries it
- Folder-browser picker (the "Browse for folder" pattern the other *Starr apps use) instead of
  typing/pasting a path blind, wired into Root Folders
- Audio-only ripping for the yt-dlp download client — extracts to mp3 instead of saving video,
  for pulling music out of a video source

Also found and fixed a real bug while building the audio-only toggle: the download clients PATCH
route passed raw JS booleans straight to better-sqlite3, which rejects them outright — coerced to
1/0 for the columns that are actually booleans.

## Round 29
- TRaSH-Guides custom format import — paste a TRaSH-Guides/Radarr/Sonarr custom format JSON
  export and title/release-group/size conditions translate directly into a real custom format;
  unsupported condition types (language, etc.) are reported as skipped rather than silently lost
- Metadata export: individual (.nfo or JSON, from a media item's own page) and bulk (a .zip of one
  file per item, from any library type's page)
- Calibre export — a .zip of Calibre-compatible .opf sidecars for Books/Audiobooks/Comics/Manga
- Network Stats page — per-download-client bandwidth totals plus a queue status/size breakdown

This closes out the last of the originally-listed "straightforward" batch from a few rounds back.

## Round 28
- Anime absolute-episode naming: new {absoluteEpisode} naming token (a running count across every
  season) as an alternative to {season}/{episode}, alongside the existing global numbering
- Prowlarr indexer sync — mirrors your Prowlarr instance's indexer list in, searches go through
  Prowlarr's own per-indexer proxy so credentials stay managed there; scheduled job + manual sync
- Trailers on the media detail page (movies/series/anime, via TMDB) when a trailer is available
- Notifications expanded to Matrix and SMS (Twilio), alongside the existing
  Discord/Slack/Telegram/Pushover/webhook/email channels

## Round 27
- New Manga library (Books-shaped, metadata from AniList and MangaDex — both free, no API key)
- Missing page: episodes now group by series with a "Search all missing in this series" button,
  and every row (movies/episodes/albums/books) got an individual "Search" button, not just bulk
- Complete size details: total + per-library size on the Dashboard, a size per type on the
  Library overview page, and each library type's own page now shows its size — computed from
  actual on-disk file sizes (cached 10 minutes), not just free-space-remaining like before
- Confirmed already covered by earlier rounds, no new work needed: max-quality-wanted (quality
  profile "cutoff" already caps upgrades there), audio/video codec display (already shown on
  Media Detail via ffprobe-derived info), and logs outside the container (already written to
  stdout/stderr for `docker logs`, in addition to the in-app System → Logs tab)

## Round 26
- Stalled-download cleanup job: a queue item with no progress for longer than a configurable
  threshold gets dropped and retried with the next-best release, same as a failed grab
- Archive unpacking: .zip (built-in), .7z/.rar (if the `7z`/`unrar` binary is present) inside a
  download are unpacked automatically before the importer looks for the media file
- SOCKS5 proxy support — routes every outbound request (indexers, metadata providers, download
  client APIs) through a configured proxy, takes effect immediately with no restart
- External URL setting, used to build share links correctly behind a reverse proxy where the
  browser's own URL doesn't match the actual public one

## Round 25
- Job scheduling system: every background job (auto-search, queue poll, auto-archival, Trakt
  sync, import lists, disk usage sampling, recycle bin cleanup, scheduled backup) now has an
  editable schedule, a manual "run now", and best-effort cancellation, all on a new Jobs page
- Recycle bin: files removed via Media Detail's opt-in "delete files" or auto-archival's
  permanent-delete option move into a type-namespaced recycle bin instead of being deleted
  outright, with a scheduled cleanup job (editable via Jobs) purging entries past retention. New
  Recycle Bin page groups entries by library type and can restore or permanently delete each one.

## Round 24
- Media detail pages now show the poster image (previously never rendered at all) alongside a
  Details panel: added date, quality profile, root folder, file path, tags, and external IDs
  rendered as links to TMDB/IMDb/TVDB/TVmaze/AniList/MusicBrainz/Discogs/Open Library/Comic
  Vine/IGDB/Trakt where the provider is recognized
- Fixed a frontend type gap: MediaItem was missing externalIds entirely, so it was never
  accessible on the detail page despite the API always returning it

## Round 23
- Poster size option (small/medium/large, persisted per browser) on every library type's poster view
- Verified Online Videos' and Courses' group hierarchies live against the actual published image,
  not just typechecked — both browse and label correctly at every level

## Round 22
- Multi-source metadata on the media detail page — pull a second opinion from any other
  configured provider for that type without touching the item's primary overview/poster, then
  optionally promote a source's overview or poster to primary
- PATCH /api/media/:id now accepts overview/posterUrl directly, backing that promotion

## Round 21
- Verified Adult's 3-level hierarchy (Site → Maker → Series) end-to-end, not just typechecked
- Add Media now shows cascading group pickers (with inline "+ New" at every level) for grouped
  types, so a new ROM/Adult/Online Video/Course item can be filed into its group on creation
- Media detail pages for grouped types show their current location and a "Move to group..." panel
  to refile an existing item

## Round 20
- Nested library grouping (generic `library_groups` table + API) for the library types whose
  real-world organization goes deeper than one level: ROMs (System → Maker → Game), Adult
  (Site → Maker → Series → Video), Online Videos (Site → Creator), and Courses (Site → Creator)
- Library pages for those types now browse through the group hierarchy before showing items, with
  breadcrumbs, in-place group creation/deletion, and an "ungrouped items" fallback view
- `/api/media` and the add-media endpoint accept a `groupId` to file an item directly under a group

## Round 19
- Library restructured: a landing page showing recently-added across every type plus per-type
  cards, and each library type now has its own page with sort/status-filter/tag-filter and a
  posters-vs-list view toggle (persisted per browser)
- Sidebar reorganized into collapsible groups (Library, Manage, Configuration, System) instead of
  one long flat list, with the Library group expanded to show every type as a direct link

## Round 18
- Indexer rate-limit backoff — a 429 pauses that indexer for 15m instead of retrying every cycle
- Consolidated health dashboard now also covers download client reachability and low disk space
- Admin-triggered password reset for household accounts, with automatic session revocation
- Settings and System pages reorganized into tabs instead of one long scroll
- Users/Indexers/Download Clients/Watchlist Import "Add" flows moved into popup dialogs
- Watchlist Import gained a single-title add option alongside the existing CSV upload

## Round 17
- Guided first-run onboarding wizard (root folder → indexer → download client checklist)
- SMTP email notifications alongside the existing webhook/bot providers
- Import lists — recurring Trakt/IMDb list auto-add, generalized from the old single Trakt-sync setting
- Audiobooks as a distinct library type
- Public, revocable share links for a single media item's overview/poster
- Per-account TOTP two-factor (household and admin-via-session, not just the legacy API key)
- Docker-secrets-style `_FILE` env vars, plus non-interactive admin account bootstrap
- In-app update checker comparing the running image's build time against Docker Hub

## Round 16
- Multi-instance federation — browse another AoNarr instance's library read-only
- Smart collections — a saved filter re-evaluated live instead of a fixed item list
- Release-group reputation tracking, used as a search tiebreaker
- Bulk edit via CSV upload (the inverse of CSV export)
- Storage quota per root folder, with optional auto-pause of new grabs
- Duplicate request detection for household requests
- Search window scheduling — restrict auto-search to a daily time window
- Media server library validation (AoNarr's library vs. what Plex/Jellyfin/Emby actually reports)

## Round 15
- Plex/Jellyfin/Emby webhook receiver for instant "recently watched" updates
- Self-hosted OpenAPI/Swagger docs page at `/api-docs`
- Download queue manual reordering/priority (qBittorrent, SABnzbd)
- Parental/content rating controls per household user
- Torrent client health stats (seed ratio, upload/download totals, ratio-limit warnings)
- Remote backup destination (S3-compatible: AWS S3, MinIO, Backblaze B2, etc.)
- In-app changelog page (this page)
- Saved/recent searches on Global Search
- Actor/cast browsing pages

## Round 14
- ffprobe media info extraction on import (real codec/resolution/bitrate)
- Automatic failed-grab retry (blocklists the failed release, tries the next-best result)
- FlareSolverr indexer proxy support for Cloudflare-protected indexers
- Import exclusions ("never add this again")
- Custom scripts on grab/import/failure events
- Bulk cleanup suggestions (unmonitored + no file, duplicate-content files)
- Per-user request/storage stats
- Keyboard shortcuts + command palette (Ctrl/Cmd+K)
- Scene-name fallback search

## Round 13
- Season-level monitor toggle
- Multiple root folders per type with free-space auto-selection
- NFO metadata import (Kodi/Jellyfin-style sidecar files)
- Active session list + revoke for household accounts
- Scheduled automatic backups (local)
- CSV export of the library
- Home dashboard (Recently Added, Recently Watched, Upcoming)
- Additional subtitle providers via a generic Custom (JSON API) type

## Round 12
- Login rate-limiting (API key + TOTP)
- Docker HEALTHCHECK on both containers
- In-app log viewer
- Prometheus `/metrics` endpoint
- Duplicate-on-add confirmation
- Scheduled quiet hours for auto-search
- Watchlist CSV import (IMDb/Letterboxd/Trakt)
- iCal feed for the release calendar
- Light/dark theme toggle
- Customizable notification message templates

## Round 11 and earlier
Multi-user accounts and a request portal, watch-status auto-archival, a unified health dashboard,
backup/restore, release blocklist, recommendations, Trakt list sync, duplicate/upgrade detection,
per-user request limits, an activity/audit log, PWA + Web Push notifications, a generic DDL/RSS
indexer protocol, direct-HTTP and yt-dlp download clients, search caching, collections as
exportable playlists, a unified activity timeline, upgrade-candidate detection, storage
forecasting, bulk Library/Missing actions, config template import/export, and TOTP two-factor
login — see README.md for the complete history.
