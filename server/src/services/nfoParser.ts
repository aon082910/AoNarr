import { parseStringPromise } from "xml2js";
import { CONTENT_RATING_ORDER } from "./contentRatings.js";

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

/** Kodi writes <mpaa> with its "Rated " prefix ("Rated R") and other NFO writers use a country
 * prefix ("US:R", "US:Rated PG-13", "GB:15 / US:R"). Stored verbatim those are unranked, so a
 * household max-content-rating restriction never blocks them. The canonical vocabulary is the US
 * one, so a US (or unprefixed) part wins over another country's same-named label ("GB:PG / US:PG-13"
 * is PG-13, not the UK's PG). Anything that doesn't reduce to the vocabulary (a course's "All Ages",
 * an artist's "Explicit") is kept as written. */
function normalizeNfoRating(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split("/").map((part) => {
    const m = part.trim().match(/^(?:rated\s+)?(?:([a-z]{2,3})\s*:\s*)?(?:rated\s+)?(.*)$/i);
    return { country: m?.[1]?.toUpperCase() ?? null, bare: (m?.[2] ?? "").trim().toUpperCase() };
  });
  const isUs = (country: string | null) => country === null || country === "US" || country === "USA";
  const pick = (candidates: typeof parts) => candidates.find((p) => CONTENT_RATING_ORDER.includes(p.bare))?.bare;
  return pick(parts.filter((p) => isUs(p.country))) ?? pick(parts) ?? raw;
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

  const contentRating = normalizeNfoRating(firstText(root.mpaa));
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
    // Season 0 is Kodi/Jellyfin's specials season, so 0 must survive (not be treated as falsy).
    season: season !== null && !Number.isNaN(season) ? season : null,
    episode: episode !== null && !Number.isNaN(episode) ? episode : null,
  };
}
