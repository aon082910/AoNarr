import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { guardedFsCall, FS_CALL_TIMEOUT_MS } from "./fsAsync.js";
import { removeStaleImportTemps } from "./importer.js";

/** Deep enough for every library naming template's folders. */
const STALE_TEMP_SWEEP_DEPTH = 4;

/** A `setImmediate` yield only defers to the *next* event loop tick — for a library with tens of thousands of
 * directories (a season-by-season TV library easily has more directories than media items), that is still
 * thousands of consecutive turns with no real gap, which on a large library measurably starved HTTP handling for
 * minutes. A real (if tiny) per-directory delay spreads the same work over wall-clock time instead, so it never
 * dominates — this sweep has no user-facing deadline, unlike a request in flight. */
const SWEEP_DIR_DELAY_MS = 15;

/**
 * An import cut off by a restart leaves a `.aonarr-tmp-*` partial copy beside its destination; the next import to
 * that same file removes it, but one whose destination is never imported again would stay forever.
 * removeStaleImportTemps only takes temps untouched for an hour and never an in-flight copy of this process, so this
 * is safe to run alongside imports. Registered as the "Import Leftover Sweep" job (weekly, and shortly after a start),
 * so it shows on the Jobs page with its history, can be run by hand and cancelled.
 */
export async function sweepStaleImportTemps(signal?: AbortSignal): Promise<void> {
  const roots = (await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (signal?.aborted) return;
    await removeStaleImportTemps(dir);
    if (depth >= STALE_TEMP_SWEEP_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await guardedFsCall("readdir", dir, FS_CALL_TIMEOUT_MS, () => fs.promises.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (!entry.isDirectory()) continue;
      await new Promise((resolve) => setTimeout(resolve, SWEEP_DIR_DELAY_MS));
      await visit(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) await visit(root.path, 0);
}
