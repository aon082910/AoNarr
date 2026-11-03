import path from "node:path";
import { db } from "../db/index.js";
import { ownFolderDepth, templateFolderLevels } from "./naming.js";

/**
 * A show keeps one folder. Sonarr stores each series' path, so a title correction, a rematch or a provider rename never
 * opens a second folder; AoNarr rendered the folder from the current title on every import and split the show
 * ("Agents of SHIELD" and "Marvel's Agents of S.H.I.E.L.D.", one episode in each). The folder is now the one the item
 * already uses: the stored `library_folder`, else the folder its first file is in, else the template's.
 *
 * `library_folder` is the folder's path below the root folder, with "/" between levels: "Arrow", or "A/Arrow" for a
 * library with a category level above the show folders.
 */

/** A folder name that is one plain path segment (no separators, no dot-dot) and so safe to join under a root folder. */
export function isPlainFolderName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

/** The levels of a stored `library_folder`, or null when it is empty or any level is not a plain name. */
export function folderSegmentsOf(stored: unknown): string[] | null {
  if (typeof stored !== "string" || stored.trim() === "") return null;
  const parts = stored.split("/");
  return parts.every((part) => isPlainFolderName(part)) ? parts : null;
}

function owningRoot(target: string, roots: string[]): string | null {
  const resolved = path.resolve(target);
  return roots.filter((r) => resolved.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * The title's own folder for one of its files (or, for an album, its folder): the template's own levels plus any
 * category levels above them in the file's real path ("TV/A/Arrow/Season 01/x.mkv" with the default series template is
 * "TV/A/Arrow"). Null when the template has no folder of the title's own, the file sits outside every root folder, or
 * its path is shallower than the template's.
 */
export function ownFolderOf(target: string, roots: string[], template: string, multiFilePerChild = false): string | null {
  const owner = owningRoot(target, roots);
  if (!owner) return null;
  const fileNameLast = !multiFilePerChild;
  const own = ownFolderDepth(template, fileNameLast);
  if (own === 0) return null;
  const rel = path.relative(owner, path.resolve(target)).split(path.sep).filter(Boolean);
  const have = fileNameLast ? rel.length - 1 : rel.length;
  if (have < own) return null;
  const extra = Math.max(0, have - templateFolderLevels(template, fileNameLast));
  return path.join(owner, ...rel.slice(0, own + extra));
}

/**
 * The template's path segments with the item's own folder in place of its leading title-folder levels, and how many
 * levels that folder has. A template with no stable folder of the title's own (flat, or varying by season in its first
 * part) is left as it is.
 */
export async function withItemFolder(
  item: { id: number; libraryFolder: string | null },
  rootPath: string,
  segments: string[],
  template: string
): Promise<{ segments: string[]; folderLength: number }> {
  const own = ownFolderDepth(template, true);
  if (own === 0 || segments.length <= own) return { segments, folderLength: 0 };
  const stored = folderSegmentsOf(item.libraryFolder);
  if (stored) return { segments: [...stored, ...segments.slice(own)], folderLength: stored.length };
  const files = (await db
    .prepare("SELECT file_path FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL ORDER BY season_number, episode_number")
    .all(item.id)) as { file_path: string }[];
  const root = path.resolve(rootPath);
  for (const file of files) {
    const folder = ownFolderOf(file.file_path, [root], template);
    if (!folder) continue;
    const found = path.relative(root, folder).split(path.sep);
    if (found.every((part) => isPlainFolderName(part))) return { segments: [...found, ...segments.slice(own)], folderLength: found.length };
  }
  return { segments, folderLength: own };
}

/** Remembers the folder an item's first import used. A later change of the title does not move it. */
export async function rememberItemFolder(itemId: number, folderSegments: string[]): Promise<void> {
  if (folderSegments.length === 0 || !folderSegments.every((part) => isPlainFolderName(part))) return;
  await db.prepare("UPDATE media_items SET library_folder = ? WHERE id = ? AND library_folder IS NULL").run(folderSegments.join("/"), itemId);
}
