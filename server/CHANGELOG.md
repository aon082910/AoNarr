# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

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
