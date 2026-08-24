import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { db } from "../db/index.js";
// SQLite-only snapshot path (Database.backup()) — no Postgres equivalent, see backupPostgres()
// below for that dialect's own approach via pg_dump. Same raw-handle-alongside-async-db pattern
// established in routes/system.ts.
import { db as sqliteDb } from "../db/client.js";
import { config } from "../config.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { uploadBackupToRemote } from "./remoteBackup.js";

const execFileAsync = promisify(execFile);

/** File extension a backup for the active dialect is stored/recognized under — lets rotation and
 * the manual restore upload tell a SQLite snapshot and a Postgres dump apart, and means switching
 * `AONARR_DATABASE_DRIVER` mid-deployment doesn't accidentally rotate out or misidentify the other
 * dialect's old backups. */
export function backupFileExtension(): "db" | "dump" {
  return db.dialect === "postgres" ? "dump" : "db";
}

/** SQLite: better-sqlite3's own online backup API (safe mid-write, no need to pause the app). */
async function backupSqlite(destPath: string): Promise<void> {
  await sqliteDb.backup(destPath);
}

/** Postgres: shells out to `pg_dump` in custom format (`-Fc`) — compressed, and the only format
 * `pg_restore` can selectively/parallel-restore from. Requires the `postgresql-client` package in
 * the image (added alongside this) and `AONARR_DATABASE_URL` to be set, which is already required
 * for `AONARR_DATABASE_DRIVER=postgres` to start at all. */
async function backupPostgres(destPath: string): Promise<void> {
  if (!config.databaseUrl) throw new Error("AONARR_DATABASE_URL is not set");
  await execFileAsync("pg_dump", ["--format=custom", `--file=${destPath}`, config.databaseUrl]);
}

export async function writeBackup(destPath: string): Promise<void> {
  if (db.dialect === "postgres") await backupPostgres(destPath);
  else await backupSqlite(destPath);
}

/** Postgres restore: `pg_restore --clean --if-exists` drops and recreates every object the dump
 * contains before reloading it, so (unlike the SQLite path) the app never needs to stop touching
 * the database or exit — the pool's existing connections just see the schema change happen live.
 * Deliberately NOT `--single-transaction`: a `pg_dump`/`pg_restore` client newer than the target
 * server (e.g. this image's client 17 dumping/restoring against a still-common server 15/16) emits
 * session-level `SET` preamble commands for GUCs that only exist on the newer server
 * (`transaction_timeout`, added in 17) — harmless to skip, but `--single-transaction` implies
 * `--exit-on-error` and aborts the *entire* restore over that one cosmetic statement.
 * `pg_restore`'s own default (continue past errors, report a count at the end) tolerates it. */
export async function restorePostgres(srcPath: string): Promise<void> {
  if (!config.databaseUrl) throw new Error("AONARR_DATABASE_URL is not set");
  try {
    await execFileAsync("pg_restore", ["--clean", "--if-exists", `--dbname=${config.databaseUrl}`, srcPath]);
  } catch (err) {
    // pg_restore exits non-zero whenever it skipped ANY statement, even the harmless
    // `unrecognized configuration parameter "transaction_timeout"` case above — a real newer-
    // client-than-server version mismatch, not a sign the restore itself failed (verified live: the
    // data is fully restored). Only the specific "N ignored, all of them that one GUC" shape is
    // treated as success; any other pg_restore error still surfaces as a real failure.
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const ignoredMatch = stderr.match(/errors ignored on restore: (\d+)/);
    const realErrors = stderr
      .split("\n")
      .filter((line) => line.includes("pg_restore: error:") && !line.includes('unrecognized configuration parameter "transaction_timeout"'));
    if (!ignoredMatch || realErrors.length > 0) throw err;
    log.warn(`[backup] pg_restore skipped ${ignoredMatch[1]} harmless statement(s) (client/server version mismatch) — restore otherwise succeeded`);
  }
}

/** Called hourly; only actually backs up once `backupIntervalHours` have elapsed since the last
 * one, so the interval is reconfigurable without needing to restart a cron job. Writes a
 * timestamped DB snapshot (SQLite: a `.db` file via better-sqlite3's backup API; Postgres: a
 * `.dump` file via `pg_dump`) into the configured backup directory and deletes the oldest ones
 * beyond the configured keep-count. No-ops (quietly) when scheduled backups aren't enabled or
 * no directory is configured — this runs unattended on a cron, so it must never throw. */
export async function runScheduledBackup(): Promise<void> {
  if (getSetting("backupEnabled") !== "1") return;

  const dir = getSetting("backupDir");
  if (!dir) {
    log.warn("[backup] scheduled backups are enabled but no backup directory is configured — skipping");
    return;
  }

  const intervalHours = Math.max(1, parseInt(getSetting("backupIntervalHours") ?? "24", 10) || 24);
  const lastRunAt = getSetting("lastScheduledBackupAt");
  if (lastRunAt) {
    const elapsedHours = (Date.now() - new Date(lastRunAt).getTime()) / (1000 * 60 * 60);
    if (elapsedHours < intervalHours) return;
  }

  const keepCount = Math.max(1, parseInt(getSetting("backupKeepCount") ?? "7", 10) || 7);
  const ext = backupFileExtension();

  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `aonarr-backup-${stamp}.${ext}`;
    const destPath = path.join(dir, fileName);
    await writeBackup(destPath);
    setSetting("lastScheduledBackupAt", new Date().toISOString());
    log.info(`[backup] wrote scheduled backup to ${destPath}`);

    await uploadBackupToRemote(destPath, fileName, keepCount);

    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("aonarr-backup-") && f.endsWith(`.${ext}`))
      .sort();
    const toDelete = existing.slice(0, Math.max(0, existing.length - keepCount));
    for (const file of toDelete) {
      fs.unlinkSync(path.join(dir, file));
      log.info(`[backup] rotated out old backup ${file}`);
    }
  } catch (err) {
    log.error("[backup] scheduled backup failed:", (err as Error).message);
  }
}
