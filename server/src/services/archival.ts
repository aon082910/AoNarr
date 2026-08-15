import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/client.js";
import { getSetting } from "./settingsStore.js";
import { fetchWatchedFiles, getMediaServerConfig, type WatchedFile } from "./mediaServer.js";

/**
 * Plex/Jellyfin/Emby usually mount the library at a different path than AoNarr sees (e.g. Plex's
 * `/data/movies/...` vs AoNarr's `/media/movies/...` inside their own containers), so an exact
 * path match is unreliable. Comparing the last two path segments (parent folder + filename) is a
 * much safer heuristic given each media item normally lives in its own folder.
 */
export function pathTail(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

export function findWatchedMatch(filePath: string | null, watched: WatchedFile[]): WatchedFile | null {
  if (!filePath) return null;
  const tail = pathTail(filePath);
  return watched.find((w) => pathTail(w.path) === tail) ?? null;
}

function moveOrDelete(filePath: string, archiveFolder: string | null, permanentDelete: boolean): void {
  if (permanentDelete || !archiveFolder) {
    fs.unlinkSync(filePath);
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
function effectiveRetentionDays(mediaItemId: number, globalDefaultDays: number): number | null {
  const tagOverrides = (
    db
      .prepare(
        `SELECT t.retention_days AS r FROM tags t
         JOIN media_item_tags mit ON mit.tag_id = t.id
         WHERE mit.media_item_id = ? AND t.retention_days IS NOT NULL`
      )
      .all(mediaItemId) as { r: number }[]
  ).map((row) => row.r);

  const collectionOverrides = (
    db
      .prepare(
        `SELECT c.retention_days AS r FROM collections c
         JOIN collection_items ci ON ci.collection_id = c.id
         WHERE ci.media_item_id = ? AND c.retention_days IS NOT NULL`
      )
      .all(mediaItemId) as { r: number }[]
  ).map((row) => row.r);

  const overrides = [...tagOverrides, ...collectionOverrides];
  if (overrides.length === 0) return globalDefaultDays;
  if (overrides.includes(-1)) return null; // never archive
  return Math.max(...overrides);
}

function logArchival(mediaItemId: number, title: string, mode: "archived" | "deleted"): void {
  db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'auto_archived', ?)`).run(
    mediaItemId,
    JSON.stringify({ title, mode })
  );
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

  const singleItems = db
    .prepare("SELECT * FROM media_items WHERE has_file = 1 AND protected = 0 AND path IS NOT NULL")
    .all() as any[];
  for (const item of singleItems) {
    const match = findWatchedMatch(item.path, watched);
    if (!match) continue;
    const retentionDays = effectiveRetentionDays(item.id, afterDays);
    if (retentionDays === null) continue; // never-archive override
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    try {
      moveOrDelete(item.path, archiveFolder, permanentDelete);
      db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(item.id);
      logArchival(item.id, item.title, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${item.title}":`, (err as Error).message);
    }
  }

  const episodes = db
    .prepare(
      `SELECT e.*, m.title AS media_title, m.protected AS media_protected
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND m.protected = 0 AND e.file_path IS NOT NULL`
    )
    .all() as any[];
  for (const ep of episodes) {
    const match = findWatchedMatch(ep.file_path, watched);
    if (!match) continue;
    const retentionDays = effectiveRetentionDays(ep.media_item_id, afterDays);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    const label = `${ep.media_title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
    try {
      moveOrDelete(ep.file_path, archiveFolder, permanentDelete);
      db.prepare("UPDATE episodes SET has_file = 0, file_path = NULL, quality = NULL WHERE id = ?").run(ep.id);
      logArchival(ep.media_item_id, label, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${label}":`, (err as Error).message);
    }
  }

  const subItems = db
    .prepare(
      `SELECT s.*, m.title AS media_title, m.protected AS media_protected
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
       WHERE s.has_file = 1 AND m.protected = 0 AND s.file_path IS NOT NULL`
    )
    .all() as any[];
  for (const sub of subItems) {
    const match = findWatchedMatch(sub.file_path, watched);
    if (!match) continue;
    const retentionDays = effectiveRetentionDays(sub.media_item_id, afterDays);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    const label = `${sub.media_title} - ${sub.title}`;
    try {
      moveOrDelete(sub.file_path, archiveFolder, permanentDelete);
      db.prepare("UPDATE sub_items SET has_file = 0, file_path = NULL, quality = NULL WHERE id = ?").run(sub.id);
      logArchival(sub.media_item_id, label, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${label}":`, (err as Error).message);
    }
  }
}
