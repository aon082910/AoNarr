import path from "node:path";
import { db } from "../db/index.js";
import { type StarrApp, typeFilter } from "./apps.js";
import {
  dayOrNull,
  images,
  isoOrNull,
  loadItemTags,
  loadQualityCatalog,
  parseExternalIds,
  qualityModelOf,
  slugOf,
  type QualityCatalog,
} from "./shapes.js";

/**
 * The library resources a Starr app serves: series, episode and episodefile for Sonarr; movie and moviefile for Radarr;
 * artist, album and trackfile for Lidarr; author, book and bookfile for Readarr. Built from AoNarr's rows, which keep every
 * library type in one table and a title's parts (episodes, albums, books) in two others.
 */

const ENGLISH = { id: 1, name: "English" };

export interface LibraryContext {
  app: StarrApp;
  catalog: QualityCatalog;
  tags: Map<number, number[]>;
  /** Today as YYYY-MM-DD, for what has aired or been released. */
  today: string;
}

export async function loadContext(app: StarrApp): Promise<LibraryContext> {
  const [catalog, tags] = await Promise.all([loadQualityCatalog(), loadItemTags()]);
  return { app, catalog, tags, today: new Date().toISOString().slice(0, 10) };
}

/** Titles of an app with the path of their root folder; `ids` narrows to some of them. */
export async function titleRows(app: StarrApp, ids?: number[]): Promise<any[]> {
  const f = typeFilter(app);
  const params: unknown[] = [...f.params];
  let where = f.sql;
  if (ids) {
    if (ids.length === 0) return [];
    where += ` AND m.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }
  return (await db
    .prepare(`SELECT m.*, rf.path AS root_folder_path FROM media_items m LEFT JOIN root_folders rf ON rf.id = m.root_folder_id WHERE ${where} ORDER BY m.sort_title, m.id`)
    .all(...params)) as any[];
}

export async function titleRow(app: StarrApp, id: number): Promise<any | null> {
  return (await titleRows(app, [id]))[0] ?? null;
}

/** A title's folder: its path, or the folder of its file when the path is a file (a movie's is). */
function folderOf(row: any): string {
  const p = row.path as string | null;
  if (!p) return row.root_folder_path ? path.posix.join(String(row.root_folder_path).replace(/\\/g, "/"), slugOf(row.title, row.id)) : "";
  return /\.[A-Za-z0-9]{2,5}$/.test(p) ? path.dirname(p) : p;
}

function numeric(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function genresOf(row: any): string[] {
  try {
    const list = row.genres ? JSON.parse(row.genres) : [];
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function common(ctx: LibraryContext, row: any) {
  return {
    id: Number(row.id),
    overview: row.overview ?? "",
    images: images(row.poster_url, row.backdrop_url),
    path: folderOf(row),
    qualityProfileId: row.quality_profile_id == null ? 0 : Number(row.quality_profile_id),
    monitored: !!Number(row.monitored),
    rootFolderPath: row.root_folder_path ?? "",
    folder: path.basename(folderOf(row)),
    genres: genresOf(row),
    tags: ctx.tags.get(Number(row.id)) ?? [],
    added: isoOrNull(row.added_at) ?? new Date(0).toISOString(),
    ratings: { votes: 0, value: row.rating == null ? 0 : Number(row.rating) },
    certification: row.content_rating ?? undefined,
  };
}

// --- files -------------------------------------------------------------------------------------------------------

function mediaInfoOf(raw: unknown): Record<string, unknown> {
  try {
    const info = typeof raw === "string" ? JSON.parse(raw) : raw;
    return info && typeof info === "object" ? (info as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fileResource(ctx: LibraryContext, base: { id: number; filePath: string; size: number | null; quality: string | null; addedAt: unknown; mediaInfo: unknown; sceneName?: string | null }) {
  return {
    id: base.id,
    relativePath: path.basename(base.filePath),
    path: base.filePath,
    size: base.size == null ? 0 : Number(base.size),
    dateAdded: isoOrNull(base.addedAt) ?? new Date(0).toISOString(),
    sceneName: base.sceneName ?? "",
    releaseGroup: "",
    quality: qualityModelOf(ctx.catalog, base.quality),
    languages: [ENGLISH],
    mediaInfo: mediaInfoOf(base.mediaInfo),
    qualityCutoffNotMet: false,
    customFormats: [],
    customFormatScore: 0,
  };
}

/** A movie's file is the item's own. Its id is the movie's: one file per movie. */
export function movieFileResource(ctx: LibraryContext, row: any) {
  if (!Number(row.has_file) || !row.path) return null;
  return { movieId: Number(row.id), edition: "", ...fileResource(ctx, { id: Number(row.id), filePath: String(row.path), size: row.size_bytes, quality: row.quality, addedAt: row.added_at, mediaInfo: row.media_info, sceneName: row.file_release_title }) };
}

/** An episode's file is the episode's own; its id is the episode's. */
export function episodeFileResource(ctx: LibraryContext, ep: any) {
  if (!Number(ep.has_file) || !ep.file_path) return null;
  return { seriesId: Number(ep.media_item_id), seasonNumber: Number(ep.season_number), ...fileResource(ctx, { id: Number(ep.id), filePath: String(ep.file_path), size: ep.size_bytes, quality: ep.quality, addedAt: ep.added_at ?? null, mediaInfo: ep.media_info }) };
}

export function subItemFileResource(ctx: LibraryContext, app: StarrApp, sub: any) {
  if (!Number(sub.has_file) || !sub.file_path) return null;
  const base = fileResource(ctx, { id: Number(sub.id), filePath: String(sub.file_path), size: sub.size_bytes, quality: sub.quality, addedAt: null, mediaInfo: sub.media_info });
  return app.key === "lidarr" ? { artistId: Number(sub.media_item_id), albumId: Number(sub.id), ...base } : { authorId: Number(sub.media_item_id), bookId: Number(sub.id), ...base };
}

// --- Sonarr --------------------------------------------------------------------------------------------------------

export interface SeasonStats {
  seasonNumber: number;
  episodeCount: number;
  episodeFileCount: number;
  monitoredCount: number;
  totalEpisodeCount: number;
  sizeOnDisk: number;
  nextAiring: string | null;
  previousAiring: string | null;
}

export async function seasonStats(app: StarrApp, today: string, ids?: number[]): Promise<Map<number, SeasonStats[]>> {
  const f = typeFilter(app);
  const params: unknown[] = [...f.params];
  let where = f.sql;
  if (ids) {
    if (ids.length === 0) return new Map();
    where += ` AND m.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }
  const rows = (await db
    .prepare(
      `SELECT e.media_item_id AS id, e.season_number AS season, COUNT(*) AS total,
              SUM(CASE WHEN e.has_file = 1 THEN 1 ELSE 0 END) AS files,
              SUM(CASE WHEN e.monitored = 1 THEN 1 ELSE 0 END) AS monitored,
              SUM(CASE WHEN (e.monitored = 1 AND e.air_date IS NOT NULL AND e.air_date <= ?) OR e.has_file = 1 THEN 1 ELSE 0 END) AS counted,
              SUM(COALESCE(e.size_bytes, 0)) AS size,
              MIN(CASE WHEN e.monitored = 1 AND e.air_date > ? THEN e.air_date END) AS next_air,
              MAX(CASE WHEN e.monitored = 1 AND e.air_date <= ? THEN e.air_date END) AS previous_air
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE ${where}
       GROUP BY e.media_item_id, e.season_number
       ORDER BY e.media_item_id, e.season_number`
    )
    .all(today, today, today, ...params)) as any[];
  const map = new Map<number, SeasonStats[]>();
  for (const r of rows) {
    const list = map.get(Number(r.id)) ?? [];
    list.push({
      seasonNumber: Number(r.season),
      // Sonarr's EpisodeCount: a monitored episode that has aired, or one that has a file.
      episodeCount: Number(r.counted),
      episodeFileCount: Number(r.files),
      monitoredCount: Number(r.monitored),
      totalEpisodeCount: Number(r.total),
      sizeOnDisk: Number(r.size ?? 0),
      nextAiring: isoOrNull(r.next_air),
      previousAiring: isoOrNull(r.previous_air),
    });
    map.set(Number(r.id), list);
  }
  return map;
}

function seriesStatus(raw: string | null | undefined): "continuing" | "ended" | "upcoming" {
  const text = String(raw ?? "").toLowerCase();
  if (/ended|cancel/.test(text)) return "ended";
  if (/planned|upcoming|production|pilot/.test(text)) return "upcoming";
  return "continuing";
}

export function seriesResource(ctx: LibraryContext, row: any, seasons: SeasonStats[]) {
  const ids = parseExternalIds(row.external_ids);
  const status = seriesStatus(row.status);
  const sum = (pick: (s: SeasonStats) => number) => seasons.reduce((total, s) => total + pick(s), 0);
  const episodeCount = sum((s) => s.episodeCount);
  const fileCount = sum((s) => s.episodeFileCount);
  const aired = seasons.map((s) => s.previousAiring).filter(Boolean) as string[];
  const upcoming = seasons.map((s) => s.nextAiring).filter(Boolean) as string[];
  return {
    ...common(ctx, row),
    title: row.title,
    alternateTitles: [],
    sortTitle: row.sort_title,
    status,
    ended: status === "ended",
    network: row.studio ?? undefined,
    year: row.year ?? 0,
    seriesType: row.series_type || (row.type === "anime" ? "anime" : "standard"),
    cleanTitle: slugOf(row.title, row.id).replace(/-/g, ""),
    titleSlug: slugOf(row.title, row.id),
    languageProfileId: 1,
    seasonFolder: true,
    useSceneNumbering: false,
    runtime: row.runtime_minutes ?? 0,
    tvdbId: numeric(ids.tvdb),
    tmdbId: numeric(ids.tmdb),
    imdbId: ids.imdb ?? undefined,
    tvMazeId: 0,
    tvRageId: 0,
    firstAired: undefined,
    lastAired: aired.length > 0 ? aired.sort().at(-1) : undefined,
    previousAiring: aired.length > 0 ? aired.sort().at(-1) : undefined,
    nextAiring: upcoming.length > 0 ? upcoming.sort()[0] : undefined,
    originalLanguage: ENGLISH,
    seasons: seasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: s.monitoredCount > 0,
      statistics: {
        episodeFileCount: s.episodeFileCount,
        episodeCount: s.episodeCount,
        totalEpisodeCount: s.totalEpisodeCount,
        sizeOnDisk: s.sizeOnDisk,
        percentOfEpisodes: s.episodeCount > 0 ? Math.min(100, (s.episodeFileCount / s.episodeCount) * 100) : 100,
        nextAiring: s.nextAiring ?? undefined,
        previousAiring: s.previousAiring ?? undefined,
      },
    })),
    statistics: {
      seasonCount: seasons.filter((s) => s.seasonNumber > 0).length,
      episodeFileCount: fileCount,
      episodeCount,
      totalEpisodeCount: sum((s) => s.totalEpisodeCount),
      sizeOnDisk: sum((s) => s.sizeOnDisk),
      releaseGroups: [],
      percentOfEpisodes: episodeCount > 0 ? Math.min(100, (fileCount / episodeCount) * 100) : 100,
    },
  };
}

export function episodeResource(ctx: LibraryContext, ep: any, extras: { series?: unknown; withFile?: boolean } = {}) {
  const file = extras.withFile ? episodeFileResource(ctx, ep) : undefined;
  return {
    id: Number(ep.id),
    seriesId: Number(ep.media_item_id),
    tvdbId: 0,
    episodeFileId: Number(ep.has_file) && ep.file_path ? Number(ep.id) : 0,
    seasonNumber: Number(ep.season_number),
    episodeNumber: Number(ep.episode_number),
    title: ep.title ?? "",
    airDate: dayOrNull(ep.air_date) ?? undefined,
    airDateUtc: isoOrNull(ep.air_date) ?? undefined,
    overview: ep.overview ?? undefined,
    hasFile: !!Number(ep.has_file),
    monitored: !!Number(ep.monitored),
    absoluteEpisodeNumber: ep.absolute_episode_number ?? undefined,
    sceneAbsoluteEpisodeNumber: undefined,
    sceneEpisodeNumber: ep.scene_episode_number ?? undefined,
    sceneSeasonNumber: ep.scene_season_number ?? undefined,
    unverifiedSceneNumbering: false,
    runtime: 0,
    finaleType: undefined,
    ...(extras.series ? { series: extras.series } : {}),
    ...(file ? { episodeFile: file } : {}),
  };
}

// --- Radarr --------------------------------------------------------------------------------------------------------

function movieStatus(row: any, today: string): "tba" | "announced" | "inCinemas" | "released" {
  const date = dayOrNull(row.release_date);
  if (Number(row.has_file)) return "released";
  if (!date) return "announced";
  return date <= today ? "released" : "announced";
}

/** Radarr's isAvailable: the movie has reached what its minimum availability asks for. */
function movieAvailable(row: any, today: string): boolean {
  const minimum = row.minimum_availability || "announced";
  if (minimum === "announced" || minimum === "tba") return true;
  const release = dayOrNull(row.release_date);
  if (minimum === "inCinemas") return release != null && release <= today;
  const reference = dayOrNull(row.digital_release_date) ?? dayOrNull(row.physical_release_date) ?? release;
  return reference != null && reference <= today;
}

export function movieResource(ctx: LibraryContext, row: any, extras: { withFile?: boolean } = {}) {
  const ids = parseExternalIds(row.external_ids);
  const status = movieStatus(row, ctx.today);
  const file = extras.withFile === false ? undefined : movieFileResource(ctx, row);
  const sizeOnDisk = row.size_bytes == null ? 0 : Number(row.size_bytes);
  return {
    ...common(ctx, row),
    title: row.title,
    originalTitle: row.title,
    originalLanguage: ENGLISH,
    alternateTitles: [],
    sortTitle: row.sort_title,
    sizeOnDisk,
    status,
    inCinemas: isoOrNull(row.release_date) ?? undefined,
    physicalRelease: isoOrNull(row.physical_release_date) ?? undefined,
    digitalRelease: isoOrNull(row.digital_release_date) ?? undefined,
    year: row.year ?? 0,
    hasFile: !!Number(row.has_file),
    youTubeTrailerId: "",
    studio: row.studio ?? undefined,
    minimumAvailability: row.minimum_availability || "announced",
    isAvailable: !!Number(row.has_file) || movieAvailable(row, ctx.today),
    folderName: folderOf(row),
    runtime: row.runtime_minutes ?? 0,
    cleanTitle: slugOf(row.title, row.id).replace(/-/g, ""),
    imdbId: ids.imdb ?? undefined,
    tmdbId: numeric(ids.tmdb),
    titleSlug: ids.tmdb || slugOf(row.title, row.id),
    ...(file ? { movieFile: file } : {}),
    statistics: { movieFileCount: Number(row.has_file) ? 1 : 0, sizeOnDisk, releaseGroups: [] },
  };
}

// --- Lidarr and Readarr ----------------------------------------------------------------------------------------

export interface SubStats {
  total: number;
  files: number;
  monitored: number;
  size: number;
}

export async function subItemStats(app: StarrApp, ids?: number[]): Promise<Map<number, SubStats>> {
  const f = typeFilter(app);
  const params: unknown[] = [...f.params];
  let where = f.sql;
  if (ids) {
    if (ids.length === 0) return new Map();
    where += ` AND m.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }
  const rows = (await db
    .prepare(
      `SELECT s.media_item_id AS id, COUNT(*) AS total, SUM(CASE WHEN s.has_file = 1 THEN 1 ELSE 0 END) AS files,
              SUM(CASE WHEN s.monitored = 1 THEN 1 ELSE 0 END) AS monitored, SUM(COALESCE(s.size_bytes, 0)) AS size
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${where} GROUP BY s.media_item_id`
    )
    .all(...params)) as any[];
  return new Map(rows.map((r) => [Number(r.id), { total: Number(r.total), files: Number(r.files), monitored: Number(r.monitored), size: Number(r.size ?? 0) }]));
}

export function artistResource(ctx: LibraryContext, row: any, stats: SubStats | undefined) {
  const ids = parseExternalIds(row.external_ids);
  const s = stats ?? { total: 0, files: 0, monitored: 0, size: 0 };
  return {
    ...common(ctx, row),
    artistName: row.title,
    sortName: row.sort_title,
    status: seriesStatus(row.status) === "ended" ? "ended" : "continuing",
    ended: seriesStatus(row.status) === "ended",
    disambiguation: "",
    links: [],
    cleanName: slugOf(row.title, row.id).replace(/-/g, ""),
    foreignArtistId: ids.musicbrainz ?? ids.mbid ?? "",
    metadataProfileId: row.metadata_profile_id == null ? 0 : Number(row.metadata_profile_id),
    monitorNewItems: row.monitor_new_items === "none" ? "none" : "all",
    artistType: "",
    statistics: { albumCount: s.monitored, trackFileCount: s.files, trackCount: s.monitored, totalTrackCount: s.total, sizeOnDisk: s.size, percentOfTracks: s.monitored > 0 ? Math.min(100, (s.files / s.monitored) * 100) : 100 },
  };
}

export function authorResource(ctx: LibraryContext, row: any, stats: SubStats | undefined) {
  const ids = parseExternalIds(row.external_ids);
  const s = stats ?? { total: 0, files: 0, monitored: 0, size: 0 };
  return {
    ...common(ctx, row),
    authorName: row.title,
    authorNameLastFirst: row.title,
    sortName: row.sort_title,
    status: seriesStatus(row.status) === "ended" ? "ended" : "continuing",
    ended: seriesStatus(row.status) === "ended",
    disambiguation: "",
    links: [],
    cleanName: slugOf(row.title, row.id).replace(/-/g, ""),
    foreignAuthorId: ids.openlibrary ?? ids.goodreads ?? "",
    metadataProfileId: row.metadata_profile_id == null ? 0 : Number(row.metadata_profile_id),
    monitorNewItems: row.monitor_new_items === "none" ? "none" : "all",
    statistics: { bookCount: s.monitored, bookFileCount: s.files, availableBookCount: s.files, totalBookCount: s.total, sizeOnDisk: s.size, percentOfBooks: s.monitored > 0 ? Math.min(100, (s.files / s.monitored) * 100) : 100 },
  };
}

export function subItemResource(ctx: LibraryContext, app: StarrApp, sub: any, extras: { artist?: unknown } = {}) {
  const hasFile = !!Number(sub.has_file);
  const size = sub.size_bytes == null ? 0 : Number(sub.size_bytes);
  const base = {
    id: Number(sub.id),
    title: sub.title,
    disambiguation: "",
    overview: sub.overview ?? undefined,
    monitored: !!Number(sub.monitored),
    releaseDate: isoOrNull(sub.release_date) ?? undefined,
    images: images(sub.poster_url),
    genres: [],
    ratings: { votes: 0, value: 0 },
    grabbed: false,
  };
  if (app.key === "lidarr") {
    return {
      ...base,
      artistId: Number(sub.media_item_id),
      foreignAlbumId: sub.external_id ?? "",
      anyReleaseOk: true,
      profileId: 0,
      duration: 0,
      albumType: "Album",
      secondaryTypes: [],
      mediaCount: 1,
      releases: [],
      media: [],
      ...(extras.artist ? { artist: extras.artist } : {}),
      statistics: { trackFileCount: hasFile ? 1 : 0, trackCount: 1, totalTrackCount: 1, sizeOnDisk: size, percentOfTracks: hasFile ? 100 : 0 },
    };
  }
  return {
    ...base,
    authorId: Number(sub.media_item_id),
    foreignBookId: sub.external_id ?? "",
    titleSlug: slugOf(sub.title, sub.id),
    pageCount: 0,
    seriesTitle: sub.series_name ?? "",
    anyEditionOk: true,
    editions: [],
    ...(extras.artist ? { author: extras.artist } : {}),
    statistics: { bookFileCount: hasFile ? 1 : 0, bookCount: 1, totalBookCount: 1, sizeOnDisk: size, percentOfBooks: hasFile ? 100 : 0 },
  };
}

/** The resource of a title in any app, with its statistics (one query each, for a list of titles or one). */
export async function titleResources(ctx: LibraryContext, rows: any[]): Promise<any[]> {
  const app = ctx.app;
  const ids = rows.map((r) => Number(r.id));
  if (app.key === "sonarr") {
    const stats = await seasonStats(app, ctx.today, ids);
    return rows.map((row) => seriesResource(ctx, row, stats.get(Number(row.id)) ?? []));
  }
  if (app.key === "radarr") return rows.map((row) => movieResource(ctx, row));
  const stats = await subItemStats(app, ids);
  return rows.map((row) => (app.key === "lidarr" ? artistResource(ctx, row, stats.get(Number(row.id))) : authorResource(ctx, row, stats.get(Number(row.id)))));
}
