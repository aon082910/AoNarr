import fs from "node:fs";
import { db } from "../db/client.js";
import { probeMediaInfo } from "./ffprobe.js";
import { recycleFile } from "./recycleBin.js";
import { log } from "./logger.js";
import { getMediaTypeConfig } from "./mediaTypes.js";

export interface CorruptCheckResult {
  checked: number;
  corrupt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A single ffprobe failure ("Invalid data found when processing input", "EBML header", a
 * timeout, etc.) doesn't distinguish a genuinely corrupt file from a transient one — a file still
 * mid-write by something else with access to the root folder, a network/SMB mount hiccup, a brief
 * lock. Both look identical to ffprobe: it can't parse what's currently on disk. Before trusting a
 * single failure enough to recycle a file, confirm the file isn't still changing size (a dead
 * giveaway it's still being written) and give ffprobe one retry a few seconds later — cheap
 * insurance against exactly the false-positive class this weekly background job has no business
 * risking real data over. */
async function isStillBeingWritten(filePath: string): Promise<boolean> {
  try {
    const before = fs.statSync(filePath).size;
    await sleep(3000);
    const after = fs.statSync(filePath).size;
    return before !== after;
  } catch {
    return false;
  }
}

/** A file counts as corrupt if it's gone from disk despite the DB saying it has one, or ffprobe
 * can't make sense of it (after ruling out "it's still being written" and giving it one retry), or
 * (for a library whose shape is actual video) ffprobe succeeds but finds no video stream at all —
 * a classic symptom of a fake/mislabeled release that's actually an html error page or a truncated
 * download saved with a video extension. */
async function isCorrupt(filePath: string, type: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return true;

  // Probe first — the fast path for the overwhelming majority of files, which are fine, so the
  // stability check and retry below only ever run for a file that's already failed once (paying
  // the extra few seconds only where it's actually needed, not on every healthy file in a library
  // that could be thousands of items).
  let info = await probeMediaInfo(filePath);
  if (!info) {
    if (await isStillBeingWritten(filePath)) return false;
    await sleep(3000);
    info = await probeMediaInfo(filePath);
  }
  if (!info) return true;

  const looksLikeVideo = ["movie", "series", "anime", "video", "course", "adult"].includes(type);
  if (looksLikeVideo && !info.videoCodec) return true;
  return false;
}

async function handleCorrupt(
  table: "media_items" | "episodes" | "sub_items",
  id: number,
  filePath: string,
  type: string,
  title: string,
  mediaItemId: number
): Promise<void> {
  recycleFile(filePath, type, `${title} (corrupt)`, mediaItemId);
  const pathCol = table === "media_items" ? "path" : "file_path";
  db.prepare(`UPDATE ${table} SET has_file = 0, ${pathCol} = NULL, quality = NULL WHERE id = ?`).run(id);
  log.warn(`[corruptMediaCheck] "${title}" failed validation — moved to recycle bin, marked missing`);
}

/** Walks every file AoNarr thinks it has and validates it with ffprobe, moving anything that
 * fails to the recycle bin and marking it missing again so the normal auto-search picks it back
 * up — the same "missing" state a never-downloaded item is in. Checks between items for
 * best-effort cancellation, same pattern as the other loop-based jobs. */
export async function checkForCorruptMedia(signal?: AbortSignal): Promise<CorruptCheckResult> {
  let checked = 0;
  let corrupt = 0;

  const singleItems = db.prepare("SELECT id, type, title, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all() as any[];
  for (const item of singleItems) {
    if (signal?.aborted) return { checked, corrupt };
    checked++;
    if (await isCorrupt(item.path, item.type)) {
      corrupt++;
      await handleCorrupt("media_items", item.id, item.path, item.type, item.title, item.id);
    }
  }

  const episodes = db
    .prepare(
      `SELECT e.id, e.file_path, e.title, m.type, m.title AS media_title, m.id AS media_item_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.has_file = 1 AND e.file_path IS NOT NULL`
    )
    .all() as any[];
  for (const ep of episodes) {
    if (signal?.aborted) return { checked, corrupt };
    checked++;
    if (await isCorrupt(ep.file_path, ep.type)) {
      corrupt++;
      await handleCorrupt("episodes", ep.id, ep.file_path, ep.type, `${ep.media_title} — ${ep.title ?? "episode"}`, ep.media_item_id);
    }
  }

  const subItems = db
    .prepare(
      `SELECT s.id, s.file_path, s.title, m.type, m.title AS media_title, m.id AS media_item_id
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.has_file = 1 AND s.file_path IS NOT NULL`
    )
    .all() as any[];
  for (const sub of subItems) {
    if (signal?.aborted) return { checked, corrupt };
    // Only shapes with one file per child are meaningfully checkable this way (Music's
    // multiFilePerChild stores per-track files elsewhere, not sub_items.file_path).
    if (getMediaTypeConfig(sub.type).multiFilePerChild) continue;
    checked++;
    if (await isCorrupt(sub.file_path, sub.type)) {
      corrupt++;
      await handleCorrupt("sub_items", sub.id, sub.file_path, sub.type, `${sub.media_title} — ${sub.title}`, sub.media_item_id);
    }
  }

  return { checked, corrupt };
}
