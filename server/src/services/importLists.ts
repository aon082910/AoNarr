import { log } from "./logger.js";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { getSetting } from "./settingsStore.js";
import {
  fetchAlbumTracksFor,
  fetchArtistAlbumsFor,
  fetchImdbIdFor,
  fetchSeriesEpisodesFor,
  searchMetadata,
  TMDB_IMAGE_BASE,
} from "./metadata.js";
import { insertNewSeriesEpisodes } from "./seriesAdd.js";
import { isExcluded } from "./importExclusions.js";
import { findPossibleDuplicates } from "./duplicateCheck.js";
import { queueForReview } from "./importReview.js";
import { verifyProviderHit } from "./titleMatch.js";
import { autoSelectRootFolderId } from "./rootFolderSelect.js";
import { finishWantedAdd } from "./addDefaults.js";
import { addTagsToItem, parseTagIds } from "./tagScope.js";
import { resolveAddMonitorMode, resolveAddQualityProfileId } from "./rootFolderDefaults.js";
import { applyEpisodeMonitorMode, applySubItemMonitorMode } from "./monitorModes.js";
import { resolveMetadataProfile } from "./metadataProfiles.js";
import { queueSearchAfterAdd } from "./searchOnAdd.js";

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
  /** What the list monitors of what it adds: all, none, or a mode for a series' episodes or an artist's albums. */
  monitor: string;
  /** "Monitor New Items" the added titles start with (all, none, new); null leaves the title's own default. */
  monitor_new_items: string | null;
  /** 1: a search for the title starts as soon as the list adds it. */
  search_on_add: number;
  /** Overrides the instance default for the titles it adds; null uses the default. */
  minimum_availability: string | null;
  /** What happens to a title the list added once it is no longer on the list (see LIST_CLEAN_LEVELS). */
  clean_level: string;
  /** JSON list of tag ids given to every title the list adds. */
  tag_ids: string | null;
  created_at: string;
}

/** Radarr's and Sonarr's "List Sync Level". */
export const LIST_CLEAN_LEVELS = ["disabled", "logOnly", "keepAndUnmonitor", "removeAndKeep", "removeAndDelete"] as const;

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
/** The id of the item of `type` that has this tmdb id, or null. */
export async function findLibraryItemIdByTmdbId(type: string, tmdbId: string): Promise<number | null> {
  const rows = (await db
    .prepare("SELECT id, external_ids FROM media_items WHERE type = ? AND external_ids LIKE ? ORDER BY id")
    .all(type, `%${tmdbId}%`)) as { id: number; external_ids: string | null }[];
  const match = rows.find((row) => {
    try {
      const parsed = JSON.parse(row.external_ids ?? "{}");
      return parsed?.tmdb != null && String(parsed.tmdb) === tmdbId;
    } catch {
      return false;
    }
  });
  return match ? Number(match.id) : null;
}

export async function libraryHasTmdbId(type: string, tmdbId: string): Promise<boolean> {
  return (await findLibraryItemIdByTmdbId(type, tmdbId)) != null;
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
  /** The list's own quality profile, or null to take the root folder's default per item. */
  qualityProfileId: number | null;
  rootFolders: RootFolderPicker;
  /** Every title the list currently holds, keyed like itemListKeys(), whether or not it was added. */
  seen: Set<string>;
}

/** The keys under which an entry of a list is recognised: `<type>:tmdb:<id>`, `<type>:imdb:<id>`, `artist:name:<name>`. */
export function itemListKeys(item: { type: string; title: string; external_ids: string | null }): string[] {
  const keys: string[] = [];
  try {
    const ids = JSON.parse(item.external_ids ?? "{}") ?? {};
    if (ids.tmdb) keys.push(`${item.type}:tmdb:${ids.tmdb}`);
    if (ids.imdb) keys.push(`${item.type}:imdb:${ids.imdb}`);
  } catch {
    // an unreadable id list gives no id keys
  }
  if (item.type === "artist") keys.push(`artist:name:${item.title.toLowerCase()}`);
  return keys;
}

/**
 * Finishes the add of a title a list just inserted: the list's own choices go onto the row first (its
 * source, minimum availability, monitor_new_items, tags, and whether it is monitored at all), then the
 * common add defaults run, which read the minimum availability to decide about release dates.
 */
async function finishListAdd(list: ImportListRow, itemId: number | bigint | null, source: { releaseDate?: string | null } = {}): Promise<void> {
  if (itemId == null) return;
  // The list's Monitor choice, else the root folder's default (a list that names none leaves it to the folder).
  const mode = await listMonitorMode(list, itemId);
  await db
    .prepare(
      "UPDATE media_items SET source_list_id = ?, monitor_new_items = COALESCE(?, monitor_new_items), minimum_availability = COALESCE(?, minimum_availability), monitored = ? WHERE id = ?"
    )
    .run(list.id, list.monitor_new_items ?? null, list.minimum_availability ?? null, mode === "none" ? 0 : 1, Number(itemId));
  await addTagsToItem(itemId, parseTagIds(list.tag_ids));
  await finishWantedAdd(itemId, source);
}

/** The Monitor choice an item a list just added starts with: the list's own, else its root folder's default, else all. */
async function listMonitorMode(list: ImportListRow, itemId: number | bigint): Promise<string> {
  if (list.monitor && list.monitor !== "all") return list.monitor;
  const row = (await db.prepare("SELECT type, root_folder_id FROM media_items WHERE id = ?").get(Number(itemId))) as { type: string; root_folder_id: number | null } | undefined;
  if (!row) return "all";
  return resolveAddMonitorMode(null, row.root_folder_id, row.type);
}

/** What happens once a list has put in a title's episodes or albums: the list's monitor choice, then its search on add. */
async function afterListChildren(list: ImportListRow, itemId: number | bigint | null, type: string): Promise<void> {
  if (itemId == null) return;
  try {
    const mode = await listMonitorMode(list, itemId);
    if (mode !== "all") {
      if (type === "series") await applyEpisodeMonitorMode(itemId, mode);
      else if (type === "artist") await applySubItemMonitorMode(itemId, mode);
    }
    if (Number(list.search_on_add) && mode !== "none") queueSearchAfterAdd(itemId);
  } catch (err) {
    log.warn(`[importLists] list "${list.name}": could not finish the add of item ${itemId}:`, (err as Error).message);
  }
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
  if (mediaItemId == null) return;
  const episodes = await fetchSeriesEpisodesFor(externalIds).catch(() => []);
  await insertNewSeriesEpisodes(mediaItemId, episodes);
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
  const itemRow = mediaItemId == null ? null : ((await db.prepare("SELECT metadata_profile_id, root_folder_id FROM media_items WHERE id = ?").get(Number(mediaItemId))) as any);
  const profile = itemRow ? await resolveMetadataProfile(itemRow) : null;
  const result = await fetchArtistAlbumsFor(externalIds, profile).catch(() => null);
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
        if (tmdbId) ctx.seen.add(`movie:tmdb:${tmdbId}`);
        if (!tmdbId || existingMovies.has(String(tmdbId))) continue;
        if (await isExcluded("movie", m.title, m.year ?? null, String(tmdbId), "tmdb")) continue;
        if (!passesListFilters(list, { rating: m.rating ?? null, votes: m.votes ?? null, genres: m.genres ?? null })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "movie", title: m.title, year: m.year ?? null });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("movie");
        if (rootFolderId == null) continue;
        const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
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
              profileId
            )
        );
        existingMovies.add(String(tmdbId));
        if (inserted) {
          await finishListAdd(list, inserted.lastInsertRowid, { releaseDate: m.released ?? null });
          await afterListChildren(list, inserted.lastInsertRowid, "movie");
          added++;
        }
      } else if (entry.show) {
        const s = entry.show;
        const tmdbId = s.ids?.tmdb;
        if (tmdbId) ctx.seen.add(`series:tmdb:${tmdbId}`);
        if (!tmdbId || existingSeries.has(String(tmdbId))) continue;
        if (await isExcluded("series", s.title, s.year ?? null, String(tmdbId), "tmdb")) continue;
        if (!passesListFilters(list, { rating: s.rating ?? null, votes: s.votes ?? null, genres: s.genres ?? null })) continue;
        if (list.require_review) {
          await queueForReview({ source: list.name, importListId: list.id, type: "series", title: s.title, year: s.year ?? null });
          continue;
        }
        const rootFolderId = await ctx.rootFolders.pick("series");
        if (rootFolderId == null) continue;
        const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
        const externalIds = { tmdb: String(tmdbId), trakt: String(s.ids?.trakt ?? "") };
        const result = await insertUnlessTmdbIdExists("series", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('series', ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(s.title, s.title.toLowerCase(), s.year ?? null, s.overview ?? null, JSON.stringify(externalIds), rootFolderId, profileId)
        );
        existingSeries.add(String(tmdbId));
        if (!result) continue;
        await finishListAdd(list, result.lastInsertRowid);
        await insertSeriesEpisodes(result.lastInsertRowid, externalIds);
        await afterListChildren(list, result.lastInsertRowid, "series");
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
    if (row["Const"]) ctx.seen.add(`${type}:imdb:${row["Const"]}`);

    try {
      if ((await findPossibleDuplicates(type as any, title, year)).length > 0) continue;
      if (await isExcluded(type, title, year, "", "")) continue;
      const rating = row["IMDb Rating"] ? Number(row["IMDb Rating"]) : null;
      const votes = row["Num Votes"] ? Number(row["Num Votes"].replace(/,/g, "")) : null;
      const genres = row["Genres"] ? row["Genres"].split(",").map((g) => g.trim()) : null;
      if (!passesListFilters(list, { rating, votes, genres })) continue;

      const query = year ? `${title} ${year}` : title;
      const results = await searchMetadata(type as any, query, undefined, year).catch(() => []);
      // Only a hit the title (and year) verify is added; the first result of a title search is
      // often another film, and two same-titled ones with no year to tell them apart are not
      // for this code to choose between.
      const verdict = verifyProviderHit(results, title, year, { topHitWhenYearAgrees: true });
      if (!("hit" in verdict)) {
        await queueForReview({ source: list.name, importListId: list.id, type, title, year });
        continue;
      }
      const best = verdict.hit;
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
      const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
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
            // The list's own id for the title is kept too, so a later sync (and the clean-up) recognises it.
            JSON.stringify(row["Const"] && !bestIds.imdb ? { ...bestIds, imdb: row["Const"] } : bestIds),
            rootFolderId,
            profileId
          );
      });
      if (!insertResult) continue;

      await finishListAdd(list, insertResult.lastInsertRowid, { releaseDate: best.releaseDate ?? null });
      if (type === "series") await insertSeriesEpisodes(insertResult.lastInsertRowid, bestIds);
      await afterListChildren(list, insertResult.lastInsertRowid, type);
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
    ctx.seen.add(`artist:name:${String(title).toLowerCase()}`);
    try {
      if ((await findPossibleDuplicates("artist" as any, title, null)).length > 0) continue;
      if (await isExcluded("artist", title, null, a.mbid ?? "", "lastfm")) continue;
      if (list.require_review) {
        await queueForReview({ source: list.name, importListId: list.id, type: "artist", title, year: null });
        continue;
      }

      const rootFolderId = await ctx.rootFolders.pick("artist");
      if (rootFolderId == null) continue;
      const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
      const externalIds = { lastfm: a.mbid || title };
      const insertResult = await withLibraryAddLock(async () => {
        if ((await findPossibleDuplicates("artist", title, null, externalIds)).length > 0) return null;
        return db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, external_ids, root_folder_id, quality_profile_id, monitored, status)
             VALUES ('artist', ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(title, title.toLowerCase(), JSON.stringify(externalIds), rootFolderId, profileId);
      });
      if (!insertResult) continue;
      await finishListAdd(list, insertResult.lastInsertRowid);
      await insertArtistAlbums(insertResult.lastInsertRowid, externalIds);
      await afterListChildren(list, insertResult.lastInsertRowid, "artist");
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
      ctx.seen.add(`${isTv ? "series" : "movie"}:tmdb:${tmdbId}`);

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
        const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
        const externalIds = { tmdb: String(tmdbId) };
        const posterUrl = entry.poster_path ? `${TMDB_IMAGE_BASE}${entry.poster_path}` : null;
        const result = await insertUnlessTmdbIdExists("series", String(tmdbId), () =>
          db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
               VALUES ('series', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
            )
            .run(title, title.toLowerCase(), year, entry.overview ?? null, posterUrl, JSON.stringify(externalIds), rootFolderId, profileId)
        );
        existingSeries.add(String(tmdbId));
        if (!result) continue;
        await finishListAdd(list, result.lastInsertRowid);
        await insertSeriesEpisodes(result.lastInsertRowid, externalIds);
        await afterListChildren(list, result.lastInsertRowid, "series");
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
        const profileId = await resolveAddQualityProfileId(ctx.qualityProfileId, rootFolderId);
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
              profileId
            )
        );
        existingMovies.add(String(tmdbId));
        if (inserted) {
          await finishListAdd(list, inserted.lastInsertRowid, { releaseDate: entry.release_date ?? null });
          await afterListChildren(list, inserted.lastInsertRowid, "movie");
          added++;
        }
      }
    } catch (err) {
      log.warn(`[importLists] TMDB list "${list.name}" failed to add an item:`, (err as Error).message);
    }
  }

  return added;
}

/** Replaces what a list is recorded as holding. */
async function recordListEntries(listId: number, seen: Set<string>): Promise<void> {
  await db.transaction(async () => {
    await db.prepare("DELETE FROM import_list_entries WHERE list_id = ?").run(listId);
    for (const key of seen) await db.prepare("INSERT INTO import_list_entries (list_id, entry_key) VALUES (?, ?) ON CONFLICT DO NOTHING").run(listId, key);
  });
}

/** How many titles one clean-up looks an IMDb id up for; the rest are asked on the next sync. */
const IMDB_LOOKUPS_PER_CLEAN = 100;

/**
 * An IMDb list can only judge a title that carries an IMDb id, and one added with a TMDB or TVDB id alone (by an
 * older sync, or by a list of another kind) was never judged. For those, the id is asked of the providers that list
 * external ids and stored on the title, so the next clean-up needs no lookup. A title no provider answers for is
 * left as it is, never treated as gone. Mutates `items` so the caller sees the ids.
 */
async function addMissingImdbIds(items: { id: number; type: string; external_ids: string | null }[], seenKinds: Set<string>): Promise<void> {
  let lookups = 0;
  for (const item of items) {
    if (!seenKinds.has(`${item.type}:imdb`)) continue;
    let ids: Record<string, string>;
    try {
      ids = JSON.parse(item.external_ids ?? "{}") ?? {};
    } catch {
      continue;
    }
    if (ids.imdb || (!ids.tmdb && !ids.tvdb)) continue;
    if (lookups >= IMDB_LOOKUPS_PER_CLEAN) break;
    lookups++;
    const imdb = await fetchImdbIdFor(item.type as any, ids).catch(() => null);
    if (!imdb) continue;
    const merged = JSON.stringify({ ...ids, imdb });
    await db.prepare("UPDATE media_items SET external_ids = ? WHERE id = ?").run(merged, item.id);
    item.external_ids = merged;
  }
}

/** A clean-up that would take more than this share of the titles a list added is refused: more likely the list came back short than that it changed that much. */
const CLEAN_REFUSE_SHARE = 0.5;
const CLEAN_REFUSE_MIN_COUNT = 10;

/**
 * Sonarr's and Radarr's "List Sync Level": what happens to a title this list added once the list no
 * longer holds it. Only the list that added a title cleans it, and a protected title is never touched.
 * An entry is recognised by its tmdb or imdb id (or, for an artist, its name); a title the list added
 * under neither is left alone. Returns how many titles were acted on.
 */
export async function cleanListItems(list: ImportListRow, seen: Set<string>, onWarning: (message: string) => void = () => undefined): Promise<number> {
  const refuse = (message: string): 0 => {
    log.warn(`[importLists] list "${list.name}": ${message}`);
    onWarning(message);
    return 0;
  };
  // A Last.fm list is the top 50 of a ranking: an artist slipping to number 51 has not left anyone's library.
  if (list.type === "lastfm" && (list.clean_level === "removeAndKeep" || list.clean_level === "removeAndDelete")) {
    return refuse("a Last.fm list is a ranking, so it can only log or unmonitor, never remove");
  }
  const items = (await db
    .prepare("SELECT id, type, title, external_ids, monitored, protected, path FROM media_items WHERE source_list_id = ?")
    .all(list.id)) as { id: number; type: string; title: string; external_ids: string | null; monitored: number; protected: number }[];

  // An item is judged only by keys of a kind this sync produced: a sync that listed IMDb ids cannot say anything about a title kept under its TMDB id.
  const kindOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
  const seenKinds = new Set([...seen].map(kindOf));
  await addMissingImdbIds(items, seenKinds);
  // A title another enabled list still holds stays, whichever list added it.
  const others = (await db
    .prepare("SELECT l.id AS id, l.type AS type, e.entry_key AS entry_key FROM import_lists l LEFT JOIN import_list_entries e ON e.list_id = l.id WHERE l.enabled = 1 AND l.id <> ?")
    .all(list.id)) as { id: number; type: ImportListRow["type"]; entry_key: string | null }[];
  const heldElsewhere = new Set(others.filter((o) => o.entry_key).map((o) => o.entry_key as string));
  const listsWithEntries = new Set(others.filter((o) => o.entry_key).map((o) => Number(o.id)));
  const itemTypes = new Set(items.map((i) => i.type));
  // A list that has not recorded what it holds yet (never synced since this existed) could be holding any of these titles.
  const unknown = others.filter((o) => !listsWithEntries.has(Number(o.id)) && IMPORT_LIST_MEDIA_TYPES[o.type]?.some((t) => itemTypes.has(t)));
  if (unknown.length > 0 && list.clean_level !== "logOnly") {
    return refuse("waiting for the other enabled lists to sync once, so a title one of them holds is not removed");
  }

  const gone = items.filter((item) => {
    if (Number(item.protected)) return false;
    const keys = itemListKeys(item);
    const comparable = keys.filter((k) => seenKinds.has(kindOf(k)));
    return comparable.length > 0 && !comparable.some((k) => seen.has(k)) && !keys.some((k) => heldElsewhere.has(k));
  });
  if (gone.length === 0) return 0;
  if (list.clean_level !== "logOnly") {
    // The list came back much shorter than last time: more likely a short answer than that many titles left.
    const previous = Number(((await db.prepare("SELECT COUNT(*) AS c FROM import_list_entries WHERE list_id = ?").get(list.id)) as { c: number | string }).c);
    if (previous >= 4 && seen.size < previous * CLEAN_REFUSE_SHARE) {
      return refuse(`it came back with ${seen.size} entries after ${previous} last time; nothing was cleaned (did the list come back short?)`);
    }
    if (gone.length > CLEAN_REFUSE_MIN_COUNT && gone.length > items.length * CLEAN_REFUSE_SHARE) {
      return refuse(`${gone.length} of its ${items.length} titles are no longer on it; refusing to clean that many at once (did the list come back short?)`);
    }
  }

  let acted = 0;
  for (const item of gone) {
    try {
      if (list.clean_level === "logOnly") {
        log.info(`[importLists] list "${list.name}": "${item.title}" is no longer on the list (clean level: log only)`);
      } else if (list.clean_level === "keepAndUnmonitor") {
        if (!Number(item.monitored)) continue;
        await db.prepare("UPDATE media_items SET monitored = 0 WHERE id = ?").run(item.id);
        log.info(`[importLists] list "${list.name}": "${item.title}" is no longer on the list; unmonitored`);
      } else if (list.clean_level === "removeAndKeep" || list.clean_level === "removeAndDelete") {
        // Loaded here: the router pulls in most of the server, and this module is imported by it.
        const { deleteMediaItemCascade } = await import("../routes/media.js");
        const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(item.id);
        if (!row) continue;
        await deleteMediaItemCascade(row, list.clean_level === "removeAndDelete");
        log.info(`[importLists] list "${list.name}": "${item.title}" is no longer on the list; removed${list.clean_level === "removeAndDelete" ? " with its files" : ""}`);
      }
      acted++;
    } catch (err) {
      log.warn(`[importLists] list "${list.name}": could not clean "${item.title}":`, (err as Error).message);
    }
  }
  return acted;
}

/** `error`: the sync failed. `warning`: it added `added` items but skipped others. Either is also
 * stored in last_error, the list's only status column (a warning with the added count in front,
 * since the list shows last_error in place of that count). */
export async function syncImportList(list: ImportListRow): Promise<{ added: number; error?: string; warning?: string }> {
  // The list's own profile, when it names one. Without it each add takes its root folder's default
  // profile, else the first profile (resolveAddQualityProfileId, once the item's folder is known).
  const qualityProfileId = list.quality_profile_id ?? null;
  const ctx: ListSyncContext = { qualityProfileId, rootFolders: new RootFolderPicker(list.root_folder_id ?? null), seen: new Set() };

  try {
    const added =
      list.type === "trakt"
        ? await syncTraktList(list, ctx)
        : list.type === "lastfm"
          ? await syncLastfmList(list, ctx)
          : list.type === "tmdb"
            ? await syncTmdbList(list, ctx)
            : await syncImdbList(list, ctx);
    // A list that came back empty says nothing about what it holds, so nothing is cleaned after one.
    const cleanWarnings: string[] = [];
    if (list.clean_level && list.clean_level !== "disabled" && ctx.seen.size > 0) {
      await cleanListItems(list, ctx.seen, (message) => cleanWarnings.push(`clean-up: ${message}`)).catch((err) =>
        log.warn(`[importLists] list "${list.name}": clean-up failed:`, (err as Error).message)
      );
    }
    // What the list holds now is what the next sync compares with, and what other lists' clean-ups protect.
    if (ctx.seen.size > 0) await recordListEntries(list.id, ctx.seen);
    const warning = [ctx.rootFolders.skippedSummary(), ...cleanWarnings].filter(Boolean).join("; ") || null;
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
