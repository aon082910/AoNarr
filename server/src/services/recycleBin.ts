import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { nowOffsetExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";
import { fitFileName } from "./pathNames.js";
import { StorageTimeoutError, directorySizeAsync, guardedFsCall, lstatAsync, pathExistsAsync, readdirAsync, statAsync } from "./fsAsync.js";

function recycleBinRoot(): string {
  return getSetting("recycleBinDir") || path.join(config.configDir, "recycle-bin");
}

/** Where recycled files go; the library scan skips it when it sits inside a root folder. */
export function recycleBinDirectory(): string {
  return recycleBinRoot();
}

export function isRecycleBinEnabled(): boolean {
  return getSetting("recycleBinEnabled") !== "0"; // on by default
}

/** Whether anything (a file, a directory, or a symlink, dangling or not) still sits at `p`. Any
 * error other than "not there", like a dead mount's ENOTCONN or a mount that does not answer, counts as still there. */
async function entryExists(p: string): Promise<boolean> {
  try {
    await lstatAsync(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Whether the recycle bin could take `files` right now, as a reason when it could not (null when it
 * can, or when the bin is off and a delete is meant to be permanent). A delete that must not
 * half-happen asks first: the bin folder must be writable, and the files that live on another
 * filesystem than the bin (which are copied, not renamed) must fit in its free space.
 */
export async function recycleBinProblem(files: string[]): Promise<string | null> {
  if (!isRecycleBinEnabled() || files.length === 0) return null;
  const root = recycleBinRoot();
  try {
    await fsp.mkdir(root, { recursive: true });
    const probe = path.join(root, `.write-test-${crypto.randomBytes(4).toString("hex")}`);
    await fsp.writeFile(probe, "x");
    await fsp.rm(probe, { force: true });
  } catch (err) {
    return `the recycle bin folder "${root}" is not writable (${(err as Error).message})`;
  }
  try {
    const binDevice = (await fsp.stat(root)).dev;
    let needed = 0;
    for (const file of files) {
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.dev !== binDevice) needed += stat.size;
    }
    if (needed > 0) {
      const fsStat = await fsp.statfs(root);
      const free = Number(fsStat.bavail) * Number(fsStat.bsize);
      if (free < needed) {
        return `the recycle bin has ${Math.round(free / 1e9)}GB free and ${Math.round(needed / 1e9)}GB would go into it`;
      }
    }
  } catch {
    // Can't read the space: not a reason to refuse; recycleFile reports a real failure.
  }
  return null;
}

/**
 * Whether the recycle bin folder is writable right now, for Health (recycleBinProblem checks it only when files
 * are about to go in). Null when it is off, fine, or not created yet (it is created by the first file that goes in:
 * a health check must not create it, which on an unmounted share would build the tree on the container's own disk).
 * Every call is bounded, so a bin on a dead mount cannot hang the health report.
 */
export async function recycleBinFolderProblem(): Promise<string | null> {
  if (!isRecycleBinEnabled()) return null;
  const root = recycleBinRoot();
  const probe = path.join(root, `.write-test-${crypto.randomBytes(4).toString("hex")}`);
  try {
    try {
      await statAsync(root, 10_000);
    } catch (err) {
      if (err instanceof StorageTimeoutError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    await guardedFsCall("write-probe", probe, 10_000, () => fsp.writeFile(probe, "x"));
    await guardedFsCall("rm-probe", probe, 10_000, () => fsp.rm(probe, { force: true }));
    return null;
  } catch (err) {
    return `the recycle bin folder "${root}" is not writable (${(err as Error).message})`;
  }
}

/** Moves a file into the recycle bin (type-namespaced, original filename kept) instead of
 * deleting it outright, and records enough to restore it later. Deletes outright only when the
 * recycle bin is disabled; if the move itself fails (full or unwritable bin, an unreachable mount)
 * the file is left where it is — never throws, since this runs inline with delete/merge flows that
 * shouldn't be blocked by a housekeeping feature. Resolves to whether `filePath` is gone
 * afterwards, so a caller that must not proceed without the file out of the way can tell.
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
    const stat = await statAsync(filePath);
    // A folder's own size is its directory inode (4 KB): its entry shows what is in it.
    size = stat.isDirectory() ? (await directorySizeAsync(filePath)).bytes : stat.size;
  } catch (err) {
    // stat follows symlinks, so a library symlink into a debrid/rclone mount that's down fails
    // here although the link itself is fine. The link is still moved into the bin (as a link,
    // restorable); anything else unreachable is left in place. Deleting it "instead" used to
    // destroy exactly the files a mount outage made look missing.
    const link = await lstatAsync(filePath).catch(() => null);
    if (!link?.isSymbolicLink()) {
      if (link || (err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`[recycleBin] can't reach "${filePath}", leaving it in place:`, (err as Error).message);
      }
      return !(await entryExists(filePath));
    }
    size = 0;
  }

  let dest = "";
  try {
    const destDir = path.join(recycleBinRoot(), mediaType);
    await fsp.mkdir(destDir, { recursive: true });
    // A random component too, not just the millisecond: deleting an item recycles its files in a
    // tight loop, and two same-named files ("Lesson 1/video.mp4", "Lesson 2/video.mp4") recycled in
    // the same millisecond used to land on the same destination — rename()/cp() replace silently,
    // so the first file was destroyed while both recycle_bin rows pointed at the second. The name is
    // cut to fit when the prefix would push a long library name past the filesystem's limit.
    dest = path.join(destDir, fitFileName(`${Date.now()}-${crypto.randomBytes(4).toString("hex")}-`, path.basename(filePath)));
    await moveFileAsync(filePath, dest);
  } catch (err) {
    // Whatever the reason (a full or read-only bin disk, a permission error, an unreachable mount),
    // the file stays where it is: a bin that "can't take" a file is not the user choosing to delete
    // it, and the callers (delete, upgrade replace, archive, corrupt-media flows) all treat `false`
    // as "not gone". Only a disabled bin, the user's explicit choice, deletes outright (above).
    log.warn(`[recycleBin] failed to recycle "${filePath}", leaving it in place:`, (err as Error).message);
    // A cross-device move that copied the file but could not remove the source (a read-only mount)
    // leaves a full copy in the bin with no row to find it by; every retry would add another.
    if (dest && (await entryExists(filePath))) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
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

/** Whether `p` is a directory (not a link to one); false for anything else or a path that cannot be read. */
async function isDirectoryAt(p: string): Promise<boolean> {
  try {
    return (await lstatAsync(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Moves what is in recycled folder `src` into the existing folder `dest`: entries that are not there yet are moved,
 * folders in both are merged, and a file that is already there is left in `src` (it may be a newer copy). Returns how
 * many entries were left.
 */
async function mergeDirectoryInto(src: string, dest: string, id: number): Promise<number> {
  let left = 0;
  for (const entry of await readdirAsync(src)) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (!(await entryExists(to))) {
      await moveFileAsync(from, to, restoreStagingPath(id, to));
    } else if (entry.isDirectory() && (await isDirectoryAt(to))) {
      left += await mergeDirectoryInto(from, to, id);
      if ((await readdirAsync(from)).length === 0) await fsp.rmdir(from).catch(() => {});
    } else {
      left++;
    }
  }
  return left;
}

/** Starts the restore of every other entry whose original path is below `folder`. Each is restored on its own (an
 * entry already restoring is skipped, as are those whose file is back already: they report it on their own row). */
async function restoreEntriesBeneath(folder: string, exceptId: number): Promise<void> {
  const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
  const rows = (await db
    .prepare("SELECT id, original_path FROM recycle_bin WHERE restoring = 0 AND id <> ? AND substr(original_path, 1, ?) = ? ORDER BY id")
    .all(exceptId, prefix.length, prefix)) as { id: number; original_path: string }[];
  // The same path recycled more than once: only the most recent entry is restored, as restore-all does.
  const claimed = new Set<string>();
  for (const row of [...rows].reverse()) {
    if (claimed.has(row.original_path)) continue;
    claimed.add(row.original_path);
    try {
      await startRestoreFromRecycleBin(row.id);
    } catch (err) {
      log.warn(`[recycleBin] restoring beneath "${folder}" skipped entry ${row.id}:`, (err as Error).message);
    }
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
      if (await pathExistsAsync(row.original_path)) {
        // A recycled folder whose files came back first (their restore created it again) is put back by merging: what is
        // not there yet is moved in, and nothing is replaced.
        const folderIntoFolder = (await isDirectoryAt(row.recycle_path)) && (await isDirectoryAt(row.original_path));
        if (!folderIntoFolder) {
          throw new Error("A file already exists at the original location — move or remove it first, then restore again");
        }
        const left = await mergeDirectoryInto(row.recycle_path, row.original_path, id);
        if (left > 0) {
          throw new Error(`The folder was restored, but ${left} file(s) in it already exist at the original location and stay in the recycle bin`);
        }
        await fsp.rm(row.recycle_path, { recursive: true, force: true });
      } else {
        await fsp.mkdir(path.dirname(row.original_path), { recursive: true });
        await moveFileAsync(row.recycle_path, row.original_path, restoreStagingPath(id, row.original_path));
      }
      await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
      // Restoring a folder brings back what was recycled from beneath it too (a file recycled on its own before the
      // folder went, which a restore of the folder alone would leave behind in the bin).
      await restoreEntriesBeneath(row.original_path, id);
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
    await fsp.rm(row.recycle_path, { recursive: true, force: true });
  } catch {
    // already gone
  }
  await db.prepare("DELETE FROM recycle_bin WHERE id = ?").run(id);
}

/** Scheduled cleanup: purges anything older than the configured retention. */
export async function purgeExpiredRecycleBinEntries(): Promise<void> {
  // "Unset" falls back to the 30-day default; an explicit 0 turns the automatic cleanup off, as in Sonarr and Radarr
  // (it used to be read as 1 day, so an admin who typed 0 to keep everything lost the bin overnight).
  const rawDays = getSetting("recycleBinRetentionDays");
  const parsedDays = rawDays != null && rawDays.trim() !== "" ? parseInt(rawDays, 10) : NaN;
  const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 30;
  await resetInterruptedRestoresOnce();
  if (days === 0) return;
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
