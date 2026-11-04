import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError } from "../middleware/errorHandler.js";
import { recycleBinDirectory } from "./recycleBin.js";
import { StorageTimeoutError, guardedFsCall, statAsync } from "./fsAsync.js";

const CHECK_TIMEOUT_MS = 10_000;

export type RootFolderProblemKind = "missing" | "not_a_directory" | "unwritable" | "empty" | "unreachable";

export interface RootFolderProblem {
  rootFolderId: number;
  path: string;
  kind: RootFolderProblemKind;
  message: string;
}

/** Whether `dir` can be written by this process: creates and removes a small probe file. */
async function canWrite(dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const probe = path.join(dir, `.aonarr-write-test-${process.pid}`);
  try {
    await guardedFsCall("write-probe", probe, CHECK_TIMEOUT_MS, () => fs.promises.writeFile(probe, ""));
    await guardedFsCall("rm-probe", probe, CHECK_TIMEOUT_MS, () => fs.promises.rm(probe, { force: true }));
    return { ok: true };
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
}

/**
 * The recurring writable test for Health: `access(W_OK)` answers EROFS on a read-only mount and EACCES on a folder
 * the process may not write, without creating anything. The real write probe (canWrite) stays for the moment a root
 * folder is added; doing it on every health refresh would spin up the disk that holds each root on an Unraid array.
 */
async function canWriteCheaply(dir: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await guardedFsCall("access-w", dir, timeoutMs, () => fs.promises.access(dir, fs.constants.W_OK));
    return { ok: true };
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
}

async function hasAnyEntry(dir: string, timeoutMs: number): Promise<boolean> {
  return guardedFsCall("first-entry", dir, timeoutMs, async () => {
    const handle = await fs.promises.opendir(dir);
    try {
      return (await handle.read()) !== null;
    } finally {
      await handle.close().catch(() => {});
    }
  });
}

/**
 * Why an import must not go into this root folder, or null. A share that did not come up leaves an empty mount point
 * (the folder exists, so assertInsideRoot lets the import through): every destination folder would then be created
 * on the container's own file system and the import would "succeed" into a tree nothing reads. A root that is empty
 * while the library has files recorded in it is that case; an empty root with nothing recorded is a new library. A
 * mount that does not answer reads as unknown (the move reports it). The caller throws a plain Error, which the
 * poller parks as transient and retries after 15 minutes, an hour and six hours.
 */
export async function rootFolderUnmountedReason(row: { id: number; path: string }, timeoutMs = CHECK_TIMEOUT_MS): Promise<string | null> {
  try {
    if (await hasAnyEntry(row.path, timeoutMs)) return null;
  } catch {
    return null; // missing or not answering: assertInsideRoot and the move itself say so
  }
  const recorded = (await db
    .prepare(
      `SELECT COUNT(*) AS c FROM media_items WHERE root_folder_id = ? AND (has_file = 1 OR EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1) OR EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = media_items.id AND s.has_file = 1))`
    )
    .get(row.id)) as { c: number };
  return Number(recorded.c) > 0
    ? `Root folder "${row.path}" is empty although ${recorded.c} item(s) have files recorded in it (is the share mounted?)`
    : null;
}

/**
 * Why files must not be moved into `destinationPath` (coming from `sourcePath`), or null. A share that is not mounted
 * leaves an empty directory on the container's own file system; a new, empty destination cannot be told from that by
 * looking at what is in it, but it shows as being on the same device as `/` while the source (a real mount) is not.
 * Files moved there would be copied into the container's writable layer and lost with the container. Not checked on
 * Windows (no device numbers worth comparing). A path that cannot be read gives no answer here: the move reports it.
 */
export async function destinationOnContainerDiskReason(
  destinationPath: string,
  sourcePath: string,
  statFn: (target: string) => Promise<{ dev: number }> = statAsync,
  platform: string = process.platform
): Promise<string | null> {
  if (platform === "win32") return null;
  try {
    const [container, source, destination] = await Promise.all([statFn("/"), statFn(sourcePath), statFn(destinationPath)]);
    if (destination.dev === container.dev && source.dev !== container.dev) {
      return `The destination "${destinationPath}" is on the container's own file system, not on a mount like "${sourcePath}" (is the share mounted?) — nothing is moved there`;
    }
  } catch {
    return null;
  }
  return null;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Sonarr/Radarr's root folder validation, on adding one: the path must be absolute, exist, be a directory
 * and be writable, must not be (or sit inside, or contain) another root folder, and must not be the
 * downloads folder, the recycle bin or the config folder. An absent path used to be accepted and then
 * silently created by the first import, so a typo or an unmounted share became a real directory tree on
 * the container's own file system.
 */
export async function validateNewRootFolder(rootPath: unknown, options: { readOnly?: boolean } = {}): Promise<string> {
  if (typeof rootPath !== "string" || rootPath.trim() === "") throw new HttpError(400, "path is required");
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) throw new HttpError(400, `"${trimmed}" is not an absolute path`);

  const resolved = path.resolve(trimmed);
  for (const [label, other] of [
    ["the downloads folder", config.downloadsDir],
    ["the recycle bin", recycleBinDirectory()],
    ["the config folder", config.configDir],
  ] as const) {
    if (isInside(other, resolved) || isInside(resolved, other)) {
      throw new HttpError(400, `"${trimmed}" is, contains or sits inside ${label} (${other}), which cannot also be a library folder`);
    }
  }

  const existing = (await db.prepare("SELECT id, path FROM root_folders").all()) as { id: number; path: string }[];
  for (const row of existing) {
    if (path.resolve(row.path) === resolved) throw new HttpError(409, `"${trimmed}" is already a root folder`);
    if (isInside(row.path, resolved) || isInside(resolved, row.path)) {
      throw new HttpError(409, `"${trimmed}" overlaps the existing root folder "${row.path}" (one contains the other)`);
    }
  }

  let stat: fs.Stats;
  try {
    stat = await statAsync(resolved, CHECK_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw new HttpError(400, `"${trimmed}" did not answer: ${err.message}`);
    throw new HttpError(400, `"${trimmed}" does not exist. Create the folder (or mount the share) first; AoNarr does not create root folders.`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `"${trimmed}" is not a folder`);

  // A library that is only scanned and served may sit on a read-only mount: nothing is ever imported into it.
  if (options.readOnly) return trimmed;
  await assertWritableRootFolder(resolved, trimmed);
  return trimmed;
}

/** Throws a 400 when AoNarr cannot write into the folder (the real write probe, used when a root is added or made writable). */
export async function assertWritableRootFolder(resolved: string, shown: string = resolved): Promise<void> {
  let writable;
  try {
    writable = await canWrite(resolved);
  } catch (err) {
    throw new HttpError(400, `"${shown}" did not answer: ${(err as Error).message}`);
  }
  if (!writable.ok) throw new HttpError(400, `"${shown}" is not writable by AoNarr (${writable.reason}). Check the folder's owner or the mount's read-only flag, or add it as a read-only library.`);
}

/**
 * Root folders that look broken right now, for Health: gone (an unmounted share), not a folder, answering
 * too slowly, read-only, or empty although the library has files recorded in it (a share that did not come
 * up leaves an empty mount point). A root that is empty with nothing recorded in it is a new library and
 * is left alone.
 */
export async function findRootFolderProblems(timeoutMs = CHECK_TIMEOUT_MS): Promise<RootFolderProblem[]> {
  const rows = (await db.prepare("SELECT id, path, read_only FROM root_folders").all()) as { id: number; path: string; read_only?: number }[];
  // The roots are independent. One after another, several dead shares would cost the timeout each.
  return (await Promise.all(rows.map((row) => checkOneRoot(row, timeoutMs)))).flat();
}

async function checkOneRoot(row: { id: number; path: string; read_only?: number }, timeoutMs: number): Promise<RootFolderProblem[]> {
  const one = (kind: RootFolderProblemKind, message: string): RootFolderProblem[] => [{ rootFolderId: row.id, path: row.path, kind, message }];
  try {
    let stat: fs.Stats;
    try {
      stat = await statAsync(row.path, timeoutMs);
    } catch (err) {
      if (err instanceof StorageTimeoutError) throw err;
      return one("missing", `Root folder "${row.path}" is missing. Is the share mounted?`);
    }
    if (!stat.isDirectory()) return one("not_a_directory", `Root folder "${row.path}" is not a folder`);

    // A read-only library is meant to be: only the other checks apply to it.
    if (!Number(row.read_only ?? 0)) {
      const writable = await canWriteCheaply(row.path, timeoutMs);
      if (!writable.ok) return one("unwritable", `Root folder "${row.path}" is not writable (${writable.reason}). Is it mounted read-only?`);
    }

    if (!(await hasAnyEntry(row.path, timeoutMs))) {
      const recorded = (await db
        .prepare(
          `SELECT COUNT(*) AS c FROM media_items WHERE root_folder_id = ? AND (has_file = 1 OR EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1))`
        )
        .get(row.id)) as { c: number };
      if (Number(recorded.c) > 0) {
        return one("empty", `Root folder "${row.path}" is empty although ${recorded.c} item(s) have files recorded in it. Is the share mounted?`);
      }
    }
    return [];
  } catch (err) {
    if (err instanceof StorageTimeoutError) return one("unreachable", `Root folder "${row.path}" is not answering (${err.message})`);
    throw err;
  }
}
