import { db } from "../db/index.js";
import { log } from "./logger.js";
import { applyEpisodeMonitorMode, applySubItemMonitorMode, COLLECTION_MONITOR_MODES, isMonitorMode, isNewItemMode, SERIES_MONITOR_MODES } from "./monitorModes.js";
import { addTagsToItem, parseTagIds } from "./tagScope.js";

/**
 * Lidarr and Readarr root folders carry defaults for what is added into them: a quality profile, a
 * metadata profile, the monitor choices and tags. AoNarr applies them to an item whose own fields
 * are empty, so a list, a request or a hand add into the folder starts from the folder's choices.
 */
export interface RootFolderDefaults {
  qualityProfileId: number | null;
  metadataProfileId: number | null;
  monitor: string | null;
  monitorNewItems: string | null;
  tagIds: number[];
}

const NONE: RootFolderDefaults = { qualityProfileId: null, metadataProfileId: null, monitor: null, monitorNewItems: null, tagIds: [] };

export async function rootFolderDefaultsOf(rootFolderId: number | null | undefined): Promise<RootFolderDefaults> {
  if (rootFolderId == null) return NONE;
  const row = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(Number(rootFolderId))) as any;
  if (!row) return NONE;
  return {
    qualityProfileId: row.default_quality_profile_id == null ? null : Number(row.default_quality_profile_id),
    metadataProfileId: row.default_metadata_profile_id == null ? null : Number(row.default_metadata_profile_id),
    monitor: isMonitorMode(row.default_monitor) ? row.default_monitor : null,
    monitorNewItems: isNewItemMode(row.default_monitor_new_items) ? row.default_monitor_new_items : null,
    tagIds: parseTagIds(row.default_tag_ids),
  };
}

/**
 * The quality profile a new wanted item starts with: the one the adder chose (a list's own profile, an
 * admin's pick on a request), else the default profile of the root folder it is added into, else the
 * first profile. A default that points at a profile deleted since is skipped. Without any profile the
 * auto-search would apply no allowed-quality gate or cutoff at all, so the first profile is the floor.
 */
export async function resolveAddQualityProfileId(chosen: number | null | undefined, rootFolderId: number | null | undefined): Promise<number | null> {
  if (chosen != null) return Number(chosen);
  const folderDefault = (await rootFolderDefaultsOf(rootFolderId)).qualityProfileId;
  if (folderDefault != null && (await db.prepare("SELECT id FROM quality_profiles WHERE id = ?").get(folderDefault))) return folderDefault;
  const first = (await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined;
  return first?.id ?? null;
}

/**
 * The Monitor choice for what a title's episodes or albums start as: the one the adder chose, else the
 * root folder's default, else "all". Only choices that fit the type count (a series mode on an artist
 * would mean nothing), so a folder default of the wrong family reads as "all".
 */
export async function resolveAddMonitorMode(chosen: string | null | undefined, rootFolderId: number | null | undefined, type: string): Promise<string> {
  if (chosen) return chosen;
  const mode = (await rootFolderDefaultsOf(rootFolderId)).monitor;
  if (!mode) return "all";
  const fits = type === "series" ? (SERIES_MONITOR_MODES as readonly string[]).includes(mode) : (COLLECTION_MONITOR_MODES as readonly string[]).includes(mode);
  return fits ? mode : "all";
}

/**
 * Applies the root folder's default Monitor choice to a series or artist whose episodes or albums are
 * now in (call it after they are inserted). For the adds that name no Monitor choice of their own: a
 * Trakt or Plex watchlist, an automatic request. "none" leaves the title unmonitored, as a list does.
 * Best effort, like the other defaults.
 */
export async function applyRootFolderMonitor(itemId: number | bigint | null | undefined): Promise<void> {
  if (itemId == null) return;
  try {
    const row = (await db.prepare("SELECT type, root_folder_id FROM media_items WHERE id = ?").get(Number(itemId))) as
      | { type: string; root_folder_id: number | null }
      | undefined;
    if (!row || row.root_folder_id == null || (row.type !== "series" && row.type !== "artist")) return;
    const mode = await resolveAddMonitorMode(null, row.root_folder_id, row.type);
    if (mode === "all") return;
    if (row.type === "series") await applyEpisodeMonitorMode(itemId, mode);
    else await applySubItemMonitorMode(itemId, mode);
    if (mode === "none") await db.prepare("UPDATE media_items SET monitored = 0 WHERE id = ?").run(Number(itemId));
  } catch (err) {
    log.warn(`[rootFolderDefaults] could not apply the root folder monitor choice to item ${itemId}:`, (err as Error).message);
  }
}

/** Fills what the item left empty from its root folder's defaults. Best effort: the item is already in the library. */
export async function applyRootFolderDefaults(itemId: number | bigint | null | undefined): Promise<void> {
  if (itemId == null) return;
  try {
    const item = (await db.prepare("SELECT id, root_folder_id, quality_profile_id, monitor_new_items FROM media_items WHERE id = ?").get(Number(itemId))) as
      | { id: number; root_folder_id: number | null; quality_profile_id: number | null; monitor_new_items: string | null }
      | undefined;
    if (!item || item.root_folder_id == null) return;
    const defaults = await rootFolderDefaultsOf(item.root_folder_id);
    if (item.quality_profile_id == null && defaults.qualityProfileId != null) {
      await db.prepare("UPDATE media_items SET quality_profile_id = ? WHERE id = ?").run(defaults.qualityProfileId, item.id);
    }
    if (!item.monitor_new_items && defaults.monitorNewItems) {
      await db.prepare("UPDATE media_items SET monitor_new_items = ? WHERE id = ?").run(defaults.monitorNewItems, item.id);
    }
    if (defaults.tagIds.length > 0) await addTagsToItem(item.id, defaults.tagIds);
  } catch (err) {
    log.warn(`[rootFolderDefaults] could not apply the root folder defaults to item ${itemId}:`, (err as Error).message);
  }
}
