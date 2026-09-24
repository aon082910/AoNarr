import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "../db/index.js";
import { pathTail } from "./archival.js";
import {
  fetchMediaServerMovies,
  fetchMediaServerSeries,
  getMediaServerConfig,
  isMediaServerArtworkPath,
  isMediaServerArtworkRef,
  MEDIA_SERVER_ARTWORK_PREFIX,
  type MediaServerLibraryItem,
  type MediaServerSeriesLibrary,
} from "./mediaServer.js";
import { log } from "./logger.js";

/** A poster value safe to put straight into poster_url: a media server's own artwork reference is
 * never one (it needs that server's credential, see mediaServer.ts's MEDIA_SERVER_ARTWORK_PREFIX) —
 * storeMediaServerPoster routes it through the token-gated local-artwork proxy instead. */
function publicPoster(url: string | null): string | null {
  return isMediaServerArtworkRef(url) ? null : url;
}

async function storeMediaServerPoster(mediaItemId: number, ref: string | null): Promise<void> {
  if (!isMediaServerArtworkRef(ref)) return;
  const token = crypto.randomBytes(20).toString("hex");
  await db
    .prepare("UPDATE media_items SET poster_url = ?, local_poster_path = ?, local_poster_token = ? WHERE id = ? AND poster_url IS NULL")
    .run(`/api/media/local-artwork/${token}`, ref, token, mediaItemId);
}

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

/** Exact-only comparison — no substring tolerance. Safe for matching that has no year (or other
 * independent signal) to gate the fuzzier titlesMatch() against, e.g. artist/author names, where
 * substring tolerance would merge unrelated entries whose names happen to be a subset of one
 * another (the same class of bug libraryScan.ts's own titlesMatch was made exact-only to fix). */
export function exactTitlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  return !!na && na === nb;
}

/** Title+year fallback match for items with no shared external id. The substring-tolerant
 * `titlesMatch` is only safe when a real year also agrees — two unknown years match each other
 * trivially and would fold "Extraction 2" into "Extraction". */
export function titleAndYearMatch(existingTitle: string, existingYear: number | null, title: string, year: number | null): boolean {
  if (existingYear == null || year == null) {
    return normalizeForMatch(existingTitle) === normalizeForMatch(title) && existingYear == year;
  }
  return existingYear === year && titlesMatch(existingTitle, title);
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
export async function importMoviesFromMediaServer(
  rootFolderId: number,
  signal?: AbortSignal,
  type: string = "movie"
): Promise<MediaServerImportResult> {
  const items = await fetchMediaServerMovies();
  return importMovieItems(items, rootFolderId, signal, type);
}

/** Core matching/creation logic shared by every movie-shaped library source (Plex/Jellyfin/Emby
 * via fetchMediaServerMovies above, Radarr via starrImport.ts) — takes already-fetched items so
 * each source only needs to know how to fetch and shape its own data into MediaServerLibraryItem.
 * `type` lets this import into any "single"-shape library (Movies by default, or Sports PPV —
 * both are one-file-per-item and otherwise identical, same reasoning as importSeriesData's own
 * `type` param for the two episodic libraries). */
export async function importMovieItems(
  items: MediaServerLibraryItem[],
  rootFolderId: number,
  signal?: AbortSignal,
  type: string = "movie"
): Promise<MediaServerImportResult> {
  const result: MediaServerImportResult = { matched: 0, created: 0, skipped: 0 };

  const knownTails = new Set(
    ((await db.prepare("SELECT path FROM media_items WHERE type = ? AND path IS NOT NULL").all(type)) as { path: string }[]).map((r) =>
      pathTail(r.path)
    )
  );
  // Matched against ALL movies, not just has_file=0 ones — same reasoning as importSeriesData's
  // existingShows below (which already gets this right). Filtering to only-missing here meant an
  // already-imported movie became invisible to this match the moment it had a file, so a second
  // media-server item for the same movie (a re-scan, a slightly different path/tail, a duplicate
  // library entry on the media-server side) always fell to "no match" and created a new row.
  const allMovies = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
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
      return externalIdsOverlap(externalIds, item.externalIds) || titleAndYearMatch(m.title, m.year ?? null, item.title, item.year ?? null);
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
          .run(item.path, publicPoster(item.posterUrl), item.overview, JSON.stringify(item.externalIds), match.id);
        await storeMediaServerPoster(match.id, item.posterUrl);
        match.has_file = 1;
        result.matched++;
      } else {
        await db
          .prepare(
            `UPDATE media_items SET poster_url = COALESCE(poster_url, ?), overview = COALESCE(overview, ?),
             external_ids = COALESCE(NULLIF(external_ids, '{}'), ?)
             WHERE id = ?`
          )
          .run(publicPoster(item.posterUrl), item.overview, JSON.stringify(item.externalIds), match.id);
        await storeMediaServerPoster(match.id, item.posterUrl);
        result.matched++;
      }
    } else {
      const insertResult = await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, path, root_folder_id, quality_profile_id, monitored, has_file, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'unknown')`
        )
        .run(
          type,
          item.title,
          item.title.toLowerCase(),
          item.year,
          item.overview,
          publicPoster(item.posterUrl),
          JSON.stringify(item.externalIds),
          item.path,
          rootFolderId,
          qualityProfileId,
          item.path ? 1 : 0
        );
      await storeMediaServerPoster(Number(insertResult.lastInsertRowid), item.posterUrl);
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

  log.info(`[mediaServerImport] ${type}: matched ${result.matched}, created ${result.created}, skipped ${result.skipped}`);
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
  type: "series" | "anime" | "sports",
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerSeriesImportResult> {
  const { shows, episodes } = await fetchMediaServerSeries();
  return importSeriesData(shows, episodes, type, rootFolderId, signal);
}

/** Core matching/creation logic shared by every series-library source (Plex/Jellyfin/Emby via
 * fetchMediaServerSeries above, Sonarr/Whisparr via starrImport.ts) — same reasoning as
 * importMovieItems. "adult" is Whisparr-only (no media-server source imports adult content) —
 * Whisparr's own flat Studio+Movie/Scene model has no real season/episode numbering, so
 * starrImport.ts's fetchWhisparrLibrary synthesizes season 1 + sequential numbers per studio the
 * same way a locally-scanned adult folder's sequentialEpisodeFallback already does. */
export async function importSeriesData(
  shows: MediaServerSeriesLibrary["shows"],
  episodes: MediaServerSeriesLibrary["episodes"],
  type: "series" | "anime" | "sports" | "adult",
  rootFolderId: number,
  signal?: AbortSignal,
  options: { synthesizedEpisodeNumbers?: boolean } = {}
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
  const episodesFiledThisRun = new Set<number>();

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
      return externalIdsOverlap(externalIds, info.externalIds) || titleAndYearMatch(m.title, m.year ?? null, info.title, info.year ?? null);
    });

    if (match) {
      await db
        .prepare(
          `UPDATE media_items SET poster_url = COALESCE(poster_url, ?), overview = COALESCE(overview, ?),
           external_ids = COALESCE(NULLIF(external_ids, '{}'), ?) WHERE id = ?`
        )
        .run(publicPoster(info.posterUrl), info.overview, JSON.stringify(info.externalIds), match.id);
      await storeMediaServerPoster(match.id, info.posterUrl);
      result.showsMatched++;
      resolvedShowIds.set(showId, match.id);
      return match.id;
    }

    const insertResult = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, has_file, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'unknown')`
      )
      .run(type, info.title, info.title.toLowerCase(), info.year, info.overview, publicPoster(info.posterUrl), JSON.stringify(info.externalIds), rootFolderId, qualityProfileId);
    const newId = Number(insertResult.lastInsertRowid);
    await storeMediaServerPoster(newId, info.posterUrl);
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

    // A synthesized number (Whisparr's per-run counter) says nothing about which row is which —
    // matching on it would repoint an unrelated episode at another scene's file. Such an episode
    // matches a same-titled row instead: a fileless one first, else one whose file is gone (Whisparr
    // upgraded/renamed it) — never a row still holding another existing file, or one given its file
    // earlier in this same run — and anything new is appended after the show's last episode.
    let existingEp: { id: number } | undefined;
    if (options.synthesizedEpisodeNumbers) {
      const sameTitle = (await db
        .prepare("SELECT id, has_file, file_path FROM episodes WHERE media_item_id = ? AND season_number = ? AND title = ? ORDER BY id")
        .all(mediaItemId, ep.seasonNumber, ep.title)) as { id: number; has_file: number | string | null; file_path: string | null }[];
      existingEp = !ep.path
        ? sameTitle[0]
        : (sameTitle.find((r) => r.file_path === null) ??
          sameTitle.find(
            (r) => !episodesFiledThisRun.has(r.id) && (Number(r.has_file) === 0 || !fs.existsSync(r.file_path as string))
          ));
    } else {
      existingEp = (await db
        .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
        .get(mediaItemId, ep.seasonNumber, ep.episodeNumber)) as { id: number } | undefined;
    }

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
        episodesFiledThisRun.add(existingEp.id);
        result.episodesMatched++;
      } else {
        await db
          .prepare("UPDATE episodes SET title = COALESCE(title, ?), overview = COALESCE(overview, ?) WHERE id = ?")
          .run(ep.title, ep.overview, existingEp.id);
        result.episodesMatched++;
      }
    } else {
      let episodeNumber = ep.episodeNumber;
      if (options.synthesizedEpisodeNumbers) {
        const last = (await db
          .prepare("SELECT MAX(episode_number) AS n FROM episodes WHERE media_item_id = ? AND season_number = ?")
          .get(mediaItemId, ep.seasonNumber)) as { n: number | string | null } | undefined;
        episodeNumber = Number(last?.n ?? 0) + 1;
      }
      const inserted = await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, overview, monitored, has_file, file_path)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(mediaItemId, ep.seasonNumber, episodeNumber, ep.title, ep.overview, ep.path ? 1 : 0, ep.path);
      if (ep.path) episodesFiledThisRun.add(Number(inserted.lastInsertRowid));
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

/** One-time cleanup for rows imported before media-server artwork went through the token-gated
 * proxy: poster_url still holds the raw media-server URL with its credential embedded (Plex's
 * X-Plex-Token, Jellyfin/Emby's api_key), readable by every household user and public share link.
 * Each is converted in place to the same proxied form a fresh import now produces. Cheap and
 * idempotent — a converted row no longer matches the LIKE filters.
 *
 * Only an artwork path on the configured server itself is converted, relative to that server's
 * URL (a Jellyfin Base URL or reverse-proxy sub-path is already part of cfg.url, which
 * fetchMediaServerArtwork prefixes again). poster_url can also come from a household user's
 * request, and the proxy fetches with the owner's credential, so anything else is left alone. */
export async function migrateCredentialedMediaServerPosters(): Promise<number> {
  const cfg = getMediaServerConfig();
  if (!cfg) return 0;
  let server: URL;
  try {
    server = new URL(cfg.url);
  } catch {
    return 0;
  }
  const basePath = server.pathname.replace(/\/+$/, "");
  const credentialParam = cfg.type === "plex" ? "X-Plex-Token" : "api_key";

  const rows = (await db
    .prepare("SELECT id, poster_url FROM media_items WHERE poster_url LIKE '%X-Plex-Token=%' OR poster_url LIKE '%api_key=%'")
    .all()) as { id: number; poster_url: string }[];
  let converted = 0;
  for (const row of rows) {
    let url: URL;
    try {
      url = new URL(row.poster_url);
    } catch {
      continue;
    }
    if (url.origin !== server.origin || !url.searchParams.has(credentialParam)) continue;
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) continue;
    const relativePath = url.pathname.slice(basePath.length);
    if (!isMediaServerArtworkPath(cfg.type, relativePath)) continue;
    const token = crypto.randomBytes(20).toString("hex");
    await db
      .prepare("UPDATE media_items SET poster_url = ?, local_poster_path = ?, local_poster_token = ? WHERE id = ?")
      .run(`/api/media/local-artwork/${token}`, `${MEDIA_SERVER_ARTWORK_PREFIX}${relativePath}`, token, row.id);
    converted++;
  }
  if (converted > 0) log.info(`[mediaServerImport] moved ${converted} media-server poster URL(s) behind the artwork proxy (their credential is no longer exposed)`);
  return converted;
}
