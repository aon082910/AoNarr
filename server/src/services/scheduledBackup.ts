import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import { db } from "../db/client.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { uploadBackupToRemote } from "./remoteBackup.js";

/** Called hourly; only actually backs up once `backupIntervalHours` have elapsed since the last
 * one, so the interval is reconfigurable without needing to restart a cron job. Writes a
 * timestamped DB snapshot into the configured backup directory and deletes the oldest ones
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

  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `aonarr-backup-${stamp}.db`;
    const destPath = path.join(dir, fileName);
    await db.backup(destPath);
    setSetting("lastScheduledBackupAt", new Date().toISOString());
    log.info(`[backup] wrote scheduled backup to ${destPath}`);

    await uploadBackupToRemote(destPath, fileName, keepCount);

    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("aonarr-backup-") && f.endsWith(".db"))
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
