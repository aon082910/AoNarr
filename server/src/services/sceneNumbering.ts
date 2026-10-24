import { db } from "../db/index.js";
import { log } from "./logger.js";
import { typeKeysByShape } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import type { SceneIndex } from "./releaseParser.js";

interface XemEntry {
  scene?: { season: number; episode: number };
  scene_2?: { season: number; episode: number }; // xem's alternate scene numbering, when a show has one
  tvdb?: { season: number; episode: number };
}

/**
 * The series' scene numbers that differ from the aired ones, by number, for releaseMatchesEpisode's
 * precedence rule (scene numbering first, aired numbering only while it is no other episode's scene
 * number). Undefined when there is nothing to arbitrate or the `sceneNumberingMode` setting is `or`,
 * which restores the older rule that a release fitting either numbering matches.
 */
export async function sceneIndexFor(mediaItemId: number): Promise<SceneIndex | undefined> {
  if ((getSetting("sceneNumberingMode") ?? "").trim().toLowerCase() === "or") return undefined;
  const rows = (await db
    .prepare(
      `SELECT season_number, episode_number, scene_season_number, scene_episode_number FROM episodes
       WHERE media_item_id = ? AND scene_season_number IS NOT NULL AND scene_episode_number IS NOT NULL
         AND (scene_season_number <> season_number OR scene_episode_number <> episode_number)`
    )
    .all(mediaItemId)) as { season_number: number; episode_number: number; scene_season_number: number; scene_episode_number: number }[];
  if (rows.length === 0) return undefined;
  return new Map(rows.map((r) => [`${r.scene_season_number}:${r.scene_episode_number}`, `${r.season_number}:${r.episode_number}`]));
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
  // The mapping TheXEM returns is the whole mapping: scene numbers it no longer lists (a corrected
  // or removed entry) must not stay behind, or an old number keeps matching releases. Cleared and
  // rewritten together so a search never sees the show half-mapped.
  await db.transaction(async () => {
    await db.prepare("UPDATE episodes SET scene_season_number = NULL, scene_episode_number = NULL WHERE media_item_id = ?").run(mediaItemId);
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
  });

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
