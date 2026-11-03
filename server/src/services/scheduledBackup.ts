import crypto from "node:crypto";
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
import { ENCRYPTION_KEY_PATH, decryptValue } from "./encryption.js";
import { getPreMigrationProblem } from "../db/preMigrationBackup.js";
import { checkSqliteFileInWorker, unzipBundleInWorker, zipFilesInWorker } from "./backupZip.js";

const execFileAsync = promisify(execFile);

/** File extension a raw DB snapshot for the active dialect is stored under inside a backup
 * bundle (see DB_ENTRY_NAME) — lets restore tell a SQLite snapshot and a Postgres dump apart, and
 * means switching `AONARR_DATABASE_DRIVER` mid-deployment doesn't misidentify an old bundle made
 * under the other dialect. */
export function backupFileExtension(): "db" | "dump" {
  return db.dialect === "postgres" ? "dump" : "db";
}

/** Bundles (as a zip) ship as `.aonarrbackup` — deliberately not `.zip`, so it doesn't invite
 * being opened/extracted by hand and having just the db file re-uploaded on restore (which would
 * silently skip the encryption key). Older single-file `.db`/`.dump` backups made before this
 * bundling existed are still accepted on restore for backward compatibility — see routes/system.ts. */
export const BACKUP_BUNDLE_EXTENSION = "aonarrbackup";
const DB_ENTRY_NAME = "db";
const KEY_ENTRY_NAME = "encryption.key";

/** Scheduled backups are named with this prefix and are the only files the keep-count rotation may
 * delete. A backup the admin asked for ("Backup Now" / Download) is named with MANUAL_BACKUP_PREFIX
 * and is never rotated out, as in Sonarr and Radarr. */
export const SCHEDULED_BACKUP_PREFIX = "aonarr-backup-";
export const MANUAL_BACKUP_PREFIX = "aonarr-manual-";
/** Name of the temporary database snapshot a bundle is built from (beside the live database). */
const SNAPSHOT_PREFIX = ".backup-snapshot-";
/** How many "Backup Now" bundles are kept. The schedule never rotates them, but every click writes one. */
export const MANUAL_BACKUP_KEEP = 10;

/** Where backups go when Settings, Backup has no folder set: a fresh install is protected without anyone
 * finding that page first. Inside the config volume, so it survives container recreation. */
export function defaultBackupDir(): string {
  return path.join(config.configDir, "Backups", "scheduled");
}

export function getBackupDir(): string {
  return getSetting("backupDir") || defaultBackupDir();
}

/** Builds a backup bundle at `destPath`: the live DB snapshot plus `encryption.key` (when one
 * exists) zipped together, so a restore onto a different config volume can still decrypt every
 * settings credential the DB references — see encryption.ts's module doc for why the key is a
 * separate file in the first place, and why that meant it was silently left out of backups until
 * now.
 *
 * The snapshot is written beside the live database (the file system SQLite already runs on: not the
 * container's tmp, which on Unraid sits in docker.img, and not the backup folder, which may be a network
 * share where SQLite locking misbehaves). The zip runs on a worker thread (see backupZip.ts) and goes to
 * `destPath.partial` first, so a failed or half-written zip is never left looking like a backup. */
export async function writeBackupBundle(destPath: string): Promise<void> {
  const ext = backupFileExtension();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const snapshotPath = path.join(path.dirname(config.dbPath), `${SNAPSHOT_PREFIX}${process.pid}-${Date.now()}.src`);
  const partialPath = `${destPath}.partial`;
  try {
    await writeBackup(snapshotPath);
    const entries = [{ path: snapshotPath, name: `${DB_ENTRY_NAME}.${ext}` }];
    if (fs.existsSync(ENCRYPTION_KEY_PATH)) entries.push({ path: ENCRYPTION_KEY_PATH, name: KEY_ENTRY_NAME });
    await zipFilesInWorker(entries, partialPath);
    fs.renameSync(partialPath, destPath);
  } finally {
    fs.rmSync(snapshotPath, { force: true });
    fs.rmSync(partialPath, { force: true });
  }
}

/** Reads a backup bundle produced by writeBackupBundle: the raw DB snapshot bytes plus, when
 * present, the encryption key that was bundled alongside it. Inflated on a worker thread; a zip that
 * is truncated or damaged rejects with the zip library's message. */
export function readBackupBundle(zipBuffer: Buffer): Promise<{ dbBuffer: Buffer; keyBuffer: Buffer | null }> {
  return unzipBundleInWorker(zipBuffer, `${DB_ENTRY_NAME}.`, KEY_ENTRY_NAME);
}

/** Whether `dbBuffer` (the database inside an uploaded backup) can be restored: opens it read-only on
 * a worker thread, runs a quick integrity check and requires the media_items and settings tables.
 * Returns a sentence saying why not, or null. Restoring used to check only the 16-byte SQLite header,
 * answer "restored", swap the file and exit, so a damaged file (or another program's database) left an
 * app that failed to start the same way on every restart. */
export async function checkSqliteBackup(dbBuffer: Buffer): Promise<string | null> {
  const tmpPath = `${config.dbPath}.restore-check`;
  try {
    // A failure to write the check copy (a full disk) is ours, not the backup's: it propagates as an error.
    await fs.promises.writeFile(tmpPath, dbBuffer);
    try {
      return await checkSqliteFileInWorker(tmpPath, ["media_items", "settings"]);
    } catch (err) {
      return `it could not be opened as a database (${(err as Error).message})`;
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${tmpPath}${suffix}`, { force: true });
  }
}

/** True when `buffer` looks like a zip (backup bundle) rather than a legacy raw `.db`/`.dump`
 * file — the local zip magic number, `PK\x03\x04`. */
export function looksLikeBackupBundle(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
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
 * `pg_restore`'s own default (continue past errors, report a count at the end) tolerates it.
 * `--no-owner --no-privileges`: a dump from another install names that install's roles in its
 * OWNER TO / GRANT statements, which fail here ("role does not exist") after the data is in. */
export async function restorePostgres(srcPath: string): Promise<void> {
  if (!config.databaseUrl) throw new Error("AONARR_DATABASE_URL is not set");
  try {
    await execFileAsync("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", `--dbname=${config.databaseUrl}`, srcPath]);
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

const ENCRYPTED_COLUMNS: [table: string, column: string][] = [
  ["settings", "value"],
  ["indexers", "api_key"],
  ["download_clients", "password"],
  ["download_clients", "api_key"],
  ["irc_feeds", "sasl_pass"],
  ["ai_providers", "api_key"],
  ["subtitle_providers", "api_key"],
  ["remote_instances", "api_key"],
  ["friend_libraries", "token"],
];

/** A few `enc1:` values from every encrypted column, so no single stale or re-encrypted row decides. */
async function sampleEncryptedValues(): Promise<string[]> {
  const samples: string[] = [];
  for (const [table, column] of ENCRYPTED_COLUMNS) {
    try {
      const rows = (await db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} LIKE ? LIMIT 5`).all("enc1:%")) as { v: string }[];
      for (const row of rows) if (row.v) samples.push(row.v);
    } catch {
      // table missing after a partial restore
    }
  }
  return samples;
}

/** encryption.ts's `enc1:` AES-256-GCM format, tried with a key other than the installed one. */
function decryptsWithKey(key: Buffer, value: string): boolean {
  try {
    const raw = Buffer.from(value.slice(value.indexOf(":") + 1), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    decipher.update(raw.subarray(28));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

/**
 * After a Postgres restore attempt, whether the backup bundle's key should replace the installed
 * one. pg_restore's exit status doesn't say which key the live data needs: it can fail before
 * touching anything (old DB still live, still on the current key) or after all the data is in
 * (restored rows encrypted with the bundle's key). So the encrypted values actually in the database
 * decide, by which key opens more of them, and only when there are none does the restore's own exit
 * status.
 */
export async function restoredDbNeedsBundleKey(keyBuffer: Buffer, restoreSucceeded: boolean): Promise<boolean> {
  const samples = await sampleEncryptedValues();
  if (samples.length === 0) return restoreSucceeded;
  const bundleKeyHex = keyBuffer.toString("utf-8").trim();
  if (!/^[0-9a-f]{64}$/i.test(bundleKeyHex)) return false;
  const bundleKey = Buffer.from(bundleKeyHex, "hex");
  let bundleOk = 0;
  let currentOk = 0;
  for (const value of samples) {
    if (decryptsWithKey(bundleKey, value)) bundleOk++;
    try {
      decryptValue(value);
      currentOk++;
    } catch {
      // not the installed key's
    }
  }
  return bundleOk > currentOk;
}

/** The scheduled backup runs unless an admin switched it off. An install that never opened the Backup
 * page has no `backupEnabled` row, and that now means on (daily, keep 7, into the config volume). */
export function isScheduledBackupEnabled(): boolean {
  return getSetting("backupEnabled") !== "0";
}

const BACKUP_PROBLEM_KEY = "backupProblem";
const BACKUP_PROBLEM_AT_KEY = "backupProblemAt";
/** After a failed run the next try waits this long (or the backup interval when that is shorter), so a
 * full disk does not cost a snapshot and a zip every hour. A cheap failure (an unwritable folder) is
 * found before any work is done, and waits the same time. */
const BACKUP_RETRY_HOURS = 3;

/** The failure text without the temporary file names, so a retry that fails the same way produces the same
 * Health text (the health notification is sent once per distinct text). */
function describeBackupError(err: unknown): string {
  return ((err as Error).message ?? String(err)).replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+\.(?:partial|src)\b/g, "the backup file");
}

function recordBackupProblem(message: string): void {
  setSetting(BACKUP_PROBLEM_KEY, message);
  setSetting(BACKUP_PROBLEM_AT_KEY, new Date().toISOString());
}

/** A backup the admin took by hand worked, so a failed scheduled run no longer says the folder is unusable. */
export function noteManualBackupSucceeded(): void {
  clearBackupProblem();
}

function clearBackupProblem(): void {
  if (getSetting(BACKUP_PROBLEM_KEY)) setSetting(BACKUP_PROBLEM_KEY, "");
  if (getSetting(BACKUP_PROBLEM_AT_KEY)) setSetting(BACKUP_PROBLEM_AT_KEY, "");
}

/** Why scheduled backups are not working, for the Health page and the health notification, or null.
 * A failed run used to be a log line only. Null while scheduled backups are switched off. */
export function getBackupProblem(): string | null {
  const preMigration = getPreMigrationProblem();
  if (!isScheduledBackupEnabled()) return preMigration;
  const scheduled = getSetting(BACKUP_PROBLEM_KEY) || null;
  return [scheduled, preMigration].filter(Boolean).join(" ") || null;
}

/** Fails early, before any snapshot work, when the folder cannot be written by this process (a
 * folder created by root while the container runs as PUID is the usual cause). */
function assertWritableDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.aonarr-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
  } catch (err) {
    throw new Error(`The backup folder ${dir} is not writable: ${(err as Error).message}`);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** A crash mid-backup leaves a `.src` snapshot or a `.partial` zip behind; both are always safe to
 * delete once they are old enough that no run can still be using them. */
function removeStaleBackupLeftovers(dir: string): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const sweep = (folder: string, isLeftover: (name: string) => boolean) => {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isLeftover(name)) continue;
      const full = path.join(folder, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        // gone already
      }
    }
  };
  sweep(dir, (name) => name.endsWith(".partial") && (name.startsWith(SCHEDULED_BACKUP_PREFIX) || name.startsWith(MANUAL_BACKUP_PREFIX)));
  sweep(path.dirname(config.dbPath), (name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(".src"));
}

/** Keeps the newest `keep` "Backup Now" bundles in `dir` and removes the rest. Best effort: a file that cannot
 * be removed is left. Scheduled backups are never touched here. */
export function rotateManualBackups(dir: string, keep: number = MANUAL_BACKUP_KEEP): void {
  try {
    const manual = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(MANUAL_BACKUP_PREFIX) && (f.endsWith(`.${BACKUP_BUNDLE_EXTENSION}`) || f.endsWith(".db") || f.endsWith(".dump")))
      .sort();
    for (const file of manual.slice(0, Math.max(0, manual.length - keep))) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {
        // left in place
      }
    }
  } catch {
    // folder unreadable: nothing to trim
  }
}

/** Called hourly; only actually backs up once `backupIntervalHours` have elapsed since the last
 * one, so the interval is reconfigurable without needing to restart a cron job. Writes a
 * timestamped backup bundle (the DB snapshot plus `encryption.key`, see writeBackupBundle) into
 * the configured backup directory (the config volume's Backups/scheduled when none is set) and deletes
 * the oldest scheduled ones beyond the configured keep-count; a manual backup is never rotated out.
 * A failure is kept as a Health problem (see getBackupProblem) until the next success. This runs
 * unattended on a cron, so it must never throw. */
export async function runScheduledBackup(): Promise<void> {
  if (!isScheduledBackupEnabled()) return;

  const dir = getBackupDir();

  const intervalHours = Math.max(1, parseInt(getSetting("backupIntervalHours") ?? "24", 10) || 24);
  const lastRunAt = getSetting("lastScheduledBackupAt");
  if (lastRunAt) {
    const elapsedHours = (Date.now() - new Date(lastRunAt).getTime()) / (1000 * 60 * 60);
    if (elapsedHours < intervalHours) return;
  }
  const problemAt = getSetting(BACKUP_PROBLEM_AT_KEY);
  if (problemAt) {
    const sinceFailureHours = (Date.now() - new Date(problemAt).getTime()) / (1000 * 60 * 60);
    if (sinceFailureHours < Math.min(intervalHours, BACKUP_RETRY_HOURS)) return;
  }

  const keepCount = Math.max(1, parseInt(getSetting("backupKeepCount") ?? "7", 10) || 7);

  try {
    assertWritableDir(dir);
    removeStaleBackupLeftovers(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${SCHEDULED_BACKUP_PREFIX}${stamp}.${BACKUP_BUNDLE_EXTENSION}`;
    const destPath = path.join(dir, fileName);
    await writeBackupBundle(destPath);
    setSetting("lastScheduledBackupAt", new Date().toISOString());
    clearBackupProblem();
    log.info(`[backup] wrote scheduled backup to ${destPath}`);

    // Off-site copy first: a rotation error below must not cost today's upload.
    const remoteError = await uploadBackupToRemote(destPath, fileName, keepCount);
    if (remoteError) recordBackupProblem(`The backup was saved here but the remote copy failed: ${remoteError}`);

    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(SCHEDULED_BACKUP_PREFIX) && (f.endsWith(`.${BACKUP_BUNDLE_EXTENSION}`) || f.endsWith(".db") || f.endsWith(".dump")))
      .sort();
    const toDelete = existing.slice(0, Math.max(0, existing.length - keepCount));
    for (const file of toDelete) {
      fs.unlinkSync(path.join(dir, file));
      log.info(`[backup] rotated out old backup ${file}`);
    }
  } catch (err) {
    log.error("[backup] scheduled backup failed:", (err as Error).message);
    recordBackupProblem(`Scheduled backup failed: ${describeBackupError(err)}`);
  }
}
