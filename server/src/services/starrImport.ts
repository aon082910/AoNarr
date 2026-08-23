import type { MediaServerEpisodeItem, MediaServerLibraryItem, MediaServerShowInfo } from "./mediaServer.js";
import { importMovieItems, importSeriesData, type MediaServerImportResult, type MediaServerSeriesImportResult } from "./mediaServerImport.js";

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

async function starrGet(baseUrl: string, apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v3/${path}`, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
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
    if (!m.hasFile || !m.title) continue;
    const filePath = m.movieFile?.path || (m.path && m.movieFile?.relativePath ? `${m.path}/${m.movieFile.relativePath}` : null);
    if (!filePath) continue;
    results.push({
      mediaServerId: filePath,
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
      if (!ep.hasFile || !ep.episodeFileId) continue;
      const path = filesById.get(ep.episodeFileId);
      if (!path) continue;
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
