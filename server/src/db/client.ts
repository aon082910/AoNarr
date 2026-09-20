import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schemaSql);

/** Lightweight migrations for columns added after a DB already exists. CREATE TABLE IF NOT
 * EXISTS above won't retrofit new columns onto an existing table, so patch them in here. */
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("media_items", "has_file", "has_file INTEGER NOT NULL DEFAULT 0");
ensureColumn("queue", "episode_id", "episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE");
ensureColumn("queue", "sub_item_id", "sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE");
ensureColumn("media_items", "quality", "quality TEXT");
ensureColumn("episodes", "quality", "quality TEXT");
ensureColumn("sub_items", "quality", "quality TEXT");
ensureColumn("queue", "quality", "quality TEXT");
ensureColumn("quality_profiles", "min_format_score", "min_format_score INTEGER NOT NULL DEFAULT 0");
ensureColumn("sub_items", "external_id", "external_id TEXT");
ensureColumn("sub_items", "external_provider", "external_provider TEXT");
ensureColumn("media_items", "protected", "protected INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "max_pending_requests", "max_pending_requests INTEGER");
ensureColumn("users", "auto_approve", "auto_approve INTEGER NOT NULL DEFAULT 0");
ensureColumn("push_subscriptions", "user_id", "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
ensureColumn("root_folders", "last_scanned_at", "last_scanned_at TEXT");
ensureColumn("collection_items", "position", "position INTEGER NOT NULL DEFAULT 0");
ensureColumn("tags", "retention_days", "retention_days INTEGER");
ensureColumn("collections", "retention_days", "retention_days INTEGER");
ensureColumn("indexers", "config", "config TEXT");
ensureColumn("sessions", "last_used_at", "last_used_at TEXT");
ensureColumn("sessions", "user_agent", "user_agent TEXT");
ensureColumn("subtitle_providers", "config", "config TEXT");
ensureColumn("media_items", "media_info", "media_info TEXT");
ensureColumn("episodes", "media_info", "media_info TEXT");
ensureColumn("episodes", "overview", "overview TEXT");
ensureColumn("sub_items", "media_info", "media_info TEXT");
ensureColumn("queue", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("indexers", "use_flaresolverr", "use_flaresolverr INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "content_rating", "content_rating TEXT");
ensureColumn("users", "max_content_rating", "max_content_rating TEXT");
ensureColumn("collections", "smart_filter", "smart_filter TEXT");
ensureColumn("root_folders", "quota_percent", "quota_percent INTEGER");
ensureColumn("users", "totp_secret", "totp_secret TEXT");
ensureColumn("users", "totp_enabled", "totp_enabled INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "group_id", "group_id INTEGER REFERENCES library_groups(id) ON DELETE SET NULL");
ensureColumn("media_items", "extra_metadata", "extra_metadata TEXT");
ensureColumn("queue", "last_progress_at", "last_progress_at TEXT");
ensureColumn("queue", "season_number", "season_number INTEGER");
ensureColumn("download_clients", "audio_only", "audio_only INTEGER NOT NULL DEFAULT 0");
ensureColumn("root_folders", "pause_grabs_at_quota", "pause_grabs_at_quota INTEGER NOT NULL DEFAULT 0");
ensureColumn("library_groups", "overview", "overview TEXT");
ensureColumn("qualities", "preferred_size_mb", "preferred_size_mb INTEGER");
ensureColumn("custom_formats", "media_types", "media_types TEXT");
ensureColumn("custom_formats", "trash_id", "trash_id TEXT");
ensureColumn("recycle_bin", "restoring", "restoring INTEGER NOT NULL DEFAULT 0");
ensureColumn("recycle_bin", "restore_error", "restore_error TEXT");
ensureColumn("media_items", "release_date", "release_date TEXT");
ensureColumn("sub_items", "poster_url", "poster_url TEXT");
ensureColumn("duplicate_group_seen", "dismissed", "dismissed INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "minimum_availability", "minimum_availability TEXT");
ensureColumn("media_items", "series_type", "series_type TEXT");
ensureColumn("library_groups", "logo_url", "logo_url TEXT");
ensureColumn("sub_items", "series_name", "series_name TEXT");
ensureColumn("sub_items", "series_position", "series_position REAL");
ensureColumn("sub_items", "narrator", "narrator TEXT");
ensureColumn("media_items", "backdrop_url", "backdrop_url TEXT");
ensureColumn("media_items", "rating", "rating REAL");
ensureColumn("media_items", "runtime_minutes", "runtime_minutes INTEGER");
ensureColumn("media_items", "size_bytes", "size_bytes INTEGER");
ensureColumn("episodes", "size_bytes", "size_bytes INTEGER");
ensureColumn("sub_items", "size_bytes", "size_bytes INTEGER");
ensureColumn("media_items", "studio", "studio TEXT");
ensureColumn("episodes", "scene_season_number", "scene_season_number INTEGER");
ensureColumn("episodes", "scene_episode_number", "scene_episode_number INTEGER");
ensureColumn("indexers", "query_limit_per_hour", "query_limit_per_hour INTEGER");
ensureColumn("episodes", "absolute_episode_number", "absolute_episode_number INTEGER");
ensureColumn("root_folders", "min_free_space_gb", "min_free_space_gb INTEGER");
ensureColumn("import_lists", "require_review", "require_review INTEGER NOT NULL DEFAULT 0");
ensureColumn("root_folders", "name", "name TEXT");
ensureColumn("quality_profiles", "max_size_gb", "max_size_gb REAL");
ensureColumn("import_lists", "min_rating", "min_rating REAL");
ensureColumn("import_lists", "min_votes", "min_votes INTEGER");
ensureColumn("import_lists", "exclude_genres", "exclude_genres TEXT");
ensureColumn(
  "queue",
  "download_path",
  "download_path TEXT" // remote-path-mapping-translated location of this download, set by pollQueue when the client reports one (see services/downloadClient.ts's applyRemotePathMapping)
);
ensureColumn("download_clients", "download_types", "download_types TEXT");
ensureColumn("media_items", "digital_release_date", "digital_release_date TEXT");
ensureColumn("media_items", "physical_release_date", "physical_release_date TEXT");
ensureColumn("users", "display_name", "display_name TEXT");
ensureColumn("users", "avatar_path", "avatar_path TEXT");
ensureColumn("users", "bio", "bio TEXT");
ensureColumn("users", "social_links", "social_links TEXT");
// A JSON array of strings, same storage convention as extra_metadata/performers (genres are
// multi-valued, unlike content_rating's single-scalar column) — see mediaQuery.ts for how
// filter/sort/search treat this as JSON text rather than a real array column.
ensureColumn("media_items", "genres", "genres TEXT");

/**
 * One-time transition marker for the course/adult "collection"/"single" -> "episodic" shape change
 * (see services/mediaTypes.ts's effectiveShape()): every existing course/adult row is stamped with
 * its OLD shape the moment this column is first created, so it keeps rendering/behaving exactly as
 * it did before the config flip until an admin explicitly runs "Convert to Episodic" for that
 * library (routes/media.ts's POST /media/convert-to-episodic, which clears the stamp back to NULL
 * once it restructures the row). Deliberately not a plain ensureColumn() call: unlike every
 * rerunnable backfill in this file, "does this row have a legacy_shape yet" is NOT a safe condition
 * to reapply on a later startup — by then, brand-new post-upgrade course/adult rows would exist
 * too, and this must never stamp those. Gating the one-time UPDATEs on "the column didn't exist
 * until this exact statement created it" is what makes this fire exactly once, ever.
 */
{
  const hasLegacyShapeColumn = (db.prepare(`PRAGMA table_info(media_items)`).all() as { name: string }[]).some(
    (c) => c.name === "legacy_shape"
  );
  if (!hasLegacyShapeColumn) {
    db.exec(`ALTER TABLE media_items ADD COLUMN legacy_shape TEXT`);
    db.prepare(`UPDATE media_items SET legacy_shape = 'collection' WHERE type = 'course'`).run();
    db.prepare(`UPDATE media_items SET legacy_shape = 'single' WHERE type = 'adult'`).run();
  }
}

/**
 * indexers.protocol and download_clients.type originally shipped with a rigid `CHECK (... IN (...))`
 * list. New protocol/client types (ddl, rss, http, ytdlp) need those values to be insertable, and
 * SQLite can't drop/alter a CHECK constraint in place — the table has to be rebuilt. This runs once
 * per column (idempotent: skipped once the constraint is already gone) and preserves all rows.
 *
 * `legacy_alter_table` matters here: modern SQLite's `RENAME TO` helpfully rewrites any other
 * table's `REFERENCES old_name(...)` clause to the new name — which is exactly wrong mid-migration,
 * since the "new name" is the throwaway `_pre_migration` table we're about to drop. Without
 * disabling that, e.g. `queue.download_client_id`'s FK ends up permanently pointing at a table
 * that no longer exists, and every INSERT into queue starts failing with "no such table". Turning
 * it on for the duration of the rename keeps other tables' REFERENCES text untouched, so it keeps
 * meaning "download_clients" — which is exactly what still exists once the rebuild finishes.
 */
function dropCheckConstraint(table: string, rebuiltCreateSql: string) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!row || !row.sql.includes("CHECK")) return;

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_migration`);
    db.exec(rebuiltCreateSql);
    db.exec(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM ${table}_pre_migration`);
    db.exec(`DROP TABLE ${table}_pre_migration`);
  })();
  db.pragma("legacy_alter_table = OFF");
}

/**
 * Repairs a table whose own REFERENCES text got rewritten to point at a `_pre_migration` throwaway
 * table by an earlier run of the bug described above (only matters for a database that already
 * went through that buggy migration once — safe/idempotent no-op otherwise).
 */
function repairDanglingReference(table: string, correctCreateSql: string) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!row || !row.sql.includes("_pre_migration")) return;

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_repair`);
    db.exec(correctCreateSql);
    db.exec(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM ${table}_repair`);
    db.exec(`DROP TABLE ${table}_repair`);
  })();
  db.pragma("legacy_alter_table = OFF");
}

dropCheckConstraint(
  "indexers",
  `CREATE TABLE indexers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     protocol TEXT NOT NULL,
     url TEXT NOT NULL,
     api_key TEXT,
     categories TEXT NOT NULL DEFAULT '',
     media_types TEXT NOT NULL DEFAULT 'movie,series,anime,artist,author,audiobook,comic,manga,rom,video,course,adult',
     enabled INTEGER NOT NULL DEFAULT 1,
     priority INTEGER NOT NULL DEFAULT 25,
     config TEXT,
     use_flaresolverr INTEGER NOT NULL DEFAULT 0,
     query_limit_per_hour INTEGER
   )`
);

dropCheckConstraint(
  "download_clients",
  `CREATE TABLE download_clients (
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
     enabled INTEGER NOT NULL DEFAULT 1,
     audio_only INTEGER NOT NULL DEFAULT 0,
     download_types TEXT
   )`
);

repairDanglingReference(
  "queue",
  `CREATE TABLE queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
     episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
     sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE,
     season_number INTEGER,
     title TEXT NOT NULL,
     indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
     download_client_id INTEGER REFERENCES download_clients(id) ON DELETE SET NULL,
     download_id TEXT,
     size INTEGER,
     quality TEXT,
     status TEXT NOT NULL DEFAULT 'queued',
     progress REAL NOT NULL DEFAULT 0,
     added_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_progress_at TEXT,
     download_path TEXT,
     retry_count INTEGER NOT NULL DEFAULT 0
   )`
);

/**
 * users.role originally shipped CHECK'd to 'user' only. Unlike dropCheckConstraint (which drops
 * the CHECK entirely and so can key off "does the CHECK clause still exist"), this widens it to
 * also allow 'admin' — the rebuilt table still has a CHECK clause, so that same "still has CHECK"
 * test would never be able to tell "already migrated" apart from "needs migrating" and would
 * rebuild the table (harmlessly, but wastefully) on every single startup. Keying off whether
 * 'admin' is already an allowed value avoids that.
 */
function ensureUsersAdminRole() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'admin'")) return;

  const cols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  db.pragma("legacy_alter_table = ON");
  db.transaction(() => {
    db.exec(`ALTER TABLE users RENAME TO users_pre_migration`);
    db.exec(`CREATE TABLE users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       max_pending_requests INTEGER,
       auto_approve INTEGER NOT NULL DEFAULT 0,
       max_content_rating TEXT,
       totp_secret TEXT,
       totp_enabled INTEGER NOT NULL DEFAULT 0
     )`);
    db.exec(`INSERT INTO users (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM users_pre_migration`);
    db.exec(`DROP TABLE users_pre_migration`);
  })();
  db.pragma("legacy_alter_table = OFF");
}
ensureUsersAdminRole();

// Every table with a `REFERENCES users(...)` foreign key needs the same dangling-reference repair
// as queue above (and blocklist further below), in case an earlier run of this migration (or the
// indexers/download_clients ones) already rewrote their FK text to point at a throwaway
// `_pre_migration` table.
repairDanglingReference(
  "user_library_access",
  `CREATE TABLE user_library_access (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     media_type TEXT NOT NULL,
     PRIMARY KEY (user_id, media_type)
   )`
);

repairDanglingReference(
  "sessions",
  `CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT NOT NULL,
     last_used_at TEXT,
     user_agent TEXT
   )`
);

repairDanglingReference(
  "requests",
  `CREATE TABLE requests (
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
   )`
);

repairDanglingReference(
  "audit_log",
  `CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     username TEXT NOT NULL,
     event_type TEXT NOT NULL,
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`
);

repairDanglingReference(
  "push_subscriptions",
  `CREATE TABLE push_subscriptions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     endpoint TEXT NOT NULL UNIQUE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
   )`
);

repairDanglingReference(
  "blocklist",
  `CREATE TABLE blocklist (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
     release_title TEXT NOT NULL,
     indexer_id INTEGER REFERENCES indexers(id) ON DELETE SET NULL,
     reason TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`
);

dropCheckConstraint(
  "import_lists",
  `CREATE TABLE import_lists (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     url TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     quality_profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
     last_synced_at TEXT,
     last_added_count INTEGER,
     last_error TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     require_review INTEGER NOT NULL DEFAULT 0,
     min_rating REAL,
     min_votes INTEGER,
     exclude_genres TEXT
   )`
);

const DEFAULT_QUALITY_SEED = [
  "SD",
  "DVD",
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "HDTV-1080p",
  "WEBRip-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-1080p",
  "HDTV-2160p",
  "WEBRip-2160p",
  "WEBDL-2160p",
  "Bluray-2160p",
  "Remux-2160p",
];
const qualityCount = (db.prepare("SELECT COUNT(*) as c FROM qualities").get() as { c: number }).c;
if (qualityCount === 0) {
  const insert = db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)");
  const insertMany = db.transaction((names: string[]) => {
    names.forEach((name, rank) => insert.run(name, rank));
  });
  insertMany(DEFAULT_QUALITY_SEED);
}

const defaultProfile = db
  .prepare("SELECT id FROM quality_profiles WHERE name = ?")
  .get("Any");
if (!defaultProfile) {
  db.prepare(
    "INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)"
  ).run(
    "Any",
    JSON.stringify(["SD", "HDTV-720p", "WEBDL-720p", "HDTV-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-2160p"]),
    "WEBDL-1080p"
  );
}

const existingApiKey = db.prepare("SELECT value FROM settings WHERE key = 'apiKey'").get();
if (!existingApiKey) {
  const apiKey = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES ('apiKey', ?)").run(apiKey);
  // This whole file's top-level setup still runs even when AONARR_DATABASE_DRIVER=postgres —
  // every not-yet-converted file that still imports `db/client.ts` directly (see
  // DATABASE_MIGRATION.md) triggers it as an ES module side effect, maintaining an orphaned local
  // SQLite database nothing in postgres mode actually reads from. Printing "here's your API key"
  // for a key that lives in the database the app *isn't* using would be actively misleading — the
  // real one comes from db/postgresSeed.ts instead — so this banner is suppressed specifically in
  // postgres mode, even though the shadow SQLite file still quietly gets seeded either way.
  if (config.databaseDriver !== "postgres") {
    console.log("=".repeat(60));
    console.log(`[startup] generated AoNarr API key: ${apiKey}`);
    console.log("Use this to log into the web UI. Find it again later in Settings.");
    console.log("=".repeat(60));
  }
}

// One-time backfill for library_search_fts (see schema.sql) — the triggers there only fire on
// rows changed after the virtual table exists, so an install upgrading from before this table
// existed needs its already-present media_items/episodes/sub_items rows indexed by hand, once.
// Guarded on the fts table being empty (not a version flag) so it's naturally a no-op on a fresh
// install (nothing to backfill yet) and idempotent on every subsequent boot.
{
  const ftsCount = (db.prepare("SELECT COUNT(*) AS c FROM library_search_fts").get() as { c: number }).c;
  const mediaItemCount = (db.prepare("SELECT COUNT(*) AS c FROM media_items").get() as { c: number }).c;
  if (ftsCount === 0 && mediaItemCount > 0) {
    db.exec(`
      INSERT INTO library_search_fts (media_item_id, match_type, source_id, match_detail, title)
      SELECT id, 'title', id, NULL, title FROM media_items;
      INSERT INTO library_search_fts (media_item_id, match_type, source_id, match_detail, title)
      SELECT media_item_id, 'episode', id, title, title FROM episodes;
      INSERT INTO library_search_fts (media_item_id, match_type, source_id, match_detail, title)
      SELECT media_item_id, 'child', id, title, title FROM sub_items;
    `);
    console.log("[startup] backfilled library_search_fts for existing library rows");
  }
}
