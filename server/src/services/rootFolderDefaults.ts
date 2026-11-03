import { db } from "../db/index.js";
import { log } from "./logger.js";
import { isMonitorMode, isNewItemMode } from "./monitorModes.js";
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
