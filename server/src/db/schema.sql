-- AoNarr unified schema. Every media type (movie/series/artist/author) shares media_items;
-- season/episode and album/book granularity live in the sub_items / episodes tables below.

-- media_type/type are intentionally unconstrained here (not a fixed CHECK list): the valid set of
-- library types lives in services/mediaTypes.ts and is validated at the application layer, so
-- adding a new library type never requires a schema migration.
CREATE TABLE IF NOT EXISTS root_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  allowed_qualities TEXT NOT NULL, -- JSON array, worst -> best
  cutoff TEXT NOT NULL,
  min_format_score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);

-- TV episodes (series only)
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  title TEXT,
  air_date TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  has_file INTEGER NOT NULL DEFAULT 0,
  quality TEXT,
  file_path TEXT,
  UNIQUE(media_item_id, season_number, episode_number)
);

-- Albums (artist) / Books (author) - generic sub-item table
CREATE TABLE IF NOT EXISTS sub_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT,
  categories TEXT NOT NULL DEFAULT '',
  media_types TEXT NOT NULL DEFAULT 'movie,series,anime,artist,author,comic,rom,video,course,adult',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 25,
  config TEXT -- JSON blob, protocol-specific (e.g. DDL's JSON-field mapping); unused by torznab/newznab/rss
);

CREATE TABLE IF NOT EXISTS download_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  use_ssl INTEGER NOT NULL DEFAULT 0,
  username TEXT,
  password TEXT,
  api_key TEXT,
  category TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
  download_client_id INTEGER REFERENCES download_clients(id) ON DELETE SET NULL,
  download_id TEXT,
  size INTEGER,
  quality TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitle_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rank INTEGER NOT NULL UNIQUE,
  min_size_mb INTEGER,
  max_size_mb INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  patterns TEXT NOT NULL -- JSON array of regex source strings; format matches if ANY pattern matches the release title
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, media_item_id)
);

-- Restricted user accounts (separate from the single admin API key). Admins keep using the
-- instance-wide API key; these are for household members with limited, per-library access.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, -- "scrypt$salt$hash", see services/auth.ts
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user')), -- only non-admin roles live here
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_library_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  PRIMARY KEY (user_id, media_type)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Requests submitted by restricted users; an admin approves (which adds the media item to the
-- library the normal way) or rejects.
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Releases the scheduler/manual search should never grab again for a given media item — e.g. a
-- grab that turned out to be fake/corrupt/mislabeled.
CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  release_title TEXT NOT NULL,
  indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Instant "this was just watched" signal from a Plex/Jellyfin/Emby webhook, distinct from the
-- polling-based fetchWatchedFiles() used by auto-archival — lets the dashboard's Recently
-- Watched widget update immediately instead of waiting for the next scheduled poll.
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Never suggest/add this again" — a title (optionally tied to an external id) that search
-- results, recommendations, and Trakt sync should all skip, distinct from the blocklist above
-- (which excludes a specific *release* for something already in the library, not a title from
-- ever being added at all).
CREATE TABLE IF NOT EXISTS import_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  external_id TEXT,
  external_provider TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who did what, when — logins, requests, and admin actions on restricted-user accounts, for the
-- admin-only audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Periodic free/total-space samples per root folder, used to forecast days-until-full.
CREATE TABLE IF NOT EXISTS disk_usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_folder_id INTEGER NOT NULL REFERENCES root_folders(id) ON DELETE CASCADE,
  free_bytes INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Web Push subscriptions, one row per browser/device that opted in.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
