# AoNarr

**AoNarr** combines the core functionality of the *Starr* app family — Sonarr (TV), Radarr
(movies), Lidarr (music), Readarr (books), Prowlarr (indexers), Bazarr (subtitles), and Whisparr
(adult) — plus equivalents for ROMs, comics, online videos, and courses, into a single
self-hosted application, built for Unraid.

Instead of running a container per media type, AoNarr gives you **10 libraries** — Movies, TV
Shows, Anime, Music, Books, Comics, ROMs, Online Videos, Courses, and Adult — in one unified app,
one place to configure indexers (Torznab/Newznab), one place to configure download clients, and
one scheduler that drives metadata-aware, quality-aware searches, grabs, imports, and
notifications across all of them.

> **Status:** feature-complete for everything scoped so far. Every library type is driven by a
> central config (`services/mediaTypes.ts`) rather than hardcoded per-type logic, so the
> scheduler, importer, indexer category mapping, and naming templates all generalize across all
> 10 libraries automatically. Add media from any of 15 metadata search providers (plus Fanart.tv
> for artwork), tag and organize the library, browse what's missing/upcoming, search indexers
> with AND/OR/NOT custom-format scoring across title/size/language/release-group conditions
> against a quality ladder you can reorder, rename, and size-bound, grab, auto-import (season
> packs and multi-track albums included) into your library folders using naming templates you
> control, fetch subtitles, get notified across five providers, or step in and manually
> import/fix anything that didn't auto-match. Beyond matching individual *Starr apps, AoNarr adds
> things no single one of them can: search across every library at once, optional collections that
> span library types, household accounts with per-library read access and a request queue (with
> per-user request limits and optional auto-approval), a health dashboard that rolls up every
> subsystem (indexer reachability, stuck queue items, repeated-import/upgrade tracking), an
> admin-only audit log of logins/requests/account changes, watch-status auto-archival against
> Plex/Jellyfin/Emby to reclaim space automatically, a release blocklist so a bad grab is never
> re-suggested, Trakt list/watchlist sync, TMDB/Last.fm-powered recommendations, one-click DB
> backup/restore, and an installable PWA with Web Push notifications. Indexers aren't limited to
> Torznab/Newznab either — a generic JSON-API (DDL) adapter and a plain-RSS adapter let you point
> AoNarr at any search source that returns one of those shapes, and Online Videos can be grabbed
> directly via a built-in yt-dlp download client, no indexer involved at all. Bulk actions
> (monitor/unmonitor/tag/search) cover the Library and Missing pages, a unified Activity timeline
> merges every grab/import/failure/archival/request event into one feed, downloaded files below
> their profile's current cutoff are flagged as upgrade candidates, disk space is trended into a
> days-until-full estimate, collections can be manually ordered and exported as an M3U playlist or
> a plain watch-order list, tags/collections can override the instance-wide archival retention
> (including "never archive"), quality-profile/custom-format/naming config can be exported and
> imported as a portable template, and the admin web login can require an optional TOTP
> authenticator code as a second step. Operationally: both containers have a real Docker
> `HEALTHCHECK`, failed-credential attempts are rate-limited per IP with a lockout, the last 500
> log lines are viewable from the System page, and `/api/metrics` exposes Prometheus-format
> metrics. Also: a daily quiet-hours window can pause auto-search, adding a title that looks like
> it's already in the library asks for confirmation first, an IMDb/Letterboxd/Trakt watchlist CSV
> export can be bulk-imported, the release calendar has a subscribable `.ics` feed, the UI has a
> light/dark theme toggle, and notification message text is template-customizable per event.
> Admin API-key gated like the real Starr apps, plus session-token auth for restricted household
> accounts. A home Dashboard (Recently Added, Recently Watched, Upcoming) is now the default
> landing page, with Library moved to `/library`. A failed grab automatically retries the next-best
> release before giving up, files are probed with `ffprobe` after import for real codec/resolution
> info, and Ctrl/Cmd+K opens a jump-to-page command palette from anywhere. Verified across sixteen
> rounds with `docker compose build` + live runs (see [Verification](#verification)). A self-hosted
> Swagger UI at `/api-docs` documents the core API, and a "What's New" page renders `CHANGELOG.md`
> in-app.
> Still open: Fanart.tv artwork is only wired up for Movies/TV/Music (the three types it can
> actually look up by id), and Courses has no metadata provider at all (no public course-catalog
> search API exists) — see [Architecture](#architecture).

## Libraries

| Library | Type key | Shape | Metadata providers |
|---|---|---|---|
| Movies | `movie` | single file | TMDB, OMDb, Trakt |
| TV Shows | `series` | seasons/episodes | TMDB, TVDB, TVmaze, Trakt |
| Anime | `anime` | seasons/episodes | AniList, TVDB, TMDB |
| Music | `artist` | albums (multi-file) | MusicBrainz, Deezer, Discogs, Last.fm |
| Books | `author` | books | Open Library, Google Books |
| Comics | `comic` | issues | Comic Vine |
| ROMs | `rom` | single file | RAWG, IGDB |
| Online Videos | `video` | channel videos | YouTube Data API |
| Courses | `course` | lessons | *(manual only — no viable public search API)* |
| Adult | `adult` | single file | ThePornDB *(the same source [Whisparr](https://github.com/Whisparr/Whisparr) uses)* |

"Shape" is the structural pattern a library follows, and it's what the scheduler/importer/naming
logic actually branches on — not the specific type. Adding an 11th library is a config entry in
`services/mediaTypes.ts`, not new branching logic scattered through the codebase.

## Features

- **10 libraries on 3 shapes** — single-file items (Movies, ROMs, Adult), episodic items with
  season/episode children (TV Shows, Anime), and collections of named children (Music albums,
  Books, Comics issues, Online Video uploads, Course lessons). Every library shares the same
  monitoring/quality-profile/tagging model regardless of shape.
- **Metadata lookup** (add-media search) — 15 search providers across the 9 searchable library
  types (Courses is manual-only), picked per search or defaulted per type in Settings. MusicBrainz,
  Open Library, Deezer, TVmaze, and AniList need no key. Selecting a result auto-populates
  poster/overview/external IDs and, for episodic/collection types, eagerly fetches and inserts the
  full episode/album/book/issue/video list from whichever provider it came from.
- **Artwork enrichment via Fanart.tv** — Fanart.tv only supports lookup-by-known-id, not
  title search, so it isn't offered as an Add Media provider; instead, a media item's page (movies,
  series, artists) has an "Artwork" picker that fetches poster options using the TMDB/TVDB/
  MusicBrainz id already on the item and lets you pick one.
- **Indexer management** (Prowlarr-style) — add any Torznab, Newznab, plain RSS feed, or generic
  JSON API (DDL) source once; searches fan out to all enabled indexers for the relevant media
  category. The DDL adapter is a real generic client, not a scraper or a specific-site
  integration: you give it a search URL template and a dot-path field mapping (title/size/
  download URL/seeders/publish date) describing whatever shape that particular API's JSON
  response happens to be, and AoNarr reads it — it never scrapes HTML or hardcodes a site.
- **Direct-download + yt-dlp download clients** — alongside qBittorrent/SABnzbd, a "Direct HTTP
  download" client type lets AoNarr grab a DDL/RSS result's URL itself with no external client at
  all, and a "yt-dlp" client type grabs Online Videos (YouTube, etc.) directly by video id — both
  feed the same queue/import pipeline as any torrent/usenet grab. The scheduler picks whichever
  configured client actually matches a result's protocol instead of grabbing blindly, so
  torrent/usenet/http clients can all be configured side by side safely.
- **Release parsing + quality-aware grabbing** — release titles are parsed for
  season/episode/season-pack/quality; search results are ranked against each item's quality
  profile (allowed qualities + cutoff) before auto-grabbing, and annotated in the manual search
  UI too. Downloaded quality is tracked per movie/episode/album/book and shown as badges.
- **Download client integration** — qBittorrent and SABnzbd, grabbed automatically or manually
  per release, per episode/album/book.
- **Automatic import**, season packs included — once a download completes, AoNarr matches it
  back to the right file(s) in your downloads folder (fuzzy title + season/episode match), moves
  and renames into the item's root folder using Sonarr/Radarr-style naming, and marks it
  downloaded. A season-pack folder with several episodes correctly splits across each episode's
  own queue entry instead of colliding.
- **Manual import** — browse the downloads folder from a media item's page and assign any file
  to it (or a specific episode/album/book) yourself, for anything auto-match couldn't resolve.
- **Calendar** and **Missing** views — upcoming episode/album/book release dates, and everything
  monitored across the library that doesn't have a file yet.
- **Subtitle search + auto-download** (Bazarr-style) — OpenSubtitles-backed; once a video file is
  imported, AoNarr automatically fetches and saves a matching subtitle if a provider is
  configured.
- **Notifications** — Discord, Slack, Telegram, Pushover, and generic webhook support for
  grabbed/imported/failed events, configured once in Settings.
- **API key authentication** — like every Starr app, the REST API (and the web UI, which is just
  a client of it) requires an API key, generated automatically on first boot.
- **System status page** — version, library counts, active queue size, and free/total disk space
  per root folder.
- **Tags** — create tags, assign them to any media item, and filter the library by tag.
- **Custom format scoring with AND/OR/NOT conditions across title, size, language, and release
  group** — define named formats made of condition groups (OR'd within a group, AND'd together,
  each negatable) of four kinds: title regex, release-size-range, detected audio language
  (parsed from tags like MULTi/FRENCH/GERMAN), or the parsed trailing release-group tag — e.g.
  "(REMUX or BluRay) and not x265 and 4000-15000 MB and not French and (RARBG or EVO)". Grabbing
  ranks releases by quality first, then custom-format score, and can reject anything below a
  profile's minimum score — visible as a "Format score" column (plus a size-mismatch flag) in
  manual search too.
- **Size-based quality validation** — quality definitions can carry a min/max size in MB; a
  release parsed as that quality but outside its size range (a common tell for mislabeled or fake
  releases) is rejected before grabbing and flagged in manual search.
- **In-UI renaming templates** — every library's naming pattern is editable in Settings using
  `{token}` / `{token:00}` placeholders (`{title}`/`{year}` for single-file libraries,
  `{parentTitle}`/`{season:00}`/`{episode:00}` for episodic, `{parentTitle}`/`{childTitle}` for
  collections), defaulting to a sensible per-shape template rather than being hardcoded per type.
- **Track-level album detail** — expanding an album on an artist's page lazily fetches its full
  track list from whichever provider it came from (MusicBrainz or Deezer; cached after the first
  fetch); importing a multi-track album download moves every track file into the album folder and
  matches each to its track by number.
- **Editable quality ladder** — the resolution/source ranking (SD → Remux-2160p) used for
  upgrades and cutoffs is a reorderable, renameable list in Settings, not a hardcoded array.
- **Quality profiles & root folders** — pick allowed qualities from that ladder, a cutoff, a
  minimum custom-format score, and where each media type's files live on disk.
- **Scheduler** — periodic per-episode/album/book auto-search, download-client queue polling,
  and auto-import, plus a queue/activity view.
- **Single web UI** — one React app for library (filterable by type and tag), add-media search,
  calendar, missing, indexers, download clients, settings (root folders, quality profiles, custom
  formats, naming, tags, metadata/notification/security keys), activity/queue, and system status.
- **Global search** — one search box fans out across every library's items plus their
  episodes/albums/issues/etc. in a single query, deduped and ranked — something no individual
  Starr app can offer since each only knows its own media type.
- **Optional collections** — cross-library groupings (a movie, its comic tie-in, and its
  soundtrack album, all in one place) that any media item can join or skip; nothing requires
  membership in one.
- **Multi-user accounts** — the admin keeps the instance-wide API key; household accounts get a
  username/password, sign in with a session token, and see only the libraries an admin explicitly
  grants them (read-only browsing, no settings/indexers/admin pages).
- **Request portal** — restricted users request media for a library they have access to; admins
  review a queue and approve (which creates the real library entry via the same pipeline as adding
  it manually) or reject.
- **Unified health dashboard** — indexer reachability checks, queue items stuck longer than 6
  hours, a pending-request count, and an opt-in orphaned-file scan across root folders, all on the
  System page.
- **Watch-status auto-archival** — connect Plex, Jellyfin, or Emby in Settings; once something has
  been watched and sits untouched past a configurable retention window, AoNarr moves its file to
  an archive folder (the default, reversible) or deletes it outright (explicit opt-in only).
  Per-item "Protect from archival" always exempts it. Runs on a schedule or on demand from System.
- **Release blocklist** — blocklist a specific release from a media item's search results (or a
  manual grab attempt) so it's never auto-grabbed or shown as grabbable again for that item;
  managed centrally in Settings.
- **Recommendations** — "because you added X" suggestions for movies/TV (via TMDB's
  recommendations endpoint, reusing the tmdb id already on each library item) and music (via
  Last.fm's similar-artist endpoint), sourced from your 5 most recently added items per type, with
  a one-click Add.
- **Trakt list sync** — point Settings at any public Trakt list or watchlist URL; AoNarr adds
  anything new in it as a monitored movie or TV show (episodes fetched the same way any other
  series import does) every 12 hours, or on demand from System. Never removes items the list no
  longer has.
- **Duplicate/upgrade detection** — the health dashboard surfaces media/episodes/albums imported
  more than once, with their full quality history, so a rising-quality sequence (a normal upgrade)
  is easy to tell apart from the same quality grabbed twice (a wasted duplicate worth cleaning up).
- **Per-user request limits and auto-approval** — cap how many pending requests a household
  account can have outstanding at once, or flag an account as auto-approved so their requests skip
  the review queue and land in the library immediately.
- **Audit log** — every login (successful or failed), request submission/approval/rejection, and
  admin action on a user account is logged with who/what/when, visible only to admins.
- **Backup & restore** — one-click download of a consistent DB snapshot (library, settings,
  indexers, users — everything except files on disk) from System, and restore from an uploaded
  one; the database in place just before a restore is always kept as a `.pre-restore` copy, and
  restoring restarts the app to swap the file in safely.
- **Installable PWA with Web Push** — a manifest + service worker make AoNarr installable to a
  phone/desktop home screen; an "Enable notifications" toggle in the sidebar subscribes the
  browser to Web Push so grab/import/failure events (and, for a requester, their own
  approved/rejected requests) arrive as real push notifications, not just in-app.
- **Indexer search caching + per-indexer timeout** — repeated auto-search cycles for the same
  query reuse a 5-minute-TTL in-memory cache instead of re-hitting every indexer (manual searches
  from the UI always bypass it for a live result); every indexer request now carries a 20s hard
  timeout so one slow/hanging source can't stall the whole fan-out.
- **Incremental orphaned-file scanning** — repeat scans skip any directory whose mtime hasn't
  changed since the last scan (adding/removing a file always bumps a directory's own mtime),
  making repeat scans of a large, mostly-static library fast; `?full=1` forces a complete walk.
- **Ordered, exportable collections** — reorder a collection's items (Up/Down, persisted) and
  export it as an M3U playlist (items without a downloaded file are skipped and counted) or a
  plain ordered watch-list JSON.
- **Unified activity timeline** — grabs, imports, failures, auto-archival, and request
  submissions/approvals/rejections merged into one chronological feed on the Activity page,
  instead of checking Activity/Requests/System separately.
- **Upgrade candidates** — the health dashboard flags anything downloaded below its quality
  profile's *current* cutoff — profiles can change after a file was already imported, and nothing
  revisits old downloads automatically otherwise.
- **Storage forecasting** — daily free-space samples per root folder (retained 90 days) trend
  into an estimated "days until full" shown on the System page's disk space table.
- **Bulk actions** — multi-select in Library (monitor/unmonitor, tag, search) and Missing (search)
  instead of acting on one item at a time; bulk search reuses the same search-and-grab logic as
  the scheduler's own auto-search, scoped to exactly the selected targets.
- **Config template import/export** — the quality ladder, quality profiles, custom formats + their
  per-profile scores, and naming templates export as one portable JSON bundle (deliberately
  excluding anything instance-specific — API keys, indexers, download clients, root folders,
  users) for sharing a setup or reusing it on another AoNarr instance; re-importing updates
  existing entries by name rather than duplicating them.
- **Optional TOTP two-factor login** — an authenticator-app code as a second step on the admin web
  login, on top of the API key. This gates the web UI's login screen only — the API key remains
  the actual per-request credential for every API call, the same way a real Starr app works.
- **Per-tag/collection archival retention** — a tag or collection can override the instance-wide
  auto-archival retention for every item it's applied to, including "never archive"; when more
  than one override applies to the same item, the most protective one wins.
- **Login rate-limiting** — failed admin API key, household login, and TOTP attempts are throttled
  per IP (10 failures → 15-minute lockout); a wrong guess against one credential type doesn't
  reset a different type's counter, and a successful auth clears it immediately.
- **Docker healthchecks** — both containers ship a real `HEALTHCHECK` (the server hits
  `/api/health`, the web container fetches `/`), so `docker ps` / Unraid's UI actually reflects
  whether the app is serving traffic, not just whether the process is running.
- **In-app log viewer** — the last 500 log lines (info/warn/error) are viewable from the System
  page, the same content as `docker compose logs aonarr-server` without needing shell access.
- **Prometheus `/metrics`** — library counts, queue depth by status, indexer/download-client
  counts, pending requests, repeated-imports/upgrade-candidate counts, and per-root-folder disk
  space in Prometheus text-exposition format; deliberately unauthenticated like `/health`, same
  reasoning as any `/metrics` endpoint.
- **Duplicate-on-add confirmation** — adding a title (manually or via metadata search) that
  normalized-title-matches something already in that library asks for confirmation instead of
  silently creating a second copy; a `confirmDuplicate` flag bypasses the check once the user's
  actually sure.
- **Quiet hours** — a daily time window (handles overnight wraparound, e.g. 22:00–06:00) during
  which the scheduler's auto-search cycle skips itself entirely; manual searches/grabs are
  unaffected.
- **Watchlist CSV import** — bulk-import an IMDb "Your Watchlist" export, a Letterboxd
  `watchlist.csv`, or a Trakt CSV export; each row is metadata-searched and the top match added as
  monitored, with duplicates and no-match rows skipped and reported rather than guessed at.
- **Subscribable release calendar** — a `.ics` feed of upcoming episode/album/book release dates
  for Google/Apple/Outlook Calendar's "subscribe by URL," gated by a dedicated token (not the
  admin API key) since calendar apps can't send custom headers.
- **Light/dark theme** — a sidebar toggle switches the whole UI's color scheme, persisted in
  `localStorage` and applied before first paint to avoid a flash of the wrong theme.
- **Customizable notification templates** — override the `{token}`-based message text sent for
  grabbed/imported/failed events per provider, instead of the fixed built-in wording.
- **Season-level monitor toggle** — a TV/Anime series' Episodes list is now grouped by season with
  "Monitor season"/"Unmonitor season" buttons, bulk-updating every episode in that season instead
  of clicking through them one at a time.
- **Multiple root folders per type with auto-selection** — a media type isn't limited to one root
  folder; when adding media without picking one explicitly, AoNarr auto-selects whichever
  configured folder for that type currently has the most free disk space (checked live via
  `statfs`, not the daily storage-forecast samples). Free/total space is shown next to each folder
  in both Settings and Add Media's folder dropdown.
- **NFO metadata import** — reads a Kodi/Jellyfin-style `.nfo` sidecar file (movie.nfo, tvshow.nfo,
  etc.) from the downloads directory and prefills Add Media's title/year/overview/poster/external
  IDs from it, as an alternative to a live metadata-provider search.
- **Active session list + revoke** — Users page lists every currently-active household session
  (user, last-active time, sign-in time, device/browser user agent) with a one-click Revoke that
  force-logs-out that device immediately.
- **Scheduled automatic backups** — optionally configure a backup directory, interval (hours), and
  keep-count in System; an hourly check writes a new timestamped DB snapshot once the interval has
  elapsed and rotates out the oldest backups beyond the keep-count. Separate from the existing
  one-click manual backup/restore.
- **CSV export of library** — an admin-only "Export CSV" button on the Library page (respecting the
  current type filter) and `GET /api/media/export.csv` download a flat CSV of the library for
  spreadsheet tracking outside the app.
- **Home dashboard** — a new landing page (Library moved to `/library`) with Recently Added,
  Recently Watched (cross-referenced against the configured Plex/Jellyfin/Emby "watched" list, the
  same source auto-archival uses), and Upcoming (next 14 days, reusing the calendar's data) widgets.
- **Additional subtitle providers** — alongside OpenSubtitles, a "Custom (JSON API)" provider type
  lets you point subtitle search at any API you have legitimate access to (search URL template +
  dot-path field mapping for the results array, download URL, language, and release name — the
  same generic pattern as the DDL indexer adapter). Deliberately doesn't ship scrapers for sites
  without a public API (e.g. Subscene, Addic7ed) since that would mean bypassing their terms of
  service; Custom is the supported way to add a provider AoNarr doesn't know about ahead of time.
- **ffprobe media info** — after import, video/audio files are probed with `ffprobe` for their
  real codec/resolution/bitrate/audio channels (shown next to the quality badge on a media item's
  page and its episode/sub-item rows) — the parsed release-title "quality" is a naming-convention
  guess, this reads the file itself, catching mislabeled or fake releases after the fact.
- **Automatic failed-grab retry** — a failed download (client-reported failure, or an import that
  couldn't place the file) blocklists that specific release and automatically tries the next-best
  result for the same target, up to 2 retries, before falling back to the usual failure
  notification; the Activity queue shows a "retry N" badge on anything that needed one.
- **FlareSolverr indexer proxy** — a global FlareSolverr URL in Settings plus a per-indexer
  toggle routes Torznab/Newznab/RSS requests through a running
  [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance for indexers behind
  Cloudflare/bot-detection that would otherwise return a challenge page instead of results.
- **Import exclusions** — a "never add this again" list; search results in Add Media show
  excluded titles dimmed, and Trakt sync / Recommendations skip them silently. Matches by external
  id when available, falling back to normalized title (+ year). Managed in Settings; Recommendations
  has a one-click "Not interested" that adds the exclusion directly.
- **Custom script on events** — alongside the webhook/bot notification providers, an optional
  admin-configured local script runs on the same grab/import/failure events, invoked directly (no
  shell) with event data as `AONARR_*` environment variables — the same idea as Sonarr/Radarr's
  "Custom Script" connection, for automation a webhook alone can't cover.
- **Bulk cleanup suggestions** — on-demand (never automatic) System page report of unmonitored
  library items with no downloaded file (safe to delete outright, with one-click bulk delete) and
  files that are very likely byte-identical across different library entries (same size + matching
  content sample) — usually a stale re-import left behind after a naming template change.
- **Per-user request stats** — the Users page shows each household account's total/pending/
  approved/rejected request counts, approval rate, and the actual on-disk storage attributable to
  their approved requests (computed by statting the real files, not a maintained running total);
  household users see their own summary on the Requests page.
- **Keyboard shortcuts + command palette** — Ctrl/Cmd+K opens a fuzzy-filterable jump-to-page
  palette (arrow keys + Enter, or click); `/` from anywhere not already typing in a field jumps
  straight to Search. Both restricted to the pages a given user (admin or household) actually has.
- **Scene-name fallback search** — when a search returns zero results, a few common scene-release
  title normalizations (punctuation stripped, "and"/"&" swapped, leading article dropped,
  dot-separated) are tried in turn before giving up — release groups often drop punctuation
  entirely, which an exact/near-match indexer can otherwise miss on the literal title.
- **Request notes** — a household user can attach a short note to a request ("need this by
  Friday"); admins see it in the review queue next to the title instead of a bare request.
- **Media server webhook receiver** — paste a generated URL into Plex's Settings → Webhooks (or
  Jellyfin/Emby's Webhook plugin) and a "recently watched" item shows up on the Dashboard
  immediately instead of waiting for the next scheduled poll; supports Plex's `media.scrobble`
  event and Jellyfin/Emby-style `PlaybackStop` JSON, matched to a library file the same way
  auto-archival's poller already does.
- **Self-hosted API docs** — Swagger UI at `/api-docs`, served from `GET /api/openapi.json`
  (no external CDN), covering the core resources for anyone scripting against AoNarr directly.
- **Download queue reordering** — a "Prioritize" action on a queued/downloading item calls through
  to qBittorrent's `topPrio` or SABnzbd's force-priority, for the download clients that actually
  have a real queue to reorder.
- **Parental/content rating controls** — set a movie/show's rating (MPAA or TV Parental
  Guidelines, one combined scale) and cap a household account at a maximum rating; anything above
  it is hidden from that account's library list, detail page, and global search. Unrated items are
  never blocked, since there's no reliable signal to block on.
- **Torrent client health** — seed ratio, upload/download totals, and ratio-limit warnings
  surfaced from qBittorrent on the Download Clients page (usenet clients have no equivalent
  concept, so this only appears for qBittorrent).
- **Remote backup destination** — scheduled backups can optionally also upload to an S3-compatible
  bucket (AWS S3, MinIO, Backblaze B2, via an optional custom endpoint), rotated the same way as
  the local copies.
- **In-app changelog** — a "What's New" page rendering `CHANGELOG.md` for anyone, not just admins.
- **Saved/recent searches** — Global Search remembers your last 8 queries (per browser) for
  one-click re-run.
- **Actor/cast browsing** — a movie/show's Cast section (TMDB credits) links to a person page with
  their bio and filmography, cross-referenced against the library so items you already have link
  straight through.
- **Multi-instance federation** — add another AoNarr instance's URL + API key and browse its
  library read-only from a dedicated page; nothing can be added, edited, or grabbed remotely, it's
  purely a window into that instance's own library, for households running separate instances per
  location.
- **Smart collections** — a collection can be a live saved filter (type/monitored/file-status/
  added-within-N-days) re-evaluated on every view instead of a fixed membership list; membership
  can't be manually edited on a smart collection since it's computed, not stored.
- **Release-group reputation** — every import records a success for its release group, every
  auto-retried failure records one too; a group's track record (once it has at least 3 known
  outcomes) breaks ties between search results that already tie on quality and custom-format
  score. Viewable on the System page.
- **Bulk edit via CSV** — the inverse of CSV export: edit `monitored`/`qualityProfileId` in a
  spreadsheet and re-upload it to bulk-apply the changes by `id` across as many items as the file
  has rows.
- **Storage quota per root folder** — set a quota percentage and opt in to pausing new auto-search
  grabs into that folder once it's at/over quota, checked live via `statfs` at grab time; a warning
  badge appears in Settings once a folder crosses its own quota.
- **Duplicate request detection** — submitting a request for a title that's already pending or
  approved (from any household member, not just yourself) asks for confirmation instead of quietly
  creating a second request for the same thing.
- **Search window** — beyond quiet hours (which pauses auto-search inside a window), this
  restricts auto-search to only run inside a configured daily window instead of continuously.
- **Media server library validation** — a System check cross-references AoNarr's own movie/episode
  library against what the configured media server actually reports having, flagging anything
  AoNarr thinks exists that the media server doesn't see — a stale path, a permissions issue, or a
  file moved/deleted outside AoNarr's own pipeline.

## Architecture

```
AoNarr/
  server/   Node.js + TypeScript API (Express, SQLite via better-sqlite3, node-cron)
  web/      React + Vite single-page UI
  data/     Bind-mounted at runtime: SQLite DB, config, downloads
```

The server exposes a REST API under `/api`, gated by an API key (`X-Api-Key` header) that's
generated on first boot and printed once to the container logs.

SQLite is the only supported database — see [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md) for the
scoping analysis on optional PostgreSQL/MariaDB support (not started; that document explains why
it's a foundation-level change rather than a bounded feature).

**`services/mediaTypes.ts` is the single source of truth for every library.** Each of the 10
entries declares a `shape` (`single` | `episodic` | `collection`), file extensions, a default
Torznab/Newznab category, and its metadata providers. Every other part of the app — the DB layer
(`media_items.type`/`root_folders.media_type` are unconstrained TEXT, validated against this
config at the application layer instead of a fixed SQL `CHECK`), the scheduler's auto-search loop,
the importer's file-placement logic, the indexer category lookup, and the naming-template
defaults — branches on `shape`, not on a hardcoded type name. Adding an 11th library is one entry
in `MEDIA_TYPES` plus (if it needs one) a metadata provider function; nothing else in the
scheduler/importer/indexer code needs to change. `GET /api/media-types` publishes this config so
the web UI never hardcodes a type list either — `Library`, `AddMedia`, `Settings`, and
`MediaDetail` all render from it.

Indexer, download-client, metadata, and subtitle-provider integrations are behind small
interfaces/modules (`services/indexerClient.ts`, `services/downloadClient.ts`,
`services/metadata.ts`, `services/subtitleClient.ts`) — adding NZBGet, Deluge, Transmission,
another metadata source, or another subtitle provider means implementing that module once,
reusable by every library.

Key services:

- `services/mediaTypes.ts` — the library registry described above.
- `services/releaseParser.ts` — parses season/episode/season-pack/quality/audio-language/
  release-group out of release titles.
- `services/quality.ts` — reads the DB-backed quality ladder (`qualities` table, reorderable in
  Settings) and provides profile-aware "best allowed quality" picking plus size-bounds validation,
  both cached in-memory and invalidated on write.
- `services/customFormatScoring.ts` — evaluates a release against every custom format's condition
  groups (title-regex, size-range, language, or release-group; OR'd within a group, AND'd across
  groups, optional negation) for a given quality profile; used by both the scheduler's grab
  ranking and the manual search annotation.
- `services/naming.ts` — renders `{token}` / `{token:00}` naming templates into path segments,
  with one default template per shape (not per type).
- `services/metadata.ts` — one search + detail-fetch implementation per provider (15 search
  providers + Fanart.tv artwork across 9 searchable library types), behind a registry derived from
  `MEDIA_TYPES` and dispatch functions that pick the right implementation by which provider's id
  is present on a media item/album, so the rest of the app never needs to know which provider a
  given item came from.
- `services/scheduler.ts` — the auto-search/grab/poll/import loop (`node-cron` + `setInterval`),
  quality- and custom-format-aware, branching on shape for how it walks a library's monitored,
  fileless items (once for a single-file item, per-episode for episodic, per-child for
  collections).
- `services/importer.ts` — matches a completed download to a file on disk (season-pack-aware for
  episodic libraries) and moves/renames it into the right root folder using the naming templates;
  exposes `placeFile()` (single file — covers `single` shape and non-multi-file `collection`
  children like Books/Comics/Videos/Lessons, shared by both the automatic post-download path and
  the manual-import endpoint) and `placeAlbumFiles()` (multi-file — for `collection` types with
  `multiFilePerChild: true`, currently just Music: moves every sibling audio file in an album
  download and matches each to a track by leading track number).
- `services/notifications.ts` — fan-out to Discord/Slack/Telegram/Pushover/generic webhooks.
- `services/auth.ts` — scrypt password hashing and session-token issue/verify for household
  accounts (the admin API key is unrelated and unchanged).
- `services/mediaServer.ts` — fetches "watched" file paths + last-played times from Plex,
  Jellyfin, or Emby's own API, whichever is configured.
- `services/archival.ts` — matches watched files back to library items (by parent-folder +
  filename, since the media server usually mounts the library at a different path than AoNarr
  does), and moves or deletes anything past the retention window and not marked `protected`.
- `services/blocklist.ts` — release blocklist lookups, consulted by both the scheduler's
  auto-grab ranking and the manual search/grab endpoints.
- `services/recommendations.ts` — TMDB recommendations (movies/TV) and Last.fm similar-artist
  (music) lookups sourced from the most recently added library items, deduped against what's
  already in the library.
- `services/traktSync.ts` — parses a public Trakt list/watchlist URL, fetches its items, and adds
  anything new as a monitored library item through the same insert path every other add-media
  route uses.
- `services/duplicates.ts` — reconstructs repeated-import patterns from the `history` table (an
  item's `path`/`file_path` only ever holds the current file, so this is inferred from import
  events rather than a live disk scan) to flag likely upgrades vs. wasted duplicate grabs.
- `services/audit.ts` — append-only audit log writer, called from the auth/requests/users routes.
- `services/push.ts` — Web Push: generates and persists VAPID keys once, stores/removes browser
  subscriptions, and sends notifications either to all admin/global subscriptions (grab/import/
  failed events) or to one user's own subscriptions (their request's approve/reject outcome).
- `middleware/auth.ts` — `requireAuth` accepts either the admin API key (`X-Api-Key`) or a
  household session token (`X-Session-Token`) on every `/api` route except `/api/health` and
  `/api/auth/login`; `requireAdmin` additionally gates admin-only routers and mutation endpoints.
  Read routes that both roles can hit (`media`, `library-search`) filter results to a restricted
  user's granted library types in-handler rather than being blanket-gated.
- `services/indexerClient.ts` — one function per indexer protocol (Torznab/Newznab, RSS, DDL),
  dispatched by `indexer.protocol`; the DDL branch reads `indexer.config` (a JSON field-mapping —
  see Features above) to turn an arbitrary JSON API response into `SearchResult[]` without any
  site-specific code.
- `services/downloadClient.ts` — one adapter per client type. qBittorrent/SABnzbd talk to an
  external client's API as before; `http` and `ytdlp` are in-process adapters with no external
  client at all — `http` streams a URL straight into `downloadsDir` itself, `ytdlp` spawns the
  `yt-dlp` binary (bundled in the server image) — both track job progress in an in-memory map
  polled by `getStatus()`, then feed the same queue/import pipeline every other grab does.
  `scheduler.ts`'s `pickClientForProtocol()` picks the configured client whose type actually
  matches a grabbed result's protocol (torrent→qbittorrent, usenet→sabnzbd, http→http) instead of
  always grabbing via the first enabled client — a real bug fixed while adding the new client
  types, since it broke silently the moment more than one client type was configured.
- `db/client.ts`'s `dropCheckConstraint()`/`repairDanglingReference()` — `indexers.protocol` and
  `download_clients.type` originally shipped with a rigid `CHECK (...)` list; adding new
  protocol/client types required rebuilding those two tables into the same unconstrained-TEXT,
  validated-at-the-application-layer pattern `media_items.type` already used. The rebuild runs
  once (idempotent) and is careful about a real footgun in SQLite's `ALTER TABLE RENAME`: by
  default it rewrites *other* tables' `REFERENCES` clauses to follow the rename, which is exactly
  wrong for a rename into a throwaway `_pre_migration` table about to be dropped — caught live
  during round-10 testing as `queue`/`blocklist` inserts failing with "no such table:
  download_clients_pre_migration" after the first migration ran. Fixed by toggling
  `PRAGMA legacy_alter_table` off for the rename, plus a one-time repair pass for any database
  that already got corrupted by the earlier version of the migration.
- `services/rateLimiter.ts` — a simple in-memory fixed-window limiter (10 failures per 15-minute
  window → 15-minute lockout, keyed by `${scope}:${ip}`), applied to `requireAuth`'s credential
  check, household login, and TOTP verify/check-login/disable. Not distributed — fine for a
  single-process self-hosted app; resets on restart.
- `services/logger.ts` — thin wrapper around `console.*` that also keeps an in-memory 500-line
  ring buffer, surfaced via `GET /api/system/logs`. Every `console.log`/`warn`/`error` call across
  the scheduler, archival, importer, indexer client, download clients, notifications, and push
  services was swept over to use it.
- `routes/metrics.ts` — Prometheus text-exposition output, exempted from `requireAuth` the same
  way `/health` is.
- `services/duplicateCheck.ts` — normalized-title (+ year, when both sides have one) matching
  against existing library items of the same type, consulted by both the manual-add and
  metadata-import routes before insert; a `409` with the matches lets the caller confirm or bypass
  via `confirmDuplicate`.
- `services/scheduler.ts`'s `isWithinQuietHours()` — parses `HH:MM` settings into
  minutes-since-midnight and handles the overnight-wraparound case (start > end) so a window like
  22:00–06:00 works correctly across midnight.
- `routes/watchlistImport.ts` — bulk watchlist import; the web UI normalizes IMDb/Letterboxd/Trakt
  CSV headers into `{title, year, type}` rows client-side (each export uses different column
  names), and the server does the metadata search + duplicate check + insert per row server-side.
- `routes/calendarFeed.ts` — the `.ics` feed is deliberately on a separate token from the admin
  API key (`?token=`, generated/regenerated via `/api/settings/calendar-token`) since calendar
  apps subscribing by URL can't send custom headers; exempted from `requireAuth` like `/health`
  and `/metrics`, with its own manual token check inside the handler.

## Running on Unraid

The easiest path is Community Applications: search "AoNarr" in the Apps tab. Until the app is
listed there, add this repo as a Template Repository (Apps → Settings → Template Repositories →
paste `https://github.com/aon082910/AoNarr`) to get the templates in `templates/` — `aonarr`
(all-in-one, recommended) or `aonarr-server` + `aonarr-web` (split, independently scalable) —
without needing Docker Compose at all.

Otherwise, the simplest path is Docker Compose (Unraid's Docker tab can also run a compose stack
via the Compose Manager plugin, or you can `docker compose up -d` over SSH):

```bash
cd /mnt/user/appdata/aonarr
git clone <this-repo> .
docker compose up -d --build
```

This starts two containers:

- `aonarr-server` — the API + scheduler, listening on `8989`, with `/mnt/user/appdata/aonarr/data`
  bind-mounted to `/config`, plus `/media` and `/downloads` mounts.
- `aonarr-web` — the UI, listening on `9876`, proxying `/api` to the server.

Edit `docker-compose.yml` to point the `media` and `downloads` volumes at your actual Unraid
shares (e.g. `/mnt/user/media`, `/mnt/user/downloads`) before starting — `downloads` must be the
same directory your download client saves completed files into, since that's what the importer
scans to find and move finished downloads.

On first boot, check the logs for your API key:

```bash
docker compose logs aonarr-server | grep "API key"
```

Then open `http://<unraid-ip>:9876`, paste that key in to log in, and:

1. **Settings** → add a root folder per library you'll use, whichever metadata provider API keys
   you want (MusicBrainz/Open Library/Deezer/TVmaze/AniList need none), a subtitle provider
   (OpenSubtitles API key), and notification webhook URLs.
2. **Indexers** → add your Torznab/Newznab indexers.
3. **Download Clients** → add qBittorrent or SABnzbd, with a `category` matching what you use
   elsewhere.
4. **Add Media** → pick a metadata provider (or use the type's default), search, and import — or
   add manually.

From there the scheduler auto-searches monitored, fileless items on the configured interval,
grabs the best release that fits the quality profile, and imports it (subtitles included) once
your download client finishes. Check **Missing** for what's still outstanding and **Calendar**
for what's coming up; use **Manual Import** on a media item's page for anything that didn't
auto-resolve.

## Verification

This has been built and smoke-tested sixteen times with `docker compose build` + live
`docker compose up` runs against real endpoints, not just typechecked:

- **Round 1** (core loop): health check, CRUD, MusicBrainz/Open Library metadata search + import
  producing real album/book children, release-title parsing across single-episode/season-pack/
  movie/episode-range cases, an end-to-end import that moved and renamed a test file into the
  correct root-folder layout.
- **Round 2** (auth, calendar, manual import, system status): API-key auth (401 without/with-wrong
  key, 200 with the right one, through both the direct API and the nginx web proxy), key
  regeneration invalidating the old key immediately, the Missing and Calendar endpoints against
  real episode data, manual import browse + assign (including a rejected path-traversal attempt),
  the system status endpoint, and a genuine bug this round's testing caught: a season-pack import
  where two episodes shared one downloaded folder — before the fix both queue entries would have
  raced for the same top-scoring file; after the fix, each episode resolved to its own
  correctly-sized file (`S01E01.mkv` / `S01E02.mkv`, 10KB/20KB respectively).
- **Round 3** (tags, custom formats, naming, tracks, notifications): tag CRUD + assignment +
  library filtering by tag end-to-end; custom format creation with invalid-regex rejection,
  live-verified regex scoring (`REMUX` release scored 50, `WEBDL` scored 0 against the same
  format); per-profile format scores and minimum-score gate set via the API; an overridden movie
  naming template (`Movies/{title}.{year}/...`) verified to actually change where an imported file
  landed on disk; a real MusicBrainz track fetch returning a genuine 15-track album with correct
  titles/durations, cached on second fetch; a simulated multi-track album download where all three
  test track files moved into the album folder and correctly matched to tracks 1–3 by leading
  track number, with the rest of the (real, un-downloaded) tracklist correctly left unmatched; and
  a configured-but-fake Telegram provider failing gracefully (logged, not thrown) when notified.
  One MusicBrainz endpoint intermittently 503'd under repeated testing load — confirmed as
  MusicBrainz-side rate limiting (a direct request without our code returned the same 503, then
  succeeded on retry), not an AoNarr bug.
- **Round 4** (quality definitions, AND/OR custom formats, 6 new metadata providers): quality
  seeding, live rename, and reorder — which surfaced a genuine bug: reordering hit `SqliteError:
  UNIQUE constraint failed: qualities.rank` because writing final ranks directly can collide
  mid-transaction with a row that hasn't been updated yet (e.g. swapping two adjacent ranks).
  Fixed by staging through negative placeholder ranks first; re-verified the swap succeeds and
  `qualityRank()`'s cache reflects the new order immediately. AND/OR/NOT condition groups verified
  directly against four titles — `(REMUX or BluRay) and not x265` correctly matched a
  BluRay-REMUX release, correctly rejected a BluRay-x265 release, correctly rejected a plain WEBDL
  release, and correctly matched a plain BluRay release. Metadata providers verified live: TVmaze
  series search and a real 62-episode import, Deezer artist search and a real 38-album import,
  Deezer track fetch returning Daft Punk's actual "Homework" tracklist, the default-provider
  setting actually changing which provider an unqualified search uses, and OMDb/TVDB/Discogs all
  failing with clear "not configured" errors (not crashes) when their keys are unset.
- **Round 5** (size-based quality validation, size custom-format conditions, Trakt): size-bounds
  enforcement verified against four cases — a 300MB release parsed as WEBDL-1080p correctly
  rejected as too small for a configured 4000–15000MB range, an 8000MB release correctly accepted,
  a 20000MB release correctly rejected as too large, and a quality with no bounds configured
  correctly always passing. A combined title+size custom format
  (`REMUX and 4000-30000MB`) verified against four cases including a release with unknown size
  correctly failing the size condition rather than silently passing. Trakt verified live: both the
  movie and series search dispatch paths (which share the "trakt" provider name but call different
  endpoints) return the provider in `/api/metadata/providers`, and both fail with the same clean
  `HTTP 403` error under an invalid Client ID rather than crashing or behaving inconsistently
  between the two media types.
- **Round 6** (language/release-group custom formats, Fanart.tv, AniList, Last.fm): release
  parsing verified against 4 real-shaped titles, correctly extracting language tags (`multi`,
  `french`, `german`) and release groups (`RARBG`, `EVO`, `SomeGroup`) or correctly finding
  neither on a plain title. A combined `NOT LANG:french AND GROUP:(RARBG|EVO)` custom format
  verified against 3 cases: an English RARBG release matched, the same release in French
  correctly didn't, and an English release from an untrusted group correctly didn't. AniList
  verified live end-to-end: real search results, then a real import producing 25 actual episodes
  for Attack on Titan season 1. Fanart.tv verified live: an item with no TMDB/TVDB/MusicBrainz id
  correctly rejected with a clear error, an item with a TMDB id but no Fanart key correctly
  rejected, and — once a (deliberately invalid) key was set — the request reached Fanart.tv for
  real and got back a genuine `HTTP 401`, confirming the integration talks to the real API rather
  than failing silently earlier in the chain. Last.fm confirmed failing cleanly without a key.
- **Round 7** (Books/ROMs/Anime/Music/Comics/Online Videos/Courses/Adult — the full 10-library
  expansion): `GET /api/media-types` verified returning all 10 entries with correct
  shape/childLabel/multiFilePerChild. Created a root folder and a media item for all 10 types
  live, including confirming an invalid type is rejected with `400`. Verified shape-driven
  children routing returns `episodes` for an episodic type (series) and `sub_items` for a
  collection type (comic) from the same `GET /api/media/:id` handler. Ran the import pipeline
  end-to-end for two type combinations never exercised before: a Comic issue (collection,
  non-multi-file) correctly landed at `Test Comic/Issue #1.cbz` using the generic
  `{parentTitle}/{childTitle}` template, and a ROM (single shape, non-video extension) correctly
  matched a `.zip` file and landed under `Test Game (.../Test Game (....zip` using the generic
  `{title} ({year})` template. Confirmed indexer category mapping for all 10 types (e.g. ROMs →
  `4050`, Adult → `6000`, Comics → `7030`). All five new keyed providers (Comic Vine, RAWG, IGDB,
  YouTube, ThePornDB) confirmed failing with clear "not configured" errors when unkeyed, and
  Courses — which has no provider at all — confirmed returning a clear "add this item manually"
  error from the search endpoint rather than a generic failure.

- **Round 8** (global search, collections, multi-user accounts, request portal, health dashboard,
  watch-status auto-archival): built and started both containers clean with no errors. Verified
  live end-to-end: admin login via `/api/auth/me`; created a restricted household account scoped
  to Movies only; logged in as that user and confirmed a `GET /api/settings` call correctly
  returned `403` while `GET /api/media` correctly returned an empty, type-filtered list; submitted
  a request as that user; approved it as admin (which created a real `media_items` row through the
  same insert path as adding media directly); created a collection and added the newly-approved
  item to it; confirmed global search (`/api/library-search`) found it by title. In the browser:
  the auth gate's Admin/Household toggle, admin login landing on the full nav (including the new
  Users and Requests links), the Users page listing the account created via the API, the System
  page's new Health section (indexer reachability, stuck-queue count, pending-request count) and
  Maintenance section (manual archival trigger, orphaned-file scan), logging out, logging back in
  as the restricted user, confirming the nav collapsed to just Library/Search/Collections/Requests
  with the type filter showing only "Movies", the approved movie visible in Library, and its detail
  page correctly showing no admin controls (Monitor/Protect/Search/Remove/Manual Import) while
  still allowing collection membership. No bugs found this round — the multi-router admin gate
  (`requireAdmin` applied per-router or per-mutation-route) and the in-handler type filtering on
  `media`/`library-search` both behaved correctly on the first live pass.
- **Round 9** (release blocklist, recommendations, Trakt sync, duplicate/upgrade detection,
  per-user request limits + auto-approval, audit log, backup/restore, PWA + Web Push): rebuilt and
  restarted both containers clean (including a fresh `web-push` dependency compiling correctly
  under the pinned Node 20 image). Verified live end-to-end: `/api/push/vapid-public-key` returns
  a real VAPID key generated on first use and persisted in settings; created a household account
  with `autoApprove: true` and `maxPendingRequests: 2` — submitting a request as that user
  immediately came back `status: "approved"` with a real `media_items` row, and the audit log
  correctly recorded `request_submitted` followed by `request_auto_approved`; a second account with
  `maxPendingRequests: 1` got a clean `400` (not a crash) on its second pending request while the
  first stayed queued; `GET /api/system/health` returned the new `repeatedImports` array; a
  downloaded backup via `GET /api/system/backup` was confirmed by file signature to be a genuine
  SQLite database ("SQLite 3.x database..."); Trakt sync correctly no-ops (`{"added":0}`) when
  unconfigured rather than erroring. One genuine bug found and fixed this round: `POST
  /api/blocklist` with a `mediaItemId` that doesn't exist hit the `media_items` foreign key
  constraint and surfaced as an opaque `500` instead of a clean `404` — added an existence check
  before the insert, re-verified both the `404` on a bad id and a real `201` on a valid one. In the
  browser: the sidebar's new "Enable notifications" link, the Users page's new max-pending/
  auto-approve columns, the Audit Log page rendering every event from the API tests above with
  correct human-readable labels, Settings' new Watch-status Auto-Archival/Trakt List Sync/
  Blocklist sections (the blocklist entry created via the API appeared correctly), the
  Recommendations page's correct empty state (no TMDB/Last.fm key configured yet), and System's new
  Backup & Restore and Trakt-sync-trigger controls alongside the existing Health/Maintenance
  sections — including "1 pending request(s)" correctly reflecting the still-queued account from
  the limit test.
- **Round 10** (DDL + RSS indexer protocols, direct-HTTP and yt-dlp download clients, per-protocol
  client selection): rebuilt both images clean, including the server image fetching the `yt-dlp`
  standalone binary and confirming `yt-dlp --version` works inside the running container. Verified
  live end-to-end: created an RSS indexer and a DDL indexer via the API; tested the DDL indexer
  against a genuinely public JSON API (archive.org's advancedsearch endpoint) with a real
  field-mapping config and got back `{"ok":true,"resultCount":50}` — confirming the generic
  dot-path field mapping actually works against a real, un-special-cased API, not just a fixture;
  created `http` and `ytdlp` download clients with no host/port and confirmed both persisted
  correctly; manually grabbed a real file through the `http` client and confirmed the exact bytes
  landed in the downloads folder; triggered a yt-dlp download through the new
  `POST /api/media/subitems/:id/download` endpoint and confirmed the process actually spawned,
  ran, and reported a real error (YouTube's bot-check, an external constraint of the test
  environment, not an AoNarr defect — confirmed by running `yt-dlp` directly in the container and
  hitting the identical error). Two genuine bugs found and fixed this round, both significant: (1)
  the scheduler always grabbed through `clients[0]` regardless of the result's protocol, silently
  broken the moment more than one download client type was configured — fixed with
  protocol-to-client-type matching, verified by tracing the new `pickClientForProtocol` logic
  against all three protocol/type pairings; (2) the table-rebuild migration for dropping the old
  `CHECK` constraints used SQLite's default `ALTER TABLE RENAME` behavior, which rewrites *other*
  tables' `REFERENCES` clauses to follow the renamed table — silently pointing `queue`'s and
  `blocklist`'s foreign keys at a `_pre_migration` table that gets dropped moments later. This
  surfaced as a live `500` ("no such table: main.download_clients_pre_migration") on the very
  first real grab attempt after migrating; root-caused via the server logs, fixed by toggling
  `PRAGMA legacy_alter_table` off for the rename step, and — since the bug had already corrupted
  the running test database — added a one-time repair pass that rebuilds `queue`/`blocklist` back
  to correct `REFERENCES` text, then re-verified the exact grab that failed now succeeds along
  with a blocklist insert. Also improved yt-dlp failure visibility while root-causing the YouTube
  error above: the adapter now captures and logs stderr on a non-zero exit instead of just
  recording a bare "failed" status. In the browser: the Indexers page's protocol dropdown
  (Torznab/Newznab/RSS/DDL) with the DDL-only field-mapping form appearing/disappearing correctly,
  and the Download Clients page's type dropdown correctly hiding host/port/category for
  `http`/`ytdlp` while keeping them for `qbittorrent`/`sabnzbd`.
- **Round 11** (search caching/timeout, incremental orphaned-scan, ordered/exportable collections,
  unified timeline, upgrade candidates, storage forecasting, bulk actions, config template
  import/export, TOTP 2FA, per-tag/collection retention): rebuilt and restarted both containers
  clean, including three more schema migrations (collection item position, root-folder scan
  timestamps, disk-usage samples, tag/collection retention columns) running with no errors on top
  of the already-migrated round-10 database. Verified live end-to-end: `GET /api/system/status`
  and `/api/system/health` return the new `daysUntilFull`/`upgradeCandidates` fields;
  `/api/activity/timeline` returns `[]` cleanly with no data yet; `/api/system/orphaned-scan`
  returns `{"incremental":true,"skippedDirs":0}` on a fresh instance. The TOTP implementation was
  checked against the actual RFC 6238 Appendix B test vector (ASCII secret
  `12345678901234567890`, counter 1, SHA1) and produced the exact expected `94287082` — not just
  self-consistency — before ever touching the live app; then tested for real against the live
  server: `/totp/setup` returned a real secret, a code generated from that secret via the same
  verified algorithm was accepted by `/totp/verify` (enabling 2FA), a wrong code was correctly
  rejected by `/totp/check-login` (`{"ok":false}`) while a freshly-generated correct code was
  accepted (`{"ok":true}`), and `/totp/disable` correctly required and accepted a valid code.
  Bulk endpoints verified: `POST /api/media/bulk/monitor` and `/bulk/tag` both applied correctly
  to a real media item in one call. Collections verified: set a 90-day retention override via
  `PATCH`, confirmed the JSON watch-order export returns items in the right order, and confirmed
  the M3U export correctly skips (and counts) an item with no downloaded file rather than emitting
  a broken playlist entry. Settings template export returned real quality/profile data in the
  documented shape. In the browser: Settings' new Two-Factor Authentication and Config Template
  sections, the Tags table's new retention column and its explanatory copy, and the Activity
  page's new Timeline section all rendered correctly with the right empty states.
- **Round 12** (login rate-limiting, Docker healthchecks, log viewer, Prometheus metrics,
  duplicate-on-add, quiet hours, watchlist CSV import, iCal feed, theme toggle, notification
  templates): rebuilt both images clean. One genuine bug found and fixed this round: the web
  container's `HEALTHCHECK` used `wget http://localhost:7878/`, which failed with "connection
  refused" even though nginx was demonstrably listening (confirmed via `netstat` inside the
  container) — root cause was `localhost` resolving to `::1` first inside the container while
  nginx only binds `0.0.0.0` (IPv4), so the IPv6 attempt was refused. Fixed by pointing the
  healthcheck at `127.0.0.1` explicitly; re-verified both containers report `healthy` via
  `docker inspect`. Verified live end-to-end: `/api/metrics` returns real Prometheus-format output
  unauthenticated; rate limiting confirmed with 11 consecutive wrong-API-key requests — the first
  10 correctly return `401`, the 11th returns `429`, and (expectedly, since the limiter is
  per-IP) even the *correct* key was locked out from that IP until the window reset, matching
  standard IP-based brute-force protection behavior rather than being a bug; duplicate-on-add
  confirmed end-to-end — adding "Dup Test (2024)" twice returned a `409` with the existing match
  on the second attempt, and retrying with `confirmDuplicate: true` correctly created it anyway;
  the iCal feed returned well-formed `VCALENDAR` output with a valid token and a clean `401` with
  an invalid one. In the browser: the new Watchlist Import nav item and page, and the theme
  toggle — clicking it live-verified via `getComputedStyle` that the page background actually
  changed color and `data-theme="light"` was applied to `<html>`, not just that the button
  rendered.
- **Round 13** (season-level monitor toggle, multi-root-folder auto-selection, NFO import, active
  session list + revoke, scheduled backups, CSV export, home dashboard, custom subtitle providers):
  rebuilt both images clean, redeployed with `docker compose down && up -d`, both containers
  `healthy`. One bug caught and fixed before it shipped: the NFO parser's `mergeAttrs: true` +
  `explicitArray: true` xml2js options mean every XML attribute (`type="imdb"`, `aspect="poster"`)
  comes back as a one-element array, not a bare string — the first draft compared `entry.type` and
  `t.aspect` directly against `"imdb"`/`"poster"`, which would have silently matched nothing;
  caught by a standalone test script against a real sample `movie.nfo` before it ever reached the
  route, fixed by routing both through the same `firstText()` unwrapping helper used for text
  nodes. Verified live end-to-end via direct API calls against the running container plus the
  browser UI: unmonitoring season 1 of a 2-season test show via `PATCH .../season/1/monitor` left
  season 2 untouched, then re-monitoring it from the actual MediaDetail page's "Monitor season"
  button round-tripped correctly through the UI; adding a movie with no `rootFolderId` against two
  configured movie root folders auto-selected one by live `statfs` free-space (confirmed both
  folders report real free/total bytes via `GET /root-folders`); a real `movie.nfo` file written
  into the downloads dir parsed correctly via `GET /import/nfo` (title/year/plot/imdb-id/poster all
  present) after the bug fix above; a household login's session showed up in `GET
  /users/sessions` with the correct `User-Agent`, and `DELETE /users/sessions/:token` immediately
  invalidated it (`/auth/me` with the revoked token returned 401); `runScheduledBackup()` invoked
  directly inside the container wrote a real SQLite snapshot file and, run three more times with
  `backupKeepCount=2`, correctly rotated out the oldest backup each time, always leaving exactly 2;
  `GET /media/export.csv` returned correct CSV rows for real library data; the new Dashboard page
  (now the `/` route, with Library moved to `/library`) showed Recently Added and an empty-state
  Upcoming section correctly in the browser; a "custom" JSON subtitle provider's field-mapping
  config round-tripped through `POST`/`GET /subtitles/providers` and rendered correctly in
  Settings. All test media items, root folders, users, and the test subtitle provider were deleted
  after verification.
- **Round 14** (ffprobe media info, automatic failed-grab retry, FlareSolverr proxy, import
  exclusions, custom scripts on events, bulk cleanup suggestions, per-user request/storage stats,
  command palette, scene-name fallback search): rebuilt both images clean — the server image now
  installs `ffmpeg` for `ffprobe` — redeployed, both containers `healthy`, and confirmed `ffprobe`
  actually runs inside the container. Verified live end-to-end: generated a real small MP4 with
  `ffmpeg` inside the container, manually imported it, and confirmed the stored `mediaInfo`
  matched the actual file (`h264`/`aac`, 320x240, 1 audio channel) both via the API and rendered
  on the MediaDetail page; added two root folders and confirmed live free-space bytes; copied the
  imported file to a second library path and confirmed the duplicate-file scan correctly grouped
  both copies (plus a third media item independently pointed at the same path) by matching
  size + content sample; created an unmonitored/fileless item and confirmed the cleanup-suggestions
  endpoint and System page found and could delete it; added an import exclusion and confirmed
  `isExcluded()` matches on exact title+year and correctly misses on a year or title mismatch;
  configured a real custom script, triggered `notifyGrabbed()` directly, and confirmed the script
  actually ran with correct `AONARR_EVENT`/`AONARR_MEDIA_TITLE`/`AONARR_RELEASE_TITLE` environment
  variables (log file written to disk as proof); ran a full request → approve → attach-file →
  stats flow through a real household login and confirmed `GET /requests/stats` reported the exact
  on-disk file size (14517 bytes) against the requesting user; added an indexer with
  `useFlareSolverr` enabled and confirmed the flag round-trips through create/list; unit-verified
  the scene-name variant generator against real title examples (`"Mr. & Mrs. Smith 2005"` →
  `"Mr and Mrs Smith 2005"`, `"The Matrix 1999"` → `"Matrix 1999"`, etc.). In the browser: Ctrl+K
  opened the command palette, typing "System" correctly filtered to one match, and — after
  discovering the browser-automation tool's synthesized Return keypress didn't reach the palette's
  React handler (an automation-tool quirk, confirmed by dispatching a real `KeyboardEvent`
  directly, which navigated correctly) — verified the palette's own Enter-to-navigate logic is
  correct; the System page's "Find duplicate files" button was clicked live and rendered all three
  affected library entries grouped correctly; the Users page's new Active Sessions and Request
  Stats tables rendered matching data from the API exactly. Also discovered mid-round that task
  #109 (request notes) was already fully implemented in an earlier round — verified the existing
  `note` field end-to-end rather than redoing it. All test media, users, root folders, indexers,
  and exclusions were deleted after verification.
- **Round 15** (media server webhook receiver, self-hosted OpenAPI docs, download queue
  reordering, parental/content rating controls, torrent client health stats, remote S3 backup,
  in-app changelog, saved searches, actor/cast browsing): rebuilt both images clean (the server
  image now also copies `CHANGELOG.md` into place) and confirmed both containers `healthy`.
  Verified live end-to-end: the webhook endpoint correctly 401s on a wrong token; both supported
  payload shapes (Plex's multipart `media.scrobble`, Jellyfin/Emby-style JSON `PlaybackStop`)
  parsed and responded `{received:true}`; a webhook payload with a completely different mount-path
  prefix than the library's own path still matched the right item via the existing tail-matching
  heuristic and immediately appeared on `/dashboard/recently-watched`; `GET /api/openapi.json`
  correctly requires admin auth (401 unauthenticated, 200 with the API key) and Swagger UI in the
  browser rendered all 37 documented operations from the live spec; a non-qBittorrent download
  client's health-stats and priority endpoints both cleanly 400 instead of silently no-op'ing;
  content-rating restriction was verified with a real household login — a PG-13-restricted user's
  `GET /media` omitted an R-rated item entirely and a direct `GET /media/:id` on it returned 403,
  while the admin (no restriction) still saw it, and the Users page's rating dropdown loaded the
  correct saved value in the browser; the changelog page rendered real markdown headers/lists from
  `GET /api/changelog`. Not independently re-verified live this round (no TMDB key or qBittorrent
  instance available in this environment): actor/cast browsing's TMDB credits lookup and the
  S3 upload path — both build-verified and code-reviewed against the documented request/response
  shapes used elsewhere in the same file, consistent with how every other TMDB-dependent feature
  in this project has been verified when a live key wasn't available. All test media, users, root
  folders, and download clients were deleted after verification.
- **Round 16** (multi-instance federation, smart collections, release-group reputation, CSV bulk
  edit, storage quota per root folder, duplicate request detection, search window scheduling,
  media server library validation): rebuilt both images clean, redeployed, both containers
  `healthy`. Verified live end-to-end: created a smart collection with filter
  `{type: "movie", monitored: 1}` and confirmed `GET /collections/:id` returned only the matching
  item while a direct attempt to manually add a different item to it correctly 400'd ("its
  membership is computed from its filter"); exported the library to CSV, edited a row's
  `monitored` value, re-uploaded it via `POST /media/bulk-import.csv`, got back
  `{updated:2,skipped:0}`, and confirmed the item's monitored flag actually flipped — then watched
  the smart collection's item count drop from 1 to 0 live in the browser as a direct consequence,
  confirming both features compose correctly; submitted a request, then a second request whose
  title only differed by punctuation/case, got a `409` naming the original requester, and confirmed
  `confirmDuplicate: true` correctly bypassed it on retry; `GET /system/library-validation` and
  `GET /system/release-group-stats` responded correctly (the former cleanly 400ing with no media
  server configured, rather than silently returning an empty "all clear"); `remote-instances` CRUD
  round-tripped through the API. Not independently re-verified live this round (no qBittorrent/
  SABnzbd instance, media server, or second AoNarr instance available in this environment): the
  qBittorrent/SABnzbd priority-reordering calls, the storage-quota grab-pausing check, and the
  remote-instance browse proxy's actual cross-instance fetch — all build-verified and code-reviewed
  against the same request/response patterns already live-verified elsewhere in this project (the
  qBittorrent adapter's existing `topPrio` pattern, `statfs`-based disk checks used everywhere else,
  and the existing API-key-authenticated fetch pattern used by every other server-to-server call in
  the app). All test media, collections, users, and requests were deleted after verification.

TMDB, OMDb, TVDB, Trakt, Discogs, Last.fm, Fanart.tv, Comic Vine, RAWG, IGDB, YouTube, ThePornDB,
and subtitle download require API keys/tokens you supply — those paths return clear errors until
configured in Settings. Google Books and AniList work keyless (Google Books is tightly rate
limited without a key; observed a 429 during testing at low volume). Courses has no metadata
provider at all — no public course-catalog search API exists — so it's always added manually.

## Local development

Requires Node.js 20 (native `better-sqlite3` bindings are not guaranteed to prebuild on very new
or non-LTS Node versions — the Docker image pins Node 20 for this reason).

```bash
# server
cd server
npm install
npm run dev     # http://localhost:8989

# web (separate terminal)
cd web
npm install
npm run dev      # http://localhost:5173, proxies /api to :8989
```
