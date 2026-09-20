import { db } from "../db/index.js";
import { log } from "./logger.js";
import { typeKeysByShape } from "./mediaTypes.js";

interface XemEntry {
  scene?: { season: number; episode: number };
  scene_2?: { season: number; episode: number }; // xem's alternate scene numbering, when a show has one
  tvdb?: { season: number; episode: number };
}

/**
 * Sonarr's TheXEM (thexem.info) scene-numbering integration — some shows (mostly anime, some
 * long-running series with production-order/broadcast-order mismatches) are released by scene
 * groups using a different season/episode numbering than the metadata provider's own. Without
 * this, a search built from AoNarr's own S01E05 doesn't match a release actually titled S05E01,
 * and a downloaded S05E01 release doesn't get matched back to the right episode either. TheXEM is
 * keyed by TVDB id (the only provider it indexes against), so anime tracked purely via AniList
 * with no tvdb external id has nothing to map — that's a real gap for AniList-only anime, not a
 * bug, since there's no equivalent free scene-mapping source for non-TVDB-indexed shows.
 */
export async function syncSceneNumbering(mediaItemId: number): Promise<{ updated: number } | { error: string }> {
  const mediaRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId)) as any;
  if (!mediaRow) return { error: "Media item not found" };

  let externalIds: Record<string, string> = {};
  try {
    externalIds = mediaRow.external_ids ? JSON.parse(mediaRow.external_ids) : {};
  } catch {
    // malformed external_ids — treated as none below
  }
  const tvdbId = externalIds.tvdb;
  if (!tvdbId) return { error: "This series has no TVDB id — TheXEM only maps scene numbering against TVDB-indexed shows" };

  let body: any;
  try {
    const res = await fetch(`https://thexem.info/map/all?id=${encodeURIComponent(tvdbId)}&origin=tvdb&destination=scene`);
    if (!res.ok) return { error: `TheXEM request failed: HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { error: `TheXEM request failed: ${(err as Error).message}` };
  }

  if (body?.result !== "success" || !Array.isArray(body?.data)) {
    // Not every show has a scene-numbering mapping — thexem simply returns no data for most,
    // which isn't an error, just "nothing to translate here."
    return { updated: 0 };
  }

  let updated = 0;
  for (const entry of body.data as XemEntry[]) {
    const scene = entry.scene ?? entry.scene_2;
    const tvdb = entry.tvdb;
    if (!scene || !tvdb) continue;
    const result = await db
      .prepare(
        `UPDATE episodes SET scene_season_number = ?, scene_episode_number = ?
         WHERE media_item_id = ? AND season_number = ? AND episode_number = ?`
      )
      .run(scene.season, scene.episode, mediaItemId, tvdb.season, tvdb.episode);
    if (result.changes > 0) updated++;
  }

  if (updated > 0) log.info(`[sceneNumbering] "${mediaRow.title}": mapped scene numbering for ${updated} episode(s)`);
  return { updated };
}

/** Runs syncSceneNumbering for every episodic series/anime/sports item with a TVDB id, on the
 * scheduler's own cadence — TheXEM's mappings occasionally change (a show gets added, or a mapping
 * gets corrected), and a series added before this feature existed never gets one otherwise. */
export async function syncAllSceneNumbering(): Promise<void> {
  const episodicTypes = typeKeysByShape("episodic");
  const rows = (await db
    .prepare(`SELECT id FROM media_items WHERE type IN (${episodicTypes.map(() => "?").join(",")})`)
    .all(...episodicTypes)) as { id: number }[];
  let totalUpdated = 0;
  for (const row of rows) {
    const result = await syncSceneNumbering(row.id);
    if ("updated" in result) totalUpdated += result.updated;
  }
  if (totalUpdated > 0) log.info(`[sceneNumbering] scheduled sync: mapped ${totalUpdated} episode(s) across all series`);
}
