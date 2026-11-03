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
export async function validateNewRootFolder(rootPath: unknown): Promise<string> {
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

  let writable;
  try {
    writable = await canWrite(resolved);
  } catch (err) {
    throw new HttpError(400, `"${trimmed}" did not answer: ${(err as Error).message}`);
  }
  if (!writable.ok) throw new HttpError(400, `"${trimmed}" is not writable by AoNarr (${writable.reason}). Check the folder's owner or the mount's read-only flag.`);
  return trimmed;
}

/**
 * Root folders that look broken right now, for Health: gone (an unmounted share), not a folder, answering
 * too slowly, read-only, or empty although the library has files recorded in it (a share that did not come
 * up leaves an empty mount point). A root that is empty with nothing recorded in it is a new library and
 * is left alone.
 */
export async function findRootFolderProblems(timeoutMs = CHECK_TIMEOUT_MS): Promise<RootFolderProblem[]> {
  const rows = (await db.prepare("SELECT id, path FROM root_folders").all()) as { id: number; path: string }[];
  // The roots are independent. One after another, several dead shares would cost the timeout each.
  return (await Promise.all(rows.map((row) => checkOneRoot(row, timeoutMs)))).flat();
}

async function checkOneRoot(row: { id: number; path: string }, timeoutMs: number): Promise<RootFolderProblem[]> {
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

    const writable = await canWriteCheaply(row.path, timeoutMs);
    if (!writable.ok) return one("unwritable", `Root folder "${row.path}" is not writable (${writable.reason}). Is it mounted read-only?`);

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
