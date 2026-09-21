import { parseStringPromise } from "xml2js";

export interface ParsedNfo {
  title: string | null;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  contentRating: string | null;
  genres: string[];
  /** Only present for an episodedetails.nfo root — a show/movie/artist/album NFO has neither. */
  season: number | null;
  episode: number | null;
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "_" in (value as any)) return firstText((value as any)._);
  return null;
}

function allText(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => firstText(v)).filter((v): v is string => !!v);
}

/**
 * Parses a Kodi/Jellyfin-style .nfo sidecar file (movie.nfo, tvshow.nfo, episodedetails.nfo,
 * artist.nfo, album.nfo) into the same shape AddMedia's metadata search returns, so an NFO import
 * can prefill the same form fields instead of requiring a live provider lookup — and, since
 * Round 340, the same shape sidecarMetadata.ts's automatic scan/refresh matching consumes too.
 */
export async function parseNfo(xml: string): Promise<ParsedNfo> {
  const parsed = await parseStringPromise(xml, { explicitArray: true, mergeAttrs: true });
  const root = parsed?.movie ?? parsed?.tvshow ?? parsed?.episodedetails ?? parsed?.artist ?? parsed?.musicalbum ?? parsed?.album ?? null;
  const empty: ParsedNfo = { title: null, year: null, overview: null, posterUrl: null, externalIds: {}, contentRating: null, genres: [], season: null, episode: null };
  if (!root) return empty;

  // A real Kodi artist.nfo's own title field is <name>, not <title> — <title> is a movie/tvshow/
  // episodedetails convention only. Without this fallback every genuine artist.nfo parsed to a
  // null title (the field it actually has was never read at all).
  const title = firstText(root.title) ?? firstText(root.name);
  const yearText = firstText(root.year) ?? (firstText(root.premiered) ?? firstText(root.releasedate))?.slice(0, 4);
  const year = yearText ? parseInt(yearText, 10) : null;
  const overview = firstText(root.plot) ?? firstText(root.outline) ?? firstText(root.biography);

  let posterUrl: string | null = null;
  if (Array.isArray(root.thumb)) {
    const posterThumb = root.thumb.find((t: any) => !t.aspect || firstText(t.aspect) === "poster") ?? root.thumb[0];
    posterUrl = firstText(posterThumb);
  }

  const externalIds: Record<string, string> = {};
  const uniqueIds = Array.isArray(root.uniqueid) ? root.uniqueid : root.uniqueid ? [root.uniqueid] : [];
  for (const entry of uniqueIds) {
    const type = firstText(entry?.type);
    const value = firstText(entry);
    if (type && value) externalIds[type] = value;
  }
  const imdbId = firstText(root.imdbid ?? root.imdb_id);
  if (imdbId && !externalIds.imdb) externalIds.imdb = imdbId;

  const contentRating = firstText(root.mpaa);
  const genres = allText(root.genre);

  const seasonText = firstText(root.season);
  const episodeText = firstText(root.episode);
  const season = seasonText ? parseInt(seasonText, 10) : null;
  const episode = episodeText ? parseInt(episodeText, 10) : null;

  return {
    title,
    year: year && !Number.isNaN(year) ? year : null,
    overview,
    posterUrl,
    externalIds,
    contentRating,
    genres,
    season: season && !Number.isNaN(season) ? season : null,
    episode: episode && !Number.isNaN(episode) ? episode : null,
  };
}
