import { db } from "../db/client.js";
import { getSetting } from "./settingsStore.js";
import { isExcluded } from "./importExclusions.js";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
const SOURCE_SAMPLE_SIZE = 5;

export interface Recommendation {
  title: string;
  year: number | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  type: "movie" | "series" | "artist";
  sourceTitle: string;
}

function parseExternalIds(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function recentLibraryItems(type: string): { title: string; externalIds: Record<string, string> }[] {
  const rows = db
    .prepare("SELECT title, external_ids FROM media_items WHERE type = ? ORDER BY added_at DESC LIMIT ?")
    .all(type, SOURCE_SAMPLE_SIZE) as { title: string; external_ids: string | null }[];
  return rows.map((r) => ({ title: r.title, externalIds: parseExternalIds(r.external_ids) }));
}

function existingExternalIds(type: string, provider: string): Set<string> {
  const rows = db.prepare("SELECT external_ids FROM media_items WHERE type = ?").all(type) as {
    external_ids: string | null;
  }[];
  const ids = new Set<string>();
  for (const row of rows) {
    const parsed = parseExternalIds(row.external_ids);
    if (parsed[provider]) ids.add(String(parsed[provider]));
  }
  return ids;
}

async function tmdbSimilar(kind: "movie" | "tv", tmdbId: string, apiKey: string): Promise<any[]> {
  const url = new URL(`https://api.themoviedb.org/3/${kind}/${tmdbId}/recommendations`);
  url.searchParams.set("api_key", apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const body = (await res.json()) as { results?: any[] };
  return body.results ?? [];
}

async function recommendMovies(apiKey: string): Promise<Recommendation[]> {
  const seen = existingExternalIds("movie", "tmdb");
  const out: Recommendation[] = [];
  for (const source of recentLibraryItems("movie")) {
    const tmdbId = source.externalIds.tmdb;
    if (!tmdbId) continue;
    const results = await tmdbSimilar("movie", tmdbId, apiKey);
    for (const r of results.slice(0, 5)) {
      if (seen.has(String(r.id))) continue;
      out.push({
        title: r.title ?? r.name ?? "Unknown",
        year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
        posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
        externalIds: { tmdb: String(r.id) },
        type: "movie",
        sourceTitle: source.title,
      });
    }
  }
  return out;
}

async function recommendSeries(apiKey: string): Promise<Recommendation[]> {
  const seen = existingExternalIds("series", "tmdb");
  const out: Recommendation[] = [];
  for (const source of recentLibraryItems("series")) {
    const tmdbId = source.externalIds.tmdb;
    if (!tmdbId) continue;
    const results = await tmdbSimilar("tv", tmdbId, apiKey);
    for (const r of results.slice(0, 5)) {
      if (seen.has(String(r.id))) continue;
      out.push({
        title: r.name ?? r.title ?? "Unknown",
        year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
        posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
        externalIds: { tmdb: String(r.id) },
        type: "series",
        sourceTitle: source.title,
      });
    }
  }
  return out;
}

async function recommendArtists(apiKey: string): Promise<Recommendation[]> {
  const seenNames = new Set(
    (db.prepare("SELECT title FROM media_items WHERE type = 'artist'").all() as { title: string }[]).map((r) =>
      r.title.toLowerCase()
    )
  );
  const out: Recommendation[] = [];
  for (const source of recentLibraryItems("artist")) {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", "artist.getsimilar");
    url.searchParams.set("artist", source.title);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "5");
    const res = await fetch(url.toString());
    if (!res.ok) continue;
    const body = (await res.json()) as { similarartists?: { artist?: any[] } };
    for (const a of body.similarartists?.artist ?? []) {
      if (seenNames.has(String(a.name).toLowerCase())) continue;
      const image = Array.isArray(a.image) ? a.image.find((i: any) => i.size === "large")?.["#text"] : null;
      out.push({
        title: a.name,
        year: null,
        posterUrl: image || null,
        externalIds: a.mbid ? { musicbrainz: a.mbid } : {},
        type: "artist",
        sourceTitle: source.title,
      });
    }
  }
  return out;
}

/** "Because you added X" recommendations — TMDB's recommendations endpoint for movies/TV
 * (reusing the tmdb id already on each library item), Last.fm's similar-artist endpoint for
 * music. Sourced from the 5 most recently added items per type to keep API calls bounded. */
export async function getRecommendations(): Promise<{
  movies: Recommendation[];
  series: Recommendation[];
  artists: Recommendation[];
}> {
  const tmdbKey = getSetting("tmdbApiKey");
  const lastfmKey = getSetting("lastfmApiKey");

  const [movies, series, artists] = await Promise.all([
    tmdbKey ? recommendMovies(tmdbKey).catch(() => []) : Promise.resolve([]),
    tmdbKey ? recommendSeries(tmdbKey).catch(() => []) : Promise.resolve([]),
    lastfmKey ? recommendArtists(lastfmKey).catch(() => []) : Promise.resolve([]),
  ]);

  const notExcluded = async (r: Recommendation) => {
    const provider = Object.keys(r.externalIds)[0];
    return !(await isExcluded(r.type, r.title, r.year, provider ? r.externalIds[provider] : null, provider ?? null));
  };
  // isExcluded is DB-backed (async) — Array.filter's predicate can't await, so each list is
  // checked in parallel first and filtered against the resulting boolean array instead.
  async function filterAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
    const keep = await Promise.all(items.map(predicate));
    return items.filter((_, i) => keep[i]);
  }

  const [filteredMovies, filteredSeries, filteredArtists] = await Promise.all([
    filterAsync(movies, notExcluded),
    filterAsync(series, notExcluded),
    filterAsync(artists, notExcluded),
  ]);

  return { movies: filteredMovies, series: filteredSeries, artists: filteredArtists };
}
