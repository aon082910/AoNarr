import { log } from "./logger.js";
import { db } from "../db/client.js";
import { getSetting } from "./settingsStore.js";
import { fetchSeriesEpisodesFor } from "./metadata.js";
import { isExcluded } from "./importExclusions.js";

interface TraktListTarget {
  username: string;
  listSlug: string | null; // null = watchlist
}

/** Accepts a public Trakt list or watchlist URL, e.g.
 * https://trakt.tv/users/aonarr/lists/to-watch or https://trakt.tv/users/aonarr/watchlist */
function parseTraktListUrl(url: string): TraktListTarget | null {
  const m = url.match(/trakt\.tv\/users\/([^/]+)\/(?:lists\/([^/?#]+)|watchlist)/);
  if (!m) return null;
  return { username: m[1], listSlug: m[2] ?? null };
}

async function fetchTraktListItems(target: TraktListTarget, clientId: string): Promise<any[]> {
  const path = target.listSlug ? `lists/${target.listSlug}/items` : "watchlist";
  const url = `https://api.trakt.tv/users/${target.username}/${path}`;
  const res = await fetch(url, {
    headers: { "trakt-api-version": "2", "trakt-api-key": clientId, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Trakt list request failed: HTTP ${res.status}`);
  return (await res.json()) as any[];
}

function existingTmdbIds(type: string): Set<string> {
  const rows = db.prepare("SELECT external_ids FROM media_items WHERE type = ?").all(type) as {
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

function defaultQualityProfileId(): number | null {
  const row = db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

/** Adds anything new in the configured Trakt list/watchlist as a monitored library item —
 * movies as single items, shows with their full episode list fetched via TMDB (reusing the same
 * add-media pipeline every other import path uses). Never removes items the list no longer has. */
export async function runTraktSync(): Promise<{ added: number; error?: string }> {
  if (getSetting("traktSyncEnabled") !== "1") return { added: 0 };
  const url = getSetting("traktSyncUrl");
  const clientId = getSetting("traktClientId");
  if (!url || !clientId) return { added: 0 };

  const target = parseTraktListUrl(url);
  if (!target) return { added: 0, error: "Trakt list URL is not in a recognized format" };

  let items: any[];
  try {
    items = await fetchTraktListItems(target, clientId);
  } catch (err) {
    return { added: 0, error: (err as Error).message };
  }

  const qualityProfileId = defaultQualityProfileId();
  const existingMovies = existingTmdbIds("movie");
  const existingSeries = existingTmdbIds("series");
  let added = 0;

  for (const entry of items) {
    try {
      if (entry.movie) {
        const m = entry.movie;
        const tmdbId = m.ids?.tmdb;
        if (!tmdbId || existingMovies.has(String(tmdbId))) continue;
        if (isExcluded("movie", m.title, m.year ?? null, String(tmdbId), "tmdb")) continue;
        db.prepare(
          `INSERT INTO media_items (type, title, sort_title, year, external_ids, quality_profile_id, monitored, status)
           VALUES ('movie', ?, ?, ?, ?, ?, 1, 'missing')`
        ).run(m.title, m.title.toLowerCase(), m.year ?? null, JSON.stringify({ tmdb: String(tmdbId), trakt: String(m.ids?.trakt ?? "") }), qualityProfileId);
        existingMovies.add(String(tmdbId));
        added++;
      } else if (entry.show) {
        const s = entry.show;
        const tmdbId = s.ids?.tmdb;
        if (!tmdbId || existingSeries.has(String(tmdbId))) continue;
        if (isExcluded("series", s.title, s.year ?? null, String(tmdbId), "tmdb")) continue;
        const externalIds = { tmdb: String(tmdbId), trakt: String(s.ids?.trakt ?? "") };
        const result = db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, external_ids, quality_profile_id, monitored, status)
             VALUES ('series', ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(s.title, s.title.toLowerCase(), s.year ?? null, JSON.stringify(externalIds), qualityProfileId);

        const mediaItemId = result.lastInsertRowid;
        const episodes = await fetchSeriesEpisodesFor(externalIds).catch(() => []);
        const insertEp = db.prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored)
           VALUES (?, ?, ?, ?, ?, 1)`
        );
        for (const ep of episodes) insertEp.run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate);

        existingSeries.add(String(tmdbId));
        added++;
      }
    } catch (err) {
      log.warn("[traktSync] failed to add an item:", (err as Error).message);
    }
  }

  return { added };
}
