# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

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
