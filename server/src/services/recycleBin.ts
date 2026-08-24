import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { nowOffsetExpr } from "../db/asyncDb.js";
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
export async function recycleFile(filePath: string, mediaType: string, title: string, mediaItemId: number | null): Promise<void> {
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
    await db
      .prepare(
        `INSERT INTO recycle_bin (media_item_id, media_type, title, original_path, recycle_path, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(mediaItemId, mediaType, title, filePath, dest, stat.size);
  } catch (err) {
    log.warn(`[recycleBin] failed to recycle "${filePath}", deleting instead:`, (err as Error).message);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }
}

/** Async counterpart to moveFile — restoring can mean moving a many-GB remux back across a
 * different filesystem (the same EXDEV case moveFile handles), and fs.copyFileSync blocks Node's
 * single event loop for the entire copy. fs.promises' copyFile/rename hand the work to libuv's
 * thread pool instead, so the rest of the app (including the next click on this same page) keeps
 * responding while a big restore is in flight. */
async function moveFileAsync(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

/** Kicks off a restore and returns immediately — the caller (the route) responds right away
 * rather than holding the HTTP request open for however long a large file takes to move. Progress
 * is tracked via the `restoring`/`restore_error` columns so the list view can reflect it. Throws
 * synchronously (before any async work starts) for the cheap, immediate validation errors — "no
 * such entry" or "already restoring" — so the route can 400 those the normal way; everything after
 * that point resolves through the DB row instead of a thrown error, since by then the HTTP response
 * has already gone out. */
export async function startRestoreFromRecycleBin(id: number): Promise<void> {
  const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as
    | { recycle_path: string; original_path: string; restoring: number }
    | undefined;
  if (!row) throw new Error("Recycle bin entry not found");
  if (row.restoring) throw new Error("This item is already being restored");

  await db.prepare("UPDATE recycle_bin SET restoring = 1, restore_error = NULL WHERE id = ?").run(id);

  (async () => {
    try {
      await fsp.mkdir(path.dirname(row.original_path), { recursive: true });
      await moveFileAsync(row.recycle_path, row.original_path);
      await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
    } catch (err) {
      log.warn(`[recycleBin] restore failed for entry ${id}:`, (err as Error).message);
      await db.prepare("UPDATE recycle_bin SET restoring = 0, restore_error = ? WHERE id = ?").run((err as Error).message, id);
    }
  })();
}

export async function purgeRecycleBinEntry(id: number): Promise<void> {
  const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as { recycle_path: string; restoring: number } | undefined;
  if (!row) return;
  if (row.restoring) throw new Error("This item is being restored — wait for that to finish first");
  try {
    fs.unlinkSync(row.recycle_path);
  } catch {
    // already gone
  }
  await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
}

/** Scheduled cleanup: purges anything older than the configured retention. */
export async function purgeExpiredRecycleBinEntries(): Promise<void> {
  const days = Math.max(1, parseInt(getSetting("recycleBinRetentionDays") ?? "30", 10) || 30);
  const rows = (await db
    .prepare(`SELECT id FROM recycle_bin WHERE deleted_at <= ${nowOffsetExpr(db, -days)} AND restoring = 0`)
    .all()) as { id: number }[];
  for (const row of rows) {
    try {
      await purgeRecycleBinEntry(row.id);
    } catch (err) {
      log.warn(`[recycleBin] failed to purge expired entry ${row.id}:`, (err as Error).message);
    }
  }
  if (rows.length > 0) log.info(`[recycleBin] purged ${rows.length} expired entrie(s)`);
}
