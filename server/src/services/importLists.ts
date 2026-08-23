import { log } from "./logger.js";
import { db } from "../db/client.js";
import { getSetting } from "./settingsStore.js";
import { fetchArtistAlbumsFor, fetchSeriesEpisodesFor, searchMetadata } from "./metadata.js";
import { isExcluded } from "./importExclusions.js";
import { findPossibleDuplicates } from "./duplicateCheck.js";
import { queueForReview } from "./importReview.js";

export interface ImportListRow {
  id: number;
  name: string;
  type: "trakt" | "imdb" | "lastfm";
  url: string;
  enabled: number;
  quality_profile_id: number | null;
  last_synced_at: string | null;
  last_added_count: number | null;
  last_error: string | null;
  created_at: string;
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

async function insertSeriesEpisodes(mediaItemId: number | bigint, externalIds: Record<string, string>) {
  const episodes = await fetchSeriesEpisodesFor(externalIds).catch(() => []);
  const insertEp = db.prepare(
    `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  for (const ep of episodes) insertEp.run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
}

async function insertArtistAlbums(mediaItemId: number | bigint, externalIds: Record<string, string>) {
  const result = await fetchArtistAlbumsFor(externalIds).catch(() => null);
  if (!result) return;
  const insertAlbum = db.prepare(
    `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  for (const album of result.albums) insertAlbum.run(mediaItemId, album.title, album.releaseDate, album.externalId ?? null, result.provider);
}

interface TraktListTarget {
  username: string;
  listSlug: string | null;
}

function parseTraktListUrl(url: string): TraktListTarget | null {
  const m = url.match(/trakt\.tv\/users\/([^/]+)\/(?:lists\/([^/?#]+)|watchlist)/);
  if (!m) return null;
  return { username: m[1], listSlug: m[2] ?? null };
}

async function syncTraktList(list: ImportListRow, qualityProfileId: number | null): Promise<number> {
  const clientId = getSetting("traktClientId");
  if (!clientId) throw new Error("Set a Trakt API client ID in Settings before using a Trakt import list");
  const target = parseTraktListUrl(list.url);
  if (!target) throw new Error("URL is not a recognized Trakt list/watchlist URL");

  const path = target.listSlug ? `lists/${target.listSlug}/items` : "watchlist";
  const res = await fetch(`https://api.trakt.tv/users/${target.username}/${path}`, {
    headers: { "trakt-api-version": "2", "trakt-api-key": clientId, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Trakt list request failed: HTTP ${res.status}`);
  const items = (await res.json()) as any[];

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
        ).run(
          m.title,
          m.title.toLowerCase(),
          m.year ?? null,
          JSON.stringify({ tmdb: String(tmdbId), trakt: String(m.ids?.trakt ?? "") }),
          qualityProfileId
        );
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
        await insertSeriesEpisodes(result.lastInsertRowid, externalIds);
        existingSeries.add(String(tmdbId));
        added++;
      }
    } catch (err) {
      log.warn(`[importLists] Trakt list "${list.name}" failed to add an item:`, (err as Error).message);
    }
  }

  return added;
}

/** IMDb's public per-list CSV export — works for any public list URL of the form
 * imdb.com/list/ls123456789/ without authentication. */
function parseImdbListId(url: string): string | null {
  const m = url.match(/imdb\.com\/list\/(ls\d+)/);
  return m ? m[1] : null;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    // Minimal CSV field split that respects double-quoted commas — IMDb's export doesn't nest quotes.
    const fields = line.match(/(".*?"|[^,]+)(?=,|$)/g) ?? [];
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (fields[i] ?? "").replace(/^"|"$/g, "");
    });
    return row;
  });
}

async function syncImdbList(list: ImportListRow, qualityProfileId: number | null): Promise<number> {
  const listId = parseImdbListId(list.url);
  if (!listId) throw new Error("URL is not a recognized IMDb list URL (expected imdb.com/list/ls.../)");

  const res = await fetch(`https://www.imdb.com/list/${listId}/export`);
  if (!res.ok) throw new Error(`IMDb list export failed: HTTP ${res.status}`);
  const rows = parseCsv(await res.text());

  let added = 0;
  for (const row of rows) {
    const title = row["Title"];
    const year = row["Year"] ? Number(row["Year"]) : null;
    const titleType = (row["Title Type"] ?? "").toLowerCase();
    if (!title) continue;
    const type = titleType.includes("series") || titleType.includes("show") ? "series" : "movie";

    try {
      if (findPossibleDuplicates(type as any, title, year).length > 0) continue;
      if (isExcluded(type, title, year, "", "")) continue;

      const query = year ? `${title} ${year}` : title;
      const results = await searchMetadata(type as any, query).catch(() => []);
      const best = results[0];
      if (!best) {
        queueForReview({ source: list.name, importListId: list.id, type, title, year });
        continue;
      }

      const insertResult = db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, quality_profile_id, monitored, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
        )
        .run(
          type,
          best.title,
          best.title.toLowerCase(),
          best.year,
          best.overview,
          best.posterUrl,
          JSON.stringify(best.externalIds),
          qualityProfileId
        );

      if (type === "series") await insertSeriesEpisodes(insertResult.lastInsertRowid, best.externalIds as any);
      added++;
    } catch (err) {
      log.warn(`[importLists] IMDb list "${list.name}" failed to add "${title}":`, (err as Error).message);
    }
  }

  return added;
}

/** Accepts either a full last.fm/user/<name> profile URL or a bare username. */
function parseLastfmUsername(url: string): string | null {
  const m = url.match(/last\.fm\/user\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  const trimmed = url.trim();
  return /^[\w-]+$/.test(trimmed) ? trimmed : null;
}

/** Imports a Last.fm user's all-time top artists as Music library entries — the closest thing
 * Last.fm has to a "playlist" to import from (it has no user-created playlist concept itself,
 * unlike Spotify/Apple Music, whose APIs require a paid developer account and OAuth per-user
 * consent this app has no way to broker). */
async function syncLastfmList(list: ImportListRow, qualityProfileId: number | null): Promise<number> {
  const key = getSetting("lastfmApiKey");
  if (!key) throw new Error("Set a Last.fm API key in Settings before using a Last.fm import list");
  const username = parseLastfmUsername(list.url);
  if (!username) throw new Error("URL is not a recognized Last.fm profile (expected last.fm/user/<name> or a bare username)");

  const apiUrl = new URL("https://ws.audioscrobbler.com/2.0/");
  apiUrl.searchParams.set("method", "user.gettopartists");
  apiUrl.searchParams.set("user", username);
  apiUrl.searchParams.set("api_key", key);
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("period", "overall");
  apiUrl.searchParams.set("limit", "50");

  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`Last.fm top artists request failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const raw = body?.topartists?.artist ?? [];
  const artists: any[] = Array.isArray(raw) ? raw : [raw];

  let added = 0;
  for (const a of artists) {
    const title = a?.name;
    if (!title) continue;
    try {
      if (findPossibleDuplicates("artist" as any, title, null).length > 0) continue;
      if (isExcluded("artist", title, null, a.mbid ?? "", "lastfm")) continue;

      const externalIds = { lastfm: a.mbid || title };
      const insertResult = db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, external_ids, quality_profile_id, monitored, status)
           VALUES ('artist', ?, ?, ?, ?, 1, 'missing')`
        )
        .run(title, title.toLowerCase(), JSON.stringify(externalIds), qualityProfileId);
      await insertArtistAlbums(insertResult.lastInsertRowid, externalIds);
      added++;
    } catch (err) {
      log.warn(`[importLists] Last.fm list "${list.name}" failed to add "${title}":`, (err as Error).message);
    }
  }

  return added;
}

export async function syncImportList(list: ImportListRow): Promise<{ added: number; error?: string }> {
  const qualityProfileId =
    list.quality_profile_id ??
    (db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ??
    null;

  try {
    const added =
      list.type === "trakt"
        ? await syncTraktList(list, qualityProfileId)
        : list.type === "lastfm"
          ? await syncLastfmList(list, qualityProfileId)
          : await syncImdbList(list, qualityProfileId);
    db.prepare(
      "UPDATE import_lists SET last_synced_at = datetime('now'), last_added_count = ?, last_error = NULL WHERE id = ?"
    ).run(added, list.id);
    return { added };
  } catch (err) {
    const message = (err as Error).message;
    db.prepare("UPDATE import_lists SET last_synced_at = datetime('now'), last_error = ? WHERE id = ?").run(
      message,
      list.id
    );
    return { added: 0, error: message };
  }
}

/** Runs every enabled import list, called on the same interval as the search scheduler. */
export async function runAllImportLists(signal?: AbortSignal): Promise<void> {
  const lists = db.prepare("SELECT * FROM import_lists WHERE enabled = 1").all() as ImportListRow[];
  for (const list of lists) {
    if (signal?.aborted) {
      log.info("[importLists] cancelled");
      return;
    }
    const result = await syncImportList(list);
    if (result.error) log.warn(`[importLists] "${list.name}" failed:`, result.error);
    else if (result.added > 0) log.info(`[importLists] "${list.name}" added ${result.added} item(s)`);
  }
}
