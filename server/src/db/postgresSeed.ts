import crypto from "node:crypto";
import type { AsyncDb } from "./asyncDb.js";
import { DEFAULT_QUALITY_ORDER } from "../services/quality.js";

/**
 * Async port of `db/client.ts`'s first-boot seeding (default qualities, the "Any" quality profile,
 * and the instance API key) — those run as SQLite-only synchronous top-level side effects and have
 * no equivalent for Postgres. Without this, a fresh Postgres database would have no qualities, no
 * default quality profile, and — critically — no generated API key, meaning nobody could even log
 * into a fresh Postgres-backed instance. Idempotent the same way the SQLite version is: each step
 * only acts when the table it seeds is still empty.
 */
export async function seedPostgresDefaults(db: AsyncDb): Promise<void> {
  await upgradeLegacyPostgresColumns(db);

  const qualityCount = Number(((await db.prepare("SELECT COUNT(*) AS c FROM qualities").get()) as { c: number }).c);
  if (qualityCount === 0) {
    for (let rank = 0; rank < DEFAULT_QUALITY_ORDER.length; rank++) {
      await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run(DEFAULT_QUALITY_ORDER[rank], rank);
    }
  }

  // Seeded only into an EMPTY table, never "whenever no profile is named Any" — that re-created
  // the default profile on every restart after an admin renamed or deleted it.
  const profileCount = Number(((await db.prepare("SELECT COUNT(*) AS c FROM quality_profiles").get()) as { c: number }).c);
  if (profileCount === 0) {
    await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
      .run(
        "Any",
        JSON.stringify(["SD", "HDTV-720p", "WEBDL-720p", "HDTV-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-2160p"]),
        "WEBDL-1080p"
      );
  }

  const existingApiKey = await db.prepare("SELECT value FROM settings WHERE key = 'apiKey'").get();
  if (!existingApiKey) {
    const apiKey = crypto.randomBytes(24).toString("hex");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('apiKey', ?)").run(apiKey);
    console.log("=".repeat(60));
    console.log(`[startup] generated AoNarr API key: ${apiKey}`);
    console.log("Use this to log into the web UI. Find it again later in Settings.");
    console.log("=".repeat(60));
  }
}

const INDEXER_DEFAULT_MEDIA_TYPES = "movie,series,anime,sports,ppv,artist,author,audiobook,comic,manga,rom,course,adult";
// Every value indexers.media_types was ever given implicitly: past schema defaults plus the
// add-indexer route's old fallback.
const LEGACY_INDEXER_MEDIA_TYPE_DEFAULTS = [
  "movie,series,artist,author",
  "movie,series,anime,artist,author,comic,rom,video,course,adult",
  "movie,series,anime,artist,author,audiobook,comic,rom,video,course,adult",
  "movie,series,anime,artist,author,audiobook,comic,manga,rom,video,course,adult",
];

/**
 * Brings a Postgres database created from an older schema.postgres.sql up to date (CREATE TABLE IF
 * NOT EXISTS never changes an existing column), on every Postgres startup, before anything reads it:
 * - queue.progress was REAL, which is float4 on Postgres. A client's full-precision progress never
 *   equalled the value read back, so every poll counted as movement and stalled downloads were
 *   never cleaned up.
 * - indexers.media_types' default never included sports or ppv, so indexers added without an
 *   explicit list (Jackett/Prowlarr sync) were never searched for them. Rows are widened only while
 *   the old default is still in place, so this runs once and never overrides a list an admin picks
 *   later (the SQLite twin is client.ts's upgradeIndexerMediaTypesDefault).
 */
export async function upgradeLegacyPostgresColumns(db: AsyncDb): Promise<void> {
  if (db.dialect !== "postgres") return;

  const progress = (await db
    .prepare(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'queue' AND column_name = 'progress'`
    )
    .get()) as { data_type: string } | undefined;
  if (progress?.data_type === "real") {
    await db.exec(`ALTER TABLE queue ALTER COLUMN progress TYPE DOUBLE PRECISION USING progress::double precision`);
  }

  const mediaTypes = (await db
    .prepare(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'indexers' AND column_name = 'media_types'`
    )
    .get()) as { column_default: string | null } | undefined;
  if (mediaTypes && !(mediaTypes.column_default ?? "").includes(`'${INDEXER_DEFAULT_MEDIA_TYPES}'`)) {
    await db.transaction(async () => {
      await db.exec(`ALTER TABLE indexers ALTER COLUMN media_types SET DEFAULT '${INDEXER_DEFAULT_MEDIA_TYPES}'`);
      await db
        .prepare(
          `UPDATE indexers SET media_types = ? WHERE media_types IN (${LEGACY_INDEXER_MEDIA_TYPE_DEFAULTS.map(() => "?").join(", ")})`
        )
        .run(INDEXER_DEFAULT_MEDIA_TYPES, ...LEGACY_INDEXER_MEDIA_TYPE_DEFAULTS);
    });
  }
}
