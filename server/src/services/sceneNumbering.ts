import { db } from "../db/index.js";
import { log } from "./logger.js";
import { typeKeysByShape } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import type { SceneIndex } from "./releaseParser.js";
import { seasonContextOf } from "./anilistSeasons.js";
import { syncXemNames } from "./xemNames.js";

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
  const index = new Map(rows.map((r) => [`${r.scene_season_number}:${r.scene_episode_number}`, `${r.season_number}:${r.episode_number}`]));
  // A sequel's rows (AniList lists each season as its own entry, anilistSeasons.ts) are numbered season 1 by
  // the provider and season N by the scene. Season 1's own numbering names another entry's episodes, never
  // these: "Show.S01E05" is not the sequel's fifth episode, so the aired numbers count for none of its rows.
  const item = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as { extra_metadata: string | null } | undefined;
  if ((seasonContextOf(item?.extra_metadata)?.ordinal ?? 1) > 1) {
    for (const r of rows) index.set(`${r.season_number}:${r.episode_number}`, "anilist-season:0");
  }
  return index;
}

interface EpisodeRow {
  season_number: number;
  episode_number: number;
  air_date?: string | null;
}

export interface SceneNumber {
  season: number;
  episode: number;
}

/**
 * TheXEM numbers episodes by TVDB's order, and AoNarr's episode rows are TVDB's only when TVDB listed them:
 * with a TMDB id too, the rows come from TMDB (the first provider that is asked), whose seasons are split
 * differently for some shows (American Dad!, long-running anime). A mapping that names an episode the rows do
 * not have is for another numbering, and written onto them it would put a scene number on the wrong episode.
 */
export function xemAlignsWithRows(rows: EpisodeRow[], wanted: ReadonlyMap<string, SceneNumber>): boolean {
  const have = new Set(rows.map((r) => `${r.season_number}:${r.episode_number}`));
  for (const key of wanted.keys()) if (!have.has(key)) return false;
  return true;
}

/**
 * Episodes newer than the last one TheXEM lists carry its last offset forward (Sonarr's
 * XemService.ExtrapolateMappings): a show whose TVDB S01E14-E26 are scene S02E01-E13 and whose E27 TheXEM has
 * not added yet is searched as S02E14, not S01E27. Only a season with a shifted last mapping is extended
 * (an unshifted one needs nothing), and only an episode that aired after the last mapped one: an older
 * episode TheXEM dropped from the map was dropped on purpose. Returns the extra entries.
 */
export function extrapolateSceneNumbers(rows: EpisodeRow[], wanted: ReadonlyMap<string, SceneNumber>): Map<string, SceneNumber> {
  const extra = new Map<string, SceneNumber>();
  const airDateOf = new Map(rows.map((r) => [`${r.season_number}:${r.episode_number}`, r.air_date ?? null]));
  const lastBySeason = new Map<number, { episode: number; scene: SceneNumber; airDate: string | null }>();
  for (const [key, scene] of wanted) {
    const [season, episode] = key.split(":").map(Number);
    const last = lastBySeason.get(season);
    if (!last || episode > last.episode) lastBySeason.set(season, { episode, scene, airDate: airDateOf.get(key) ?? null });
  }
  for (const row of rows) {
    const key = `${row.season_number}:${row.episode_number}`;
    const last = lastBySeason.get(row.season_number);
    if (wanted.has(key) || !last || row.episode_number <= last.episode) continue;
    if (!row.air_date || !last.airDate || row.air_date <= last.airDate) continue;
    const shifted = last.scene.season !== row.season_number || last.scene.episode !== last.episode;
    if (!shifted) continue;
    extra.set(key, { season: last.scene.season, episode: last.scene.episode + (row.episode_number - last.episode) });
  }
  return extra;
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

  // The names scene groups call the show and its seasons, best effort and apart from the numbering below.
  await syncXemNames(mediaItemId, tvdbId).catch(() => 0);

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

  // The mapping TheXEM returns is the whole mapping: scene numbers it no longer lists (a corrected
  // or removed entry) must not stay behind, or an old number keeps matching releases. Written
  // together, and only where a row differs, so a search never sees the show half-mapped and an
  // unchanged mapping (nearly every sync) locks nothing.
  const wanted = new Map<string, { season: number; episode: number }>();
  for (const entry of body.data as XemEntry[]) {
    const scene = entry.scene ?? entry.scene_2;
    if (scene && entry.tvdb) wanted.set(`${entry.tvdb.season}:${entry.tvdb.episode}`, scene);
  }
  const rows = (await db
    .prepare("SELECT id, season_number, episode_number, scene_season_number, scene_episode_number, air_date FROM episodes WHERE media_item_id = ?")
    .all(mediaItemId)) as { id: number; season_number: number; episode_number: number; scene_season_number: number | null; scene_episode_number: number | null; air_date: string | null }[];
  // Rows that may be TMDB's are numbered like TVDB's only if the mapping fits them.
  if (externalIds.tmdb && !xemAlignsWithRows(rows, wanted)) {
    log.info(`[sceneNumbering] "${mediaRow.title}": TheXEM's TVDB numbering does not fit this show's TMDB episode list; scene numbering left as it was`);
    return { updated: 0 };
  }
  for (const [key, scene] of extrapolateSceneNumbers(rows, wanted)) wanted.set(key, scene);
  let updated = 0;
  await db.transaction(async () => {
    for (const row of rows) {
      const scene = wanted.get(`${row.season_number}:${row.episode_number}`);
      if (scene) {
        updated++;
        if (Number(row.scene_season_number) !== scene.season || Number(row.scene_episode_number) !== scene.episode || row.scene_season_number == null) {
          await db.prepare("UPDATE episodes SET scene_season_number = ?, scene_episode_number = ? WHERE id = ?").run(scene.season, scene.episode, row.id);
        }
      } else if (row.scene_season_number != null || row.scene_episode_number != null) {
        await db.prepare("UPDATE episodes SET scene_season_number = NULL, scene_episode_number = NULL WHERE id = ?").run(row.id);
      }
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
