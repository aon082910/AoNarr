import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { trackedFileInside } from "./fileDeletion.js";
import { finishBackgroundJob, incrementBackgroundJobDone, startBackgroundJob, updateBackgroundJob } from "./backgroundJobs.js";
import { isOtherExistingEntry, makeLibraryDirectory, moveAlbumFolder, moveFile, removeEmptyParents } from "./importer.js";
import { folderSegmentsOf, ownFolderOf } from "./libraryFolder.js";
import { log } from "./logger.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { namingTemplateOfType } from "./naming.js";
import { rootFolderUnmountedReason } from "./rootFolderCheck.js";

/**
 * Moving a title to another root folder, like Sonarr's and Radarr's "move files" on a path edit.
 *
 * What moves is the title's own folder, whole: the video files, artwork, NFO, subtitles, extras folders and anything
 * else in it. The title's own folder is the stored `library_folder` of a show, else the leading folders of the naming
 * template that belong to the title (a movie's "Title (Year)", a show's "Show", a music artist's or an author's
 * folder), with any category levels above it kept. The folder lands at the same path below the new root folder.
 *
 * A title with no folder of its own (a movie file straight in a shared folder, a flat template), or whose folder
 * another title also has files in, moves only what it tracks: each tracked file with the files that carry its name
 * (subtitles, an NFO, "Name-poster.jpg"). An album folder tracked as a whole moves as a folder.
 *
 * Rows are repointed as each piece lands, so an interrupted or partly failed move leaves every row at the place its
 * file really is. The title's root folder changes only when everything moved; running the move again continues.
 */

export interface TitleMoveStep {
  kind: "folder" | "file";
  from: string;
  to: string;
}

export interface TitleMoveResult {
  moved: TitleMoveStep[];
  /** Things the move left where they were, with the reason; they do not stop the root folder change. */
  skipped: { path: string; reason: string }[];
  errors: { title: string; error: string }[];
  /** True when the title now belongs to the destination root folder. */
  rootFolderChanged: boolean;
}

/** Files beside a video that carry its name: subtitles, an NFO, its own artwork. */
const SIDECAR_EXTENSIONS = new Set([".nfo", ".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".jpg", ".jpeg", ".png", ".webp", ".tbn", ".gif"]);
const ARTWORK_SUFFIX_RE = /^-(poster|fanart|thumb|banner|clearlogo|clearart|landscape|backdrop|logo|disc|discart)\.(jpg|jpeg|png|webp|tbn)$/i;

/** The files in a video's folder named for it ("Movie.nfo", "Movie.en.srt", "Movie.jpg", "Movie-poster.jpg"). */
export function sidecarsOf(mediaFile: string): string[] {
  const dir = path.dirname(mediaFile);
  const mediaName = path.basename(mediaFile);
  const stem = path.basename(mediaFile, path.extname(mediaFile));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (name === mediaName) return false;
      if (name.startsWith(stem + ".")) return SIDECAR_EXTENSIONS.has(path.extname(name).toLowerCase());
      return name.startsWith(stem + "-") && ARTWORK_SUFFIX_RE.test(name.slice(stem.length));
    })
    .map((name) => path.join(dir, name));
}

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

interface TrackedPath {
  path: string;
  hasFile: boolean;
}

async function trackedPathsOf(itemId: number, itemPath: string | null, itemHasFile: boolean): Promise<TrackedPath[]> {
  const found = new Map<string, TrackedPath>();
  const add = (p: string | null | undefined, hasFile: boolean) => {
    if (!p) return;
    const key = path.resolve(p);
    const existing = found.get(key);
    found.set(key, { path: p, hasFile: hasFile || !!existing?.hasFile });
  };
  add(itemPath, itemHasFile);
  for (const row of (await db.prepare("SELECT file_path, has_file FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL").all(itemId)) as { file_path: string; has_file: number }[]) {
    add(row.file_path, Number(row.has_file) === 1);
  }
  for (const row of (await db.prepare("SELECT file_path, has_file FROM sub_items WHERE media_item_id = ? AND file_path IS NOT NULL").all(itemId)) as { file_path: string; has_file: number }[]) {
    add(row.file_path, Number(row.has_file) === 1);
  }
  return [...found.values()];
}

/** Points every row of the item that sits at or under `from` at the same place under `to`. */
async function repointRows(itemId: number, from: string, to: string): Promise<void> {
  const fromResolved = path.resolve(from);
  const swap = (p: string): string | null => {
    const resolved = path.resolve(p);
    if (resolved === fromResolved) return to;
    return resolved.startsWith(fromResolved + path.sep) ? path.join(to, path.relative(fromResolved, resolved)) : null;
  };
  const tables: { table: string; column: string; select: string; args: unknown[] }[] = [
    { table: "media_items", column: "path", select: "SELECT id, path AS p FROM media_items WHERE id = ? AND path IS NOT NULL", args: [itemId] },
    { table: "episodes", column: "file_path", select: "SELECT id, file_path AS p FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL", args: [itemId] },
    { table: "sub_items", column: "file_path", select: "SELECT id, file_path AS p FROM sub_items WHERE media_item_id = ? AND file_path IS NOT NULL", args: [itemId] },
    {
      table: "tracks",
      column: "file_path",
      select: "SELECT t.id AS id, t.file_path AS p FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id WHERE s.media_item_id = ? AND t.file_path IS NOT NULL",
      args: [itemId],
    },
  ];
  for (const { table, column, select, args } of tables) {
    const rows = (await db.prepare(select).all(...args)) as { id: number; p: string }[];
    for (const row of rows) {
      const next = swap(row.p);
      if (next !== null) await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(next, row.id);
    }
  }
}

export interface TitleMoveChecked {
  item: any;
  source: any | null;
  destination: any;
}

/** The checks that make a move refuse before anything happens. Throws HttpError. */
export async function checkTitleMove(itemId: number, destinationId: number): Promise<TitleMoveChecked> {
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  if (!item) throw new HttpError(404, "Media item not found");
  const destination = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(destinationId)) as any;
  if (!destination) throw new HttpError(404, "Destination root folder not found");
  if (destination.media_type !== item.type) throw new HttpError(400, `Can't move a ${getMediaTypeConfig(item.type).label} title into a ${destination.media_type} root folder`);
  if (Number(destination.read_only)) throw new HttpError(400, "The destination is a read-only library: nothing is moved into it");
  const source = item.root_folder_id != null ? (((await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.root_folder_id)) as any) ?? null) : null;
  if (source && Number(source.read_only)) throw new HttpError(400, "The source is a read-only library: its files are not moved out of it");
  return { item, source, destination };
}

interface PlannedUnit extends TitleMoveStep {
  /** Files that go with a `file` step (the sidecars). */
  sidecars: string[];
  /** The tracked paths this step covers, for the report of a failed one. */
  label: string;
}

/**
 * Works out what moves and moves it. `dryRun` returns the same steps without touching disk or rows.
 * Never throws for a problem with one piece: it is reported in `errors`.
 */
export async function moveTitleToRootFolder(itemId: number, destinationId: number, options: { dryRun?: boolean } = {}): Promise<TitleMoveResult> {
  const { item, source, destination } = await checkTitleMove(itemId, destinationId);
  const result: TitleMoveResult = { moved: [], skipped: [], errors: [], rootFolderChanged: false };
  const dryRun = !!options.dryRun;
  const title = String(item.title);

  if (source && Number(source.id) === Number(destination.id)) {
    result.rootFolderChanged = false;
    return result;
  }

  const destRoot = path.resolve(destination.path);
  let destStat: fs.Stats | null = null;
  try {
    destStat = fs.statSync(destRoot);
  } catch {
    // reported below
  }
  if (!destStat?.isDirectory()) {
    result.errors.push({ title, error: `The destination root folder "${destination.path}" is not a folder on disk` });
    return result;
  }

  const tracked = await trackedPathsOf(Number(item.id), item.path ?? null, Number(item.has_file) === 1);

  if (source && tracked.length > 0) {
    // A source share that did not come up looks like a library with every file missing.
    const unmounted = await rootFolderUnmountedReason({ id: Number(source.id), path: source.path });
    if (unmounted) {
      result.errors.push({ title, error: unmounted });
      return result;
    }
  }

  const sourceRoot = source ? path.resolve(source.path) : null;
  const template = namingTemplateOfType(item.type);
  const multiFile = !!getMediaTypeConfig(item.type).multiFilePerChild;
  const storedSegments = folderSegmentsOf(item.library_folder);
  const allRoots = ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => path.resolve(r.path));

  const ownFolderFor = (file: string): string | null => {
    if (!sourceRoot) return null;
    if (storedSegments) {
      const stored = path.join(sourceRoot, ...storedSegments);
      if (path.resolve(file).startsWith(stored + path.sep)) return stored;
    }
    return ownFolderOf(file, [sourceRoot], template, multiFile);
  };

  const units: PlannedUnit[] = [];
  const folderUnits = new Map<string, PlannedUnit>();
  const handledFolders = new Set<string>();
  const refusedFolders = new Map<string, string>();

  for (const entry of tracked) {
    const file = path.resolve(entry.path);
    // Already in the destination (an earlier run got this far).
    if (isUnder(destRoot, file)) continue;
    if (!sourceRoot || !isUnder(sourceRoot, file)) {
      result.skipped.push({ path: entry.path, reason: "it is not inside the title's current root folder, so it stays where it is" });
      continue;
    }
    if (!fs.existsSync(file)) {
      if (entry.hasFile) result.errors.push({ title, error: `"${entry.path}" is not on disk` });
      continue;
    }

    const folder = ownFolderFor(file);
    if (folder && !refusedFolders.has(folder)) {
      if (!handledFolders.has(folder)) {
        handledFolders.add(folder);
        const isRoot = allRoots.some((r) => r === folder || r.startsWith(folder + path.sep));
        const sharer = isRoot ? null : await trackedFileInside(folder, Number(item.id));
        if (isRoot || sharer) {
          refusedFolders.set(folder, isRoot ? "it is, or holds, a root folder" : `"${sharer}" belongs to another title`);
        } else {
          const unit: PlannedUnit = { kind: "folder", from: folder, to: path.join(destRoot, path.relative(sourceRoot, folder)), sidecars: [], label: folder };
          folderUnits.set(folder, unit);
          units.push(unit);
          continue;
        }
      } else if (folderUnits.has(folder)) {
        continue;
      }
    }
    if (folder && refusedFolders.has(folder)) {
      const reason = refusedFolders.get(folder)!;
      const note = `"${folder}" is not moved as a whole (${reason}): only this title's own files go`;
      if (!result.skipped.some((s) => s.reason === note)) result.skipped.push({ path: folder, reason: note });
    }

    // Only what this title tracks, from a folder it does not own alone. A tracked directory (an album) goes whole.
    const isDirectory = fs.statSync(file).isDirectory();
    const relDir = path.relative(sourceRoot, path.dirname(file));
    units.push(
      isDirectory
        ? { kind: "folder", from: file, to: path.join(destRoot, path.relative(sourceRoot, file)), sidecars: [], label: file }
        : { kind: "file", from: file, to: path.join(destRoot, relDir, path.basename(file)), sidecars: sidecarsOf(file), label: file }
    );
  }

  // A folder that holds another planned folder (a show folder and a tracked path inside it) moves once, as the outer one.
  const folders = units.filter((u) => u.kind === "folder");
  const planned = units.filter((u) => !folders.some((f) => f !== u && u.from.startsWith(f.from + path.sep)));

  for (const unit of planned) {
    if (isOtherExistingEntry(unit.from, unit.to)) {
      result.errors.push({ title, error: `"${unit.to}" already exists — not moving "${unit.from}" onto it` });
      continue;
    }
    if (unit.kind === "file") {
      // A sidecar whose new name is taken stays behind with the old one; the video itself is not blocked by it.
      const taken = unit.sidecars.filter((s) => isOtherExistingEntry(s, path.join(path.dirname(unit.to), path.basename(s))));
      for (const s of taken) result.skipped.push({ path: s, reason: "a file with that name already exists in the destination" });
      unit.sidecars = unit.sidecars.filter((s) => !taken.includes(s));
    }
    if (dryRun) {
      result.moved.push({ kind: unit.kind, from: unit.from, to: unit.to });
      continue;
    }
    try {
      if (unit.kind === "folder") {
        await moveAlbumFolder(unit.from, unit.to);
      } else {
        await moveFile(unit.from, unit.to, true);
        for (const s of unit.sidecars) {
          try {
            await moveFile(s, path.join(path.dirname(unit.to), path.basename(s)), true);
          } catch (err) {
            // Best effort: the video is where the row says it is, and a sidecar left behind loses nothing.
            result.skipped.push({ path: s, reason: (err as Error).message });
          }
        }
      }
      await repointRows(Number(item.id), unit.from, unit.to);
      result.moved.push({ kind: unit.kind, from: unit.from, to: unit.to });
      if (sourceRoot) {
        try {
          removeEmptyParents(path.dirname(unit.from), sourceRoot);
        } catch {
          // an empty folder left behind is cosmetic
        }
      }
    } catch (err) {
      result.errors.push({ title, error: `Moving "${unit.from}" failed: ${(err as Error).message}` });
      log.warn(`[titleMove] moving "${unit.from}" for "${title}" failed:`, (err as Error).message);
    }
  }

  if (result.errors.length === 0 && !dryRun) {
    await db.prepare("UPDATE media_items SET root_folder_id = ? WHERE id = ?").run(destination.id, item.id);
    result.rootFolderChanged = true;
  }
  return result;
}

/** Starts the move of one title as a tracked background job; answers with the job's id at once. */
export async function startTitleMoveJob(itemId: number, destinationId: number): Promise<{ jobId: string; title: string }> {
  const { item, destination } = await checkTitleMove(itemId, destinationId);
  const type = `title-${item.id}`;
  const label = `Move "${item.title}" to ${String(destination.name ?? "").trim() || destination.path}`;
  let jobId: string;
  try {
    jobId = startBackgroundJob("move", type, label, 1);
  } catch {
    throw new HttpError(409, `"${item.title}" is already being moved`);
  }
  void (async () => {
    let error: string | undefined;
    try {
      const result = await moveTitleToRootFolder(Number(item.id), Number(destination.id));
      if (result.errors.length > 0) error = result.errors.map((e) => e.error).join("; ");
      else log.info(`[titleMove] moved "${item.title}" to "${destination.path}" (${result.moved.length} piece(s))`);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      updateBackgroundJob("move", type, { done: 1 });
      finishBackgroundJob(jobId, error);
      if (error) log.warn(`[titleMove] "${item.title}" was not fully moved:`, error);
    }
  })();
  return { jobId, title: String(item.title) };
}

export interface RootFolderMoveSummary {
  moved: number;
  failed: number;
  total: number;
}

/**
 * Moves every title of a root folder to another of the same type, as one tracked job. `onDone` runs when it ends (the
 * audit entry). Titles are moved one at a time; a title that cannot be moved stays where it is and is counted.
 */
export function startRootFolderMoveJob(source: any, destination: any, items: { id: number; title: string }[], onDone: (summary: RootFolderMoveSummary) => void): string {
  const type = `root-${source.id}`;
  const label = `Move ${String(source.name ?? "").trim() || source.path} to ${String(destination.name ?? "").trim() || destination.path}`;
  let jobId: string;
  try {
    jobId = startBackgroundJob("move", type, label, items.length);
  } catch {
    throw new HttpError(409, "This root folder is already being moved");
  }
  void (async () => {
    let moved = 0;
    let failed = 0;
    try {
      for (const item of items) {
        try {
          const result = await moveTitleToRootFolder(item.id, Number(destination.id));
          if (result.errors.length > 0) {
            failed++;
            log.warn(`[rootFolders] didn't move "${item.title}" to "${destination.path}":`, result.errors.map((e) => e.error).join("; "));
          } else {
            moved++;
          }
        } catch (err) {
          failed++;
          log.warn(`[rootFolders] failed to move "${item.title}" to "${destination.path}":`, (err as Error).message);
        }
        incrementBackgroundJobDone("move", type);
      }
    } finally {
      log.info(`[rootFolders] moved ${moved}/${items.length} item(s) from "${source.path}" to "${destination.path}"`);
      finishBackgroundJob(jobId, failed > 0 ? `${failed} of ${items.length} title(s) could not be moved — see the Logs page` : undefined);
      onDone({ moved, failed, total: items.length });
    }
  })();
  return jobId;
}
