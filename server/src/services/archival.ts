import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { fetchWatchedFiles, getMediaServerConfig, type WatchedFile } from "./mediaServer.js";
import { recycleFile } from "./recycleBin.js";

/**
 * Plex/Jellyfin/Emby usually mount the library at a different path than AoNarr sees (e.g. Plex's
 * `/data/movies/...` vs AoNarr's `/media/movies/...` inside their own containers), so an exact
 * path match is unreliable. Comparing the last three path segments is a much safer heuristic given
 * each media item normally lives in its own folder — three rather than two specifically because a
 * generically-named episode file under a generic season folder ("Season 01/S01E01.mkv") is common
 * enough that two segments alone can collide across two *different* shows; the third segment reaches
 * up to the item's own folder name (the show, or the movie's release folder), which is what actually
 * disambiguates one item from another. A mount-point prefix difference never touches these trailing
 * segments, so this is strictly more specific than the old two-segment comparison with no loss of
 * legitimate cross-mount-point matches — verified during Round 67 development, where a test fixture
 * using identical "Season 01/S01E01.mkv" episode paths for two unrelated shows produced exactly this
 * false-positive collision under the two-segment version.
 */
export function pathTail(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-3).join("/").toLowerCase();
}

export function findWatchedMatch(filePath: string | null, watched: WatchedFile[]): WatchedFile | null {
  if (!filePath) return null;
  const tail = pathTail(filePath);
  return watched.find((w) => pathTail(w.path) === tail) ?? null;
}

async function moveOrDelete(
  filePath: string,
  archiveFolder: string | null,
  permanentDelete: boolean,
  mediaType: string,
  title: string,
  mediaItemId: number
): Promise<void> {
  if (permanentDelete || !archiveFolder) {
    // "Permanently delete" here means "don't keep an archive copy" — it still goes through the
    // recycle bin (unless that's disabled instance-wide), since the whole point of a recycle bin
    // is catching exactly this kind of automated deletion.
    await recycleFile(filePath, mediaType, title, mediaItemId);
    return;
  }
  fs.mkdirSync(archiveFolder, { recursive: true });
  const dest = path.join(archiveFolder, path.basename(filePath));
  try {
    fs.renameSync(filePath, dest);
  } catch {
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
}

/**
 * A tag or collection can override the instance-wide retention for the media items it's applied
 * to — e.g. "Kids" tagged as never-archive, or a "Comfort rewatches" collection kept for a full
 * year instead of the global 30 days. `-1` means never archive. When more than one override
 * applies (a movie tagged "Kids" that's also in a long-retention collection), the *most
 * protective* one wins — never beats any duration, and among durations the longest wins — since
 * these overrides exist to protect content the default policy would otherwise sweep up.
 */
async function effectiveRetentionDays(mediaItemId: number, globalDefaultDays: number): Promise<number | null> {
  const tagOverrides = (
    (await db
      .prepare(
        `SELECT t.retention_days AS r FROM tags t
         JOIN media_item_tags mit ON mit.tag_id = t.id
         WHERE mit.media_item_id = ? AND t.retention_days IS NOT NULL`
      )
      .all(mediaItemId)) as { r: number }[]
  ).map((row) => row.r);

  const collectionOverrides = (
    (await db
      .prepare(
        `SELECT c.retention_days AS r FROM collections c
         JOIN collection_items ci ON ci.collection_id = c.id
         WHERE ci.media_item_id = ? AND c.retention_days IS NOT NULL`
      )
      .all(mediaItemId)) as { r: number }[]
  ).map((row) => row.r);

  const overrides = [...tagOverrides, ...collectionOverrides];
  if (overrides.length === 0) return globalDefaultDays;
  if (overrides.includes(-1)) return null; // never archive
  return Math.max(...overrides);
}

async function logArchival(mediaItemId: number, title: string, mode: "archived" | "deleted"): Promise<void> {
  await db
    .prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'auto_archived', ?)`)
    .run(mediaItemId, JSON.stringify({ title, mode }));
  log.info(`[archival] ${mode} "${title}" (watched + past retention window)`);
}

/**
 * Finds watched, aged, unprotected files and archives (default, reversible — moves the file to
 * the configured archive folder) or permanently deletes them (explicit opt-in only).
 */
export async function runAutoArchival(): Promise<void> {
  if (getSetting("archiveEnabled") !== "1") return;
  if (!getMediaServerConfig()) return;

  const afterDays = Number(getSetting("archiveAfterDays") ?? "30") || 30;
  const archiveFolder = getSetting("archiveFolder");
  const permanentDelete = getSetting("archivePermanentDelete") === "1";
  if (!permanentDelete && !archiveFolder) {
    log.warn("[archival] skipping: no archive folder configured and permanent delete is not enabled");
    return;
  }

  let watched: WatchedFile[];
  try {
    watched = await fetchWatchedFiles();
  } catch (err) {
    log.warn("[archival] failed to fetch watch status from media server:", (err as Error).message);
    return;
  }
  if (watched.length === 0) return;

  const singleItems = (await db
    .prepare("SELECT * FROM media_items WHERE has_file = 1 AND protected = 0 AND path IS NOT NULL")
    .all()) as any[];
  for (const item of singleItems) {
    const match = findWatchedMatch(item.path, watched);
    if (!match) continue;
    const retentionDays = await effectiveRetentionDays(item.id, afterDays);
    if (retentionDays === null) continue; // never-archive override
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    try {
      await moveOrDelete(item.path, archiveFolder, permanentDelete, item.type, item.title, item.id);
      await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(item.id);
      await logArchival(item.id, item.title, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${item.title}":`, (err as Error).message);
    }
  }

  const episodes = (await db
    .prepare(
      `SELECT e.*, m.title AS media_title, m.protected AS media_protected, m.type AS media_type
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND m.protected = 0 AND e.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const ep of episodes) {
    const match = findWatchedMatch(ep.file_path, watched);
    if (!match) continue;
    const retentionDays = await effectiveRetentionDays(ep.media_item_id, afterDays);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    const label = `${ep.media_title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
    try {
      await moveOrDelete(ep.file_path, archiveFolder, permanentDelete, ep.media_type, label, ep.media_item_id);
      await db.prepare("UPDATE episodes SET has_file = 0, file_path = NULL, quality = NULL WHERE id = ?").run(ep.id);
      await logArchival(ep.media_item_id, label, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${label}":`, (err as Error).message);
    }
  }

  const subItems = (await db
    .prepare(
      `SELECT s.*, m.title AS media_title, m.protected AS media_protected, m.type AS media_type
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
       WHERE s.has_file = 1 AND m.protected = 0 AND s.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const sub of subItems) {
    const match = findWatchedMatch(sub.file_path, watched);
    if (!match) continue;
    const retentionDays = await effectiveRetentionDays(sub.media_item_id, afterDays);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    const label = `${sub.media_title} - ${sub.title}`;
    try {
      await moveOrDelete(sub.file_path, archiveFolder, permanentDelete, sub.media_type, label, sub.media_item_id);
      await db.prepare("UPDATE sub_items SET has_file = 0, file_path = NULL, quality = NULL WHERE id = ?").run(sub.id);
      await logArchival(sub.media_item_id, label, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${label}":`, (err as Error).message);
    }
  }
}
