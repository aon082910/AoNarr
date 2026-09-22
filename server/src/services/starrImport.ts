import { db } from "../db/index.js";
import { pathTail } from "./archival.js";
import type { MediaServerEpisodeItem, MediaServerLibraryItem, MediaServerShowInfo } from "./mediaServer.js";
import {
  defaultQualityProfileId,
  externalIdsOverlap,
  importMovieItems,
  importSeriesData,
  exactTitlesMatch,
  type MediaServerImportResult,
  type MediaServerSeriesImportResult,
} from "./mediaServerImport.js";
import { translateTrashFormat, type TrashCustomFormat } from "./trashFormats.js";
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
  const poster = images?.find((i) => i.coverType === "poster") ?? images?.find((i) => i.coverType === "cover");
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

// ---- Whisparr (adult) — its own "Eros" (v3) API is a FLAT list of Movie/Scene items, each
// carrying its Studio denormalized on itself (studioTitle/studioForeignId), not nested the way
// Sonarr nests episodes under a series. Studio/Performer are separate top-level entities with
// their own endpoints, but nothing on a Movie/Scene item points at enough of a Studio's own
// overview/artwork to justify a second fetch (its own `images` already gives every item a
// perfectly good poster) — so a studio's own AoNarr "show" poster/overview is borrowed from
// whichever of its scenes is encountered first, the same "good enough, no extra round trip"
// tradeoff fetchLidarrLibrary/fetchReadarrLibrary don't need to make since Lidarr/Readarr's own
// parent (artist/author) endpoints already carry real overview/artwork directly.
interface WhisparrMovie {
  id: number;
  title: string;
  overview?: string;
  images?: StarrImage[];
  tmdbId?: number;
  tpdbId?: string;
  stashId?: string;
  imdbId?: string;
  studioTitle?: string;
  studioForeignId?: string;
  hasFile?: boolean;
  path?: string;
  movieFile?: { relativePath?: string; path?: string };
}

function whisparrExternalIds(item: WhisparrMovie): Record<string, string> {
  const ids: Record<string, string> = {};
  if (item.tpdbId) ids.tpdb = item.tpdbId;
  if (item.stashId) ids.stash = item.stashId;
  if (item.tmdbId) ids.tmdb = String(item.tmdbId);
  if (item.imdbId) ids.imdb = item.imdbId;
  return ids;
}

export async function fetchWhisparrLibrary(
  baseUrl: string,
  apiKey: string
): Promise<{ shows: Map<string, MediaServerShowInfo>; episodes: MediaServerEpisodeItem[] }> {
  const items = (await starrGet(baseUrl, apiKey, "movie", "v3")) as WhisparrMovie[];
  const shows = new Map<string, MediaServerShowInfo>();
  const episodes: MediaServerEpisodeItem[] = [];
  const episodeCounters = new Map<string, number>();

  for (const item of items) {
    if (!item.title) continue;
    // A scene/movie with no studio at all has no natural "show" to belong to — it becomes its own
    // single-episode show instead, keyed by its own item id (never collides with a real studio's
    // own foreignId-based key below).
    const showId = item.studioForeignId ? `studio:${item.studioForeignId}` : `solo:${item.id}`;

    if (!shows.has(showId)) {
      shows.set(showId, {
        title: item.studioForeignId ? item.studioTitle || "Unknown Studio" : item.title,
        year: null,
        overview: item.studioForeignId ? null : item.overview || null,
        posterUrl: starrPosterUrl(item.images),
        externalIds: item.studioForeignId ? {} : whisparrExternalIds(item),
      });
    }

    // Same reasoning as Radarr/Sonarr above — a monitored-but-not-yet-downloaded scene has no file
    // yet, imported anyway with path null so it shows up in AoNarr as monitored+missing.
    const filePath = item.hasFile
      ? item.movieFile?.path || (item.path && item.movieFile?.relativePath ? `${item.path}/${item.movieFile.relativePath}` : null)
      : null;
    // Whisparr has no season/episode numbering of its own (nothing to number scenes by within a
    // studio) — synthesized as season 1 + sequential, the exact same fallback a locally-scanned
    // adult folder's sequentialEpisodeFallback already uses for an un-numbered file.
    const episodeNumber = (episodeCounters.get(showId) ?? 0) + 1;
    episodeCounters.set(showId, episodeNumber);

    episodes.push({
      showId,
      path: filePath,
      seasonNumber: 1,
      episodeNumber,
      title: item.title,
      overview: item.overview || null,
    });
  }

  return { shows, episodes };
}

export async function importAdultFromWhisparr(
  baseUrl: string,
  apiKey: string,
  rootFolderId: number,
  signal?: AbortSignal
): Promise<MediaServerSeriesImportResult> {
  const { shows, episodes } = await fetchWhisparrLibrary(baseUrl, apiKey);
  return importSeriesData(shows, episodes, "adult", rootFolderId, signal);
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
  posterUrl: string | null;
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
  images?: StarrImage[];
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
        posterUrl: starrPosterUrl(album.images),
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
  images?: StarrImage[];
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
        posterUrl: starrPosterUrl(book.images),
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
      return externalIdsOverlap(externalIds, info.externalIds) || exactTitlesMatch(m.title, info.title);
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
      // an actual download, never get reset back to missing by a re-import. Still counts as matched
      // either way, so childrenMatched + childrenCreated + childrenSkipped always sums to the total
      // children processed, the same identity importSeriesData's equivalent episode handling keeps.
      if (child.path) {
        await db
          .prepare("UPDATE sub_items SET has_file = 1, file_path = ?, poster_url = COALESCE(poster_url, ?) WHERE id = ?")
          .run(child.path, child.posterUrl, existingChild.id);
      } else if (child.posterUrl) {
        await db.prepare("UPDATE sub_items SET poster_url = COALESCE(poster_url, ?) WHERE id = ?").run(child.posterUrl, existingChild.id);
      }
      result.childrenMatched++;
    } else {
      await db
        .prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored, has_file, file_path, poster_url)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          mediaItemId,
          child.title,
          child.releaseDate,
          child.externalId,
          child.externalId ? externalProvider : null,
          child.path ? 1 : 0,
          child.path,
          child.posterUrl
        );
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

// ---- Quality Profiles / Custom Formats, imported directly from a live instance ----------------
//
// Only Radarr, Sonarr, and Whisparr (a Radarr fork) publish a CustomFormat model that maps onto
// anything in AoNarr — its own condition-group shape already matches theirs field-for-field, the
// same one TRaSH-Guides mirrors and services/trashFormats.ts already translates. Lidarr/Readarr's
// quality tiers are audio/ebook format names (not video resolution/source tiers), which nothing in
// AoNarr's own `qualities` table has an equivalent of — offering an import that would silently
// create an unusable, empty-allowed-qualities profile is worse than not offering it, so those two
// apps stay library-import-only (see importArtistsFromLidarr/importAuthorsFromReadarr above).
export type StarrFormatApp = "radarr" | "sonarr" | "whisparr";

const STARR_FORMAT_APP_VERSION: Record<StarrFormatApp, "v1" | "v3"> = { radarr: "v3", sonarr: "v3", whisparr: "v3" };

/** New formats/profiles imported for the first time get scoped to the app's own library types
 * rather than left unrestricted — same reasoning trashSync.ts's own APP_MEDIA_TYPES already
 * documents for the TRaSH-Guides sync path. */
export const STARR_FORMAT_APP_MEDIA_TYPES: Record<StarrFormatApp, string[]> = {
  radarr: ["movie", "ppv"],
  sonarr: ["series", "anime", "sports"],
  whisparr: ["adult"],
};

export interface StarrCustomFormatPreview {
  sourceId: number;
  name: string;
  translatable: boolean;
  skipped: string[];
}

async function fetchStarrCustomFormats(
  baseUrl: string,
  apiKey: string,
  app: StarrFormatApp
): Promise<{ raw: TrashCustomFormat & { id: number }; translated: { groups: any[]; skipped: string[] } }[]> {
  const list = (await starrGet(baseUrl, apiKey, "customformat", STARR_FORMAT_APP_VERSION[app])) as (TrashCustomFormat & { id: number })[];
  return list.filter((cf) => cf.name && Array.isArray(cf.specifications)).map((raw) => ({ raw, translated: translateTrashFormat(raw) }));
}

/** What the admin sees before committing to an import — every format the instance has, whether
 * it's translatable at all, and which of its own condition types (if any) would get dropped. */
export async function previewStarrCustomFormats(baseUrl: string, apiKey: string, app: StarrFormatApp): Promise<StarrCustomFormatPreview[]> {
  const items = await fetchStarrCustomFormats(baseUrl, apiKey, app);
  return items.map(({ raw, translated }) => ({
    sourceId: raw.id,
    name: raw.name,
    translatable: translated.groups.length > 0,
    skipped: translated.skipped,
  }));
}

export interface StarrCustomFormatImportResult {
  added: number;
  skipped: { name: string; reason: string }[];
}

/** Creates exactly the formats in `sourceIds` — a one-time, admin-picked subset (unlike
 * trash-sync's own "import everything" bulk sync), since a live instance's formats are rarely all
 * wanted and there's no stable id worth tracking for a later re-sync the way TRaSH's own `trash_id`
 * is (a live instance's own internal id is only meaningful to that one instance). Re-running this
 * with the same selection is still safe — a name collision with an already-imported format is
 * reported back as skipped rather than duplicated or aborting the rest. */
export async function importStarrCustomFormats(
  baseUrl: string,
  apiKey: string,
  app: StarrFormatApp,
  sourceIds: number[]
): Promise<StarrCustomFormatImportResult> {
  const result: StarrCustomFormatImportResult = { added: 0, skipped: [] };
  const items = await fetchStarrCustomFormats(baseUrl, apiKey, app);
  const wanted = items.filter((i) => sourceIds.includes(i.raw.id));
  const mediaTypes = STARR_FORMAT_APP_MEDIA_TYPES[app];

  for (const { raw, translated } of wanted) {
    if (translated.groups.length === 0) {
      result.skipped.push({ name: raw.name, reason: "none of its conditions are supported" });
      continue;
    }
    try {
      await db
        .prepare("INSERT INTO custom_formats (name, patterns, media_types) VALUES (?, ?, ?)")
        .run(raw.name, JSON.stringify(translated.groups), JSON.stringify(mediaTypes));
      result.added++;
    } catch (err) {
      // Most likely custom_formats.name's UNIQUE constraint (a format with this name already
      // exists) — skip it rather than aborting the rest of the batch over one clash.
      result.skipped.push({ name: raw.name, reason: (err as Error).message });
    }
  }
  return result;
}

// ---- Quality Profiles ---------------------------------------------------------------------
//
// A Radarr/Sonarr/Whisparr QualityProfileResource's `items[]` can nest — a "group" bundles
// several qualities under one admin-picked name for upgrade purposes. A leaf item carries its own
// `quality: {id, name}`; a group item's `quality` key is omitted entirely (not null — these apps'
// JSON serializer drops null fields) and it carries `items[]` of its own member qualities instead.
// `cutoff` is an item id, which can point at either a leaf or a group — resolving it to a name
// AoNarr can use means walking the same recursive structure.
interface StarrQualityProfileItem {
  id?: number;
  name?: string;
  quality?: { id: number; name: string };
  items?: StarrQualityProfileItem[];
  allowed: boolean;
}

interface StarrQualityProfile {
  id: number;
  name: string;
  cutoff: number;
  items: StarrQualityProfileItem[];
  minFormatScore?: number;
  formatItems?: { format: number; name: string; score: number }[];
}

/** Every *allowed* leaf quality's own name, recursing into groups — a group with `allowed: false`
 * contributes nothing even if Radarr/Sonarr still nested allowed-looking members under it. */
function collectAllowedQualityNames(items: StarrQualityProfileItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (!item.allowed) continue;
    if (item.quality) names.push(item.quality.name);
    else if (item.items) names.push(...collectAllowedQualityNames(item.items));
  }
  return names;
}

function findQualityProfileItemById(items: StarrQualityProfileItem[], id: number): StarrQualityProfileItem | null {
  for (const item of items) {
    if (item.id === id || item.quality?.id === id) return item;
    if (item.items) {
      const found = findQualityProfileItemById(item.items, id);
      if (found) return found;
    }
  }
  return null;
}

export interface StarrQualityProfilePreview {
  sourceId: number;
  name: string;
  mappedQualities: string[];
  unmappedQualities: string[];
  cutoff: string | null;
  minFormatScore: number;
}

async function fetchStarrQualityProfiles(baseUrl: string, apiKey: string, app: StarrFormatApp): Promise<StarrQualityProfile[]> {
  return (await starrGet(baseUrl, apiKey, "qualityprofile", STARR_FORMAT_APP_VERSION[app])) as StarrQualityProfile[];
}

/** Maps one source profile's allowed qualities/cutoff onto AoNarr's own `qualities` vocabulary —
 * `rankByName` decides what's mappable, and (when the cutoff itself doesn't map, e.g. it's a
 * group's own custom name) also picks the highest-ranked mapped quality as a substitute, so a
 * profile with an unresolvable cutoff still gets a sensible one rather than none at all. */
function translateStarrQualityProfile(profile: StarrQualityProfile, rankByName: Map<string, number>): StarrQualityProfilePreview {
  const allowedNames = collectAllowedQualityNames(profile.items);
  const mappedQualities = [...new Set(allowedNames.filter((n) => rankByName.has(n)))];
  const unmappedQualities = [...new Set(allowedNames.filter((n) => !rankByName.has(n)))];

  const cutoffItem = findQualityProfileItemById(profile.items, profile.cutoff);
  let cutoff = cutoffItem?.quality?.name ?? null;
  if (!cutoff || !rankByName.has(cutoff)) {
    cutoff = mappedQualities.length > 0 ? mappedQualities.reduce((best, n) => (rankByName.get(n)! > rankByName.get(best)! ? n : best)) : null;
  }

  return { sourceId: profile.id, name: profile.name, mappedQualities, unmappedQualities, cutoff, minFormatScore: profile.minFormatScore ?? 0 };
}

export async function previewStarrQualityProfiles(baseUrl: string, apiKey: string, app: StarrFormatApp): Promise<StarrQualityProfilePreview[]> {
  const [profiles, aonarrQualities] = await Promise.all([
    fetchStarrQualityProfiles(baseUrl, apiKey, app),
    db.prepare("SELECT name, rank FROM qualities").all() as Promise<{ name: string; rank: number }[]>,
  ]);
  const rankByName = new Map(aonarrQualities.map((q) => [q.name, q.rank]));
  return profiles.map((p) => translateStarrQualityProfile(p, rankByName));
}

export interface StarrQualityProfileImportResult {
  added: number;
  skipped: { name: string; reason: string }[];
}

/** Creates the selected profiles, and — best-effort — carries over each one's per-format scores
 * (`formatItems[]`) for whichever of its formats already exist in AoNarr under the same name
 * (typically because they were imported via importStarrCustomFormats first); a format that isn't
 * in AoNarr yet just has no score row, same as any other format with no score set. */
export async function importStarrQualityProfiles(
  baseUrl: string,
  apiKey: string,
  app: StarrFormatApp,
  sourceIds: number[]
): Promise<StarrQualityProfileImportResult> {
  const result: StarrQualityProfileImportResult = { added: 0, skipped: [] };
  const [profiles, aonarrQualities] = await Promise.all([
    fetchStarrQualityProfiles(baseUrl, apiKey, app),
    db.prepare("SELECT name, rank FROM qualities").all() as Promise<{ name: string; rank: number }[]>,
  ]);
  const rankByName = new Map(aonarrQualities.map((q) => [q.name, q.rank]));
  const wanted = profiles.filter((p) => sourceIds.includes(p.id));

  for (const profile of wanted) {
    const preview = translateStarrQualityProfile(profile, rankByName);
    if (preview.mappedQualities.length === 0 || !preview.cutoff) {
      result.skipped.push({ name: profile.name, reason: "none of its allowed qualities have an AoNarr equivalent" });
      continue;
    }
    try {
      const insertResult = await db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score) VALUES (?, ?, ?, ?)")
        .run(profile.name, JSON.stringify(preview.mappedQualities), preview.cutoff, preview.minFormatScore);
      const newProfileId = Number(insertResult.lastInsertRowid);
      result.added++;

      for (const formatItem of profile.formatItems ?? []) {
        if (!formatItem.score) continue;
        const existingFormat = (await db.prepare("SELECT id FROM custom_formats WHERE name = ?").get(formatItem.name)) as { id: number } | undefined;
        if (!existingFormat) continue;
        await db
          .prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, ?)")
          .run(newProfileId, existingFormat.id, formatItem.score);
      }
    } catch (err) {
      // Most likely quality_profiles.name's UNIQUE constraint — skip it rather than aborting the
      // rest of the batch over one clash.
      result.skipped.push({ name: profile.name, reason: (err as Error).message });
    }
  }
  return result;
}
