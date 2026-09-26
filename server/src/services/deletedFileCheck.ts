import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

/** A readable directory with at least one entry. Reads only the first entry: this runs once per
 * missing file, and a root folder can hold thousands of show folders. */
function isPopulatedDir(dir: string): boolean {
  try {
    const handle = fs.opendirSync(dir);
    try {
      return handle.readSync() !== null;
    } finally {
      handle.closeSync();
    }
  } catch {
    return false;
  }
}

function isNotThere(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The topmost of `dir` and its ancestors that can't be reached (stat fails with something other
 * than "not there"), so one dead mount is reported once rather than once per folder inside it. */
function unreachableAncestor(dir: string): string {
  let top = dir;
  for (let parent = path.dirname(top); parent !== top; top = parent, parent = path.dirname(top)) {
    try {
      fs.statSync(parent);
      break;
    } catch (err) {
      if (isNotThere(err)) break;
    }
  }
  return top;
}

/** The kernel's own limit on symlinks followed while resolving one path. */
const MAX_LINK_HOPS = 40;

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** For a symlink (the symlink import strategy's links into a debrid/rclone mount), the directory
 * standing in for its target's storage when that storage looks offline: the nearest existing
 * ancestor of the target's folder is empty (an unmounted mount point) or unreachable (a dead FUSE
 * mount's ENOTCONN), or the mount directory itself looks gone — nothing of the target's path exists
 * below the filesystem root, or below a top-level directory once the target folder's parent is
 * missing too. Null when the storage is up and only this target is gone: its file, or its release
 * folder inside a live directory such as a populated top-level /downloads.
 *
 * `link` is `missingPath` itself or a folder on its way (a show folder linked into the mount), and
 * the target is where `missingPath` ends up once every link along it is followed. With a debrid
 * client's symlink mode (Decypharr, rdt-client's Symlink Downloader) the library link points at the
 * client's own link in the download folder, or into a release or download folder that is itself a
 * link, which points into the mount. That download folder stays populated with its dangling links
 * while the mount is down, so only the fully followed path says where the file lives. */
function offlineLinkTargetStorage(link: string, missingPath: string, hops = 1): string | null {
  let target: string;
  try {
    target = path.join(path.resolve(path.dirname(link), fs.readlinkSync(link)), path.relative(link, missingPath));
  } catch {
    return null;
  }
  for (; hops < MAX_LINK_HOPS; hops++) {
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) break;
      target = path.resolve(path.dirname(target), fs.readlinkSync(target));
    } catch (err) {
      if (isNotThere(err)) break;
      return unreachableAncestor(path.dirname(target));
    }
  }
  for (let dir = path.dirname(target), climbed = 0; ; dir = path.dirname(dir), climbed++) {
    try {
      if (!fs.statSync(dir).isDirectory()) return null;
    } catch (err) {
      if (!isNotThere(err)) return unreachableAncestor(dir);
      if (path.dirname(dir) === dir) return dir;
      if (hops < MAX_LINK_HOPS && isSymlink(dir)) return offlineLinkTargetStorage(dir, target, hops + 1);
      continue;
    }
    if (!isPopulatedDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return climbed > 0 ? dir : null;
    return climbed >= 2 && parent === path.parse(dir).root ? dir : null;
  }
}

/** The nearest existing ancestor of a path that isn't there (below `stopAt`), when that ancestor
 * is a symlink. */
function linkedAncestor(missingPath: string, stopAt: string | undefined): string | null {
  for (let dir = path.dirname(missingPath); dir !== stopAt && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    try {
      return fs.lstatSync(dir).isSymbolicLink() ? dir : null;
    } catch (err) {
      if (!isNotThere(err)) return null;
    }
  }
  return null;
}

/** Why a file that isn't on disk can't be taken as actually gone right now (its root folder is
 * missing or empty, the storage holding it can't be reached, or it's a symlink into offline
 * storage), or null when it really is missing. */
export function offlineStorageFor(filePath: string, rootPaths: string[]): string | null {
  const resolved = path.resolve(filePath);
  const owner = rootPaths.filter((r) => resolved.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (owner && !isPopulatedDir(owner)) return `root folder "${owner}" is missing or empty`;
  let link: string | null;
  try {
    link = fs.lstatSync(resolved).isSymbolicLink() ? resolved : null;
  } catch (err) {
    // A dead FUSE/rclone mount below a populated root (root /media, mount /media/gdrive) fails
    // every lookup under it with ENOTCONN/EIO/ESTALE rather than ENOENT.
    if (!isNotThere(err)) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      return `storage holding "${unreachableAncestor(path.dirname(resolved))}" is unreachable (${code})`;
    }
    // A show or release folder linked into a mount leaves nothing below it while the mount is down.
    link = linkedAncestor(resolved, owner);
  }
  const linkStorage = link ? offlineLinkTargetStorage(link, resolved) : null;
  if (linkStorage) return `symlink target storage "${linkStorage}" is unreachable or empty`;
  return null;
}

/** A test for "this file isn't on disk only because the storage holding it is offline", logging
 * each offline root folder or mount once per checker. Availability is re-read on every call, since
 * a share can drop partway through a long run. */
export async function createOfflineStorageCheck(logTag: string): Promise<(filePath: string) => boolean> {
  const rootPaths = ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => path.resolve(r.path));
  const warned = new Set<string>();
  return (filePath) => {
    if (fs.existsSync(filePath)) return false;
    const offline = offlineStorageFor(filePath, rootPaths);
    if (offline && !warned.has(offline)) {
      warned.add(offline);
      log.warn(`[${logTag}] ${offline} — skipping its files`);
    }
    return offline !== null;
  };
}

/**
 * Radarr/Sonarr's "Unmonitor Deleted" Media Management setting — neither AoNarr's library scan nor
 * anything else previously noticed when a file it had recorded (has_file = 1, a real file_path/
 * path on disk) simply vanished (deleted outside AoNarr, a failed disk, a bad rclone unmount for a
 * debrid/symlink setup). `has_file` is always corrected back to 0 for a genuinely missing file
 * regardless of the setting — leaving it 1 for a file that doesn't exist would just be wrong — the
 * setting only controls whether `monitored` also flips to 0, so the item stops being
 * auto-re-searched for (opt-in, since some admins want AoNarr to immediately try to redownload a
 * file that went missing, not give up on it).
 */
export async function checkForDeletedFiles(): Promise<{ checked: number; missing: number }> {
  const unmonitor = getSetting("unmonitorDeletedFiles") === "1";
  let checked = 0;
  let missing = 0;

  // An unmounted/offline share (NAS reboot, dropped SMB/NFS, a stopped rclone/Zurg mount) looks
  // exactly like "every file in it was deleted". Sonarr/Radarr skip a root folder that's missing
  // or empty rather than mass-flagging its whole contents — without this, one brief outage at
  // check time wiped every path (and, with unmonitorDeletedFiles, every monitored flag) under it,
  // and the next auto-search started re-grabbing the entire library. A symlink-strategy root stays
  // populated with its links while the mount they point into is down, so the links' targets are
  // checked too.
  const isOffline = await createOfflineStorageCheck("deletedFileCheck");

  // Each update is also matched on the path that was read: a file imported or renamed onto the row
  // since then must not be cleared.
  const items = (await db.prepare("SELECT id, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all()) as {
    id: number;
    path: string;
  }[];
  for (const row of items) {
    checked++;
    if (fs.existsSync(row.path) || isOffline(row.path)) continue;
    const result = await db
      .prepare(
        `UPDATE media_items SET has_file = 0, path = NULL, size_bytes = NULL, media_info = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ? AND path = ?`
      )
      .run(row.id, row.path);
    if (result.changes > 0) missing++;
  }

  const episodes = (await db
    .prepare("SELECT id, file_path FROM episodes WHERE has_file = 1 AND file_path IS NOT NULL")
    .all()) as { id: number; file_path: string }[];
  for (const row of episodes) {
    checked++;
    if (fs.existsSync(row.file_path) || isOffline(row.file_path)) continue;
    const result = await db
      .prepare(
        `UPDATE episodes SET has_file = 0, file_path = NULL, size_bytes = NULL, media_info = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ? AND file_path = ?`
      )
      .run(row.id, row.file_path);
    if (result.changes > 0) missing++;
  }

  const subItems = (await db
    .prepare("SELECT id, file_path FROM sub_items WHERE has_file = 1 AND file_path IS NOT NULL")
    .all()) as { id: number; file_path: string }[];
  for (const row of subItems) {
    checked++;
    if (fs.existsSync(row.file_path) || isOffline(row.file_path)) continue;
    const result = await db
      .prepare(
        `UPDATE sub_items SET has_file = 0, file_path = NULL, size_bytes = NULL, media_info = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ? AND file_path = ?`
      )
      .run(row.id, row.file_path);
    if (result.changes > 0) missing++;
  }

  // A parent whose every episode/sub-item file just vanished must stop claiming has_file = 1
  // itself, or it stays out of the Missing views and auto-search until the next full library
  // scan happens to run.
  if (missing > 0) {
    await db
      .prepare(
        `UPDATE media_items SET has_file = 0 WHERE has_file = 1 AND path IS NULL
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1)
         AND NOT EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = media_items.id AND s.has_file = 1)`
      )
      .run();
  }

  if (missing > 0) {
    log.info(
      `[deletedFileCheck] found ${missing} file(s) no longer on disk out of ${checked} checked${unmonitor ? " — unmonitored" : ""}`
    );
  }
  return { checked, missing };
}
