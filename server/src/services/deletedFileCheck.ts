import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

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
  // and the next auto-search started re-grabbing the entire library.
  const roots = ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => {
    const resolved = path.resolve(r.path);
    let available = false;
    try {
      available = fs.statSync(resolved).isDirectory() && fs.readdirSync(resolved).length > 0;
    } catch {
      available = false;
    }
    return { path: resolved, available };
  });
  const unavailableRoots = roots.filter((r) => !r.available);
  for (const r of unavailableRoots) log.warn(`[deletedFileCheck] root folder "${r.path}" is missing or empty — skipping its files this run`);
  const isOnUnavailableRoot = (filePath: string) => {
    const resolved = path.resolve(filePath);
    const owner = roots
      .filter((r) => resolved.startsWith(r.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return !!owner && !owner.available;
  };

  const items = (await db.prepare("SELECT id, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all()) as {
    id: number;
    path: string;
  }[];
  for (const row of items) {
    checked++;
    if (fs.existsSync(row.path) || isOnUnavailableRoot(row.path)) continue;
    missing++;
    await db
      .prepare(`UPDATE media_items SET has_file = 0, path = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ?`)
      .run(row.id);
  }

  const episodes = (await db
    .prepare("SELECT id, file_path FROM episodes WHERE has_file = 1 AND file_path IS NOT NULL")
    .all()) as { id: number; file_path: string }[];
  for (const row of episodes) {
    checked++;
    if (fs.existsSync(row.file_path) || isOnUnavailableRoot(row.file_path)) continue;
    missing++;
    await db
      .prepare(`UPDATE episodes SET has_file = 0, file_path = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ?`)
      .run(row.id);
  }

  const subItems = (await db
    .prepare("SELECT id, file_path FROM sub_items WHERE has_file = 1 AND file_path IS NOT NULL")
    .all()) as { id: number; file_path: string }[];
  for (const row of subItems) {
    checked++;
    if (fs.existsSync(row.file_path) || isOnUnavailableRoot(row.file_path)) continue;
    missing++;
    await db
      .prepare(`UPDATE sub_items SET has_file = 0, file_path = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ?`)
      .run(row.id);
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
