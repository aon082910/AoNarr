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
     config TEXT
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
     audio_only INTEGER NOT NULL DEFAULT 0
   )`
);

repairDanglingReference(
  "queue",
  `CREATE TABLE queue (
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
// as queue/blocklist above, in case an earlier run of this migration (or the indexers/download_clients
// ones) already rewrote their FK text to point at a throwaway `_pre_migration` table.
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
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  console.log("=".repeat(60));
  console.log(`[startup] generated AoNarr API key: ${apiKey}`);
  console.log("Use this to log into the web UI. Find it again later in Settings.");
  console.log("=".repeat(60));
}
