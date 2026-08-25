import { log } from "./logger.js";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { fetchSeriesEpisodesFor } from "./metadata.js";
import { isExcluded } from "./importExclusions.js";
import { parsePlexExternalIds } from "./mediaServer.js";

const DISCOVER_BASE = "https://discover.provider.plex.tv";

async function fetchWatchlistItems(token: string): Promise<any[]> {
  const url = `${DISCOVER_BASE}/library/sections/watchlist/all?includeCollections=1&includeExternalMedia=1`;
  const res = await fetch(url, { headers: { Accept: "application/json", "X-Plex-Token": token } });
  if (!res.ok) throw new Error(`Plex watchlist request failed: HTTP ${res.status}`);
  const body: any = await res.json();
  return body?.MediaContainer?.Metadata ?? [];
}

async function existingTmdbIds(type: string): Promise<Set<string>> {
  const rows = (await db.prepare("SELECT external_ids FROM media_items WHERE type = ?").all(type)) as {
    external_ids: string | null;
  }[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.external_ids) continue;
    try {
      const parsed = JSON.parse(row.external_ids);
      if (parsed.tmdb) ids.add(String(parsed.tmdb));
    } catch {
      // malformed external_ids on an old row — skip rather than crash the whole sync
    }
  }
  return ids;
}

async function defaultQualityProfileId(): Promise<number | null> {
  const row = (await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Adds anything new in the admin's own Plex account watchlist (the same account whose token is
 * configured for Media Server Sync in Settings) as a monitored library item — movies as single
 * items, shows with their full episode list fetched via TMDB. Same "auto-add, never remove"
 * pattern as the existing Trakt list sync, just sourced from Plex's watchlist instead of a Trakt
 * list/watchlist URL. Watchlist items only carry a `type` of "movie" or "show" (Plex's own
 * terminology) — mapped to AoNarr's "movie"/"series" media types.
 */
export async function runPlexWatchlistSync(): Promise<{ added: number; error?: string }> {
  if (getSetting("plexWatchlistSyncEnabled") !== "1") return { added: 0 };
  if (getSetting("mediaServerType") !== "plex") return { added: 0 };
  const token = getSetting("mediaServerToken");
  if (!token) return { added: 0 };

  let items: any[];
  try {
    items = await fetchWatchlistItems(token);
  } catch (err) {
    return { added: 0, error: (err as Error).message };
  }

  const qualityProfileId = await defaultQualityProfileId();
  const existingMovies = await existingTmdbIds("movie");
  const existingSeries = await existingTmdbIds("series");
  let added = 0;

  for (const item of items) {
    try {
      const ids = parsePlexExternalIds(item);
      const tmdbId = ids.tmdb;
      if (!tmdbId) continue; // no reliable id to match against — skip rather than guess by title

      if (item.type === "movie") {
        if (existingMovies.has(tmdbId)) continue;
        if (await isExcluded("movie", item.title, item.year ?? null, tmdbId, "tmdb")) continue;
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, quality_profile_id, monitored, status)
             VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(
            item.title,
            String(item.title).toLowerCase(),
            item.year ?? null,
            item.summary ?? null,
            item.thumb ? `https://metadata-static.plex.tv${item.thumb}` : null,
            JSON.stringify({ tmdb: tmdbId, ...(ids.imdb ? { imdb: ids.imdb } : {}) }),
            qualityProfileId
          );
        existingMovies.add(tmdbId);
        added++;
      } else if (item.type === "show") {
        if (existingSeries.has(tmdbId)) continue;
        if (await isExcluded("series", item.title, item.year ?? null, tmdbId, "tmdb")) continue;
        const externalIds = { tmdb: tmdbId, ...(ids.imdb ? { imdb: ids.imdb } : {}) };
        const result = await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, quality_profile_id, monitored, status)
             VALUES ('series', ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(
            item.title,
            String(item.title).toLowerCase(),
            item.year ?? null,
            item.summary ?? null,
            item.thumb ? `https://metadata-static.plex.tv${item.thumb}` : null,
            JSON.stringify(externalIds),
            qualityProfileId
          );

        const mediaItemId = result.lastInsertRowid;
        const episodes = await fetchSeriesEpisodesFor(externalIds).catch(() => []);
        for (const ep of episodes) {
          await db
            .prepare(
              `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
               VALUES (?, ?, ?, ?, ?, ?, 1)`
            )
            .run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
        }

        existingSeries.add(tmdbId);
        added++;
      }
    } catch (err) {
      log.warn("[plexWatchlistSync] failed to add an item:", (err as Error).message);
    }
  }

  return { added };
}
