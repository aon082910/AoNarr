# External Database Support — Scoping Document

Status: **PostgreSQL — 49 files converted and verified against a real Postgres container**, covering
auth, users, quality/library config, indexers, download clients, calendar events, saved library
views, remote instances, friend libraries, library groups (including its `WITH RECURSIVE`
nested-count rollup), person credits, custom formats (including TRaSH-Guides sync), collections
(including its smart-filter query builder and item reordering transaction), album tracks, blocklist,
import exclusions (route only), artwork selection, global library search, share links, activity
(queue/history/timeline), the public calendar feed + token, the dashboard widgets, subtitle providers,
the wanted/missing + calendar views, household requests (including auto-approval and per-user storage
stats), web push subscriptions, the media-server watch webhook, library/media-server validation, and
the full recycle-bin/corrupt-media/auto-archival cluster. Most of the app (~21 remaining files) still
isn't converted; `AONARR_DATABASE_DRIVER=postgres` runs a real app, just not a complete one yet.
MariaDB — scoped, not started, deliberately deferred until PostgreSQL is fully done (see "The ask"
below; narrowed from "MariaDB or PostgreSQL" to "PostgreSQL first" by explicit user decision). This
document exists so a future round can pick this up without re-deriving the analysis below.

## Progress (Round 90)

Converted the recycle-bin/corrupt-media cluster deliberately deferred back in Round 86 and Round 88:
`services/recycleBin.ts` + `routes/recycleBin.ts`, `services/corruptMediaCheck.ts` +
`routes/corruptMediaReview.ts`, and `services/archival.ts` (auto-archival's retention-override lookup,
history logging, and the actual move/recycle/delete). This was possible now because the blocking
caller was only ever `recycleFile()` — every one of its unconverted call sites (`archival.ts` itself,
and 3 in the still-unconverted `routes/media.ts`) already sits inside an `async` handler, so making
`recycleFile()` genuinely async just meant adding `await` in front of 3 existing call sites in
`media.ts` — no need to convert `media.ts`'s own (much larger) set of database calls to unblock this
cluster. `services/archival.ts`'s `scheduler.ts` and `routes/system.ts` call sites, and
`corruptMediaCheck.ts`'s `scheduler.ts` call site, were already correctly `await`-ing these
(previously-synchronous-in-practice) functions as if they returned promises, so no changes were needed
there either.

`recycleBin.ts`'s `purgeExpiredRecycleBinEntries()` was one of the 5 files flagged in the original
Round 79 SQL-portability audit as using SQLite's `datetime('now', ?)` modifier syntax — converted to
the `nowOffsetExpr()` helper added in Round 86, the second of the 5 flagged files to actually use it
(after `collections.ts`).

`startRestoreFromRecycleBin()` had a doc comment promising it "throws synchronously... before any
async work starts" for its cheap validation checks (missing entry, already restoring) — with the DB
read now async, that's no longer literally synchronous, but the *behavioral* guarantee (validation
rejects before the actual file-move work begins) still holds; updated the comment's wording rather
than its meaning.

Verified live against a real Postgres container (no admin-bootstrap env vars): created real on-disk
test files, created media items pointing at them (via the still-shadow-SQLite-backed
`metadata.ts`/`media.ts` create path — a deliberate reminder that an unconverted file's own reads/
writes still land in the orphaned local SQLite database documented since Round 80, even though the
callee functions it invokes, like `recycleFile()`, now correctly reach the real configured backend),
exercised the full delete-with-recycle → list → restore → re-delete → purge lifecycle through
`media.ts`'s converted call sites and confirmed the file actually moved and moved back on disk each
time, and exercised the corrupt-media-review confirm/dismiss routes against directly-seeded Postgres
rows (necessary since review entries have a real FK to `media_items`, unlike the shadow-SQLite-backed
create path) — same sequence regression-checked against SQLite on the same build, where the single
consistent database made the whole flow simpler to verify end to end (and additionally surfaced that
`recycle_bin.media_item_id`'s `ON DELETE SET NULL` correctly nulls out once the parent row is actually
gone — the Postgres run didn't show this because the shadow-SQLite delete never touched the real
Postgres row, not because of any behavior difference between backends).

## Progress (Round 89)

Converted 6 files across three self-contained pairs: `services/push.ts` + `routes/push.ts` (VAPID
keys, web push subscribe/unsubscribe, send), `services/mediaServerWebhook.ts` +
`routes/mediaServerWebhook.ts` (the Plex/Jellyfin/Emby watch-event webhook receiver and its admin
token), and `services/libraryValidation.ts` (cross-references AoNarr's library against a configured
media server's own reported files, called from the still-unconverted `system.ts` — safe since that
call site already used `await`). Also converted `routes/requests.ts` (household media requests: list,
submit with duplicate-detection and per-user pending-request caps, admin approve/reject, per-user
storage-attribution stats, delete).

Before converting `push.ts`, confirmed both its call sites (`services/notifications.ts` and
`routes/requests.ts`) already treat `sendPush()` as a Promise (`.catch()` fire-and-forget or collected
into a `jobs` array) even though it was synchronous-under-the-hood until now — so making its DB calls
genuinely async carried none of the "unconverted caller doesn't await" risk that's blocked converting
several other small services in recent rounds.

`requests.ts`'s `approveRequestRow()` and the reject route both used `datetime('now')` inline in an
UPDATE's SET clause — replaced with the `nowExpr(db)` helper from Round 79/80 rather than
`nowOffsetExpr` (Round 86), since these need "right now," not a relative offset. Also applied
`Number(...)` to two more `COUNT(*)` results (`requests.ts`'s per-status counts and pending-count
check) proactively, per the established Round 84/86 bug class, before verification could catch them
live.

Verified live against a real Postgres container (no admin-bootstrap env vars): fetched the VAPID
public key and round-tripped a push subscription, confirmed the webhook token endpoint and a
Jellyfin-style watch payload correctly resolved to a seeded media item and immediately showed up in
the already-converted dashboard's recently-watched (a genuine cross-file check, not just an isolated
route test), exercised the full request lifecycle (submit via direct seed, per-user stats with correct
numeric counts, approve with its named-parameter media-item insert, reject with its `nowExpr`
resolution timestamp, delete), and confirmed `library-validation`'s "no media server configured" error
path (its query path itself validated by code review + typecheck + the camelCase-alias grep, since
exercising the success path needs a live media server, consistent with how other conditionally-gated
services were verified in this migration) — same sequence regression-checked against SQLite on the
same build with identical results.

## Progress (Round 88)

Converted 5 more self-contained route files: `routes/activity.ts` (queue, history, and the merged
cross-source timeline), `routes/calendarFeed.ts` (both the admin token router and the public `.ics`
feed router), `routes/dashboard.ts` (recently-added, per-type library counts, on-disk library sizes
with its 10-minute cache, and the media-server-aware recently-watched cross-reference), `routes/subtitles.ts`,
and `routes/wanted.ts` (missing items and the calendar view).

Quoted a large number of unquoted camelCase SQL aliases across this batch — `wanted.ts` and
`calendarFeed.ts` especially, since both build several near-identical multi-column SELECTs by hand
(`mediaItemId`, `mediaTitle`, `episodeId`, `subItemId`, `sortKey`, `hasFile`, `epTitle`, `subTitle`) —
same bug class as every prior round. Also proactively wrapped `dashboard.ts`'s `COUNT(*) AS count`
result in `Number(...)` before this round's own Postgres verification could catch it as a live bug,
since the Round 86 (`collections.ts`) and Round 84 (`libraryGroups.ts`) fixes already established that
Postgres returns `COUNT`/`SUM` aggregates as strings, not numbers.

**Deliberately NOT converted this round**: surveyed `routes/metrics.ts`, `routes/metadata.ts`, and
`routes/watchlistImport.ts` and left all three alone — each calls at least one of
`services/duplicateCheck.ts`, `services/importExclusions.ts`, or `services/upgradeCandidates.ts`
synchronously, all of which are themselves called from the still-unconverted media-add/search
pipeline (`media.ts`, `search.ts`, `importer.ts`, `recommendations.ts`, `traktSync.ts`,
`importReview.ts`). These three routes, together with `metadata.ts`'s own "add media" flow, form a
tightly coupled cluster (creating a media item, checking for duplicates/exclusions, and populating its
children) that's better tackled as one dedicated round alongside `media.ts` than converted piecemeal —
the same reasoning as the recycle-bin cluster deferred in Round 86.

Verified live against a real Postgres container (no admin-bootstrap env vars): seeded two movies and
a queue item directly via `psql`, confirmed the dashboard's library-counts came back as real numbers
(not Postgres's string-typed `COUNT` result), fetched recently-added/recently-watched/library-sizes,
listed wanted/missing and the wanted calendar with all their aliased columns intact, exercised the
full activity queue lifecycle (list, the "no download client" 400 path, delete) plus history and
timeline, created and listed a subtitle provider, and fetched/regenerated the calendar token before
confirming the public `.ics` feed both serves a real event and 401s on a wrong token — same sequence
regression-checked against SQLite on the same build with identical (empty-state) results.

## Progress (Round 87)

Converted 5 small, self-contained route files: `routes/blocklist.ts`, `routes/importExclusions.ts`
(the CRUD route only — its backing `services/importExclusions.ts` stays on the old sync path, see
below), `routes/artwork.ts`, `routes/librarySearch.ts` (the app's global cross-library search), and
`routes/shareLinks.ts` (both the admin-only and fully-public routers it exports).

**New portability issue found**: `librarySearch.ts`'s query used plain `LIKE` for its search-term
matching. SQLite's `LIKE` is case-insensitive for ASCII by default; Postgres's is case-sensitive — so
the exact same query would silently return fewer results (or none) on Postgres for any query that
didn't match the stored title's case. Fixed with a dialect-conditional operator (`ILIKE` on Postgres,
`LIKE` on SQLite) rather than a wrapper-level translation, since not every `LIKE` in the codebase
needs this (a handful of other converted/unconverted files use `LIKE` for exact substring flags where
case sensitivity doesn't matter, e.g. matching a JSON key). Also quoted several more unquoted
camelCase SQL aliases across these files (`AS mediaItemId`, `AS releaseTitle`, `AS createdAt`, etc.),
the same Round 80 bug class — `librarySearch.ts`'s query was a `UNION ALL`, where only the first
branch's aliases needed quoting since Postgres (like SQLite) takes the union's output column names
from the first `SELECT`.

**Deliberately NOT converted this round**: the surveyed remainder of the ~42 files fell into two
buckets, both left alone. First, several small services (`services/blocklist.ts`,
`services/importExclusions.ts`, `services/releaseGroupStats.ts`, `services/rootFolderSelect.ts`,
`services/duplicateCheck.ts`) export synchronous helper functions called directly, with no `await`,
from deep inside the still-unconverted search/import pipeline (`search.ts`, `importer.ts`,
`media.ts`, `recommendations.ts`, `traktSync.ts`, etc.) — converting their DB calls to async now would
leave those pipeline call sites firing unawaited promises against Postgres, the same risk class
documented for `customFormatScoring.ts` in Round 85 and the recycle-bin cluster in Round 86. Second,
`services/storageForecast.ts` and `services/duplicates.ts` are only called from `routes/system.ts` and
`services/scheduler.ts`, both large, central, not-yet-converted files better tackled as their own
dedicated round rather than piecemeal.

Verified live against a real Postgres container (no admin-bootstrap env vars): seeded two movies
directly via `psql`, confirmed `library-search` matches case-insensitively in both directions
(lowercase query against a mixed-case title, and vice versa) via the new `ILIKE` path, selected
artwork, created/listed/deleted a blocklist entry (confirming every quoted alias round-trips
correctly, including the `JOIN`-derived `mediaTitle`), created/listed/deleted an import exclusion,
and created/listed/deleted both an admin share link and its public token-based fetch — same sequence
regression-checked against SQLite on the same build (lighter on data-dependent assertions there, since
the image has no `sqlite3` CLI for direct seeding, but every route's success and 404 paths confirmed
identical).

## Progress (Round 86)

Converted `routes/collections.ts` (all 9 routes, including the smart-filter query builder and the
item-position reorder transaction) and `routes/tracks.ts` (both routes, including its track-list
upsert transaction).

**New pattern handled**: `collections.ts` used SQLite's `datetime('now', ?)` modifier syntax at the
query level for its `addedAfterDays` smart-filter condition — flagged back in Round 79's SQL-
portability audit as needing a per-call-site rewrite, not a generic wrapper translation. Added
`nowOffsetExpr(db, days)` to `asyncDb.ts` (alongside the existing `nowExpr`), which returns
`datetime('now', 'N days')` on SQLite or `to_char((now() AT TIME ZONE 'UTC') + interval 'N days', ...)`
on Postgres — the same 4 other files flagged in that audit (`system.ts`, `recycleBin.ts`,
`scheduler.ts`, `storageForecast.ts`) can reuse this helper when they're converted.

Also found and fixed two more instances of known bug classes from earlier rounds while converting
this batch:
- `collections.ts`'s list route aliased `COUNT(ci.media_item_id) AS itemCount` unquoted — Postgres
  folds it to lowercase, so `r.itemCount` would read as `undefined`. Fixed by quoting the alias
  (`AS "itemCount"`), the same class of bug caught in Round 80.
- The same route also read that `COUNT(...)` result as `r.itemCount` directly — Postgres's driver
  returns `bigint` aggregates as strings, so this rendered as `"itemCount":"0"` (a string) instead of
  a number. Fixed by wrapping in `Number(...)`, the same fix `libraryGroups.ts`'s `groupCounts()`
  needed in Round 84 for its own `COUNT`/`SUM` results.
- `collections.ts`'s "add item" route used SQLite's `INSERT OR IGNORE` syntax, which Postgres doesn't
  support at all (not just a folding/type issue — a hard syntax error). Switched to a
  dialect-conditional statement: `INSERT ... ON CONFLICT DO NOTHING` on Postgres, the original `INSERT
  OR IGNORE` on SQLite. `media.ts` (not yet converted) has two more call sites using this same
  SQLite-only syntax to handle when it's converted.

**Deliberately NOT converted this round**: `routes/recycleBin.ts`, `services/recycleBin.ts`,
`routes/corruptMediaReview.ts`, and `services/corruptMediaCheck.ts`. All four are entangled with each
other (`corruptMediaCheck.ts` calls `recycleFile()` from the recycle-bin service; the recycle-bin
route calls its own service directly) and, more importantly, `recycleFile()` is also called
synchronously — with no `await`, since it isn't async today — from three call sites inside
`routes/media.ts` (947 lines, not yet converted) and one inside `services/archival.ts`. Converting
`recycleFile()`'s DB write to async now would leave those still-synchronous callers firing an
unawaited promise into Postgres, the exact "converted callee reached from an unconverted caller"
failure class first hit with `audit.ts` in Round 80 — except here the caller can't simply be converted
alongside it the way `audit.ts` could, since the callers are still-unconverted, much larger files.
This cluster is deferred to a future round bundled with `media.ts` and `archival.ts`.

Verified live against a real Postgres container (no admin-bootstrap env vars): created a collection,
added movie rows directly via `psql` to exercise real item membership, added/deduped items via the
`ON CONFLICT DO NOTHING` path, reordered them and confirmed the new order round-tripped, exported both
`?format=json` and `?format=m3u` (confirming the m3u path correctly skips a fileless item and reports
the skip count), deleted an item and a collection, created a smart collection with an
`addedAfterDays` filter and confirmed `nowOffsetExpr`'s Postgres interval arithmetic matched the
expected items, and exercised both track routes — same regression sequence repeated against SQLite on
the same build (media-item seeding done differently there, no `psql` equivalent inside the image, but
every route and the `nowOffsetExpr` SQLite branch confirmed working identically).

## Progress (Round 85)

Converted `routes/customFormats.ts` (all 8 routes: list, create, patch, TRaSH-Guides JSON import,
trash-sync trigger, delete, and the two quality-profile-format-score routes) and its backing
`services/trashSync.ts`. The scores PUT route relies on `ON CONFLICT(quality_profile_id,
custom_format_id) DO UPDATE SET score = excluded.score` — ported unchanged, since Postgres supports
the same `ON CONFLICT ... DO UPDATE` upsert syntax as SQLite.

**Deliberately NOT converted**: `services/customFormatScoring.ts`, which scores releases during the
actual search/grab pipeline (called from `search.ts`, `importer.ts`, `upgradeCandidates.ts`,
`scheduler.ts`, and others). Converting it would cascade into that much larger and riskier surface
rather than staying scoped to "custom formats CRUD." Confirmed neither file converted this round
calls into it, so leaving it on the old synchronous `db/client.ts` path creates no
converted-calls-unconverted breakage this round.

Verified live against a real Postgres container (no admin-bootstrap env vars): created, listed,
renamed, and deleted a custom format; set and re-read a quality-profile format score via the upsert
route; ran a real `trash-sync` against the live TRaSH-Guides GitHub repo (234 Radarr formats synced
in, 8 unsupported and reported as such, matching the SQLite-path count exactly) — same regression
sequence repeated against SQLite on the same build, identical results end to end.

## Progress (Round 84)

Converted a batch of 6 smaller, mostly-independent route files plus one service:
`routes/people.ts`, `routes/calendarEvents.ts`, `routes/libraryViews.ts`,
`routes/remoteInstances.ts`, `routes/friendLibraries.ts` (+ its `services/friendLibraries.ts`
backing service), and `routes/libraryGroups.ts` — the last of these carrying the app's `WITH
RECURSIVE` query (the nested-group item-count rollup), the second-most structurally complex query
in the codebase after the transaction-based quality reorder from Round 82. No new translation gaps
found this round — the recursive CTE, the breadcrumb-walking loop (a `while` loop re-querying one
row at a time), and every INSERT/UPDATE/DELETE all ported with just the standard `await` treatment.

Verified live against a real Postgres container: created/listed custom calendar events, a saved
library view, a remote instance, a friend library, and a two-level library group hierarchy (System →
Maker), confirmed the `WITH RECURSIVE` count rollup correctly reports 0 items for a freshly-created
empty group, confirmed the breadcrumb and `isDeepestLevel`/`nextKind` fields on a single-group fetch,
patched and deleted a group, and confirmed `people.ts` fails gracefully (not a crash) when no TMDB
key is configured — same regression sequence repeated against SQLite on the same build.

## Progress (Round 83)

Converted `routes/indexers.ts`, `routes/downloadClients.ts`, and `services/prowlarrSync.ts` (called
by the indexers route, converted alongside it for the same reason `audit.ts` had to be converted
alongside `authRoutes.ts` in Round 80 — an unconverted callee undoes a converted caller).

**New pattern handled**: these two route files use better-sqlite3's named-parameter binding
(`.run({ name: "x", ... })` against SQL with `@name` tokens) for their longer INSERTs — Postgres's
driver has no named-parameter concept at all, only positional `$1, $2, ...`. Extended `asyncDb.ts`
with `translateNamedParams()`, which rewrites `@word` tokens to sequential `$N`s and builds the
matching positional values array, so the 6 files using this style (2 converted so far) don't need
their queries rewritten — just the same `await`/`db/index.js` treatment as everywhere else. Verified
standalone with a small test script before trusting it in the app (repeated-token reuse, and an `@`
inside a string literal being left alone, both confirmed).

**Found and fixed a real, pre-existing bug** (not caused by this migration, just surfaced by testing
more thoroughly than the existing test suite had): `indexers.ts`'s PATCH route bound whatever value
a boolean field (`enabled`, `useFlareSolverr`) arrived as directly, with no `true/false → 1/0`
coercion — unlike `downloadClients.ts`'s own PATCH route, which already had this coercion with a
comment explaining why. Both better-sqlite3 and Postgres reject binding a raw JS boolean to an
INTEGER column, so `PATCH /indexers/:id` with `{"enabled": true}` would have thrown on **either**
backend, not just Postgres — it just never came up before because nothing had tested that exact
input. Fixed in both `indexers.ts` (POST and PATCH) and `downloadClients.ts` (POST, which used
`b.enabled ?? 1` — silently wrong specifically for `enabled: false`, since `??` doesn't treat a real
`false` as nullish).

Verified live against a real Postgres container: created/listed/patched/deleted indexers and
download clients (including the named-parameter INSERTs and the boolean fields on both create and
patch), confirmed `prowlarr-sync` fails gracefully when unconfigured rather than crashing. Regression-
checked the identical sequence — including the exact boolean-edge-case payloads that had been
broken — against SQLite on the same build, confirming the fix (not just the Postgres path) is
correct on both backends.

## Progress (Round 82)

Converted the quality/library config slice: `routes/tags.ts`, `routes/rootFolders.ts`,
`routes/qualities.ts`, `routes/qualityProfiles.ts`, and `services/quality.ts` (the
`qualityRank`/`sizeWithinQualityBounds`/`preferredSizeDistance`/`pickBestAllowedQuality` functions
called synchronously throughout release-parsing/scoring code — converted to the same in-memory-cache
pattern as `settingsStore.ts`, since these are called from deep, hot, synchronous call chains that
would otherwise cascade `await` broadly for no real benefit on a small, read-heavy table).

**Found and fixed a genuinely critical gap**: `db/client.ts`'s SQLite-only first-boot seeding
(default qualities, the "Any" quality profile, and — the important one — generating the instance API
key) had no Postgres equivalent at all. A fresh Postgres-backed install would have booted with zero
qualities, no quality profile, and **no API key ever generated — meaning nobody could authenticate
into a brand-new Postgres install at all**, not even to click through initial setup. Added
`db/postgresSeed.ts` (an async port of that seeding logic, called once from `db/index.ts`'s
`initDb()` right after the schema itself is applied) to close this. Also silenced a confusing side
effect this surfaced: the old SQLite-only seeding still runs even in postgres mode (an unavoidable
consequence of every not-yet-converted file still importing `db/client.ts` directly — see the
"Not done yet" note below), which means it was *also* printing its own "generated AoNarr API key"
banner for a key that lives in the orphaned shadow SQLite database, not the one actually in use —
actively misleading rather than just redundant, since an admin reading it would try the wrong key.
That banner is now suppressed specifically when `AONARR_DATABASE_DRIVER=postgres`.

Verified live end-to-end against a real Postgres container: booted a **completely fresh** database
with no admin-bootstrap env vars set (the harder, more realistic case — most Postgres users
wouldn't set those), confirmed exactly one API key was generated and logged, authenticated with it,
confirmed 15 qualities and the default "Any" profile were seeded, then exercised every converted
route (create/list tags, create/list root folders, the quality-reorder transaction with its
negative-rank staging trick to dodge the UNIQUE constraint) — all correct. Regression-checked the
same sequence against SQLite on the same build.

## Progress (Round 81)

Converted `routes/users.ts` (household account CRUD, per-user library permissions, session listing/
revocation) — the natural next slice after auth itself, since it's the other half of "who can log in
and what can they see." No new patterns or bugs this round; straightforward `await` + `Promise.all`
for the one spot that mapped an array of rows through an async per-row lookup
(`getAllowedTypes`). Verified live against a real Postgres container: create a household user with
library permissions, list users, patch permissions (including the delete-then-reinsert allowed-types
pattern), log in as that user, list active sessions, force-revoke one, delete the user, and confirm
every one of those actions shows up correctly in the audit log — all passed, plus the same sequence
regression-checked against SQLite on the same build.

## Progress (Round 80) — first working vertical slice

Converted the full auth/login/session critical path — the single most connected piece of the app,
since `requireAuth` runs as global middleware on every request — to the async db interface, and
verified the whole thing end to end against a real `postgres:16` container: setup-status, creating
the bootstrap admin account from env vars, login, session-validated requests (`/me`, `/settings`),
logout, session revocation, a failed-login rejection, and the audit log correctly recording it all.
Confirmed zero regression on the same build against SQLite.

**Files converted**: `db/index.ts` (new — the driver dispatcher `initDb()`/`db` everything else
converted now imports instead of `db/client.ts` directly), `services/settingsStore.ts` (see its own
comment for the in-memory-cache design — deliberately kept `getSetting`/`setSetting` synchronous so
their ~101 existing call sites across 24 files don't need to change), `services/auth.ts`,
`middleware/auth.ts`, `services/bootstrapAdmin.ts`, `routes/authRoutes.ts`, `services/audit.ts` (kept
`logAuditEvent` synchronous/fire-and-forget for the same no-cascade reason as settings — see below),
`routes/auditLog.ts`, and one bugfix in `routes/users.ts` (a pre-existing `res.json(listActiveSessions())`
that TypeScript never caught, because `res.json(x: any)` doesn't care that `x` used to be a value and
is now a Promise — this class of bug won't show up as a compile error anywhere in the remaining
conversion, only as wrong runtime output, so each converted file needs someone to actually grep for
its exported functions' other call sites, not just trust `tsc -b` came back clean).

**Two real, previously-unknown bugs the Postgres verification pass caught** (both would have shipped
silently broken if this had gone straight from "compiles" to "looks done"):

1. **A converted file calling into an unconverted one through the *old* SQLite path corrupts data
   silently.** `authRoutes.ts`'s login handler calls `logAuditEvent(...)`, which — before this
   round's fix — still imported the old synchronous `db/client.ts`. In Postgres mode, that import
   still creates and opens a local SQLite file as an orphaned side effect (nothing stops it; every
   unconverted file does this), and audit_log's `user_id` foreign key pointed at that empty
   shadow database's `users` table, which the real user (created in Postgres) doesn't exist in —
   every login crashed with a foreign-key violation. Fixed by converting `audit.ts` too. **This means
   a file can't really be considered "converted and done" in isolation — everything it calls into
   that also touches the DB needs to be checked, or verification needs to exercise the actual
   call chain, not just the one file in question.**
2. **Postgres folds unquoted SQL identifiers to lowercase; SQLite doesn't.** `auditLog.ts`'s query
   aliased columns with plain camelCase (`user_id AS userId`) — on SQLite this returns a `userId`
   key exactly as written; on Postgres, an unquoted `userId` alias comes back as `userid`, silently
   breaking any code (or frontend) expecting camelCase keys. Fixed by quoting every such alias
   (`AS "userId"`). **This is a systemic risk for the rest of the conversion**: this codebase's raw
   SQL uses camelCase aliases extensively (`AS mediaTitle`, `AS hasFile`, `AS mediaItemId`, etc. —
   seen throughout `wanted.ts`, `dashboard.ts`, and others). Every file's conversion needs to audit
   its own queries for this, not just add `await`. A query that aliases to `snake_case` (or doesn't
   alias at all, matching the column's real name) and lets a `db/mappers.ts`-style function do the
   snake→camel conversion in JS — the pattern already used for full table rows — sidesteps this
   entirely and is the safer default for any *new* ad-hoc query, versus hand-quoting each alias.

## Progress (Round 79)

Phase 1 from the plan below ("introduce the abstraction, verify it standalone against a real
engine, don't touch the app yet") is done for PostgreSQL specifically:

- `server/src/db/asyncDb.ts` — the dual-dialect async interface (see its own module comment for
  the full design rationale). **Note: this shipped as a hand-written thin wrapper around raw SQL,
  not Kysely** as originally recommended below — once the SQL-portability audit was actually
  complete (see "What ported for free" below), the gap between "raw SQL + a thin async/placeholder-
  translation shim" and "adopt a query-builder DSL and rewrite 444 call sites into it" turned out to
  be enormous, with the query-builder buying comparatively little given how much of the existing SQL
  already ports unchanged. The Kysely option is still on the table if a future round finds the thin
  wrapper insufficient, but it's no longer the default recommendation.
- `server/src/db/schema.postgres.sql` — mechanical translation of `schema.sql`, committed as a
  static file (not generated at runtime).
- `server/src/db/postgresSchema.ts` — applies that schema plus a Postgres port of every
  `ensureColumn(...)` retrofit currently in `client.ts`, run via `migratePostgresSchema(db)`.
- **Verified against a real `postgres:16` container** (not mocked): schema migration (including
  idempotent re-run), insert with `lastInsertRowid` via `RETURNING id`, select, update, delete, the
  `ON CONFLICT ... DO UPDATE` upsert pattern used throughout the codebase (ported verbatim, ran
  correctly, no duplication on a second upsert), transaction commit, transaction rollback, and the
  one `WITH RECURSIVE` query in the codebase (`library_groups`' nested-count rollup) — all passed.

**What ported for free**, now confirmed rather than assumed: every table's DDL except two textual
substitutions (`AUTOINCREMENT` → `SERIAL`, `datetime('now')` → an explicit UTC-text-formatted
equivalent so `created_at`-style TEXT columns hold identical string shapes on both backends); the
`ON CONFLICT(...) DO UPDATE SET x = excluded.x` pattern used in 14+ places; `WITH RECURSIVE`; plain
positional `?` parameters (translated to `$1, $2, ...` internally by the wrapper, transparent to
callers). None of the 47 `ensureColumn(...)` DDL strings needed any translation either.

**One real bug the Postgres verification pass caught that the earlier static analysis missed**: not
every table has a plain `id` column — `settings` (keyed by `key`), and several join/junction tables
(`media_item_tags`, `quality_profile_format_scores`, `collection_items`, `user_library_access`,
`sessions`, `release_group_stats`) use a composite or different primary key. Blindly appending
`RETURNING id` to every INSERT breaks on those with Postgres error 42703 — and, worse, poisons the
rest of an in-progress transaction if it happens inside one (Postgres aborts the whole transaction
on a statement error; SQLite has no equivalent behavior, so this class of bug is invisible from the
SQLite side entirely). Fixed with a static exception list in `asyncDb.ts`, not a try/catch, because
retrying inside an already-poisoned transaction would just fail again.

**Also confirmed, not yet acted on**: 5 files (`collections.ts`, `system.ts`, `recycleBin.ts`,
`scheduler.ts`, `storageForecast.ts`) use SQLite's `datetime('now', ?)` modifier syntax
(`datetime('now', '-30 days')`) at the query level, not just in schema defaults — this has no direct
Postgres equivalent (`now() - interval '30 days'` is the right shape) and needs a per-call-site
rewrite when those files are converted, not a generic translation the wrapper can do for them.

**Not done yet, as of Round 79**: none of the ~70 application files (routes/services) had been
converted. **As of Round 80** (see above): 9 files converted — the full auth/login/session path,
proven end to end against real Postgres. `AONARR_DATABASE_DRIVER=postgres` now runs a real,
correctly-behaving app for that slice; everything else still imports the old synchronous
`db/client.ts` directly and would still be broken or silently wrong under Postgres (per Round 80's
bug #1 above — an unconverted file a converted one calls into can corrupt data through the orphaned
shadow SQLite database, not just throw a type error). The remaining ~61 files, converted one group
at a time and verified against both backends as each group lands, is the rest of this project.

## The ask

Let users choose PostgreSQL (MariaDB later, as a separate follow-up) as an alternative to AoNarr's
built-in SQLite, the way some self-hosted apps (Nextcloud, Immich, Jellyfin's newer versions) let
you point at an external DB server instead of a local file.

## Why this isn't a bounded feature

Every other item shipped in this project has been additive: a new route, a new table, a new page.
This one is different in kind — it's a foundation swap. The numbers from the current codebase:

- **70 files** call `db.prepare(...)` directly — 37 in `routes/`, 32 in `services/`, 1 in `db/`
- **444 individual `db.prepare()` call sites**
- **40 tables**, 34 foreign keys, 48 ad-hoc `ALTER TABLE ... ADD COLUMN` migrations already
  accumulated in `db/client.ts` (see `ensureColumn()` calls) — one per feature round that added a
  column to an existing table
- **13 files** use `db.transaction(...)` for multi-statement atomicity
- better-sqlite3 is **fully synchronous** — every `.prepare().run()/.get()/.all()` call blocks
  the calling function and returns immediately with a value, no `await` anywhere in the data layer.
  This is why so many routes in this codebase read as straight-line procedural code with no promise
  chains around DB access.

There is no existing abstraction layer. `db` (the raw better-sqlite3 `Database` instance) is
imported directly from `db/client.ts` into every route and service file that touches data. Adding a
second backend isn't "add a config option" — it's introducing an abstraction boundary retroactively
into 70 files that currently have none.

## What specifically breaks going from SQLite to Postgres/MariaDB

1. **Sync → async.** `mysql2`, `mariadb`, and `pg` (the standard Node drivers for the other two) are
   all async. Every one of the 444 call sites becomes `await db.prepare(...)`, which cascades: the
   *calling* function must become `async`, which cascades to *its* caller, and so on up through
   route handlers (already async, fine) but also plain service functions that are currently sync
   and called from other sync functions (not fine — this is the actual size of the blast radius,
   not the 444 call sites themselves).

2. **SQLite-specific SQL used throughout:**
   - `datetime('now')` as a column default (52 uses) — Postgres wants `now()`, MySQL/MariaDB wants
     `NOW()` or `CURRENT_TIMESTAMP`.
   - `INSERT ... ON CONFLICT(col) DO UPDATE SET x = excluded.x` (14 uses) — this exact syntax is
     valid Postgres too (lucky), but MariaDB/MySQL requires `ON DUPLICATE KEY UPDATE x = VALUES(x)`,
     a different clause entirely. This alone makes MariaDB strictly more work than Postgres.
   - `INTEGER PRIMARY KEY AUTOINCREMENT` (33 uses, i.e. nearly every table) — Postgres wants
     `SERIAL`/`GENERATED ALWAYS AS IDENTITY`, MariaDB wants `AUTO_INCREMENT`.
   - `PRAGMA table_info(table)` (used by the migration helpers in `db/client.ts` to introspect
     columns) has no equivalent; both alternatives use `information_schema.columns` instead.
   - `WITH RECURSIVE` (1 use, `library_groups`' nested-group rollup) — supported by both Postgres
     and MariaDB 10.2+/MySQL 8+, so this one's actually low-risk.
   - SQLite's dynamic typing means TEXT columns routinely hold JSON blobs (`external_ids`,
     `media_info`, `extra_metadata`, `config`, dozens more) parsed with `JSON.parse()` in JS.
     Postgres has a real `jsonb` type that would be the correct target; MariaDB has `JSON` (stored
     as `LONGTEXT` under the hood, so closer to what SQLite already does). Neither is a blocker,
     but it's a real design decision, not a mechanical port.

3. **The migration system itself is SQLite-specific.** `db/client.ts`'s `ensureColumn()` helper
   (`ALTER TABLE ... ADD COLUMN`, called 48 times) happens to be valid syntax on all three engines
   for simple additive columns, so that part actually ports cleanly. The harder part is the
   handful of *structural* migrations already in that file — `dropCheckConstraint()` and
   `repairDanglingReference()` rebuild a table from scratch (`RENAME TO ..._pre_migration`,
   recreate, copy rows, drop) because SQLite can't drop/alter a CHECK constraint or a foreign key
   in place. Postgres and MariaDB *can* (`ALTER TABLE ... DROP CONSTRAINT`, `ALTER TABLE ...
   MODIFY`), so these would need engine-specific rewrites rather than being reused as-is — but
   they're only 3 call sites, not 48.

4. **Every route currently trusts SQLite's implicit single-writer serialization.** Because
   better-sqlite3 runs in-process and synchronously, two "check then insert" statements back to
   back (common pattern: `SELECT ... WHERE title = ?` to check for a duplicate, then `INSERT`) are
   safe from races *by accident* — nothing else can interleave between them because nothing else is
   running. A real client-server DB with concurrent connections doesn't have that guarantee; those
   patterns need either an explicit transaction or a unique constraint + conflict handling to stay
   correct. This is the least visible risk in the whole migration — it won't show up as a compile
   error or even a test failure, only as an occasional duplicate row under real concurrent load.

## Options considered

**A. Query builder with multi-dialect support (Kysely, Knex).** Write SQL-ish TypeScript, the
library translates to each engine's dialect and abstracts the driver's async API. Still requires
touching every one of the 444 call sites and adding `await` up the call chain, but removes the need
to hand-write three versions of every query. Kysely in particular is fully typed and has clean
Postgres/MySQL/SQLite dialects. **This is the realistic option** if the goal is genuinely supporting
three backends long-term.

**B. Full ORM (Prisma, Drizzle).** Bigger rewrite than a query builder — schema gets redefined in
the ORM's own schema language, which then generates migrations, rather than hand-written SQL. More
upfront work than A, but better long-term ergonomics and built-in migration tooling (which this
project currently does by hand in `client.ts`, accumulating `ensureColumn()` calls). Drizzle is the
closer fit of the two (schema-as-TypeScript, keeps hand-written SQL as an escape hatch, decent
SQLite/Postgres/MySQL support); Prisma's query engine has historically been the heavier runtime cost
for a self-hosted single-binary-style app like this one.

**C. Thin custom repository layer, hand-write three dialects.** Wrap the ~40 tables' worth of
queries behind functions, implement each function three times (or with light templating) per
engine. More total code than A or B, all of it hand-maintained, but no new dependency and full
control. Given 444 call sites already exist as ad-hoc SQL, this is really "option A without the
library" — more work for no compensating benefit.

**D. Don't migrate the query layer at all — offer PostgreSQL-compatible export/import instead of
live dual-backend support.** Keep SQLite as the only *runtime* engine, but let a user export the
whole DB in a Postgres-loadable form (this is roughly what `pg_dump`-style tools do, or what a
one-way ETL job would do) for people who want their data queryable from an external BI tool, backup
system, etc. — without AoNarr itself ever running against anything but SQLite. Far less work, but
doesn't satisfy "let users choose MariaDB/Postgres as AoNarr's own database," which is what was
actually asked for.

## Recommendation

**Thin hand-written async wrapper (not Kysely — see "Progress" above for why that changed),
PostgreSQL only for now, MariaDB deferred as a separate later phase.**

- Postgres over MariaDB as the first (and for now, only) alternative target because the
  `ON CONFLICT ... DO UPDATE` syntax already used throughout the codebase is valid Postgres syntax
  verbatim — one whole category of the port (14+ call sites, likely more as the schema grows) is
  close to free. MariaDB's `ON DUPLICATE KEY UPDATE` is a genuinely different clause shape and would
  need every one of those sites rewritten with different logic, not just swapped syntax.
- SQLite stays the default and the only backend the Unraid Community Applications template assumes
  — this is an opt-in advanced setting for people who already run a Postgres server, not a
  requirement for anyone else. Nothing about the existing single-file-DB deployment story changes
  for the overwhelming majority of users.

## If pursued, suggested phasing

1. **Introduce the abstraction with zero behavior change.** ~~Swap `db/client.ts`'s raw
   better-sqlite3 export for a Kysely instance~~ — superseded, see "Progress" above:
   `server/src/db/asyncDb.ts` now provides the same async-shaped interface over hand-written SQL
   instead. Verified standalone against a real Postgres instance (done, Round 79). Converting the
   ~70 application files to actually use it — each still running against SQLite the whole time via
   this same interface — is the remaining, much larger part of this phase; not started. This is
   where the "add `await` up the call chain" cascade gets found and fixed, one file at a time,
   without also debugging a new database engine at the same time.
2. **Wire the Postgres path into the running app** once phase 1's file-by-file conversion is
   complete — an `AONARR_DATABASE_DRIVER=postgres` config value already exists (see config.ts) but
   doesn't yet produce a working app, since most routes still bypass the new abstraction entirely.
   Audit the "implicit serialization" risk (point 4 further up) as part of this — every
   check-then-insert pattern needs a real look, since Postgres will actually surface races SQLite
   never could.
3. **Live-verify a full round-trip on Postgres**: every route this project has, exercised against a
   real `postgres:16` container the same way every other feature in this project has been verified
   against a real running instance — not just "the query compiles."
4. **MariaDB as a follow-up phase**, once Postgres is solid and shipped — reusing the abstraction
   from phase 1, but redoing every `ON CONFLICT` site with `ON DUPLICATE KEY UPDATE` semantics, and
   auditing the two Postgres-specific choices already made (`RETURNING id` for lastInsertRowid,
   which MySQL/MariaDB gets natively via `insertId` instead; the UTC-text `datetime('now')`
   replacement, which needs MariaDB's own equivalent).

## Rough effort shape

Not a time estimate (this project's rounds don't map to calendar time), but a shape: phase 1 alone
is comparable in size to every round shipped in this project *combined* — it touches 70 files, not
one feature's worth. Phases 2–4 are each smaller than phase 1 individually, but assume phase 1 is
completely done and stable first; none of them are safe to start concurrently with it.

## Explicit non-goals

- **No live migration tool** (moving an existing SQLite install's data into Postgres/MariaDB) is
  assumed as part of this scope unless separately requested — this document only covers *supporting*
  an external DB as a fresh choice, not converting an existing installation's data.
- **Not** attempting to support all three engines simultaneously in one release — SQLite stays
  default throughout every phase above; Postgres is additive; MariaDB is a later, separate addition.
- **Not** in scope: connection pooling tuning, HA/replication setup, or anything about how the user
  runs their own Postgres/MariaDB server — that's entirely the user's infrastructure, same as how
  AoNarr doesn't manage the user's download client or media server today.

## Decision (resolved)

Commit to this; PostgreSQL first, MariaDB deferred as a separate later phase — decided by the user
after this document's original scoping pass. Foundation work started the same round (see
"Progress" above). Remaining rounds convert the ~70 application files one at a time.
