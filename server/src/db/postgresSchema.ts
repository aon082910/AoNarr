import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AsyncDb } from "./asyncDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `schema.postgres.sql` is a mechanical translation of `schema.sql` (SQLite): the *only* two
 * substitutions needed were `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY` and
 * `datetime('now')` → an explicit UTC-formatted-as-text equivalent (so `created_at`-style TEXT
 * columns hold the exact same string shape on both backends — application code that does
 * `new Date(row.created_at)` or string-compares two such columns doesn't need to know which
 * backend it's talking to). Every other construct in the schema (TEXT/INTEGER/REAL columns,
 * REFERENCES ... ON DELETE CASCADE/SET NULL, UNIQUE, composite PRIMARY KEY, CHECK) is standard
 * ANSI SQL and needed no translation — see DATABASE_MIGRATION.md for the fuller audit.
 */
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "schema.postgres.sql"), "utf-8");

/**
 * Postgres equivalent of client.ts's `ensureColumn()` retrofits — but simpler, since Postgres
 * natively supports `ADD COLUMN IF NOT EXISTS` (SQLite doesn't, which is the entire reason
 * client.ts's version has to introspect `PRAGMA table_info` first and only ALTER when the column
 * is actually missing). This list is a direct, unmodified port of every `ensureColumn(...)` call
 * in client.ts — none of those DDL strings used AUTOINCREMENT or datetime('now'), so they're
 * already valid Postgres syntax verbatim. Keep this in sync manually when a future round adds a
 * new `ensureColumn(...)` call to client.ts for the SQLite path.
 */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS has_file INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS sub_item_id INTEGER REFERENCES sub_items(id) ON DELETE CASCADE`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS quality TEXT`,
  `ALTER TABLE episodes ADD COLUMN IF NOT EXISTS quality TEXT`,
  `ALTER TABLE sub_items ADD COLUMN IF NOT EXISTS quality TEXT`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS quality TEXT`,
  `ALTER TABLE quality_profiles ADD COLUMN IF NOT EXISTS min_format_score INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sub_items ADD COLUMN IF NOT EXISTS external_id TEXT`,
  `ALTER TABLE sub_items ADD COLUMN IF NOT EXISTS external_provider TEXT`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS protected INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS max_pending_requests INTEGER`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_approve INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE root_folders ADD COLUMN IF NOT EXISTS last_scanned_at TEXT`,
  `ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tags ADD COLUMN IF NOT EXISTS retention_days INTEGER`,
  `ALTER TABLE collections ADD COLUMN IF NOT EXISTS retention_days INTEGER`,
  `ALTER TABLE indexers ADD COLUMN IF NOT EXISTS config TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT`,
  `ALTER TABLE subtitle_providers ADD COLUMN IF NOT EXISTS config TEXT`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS media_info TEXT`,
  `ALTER TABLE episodes ADD COLUMN IF NOT EXISTS media_info TEXT`,
  `ALTER TABLE episodes ADD COLUMN IF NOT EXISTS overview TEXT`,
  `ALTER TABLE sub_items ADD COLUMN IF NOT EXISTS media_info TEXT`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE indexers ADD COLUMN IF NOT EXISTS use_flaresolverr INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS content_rating TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS max_content_rating TEXT`,
  `ALTER TABLE collections ADD COLUMN IF NOT EXISTS smart_filter TEXT`,
  `ALTER TABLE root_folders ADD COLUMN IF NOT EXISTS quota_percent INTEGER`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES library_groups(id) ON DELETE SET NULL`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS extra_metadata TEXT`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS last_progress_at TEXT`,
  `ALTER TABLE queue ADD COLUMN IF NOT EXISTS season_number INTEGER`,
  `ALTER TABLE download_clients ADD COLUMN IF NOT EXISTS audio_only INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE root_folders ADD COLUMN IF NOT EXISTS pause_grabs_at_quota INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE library_groups ADD COLUMN IF NOT EXISTS overview TEXT`,
  `ALTER TABLE qualities ADD COLUMN IF NOT EXISTS preferred_size_mb INTEGER`,
  `ALTER TABLE custom_formats ADD COLUMN IF NOT EXISTS media_types TEXT`,
  `ALTER TABLE custom_formats ADD COLUMN IF NOT EXISTS trash_id TEXT`,
  `ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS restoring INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS restore_error TEXT`,
  `ALTER TABLE media_items ADD COLUMN IF NOT EXISTS release_date TEXT`,
  `ALTER TABLE sub_items ADD COLUMN IF NOT EXISTS poster_url TEXT`,
  `ALTER TABLE duplicate_group_seen ADD COLUMN IF NOT EXISTS dismissed INTEGER NOT NULL DEFAULT 0`,
];

/**
 * Widens 4 byte-count columns from Postgres's default 32-bit `INTEGER` (max ~2.1GB) to `BIGINT` —
 * `schema.postgres.sql`'s literal `INTEGER` translation of SQLite's `INTEGER` column type was wrong
 * specifically for these, since SQLite's own `INTEGER` affinity is already 64-bit with no separate
 * `BIGINT` needed, so nothing about porting the schema flagged this as needing a different type on
 * Postgres. In practice this meant any real download over ~2GB (a routine remux) silently failed to
 * record its size — `queue.size`, `recycle_bin.size_bytes`, and both `disk_usage_samples` columns
 * hold real byte counts, not megabytes. `ALTER COLUMN ... TYPE BIGINT` is a safe no-op to run on
 * every startup once a column is already `BIGINT` (Postgres doesn't error re-widening to the same
 * type), so this doesn't need separate migration-tracking bookkeeping.
 */
const TYPE_MIGRATIONS: string[] = [
  `ALTER TABLE queue ALTER COLUMN size TYPE BIGINT`,
  `ALTER TABLE recycle_bin ALTER COLUMN size_bytes TYPE BIGINT`,
  `ALTER TABLE disk_usage_samples ALTER COLUMN free_bytes TYPE BIGINT`,
  `ALTER TABLE disk_usage_samples ALTER COLUMN total_bytes TYPE BIGINT`,
];

export async function migratePostgresSchema(db: AsyncDb): Promise<void> {
  await db.exec(SCHEMA_SQL);
  for (const stmt of COLUMN_MIGRATIONS) {
    await db.exec(stmt);
  }
  for (const stmt of TYPE_MIGRATIONS) {
    await db.exec(stmt);
  }
}
