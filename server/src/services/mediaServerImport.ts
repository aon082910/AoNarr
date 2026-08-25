import { db } from "../db/index.js";
import { pathTail } from "./archival.js";
import { fetchMediaServerMovies, fetchMediaServerSeries, type MediaServerLibraryItem, type MediaServerSeriesLibrary } from "./mediaServer.js";
import { log } from "./logger.js";

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function externalIdsOverlap(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (!a) return false;
  return Object.entries(b).some(([provider, id]) => a[provider] === id);
}

export async function defaultQualityProfileId(): Promise<number | null> {
  const row = (await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface MediaServerImportResult {
  matched: number;
  created: number;
  skipped: number;
}

/**
 * Imports an already-organized Plex/Jellyfin/Emby movie library into AoNarr — for a library that
 * predates AoNarr and was never Scan & Import'd (which only guesses from filenames, no title/year/
 * poster/external-id metadata) or manually Add Media'd one at a time. Each media-server item is
 * matched against an existing AoNarr item first (by path, then external id, then title+year),
 * falling back to creating a brand new entry with the media server's own metadata — so items that
 * genuinely aren't in AoNarr yet still get imported, not just files that happen to match something
 * already there. Movies only — TV would additionally need per-episode season/episode numbers and
 * parent-show matching, a larger job left for later.
 */
export async function importMoviesFromMediaServer(rootFolderId: number, signal?: AbortSignal): Promise<MediaServerImportResult> {
  const items = await fetchMediaServerMovies();
  return importMovieItems(items, rootFolderId, signal);
}

/** Core matching/creation logic shared by every movie-library source (Plex/Jellyfin/Emby via
 * fetchMediaServerMovies above, Radarr via starrImport.ts) — takes already-fetched items so each
 * source only needs to know how to fetch and shape its own data into MediaServerLibraryItem. */
export async function importMovieItems(
  items: MediaServerLibraryItem[],
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerImportResult> {
  const result: MediaServerImportResult = { matched: 0, created: 0, skipped: 0 };

  const knownTails = new Set(
    ((await db.prepare("SELECT path FROM media_items WHERE type = 'movie' AND path IS NOT NULL").all()) as { path: string }[]).map((r) =>
      pathTail(r.path)
    )
  );
  // Matched against ALL movies, not just has_file=0 ones — same reasoning as importSeriesData's
  // existingShows below (which already gets this right). Filtering to only-missing here meant an
  // already-imported movie became invisible to this match the moment it had a file, so a second
  // media-server item for the same movie (a re-scan, a slightly different path/tail, a duplicate
  // library entry on the media-server side) always fell to "no match" and created a new row.
  const allMovies = (await db.prepare("SELECT * FROM media_items WHERE type = 'movie'").all()) as any[];
  const qualityProfileId = await defaultQualityProfileId();

  for (const item of items) {
    if (signal?.aborted) break;
    if (!item.title) {
      result.skipped++;
      continue;
    }
    if (item.path && knownTails.has(pathTail(item.path))) {
      result.skipped++;
      continue;
    }

    let externalIds: Record<string, string> = {};
    const match = allMovies.find((m) => {
      try {
        externalIds = m.external_ids ? JSON.parse(m.external_ids) : {};
      } catch {
        externalIds = {};
      }
      return externalIdsOverlap(externalIds, item.externalIds) || (titlesMatch(m.title, item.title) && m.year === item.year);
    });

    if (match) {
      // A match already tracked as downloaded (or a media-server source, always has a path) gets
      // has_file/path updated; a Starr-sourced monitored-but-missing item (item.path null) only
      // fills in metadata, never downgrades an existing match's has_file back to missing.
      if (item.path) {
        await db
          .prepare(
            `UPDATE media_items SET has_file = 1, path = COALESCE(path, ?), poster_url = COALESCE(poster_url, ?),
             overview = COALESCE(overview, ?), external_ids = COALESCE(NULLIF(external_ids, '{}'), ?)
             WHERE id = ?`
          )
          .run(item.path, item.posterUrl, item.overview, JSON.stringify(item.externalIds), match.id);
        match.has_file = 1;
        result.matched++;
      } else {
        await db
          .prepare(
            `UPDATE media_items SET poster_url = COALESCE(poster_url, ?), overview = COALESCE(overview, ?),
             external_ids = COALESCE(NULLIF(external_ids, '{}'), ?)
             WHERE id = ?`
          )
          .run(item.posterUrl, item.overview, JSON.stringify(item.externalIds), match.id);
        result.matched++;
      }
    } else {
      const insertResult = await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, path, root_folder_id, quality_profile_id, monitored, has_file, status)
           VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'unknown')`
        )
        .run(
          item.title,
          item.title.toLowerCase(),
          item.year,
          item.overview,
          item.posterUrl,
          JSON.stringify(item.externalIds),
          item.path,
          rootFolderId,
          qualityProfileId,
          item.path ? 1 : 0
        );
      // Pushed into the same array this import matches against — without this, two media-server
      // items for the same new movie in one batch each create their own row instead of the second
      // one matching the first's.
      allMovies.push({
        id: Number(insertResult.lastInsertRowid),
        title: item.title,
        year: item.year,
        external_ids: JSON.stringify(item.externalIds),
        has_file: item.path ? 1 : 0,
      });
      result.created++;
    }
  }

  log.info(`[mediaServerImport] movies: matched ${result.matched}, created ${result.created}, skipped ${result.skipped}`);
  return result;
}

export interface MediaServerSeriesImportResult {
  showsMatched: number;
  showsCreated: number;
  episodesMatched: number;
  episodesCreated: number;
  episodesSkipped: number;
}

/**
 * Same idea as importMoviesFromMediaServer, one level deeper: for each show the media server has,
 * match or create the parent AoNarr media_item (by external id, then title+year), then for every
 * one of its episodes, match or create the episode row under that parent (by season+episode
 * number) and fill in has_file/file_path/overview/title from the media server's own data. `type`
 * lets this import into either "series" or "anime" — both are the same episodic shape, the caller
 * just needs to say which library the import is for.
 */
export async function importSeriesFromMediaServer(
  type: "series" | "anime",
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerSeriesImportResult> {
  const { shows, episodes } = await fetchMediaServerSeries();
  return importSeriesData(shows, episodes, type, rootFolderId, signal);
}

/** Core matching/creation logic shared by every series-library source (Plex/Jellyfin/Emby via
 * fetchMediaServerSeries above, Sonarr via starrImport.ts) — same reasoning as importMovieItems. */
export async function importSeriesData(
  shows: MediaServerSeriesLibrary["shows"],
  episodes: MediaServerSeriesLibrary["episodes"],
  type: "series" | "anime",
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerSeriesImportResult> {
  const result: MediaServerSeriesImportResult = { showsMatched: 0, showsCreated: 0, episodesMatched: 0, episodesCreated: 0, episodesSkipped: 0 };

  const existingShows = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
  const qualityProfileId = await defaultQualityProfileId();
  const knownEpisodeTails = new Set(
    (
      (await db
        .prepare(
          `SELECT e.file_path FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE m.type = ? AND e.file_path IS NOT NULL`
        )
        .all(type)) as { file_path: string }[]
    ).map((r) => pathTail(r.file_path))
  );

  // Resolves (creating if needed) the AoNarr media_item id for one media-server show — memoized
  // per show id since every one of its episodes needs the same lookup.
  const resolvedShowIds = new Map<string, number>();

  async function resolveShow(showId: string): Promise<number | null> {
    if (resolvedShowIds.has(showId)) return resolvedShowIds.get(showId)!;
    const info = shows.get(showId);
    if (!info || !info.title) return null;

    let externalIds: Record<string, string> = {};
    const match = existingShows.find((m) => {
      try {
        externalIds = m.external_ids ? JSON.parse(m.external_ids) : {};
      } catch {
        externalIds = {};
      }
      return externalIdsOverlap(externalIds, info.externalIds) || (titlesMatch(m.title, info.title) && m.year === info.year);
    });

    if (match) {
      await db
        .prepare(
          `UPDATE media_items SET poster_url = COALESCE(poster_url, ?), overview = COALESCE(overview, ?),
           external_ids = COALESCE(NULLIF(external_ids, '{}'), ?) WHERE id = ?`
        )
        .run(info.posterUrl, info.overview, JSON.stringify(info.externalIds), match.id);
      result.showsMatched++;
      resolvedShowIds.set(showId, match.id);
      return match.id;
    }

    const insertResult = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, has_file, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'unknown')`
      )
      .run(type, info.title, info.title.toLowerCase(), info.year, info.overview, info.posterUrl, JSON.stringify(info.externalIds), rootFolderId, qualityProfileId);
    const newId = Number(insertResult.lastInsertRowid);
    result.showsCreated++;
    resolvedShowIds.set(showId, newId);
    existingShows.push({ id: newId, title: info.title, year: info.year, external_ids: JSON.stringify(info.externalIds) });
    return newId;
  }

  for (const ep of episodes) {
    if (signal?.aborted) break;
    if (ep.path && knownEpisodeTails.has(pathTail(ep.path))) {
      result.episodesSkipped++;
      continue;
    }
    const mediaItemId = await resolveShow(ep.showId);
    if (!mediaItemId) {
      result.episodesSkipped++;
      continue;
    }

    const existingEp = (await db
      .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
      .get(mediaItemId, ep.seasonNumber, ep.episodeNumber)) as { id: number } | undefined;

    if (existingEp) {
      // Same reasoning as importMovieItems' match branch — a Starr-sourced monitored-but-missing
      // episode (ep.path null) only fills in title/overview, never resets an already-downloaded
      // episode's has_file back to missing.
      if (ep.path) {
        await db
          .prepare(
            "UPDATE episodes SET has_file = 1, file_path = ?, title = COALESCE(title, ?), overview = COALESCE(overview, ?) WHERE id = ?"
          )
          .run(ep.path, ep.title, ep.overview, existingEp.id);
        result.episodesMatched++;
      } else {
        await db
          .prepare("UPDATE episodes SET title = COALESCE(title, ?), overview = COALESCE(overview, ?) WHERE id = ?")
          .run(ep.title, ep.overview, existingEp.id);
        result.episodesMatched++;
      }
    } else {
      await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, overview, monitored, has_file, file_path)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.overview, ep.path ? 1 : 0, ep.path);
      result.episodesCreated++;
    }
  }

  // Any show that got at least one real episode counts as "has files" — matches how every other
  // import path (Scan & Import, a normal grab) treats an episodic item's own has_file flag.
  await db
    .prepare(
      `UPDATE media_items SET has_file = 1 WHERE type = ? AND id IN (SELECT DISTINCT media_item_id FROM episodes WHERE has_file = 1)`
    )
    .run(type);

  log.info(
    `[mediaServerImport] ${type}: shows matched ${result.showsMatched}, created ${result.showsCreated}; episodes matched ${result.episodesMatched}, created ${result.episodesCreated}, skipped ${result.episodesSkipped}`
  );
  return result;
}
