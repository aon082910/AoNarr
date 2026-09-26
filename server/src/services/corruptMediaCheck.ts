import fs from "node:fs";
import { db } from "../db/index.js";
import { probeMediaInfo } from "./ffprobe.js";
import { recycleFile } from "./recycleBin.js";
import { log } from "./logger.js";
import { getMediaTypeConfig, isProbeableFile } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import { createOfflineStorageCheck } from "./deletedFileCheck.js";

export interface CorruptCheckResult {
  checked: number;
  corrupt: number;
}

export type CorruptTable = "media_items" | "episodes" | "sub_items";

/** What handling a flagged file did. "stale": the row no longer has that file (an upgrade, rename
 * or delete got there first); "unavailable": the file is missing only because its storage is
 * offline; "failed": the file couldn't be moved to the recycle bin, so the row was left alone. */
export type CorruptAction = "recycled" | "queued" | "stale" | "unavailable" | "failed";

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
 * download saved with a video extension. Returns the reason it failed, or null if it's fine — a
 * plain boolean would lose exactly the information a reviewer needs to judge a flagged file.
 * `confirm: false` skips the wait-and-retry confirmation, for re-checking a file an admin already
 * reviewed. */
export async function corruptReason(filePath: string, type: string, { confirm = true }: { confirm?: boolean } = {}): Promise<string | null> {
  if (!fs.existsSync(filePath)) {
    // A transient network/SMB mount hiccup can make a perfectly healthy file look momentarily
    // missing (existsSync swallows ENOENT, ESTALE, ENOTCONN, etc. alike) — same class of glitch
    // the ffprobe-failure path below already refuses to trust on a single check. Confirm the file
    // is genuinely still missing after a short wait before recycling it and clearing its DB row.
    if (confirm) await sleep(3000);
    if (!fs.existsSync(filePath)) return "File is missing from disk";
  }

  // ffprobe only understands real video/audio containers — an ebook, comic archive, ROM, etc. is
  // never going to probe successfully no matter how healthy it is, which without this check meant
  // every single Books/Comics/Manga/ROMs file in the library would eventually get flagged
  // "corrupt" and recycled by this job. Nothing to validate this way for those, so just trust that
  // the file existing on disk (checked above) means it's fine.
  if (!isProbeableFile(filePath)) return null;

  // Probe first — the fast path for the overwhelming majority of files, which are fine, so the
  // stability check and retry below only ever run for a file that's already failed once (paying
  // the extra few seconds only where it's actually needed, not on every healthy file in a library
  // that could be thousands of items).
  let info = await probeMediaInfo(filePath);
  if (!info && confirm) {
    if (await isStillBeingWritten(filePath)) return null;
    await sleep(3000);
    info = await probeMediaInfo(filePath);
  }
  if (!info) return "ffprobe couldn't read this file (corrupt or unrecognized data)";

  const looksLikeVideo = ["movie", "series", "anime", "sports", "ppv", "video", "course", "adult"].includes(type);
  if (looksLikeVideo && !info.videoCodec) return "No video stream found — likely a fake/mislabeled release";
  return null;
}

export function isCorruptMediaReviewEnabled(): boolean {
  return getSetting("corruptMediaReviewEnabled") === "1";
}

function pathColumn(table: CorruptTable): "path" | "file_path" {
  return table === "media_items" ? "path" : "file_path";
}

/** Why acting on a flagged file now would be wrong, or null. A detection can be hours old (the
 * weekly run works through the whole library one file at a time) or days old (the review queue):
 * by then an upgrade, rename or merge may have given the row a different file, and a file that
 * looks missing may only be on storage that has since gone offline. */
async function actionBlocker(table: CorruptTable, id: number, filePath: string): Promise<"stale" | "unavailable" | null> {
  const row = (await db.prepare(`SELECT has_file, ${pathColumn(table)} AS file_path FROM ${table} WHERE id = ?`).get(id)) as
    | { has_file: number; file_path: string | null }
    | undefined;
  if (!row || !Number(row.has_file) || row.file_path !== filePath) return "stale";
  if ((await createOfflineStorageCheck("corruptMediaCheck"))(filePath)) return "unavailable";
  return null;
}

export async function recycleAndMarkMissing(
  table: CorruptTable,
  id: number,
  filePath: string,
  type: string,
  title: string,
  mediaItemId: number
): Promise<CorruptAction> {
  const blocked = await actionBlocker(table, id, filePath);
  if (blocked) return blocked;
  if (!(await recycleFile(filePath, type, `${title} (corrupt)`, mediaItemId))) {
    log.warn(`[corruptMediaCheck] "${title}" failed validation but couldn't be moved to the recycle bin — left as is`);
    return "failed";
  }
  const pathCol = pathColumn(table);
  // Matched on the path too: an import can land a new file on this row while the recycle runs.
  const result = await db
    .prepare(`UPDATE ${table} SET has_file = 0, ${pathCol} = NULL, quality = NULL, size_bytes = NULL, media_info = NULL WHERE id = ? AND ${pathCol} = ?`)
    .run(id, filePath);
  if (table !== "media_items" && result.changes > 0) {
    // A series/collection whose last file this was must stop claiming has_file = 1 itself.
    await db
      .prepare(
        `UPDATE media_items SET has_file = 0 WHERE id = ? AND has_file = 1 AND path IS NULL
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1)
         AND NOT EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = media_items.id AND s.has_file = 1)`
      )
      .run(mediaItemId);
  }
  log.warn(`[corruptMediaCheck] "${title}" failed validation — moved to recycle bin, marked missing`);
  return "recycled";
}

export async function handleCorrupt(
  table: CorruptTable,
  id: number,
  filePath: string,
  type: string,
  title: string,
  mediaItemId: number,
  reason: string
): Promise<CorruptAction> {
  if (!isCorruptMediaReviewEnabled()) return recycleAndMarkMissing(table, id, filePath, type, title, mediaItemId);

  const blocked = await actionBlocker(table, id, filePath);
  if (blocked) return blocked;
  // Leave the file and the DB row alone — has_file stays 1, so the item still shows as present
  // until an admin actually confirms it. Only the queue entry is new.
  const existing = (await db
    .prepare("SELECT id, file_path FROM corrupt_media_review WHERE table_name = ? AND row_id = ?")
    .get(table, id)) as { id: number; file_path: string } | undefined;
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO corrupt_media_review (table_name, row_id, media_item_id, media_type, file_path, title, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(table, id, mediaItemId, type, filePath, title, reason);
    log.warn(`[corruptMediaCheck] "${title}" failed validation (${reason}) — queued for review`);
  } else if (existing.file_path !== filePath) {
    // The row has a different file than when it was first queued; the entry must describe this one.
    await db.prepare("UPDATE corrupt_media_review SET file_path = ?, reason = ? WHERE id = ?").run(filePath, reason, existing.id);
  }
  return "queued";
}

/** Walks every file AoNarr thinks it has and validates it with ffprobe, moving anything that
 * fails to the recycle bin and marking it missing again so the normal auto-search picks it back
 * up — the same "missing" state a never-downloaded item is in. Checks between items for
 * best-effort cancellation, same pattern as the other loop-based jobs. */
export async function checkForCorruptMedia(signal?: AbortSignal): Promise<CorruptCheckResult> {
  let checked = 0;
  let corrupt = 0;

  // Same unavailable-storage rule as the deleted-file check: an unmounted share or a stopped
  // debrid/rclone mount makes every file on it look missing, and treating that as corrupt wiped
  // the whole library's paths (and, for symlinks, recycled the links themselves). Re-checked after
  // a file fails too, since this run can take hours and a share can drop partway through.
  const isOffline = await createOfflineStorageCheck("corruptMediaCheck");
  const check = async (table: CorruptTable, id: number, filePath: string, type: string, title: string, mediaItemId: number) => {
    if (isOffline(filePath)) return;
    checked++;
    const reason = await corruptReason(filePath, type);
    if (!reason || isOffline(filePath)) return;
    const action = await handleCorrupt(table, id, filePath, type, title, mediaItemId, reason);
    if (action !== "stale" && action !== "unavailable") corrupt++;
  };

  const singleItems = (await db.prepare("SELECT id, type, title, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all()) as any[];
  for (const item of singleItems) {
    if (signal?.aborted) return { checked, corrupt };
    await check("media_items", item.id, item.path, item.type, item.title, item.id);
  }

  const episodes = (await db
    .prepare(
      `SELECT e.id, e.file_path, e.title, m.type, m.title AS media_title, m.id AS media_item_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.has_file = 1 AND e.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const ep of episodes) {
    if (signal?.aborted) return { checked, corrupt };
    await check("episodes", ep.id, ep.file_path, ep.type, `${ep.media_title} — ${ep.title ?? "episode"}`, ep.media_item_id);
  }

  const subItems = (await db
    .prepare(
      `SELECT s.id, s.file_path, s.title, m.type, m.title AS media_title, m.id AS media_item_id
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.has_file = 1 AND s.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const sub of subItems) {
    if (signal?.aborted) return { checked, corrupt };
    // Only shapes with one file per child are meaningfully checkable this way (Music's
    // multiFilePerChild stores per-track files elsewhere, not sub_items.file_path).
    if (getMediaTypeConfig(sub.type).multiFilePerChild) continue;
    await check("sub_items", sub.id, sub.file_path, sub.type, `${sub.media_title} — ${sub.title}`, sub.media_item_id);
  }

  return { checked, corrupt };
}
