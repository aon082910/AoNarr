import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { isExcluded } from "./importExclusions.js";
import { fetchWatchedFiles, getMediaServerConfig } from "./mediaServer.js";
import { findWatchedMatch } from "./archival.js";
import { autoSelectRootFolderId } from "./rootFolderSelect.js";
import { fetchSeriesEpisodesFor } from "./metadata.js";
import { log } from "./logger.js";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
const SOURCE_SAMPLE_SIZE = 5;

export interface Recommendation {
  title: string;
  year: number | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  type: "movie" | "series" | "artist";
  sourceTitle: string;
  /** "added" — TMDB/Last.fm "similar to X" seeded from the 5 most recently added library items
   * (the original behavior). "watched" — same similarity lookup, but seeded from what was
   * actually recently *watched* (via the configured media server's watch history) rather than
   * merely added — SuggestArr's real distinguishing signal, and the only basis auto-request acts
   * on, since "you added it" says nothing about whether anyone actually wanted it. */
  basis: "added" | "watched";
}

function parseExternalIds(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function recentLibraryItems(type: string): Promise<{ title: string; externalIds: Record<string, string> }[]> {
  const rows = (await db
    .prepare("SELECT title, external_ids FROM media_items WHERE type = ? ORDER BY added_at DESC LIMIT ?")
    .all(type, SOURCE_SAMPLE_SIZE)) as { title: string; external_ids: string | null }[];
  return rows.map((r) => ({ title: r.title, externalIds: parseExternalIds(r.external_ids) }));
}

/** Same shape as recentLibraryItems, but sourced from actual watch history (most recently played
 * first) instead of add date — only meaningful for "single"/"episodic" shape types (movie/series),
 * since watch history is keyed off a played file path, and only when a media server is configured
 * at all. Empty (not an error) otherwise, same as every other watch-history-gated feature here. */
async function recentlyWatchedLibraryItems(type: "movie" | "series"): Promise<{ title: string; externalIds: Record<string, string> }[]> {
  if (!getMediaServerConfig()) return [];
  let watched;
  try {
    watched = await fetchWatchedFiles();
  } catch {
    return [];
  }
  if (watched.length === 0) return [];

  const rows =
    type === "movie"
      ? ((await db.prepare("SELECT title, external_ids, path FROM media_items WHERE type = 'movie' AND has_file = 1 AND path IS NOT NULL").all()) as {
          title: string;
          external_ids: string | null;
          path: string;
        }[])
      : ((await db
          .prepare(
            `SELECT m.title, m.external_ids, e.file_path AS path, m.id AS media_item_id
             FROM episodes e JOIN media_items m ON m.id = e.media_item_id
             WHERE m.type = 'series' AND e.has_file = 1 AND e.file_path IS NOT NULL`
          )
          .all()) as { title: string; external_ids: string | null; path: string; media_item_id: number }[]);

  // A series can match on multiple episodes — keep only its most-recently-played one, keyed by
  // title (unique enough within one library type here).
  const byTitle = new Map<string, { title: string; externalIds: Record<string, string>; lastPlayedAt: number }>();
  for (const row of rows) {
    const match = findWatchedMatch(row.path, watched);
    if (!match) continue;
    const lastPlayedAt = match.lastPlayedAt.getTime();
    const existing = byTitle.get(row.title);
    if (existing && existing.lastPlayedAt >= lastPlayedAt) continue;
    byTitle.set(row.title, { title: row.title, externalIds: parseExternalIds(row.external_ids), lastPlayedAt });
  }

  return Array.from(byTitle.values())
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, SOURCE_SAMPLE_SIZE)
    .map((m) => ({ title: m.title, externalIds: m.externalIds }));
}

async function existingExternalIds(type: string, provider: string): Promise<Set<string>> {
  const rows = (await db.prepare("SELECT external_ids FROM media_items WHERE type = ?").all(type)) as {
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

async function recommendMovies(
  apiKey: string,
  sourceItems: { title: string; externalIds: Record<string, string> }[],
  basis: "added" | "watched"
): Promise<Recommendation[]> {
  const seen = await existingExternalIds("movie", "tmdb");
  const out: Recommendation[] = [];
  for (const source of sourceItems) {
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
        basis,
      });
    }
  }
  return out;
}

async function recommendSeries(
  apiKey: string,
  sourceItems: { title: string; externalIds: Record<string, string> }[],
  basis: "added" | "watched"
): Promise<Recommendation[]> {
  const seen = await existingExternalIds("series", "tmdb");
  const out: Recommendation[] = [];
  for (const source of sourceItems) {
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
        basis,
      });
    }
  }
  return out;
}

async function recommendArtists(apiKey: string): Promise<Recommendation[]> {
  const seenNames = new Set(
    ((await db.prepare("SELECT title FROM media_items WHERE type = 'artist'").all()) as { title: string }[]).map((r) =>
      r.title.toLowerCase()
    )
  );
  const out: Recommendation[] = [];
  for (const source of await recentLibraryItems("artist")) {
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
        basis: "added", // no watch-history equivalent for music — Last.fm's signal is scrobbles, which AoNarr doesn't read
      });
    }
  }
  return out;
}

/**
 * "Because you added X" recommendations (TMDB's recommendations endpoint for movies/TV, Last.fm's
 * similar-artist endpoint for music, both sourced from the 5 most recently added items per type)
 * plus "because you watched X" — the same similarity lookups, but seeded from actual watch history
 * via the configured media server instead of merely what's in the library. SuggestArr's real
 * distinguishing signal: what was added says nothing about whether anyone actually wanted it,
 * while what was watched is a much stronger interest signal — and the only basis
 * runAutoRequestFromWatchHistory (scheduler.ts) acts on for its opt-in auto-add.
 */
export async function getRecommendations(): Promise<{
  movies: Recommendation[];
  series: Recommendation[];
  artists: Recommendation[];
}> {
  const tmdbKey = getSetting("tmdbApiKey");
  const lastfmKey = getSetting("lastfmApiKey");

  const [addedMovies, watchedMovies, addedSeries, watchedSeries, artists] = await Promise.all([
    tmdbKey ? recommendMovies(tmdbKey, await recentLibraryItems("movie"), "added").catch(() => []) : Promise.resolve([]),
    tmdbKey ? recommendMovies(tmdbKey, await recentlyWatchedLibraryItems("movie"), "watched").catch(() => []) : Promise.resolve([]),
    tmdbKey ? recommendSeries(tmdbKey, await recentLibraryItems("series"), "added").catch(() => []) : Promise.resolve([]),
    tmdbKey ? recommendSeries(tmdbKey, await recentlyWatchedLibraryItems("series"), "watched").catch(() => []) : Promise.resolve([]),
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
    filterAsync([...watchedMovies, ...addedMovies], notExcluded),
    filterAsync([...watchedSeries, ...addedSeries], notExcluded),
    filterAsync(artists, notExcluded),
  ]);

  return { movies: filteredMovies, series: filteredSeries, artists: filteredArtists };
}

/**
 * SuggestArr's closed loop: don't just surface "because you watched X" suggestions for an admin
 * to browse and manually add (the getRecommendations() UI path above) — opt-in automatically add
 * the top few every run. Deliberately only ever acts on "watched" basis, never "added" — what's
 * already in the library says nothing about whether anyone wanted it, while what was actually
 * watched is a real interest signal worth auto-acting on.
 */
export async function runAutoRequestFromWatchHistory(): Promise<void> {
  if (getSetting("autoRequestFromWatchHistoryEnabled") !== "1") return;
  const limit = Math.max(1, Number(getSetting("autoRequestFromWatchHistoryLimit") ?? "3") || 3);

  const { movies, series } = await getRecommendations();
  const candidates = [...movies, ...series].filter((r) => r.basis === "watched").slice(0, limit);
  if (candidates.length === 0) return;

  const qualityProfileId =
    ((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined)?.id ?? null;

  let added = 0;
  for (const rec of candidates) {
    try {
      const rootFolderId = await autoSelectRootFolderId(rec.type);
      const result = await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
        )
        .run(rec.type, rec.title, rec.title.toLowerCase(), rec.year, rec.posterUrl, JSON.stringify(rec.externalIds), rootFolderId, qualityProfileId);

      if (rec.type === "series") {
        const episodes = await fetchSeriesEpisodesFor(rec.externalIds).catch(() => []);
        for (const ep of episodes) {
          await db
            .prepare(
              `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
               VALUES (?, ?, ?, ?, ?, ?, 1)`
            )
            .run(result.lastInsertRowid, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
        }
      }
      added++;
      log.info(`[recommendations] auto-requested "${rec.title}" (because you watched "${rec.sourceTitle}")`);
    } catch (err) {
      log.warn(`[recommendations] auto-request failed for "${rec.title}":`, (err as Error).message);
    }
  }
  if (added > 0) log.info(`[recommendations] auto-requested ${added} item(s) from watch history`);
}
