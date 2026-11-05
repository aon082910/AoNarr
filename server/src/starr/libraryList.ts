import crypto from "node:crypto";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import { log } from "../services/logger.js";
import { appUrlBase } from "../services/urlBase.js";
import { type StarrApp, typeFilter } from "./apps.js";
import {
  artistResource,
  authorResource,
  loadContext,
  movieResource,
  seasonStats,
  seriesResource,
  subItemResource,
  subItemStats,
  type LibraryContext,
  type SeasonStats,
  type SubStats,
} from "./libraryResources.js";
import { pagingOf, parseExternalIds, type PagingRequest } from "./shapes.js";

/**
 * The list endpoints (`GET /series`, `/movie`, `/artist`, `/author`, `/album`, `/book`). A Starr app answers one unpaged array
 * and the tools that read it (Bazarr, Overseerr, Homepage) fetch it whole, so that stays the default; with `page` or
 * `pageSize` the same list answers the paged envelope of the other lists of this layer.
 *
 * Building a resource is the slow part (6,000 movies were 0.55 s, 20 MB), and a library list is asked again and again while
 * almost nothing in it changed. So the JSON of each resource is kept, keyed by a fingerprint of everything that went into it
 * (the row's columns, its tags, its statistics, the day, the quality catalog): a row whose fingerprint is unchanged costs one
 * string comparison and is not built or serialized again, and the list is those strings joined. Nothing is invalidated by
 * hand, so no write path can forget to: a changed row has a different fingerprint. (A resource builder in libraryResources.ts
 * must therefore read only its row, the context and the statistics handed to it; a new input has to join the fingerprint.)
 * The entry's version number changes
 * whenever its JSON does, and the ETag of a list is a hash of its entries' versions, so the tag changes exactly when the body
 * does, without hashing the body.
 */

// --- the rows --------------------------------------------------------------------------------------------------------

/**
 * Every media_items column a resource builder reads. `m.*` also carried the long text that no resource shows
 * (extra_metadata with every alias, local artwork paths), which a 6,000-title library paid for on every request. The test
 * `starrListParity` runs the builders on a row that records what they read and fails when it is not listed here.
 */
export const TITLE_COLUMNS = [
  "id",
  "type",
  "title",
  "sort_title",
  "year",
  "overview",
  "poster_url",
  "backdrop_url",
  "external_ids",
  "path",
  "quality_profile_id",
  "monitored",
  "has_file",
  "quality",
  "status",
  "added_at",
  "release_date",
  "physical_release_date",
  "digital_release_date",
  "rating",
  "runtime_minutes",
  "size_bytes",
  "studio",
  "genres",
  "content_rating",
  "media_info",
  "minimum_availability",
  "series_type",
  "metadata_profile_id",
  "monitor_new_items",
  "file_release_title",
];

const TITLE_SELECT = `${TITLE_COLUMNS.map((c) => `m.${c}`).join(", ")}, rf.path AS root_folder_path`;

/** The sort keys a client may ask for, as a Starr client names them, and the column each means. Anything else sorts by title. */
const COMMON_SORTS: Record<string, string> = {
  sorttitle: "m.sort_title",
  title: "m.sort_title",
  sortname: "m.sort_title",
  artistname: "m.sort_title",
  authorname: "m.sort_title",
  cleantitle: "m.sort_title",
  added: "m.added_at",
  monitored: "m.monitored",
  id: "m.id",
};
const APP_SORTS: Record<StarrApp["key"], Record<string, string>> = {
  radarr: { year: "m.year", sizeondisk: "m.size_bytes", incinemas: "m.release_date", releasedate: "m.release_date", runtime: "m.runtime_minutes", hasfile: "m.has_file", studio: "m.studio" },
  sonarr: { year: "m.year", runtime: "m.runtime_minutes", status: "m.status", network: "m.studio" },
  lidarr: {},
  readarr: {},
};

function titleOrder(app: StarrApp, paging: PagingRequest | null): { sql: string; key: string } {
  const wanted = (paging?.sortKey ?? "").toLowerCase();
  const column = APP_SORTS[app.key][wanted] ?? COMMON_SORTS[wanted];
  const direction = paging?.sortDirection === "descending" ? "DESC" : "ASC";
  if (!paging || !column) return { sql: `m.sort_title ${direction}, m.id ${direction}`, key: "sortTitle" };
  // A missing value sorts last whichever way, and the same on SQLite and Postgres (they differ on where NULL goes).
  return { sql: `(${column} IS NULL), ${column} ${direction}, m.id ${direction}`, key: paging.sortKey! };
}

interface RowQuery {
  ids?: number[];
  order: string;
  limit?: number;
  offset?: number;
  /** A text each wanted row's external_ids must contain (a cheap superset of an exact id match, which the caller then checks). */
  contains?: string[];
}

async function selectTitleRows(app: StarrApp, q: RowQuery): Promise<any[]> {
  const f = typeFilter(app);
  const params: unknown[] = [...f.params];
  let where = f.sql;
  if (q.ids) {
    if (q.ids.length === 0) return [];
    where += ` AND m.id IN (${q.ids.map(() => "?").join(",")})`;
    params.push(...q.ids);
  }
  for (const text of q.contains ?? []) {
    where += " AND m.external_ids LIKE ?";
    params.push(`%${text}%`);
  }
  const paging = q.limit !== undefined ? " LIMIT ? OFFSET ?" : "";
  if (q.limit !== undefined) params.push(q.limit, q.offset ?? 0);
  return (await db
    .prepare(`SELECT ${TITLE_SELECT} FROM media_items m LEFT JOIN root_folders rf ON rf.id = m.root_folder_id WHERE ${where} ORDER BY ${q.order}${paging}`)
    .all(...params)) as any[];
}

async function countTitles(app: StarrApp): Promise<number> {
  const f = typeFilter(app);
  return Number(((await db.prepare(`SELECT COUNT(*) AS c FROM media_items m WHERE ${f.sql}`).get(...f.params)) as { c: number }).c);
}

// --- the kept JSON ---------------------------------------------------------------------------------------------------

interface Entry {
  fingerprint: string;
  /** The resource as UTF-8 JSON, encoded once: a list is these bytes joined, with no string to build or encode per request. */
  json: Buffer;
  version: number;
}

/** What the kept resources may take up (their JSON bytes and the memory of their fingerprints). Past it the whole cache starts over. */
const CACHE_LIMIT = 96 * 1024 * 1024;
let cacheLimit = CACHE_LIMIT;
const caches = new Map<string, Map<number, Entry>>();
let cachedSize = 0;
let versions = 0;
/** When the cap was last reported, so a library that does not fit logs once in a while instead of once per request. */
let lastCapWarning = 0;
const CAP_WARNING_EVERY_MS = 10 * 60 * 1000;
/** Makes a tag of an earlier run of the process unequal to every tag of this one, whatever versions were handed out. */
const RUN = crypto.randomBytes(5).toString("hex");

/** For tests: forget everything kept (and, with a number, lower the cap so the overflow can be reached with a few entries). */
export function clearListCache(limit = CACHE_LIMIT): void {
  caches.clear();
  cachedSize = 0;
  cacheLimit = limit;
  lastCapWarning = 0;
}

/** For tests: what the accounting believes is kept, next to what is really in the maps. */
export function listCacheStats(): { cachedSize: number; entries: number; recounted: number } {
  let entries = 0;
  let recounted = 0;
  for (const cache of caches.values()) {
    for (const entry of cache.values()) {
      entries++;
      recounted += costOf(entry);
    }
  }
  return { cachedSize, entries, recounted };
}

/**
 * What an entry takes up. The JSON is a Buffer, so its length is bytes. A string of the fingerprint is two bytes per character
 * as soon as one character is outside Latin-1 (a CJK title), and the count must not guess, so the upper bound is used.
 */
function costOf(entry: Entry): number {
  return entry.fingerprint.length * 2 + entry.json.length;
}

/** The text of a value, delimited so that two lists of values never read alike. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const text = typeof value === "string" ? value : String(value);
  return `${text.length}:${text}`;
}

function rowFingerprint(row: Record<string, unknown>, extra: string): string {
  let text = extra;
  for (const key in row) text += `${textOf(row[key])}|`;
  return text;
}

function entryFor(kind: string, id: number, fingerprint: string, build: () => unknown): Entry {
  let cache = caches.get(kind);
  if (!cache) caches.set(kind, (cache = new Map()));
  const have = cache.get(id);
  if (have && have.fingerprint === fingerprint) return have;
  const json = Buffer.from(JSON.stringify(build()), "utf8");
  // The replaced entry leaves the count first: a clear below drops it with the rest, and it must not be subtracted twice.
  if (have) cachedSize -= costOf(have);
  if (cachedSize > cacheLimit) {
    warnCapReached();
    caches.clear();
    cachedSize = 0;
    caches.set(kind, (cache = new Map()));
  }
  const entry = { fingerprint, json, version: ++versions };
  cache.set(id, entry);
  cachedSize += costOf(entry);
  return entry;
}

/**
 * A library whose list does not fit in the cap throws the cache away in the middle of every full list: every request rebuilds
 * most entries and the ETag never repeats. That is correct but slow, so it is said once in a while where the operator can see it.
 */
function warnCapReached(): void {
  const now = Date.now();
  if (now - lastCapWarning < CAP_WARNING_EVERY_MS) return;
  lastCapWarning = now;
  log.warn(`[starr] the kept list resources reached ${Math.round(cacheLimit / (1024 * 1024))} MB and were dropped; a library this large rebuilds its lists on every request`);
}

/** Entries of the kept list that this full listing did not see are gone from the library: let them go. */
function forgetMissing(kind: string, seen: Set<number>): void {
  const cache = caches.get(kind);
  if (!cache || cache.size <= seen.size) return;
  for (const [id, entry] of cache) {
    if (seen.has(id)) continue;
    cachedSize -= costOf(entry);
    cache.delete(id);
  }
}

/** What every resource of this request depends on besides its own row. */
function contextSignature(ctx: LibraryContext): string {
  return `${ctx.today}|${appUrlBase()}|${ctx.catalog.ordered.map((q) => `${q.id}:${q.name}`).join(",")}|`;
}

function seasonSignature(seasons: SeasonStats[] | undefined): string {
  return (seasons ?? []).map((s) => `${s.seasonNumber},${s.episodeCount},${s.episodeFileCount},${s.monitoredCount},${s.totalEpisodeCount},${s.sizeOnDisk},${s.nextAiring ?? ""},${s.previousAiring ?? ""}`).join(";");
}

// --- the answer ------------------------------------------------------------------------------------------------------

/**
 * Sends `entries` as a JSON array, or as the paged envelope when `paging` is given. The ETag is derived from the entries'
 * versions (see the top of the file); a client that holds the current list gets a 304 without the list being joined.
 */
function sendEntries(req: Request, res: Response, entries: Entry[], paging: { request: PagingRequest; key: string; total: number } | null): void {
  const head = paging ? JSON.stringify({ page: paging.request.page, pageSize: paging.request.pageSize, sortKey: paging.key, sortDirection: paging.request.sortDirection, totalRecords: paging.total }) : "";
  const hash = crypto.createHash("sha1").update(RUN).update(head);
  for (const e of entries) hash.update(`,${e.version}`);
  res.setHeader("ETag", `W/"${hash.digest("base64url")}"`);
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  const prefix = Buffer.from(paging ? `${head.slice(0, -1)},"records":[` : "[", "utf8");
  const suffix = paging ? "]}" : "]";
  let size = prefix.length + suffix.length + Math.max(0, entries.length - 1);
  for (const e of entries) size += e.json.length;
  const body = Buffer.allocUnsafe(size);
  let at = prefix.copy(body, 0);
  entries.forEach((e, i) => {
    if (i > 0) body[at++] = 0x2c;
    at += e.json.copy(body, at);
  });
  body.write(suffix, at, "ascii");
  res.set("Content-Type", "application/json; charset=utf-8").send(body);
}

// --- titles ----------------------------------------------------------------------------------------------------------

async function statsFor(app: StarrApp, today: string, ids: number[] | undefined): Promise<{ seasons?: Map<number, SeasonStats[]>; subs?: Map<number, SubStats> }> {
  if (app.key === "sonarr") return { seasons: await seasonStats(app, today, ids) };
  if (app.key === "lidarr" || app.key === "readarr") return { subs: await subItemStats(app, ids) };
  return {};
}

function titleEntry(ctx: LibraryContext, context: string, row: any, stats: Awaited<ReturnType<typeof statsFor>>): Entry {
  const app = ctx.app;
  const id = Number(row.id);
  const tags = ctx.tags.get(id);
  const tagged = tags && tags.length > 0 ? tags.join(",") : "";
  if (app.key === "radarr") return entryFor(app.key, id, rowFingerprint(row, `${context}${tagged}|`), () => movieResource(ctx, row));
  if (app.key === "sonarr") {
    const seasons = stats.seasons?.get(id) ?? [];
    return entryFor(app.key, id, rowFingerprint(row, `${context}${tagged}|${seasonSignature(seasons)}|`), () => seriesResource(ctx, row, seasons));
  }
  const sub = stats.subs?.get(id);
  const signature = sub ? `${sub.total},${sub.files},${sub.monitored},${sub.size}` : "";
  return entryFor(app.key, id, rowFingerprint(row, `${context}${tagged}|${signature}|`), () => (app.key === "lidarr" ? artistResource(ctx, row, sub) : authorResource(ctx, row, sub)));
}

/** Text that an id of tvdb/tmdb must contain to be that id at all; undefined for a value that is not a plain id. */
function idText(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value);
  return /^[A-Za-z0-9-]{1,40}$/.test(text) ? text : undefined;
}

/** `GET /series`, `/movie`, `/artist`, `/author`: the whole list, or a page of it with `page`/`pageSize`. */
export async function listTitles(req: Request, res: Response, app: StarrApp): Promise<undefined> {
  const wantsPage = req.query.page !== undefined || req.query.pageSize !== undefined;
  const paging = wantsPage ? pagingOf(req, "sortTitle", "ascending") : null;
  const order = titleOrder(app, paging);
  const ctx = await loadContext(app);
  const context = contextSignature(ctx);

  const tvdb = req.query.tvdbId;
  const tmdb = req.query.tmdbId;
  const filtered = (tvdb !== undefined && tvdb !== "") || (tmdb !== undefined && tmdb !== "");

  let rows: any[];
  let total: number;
  let whole = false;
  if (filtered) {
    const contains = [idText(tvdb), idText(tmdb)].filter((t): t is string => !!t);
    rows = await selectTitleRows(app, { order: order.sql, contains });
    if (tvdb !== undefined && tvdb !== "") rows = rows.filter((row) => parseExternalIds(row.external_ids).tvdb === String(tvdb));
    if (tmdb !== undefined && tmdb !== "") rows = rows.filter((row) => parseExternalIds(row.external_ids).tmdb === String(tmdb));
    total = rows.length;
    if (paging) rows = rows.slice(paging.offset, paging.offset + paging.pageSize);
  } else if (paging) {
    total = await countTitles(app);
    rows = await selectTitleRows(app, { order: order.sql, limit: paging.pageSize, offset: paging.offset });
  } else {
    rows = await selectTitleRows(app, { order: order.sql });
    total = rows.length;
    whole = true;
  }

  // The statistics of the whole library need no list of ids; a page or a filtered list asks for its own.
  const stats = await statsFor(app, ctx.today, whole ? undefined : rows.map((r) => Number(r.id)));
  const entries = rows.map((row) => titleEntry(ctx, context, row, stats));
  if (whole) forgetMissing(app.key, new Set(rows.map((r) => Number(r.id))));
  sendEntries(req, res, entries, paging ? { request: paging, key: order.key, total } : null);
  return undefined;
}

// --- the parts of a title (albums, books) -----------------------------------------------------------------------------

const CHILD_SORTS: Record<string, string> = {
  title: "s.title",
  releasedate: "s.release_date",
  monitored: "s.monitored",
  id: "s.id",
};

/** The ORDER BY of an album or book list: the release date by default (as before), or the sort key of a paged request. */
export function childOrder(paging: PagingRequest | null): { sql: string; key: string } {
  const column = CHILD_SORTS[(paging?.sortKey ?? "").toLowerCase()];
  if (!paging || !column) return { sql: "s.release_date, s.id", key: "releaseDate" };
  const direction = paging.sortDirection === "descending" ? "DESC" : "ASC";
  return { sql: `(${column} IS NULL), ${column} ${direction}, s.id ${direction}`, key: paging.sortKey! };
}

/** Sends the albums or books in `rows` as a list or a page. Not for a list that embeds its title (that one is built the long way). */
export function sendChildren(req: Request, res: Response, ctx: LibraryContext, rows: any[], paging: { request: PagingRequest; key: string } | null, wholeLibrary: boolean): undefined {
  const app = ctx.app;
  const context = contextSignature(ctx);
  const total = rows.length;
  const page = paging ? rows.slice(paging.request.offset, paging.request.offset + paging.request.pageSize) : rows;
  const kind = `${app.key}:${app.child}`;
  const entries = page.map((row) => entryFor(kind, Number(row.id), rowFingerprint(row, context), () => subItemResource(ctx, app, row)));
  if (wholeLibrary && !paging) forgetMissing(kind, new Set(rows.map((r) => Number(r.id))));
  sendEntries(req, res, entries, paging ? { request: paging.request, key: paging.key, total } : null);
  return undefined;
}
