import fs from "node:fs";
import path from "node:path";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

function recycleBinRoot(): string {
  return getSetting("recycleBinDir") || path.join(config.configDir, "recycle-bin");
}

/** rename() fails with EXDEV across filesystems (common in Docker — /config and /media are often
 * separate mounts) — fall back to copy+unlink in that case. */
function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

export function isRecycleBinEnabled(): boolean {
  return getSetting("recycleBinEnabled") !== "0"; // on by default
}

/** Moves a file into the recycle bin (type-namespaced, original filename kept) instead of
 * deleting it outright, and records enough to restore it later. Falls back to a plain delete if
 * the recycle bin is disabled or the move itself fails (e.g. file already gone) — never throws,
 * since this runs inline with delete flows that shouldn't be blocked by a housekeeping feature. */
export function recycleFile(filePath: string, mediaType: string, title: string, mediaItemId: number | null): void {
  if (!isRecycleBinEnabled()) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone — fine
    }
    return;
  }

  try {
    const stat = fs.statSync(filePath);
    const destDir = path.join(recycleBinRoot(), mediaType);
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = Date.now();
    const dest = path.join(destDir, `${stamp}-${path.basename(filePath)}`);
    moveFile(filePath, dest);
    db.prepare(
      `INSERT INTO recycle_bin (media_item_id, media_type, title, original_path, recycle_path, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(mediaItemId, mediaType, title, filePath, dest, stat.size);
  } catch (err) {
    log.warn(`[recycleBin] failed to recycle "${filePath}", deleting instead:`, (err as Error).message);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }
}

export function restoreFromRecycleBin(id: number): void {
  const row = db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id) as
    | { recycle_path: string; original_path: string }
    | undefined;
  if (!row) throw new Error("Recycle bin entry not found");

  fs.mkdirSync(path.dirname(row.original_path), { recursive: true });
  moveFile(row.recycle_path, row.original_path);
  db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
}

export function purgeRecycleBinEntry(id: number): void {
  const row = db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id) as { recycle_path: string } | undefined;
  if (!row) return;
  try {
    fs.unlinkSync(row.recycle_path);
  } catch {
    // already gone
  }
  db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
}

/** Scheduled cleanup: purges anything older than the configured retention. */
export async function purgeExpiredRecycleBinEntries(): Promise<void> {
  const days = Math.max(1, parseInt(getSetting("recycleBinRetentionDays") ?? "30", 10) || 30);
  const rows = db
    .prepare(`SELECT id FROM recycle_bin WHERE deleted_at <= datetime('now', ?)`)
    .all(`-${days} days`) as { id: number }[];
  for (const row of rows) purgeRecycleBinEntry(row.id);
  if (rows.length > 0) log.info(`[recycleBin] purged ${rows.length} expired entrie(s)`);
}
