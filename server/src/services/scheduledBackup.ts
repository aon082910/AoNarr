import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
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

/** Builds a backup bundle at `destPath`: the live DB snapshot plus `encryption.key` (when one
 * exists) zipped together, so a restore onto a different config volume can still decrypt every
 * settings credential the DB references — see encryption.ts's module doc for why the key is a
 * separate file in the first place, and why that meant it was silently left out of backups until
 * now. */
export async function writeBackupBundle(destPath: string): Promise<void> {
  const ext = backupFileExtension();
  const tmpDbPath = path.join(os.tmpdir(), `aonarr-backup-src-${Date.now()}.${ext}`);
  try {
    await writeBackup(tmpDbPath);
    const zip = new AdmZip();
    zip.addLocalFile(tmpDbPath, "", `${DB_ENTRY_NAME}.${ext}`);
    if (fs.existsSync(ENCRYPTION_KEY_PATH)) {
      zip.addLocalFile(ENCRYPTION_KEY_PATH, "", KEY_ENTRY_NAME);
    }
    zip.writeZip(destPath);
  } finally {
    fs.unlink(tmpDbPath, () => {});
  }
}

/** Reads a backup bundle produced by writeBackupBundle: the raw DB snapshot bytes plus, when
 * present, the encryption key that was bundled alongside it. */
export function readBackupBundle(zipBuffer: Buffer): { dbBuffer: Buffer; keyBuffer: Buffer | null } {
  const zip = new AdmZip(zipBuffer);
  const dbEntry = zip.getEntries().find((e) => e.entryName.startsWith(`${DB_ENTRY_NAME}.`));
  if (!dbEntry) throw new Error("Backup bundle has no database entry");
  const keyEntry = zip.getEntry(KEY_ENTRY_NAME);
  return { dbBuffer: dbEntry.getData(), keyBuffer: keyEntry ? keyEntry.getData() : null };
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

/** Called hourly; only actually backs up once `backupIntervalHours` have elapsed since the last
 * one, so the interval is reconfigurable without needing to restart a cron job. Writes a
 * timestamped backup bundle (the DB snapshot plus `encryption.key`, see writeBackupBundle) into
 * the configured backup directory and deletes the oldest ones beyond the configured keep-count.
 * No-ops (quietly) when scheduled backups aren't enabled or no directory is configured — this runs
 * unattended on a cron, so it must never throw. */
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

  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `aonarr-backup-${stamp}.${BACKUP_BUNDLE_EXTENSION}`;
    const destPath = path.join(dir, fileName);
    await writeBackupBundle(destPath);
    setSetting("lastScheduledBackupAt", new Date().toISOString());
    log.info(`[backup] wrote scheduled backup to ${destPath}`);

    await uploadBackupToRemote(destPath, fileName, keepCount);

    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("aonarr-backup-") && (f.endsWith(`.${BACKUP_BUNDLE_EXTENSION}`) || f.endsWith(".db") || f.endsWith(".dump")))
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
