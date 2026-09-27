import { log } from "./logger.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { fetchWatchedFiles, getMediaServerConfig, type WatchedFile } from "./mediaServer.js";
import { recycleFile } from "./recycleBin.js";
import { createOfflineStorageCheck } from "./deletedFileCheck.js";

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

/** `findWatchedMatch` used to re-derive every watched file's `pathTail` on every single call —
 * fine for a one-off lookup, but each of this module's own functions calls it once per media
 * item/episode/sub-item, so a library-wide pass turned into `pathTail(watched[i])` running
 * `(library size) x (watched list size)` times. Building this index once per pass and doing an
 * O(1) lookup per item turns that into `O(library size + watched list size)`. Keyed by the last
 * watched entry for a given tail (matching `.find()`'s original first-match semantics almost
 * never differs in practice — a tail collision means two watched entries share their last three
 * path segments, which is already the rare edge case `pathTail`'s own doc comment discusses). */
export function buildWatchedIndex(watched: WatchedFile[]): Map<string, WatchedFile> {
  const index = new Map<string, WatchedFile>();
  for (const w of watched) {
    const tail = pathTail(w.path);
    if (!index.has(tail)) index.set(tail, w);
  }
  return index;
}

export function findWatchedMatch(filePath: string | null, watchedIndex: Map<string, WatchedFile>): WatchedFile | null {
  if (!filePath) return null;
  return watchedIndex.get(pathTail(filePath)) ?? null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Where an archived file goes: its path under the root folder it lives in (or, outside every
 * root folder, its last three path segments, as in pathTail), mirrored under the archive folder,
 * and numbered " (1)", " (2)"... rather than replacing anything already there. A flat folder keyed
 * by file name let a second show's "Season 01/S01E01.mkv" overwrite the first's. */
async function archiveDestination(filePath: string, archiveFolder: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const roots = ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => path.resolve(r.path));
  const owner = roots.filter((r) => resolved.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  const relative = owner ? path.relative(owner, resolved) : path.join(...resolved.split(path.sep).filter(Boolean).slice(-3));
  const base = path.join(archiveFolder, relative);
  const ext = path.extname(base);
  let dest = base;
  for (let n = 1; await pathExists(dest); n++) dest = `${base.slice(0, base.length - ext.length)} (${n})${ext}`;
  return dest;
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
    if (!(await recycleFile(filePath, mediaType, title, mediaItemId))) throw new Error("couldn't remove the file (its storage may be offline)");
    return;
  }
  const dest = await archiveDestination(filePath, archiveFolder);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(filePath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Cross-filesystem (e.g. /config vs /media in Docker) — fsp.cp/rm hand the copy off to
    // libuv's thread pool instead of blocking Node's single event loop for as long as a
    // multi-GB archive move takes, same reasoning as recycleBin.ts's moveFileAsync.
    await fsp.cp(filePath, dest, { recursive: true, force: false, errorOnExist: true });
    await fsp.rm(filePath, { recursive: true, force: true });
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
export async function effectiveRetentionDays(mediaItemId: number, globalDefaultDays: number): Promise<number | null> {
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

/** Every media item that has *any* retention override, tag- or collection-sourced, in exactly two
 * queries total — `effectiveRetentionDays` above does the same two queries per item, which is
 * fine for a single-item call but turns a library-wide archival pass into two queries per item
 * (tens of thousands of extra synchronous statements on this scale). Both callers below that
 * sweep the whole library build this once up front and use `resolveRetentionDays` (a plain Map
 * lookup, same override-precedence rules) inside their loops instead. */
async function buildRetentionOverrideIndex(): Promise<Map<number, number[]>> {
  const index = new Map<number, number[]>();
  const add = (mediaItemId: number, r: number) => {
    const existing = index.get(mediaItemId);
    if (existing) existing.push(r);
    else index.set(mediaItemId, [r]);
  };
  (
    (await db
      .prepare(
        `SELECT mit.media_item_id AS id, t.retention_days AS r FROM tags t
         JOIN media_item_tags mit ON mit.tag_id = t.id
         WHERE t.retention_days IS NOT NULL`
      )
      .all()) as { id: number; r: number }[]
  ).forEach((row) => add(row.id, row.r));
  (
    (await db
      .prepare(
        `SELECT ci.media_item_id AS id, c.retention_days AS r FROM collections c
         JOIN collection_items ci ON ci.collection_id = c.id
         WHERE c.retention_days IS NOT NULL`
      )
      .all()) as { id: number; r: number }[]
  ).forEach((row) => add(row.id, row.r));
  return index;
}

function resolveRetentionDays(mediaItemId: number, globalDefaultDays: number, overridesByItem: Map<number, number[]>): number | null {
  const overrides = overridesByItem.get(mediaItemId);
  if (!overrides || overrides.length === 0) return globalDefaultDays;
  if (overrides.includes(-1)) return null; // never archive
  return Math.max(...overrides);
}

async function logArchival(mediaItemId: number, title: string, mode: "archived" | "deleted"): Promise<void> {
  await db
    .prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'auto_archived', ?)`)
    .run(mediaItemId, JSON.stringify({ title, mode }));
  log.info(`[archival] ${mode} "${title}" (watched + past retention window)`);
}

/** The instance-wide retention in days. 0 is a real setting ("archive as soon as it's watched"),
 * so only a blank or unparseable value falls back to the default. */
function archiveAfterDays(): number {
  const configured = parseInt(getSetting("archiveAfterDays") ?? "", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30;
}

export interface ArchivalCandidate {
  mediaItemId: number;
  title: string;
  type: string;
  filePath: string;
  scheduledFor: Date; // when its retention window closes (lastPlayedAt + effective retention days)
}

/**
 * Read-only pass over the same eligibility logic runAutoArchival uses to actually act — every
 * watched, unprotected file with a file, its scheduled cutoff date computed the same way, but
 * nothing touched. Maintainerr's "Leaving Soon" idea: a preview of what the next run will sweep
 * up, so nothing disappears as a surprise. `scheduledFor` naturally moves later (or the item drops
 * off this list entirely) the moment someone rewatches something, since lastPlayedAt is re-fetched
 * live from the media server on every call — no separate "reset the timer" logic needed.
 */
export async function getUpcomingArchivals(): Promise<ArchivalCandidate[]> {
  if (!getMediaServerConfig()) return [];
  if (getSetting("archiveEnabled") !== "1") return [];
  const archiveFolder = getSetting("archiveFolder");
  const permanentDelete = getSetting("archivePermanentDelete") === "1";
  if (!permanentDelete && !archiveFolder) return [];
  const afterDays = archiveAfterDays();

  let watched: WatchedFile[];
  try {
    watched = await fetchWatchedFiles();
  } catch {
    return [];
  }
  if (watched.length === 0) return [];
  const watchedIndex = buildWatchedIndex(watched);
  const overridesByItem = await buildRetentionOverrideIndex();

  const candidates: ArchivalCandidate[] = [];

  const singleItems = (await db.prepare("SELECT * FROM media_items WHERE has_file = 1 AND protected = 0 AND path IS NOT NULL").all()) as any[];
  for (const item of singleItems) {
    const match = findWatchedMatch(item.path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(item.id, afterDays, overridesByItem);
    if (retentionDays === null) continue;
    candidates.push({
      mediaItemId: item.id,
      title: item.title,
      type: item.type,
      filePath: item.path,
      scheduledFor: new Date(match.lastPlayedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
    });
  }

  const episodes = (await db
    .prepare(
      `SELECT e.*, m.title AS media_title, m.type AS media_type
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND m.protected = 0 AND e.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const ep of episodes) {
    const match = findWatchedMatch(ep.file_path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(ep.media_item_id, afterDays, overridesByItem);
    if (retentionDays === null) continue;
    candidates.push({
      mediaItemId: ep.media_item_id,
      title: `${ep.media_title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`,
      type: ep.media_type,
      filePath: ep.file_path,
      scheduledFor: new Date(match.lastPlayedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
    });
  }

  const subItems = (await db
    .prepare(
      `SELECT s.*, m.title AS media_title, m.type AS media_type
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
       WHERE s.has_file = 1 AND m.protected = 0 AND s.file_path IS NOT NULL`
    )
    .all()) as any[];
  for (const sub of subItems) {
    const match = findWatchedMatch(sub.file_path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(sub.media_item_id, afterDays, overridesByItem);
    if (retentionDays === null) continue;
    candidates.push({
      mediaItemId: sub.media_item_id,
      title: `${sub.media_title} - ${sub.title}`,
      type: sub.media_type,
      filePath: sub.file_path,
      scheduledFor: new Date(match.lastPlayedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
    });
  }

  return candidates.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
}

/**
 * Finds watched, aged, unprotected files and archives (default, reversible — moves the file to
 * the configured archive folder) or permanently deletes them (explicit opt-in only).
 */
export async function runAutoArchival(): Promise<void> {
  if (getSetting("archiveEnabled") !== "1") return;
  if (!getMediaServerConfig()) return;

  const afterDays = archiveAfterDays();
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
  const watchedIndex = buildWatchedIndex(watched);
  const overridesByItem = await buildRetentionOverrideIndex();

  // A file on an unmounted share or a dead rclone/debrid mount looks already gone, and the recycle
  // bin reports a missing file as removed: its row would be cleared and unmonitored for good.
  const isOffline = await createOfflineStorageCheck("archival");

  const singleItems = (await db
    .prepare("SELECT * FROM media_items WHERE has_file = 1 AND protected = 0 AND path IS NOT NULL")
    .all()) as any[];
  for (const item of singleItems) {
    const match = findWatchedMatch(item.path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(item.id, afterDays, overridesByItem);
    if (retentionDays === null) continue; // never-archive override
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    if (isOffline(item.path)) continue;
    try {
      await moveOrDelete(item.path, archiveFolder, permanentDelete, item.type, item.title, item.id);
      // Also unmonitored (here and for episodes/sub-items below): the file was watched and
      // deliberately cleared out, so auto-search — which only skips unmonitored or has_file rows —
      // mustn't treat it as missing and re-download it on its next pass, which the media server
      // would then report as watched again and the next archival run would archive again, forever.
      await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL, size_bytes = NULL, media_info = NULL, monitored = 0 WHERE id = ?").run(item.id);
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
    const match = findWatchedMatch(ep.file_path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(ep.media_item_id, afterDays, overridesByItem);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    if (isOffline(ep.file_path)) continue;
    const label = `${ep.media_title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
    try {
      await moveOrDelete(ep.file_path, archiveFolder, permanentDelete, ep.media_type, label, ep.media_item_id);
      await db.prepare("UPDATE episodes SET has_file = 0, file_path = NULL, quality = NULL, size_bytes = NULL, media_info = NULL, monitored = 0 WHERE id = ?").run(ep.id);
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
    const match = findWatchedMatch(sub.file_path, watchedIndex);
    if (!match) continue;
    const retentionDays = resolveRetentionDays(sub.media_item_id, afterDays, overridesByItem);
    if (retentionDays === null) continue;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (match.lastPlayedAt.getTime() > cutoffMs) continue;
    if (isOffline(sub.file_path)) continue;
    const label = `${sub.media_title} - ${sub.title}`;
    try {
      await moveOrDelete(sub.file_path, archiveFolder, permanentDelete, sub.media_type, label, sub.media_item_id);
      await db.prepare("UPDATE sub_items SET has_file = 0, file_path = NULL, quality = NULL, size_bytes = NULL, media_info = NULL, monitored = 0 WHERE id = ?").run(sub.id);
      await logArchival(sub.media_item_id, label, permanentDelete ? "deleted" : "archived");
    } catch (err) {
      log.warn(`[archival] failed to archive "${label}":`, (err as Error).message);
    }
  }

  // Parents whose last child file was just archived shouldn't keep reporting has_file = 1.
  await db
    .prepare(
      `UPDATE media_items SET has_file = 0 WHERE has_file = 1 AND path IS NULL
       AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = media_items.id AND e.has_file = 1)
       AND NOT EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = media_items.id AND s.has_file = 1)`
    )
    .run();
}
