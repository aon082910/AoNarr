# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

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
