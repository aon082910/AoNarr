import { db } from "../db/index.js";
import { pathTail } from "./archival.js";
import type { MediaServerEpisodeItem, MediaServerLibraryItem, MediaServerShowInfo } from "./mediaServer.js";
import {
  defaultQualityProfileId,
  externalIdsOverlap,
  importMovieItems,
  importSeriesData,
  titlesMatch,
  type MediaServerImportResult,
  type MediaServerSeriesImportResult,
} from "./mediaServerImport.js";
import { log } from "./logger.js";

/**
 * Migrates an already-organized Radarr/Sonarr library into AoNarr, reusing the exact same
 * match-or-create logic already proven out for Plex/Jellyfin/Emby imports (mediaServerImport.ts) —
 * only the fetch/shape step differs, since Radarr/Sonarr's own REST API already returns real
 * title/year/overview/poster/external-id metadata just like a media server does. Unlike the media
 * server connection (a standing setting used repeatedly for notifications/watch-sync), this is a
 * one-time migration action: the URL and API key are supplied per-request rather than stored, since
 * there's no ongoing reason for AoNarr to keep talking to a Radarr/Sonarr instance once its library
 * has been pulled in.
 */

interface StarrImage {
  coverType: string;
  remoteUrl?: string;
  url?: string;
}

function starrPosterUrl(images: StarrImage[] | undefined): string | null {
  const poster = images?.find((i) => i.coverType === "poster");
  return poster?.remoteUrl || poster?.url || null;
}

function starrExternalIds(item: { tmdbId?: number; imdbId?: string; tvdbId?: number }): Record<string, string> {
  const ids: Record<string, string> = {};
  if (item.tmdbId) ids.tmdb = String(item.tmdbId);
  if (item.imdbId) ids.imdb = item.imdbId;
  if (item.tvdbId) ids.tvdb = String(item.tvdbId);
  return ids;
}

async function starrGet(baseUrl: string, apiKey: string, path: string, version: "v1" | "v3" = "v3"): Promise<any> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/${version}/${path}`, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface RadarrMovie {
  title: string;
  year?: number;
  overview?: string;
  images?: StarrImage[];
  tmdbId?: number;
  imdbId?: string;
  path?: string;
  hasFile?: boolean;
  movieFile?: { relativePath?: string; path?: string };
}

export async function fetchRadarrMovies(baseUrl: string, apiKey: string): Promise<MediaServerLibraryItem[]> {
  const movies = (await starrGet(baseUrl, apiKey, "movie")) as RadarrMovie[];
  const results: MediaServerLibraryItem[] = [];
  for (const m of movies) {
    if (!m.title) continue;
    // Downloaded movies carry a real file path; a monitored-but-not-yet-downloaded movie has none —
    // imported anyway (with path null) so AoNarr picks it up as monitored+missing and searches for
    // it, rather than silently dropping everything Radarr hasn't grabbed yet.
    const filePath = m.hasFile ? m.movieFile?.path || (m.path && m.movieFile?.relativePath ? `${m.path}/${m.movieFile.relativePath}` : null) : null;
    results.push({
      mediaServerId: filePath || `radarr:${m.tmdbId ?? m.title}`,
      path: filePath,
      title: m.title,
      year: m.year ?? null,
      overview: m.overview || null,
      posterUrl: starrPosterUrl(m.images),
      externalIds: starrExternalIds(m),
    });
  }
  return results;
}

export async function importMoviesFromRadarr(
  baseUrl: string,
  apiKey: string,
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerImportResult> {
  const items = await fetchRadarrMovies(baseUrl, apiKey);
  return importMovieItems(items, rootFolderId, signal);
}

interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  overview?: string;
  images?: StarrImage[];
  tvdbId?: number;
  imdbId?: string;
}

interface SonarrEpisode {
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  hasFile?: boolean;
  episodeFileId?: number;
}

interface SonarrEpisodeFile {
  id: number;
  path: string;
}

/** Sonarr's v3 API has no bulk "every episode across every series" endpoint — episodes and
 * episode-files are both fetched per series, so this is N+1 requests where N is the series count.
 * Acceptable for a one-time migration job; not something a repeated sync would want. */
export async function fetchSonarrSeries(
  baseUrl: string,
  apiKey: string
): Promise<{ shows: Map<string, MediaServerShowInfo>; episodes: MediaServerEpisodeItem[] }> {
  const seriesList = (await starrGet(baseUrl, apiKey, "series")) as SonarrSeries[];
  const shows = new Map<string, MediaServerShowInfo>();
  const episodes: MediaServerEpisodeItem[] = [];

  for (const s of seriesList) {
    if (!s.title) continue;
    const showId = String(s.id);
    shows.set(showId, {
      title: s.title,
      year: s.year ?? null,
      overview: s.overview || null,
      posterUrl: starrPosterUrl(s.images),
      externalIds: starrExternalIds(s),
    });

    const [eps, files] = await Promise.all([
      starrGet(baseUrl, apiKey, `episode?seriesId=${s.id}`) as Promise<SonarrEpisode[]>,
      starrGet(baseUrl, apiKey, `episodefile?seriesId=${s.id}`) as Promise<SonarrEpisodeFile[]>,
    ]);
    const filesById = new Map(files.map((f) => [f.id, f.path]));

    for (const ep of eps) {
      // Same reasoning as Radarr above — a monitored-but-not-yet-downloaded episode has no file
      // yet, imported anyway with path null so it shows up in AoNarr as monitored+missing.
      const path = ep.hasFile && ep.episodeFileId ? filesById.get(ep.episodeFileId) ?? null : null;
      episodes.push({
        showId,
        path,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title || null,
        overview: ep.overview || null,
      });
    }
  }

  return { shows, episodes };
}

export async function importSeriesFromSonarr(
  baseUrl: string,
  apiKey: string,
  type: "series" | "anime",
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerSeriesImportResult> {
  const { shows, episodes } = await fetchSonarrSeries(baseUrl, apiKey);
  return importSeriesData(shows, episodes, type, rootFolderId, signal);
}

// ---- Lidarr (artist/album) and Readarr (author/book) — both "collection" shape: a parent
// (artist/author) with an open-ended list of named children (album/book), one file per child
// (multiFilePerChild's per-track granularity isn't attempted here — same reasoning as Scan &
// Import's own collection-shape handling: an album's file_path is the album FOLDER, has_file just
// means "at least one track file exists in it", not a fully populated tracks table). ----

interface StarrParentInfo {
  title: string;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

interface StarrChildItem {
  parentId: string;
  title: string;
  releaseDate: string | null;
  // Null for a monitored-but-not-yet-downloaded album/book — see MediaServerLibraryItem.path.
  path: string | null;
  externalId: string | null;
}

export interface StarrCollectionImportResult {
  parentsMatched: number;
  parentsCreated: number;
  childrenMatched: number;
  childrenCreated: number;
  childrenSkipped: number;
}

interface LidarrArtist {
  id: number;
  artistName: string;
  overview?: string;
  images?: StarrImage[];
  foreignArtistId?: string;
  path?: string;
}

interface LidarrAlbum {
  id: number;
  artistId: number;
  title: string;
  releaseDate?: string;
  foreignAlbumId?: string;
}

interface LidarrTrackFile {
  id: number;
  albumId: number;
  path: string;
}

async function fetchLidarrLibrary(
  baseUrl: string,
  apiKey: string
): Promise<{ parents: Map<string, StarrParentInfo>; children: StarrChildItem[] }> {
  const artists = (await starrGet(baseUrl, apiKey, "artist", "v1")) as LidarrArtist[];
  const parents = new Map<string, StarrParentInfo>();
  const children: StarrChildItem[] = [];

  for (const artist of artists) {
    if (!artist.artistName) continue;
    const parentId = String(artist.id);
    parents.set(parentId, {
      title: artist.artistName,
      overview: artist.overview || null,
      posterUrl: starrPosterUrl(artist.images),
      externalIds: artist.foreignArtistId ? { musicbrainz: artist.foreignArtistId } : {},
    });

    const [albums, files] = await Promise.all([
      starrGet(baseUrl, apiKey, `album?artistId=${artist.id}`, "v1") as Promise<LidarrAlbum[]>,
      starrGet(baseUrl, apiKey, `trackfile?artistId=${artist.id}`, "v1") as Promise<LidarrTrackFile[]>,
    ]);
    const firstFilePathByAlbum = new Map<number, string>();
    for (const f of files) {
      if (!firstFilePathByAlbum.has(f.albumId)) firstFilePathByAlbum.set(f.albumId, f.path);
    }

    for (const album of albums) {
      if (!album.title) continue;
      const trackFile = firstFilePathByAlbum.get(album.id);
      // The album folder is the track file's own directory — Lidarr doesn't return it directly, so
      // a monitored-but-not-yet-downloaded album (no track file yet) has no path to derive one
      // from; imported anyway with path null so it still shows up as monitored+missing.
      const folderPath = trackFile ? trackFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || null : null;
      children.push({
        parentId,
        title: album.title,
        releaseDate: album.releaseDate ?? null,
        path: folderPath,
        externalId: album.foreignAlbumId ?? null,
      });
    }
  }

  return { parents, children };
}

interface ReadarrAuthor {
  id: number;
  authorName: string;
  overview?: string;
  images?: StarrImage[];
  foreignAuthorId?: string;
}

interface ReadarrBook {
  id: number;
  authorId: number;
  title: string;
  releaseDate?: string;
  foreignBookId?: string;
}

interface ReadarrBookFile {
  id: number;
  bookId: number;
  path: string;
}

async function fetchReadarrLibrary(
  baseUrl: string,
  apiKey: string
): Promise<{ parents: Map<string, StarrParentInfo>; children: StarrChildItem[] }> {
  const authors = (await starrGet(baseUrl, apiKey, "author", "v1")) as ReadarrAuthor[];
  const parents = new Map<string, StarrParentInfo>();
  const children: StarrChildItem[] = [];

  for (const author of authors) {
    if (!author.authorName) continue;
    const parentId = String(author.id);
    parents.set(parentId, {
      title: author.authorName,
      overview: author.overview || null,
      posterUrl: starrPosterUrl(author.images),
      externalIds: author.foreignAuthorId ? { goodreads: author.foreignAuthorId } : {},
    });

    const [books, files] = await Promise.all([
      starrGet(baseUrl, apiKey, `book?authorId=${author.id}`, "v1") as Promise<ReadarrBook[]>,
      starrGet(baseUrl, apiKey, `bookfile?authorId=${author.id}`, "v1") as Promise<ReadarrBookFile[]>,
    ]);
    const filePathByBook = new Map(files.map((f) => [f.bookId, f.path]));

    for (const book of books) {
      if (!book.title) continue;
      children.push({
        parentId,
        title: book.title,
        releaseDate: book.releaseDate ?? null,
        path: filePathByBook.get(book.id) ?? null,
        externalId: book.foreignBookId ?? null,
      });
    }
  }

  return { parents, children };
}

/** Core matching/creation logic shared by Lidarr and Readarr import — matches a parent (artist/
 * author) by external id then title, matches a child (album/book) by path tail then external id
 * then title, same precedence used everywhere else in this file. */
async function importCollectionData(
  parents: Map<string, StarrParentInfo>,
  children: StarrChildItem[],
  type: "artist" | "author",
  externalProvider: string,
  rootFolderId: number,
  signal?: AbortSignal
): Promise<StarrCollectionImportResult> {
  const result: StarrCollectionImportResult = { parentsMatched: 0, parentsCreated: 0, childrenMatched: 0, childrenCreated: 0, childrenSkipped: 0 };

  const existingParents = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
  const qualityProfileId = await defaultQualityProfileId();
  const knownChildTails = new Set(
    (
      (await db
        .prepare(`SELECT s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE m.type = ? AND s.file_path IS NOT NULL`)
        .all(type)) as { file_path: string }[]
    ).map((r) => pathTail(r.file_path))
  );

  const resolvedParentIds = new Map<string, number>();

  async function resolveParent(parentId: string): Promise<number | null> {
    if (resolvedParentIds.has(parentId)) return resolvedParentIds.get(parentId)!;
    const info = parents.get(parentId);
    if (!info || !info.title) return null;

    let externalIds: Record<string, string> = {};
    const match = existingParents.find((m) => {
      try {
        externalIds = m.external_ids ? JSON.parse(m.external_ids) : {};
      } catch {
        externalIds = {};
      }
      return externalIdsOverlap(externalIds, info.externalIds) || titlesMatch(m.title, info.title);
    });

    if (match) {
      await db
        .prepare(
          `UPDATE media_items SET poster_url = COALESCE(poster_url, ?), overview = COALESCE(overview, ?),
         external_ids = COALESCE(NULLIF(external_ids, '{}'), ?) WHERE id = ?`
        )
        .run(info.posterUrl, info.overview, JSON.stringify(info.externalIds), match.id);
      result.parentsMatched++;
      resolvedParentIds.set(parentId, match.id);
      return match.id;
    }

    const insertResult = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, has_file, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'unknown')`
      )
      .run(type, info.title, info.title.toLowerCase(), info.overview, info.posterUrl, JSON.stringify(info.externalIds), rootFolderId, qualityProfileId);
    const newId = Number(insertResult.lastInsertRowid);
    result.parentsCreated++;
    resolvedParentIds.set(parentId, newId);
    existingParents.push({ id: newId, title: info.title, external_ids: JSON.stringify(info.externalIds) });
    return newId;
  }

  for (const child of children) {
    if (signal?.aborted) break;
    if (child.path && knownChildTails.has(pathTail(child.path))) {
      result.childrenSkipped++;
      continue;
    }
    const mediaItemId = await resolveParent(child.parentId);
    if (!mediaItemId) {
      result.childrenSkipped++;
      continue;
    }

    const existingChild = (await db
      .prepare("SELECT id FROM sub_items WHERE media_item_id = ? AND title = ?")
      .get(mediaItemId, child.title)) as { id: number } | undefined;

    if (existingChild) {
      // A child already tracked (from a prior import or Scan & Import) that's still missing on the
      // Starr side (child.path null) is left alone — has_file/file_path only ever move forward from
      // an actual download, never get reset back to missing by a re-import.
      if (child.path) {
        await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run(child.path, existingChild.id);
        result.childrenMatched++;
      }
    } else {
      await db
        .prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored, has_file, file_path)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(mediaItemId, child.title, child.releaseDate, child.externalId, child.externalId ? externalProvider : null, child.path ? 1 : 0, child.path);
      result.childrenCreated++;
    }
  }

  await db
    .prepare(
      `UPDATE media_items SET has_file = 1 WHERE type = ? AND id IN (SELECT DISTINCT media_item_id FROM sub_items WHERE has_file = 1)`
    )
    .run(type);

  log.info(
    `[starrImport] ${type}: parents matched ${result.parentsMatched}, created ${result.parentsCreated}; children matched ${result.childrenMatched}, created ${result.childrenCreated}, skipped ${result.childrenSkipped}`
  );
  return result;
}

export async function importArtistsFromLidarr(
  baseUrl: string,
  apiKey: string,
  rootFolderId: number,
  signal?: AbortSignal
): Promise<StarrCollectionImportResult> {
  const { parents, children } = await fetchLidarrLibrary(baseUrl, apiKey);
  return importCollectionData(parents, children, "artist", "musicbrainz", rootFolderId, signal);
}

export async function importAuthorsFromReadarr(
  baseUrl: string,
  apiKey: string,
  rootFolderId: number,
  signal?: AbortSignal
): Promise<StarrCollectionImportResult> {
  const { parents, children } = await fetchReadarrLibrary(baseUrl, apiKey);
  return importCollectionData(parents, children, "author", "goodreads", rootFolderId, signal);
}
