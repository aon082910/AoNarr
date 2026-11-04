import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { log } from "./logger.js";
import { effectiveShape, getMediaTypeConfig, MEDIA_TYPES } from "./mediaTypes.js";
import { namingTemplateOfType } from "./naming.js";
import { isRecycleBinEnabled, recycleFile } from "./recycleBin.js";
import { getSetting } from "./settingsStore.js";
import { isExcludedFile, isExcludedFolder, scanFilterFor } from "./scanExclusions.js";
import { offlineStorageFor } from "./deletedFileCheck.js";
import { resetSearchBackoff, wakeLeaf } from "./searchBackoff.js";
import { notifyFileDeleted } from "./notifications.js";
import { folderSegmentsOf, ownFolderOf } from "./libraryFolder.js";
import { FS_CALL_TIMEOUT_MS, StorageTimeoutError, pathExistsAsync, readdirAsync, readdirNamesAsync } from "./fsAsync.js";

/** How long one directory read of a delete may take before its storage is called unresponsive (a test shortens it). */
let walkTimeoutMs = FS_CALL_TIMEOUT_MS;
export function setFolderWalkTimeoutForTests(ms: number | null): void {
  walkTimeoutMs = ms ?? FS_CALL_TIMEOUT_MS;
}

/**
 * What a delete leaves on disk, after Sonarr's and Radarr's MediaFileDeletionService: deleting a title with its
 * files takes its own folder too (poster, NFO, subtitles, extras and empty season folders are the title's own), but
 * never a folder another title's file lives in or one that still holds media nobody tracks. Deleting one file
 * recycles that file and leaves the row as a missing one.
 */

async function rootPaths(): Promise<string[]> {
  return ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => path.resolve(r.path));
}

/**
 * A file another title tracks at or inside `folder`, or null. `excludeItemId` leaves one title's own rows out (a folder
 * move asks while the title still exists); after a delete the title's rows are gone and nothing needs excluding.
 */
export async function trackedFileInside(folder: string, excludeItemId = -1): Promise<string | null> {
  const prefix = folder + path.sep;
  const tables = [
    ["media_items", "path", "id"],
    ["episodes", "file_path", "media_item_id"],
    ["sub_items", "file_path", "media_item_id"],
  ] as const;
  for (const [table, column, ownerColumn] of tables) {
    const row = (await db
      .prepare(`SELECT ${column} AS p FROM ${table} WHERE ${column} IS NOT NULL AND ${ownerColumn} <> ? AND (${column} = ? OR substr(${column}, 1, ?) = ?) LIMIT 1`)
      .get(excludeItemId, folder, prefix.length, prefix)) as { p: string } | undefined;
    if (row) return row.p;
  }
  return null;
}

/** Everything a library can hold as media, whatever the type: a shared folder's other content is judged by this, not by the deleted title's type alone. */
const ANY_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.values(MEDIA_TYPES).flatMap((config) => config.extensions.map((e) => e.toLowerCase())),
  ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".vob", ".flv", ".webm", ".divx", ".ogm", ".iso", ".img", ".bin", ".cue", ".rmvb", ".3gp",
]);

/** First file under `dir` that is media of any type (outside extras folders and samples), or null. */
async function findMediaFile(dir: string, mediaType: string, depth = 0): Promise<string | null> {
  if (depth > 8) return null;
  const filter = scanFilterFor(mediaType);
  let entries: fs.Dirent[];
  try {
    entries = await readdirAsync(dir, walkTimeoutMs);
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return dir;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedFolder(entry.name, full, filter, depth + 1)) continue;
      const found = await findMediaFile(full, mediaType, depth + 1);
      if (found) return found;
    } else if (ANY_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !isExcludedFile(entry.name, filter)) {
      return full;
    }
  }
  return null;
}

/** Artwork, NFOs, subtitles and the like: a title's own leftovers, which a permanent delete may take. */
const DISPOSABLE_EXTENSIONS = new Set([".nfo", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tbn", ".srt", ".sub", ".idx", ".ass", ".ssa", ".vtt", ".txt", ".xml", ".json", ".db", ".ini", ".url"]);

/** Whether every file under `dir` is disposable. */
async function onlyDisposableFiles(dir: string, depth = 0): Promise<boolean> {
  if (depth > 8) return false;
  let entries: fs.Dirent[];
  try {
    entries = await readdirAsync(dir, walkTimeoutMs);
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!(await onlyDisposableFiles(path.join(dir, entry.name), depth + 1))) return false;
    } else if (!DISPOSABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return false;
  }
  return true;
}

async function hasAnyFile(dir: string, depth = 0): Promise<boolean> {
  if (depth > 8) return true;
  let entries: fs.Dirent[];
  try {
    entries = await readdirAsync(dir, walkTimeoutMs);
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || (await hasAnyFile(path.join(dir, entry.name), depth + 1))) return true;
  }
  return false;
}

export interface FolderCleanup {
  removed: string[];
  kept: { folder: string; reason: string }[];
  /** Folders whose storage did not answer, so they were not looked at (and are still there). */
  unresponsive: string[];
}

/**
 * After a title's files were recycled and its row is gone: the title's OWN folder goes too when only its leftovers
 * remain (artwork, NFO, subtitles, extras, empty season folders). The own folder is the stored `library_folder`, else
 * the one the naming template gives the files' paths (never a category folder above it, never a root folder).
 * Setting `removeFolderOnDelete` = "0" turns this off.
 */
export async function removeLeftoverFolders(
  row: { type: string; title: string; library_folder?: string | null; root_folder_id?: number | null },
  recycledPaths: string[]
): Promise<FolderCleanup> {
  const result: FolderCleanup = { removed: [], kept: [], unresponsive: [] };
  if (getSetting("removeFolderOnDelete") === "0") return result;
  const roots = await rootPaths();
  const candidates = new Set<string>();
  // The folder the title was stored with, which holds its artwork and NFO even when no file of it is left.
  const stored = folderSegmentsOf(row.library_folder);
  if (stored && row.root_folder_id != null) {
    const root = (await db.prepare("SELECT path FROM root_folders WHERE id = ?").get(row.root_folder_id)) as { path: string } | undefined;
    if (root) candidates.add(path.join(path.resolve(root.path), ...stored));
  }
  if (!stored) {
    const template = namingTemplateOfType(row.type);
    const multiFile = !!getMediaTypeConfig(row.type).multiFilePerChild;
    for (const file of recycledPaths) {
      const own = ownFolderOf(file, roots, template, multiFile);
      if (own) candidates.add(own);
    }
  }
  for (const folder of candidates) {
    if (!roots.some((r) => folder.startsWith(r + path.sep))) continue;
    if (roots.some((r) => r === folder || r.startsWith(folder + path.sep))) {
      result.kept.push({ folder, reason: "it is, or holds, a root folder" });
      continue;
    }
    try {
      if (!(await pathExistsAsync(folder, walkTimeoutMs))) continue;
      const tracked = await trackedFileInside(folder);
      if (tracked) {
        result.kept.push({ folder, reason: `"${tracked}" belongs to another title` });
        continue;
      }
      const media = await findMediaFile(folder, row.type);
      if (media) {
        result.kept.push({ folder, reason: `it still holds "${media}"` });
        continue;
      }
      if (!(await hasAnyFile(folder))) {
        await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
        if (!(await pathExistsAsync(folder, walkTimeoutMs))) result.removed.push(folder);
        continue;
      }
      // With the recycle bin off the folder is deleted outright: only when nothing but disposable leftovers is in it.
      if (!isRecycleBinEnabled() && !(await onlyDisposableFiles(folder))) {
        result.kept.push({ folder, reason: "the recycle bin is off and it holds files of other kinds" });
        continue;
      }
      if (await recycleFile(folder, row.type, `${row.title} (folder)`, null)) result.removed.push(folder);
      else result.kept.push({ folder, reason: "the recycle bin could not take it" });
    } catch (err) {
      // A share that does not answer: the folder is left as it is, rather than the delete (and with a sync read, the
      // whole server) hanging on it.
      if (!(err instanceof StorageTimeoutError)) throw err;
      result.unresponsive.push(folder);
      result.kept.push({ folder, reason: `its storage did not answer (${err.message})` });
    }
  }
  for (const k of result.kept) log.info(`[delete] left folder "${k.folder}" in place: ${k.reason}`);
  return result;
}

/** After a child's file is gone: a parent with no file-bearing episode/sub-item left stops claiming has_file. */
export async function rollUpParentMissing(mediaItemId: number | string): Promise<void> {
  await db
    .prepare(
      `UPDATE media_items SET has_file = 0 WHERE id = ? AND has_file = 1 AND path IS NULL
       AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1)
       AND NOT EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = media_items.id AND s.has_file = 1)`
    )
    .run(mediaItemId);
}

/** Empty folders left by a deleted file, from its own folder up to (not including) the root folder. */
async function removeEmptyParents(file: string, roots: string[]): Promise<void> {
  const resolved = path.resolve(file);
  const owner = roots.filter((r) => resolved.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (!owner) return;
  for (let dir = path.dirname(resolved); dir !== owner && dir.startsWith(owner + path.sep); dir = path.dirname(dir)) {
    try {
      if ((await readdirNamesAsync(dir, walkTimeoutMs)).length > 0) return;
      await fsp.rmdir(dir);
    } catch {
      return;
    }
  }
}

export type LibraryFileKind = "item" | "episode" | "subItem";

/** Another row (of any title) that tracks `filePath` or something below it, other than the rows named. */
async function otherRowTracking(filePath: string, own: { table: string; id: number; itemId: number }): Promise<string | null> {
  const prefix = filePath + path.sep;
  const tables = [
    ["media_items", "path", "id"],
    ["episodes", "file_path", "id"],
    ["sub_items", "file_path", "id"],
  ] as const;
  for (const [table, column, idColumn] of tables) {
    // A multi-episode file belongs to every episode of its title that points at it.
    const skip = table === own.table ? `AND ${idColumn} <> ${Number(own.id)}` : "";
    const sameTitle = table === "episodes" && own.table === "episodes" ? `AND media_item_id <> ${Number(own.itemId)}` : "";
    const row = (await db
      .prepare(`SELECT ${column} AS p FROM ${table} WHERE ${column} IS NOT NULL ${skip} ${sameTitle} AND (${column} = ? OR substr(${column}, 1, ?) = ?) LIMIT 1`)
      .get(filePath, prefix.length, prefix)) as { p: string } | undefined;
    if (row) return row.p;
  }
  return null;
}

/**
 * Deletes ONE library file: recycles it, then leaves its row as a missing one (the scan would otherwise link the file
 * back). With `unmonitor` (default: the `unmonitorDeletedFiles` setting) the row also stops being searched for.
 * Refuses while the file's storage looks offline, when the path is a folder or another row also uses it, and keeps the
 * row when the recycle bin cannot take the file.
 */
export async function deleteLibraryFile(params: {
  itemId: number;
  kind: LibraryFileKind;
  leafId?: number;
  unmonitor?: boolean;
}): Promise<{ path: string; unmonitored: boolean }> {
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(params.itemId)) as any;
  if (!item) throw new HttpError(404, "Media item not found");
  let filePath: string | null;
  let table: "media_items" | "episodes" | "sub_items";
  let id: number;
  if (params.kind === "episode") {
    const leaf = (await db.prepare("SELECT * FROM episodes WHERE id = ? AND media_item_id = ?").get(params.leafId, item.id)) as any;
    if (!leaf) throw new HttpError(404, "Episode not found");
    ({ table, id, filePath } = { table: "episodes", id: leaf.id, filePath: leaf.file_path ?? null });
  } else if (params.kind === "subItem") {
    const leaf = (await db.prepare("SELECT * FROM sub_items WHERE id = ? AND media_item_id = ?").get(params.leafId, item.id)) as any;
    if (!leaf) throw new HttpError(404, "Sub-item not found");
    ({ table, id, filePath } = { table: "sub_items", id: leaf.id, filePath: leaf.file_path ?? null });
  } else {
    if (effectiveShape({ type: item.type, legacyShape: item.legacy_shape }) !== "single") {
      throw new HttpError(409, "Only a single-file item has one file of its own; delete the files of its episodes or children");
    }
    ({ table, id, filePath } = { table: "media_items", id: item.id, filePath: item.path ?? null });
  }
  if (!filePath) throw new HttpError(404, "There is no file recorded for this entry");

  const roots = await rootPaths();
  const stat = await fsp.lstat(filePath).catch(() => null);
  if (stat?.isDirectory()) {
    // An album or an audiobook is a folder of its own; anything else stored as a folder is not one file.
    if (!(table === "sub_items" && getMediaTypeConfig(item.type).multiFilePerChild)) {
      throw new HttpError(409, `"${filePath}" is a folder, not a file; nothing was changed`);
    }
  }
  const sharer = await otherRowTracking(filePath, { table, id, itemId: item.id });
  if (sharer) throw new HttpError(409, `Another entry also uses "${sharer}"; nothing was changed`);

  if (!stat) {
    const offline = offlineStorageFor(filePath, roots);
    if (offline) throw new HttpError(409, `Not deleting: the file is not there because ${offline}`);
  } else if (!(await recycleFile(filePath, item.type, item.title, item.id))) {
    throw new HttpError(409, `Couldn't move "${filePath}" to the recycle bin (is it full or read-only?), so nothing was changed`);
  }

  const unmonitor = params.unmonitor ?? getSetting("unmonitorDeletedFiles") === "1";
  const column = table === "media_items" ? "path" : "file_path";
  // A multi-episode file belongs to every episode it covers.
  const where = table === "episodes" ? "media_item_id = ? AND file_path = ?" : "id = ?";
  const whereArgs = table === "episodes" ? [item.id, filePath] : [id];
  await db
    .prepare(
      `UPDATE ${table} SET has_file = 0, ${column} = NULL, quality = NULL, size_bytes = NULL, media_info = NULL,
       file_release_title = NULL, file_format_score = NULL${unmonitor ? ", monitored = 0" : ""} WHERE ${where}`
    )
    .run(...whereArgs);
  // An album's tracks pointed into the folder that is gone.
  if (table === "sub_items") await db.prepare("UPDATE tracks SET has_file = 0, file_path = NULL WHERE sub_item_id = ?").run(id);
  if (table !== "media_items") await rollUpParentMissing(item.id);
  if (!unmonitor) {
    if (table === "episodes") await wakeLeaf("episodes", id);
    else if (table === "sub_items") await wakeLeaf("sub_items", id);
    await resetSearchBackoff(item.id);
  }
  if (getSetting("deleteEmptyFolders") === "1") await removeEmptyParents(filePath, roots);
  await db
    .prepare("INSERT INTO history (media_item_id, event_type, data, episode_id, sub_item_id) VALUES (?, 'deleted', ?, ?, ?)")
    .run(
      item.id,
      JSON.stringify({ path: filePath, fileName: path.basename(filePath), reason: "Deleted by an admin", unmonitored: unmonitor }),
      table === "episodes" ? id : null,
      table === "sub_items" ? id : null
    );
  notifyFileDeleted(String(item.title), path.basename(filePath)).catch(() => undefined);
  return { path: filePath, unmonitored: unmonitor };
}
