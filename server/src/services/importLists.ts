import { log } from "./logger.js";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { getSetting } from "./settingsStore.js";
import {
  fetchAlbumTracksFor,
  fetchArtistAlbumsFor,
  fetchSeriesEpisodesFor,
  isEpisodeMonitoredByDefault,
  searchMetadata,
  TMDB_IMAGE_BASE,
} from "./metadata.js";
import { isExcluded } from "./importExclusions.js";
import { findPossibleDuplicates } from "./duplicateCheck.js";
import { queueForReview } from "./importReview.js";
import { autoSelectRootFolderId } from "./rootFolderSelect.js";

export interface ImportListRow {
  id: number;
  name: string;
  require_review: number;
  type: "trakt" | "imdb" | "lastfm" | "tmdb";
  url: string;
  enabled: number;
  quality_profile_id: number | null;
  /** Per-list root folder, used for items of its own media type; otherwise the type's auto-selected one. */
  root_folder_id: number | null;
  last_synced_at: string | null;
  last_added_count: number | null;
  last_error: string | null;
  min_rating: number | null;
  min_votes: number | null;
  exclude_genres: string | null; // JSON array of lowercased genre names
  created_at: string;
}

/** The media types each type of list adds items of. */
export const IMPORT_LIST_MEDIA_TYPES: Record<ImportListRow["type"], string[]> = {
  trakt: ["movie", "series"],
  imdb: ["movie", "series"],
  tmdb: ["movie", "series"],
  lastfm: ["artist"],
};

/**
 * Import lists, the Trakt/Plex watchlist syncs and the Overseerr webhook all add a title by
 * checking "already in the library?" and then INSERTing, with network awaits in between, and the
 * scheduled ones share a default cron slot. media_items has no unique key on external ids, so the
 * final re-check and the INSERT run under this one in-process lock; otherwise two sources adding the
 * same new title both insert it. Never call it re-entrantly (fn must not take the lock itself).
 */
let libraryAddTail: Promise<unknown> = Promise.resolve();

export function withLibraryAddLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = libraryAddTail.then(() => fn());
  libraryAddTail = run.catch(() => undefined);
  return run;
}

/** Exact tmdb-id lookup (the LIKE only narrows the scan; the parsed JSON decides). */
export async function libraryHasTmdbId(type: string, tmdbId: string): Promise<boolean> {
  const rows = (await db
    .prepare("SELECT external_ids FROM media_items WHERE type = ? AND external_ids LIKE ?")
    .all(type, `%${tmdbId}%`)) as { external_ids: string | null }[];
  return rows.some((row) => {
    try {
      const parsed = JSON.parse(row.external_ids ?? "{}");
      return parsed?.tmdb != null && String(parsed.tmdb) === tmdbId;
    } catch {
      return false;
    }
  });
}

/** Runs `insert` only if no item of `type` has this tmdb id yet, atomically with respect to every
 * other caller of the library-add lock. Resolves to null when the title was already there. */
export function insertUnlessTmdbIdExists<T>(type: string, tmdbId: string, insert: () => Promise<T>): Promise<T | null> {
  return withLibraryAddLock(async () => ((await libraryHasTmdbId(type, tmdbId)) ? null : insert()));
}

/**
 * Chooses the root folder a synced item is created under: the list's own folder when it has one for
 * that media type, else the same auto-select the Add route uses. An item that would get no root
 * folder is not created at all, because the importer refuses such an item's finished download and
 * the queue row is never retried; the skips are counted so the sync can report why.
 */
export class RootFolderPicker {
  private readonly preferredId: number | null;
  private readonly resolved = new Map<string, number | null>();
  private readonly skipped = new Map<string, number>();

  constructor(preferredId: number | null = null) {
    this.preferredId = preferredId;
  }

  async pick(type: string): Promise<number | null> {
    if (!this.resolved.has(type)) this.resolved.set(type, await this.resolve(type));
    const id = this.resolved.get(type) ?? null;
    if (id == null) this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1);
    return id;
  }

  private async resolve(type: string): Promise<number | null> {
    if (this.preferredId != null) {
      const row = (await db.prepare("SELECT media_type FROM root_folders WHERE id = ?").get(this.preferredId)) as
        | { media_type: string }
        | undefined;
      if (row?.media_type === type) return this.preferredId;
    }
    return autoSelectRootFolderId(type);
  }

  /**
   * Null when nothing was skipped for lack of a root folder. Syncs report this as a `warning`, never
   * as their `error`, even when they added nothing: a list keeps holding titles of a media type the
   * install doesn't manage, so the same skip recurs on every run and would otherwise fail each
   * scheduled run that happens to find nothing else new.
   */
  skippedSummary(): string | null {
    if (this.skipped.size === 0) return null;
    const total = [...this.skipped.values()].reduce((sum, n) => sum + n, 0);
    return `${total} item(s) not added: no root folder is configured for ${[...this.skipped.keys()].join(", ")}`;
  }
}

/** Trakt sits behind Cloudflare, which answers Node fetch's default "node" User-Agent with an HTML
 * 403 block page before the request reaches the API. Same identity metadata.ts's Trakt calls use. */
const TRAKT_USER_AGENT = "AoNarr/0.1 (self-hosted media manager)";

export function traktListHeaders(clientId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    "User-Agent": TRAKT_USER_AGENT,
  };
}

interface ListSyncContext {
  qualityProfileId: number | null;
  rootFolders: RootFolderPicker;
}

/**
 * Radarr-style import-list filtering — a list still adds *everything* it has by default (unchanged
 * behavior), but a rating/vote-count/genre floor lets an admin curate what a broad list (a Trakt
 * "Popular" list, someone else's IMDb list) actually adds instead of importing all of it
 * unfiltered. `rating`/`votes` being unknown (not every source provides them, or a specific item
 * might lack one) never rejects on its own — the same "don't reject on missing data" default the
 * quality-profile size cap and custom-format size conditions already use — only a *known* value
 * that fails the threshold does. Genre names are compared case-insensitively.
 */
export function passesListFilters(
  list: Pick<ImportListRow, "min_rating" | "min_votes" | "exclude_genres">,
  entry: { rating?: number | null; votes?: number | null; genres?: string[] | null }
): boolean {
  if (list.min_rating != null && entry.rating != null && entry.rating < list.min_rating) return false;
  if (list.min_votes != null && entry.votes != null && entry.votes < list.min_votes) return false;
  if (list.exclude_genres && entry.genres && entry.genres.length > 0) {
    let excluded: string[];
    try {
      excluded = JSON.parse(list.exclude_genres);
    } catch {
      excluded = [];
    }
    if (excluded.length > 0) {
      const entryGenres = new Set(entry.genres.map((g) => g.toLowerCase()));
      if (excluded.some((g) => entryGenres.has(g))) return false;
    }
  }
  return true;
}

/** TMDB's genre id → name maps — stable, effectively-static reference data (TMDB's own genre list
 * changes on the order of once a year, if that), so this avoids an extra API call per list sync
 * just to resolve the numeric `genre_ids` a TMDB list item carries into names exclude_genres can
 * actually compare against. Movie and TV use different id spaces. */
const TMDB_MOVIE_GENRES: Record<number, string> = {
  28: "action", 12: "adventure", 16: "animation", 35: "comedy", 80: "crime", 99: "documentary",
  18: "drama", 10751: "family", 14: "fantasy", 36: "history", 27: "horror", 10402: "music",
  9648: "mystery", 10749: "romance", 878: "science fiction", 10770: "tv movie", 53: "thriller",
  10752: "war", 37: "western",
};
const TMDB_TV_GENRES: Record<number, string> = {
  10759: "action & adventure", 16: "animation", 35: "comedy", 80: "crime", 99: "documentary",
  18: "drama", 10751: "family", 10762: "kids", 9648: "mystery", 10763: "news", 10764: "reality",
  10765: "sci-fi & fantasy", 10766: "soap", 10767: "talk", 10768: "war & politics", 37: "western",
};

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

async function insertSeriesEpisodes(mediaItemId: number | bigint | null, externalIds: Record<string, string>) {
  const episodes = await fetchSeriesEpisodesFor(externalIds).catch(() => []);
  for (const ep of episodes) {
    await db
      .prepare(
        `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview, isEpisodeMonitoredByDefault(ep) ? 1 : 0);
  }
}

/**
 * Fetches and upserts an album's track listing (best-effort — a single album's track fetch
 * failing, e.g. an unsupported provider like Discogs/Last.fm, shouldn't block the rest of an
 * artist's albums from being added).
 */
export async function insertTracksForAlbum(
  subItemId: number | bigint,
  provider: string,
  externalId: string
): Promise<void> {
  try {
    // MusicBrainz asks clients to stay at ~1 request/second; fetchAlbumTracksFor issues 2 requests
    // per album, and this function is called back-to-back for every album an artist has, so without
    // this pause a multi-album artist add gets rate-limited (HTTP 503) partway through.
    if (provider === "musicbrainz") await new Promise((resolve) => setTimeout(resolve, 1100));
    const tracks = await fetchAlbumTracksFor(provider, externalId);
    await db.transaction(async () => {
      for (const t of tracks) {
        await db
          .prepare(
            `INSERT INTO tracks (sub_item_id, track_number, title, duration_seconds) VALUES (?, ?, ?, ?)
             ON CONFLICT(sub_item_id, track_number) DO UPDATE SET title = excluded.title`
          )
          .run(subItemId, t.trackNumber, t.title, t.durationSeconds);
      }
    });
  } catch (err) {
    log.warn(`[importLists] failed to fetch tracks for sub-item ${subItemId}:`, (err as Error).message);
  }
}

async function insertArtistAlbums(mediaItemId: number | bigint | null, externalIds: Record<string, string>) {
  const result = await fetchArtistAlbumsFor(externalIds).catch(() => null);
  if (!result) return;
  const insertedAlbumIds: { id: number | bigint; externalId: string }[] = [];
  for (const album of result.albums) {
    const insertResult = await db
      .prepare(
        `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored, poster_url)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(mediaItemId, album.title, album.releaseDate, album.externalId ?? null, result.provider, album.posterUrl ?? null);
    if (album.externalId && insertResult.lastInsertRowid != null) {
      insertedAlbumIds.push({ id: insertResult.lastInsertRowid, externalId: album.externalId });
    }
  }

  for (const { id, externalId } of insertedAlbumIds) {
    await insertTracksForAlbum(id, result.provider, externalId);
  }
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

async function syncTraktList(list: ImportListRow, ctx: ListSyncContext): Promise<number> {
  const clientId = getSetting("traktClientId");
  if (!clientId) throw new Error("Set a Trakt API client ID in Settings before using a Trakt import list");
  const target = parseTraktListUrl(list.url);
  if (!target) throw new Error("URL is not a recognized Trakt list/watchlist URL");

  // extended=full is what actually puts rating/votes/genres on each movie/show object — without
  // it Trakt's list endpoints only return the bare minimum (title/year/ids), which is enough for
  // adding but not enough for passesListFilters to have anything to check.
  const path = target.listSlug ? `lists/${target.listSlug}/items` : "watchlist";
  const res = await fetch(`https://api.trakt.tv/users/${target.username}/${path}?extended=full`, {
    headers: traktListHeaders(clientId),
  });
  if (!res.ok) throw new Error(`Trakt list request failed: HTTP ${res.status}`);
  const items = (await res.json()) as any[];

  const existingMovies = await existingTmdbIds("movie");
  const existingSeries = await existingTmdbIds("series");
  let added = 0;

  for (const entry of items) {
    try {
      if (entry.movie) {
        const m = entry.movie;
        const tmdbId = m.ids?.tmdb;
        if (!tmdbId || existingMovies.has(String(tmdbId))) continue;
        if (await isExcluded("movie", m.title, m.year ?? null, String(tmdbId), "tmdb")) continue;
        if (!passesListFilters(list, { rating: m.rating ?? null, votes: m.votes ?? null, genres: m.genres ?? null })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "movie", title: m.title, year: m.year ?? null });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("movie");
        if (rootFolderId == null) continue;
        const inserted = await insertUnlessTmdbIdExists("movie", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(
              m.title,
              m.title.toLowerCase(),
              m.year ?? null,
              m.overview ?? null,
              JSON.stringify({ tmdb: String(tmdbId), trakt: String(m.ids?.trakt ?? "") }),
              rootFolderId,
              ctx.qualityProfileId
            )
        );
        existingMovies.add(String(tmdbId));
        if (inserted) added++;
      } else if (entry.show) {
        const s = entry.show;
        const tmdbId = s.ids?.tmdb;
        if (!tmdbId || existingSeries.has(String(tmdbId))) continue;
        if (await isExcluded("series", s.title, s.year ?? null, String(tmdbId), "tmdb")) continue;
        if (!passesListFilters(list, { rating: s.rating ?? null, votes: s.votes ?? null, genres: s.genres ?? null })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "series", title: s.title, year: s.year ?? null });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("series");
        if (rootFolderId == null) continue;
        const externalIds = { tmdb: String(tmdbId), trakt: String(s.ids?.trakt ?? "") };
        const result = await insertUnlessTmdbIdExists("series", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('series', ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(s.title, s.title.toLowerCase(), s.year ?? null, s.overview ?? null, JSON.stringify(externalIds), rootFolderId, ctx.qualityProfileId)
        );
        existingSeries.add(String(tmdbId));
        if (!result) continue;
        await insertSeriesEpisodes(result.lastInsertRowid, externalIds);
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
    const fields = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = fields[i] ?? "";
    });
    return row;
  });
}

/** Positional CSV split that keeps empty fields (`a,,c` → ["a", "", "c"]) and honors quoted
 * commas/doubled quotes — a regex match that skipped empty fields shifted every IMDb column left
 * of the routinely-blank Description column, putting the year where the title should be. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** isExcluded for every provider id a metadata hit carries (an exclusion made on delete is keyed on
 * whichever id the deleted row listed first), plus the title/year fallback. */
async function isExcludedByAnyId(type: string, title: string, year: number | null, externalIds: Record<string, string>): Promise<boolean> {
  const ids = Object.entries(externalIds ?? {}).filter(([, id]) => id);
  if (ids.length === 0) return isExcluded(type, title, year);
  for (const [provider, id] of ids) {
    if (await isExcluded(type, title, year, String(id), provider)) return true;
  }
  return false;
}

async function syncImdbList(list: ImportListRow, ctx: ListSyncContext): Promise<number> {
  const listId = parseImdbListId(list.url);
  if (!listId) throw new Error("URL is not a recognized IMDb list URL (expected imdb.com/list/ls.../)");

  const res = await fetch(`https://www.imdb.com/list/${listId}/export`);
  if (!res.ok) throw new Error(`IMDb list export failed: HTTP ${res.status}`);
  // IMDb's bot protection answers server-side requests with 202 and an empty challenge body. That
  // counts as ok to fetch, and parsing it would record a clean "0 added" sync on every run instead
  // of telling the admin the list was never read.
  if (res.status !== 200 || res.headers.get("x-amzn-waf-action")) {
    throw new Error(`IMDb refused the list export (HTTP ${res.status}, bot challenge); IMDb currently blocks server-side list exports`);
  }
  const text = await res.text();
  const headerLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  if (!splitCsvLine(headerLine).includes("Title")) {
    throw new Error("IMDb list export did not return a CSV (no Title column); IMDb may be blocking server-side list exports");
  }
  const rows = parseCsv(text);

  let added = 0;
  for (const row of rows) {
    const title = row["Title"];
    const year = row["Year"] ? Number(row["Year"]) : null;
    const titleType = (row["Title Type"] ?? "").toLowerCase();
    if (!title) continue;
    const type = titleType.includes("series") || titleType.includes("show") ? "series" : "movie";

    try {
      if ((await findPossibleDuplicates(type as any, title, year)).length > 0) continue;
      if (await isExcluded(type, title, year, "", "")) continue;
      const rating = row["IMDb Rating"] ? Number(row["IMDb Rating"]) : null;
      const votes = row["Num Votes"] ? Number(row["Num Votes"].replace(/,/g, "")) : null;
      const genres = row["Genres"] ? row["Genres"].split(",").map((g) => g.trim()) : null;
      if (!passesListFilters(list, { rating, votes, genres })) continue;

      const query = year ? `${title} ${year}` : title;
      const results = await searchMetadata(type as any, query).catch(() => []);
      const best = results[0];
      if (!best) {
        await queueForReview({ source: list.name, importListId: list.id, type, title, year });
        continue;
      }
      // The row is stored under the provider's title/year/ids, not IMDb's, so that is what the next
      // sync has to find; checking only the CSV's spelling re-adds the title on every sync whenever
      // the two differ ("Dune: Part One" vs "Dune", or a festival-vs-release year).
      const bestYear = best.year ?? null;
      const bestIds = best.externalIds ?? {};
      if ((await findPossibleDuplicates(type, best.title, bestYear, bestIds)).length > 0) continue;
      if (await isExcludedByAnyId(type, best.title, bestYear, bestIds)) continue;
      if (list.require_review) {
        await queueForReview({ source: list.name, importListId: list.id, type, title: best.title, year: best.year });
        continue;
      }

      const rootFolderId = await ctx.rootFolders.pick(type);
      if (rootFolderId == null) continue;
      const insertResult = await withLibraryAddLock(async () => {
        if ((await findPossibleDuplicates(type, best.title, bestYear, bestIds)).length > 0) return null;
        return db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(
            type,
            best.title,
            best.title.toLowerCase(),
            best.year,
            best.overview,
            best.posterUrl,
            JSON.stringify(bestIds),
            rootFolderId,
            ctx.qualityProfileId
          );
      });
      if (!insertResult) continue;

      if (type === "series") await insertSeriesEpisodes(insertResult.lastInsertRowid, bestIds);
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
async function syncLastfmList(list: ImportListRow, ctx: ListSyncContext): Promise<number> {
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
      if ((await findPossibleDuplicates("artist" as any, title, null)).length > 0) continue;
      if (await isExcluded("artist", title, null, a.mbid ?? "", "lastfm")) continue;
      if (list.require_review) {
        await queueForReview({ source: list.name, importListId: list.id, type: "artist", title, year: null });
        continue;
      }

      const rootFolderId = await ctx.rootFolders.pick("artist");
      if (rootFolderId == null) continue;
      const externalIds = { lastfm: a.mbid || title };
      const insertResult = await withLibraryAddLock(async () => {
        if ((await findPossibleDuplicates("artist", title, null, externalIds)).length > 0) return null;
        return db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, external_ids, root_folder_id, quality_profile_id, monitored, status)
             VALUES ('artist', ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(title, title.toLowerCase(), JSON.stringify(externalIds), rootFolderId, ctx.qualityProfileId);
      });
      if (!insertResult) continue;
      await insertArtistAlbums(insertResult.lastInsertRowid, externalIds);
      added++;
    } catch (err) {
      log.warn(`[importLists] Last.fm list "${list.name}" failed to add "${title}":`, (err as Error).message);
    }
  }

  return added;
}

/** Accepts a full themoviedb.org list URL or a bare numeric TMDB list id. */
function parseTmdbListId(url: string): string | null {
  const m = url.match(/themoviedb\.org\/list\/(\d+)/);
  if (m) return m[1];
  const trimmed = url.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * TMDB's own public/private list feature (themoviedb.org/list/<id>) — distinct from a Trakt list,
 * which most admins already use, but a real gap for anyone who curates lists on TMDB itself and
 * doesn't want a second service just to auto-add from them. A TMDB list can mix movies and TV
 * shows; each entry's own `media_type` field says which, and both branches skip entries already in
 * the library the same way syncTraktList does (by TMDB id, not title, to avoid false-duplicate
 * misses).
 */
/** TMDB's v3 list endpoint returns `items` 20 per page; the cap only guards against a response
 * that never signals its last page. */
const TMDB_LIST_MAX_PAGES = 500;

async function fetchTmdbListItems(listId: string, apiKey: string): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; page <= TMDB_LIST_MAX_PAGES; page++) {
    const res = await fetch(`https://api.themoviedb.org/3/list/${listId}?api_key=${apiKey}&page=${page}`);
    if (!res.ok) throw new Error(`TMDB list request failed: HTTP ${res.status}`);
    const body: any = await res.json();
    const pageItems: any[] = Array.isArray(body?.items) ? body.items : [];
    items.push(...pageItems);
    if (pageItems.length === 0) break;
    const totalPages = Number(body?.total_pages);
    const itemCount = Number(body?.item_count);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      if (page >= totalPages) break;
    } else if (!(Number.isFinite(itemCount) && items.length < itemCount)) {
      break;
    }
  }
  return items;
}

async function syncTmdbList(list: ImportListRow, ctx: ListSyncContext): Promise<number> {
  const apiKey = getSetting("tmdbApiKey");
  if (!apiKey) throw new Error("Set a TMDB API key in Settings before using a TMDB import list");
  const listId = parseTmdbListId(list.url);
  if (!listId) throw new Error("URL is not a recognized TMDB list URL (expected themoviedb.org/list/<id> or a bare numeric id)");

  const items = await fetchTmdbListItems(listId, apiKey);

  const existingMovies = await existingTmdbIds("movie");
  const existingSeries = await existingTmdbIds("series");
  let added = 0;

  for (const entry of items) {
    try {
      const isTv = entry.media_type === "tv" || (!entry.media_type && entry.first_air_date);
      const tmdbId = entry.id;
      if (!tmdbId) continue;

      if (isTv) {
        if (existingSeries.has(String(tmdbId))) continue;
        const title = entry.name ?? entry.title;
        const year = entry.first_air_date ? Number(String(entry.first_air_date).slice(0, 4)) : null;
        if (!title) continue;
        if (await isExcluded("series", title, year, String(tmdbId), "tmdb")) continue;
        const tvGenres = Array.isArray(entry.genre_ids) ? entry.genre_ids.map((id: number) => TMDB_TV_GENRES[id]).filter(Boolean) : null;
        if (!passesListFilters(list, { rating: entry.vote_average ?? null, votes: entry.vote_count ?? null, genres: tvGenres })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "series", title, year });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("series");
        if (rootFolderId == null) continue;
        const externalIds = { tmdb: String(tmdbId) };
        const posterUrl = entry.poster_path ? `${TMDB_IMAGE_BASE}${entry.poster_path}` : null;
        const result = await insertUnlessTmdbIdExists("series", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('series', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(title, title.toLowerCase(), year, entry.overview ?? null, posterUrl, JSON.stringify(externalIds), rootFolderId, ctx.qualityProfileId)
        );
        existingSeries.add(String(tmdbId));
        if (!result) continue;
        await insertSeriesEpisodes(result.lastInsertRowid, externalIds);
        added++;
      } else {
        if (existingMovies.has(String(tmdbId))) continue;
        const title = entry.title ?? entry.name;
        const year = entry.release_date ? Number(String(entry.release_date).slice(0, 4)) : null;
        if (!title) continue;
        if (await isExcluded("movie", title, year, String(tmdbId), "tmdb")) continue;
        const movieGenres = Array.isArray(entry.genre_ids) ? entry.genre_ids.map((id: number) => TMDB_MOVIE_GENRES[id]).filter(Boolean) : null;
        if (!passesListFilters(list, { rating: entry.vote_average ?? null, votes: entry.vote_count ?? null, genres: movieGenres })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "movie", title, year });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("movie");
        if (rootFolderId == null) continue;
        const inserted = await insertUnlessTmdbIdExists("movie", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(
              title,
              title.toLowerCase(),
              year,
              entry.overview ?? null,
              entry.poster_path ? `${TMDB_IMAGE_BASE}${entry.poster_path}` : null,
              JSON.stringify({ tmdb: String(tmdbId) }),
              rootFolderId,
              ctx.qualityProfileId
            )
        );
        existingMovies.add(String(tmdbId));
        if (inserted) added++;
      }
    } catch (err) {
      log.warn(`[importLists] TMDB list "${list.name}" failed to add an item:`, (err as Error).message);
    }
  }

  return added;
}

/** `error`: the sync failed. `warning`: it added `added` items but skipped others. Either is also
 * stored in last_error, the list's only status column (a warning with the added count in front,
 * since the list shows last_error in place of that count). */
export async function syncImportList(list: ImportListRow): Promise<{ added: number; error?: string; warning?: string }> {
  const qualityProfileId =
    list.quality_profile_id ??
    ((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined)?.id ??
    null;
  const ctx: ListSyncContext = { qualityProfileId, rootFolders: new RootFolderPicker(list.root_folder_id ?? null) };

  try {
    const added =
      list.type === "trakt"
        ? await syncTraktList(list, ctx)
        : list.type === "lastfm"
          ? await syncLastfmList(list, ctx)
          : list.type === "tmdb"
            ? await syncTmdbList(list, ctx)
            : await syncImdbList(list, ctx);
    const warning = ctx.rootFolders.skippedSummary();
    await db
      .prepare(`UPDATE import_lists SET last_synced_at = ${nowExpr(db)}, last_added_count = ?, last_error = ? WHERE id = ?`)
      .run(added, warning ? `Added ${added}; ${warning}` : null, list.id);
    return warning ? { added, warning } : { added };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .prepare(`UPDATE import_lists SET last_synced_at = ${nowExpr(db)}, last_error = ? WHERE id = ?`)
      .run(message, list.id);
    return { added: 0, error: message };
  }
}

/** Runs every enabled import list, called on the same interval as the search scheduler. */
export async function runAllImportLists(signal?: AbortSignal): Promise<void> {
  const lists = (await db.prepare("SELECT * FROM import_lists WHERE enabled = 1").all()) as ImportListRow[];
  for (const list of lists) {
    if (signal?.aborted) {
      log.info("[importLists] cancelled");
      return;
    }
    const result = await syncImportList(list);
    if (result.error) log.warn(`[importLists] "${list.name}" failed:`, result.error);
    else if (result.warning) log.warn(`[importLists] "${list.name}" added ${result.added} item(s); ${result.warning}`);
    else if (result.added > 0) log.info(`[importLists] "${list.name}" added ${result.added} item(s)`);
  }
}
