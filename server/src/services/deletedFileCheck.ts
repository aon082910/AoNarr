import fs from "node:fs";
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

  const items = (await db.prepare("SELECT id, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all()) as {
    id: number;
    path: string;
  }[];
  for (const row of items) {
    checked++;
    if (fs.existsSync(row.path)) continue;
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
    if (fs.existsSync(row.file_path)) continue;
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
    if (fs.existsSync(row.file_path)) continue;
    missing++;
    await db
      .prepare(`UPDATE sub_items SET has_file = 0, file_path = NULL${unmonitor ? ", monitored = 0" : ""} WHERE id = ?`)
      .run(row.id);
  }

  if (missing > 0) {
    log.info(
      `[deletedFileCheck] found ${missing} file(s) no longer on disk out of ${checked} checked${unmonitor ? " — unmonitored" : ""}`
    );
  }
  return { checked, missing };
}
