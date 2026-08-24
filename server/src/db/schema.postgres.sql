-- AoNarr unified schema. Every media type (movie/series/artist/author) shares media_items;
-- season/episode and album/book granularity live in the sub_items / episodes tables below.

-- media_type/type are intentionally unconstrained here (not a fixed CHECK list): the valid set of
-- library types lives in services/mediaTypes.ts and is validated at the application layer, so
-- adding a new library type never requires a schema migration.
CREATE TABLE IF NOT EXISTS root_folders (
  id SERIAL PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  allowed_qualities TEXT NOT NULL, -- JSON array, worst -> best
  cutoff TEXT NOT NULL,
  min_format_score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media_items (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_title TEXT NOT NULL,
  year INTEGER,
  overview TEXT,
  poster_url TEXT,
  external_ids TEXT,
  path TEXT,
  root_folder_id INTEGER REFERENCES root_folders(id) ON DELETE SET NULL,
  quality_profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
  monitored INTEGER NOT NULL DEFAULT 1,
  has_file INTEGER NOT NULL DEFAULT 0,
  quality TEXT,
  protected INTEGER NOT NULL DEFAULT 0, -- excluded from watch-status auto-archival
  status TEXT NOT NULL DEFAULT 'unknown',
  added_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  release_date TEXT -- single/collection-shape items' own release date (movies from TMDB, etc.) — episodes/sub_items already have air_date/release_date of their own; this is what the Calendar shows single-shape items by
);

CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);

-- TV episodes (series only)
CREATE TABLE IF NOT EXISTS episodes (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  title TEXT,
  air_date TEXT,
  overview TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  has_file INTEGER NOT NULL DEFAULT 0,
  quality TEXT,
  file_path TEXT,
  UNIQUE(media_item_id, season_number, episode_number)
);

-- Albums (artist) / Books (author) - generic sub-item table
CREATE TABLE IF NOT EXISTS sub_items (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  release_date TEXT,
  external_id TEXT, -- provider-specific album/book id; used to lazily fetch the track list
  external_provider TEXT, -- which metadata provider external_id belongs to (e.g. musicbrainz, deezer)
  monitored INTEGER NOT NULL DEFAULT 1,
  has_file INTEGER NOT NULL DEFAULT 0,
  quality TEXT,
  file_path TEXT
);

-- protocol/type are intentionally unconstrained (not a fixed CHECK list) — same reasoning as
-- media_items.type: the valid set lives in services/indexerClient.ts and services/downloadClient.ts
-- and is validated at the application layer, so adding a new protocol/client type never requires
-- a schema migration.
CREATE TABLE IF NOT EXISTS indexers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT,
  categories TEXT NOT NULL DEFAULT '',
  media_types TEXT NOT NULL DEFAULT 'movie,series,anime,artist,author,audiobook,comic,manga,rom,video,course,adult',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 25,
  config TEXT -- JSON blob, protocol-specific (e.g. DDL's JSON-field mapping); unused by torznab/newznab/rss
);

CREATE TABLE IF NOT EXISTS download_clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  use_ssl INTEGER NOT NULL DEFAULT 0,
  username TEXT,
  password TEXT,
  api_key TEXT,
  category TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  audio_only INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queue (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE,
  season_number INTEGER,
  title TEXT NOT NULL,
  indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
  download_client_id INTEGER REFERENCES download_clients(id) ON DELETE SET NULL,
  download_id TEXT,
  size BIGINT,
  quality TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  last_progress_at TEXT
);

CREATE TABLE IF NOT EXISTS history (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS subtitle_providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'opensubtitles',
  api_key TEXT,
  languages TEXT NOT NULL DEFAULT 'eng',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Ranked quality ladder; profiles pick a subset via allowed_qualities/cutoff. Seeded on first
-- boot with AoNarr's default resolution/source ladder, editable (rename, reorder, size limits).
CREATE TABLE IF NOT EXISTS qualities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rank INTEGER NOT NULL UNIQUE,
  min_size_mb INTEGER,
  max_size_mb INTEGER,
  preferred_size_mb INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS media_item_tags (
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_item_id, tag_id)
);

-- User-defined release-title patterns (regex) that score releases up/down during grabbing,
-- similar to Sonarr/Radarr custom formats (e.g. prefer REMUX, avoid a bad release group).
CREATE TABLE IF NOT EXISTS custom_formats (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  patterns TEXT NOT NULL, -- JSON array of ConditionGroup objects (see services/customFormatScoring.ts)
  media_types TEXT, -- JSON array of media_type keys this format applies to; NULL/empty = every type (unrestricted, the pre-scoping default)
  trash_id TEXT -- TRaSH-Guides format id, set only for formats pulled in via /custom-formats/trash-sync; lets a re-sync update rather than duplicate
);

-- Per-profile score for a custom format; a format with no row for a given profile scores 0.
CREATE TABLE IF NOT EXISTS quality_profile_format_scores (
  quality_profile_id INTEGER NOT NULL REFERENCES quality_profiles(id) ON DELETE CASCADE,
  custom_format_id INTEGER NOT NULL REFERENCES custom_formats(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (quality_profile_id, custom_format_id)
);

-- Individual tracks within an album (sub_items row for an artist). Fetched lazily from
-- MusicBrainz on demand rather than eagerly for every album (would blow through their rate limit).
CREATE TABLE IF NOT EXISTS tracks (
  id SERIAL PRIMARY KEY,
  sub_item_id INTEGER NOT NULL REFERENCES sub_items(id) ON DELETE CASCADE,
  track_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  duration_seconds INTEGER,
  has_file INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  UNIQUE(sub_item_id, track_number)
);

-- Optional, user-created groupings that can span media types (e.g. a movie, its comic source,
-- and its soundtrack album in one collection) — nothing requires an item to belong to one.
CREATE TABLE IF NOT EXISTS collections (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, media_item_id)
);

-- Generic nested grouping above a media_item, for library types whose real-world organization
-- goes deeper than "one item, optionally with children" — e.g. ROMs (System -> Maker -> Game),
-- Adult (Site -> Maker -> Series -> Video), Online Videos and Courses (Site -> Creator -> item).
-- One table serves every type rather than bespoke tables per hierarchy: `kind` names the level
-- (e.g. "system", "maker", "site"), `media_type` scopes it to one MEDIA_TYPES key, and
-- `parent_group_id` nests groups arbitrarily deep. A media_item's `group_id` (see below) points at
-- its immediate parent group — walk `parent_group_id` up from there for the full breadcrumb.
CREATE TABLE IF NOT EXISTS library_groups (
  id SERIAL PRIMARY KEY,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  overview TEXT, -- optional user-entered description for this group's own page (e.g. what a System/Company/Site/Creator is)
  parent_group_id INTEGER REFERENCES library_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Files moved here instead of straight-deleted (by archival's permanent-delete path and the
-- media Remove action) so they're recoverable until the scheduled cleanup job purges them.
-- recycle_path preserves the type/relative-path structure under the recycle bin root so browsing
-- it mirrors each library's own folder layout.
CREATE TABLE IF NOT EXISTS recycle_bin (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
  media_type TEXT NOT NULL,
  title TEXT NOT NULL,
  original_path TEXT NOT NULL,
  recycle_path TEXT NOT NULL,
  size_bytes BIGINT,
  deleted_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  restoring INTEGER NOT NULL DEFAULT 0, -- 1 while an async restore is in flight (large files move off the request thread)
  restore_error TEXT -- set if the last restore attempt failed, cleared on the next attempt
);

-- Files the corrupt-media check (services/corruptMediaCheck.ts) flagged as failing validation,
-- held here instead of being recycled immediately when "review before recycling" is enabled in
-- Settings — an admin confirms (recycle it) or dismisses (false positive, leave the file alone)
-- each one. table_name/row_id identify the actual media_items/episodes/sub_items row so approving
-- can run the exact same recycle-and-mark-missing logic the automatic path already uses.
CREATE TABLE IF NOT EXISTS corrupt_media_review (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL, -- 'media_items' | 'episodes' | 'sub_items'
  row_id INTEGER NOT NULL,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- A public, unauthenticated read-only link to one media item's overview/poster — for sharing
-- outside the household without handing out a login. Revocable; optionally expiring.
CREATE TABLE IF NOT EXISTS share_links (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  expires_at TEXT
);

-- Recurring "auto-add anything new here" sources, checked on the same schedule as auto-search.
-- Distinct from watchlist_import (one-time CSV upload): these are re-fetched every cycle.
CREATE TABLE IF NOT EXISTS import_lists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  quality_profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
  last_synced_at TEXT,
  last_added_count INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- A title that Watchlist Import or an Import List's recurring sync couldn't confidently match to
-- a metadata provider result — previously such a title was just silently dropped with no record
-- anywhere. `source` is either 'watchlist' or the import list's own name at the time it was queued
-- (kept as a snapshot, not a live join, so it still reads sensibly if the list is later renamed or
-- deleted); `import_list_id` is set only for the recurring-list case, null for a one-time watchlist
-- upload. Deduped by (source, import_list_id, type, title, year) regardless of status so a
-- dismissed item doesn't get silently re-queued on every subsequent sync.
CREATE TABLE IF NOT EXISTS import_review_items (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  import_list_id INTEGER REFERENCES import_lists(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  resolved_at TEXT
);

-- User accounts. 'admin' rows are created once via the first-run setup wizard (or promoted);
-- the instance-wide API key (settings.apiKey) remains valid in parallel for automation/scripts.
-- 'user' rows are household members with limited, per-library access.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, -- "scrypt$salt$hash", see services/auth.ts
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_library_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  PRIMARY KEY (user_id, media_type)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  expires_at TEXT NOT NULL
);

-- Requests submitted by restricted users; an admin approves (which adds the media item to the
-- library the normal way) or rejects.
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  overview TEXT,
  poster_url TEXT,
  external_ids TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  media_item_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  resolved_at TEXT
);

-- Releases the scheduler/manual search should never grab again for a given media item — e.g. a
-- grab that turned out to be fake/corrupt/mislabeled.
CREATE TABLE IF NOT EXISTS blocklist (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  release_title TEXT NOT NULL,
  indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Instant "this was just watched" signal from a Plex/Jellyfin/Emby webhook, distinct from the
-- polling-based fetchWatchedFiles() used by auto-archival — lets the dashboard's Recently
-- Watched widget update immediately instead of waiting for the next scheduled poll.
CREATE TABLE IF NOT EXISTS watch_events (
  id SERIAL PRIMARY KEY,
  media_item_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Per-release-group grab outcome history — a group that keeps producing releases that fail to
-- import (fake/mislabeled/corrupt) or get blocklisted is a weak tiebreaker signal against one
-- that consistently succeeds, used only when quality and custom-format score are already tied.
CREATE TABLE IF NOT EXISTS release_group_stats (
  release_group TEXT PRIMARY KEY,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);

-- Another AoNarr instance's API this one can browse read-only — for a household running separate
-- instances per location, without duplicating the whole app's auth model for cross-instance access.
CREATE TABLE IF NOT EXISTS remote_instances (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- A friend's own Plex/Jellyfin/Emby server, shared with this user (not the media server AoNarr
-- manages its own library against, in the mediaServer* settings) — read-only, just for comparing
-- their library against this one to see what they have that's missing here.
CREATE TABLE IF NOT EXISTS friend_libraries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('plex', 'jellyfin', 'emby')),
  url TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- "Never suggest/add this again" — a title (optionally tied to an external id) that search
-- results, recommendations, and Trakt sync should all skip, distinct from the blocklist above
-- (which excludes a specific *release* for something already in the library, not a title from
-- ever being added at all).
CREATE TABLE IF NOT EXISTS import_exclusions (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  external_id TEXT,
  external_provider TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Who did what, when — logins, requests, and admin actions on restricted-user accounts, for the
-- admin-only audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Periodic free/total-space samples per root folder, used to forecast days-until-full.
CREATE TABLE IF NOT EXISTS disk_usage_samples (
  id SERIAL PRIMARY KEY,
  root_folder_id INTEGER NOT NULL REFERENCES root_folders(id) ON DELETE CASCADE,
  free_bytes BIGINT NOT NULL,
  total_bytes BIGINT NOT NULL,
  sampled_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Web Push subscriptions, one row per browser/device that opted in.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- User-added calendar entries not tied to any media item — a release-day watch party, a reminder,
-- anything worth marking on the same Calendar page the library's own upcoming episodes/albums/
-- movies show on.
CREATE TABLE IF NOT EXISTS custom_calendar_events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Named, reusable combinations of a library page's sort/filter/view/column settings — the
-- lightweight per-browser localStorage state (Round 64) remembers your LAST choice; this is for
-- explicitly saving a particular combination (e.g. "Missing 4K remuxes") to switch back to later,
-- shared instance-wide the same way quality profiles/custom formats are rather than per-user.
CREATE TABLE IF NOT EXISTS saved_library_views (
  id SERIAL PRIMARY KEY,
  media_type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON: {sortKey, statusFilter, tagFilter, contentRatingFilter, viewMode, posterSize, listColumns, posterFields}
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(media_type, name)
);
