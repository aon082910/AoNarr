import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { nowOffsetExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

function recycleBinRoot(): string {
  return getSetting("recycleBinDir") || path.join(config.configDir, "recycle-bin");
}

export function isRecycleBinEnabled(): boolean {
  return getSetting("recycleBinEnabled") !== "0"; // on by default
}

/** Whether anything (a file, a directory, or a symlink, dangling or not) still sits at `p`. Any
 * error other than "not there", like a dead mount's ENOTCONN, counts as still there. */
async function entryExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** Errors that mean the file or its storage can't be reached, where deleting "instead" would
 * either do nothing or destroy what an outage only made look broken. */
const UNREACHABLE_CODES = new Set(["ENOENT", "ENOTCONN", "EIO", "ESTALE", "EHOSTDOWN"]);

/** Moves a file into the recycle bin (type-namespaced, original filename kept) instead of
 * deleting it outright, and records enough to restore it later. Falls back to a plain delete if
 * the recycle bin is disabled or the move itself fails — never throws, since this runs inline
 * with delete/merge flows that shouldn't be blocked by a housekeeping feature. Resolves to whether
 * `filePath` is gone afterwards; a file that can't be reached (a dead mount) is left alone.
 *
 * Uses moveFileAsync (below), not a synchronous rename/copy — this used to call fs.copyFileSync
 * directly, which blocks Node's entire single-threaded event loop for as long as an EXDEV
 * (cross-filesystem, e.g. /config vs /media in Docker) copy of a multi-GB file takes. During that
 * window the whole server stops responding to every request from every user, not just the one who
 * triggered the recycle — reported as a bare 502 (nginx's upstream connection simply going
 * unresponsive) with nothing in the logs, since nothing ever threw. */
export async function recycleFile(filePath: string, mediaType: string, title: string, mediaItemId: number | null): Promise<boolean> {
  if (!isRecycleBinEnabled()) {
    try {
      await fsp.rm(filePath, { recursive: true, force: true });
    } catch {
      // already gone — fine
    }
    return !(await entryExists(filePath));
  }

  let size: number;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch (err) {
    // stat follows symlinks, so a library symlink into a debrid/rclone mount that's down fails
    // here although the link itself is fine. The link is still moved into the bin (as a link,
    // restorable); anything else unreachable is left in place. Deleting it "instead" used to
    // destroy exactly the files a mount outage made look missing.
    const link = await fsp.lstat(filePath).catch(() => null);
    if (!link?.isSymbolicLink()) {
      if (link || (err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`[recycleBin] can't reach "${filePath}", leaving it in place:`, (err as Error).message);
      }
      return !(await entryExists(filePath));
    }
    size = 0;
  }

  let dest: string;
  try {
    const destDir = path.join(recycleBinRoot(), mediaType);
    await fsp.mkdir(destDir, { recursive: true });
    // A random component too, not just the millisecond: deleting an item recycles its files in a
    // tight loop, and two same-named files ("Lesson 1/video.mp4", "Lesson 2/video.mp4") recycled in
    // the same millisecond used to land on the same destination — rename()/cp() replace silently,
    // so the first file was destroyed while both recycle_bin rows pointed at the second.
    dest = path.join(destDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${path.basename(filePath)}`);
    await moveFileAsync(filePath, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && UNREACHABLE_CODES.has(code)) {
      log.warn(`[recycleBin] failed to recycle "${filePath}", leaving it in place:`, (err as Error).message);
    } else {
      log.warn(`[recycleBin] failed to recycle "${filePath}", deleting instead:`, (err as Error).message);
      try {
        await fsp.rm(filePath, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
    return !(await entryExists(filePath));
  }

  try {
    await db
      .prepare(
        `INSERT INTO recycle_bin (media_item_id, media_type, title, original_path, recycle_path, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(mediaItemId, mediaType, title, filePath, dest, size);
  } catch (err) {
    // Without a row the moved file would sit in the bin untracked: never listed, restorable or
    // purged by retention. Put it back where it was instead.
    log.warn(`[recycleBin] couldn't record "${filePath}" in the recycle bin, moving it back:`, (err as Error).message);
    try {
      await moveFileAsync(dest, filePath);
    } catch (moveBackErr) {
      log.error(`[recycleBin] "${filePath}" could not be moved back and is untracked at "${dest}":`, (moveBackErr as Error).message);
    }
  }
  return !(await entryExists(filePath));
}

/** Shared by recycleFile (above) and startRestoreFromRecycleBin (below) — either direction can
 * mean moving a many-GB remux across a filesystem boundary (rename() fails with EXDEV; common in
 * Docker, where /config and /media are often separate mounts), and a synchronous copy would block
 * Node's single event loop for the entire copy. fs.promises' copyFile/rename hand the work to
 * libuv's thread pool instead, so the rest of the app (every other request, from every user) keeps
 * responding while a big move is in flight. With `stagingPath`, a cross-device copy goes there
 * first and is renamed into place only once complete. */
async function moveFileAsync(src: string, dest: string, stagingPath?: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // fsp.cp handles both a single file and a directory (Music's sub_items.file_path is a
    // directory) — fsp.copyFile alone would throw EISDIR on a directory and leave it stranded.
    if (stagingPath) {
      await fsp.rm(stagingPath, { recursive: true, force: true });
      try {
        await fsp.cp(src, stagingPath, { recursive: true });
        await fsp.rename(stagingPath, dest);
      } catch (copyErr) {
        await fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
        throw copyErr;
      }
    } else {
      await fsp.cp(src, dest, { recursive: true });
    }
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/** Where a cross-device restore of entry `id` copies to before renaming into place. An interrupted
 * copy straight into the original path left a partial file there, and every later restore then
 * refused with "a file already exists". Fixed per entry, so a retry or the restart cleanup can
 * remove a leftover one. */
function restoreStagingPath(id: number, originalPath: string): string {
  return path.join(path.dirname(originalPath), `.${path.basename(originalPath)}.aonarr-restore-${id}.partial`);
}

/** Restores running in this process. `restoring` is set before the detached move starts and only
 * that task clears it, so any other row still marked restoring was left by a process that exited
 * mid-restore. */
const activeRestores = new Set<number>();

/** Clears `restoring` on entries whose restore was cut off by a restart (a container update during
 * a long cross-device copy): until then they refused restore and purge, and retention skipped them,
 * forever. An entry whose move had already finished (only the row delete was lost) is removed.
 * Safe to call at any time; restores running in this process are left alone. */
export async function resetInterruptedRestores(): Promise<number> {
  const rows = (await db.prepare("SELECT id, original_path, recycle_path FROM recycle_bin WHERE restoring = 1").all()) as {
    id: number;
    original_path: string;
    recycle_path: string;
  }[];
  let reset = 0;
  for (const row of rows) {
    if (activeRestores.has(row.id)) continue;
    await fsp.rm(restoreStagingPath(row.id, row.original_path), { recursive: true, force: true }).catch(() => {});
    if (!(await entryExists(row.recycle_path)) && (await entryExists(row.original_path))) {
      await db.prepare("DELETE FROM recycle_bin WHERE id = ? AND restoring = 1").run(row.id);
    } else {
      await db
        .prepare("UPDATE recycle_bin SET restoring = 0, restore_error = ? WHERE id = ? AND restoring = 1")
        .run("The restore was interrupted by a restart — restore again", row.id);
    }
    reset++;
  }
  if (reset > 0) log.warn(`[recycleBin] reset ${reset} restore(s) interrupted by a restart`);
  return reset;
}

let interruptedRestoresReset: Promise<void> | null = null;

/** Runs resetInterruptedRestores once per process, before anything here reads or sets
 * `restoring`, so a leftover flag heals on first use even if startup never called it. */
function resetInterruptedRestoresOnce(): Promise<void> {
  interruptedRestoresReset ??= resetInterruptedRestores().then(
    () => undefined,
    (err) => {
      interruptedRestoresReset = null;
      log.warn("[recycleBin] couldn't reset interrupted restores:", (err as Error).message);
    }
  );
  return interruptedRestoresReset;
}

/** Kicks off a restore and returns immediately — the caller (the route) responds right away
 * rather than holding the HTTP request open for however long a large file takes to move. Progress
 * is tracked via the `restoring`/`restore_error` columns so the list view can reflect it. Throws
 * synchronously (before any async work starts) for the cheap, immediate validation errors — "no
 * such entry" or "already restoring" — so the route can 400 those the normal way; everything after
 * that point resolves through the DB row instead of a thrown error, since by then the HTTP response
 * has already gone out. */
export async function startRestoreFromRecycleBin(id: number): Promise<void> {
  await resetInterruptedRestoresOnce();
  const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as
    | { recycle_path: string; original_path: string; restoring: number }
    | undefined;
  if (!row) throw new Error("Recycle bin entry not found");
  if (row.restoring) throw new Error("This item is already being restored");

  activeRestores.add(id);
  try {
    await db.prepare("UPDATE recycle_bin SET restoring = 1, restore_error = NULL WHERE id = ?").run(id);
  } catch (err) {
    activeRestores.delete(id);
    throw err;
  }

  (async () => {
    try {
      // rename()/cp() would silently replace whatever is there now — typically a newer download of
      // the same item that landed at the same templated path after this one was recycled.
      if (fs.existsSync(row.original_path)) {
        throw new Error("A file already exists at the original location — move or remove it first, then restore again");
      }
      await fsp.mkdir(path.dirname(row.original_path), { recursive: true });
      await moveFileAsync(row.recycle_path, row.original_path, restoreStagingPath(id, row.original_path));
      await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
    } catch (err) {
      log.warn(`[recycleBin] restore failed for entry ${id}:`, (err as Error).message);
      await db.prepare("UPDATE recycle_bin SET restoring = 0, restore_error = ? WHERE id = ?").run((err as Error).message, id);
    } finally {
      activeRestores.delete(id);
    }
  })();
}

/** Restores every entry of the given media type (or every entry, if omitted) — the Recycle Bin
 * page's per-section "Restore All". Skips entries already restoring (same guard
 * startRestoreFromRecycleBin itself enforces) rather than failing the whole batch over one, and
 * kicks each restore off via the same fire-and-forget path so a many-GB file doesn't hold this up. */
export async function restoreAllFromRecycleBin(mediaType?: string): Promise<{ started: number; skipped: number }> {
  await resetInterruptedRestoresOnce();
  const rows = (await (mediaType
    ? db.prepare("SELECT id, original_path FROM recycle_bin WHERE media_type = ? AND restoring = 0 ORDER BY id DESC").all(mediaType)
    : db.prepare("SELECT id, original_path FROM recycle_bin WHERE restoring = 0 ORDER BY id DESC").all())) as {
    id: number;
    original_path: string;
  }[];
  let started = 0;
  // The same original path recycled more than once over time (recycled, re-downloaded, recycled
  // again) would otherwise have its restores race each other to the same destination — only the
  // most recent entry for a path is restored; the rest are left for the admin to decide.
  const claimedPaths = new Set<string>();
  for (const row of rows) {
    if (claimedPaths.has(row.original_path)) continue;
    claimedPaths.add(row.original_path);
    try {
      await startRestoreFromRecycleBin(row.id);
      started++;
    } catch (err) {
      log.warn(`[recycleBin] restore-all skipped entry ${row.id}:`, (err as Error).message);
    }
  }
  return { started, skipped: rows.length - started };
}

/** Permanently purges every entry of the given media type (or every entry, if omitted) — the
 * Recycle Bin page's per-section "Delete All". Skips (not fails) any entry currently restoring,
 * matching purgeRecycleBinEntry's own guard, and tolerates individual failures the same way. */
export async function purgeAllRecycleBinEntries(mediaType?: string): Promise<{ purged: number; skipped: number }> {
  await resetInterruptedRestoresOnce();
  const rows = (await (mediaType
    ? db.prepare("SELECT id FROM recycle_bin WHERE media_type = ?").all(mediaType)
    : db.prepare("SELECT id FROM recycle_bin").all())) as { id: number }[];
  let purged = 0;
  for (const row of rows) {
    try {
      await purgeRecycleBinEntry(row.id);
      purged++;
    } catch (err) {
      log.warn(`[recycleBin] purge-all skipped entry ${row.id}:`, (err as Error).message);
    }
  }
  return { purged, skipped: rows.length - purged };
}

export async function purgeRecycleBinEntry(id: number): Promise<void> {
  await resetInterruptedRestoresOnce();
  const row = (await db.prepare("SELECT * FROM recycle_bin WHERE id = ?").get(id)) as { recycle_path: string; restoring: number } | undefined;
  if (!row) return;
  if (row.restoring) throw new Error("This item is being restored — wait for that to finish first");
  try {
    fs.rmSync(row.recycle_path, { recursive: true, force: true });
  } catch {
    // already gone
  }
  await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
}

/** Scheduled cleanup: purges anything older than the configured retention. */
export async function purgeExpiredRecycleBinEntries(): Promise<void> {
  // Distinguishes "unset" (fall back to the 30-day default) from "explicitly set to 0" (an admin
  // opting into near-immediate purging) — a plain `parseInt(...) || 30` treated 0 as falsy and
  // silently replaced it with the default, the opposite of what was requested.
  const rawDays = getSetting("recycleBinRetentionDays");
  const parsedDays = rawDays != null ? parseInt(rawDays, 10) : NaN;
  const days = Math.max(1, Number.isFinite(parsedDays) ? parsedDays : 30);
  await resetInterruptedRestoresOnce();
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
