# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

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
