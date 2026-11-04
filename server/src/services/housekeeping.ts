import fs from "node:fs";
import os from "node:os";
import { db } from "../db/index.js";
import { db as sqliteDb } from "../db/client.js";
import { config } from "../config.js";
import { failedRestoreSuffix } from "../restoreGuard.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { ENCRYPTION_KEY_PATH } from "./encryption.js";
import { createYielder, statfsAsync } from "./fsAsync.js";
import { log } from "./logger.js";
import { vacuumSqliteInWorker } from "./backupZip.js";

/**
 * The daily housekeeping job (Sonarr's HousekeepingService, reduced to what AoNarr's tables and files need).
 * Nothing used to delete from `history`, `watch_events` (659,897 rows on the live database), `audit_log` or
 * expired `sessions`, and nothing ever shrank the database file after the large deletions this project does,
 * so backups, the Dashboard queries and the health scans only grew. Foreign keys cascade, so orphan rows are
 * mostly prevented already; what is missing is trimming by age and giving the space back.
 *
 * Retention is a setting per table, in days, with a default of one year; 0 keeps everything. Below 30 days
 * is treated as 30 so a typo cannot wipe the recent history the Activity page shows.
 */
export const DEFAULT_RETENTION_DAYS = 365;
export const MIN_RETENTION_DAYS = 30;
const JOB_RUN_RETENTION_DAYS = 30;
const RSS_DECISION_RETENTION_DAYS = 14;
const DELETE_CHUNK = 5000;
const LEFTOVER_FILE_DAYS = 7;
const VACUUM_EVERY_DAYS = 30;
const CHECKPOINT_EVERY_DAYS = 6;
/** A VACUUM rewrites the file and blocks the process while it does, so it only runs when it would give
 * back a worthwhile share of the file. */
const VACUUM_MIN_RECLAIMABLE_BYTES = 100 * 1024 * 1024;
const VACUUM_MIN_RECLAIMABLE_FRACTION = 0.1;

export interface HousekeepingResult {
  trimmed: Record<string, number>;
  leftoversRemoved: string[];
  checkpointed: boolean;
  vacuumed: boolean;
  skippedVacuum: string | null;
}

/** The retention for one table: the setting in days, the default when unset or not a number, 0 for "keep forever". */
export function retentionDays(settingKey: string): number {
  const raw = getSetting(settingKey);
  if (raw === null || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS;
  if (days === 0) return 0;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(days));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** SQLite's datetime('now') default writes "YYYY-MM-DD HH:MM:SS" while code that formats its own timestamps
 * writes ISO ("...T...Z"); a cutoff in the first shape compares correctly against both at day granularity. */
function sqlTimestamp(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

/** Deletes rows older than `cutoffIso`, `DELETE_CHUNK` at a time, giving the event loop a turn between chunks.
 * `keepWhere` is an extra condition a row must also meet to be deleted. */
async function trimTable(
  table: string,
  column: string,
  cutoffIso: string,
  giveTurn: () => Promise<void>,
  signal?: AbortSignal,
  keepWhere = ""
): Promise<number> {
  let total = 0;
  for (;;) {
    if (signal?.aborted) break;
    const result = await db
      .prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} < ? ${keepWhere} ORDER BY id LIMIT ${DELETE_CHUNK})`)
      .run(sqlTimestamp(cutoffIso));
    total += result.changes;
    await giveTurn();
    if (result.changes < DELETE_CHUNK) break;
  }
  return total;
}

function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (Date.now() - ms) / (24 * 60 * 60 * 1000) : Infinity;
}

/** A restore leaves `aonarr.db.pre-restore` and `encryption.key.pre-restore` as the way back. They are safe to
 * delete once the restored database has been running for a week. */
function removeLeftoverFiles(): string[] {
  const removed: string[] = [];
  for (const file of [
    `${config.dbPath}.pre-restore`,
    `${ENCRYPTION_KEY_PATH}.pre-restore`,
    // What an automatic swap-back set aside (restoreGuard.ts): kept as long as the other leftovers, then removed.
    `${config.dbPath}${failedRestoreSuffix()}`,
    `${ENCRYPTION_KEY_PATH}${failedRestoreSuffix()}`,
  ]) {
    try {
      const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / (24 * 60 * 60 * 1000);
      if (ageDays >= LEFTOVER_FILE_DAYS) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch {
      // not there, or not removable: nothing to do
    }
  }
  return removed;
}

async function maintainSqlite(result: HousekeepingResult): Promise<void> {
  try {
    sqliteDb.pragma("optimize");
  } catch (err) {
    log.warn("[housekeeping] PRAGMA optimize failed:", (err as Error).message);
  }

  if (daysSince(getSetting("lastWalCheckpointAt")) >= CHECKPOINT_EVERY_DAYS) {
    try {
      sqliteDb.pragma("wal_checkpoint(TRUNCATE)");
      setSetting("lastWalCheckpointAt", new Date().toISOString());
      result.checkpointed = true;
    } catch (err) {
      log.warn("[housekeeping] WAL checkpoint failed:", (err as Error).message);
    }
  }

  if (getSetting("housekeepingVacuum") === "0") {
    result.skippedVacuum = "turned off";
    return;
  }
  if (daysSince(getSetting("lastVacuumAt")) < VACUUM_EVERY_DAYS) return;

  const pageSize = Number(sqliteDb.pragma("page_size", { simple: true }));
  const pageCount = Number(sqliteDb.pragma("page_count", { simple: true }));
  const freePages = Number(sqliteDb.pragma("freelist_count", { simple: true }));
  const fileBytes = pageSize * pageCount;
  const reclaimable = pageSize * freePages;
  if (reclaimable < VACUUM_MIN_RECLAIMABLE_BYTES && reclaimable < fileBytes * VACUUM_MIN_RECLAIMABLE_FRACTION) {
    result.skippedVacuum = "little to give back";
    setSetting("lastVacuumAt", new Date().toISOString());
    return;
  }
  // VACUUM writes a full copy before it replaces the file, in the database's folder and in SQLite's temp folder.
  const [free, tmpFree] = await Promise.all([statfsAsync(config.configDir, 10_000).catch(() => null), statfsAsync(os.tmpdir(), 10_000).catch(() => null)]);
  if (!free || free.bavail * free.bsize < fileBytes * 1.5 || !tmpFree || tmpFree.bavail * tmpFree.bsize < fileBytes * 1.2) {
    result.skippedVacuum = "not enough free disk space for the copy it makes";
    log.warn(`[housekeeping] VACUUM skipped: ${result.skippedVacuum}`);
    return;
  }
  try {
    log.info(`[housekeeping] VACUUM starting: writes to the database wait while it rewrites the ${Math.round(fileBytes / 1e6)} MB file; reads and the health check carry on`);
    const started = Date.now();
    // On a worker thread with its own connection (the main thread stayed frozen, and Docker's health check with it).
    // Writes from the app are held (not failed) meanwhile: on the main connection a write that meets VACUUM's lock sleeps
    // the whole event loop in SQLite's busy handler for up to 5 s and then throws.
    const resumeWrites = db.pauseWrites?.();
    try {
      await vacuumSqliteInWorker(config.dbPath);
    } finally {
      resumeWrites?.();
    }
    setSetting("lastVacuumAt", new Date().toISOString());
    result.vacuumed = true;
    log.info(`[housekeeping] VACUUM gave back about ${Math.round(reclaimable / 1e6)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    // A lock that did not clear in two minutes (a long write on the main connection), or a full disk. Tomorrow.
    result.skippedVacuum = (err as Error).message;
    log.warn("[housekeeping] VACUUM failed, will retry on the next run:", (err as Error).message);
  }
}

export async function runHousekeeping(signal?: AbortSignal): Promise<HousekeepingResult> {
  const result: HousekeepingResult = { trimmed: {}, leftoversRemoved: [], checkpointed: false, vacuumed: false, skippedVacuum: null };
  const giveTurn = createYielder();

  // "Watched" is not an event log: the Media page answers "watched" from the existence of the newest watch_events
  // row of the item (the manual mark-watched button inserts exactly one). So an old row is only deleted when a
  // newer one for the same title/episode/part exists; the latest always stays, however old.
  const same = db.dialect === "postgres" ? "IS NOT DISTINCT FROM" : "IS";
  const notTheLatestWatch = `AND EXISTS (SELECT 1 FROM watch_events n WHERE n.media_item_id = watch_events.media_item_id AND n.episode_id ${same} watch_events.episode_id AND n.sub_item_id ${same} watch_events.sub_item_id AND n.watched_at > watch_events.watched_at)`;
  // A job that runs rarely (a monthly schedule) keeps its newest row, so its last result and failures are not forgotten.
  const notTheLatestRun = "AND id NOT IN (SELECT MAX(id) FROM job_runs GROUP BY job_key)";
  const plan: { table: string; column: string; days: number; keepWhere?: string }[] = [
    { table: "history", column: "created_at", days: retentionDays("housekeepingHistoryDays") },
    { table: "watch_events", column: "watched_at", days: retentionDays("housekeepingWatchEventDays"), keepWhere: notTheLatestWatch },
    { table: "audit_log", column: "created_at", days: retentionDays("housekeepingAuditDays") },
    { table: "job_runs", column: "started_at", days: JOB_RUN_RETENTION_DAYS, keepWhere: notTheLatestRun },
    // The RSS sync keeps the newest few hundred decisions itself; a quiet feed would leave old ones for ever.
    { table: "rss_decisions", column: "created_at", days: RSS_DECISION_RETENTION_DAYS },
  ];
  for (const { table, column, days, keepWhere } of plan) {
    if (days <= 0 || signal?.aborted) continue;
    const removed = await trimTable(table, column, isoDaysAgo(days), giveTurn, signal, keepWhere);
    if (removed > 0) result.trimmed[table] = removed;
  }

  // Sessions that expired are only removed today when the same token is used again. No id column.
  const expired = await db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  if (expired.changes > 0) result.trimmed.sessions = expired.changes;

  result.leftoversRemoved = removeLeftoverFiles();
  if (db.dialect === "sqlite" && !signal?.aborted) await maintainSqlite(result);

  const summary = Object.entries(result.trimmed).map(([table, n]) => `${table} ${n}`);
  if (summary.length > 0 || result.leftoversRemoved.length > 0 || result.vacuumed) {
    log.info(
      `[housekeeping] removed rows older than their retention (${summary.join(", ") || "none"})` +
        (result.leftoversRemoved.length ? `, deleted ${result.leftoversRemoved.join(", ")}` : "")
    );
  }
  return result;
}
