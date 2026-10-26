import { log } from "./logger.js";
import { parseStringPromise } from "xml2js";
import { getMediaTypeConfig, MEDIA_TYPE_KEYS } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import { config } from "../config.js";
import { recordIndexerHealth } from "./indexerHealth.js";
import { categoriesFor } from "./indexerCategories.js";
import { parseReleaseTitle } from "./releaseParser.js";
import { identityKey } from "./releaseIdentity.js";
import { foldDiacritics, pad } from "./searchQueries.js";
import type { DdlIndexerConfig, Indexer, MediaType, SearchResult } from "../types/index.js";

/**
 * Torznab and Newznab share the same RSS-based search API (Torznab is Newznab's spec
 * extended with torrent-specific attrs like seeders/leechers), so one client handles both.
 * "rss" covers plain RSS 2.0 feeds some trackers/sites publish without full Torznab support.
 * "ddl" is a generic adapter for any JSON search API the admin points AoNarr at — never a
 * scraper for a specific site, and never hardcoded to one; the admin supplies both the URL
 * template and how to read the JSON shape that particular API happens to return.
 */

function categoriesForMediaType(type: MediaType): string {
  return getMediaTypeConfig(type).indexerCategory;
}

/** Online Videos and Podcasts are pulled from the channel/feed itself, never from an indexer. */
const NON_INDEXER_MEDIA_TYPES = new Set(["video", "podcast"]);

/** Every library type an indexer can be searched for — the default for a new indexer's
 * media_types, so an indexer added without an explicit list is used for all of them. */
export const INDEXER_MEDIA_TYPES: string[] = MEDIA_TYPE_KEYS.filter((k) => !NON_INDEXER_MEDIA_TYPES.has(k));
export const DEFAULT_INDEXER_MEDIA_TYPES = INDEXER_MEDIA_TYPES.join(",");

/** `size` stays numeric (0) when the indexer never reported one, so existing consumers keep
 * working, but `sizeKnown: false` marks it so a size-bound check can skip the release instead of
 * reading it as a 0-byte file and rejecting it. */
export type IndexerSearchResult = SearchResult & { sizeKnown?: boolean };

const SIZE_UNIT_POWER: Record<string, number> = { K: 1, M: 2, G: 3, T: 4 };

/** Bytes from a numeric size or a human-readable one ("1.4 GB", "1,234.5 MiB", "2.1GiB") — JSON
 * search APIs often report the latter. KB/MB/GB are 1024-based, as in the *Arr apps. */
function parseSizeBytes(raw: unknown): number {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw;
  const text = String(raw).trim();
  const plain = Number(text);
  if (text !== "" && Number.isFinite(plain)) return plain;
  // A comma before exactly three digits groups thousands; any other one is a decimal comma.
  const normalized = text.replace(/,(?=\d{3}(?!\d))/g, "").replace(",", ".");
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:([KMGT])(?:i?B)?|B|bytes?)?$/i);
  if (!match) return NaN;
  return Number(match[1]) * 1024 ** (match[2] ? SIZE_UNIT_POWER[match[2].toUpperCase()] : 0);
}

function sizeFields(raw: unknown): { size: number; sizeKnown?: false } {
  const n = Math.round(parseSizeBytes(raw));
  return Number.isFinite(n) && n > 0 ? { size: n } : { size: 0, sizeKnown: false };
}

/** Torznab/Newznab report API failures (bad key, request limit, removed indexer) as an
 * `<error code=".." description=".."/>` document, frequently with HTTP 200 — Jackett always does —
 * so the status code alone reads a dead indexer as a healthy one that just found nothing. */
export function indexerApiError(parsed: unknown): { code: string; description: string } | null {
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const attrs = (parsed as { error?: { $?: Record<string, unknown> } }).error?.$ ?? {};
  return { code: String(attrs.code ?? ""), description: String(attrs.description ?? "unknown error") };
}

/** Newznab 500/501 are "request/download limit reached"; Prowlarr uses 429 for its own backoff. */
const RATE_LIMIT_ERROR_CODES = new Set(["429", "500", "501"]);

/** A request that was not made because the indexer was backed off while it waited in the queue:
 * not a failure of the indexer, and nothing to record in its health history. */
class IndexerBackedOffError extends Error {}

class IndexerRateLimitError extends Error {
  /** How long the indexer asked to be left alone (a `Retry-After` header), when it said. */
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** A `Retry-After` header: a number of seconds, or an HTTP date. Capped at a day, so a bogus value
 * cannot park an indexer for good. */
function retryAfterMsOf(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 24 * 60 * 60 * 1000) : undefined;
}

function throwIfIndexerApiError(indexer: Indexer, parsed: unknown): void {
  const apiError = indexerApiError(parsed);
  if (!apiError) return;
  const message = `Indexer "${indexer.name}" error ${apiError.code}: ${apiError.description}`;
  throw RATE_LIMIT_ERROR_CODES.has(apiError.code) ? new IndexerRateLimitError(message) : new Error(message);
}

function hasRoot(parsed: unknown, root: string): boolean {
  return !!parsed && typeof parsed === "object" && root in parsed;
}

/** Every real indexer request gets a hard timeout so one slow/hanging source can't stall the
 * whole fan-out in searchAllIndexers — Promise.allSettled already isolates failures, but without
 * a timeout a single indexer that never responds would still hold up the overall search forever. */
const SEARCH_TIMEOUT_MS = 20_000;

/** Short-lived cache of raw per-indexer search results, keyed by (indexer, query, mediaType).
 * The scheduler re-runs the exact same query for the same monitored item every auto-search cycle
 * (every `searchIntervalMinutes`, default 30m) until something is grabbed — caching avoids
 * hammering indexers with an identical request when nothing about the query has changed. Manual
 * searches from the UI bypass this (see `searchAllIndexers`'s `bypassCache` param) since a user
 * clicking "Search" expects a live result, not a few-minutes-stale one. */
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();

/** Entries are (re)inserted at the end with a fixed TTL, so Map order is expiry order and expired
 * ones are always at the front. Without this, every distinct query ever searched (a new episode,
 * a daily show's air date) keeps its full result list for the life of the process. */
function pruneSearchCache(now: number): void {
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt > now) break;
    searchCache.delete(key);
  }
}

export function searchCacheSize(): number {
  return searchCache.size;
}

/** What a search is for besides its text. */
export interface SearchHints {
  /** The season and episode the query was built from (the scene numbers where the show has them),
   * for a typed tvsearch to ask the indexer for. Unset for a whole-series search. */
  season?: number | null;
  episode?: number | null;
  /** A daily show's air date (YYYY-MM-DD): the typed search asks for `season=YYYY&ep=MM/DD`. */
  airDate?: string | null;
  /** An anime episode's absolute number: the typed search asks `tvdbid` with `q=NN`, as fansub
   * releases are named by it. */
  absolute?: number | null;
  /** The show's title as a scene writes it, without the numbers. With it, an indexer whose
   * tv-search takes `q` is asked `t=tvsearch&q=<title>&season&ep` and files the numbers itself, so a
   * release named `Show.1x05` is found as well as `Show.S01E05` (Sonarr's title tier). */
  queryTitle?: string;
  /** The same search under the other titles the item goes by (alias rows, the title without its
   * "(US)" qualifier), as complete queries. At most MAX_ALTERNATE_QUERIES run, and only against an
   * indexer the main query found nothing at. */
  alternateQueries?: string[];
  /** Other forms of the same search that are asked of every indexer beside the main query, not only
   * of one that found nothing: the main query is a guess about how releases are named (an anime
   * episode by its absolute number), and an indexer that answers it with unrelated releases would
   * never be asked the other way. At most MAX_ALSO_QUERIES run, as text searches. */
  alsoQueries?: string[];
  /** Search by text only: an alternate-title query or a scene-name variant is about the words, and
   * the typed search it would repeat (same ids, same season) has been made by the main query. */
  skipTyped?: boolean;
  /** Read a plain RSS feed afresh instead of from the last few minutes' copy (a manual search). */
  fresh?: boolean;
  /** Look through the plain RSS feeds too, which an automatic search leaves to the RSS sync: for a
   * search the admin asked for, or a retry, that the sync will not repeat. */
  includeFeeds?: boolean;
}

function cacheKey(indexerId: number, query: string, mediaType: MediaType, externalIds?: Record<string, string>, hints?: SearchHints): string {
  // imdb/tmdb/tvdb ids (when present) and the season/episode change the actual request sent to the
  // indexer (see searchTorznabNewznab) — folded into the key so a cached result for the plain-title
  // query can't be wrongly reused for an id-narrowed or typed request, or vice versa.
  const idPart = externalIds?.imdb || externalIds?.tmdb || externalIds?.tvdb ? `:${externalIds.imdb ?? ""}:${externalIds.tmdb ?? ""}:${externalIds.tvdb ?? ""}` : "";
  const numberPart = hints?.season != null ? `:s${hints.season}e${hints.episode ?? ""}` : "";
  const datePart = hints?.airDate ? `:d${hints.airDate}` : "";
  const absolutePart = hints?.absolute != null ? `:a${hints.absolute}` : "";
  const titlePart = hints?.queryTitle ? `:t${hints.queryTitle.toLowerCase()}` : "";
  return `${indexerId}:${mediaType}:${query.toLowerCase()}${idPart}${numberPart}${datePart}${absolutePart}${titlePart}${hints?.skipTyped ? ":text" : ""}`;
}

/**
 * True for a transient, connection-level failure (the request never got a response at all) —
 * our own timeout firing, a reset/refused connection, DNS not resolving — never for a real HTTP
 * response the indexer sent back. `fetchIndexerText` itself never throws on a non-2xx response
 * (it returns `{ok: false, status}` and lets its callers decide what that means, including the
 * 429 backoff in recordIfRateLimited), so this can retry every exception it might see without
 * ever retrying a 429/403/500 the indexer legitimately returned.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = (err as NodeJS.ErrnoException).cause
    ? ((err as unknown as { cause?: NodeJS.ErrnoException }).cause?.code)
    : (err as NodeJS.ErrnoException).code;
  if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  return /fetch failed/i.test(err.message);
}

/** One retry after a short delay for a transient network failure — a single dropped connection
 * or DNS blip shouldn't fail an entire search cycle for an indexer that's otherwise healthy, but
 * this stays a single retry (not a loop) so a genuinely unreachable indexer still fails promptly
 * instead of doubling every search's worst-case latency. */
async function withNetworkRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return fn();
  }
}

/**
 * Fetches a URL through a configured FlareSolverr instance instead of directly, for indexers
 * behind Cloudflare/bot-detection that would otherwise return a challenge page instead of real
 * results. FlareSolverr runs a real headless browser and returns the resolved page body — see
 * https://github.com/FlareSolverr/FlareSolverr. Falls back to a plain fetch when the indexer
 * hasn't opted in or no FlareSolverr URL is configured instance-wide.
 */
async function fetchIndexerText(url: string, indexer: Indexer, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string; retryAfterMs?: number }> {
  const flaresolverrUrl = indexer.useFlareSolverr ? getSetting("flaresolverrUrl") : null;
  if (!flaresolverrUrl) {
    return withNetworkRetry(async () => {
      const res = await fetch(url, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.ok, status: res.status, text: await res.text(), retryAfterMs: retryAfterMsOf(res.headers?.get?.("retry-after")) };
    });
  }

  return withNetworkRetry(async () => {
    const res = await fetch(flaresolverrUrl.replace(/\/+$/, "") + "/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    if (!res.ok) throw new Error(`FlareSolverr request failed: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.status !== "ok") throw new Error(`FlareSolverr could not resolve "${url}": ${body.message ?? "unknown error"}`);
    return { ok: (body.solution?.status ?? 200) < 400, status: body.solution?.status ?? 200, text: body.solution?.response ?? "" };
  });
}

/** Lightweight reachability check. Torznab/Newznab hit their capabilities endpoint; rss/ddl just
 * confirm the configured URL responds. */
export async function checkIndexerHealth(indexer: Indexer): Promise<{ ok: boolean; error?: string }> {
  // A rate limit is the indexer's own request to be left alone; after failures the check is how the
  // admin finds out whether it has recovered (and a passing one ends the backoff, below).
  if (isIndexerBackedOff(indexer.id) && backoffReason.get(indexer.id) !== "failures") {
    return { ok: false, error: "Backed off after a recent 429" };
  }
  const result = await checkIndexerReachable(indexer);
  if (result.ok) clearIndexerBackoff(indexer.id);
  return result;
}

async function checkIndexerReachable(indexer: Indexer): Promise<{ ok: boolean; error?: string }> {
  try {
    let url: string;
    if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      const capsUrl = new URL(indexer.url.replace(/\/+$/, "") + "/api");
      capsUrl.searchParams.set("t", "caps");
      if (indexer.apiKey) capsUrl.searchParams.set("apikey", indexer.apiKey);
      url = capsUrl.toString();
    } else if (indexer.protocol === "ddl") {
      // A DDL indexer's URL is a template containing the literal "{query}" placeholder (enforced by
      // the admin UI) — substitute a real search term the same way searchDdl does, rather than
      // hitting the un-substituted template verbatim. Sent exactly as searchDdl sends it (bearer
      // key, never via FlareSolverr), or an auth-protected API that searches fine reads as down.
      const res = await fetchDdl(indexer, indexer.url.replace("{query}", encodeURIComponent("test")), 10_000);
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } else {
      url = indexer.url;
    }
    const res = await fetchIndexerText(url, indexer, 10_000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      const parsed = await parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });
      const apiError = indexerApiError(parsed);
      if (apiError) return { ok: false, error: `Indexer error ${apiError.code}: ${apiError.description}` };
      if (!hasRoot(parsed, "caps")) return { ok: false, error: "Response has no <caps> element — not a Torznab/Newznab API" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Newznab 201 "Incorrect parameter" / 203 "Function not available". Jackett answers any `imdbid`
 * sent to an indexer without movie-imdb search with a 201 (HTTP 200), even on a plain t=search, so
 * the id params turn a search that works fine without them into an error. */
const ID_PARAMS_REJECTED_CODES = new Set(["201", "203"]);
/** Indexers (id + url) whose id-narrowed search was rejected but whose plain one worked — later
 * searches leave the ids off rather than paying for a failed request first every time. */
const idParamsRejectedBy = new Set<string>();

/**
 * Requests to one indexer go one at a time, and an automatic search leaves a pause after each
 * (AONARR_INDEXER_REQUEST_SPACING_MS, 1 s by default; 0 turns the pause off). An automatic search
 * fans out into several queries over several episodes, and trackers with anti-flood rules read a
 * burst of them as abuse; Sonarr spaces its requests to one indexer the same way. A search the admin
 * is waiting for (`fresh`) takes its turn but does not pause.
 */
const DEFAULT_REQUEST_SPACING_MS = 1000;

function requestSpacingMs(): number {
  const raw = process.env.AONARR_INDEXER_REQUEST_SPACING_MS;
  const ms = raw === undefined || raw === "" ? DEFAULT_REQUEST_SPACING_MS : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_REQUEST_SPACING_MS;
}

const requestLanes = new Map<number, Promise<void>>();
const lastRequestEnded = new Map<number, number>();

async function inIndexerLane<T>(indexerId: number, request: () => Promise<T>, interactive = false): Promise<T> {
  const queued = requestLanes.has(indexerId);
  const previous = requestLanes.get(indexerId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  requestLanes.set(indexerId, tail);
  await previous;
  // Let the search whose request just ended finish noting how it went (a failure backs the indexer
  // off) before this one decides to go on.
  if (queued) await new Promise((resolve) => setImmediate(resolve));
  try {
    const wait = interactive ? 0 : (lastRequestEnded.get(indexerId) ?? 0) + requestSpacingMs() - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return await request();
  } finally {
    lastRequestEnded.set(indexerId, Date.now());
    release();
    if (requestLanes.get(indexerId) === tail) requestLanes.delete(indexerId);
  }
}

/** `interactive` is a search the admin is waiting for: it is not held back by the failure backoff
 * of the indexer, nor made to pause between requests. */
async function fetchTorznabFeed(indexer: Indexer, url: string, interactive = false): Promise<any> {
  const res = await inIndexerLane(
    indexer.id,
    () => {
      // A request queued behind the one that failed would only wait out the same outage.
      if (!interactive && isIndexerBackedOff(indexer.id)) throw new IndexerBackedOffError(backedOffMessage(indexer));
      return fetchIndexerText(url, indexer, SEARCH_TIMEOUT_MS);
    },
    interactive
  );
  if (!res.ok) {
    const message = `Indexer "${indexer.name}" returned HTTP ${res.status}`;
    // A 429, or a 5xx that says when to come back, is the indexer asking to be left alone.
    throw res.status === 429 || (res.status >= 500 && res.retryAfterMs) ? new IndexerRateLimitError(message, res.retryAfterMs) : new Error(message);
  }
  return parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });
}

/** What an indexer says it can search by (`t=caps`): the params its tv-search and movie-search
 * accept (or null for a search type it does not offer) and how many results a page holds. */
interface IndexerCaps {
  tv: Set<string> | null;
  movie: Set<string> | null;
  pageSize: number | null;
}

const CAPS_FAILURE_RETRY_MS = 10 * 60 * 1000;
const capsProbes = new Map<string, { at: number; failed: boolean; probe: Promise<IndexerCaps | null> }>();

/** What Sonarr assumes of a search type that lists no `supportedParams` (NewznabCapabilities). */
const DEFAULT_TV_PARAMS = ["q", "season", "ep"];
const DEFAULT_MOVIE_PARAMS = ["q"];

function searchTypeParams(parsed: any, element: string, defaults: string[]): Set<string> | null {
  const node = parsed?.caps?.searching?.[0]?.[element]?.[0]?.$;
  if (!node || String(node.available ?? "").toLowerCase() !== "yes") return null;
  const params = node.supportedParams == null ? defaults : String(node.supportedParams).split(",");
  return new Set(params.map((param) => param.trim().toLowerCase()).filter(Boolean));
}

function capsPageSize(parsed: any): number | null {
  const size = Number(parsed?.caps?.limits?.[0]?.$?.default);
  return Number.isInteger(size) && size > 0 ? size : null;
}

/** One `t=caps` request per indexer per process; a failed one is tried again after ten minutes. It
 * is not a search, so it does not count against the indexer's hourly query limit. */
function getIndexerCaps(indexer: Indexer): Promise<IndexerCaps | null> {
  const key = `${indexer.id}:${indexer.url}`;
  const known = capsProbes.get(key);
  if (known && !(known.failed && Date.now() - known.at >= CAPS_FAILURE_RETRY_MS)) return known.probe;
  const entry = { at: Date.now(), failed: false, probe: Promise.resolve<IndexerCaps | null>(null) };
  entry.probe = (async () => {
    try {
      const url = new URL(indexer.url.replace(/\/+$/, "") + "/api");
      url.searchParams.set("t", "caps");
      if (indexer.apiKey) url.searchParams.set("apikey", indexer.apiKey);
      const parsed = await fetchTorznabFeed(indexer, url.toString());
      if (indexerApiError(parsed) || !hasRoot(parsed, "caps")) throw new Error("the answer is no <caps> document");
      return {
        tv: searchTypeParams(parsed, "tv-search", DEFAULT_TV_PARAMS),
        movie: searchTypeParams(parsed, "movie-search", DEFAULT_MOVIE_PARAMS),
        pageSize: capsPageSize(parsed),
      };
    } catch (err) {
      if (err instanceof IndexerBackedOffError) {
        capsProbes.delete(key);
        return null;
      }
      entry.failed = true;
      log.info(`[indexerClient] "${indexer.name}": couldn't read its capabilities (${(err as Error).message}); searching it by text only`);
      noteSearchFailure(indexer, err);
      return null;
    }
  })();
  capsProbes.set(key, entry);
  return entry.probe;
}

/** Typed searches (search type + the params that were sent) that an indexer answered with an error,
 * and when: later searches of that kind skip it for a while. A tvsearch it lacks says nothing about
 * its movie search, nor a daily-date form about the plain season one, nor a refused id about
 * another id. */
const TYPED_REJECTION_TTL_MS = 6 * 60 * 60 * 1000;
const typedSearchRejectedBy = new Map<string, number>();

function typedRejected(key: string): boolean {
  const at = typedSearchRejectedBy.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > TYPED_REJECTION_TTL_MS) {
    typedSearchRejectedBy.delete(key);
    return false;
  }
  return true;
}

type ApiParams = [string, string][];

/** One request of a typed search: `kind` "id" asks by a provider id, "title" asks tv-search by the
 * show's title and numbers. */
interface TypedTier {
  kind: "id" | "title";
  t: "movie" | "tvsearch";
  params: ApiParams;
  rejectKey: string;
}

/** NNTmux reads a season "0" as no season, so Sonarr sends the specials' season as "00". */
function seasonParam(season: number): string {
  return season === 0 ? "00" : String(season);
}

/** The tv-search id param for a show: its tvdb id, else imdb, else tmdb, whichever the indexer takes. */
function tvIdParam(externalIds: Record<string, string>, tv: Set<string>): [string, string] | null {
  if (externalIds.tvdb && tv.has("tvdbid")) return ["tvdbid", externalIds.tvdb];
  if (externalIds.imdb && tv.has("imdbid")) return ["imdbid", externalIds.imdb.replace(/^tt/i, "")];
  if (externalIds.tmdb && tv.has("tmdbid")) return ["tmdbid", externalIds.tmdb];
  return null;
}

/** The season and episode a typed tv-search asks for: a daily show's `season=YYYY&ep=MM/DD`, or the
 * season (`00` for a special) and episode. Null when the indexer's tv-search lacks a param it needs. */
function tvNumberParams(hints: SearchHints | undefined, tv: Set<string>): ApiParams | null {
  if (hints?.airDate) {
    const [year, month, day] = hints.airDate.slice(0, 10).split("-");
    return tv.has("season") && tv.has("ep") && year && month && day ? [["season", year], ["ep", `${month}/${day}`]] : null;
  }
  if (hints?.season == null || !tv.has("season")) return null;
  const params: ApiParams = [["season", seasonParam(hints.season)]];
  if (hints.episode != null) {
    if (!tv.has("ep")) return null;
    params.push(["ep", String(hints.episode)]);
  }
  return params;
}

/**
 * The typed requests to make before a plain text search, in order, for what the item has and the
 * indexer says it takes. movie/ppv: imdb, then tmdb. series/anime: the show's id with the season and
 * episode (a daily show's date, an anime episode's absolute number), then, with the show's title,
 * tv-search by title and numbers. Anime without an id, whole-series searches and every other type
 * stay text searches.
 */
function typedTiersFor(
  indexer: Indexer,
  mediaType: MediaType,
  externalIds: Record<string, string> | undefined,
  hints: SearchHints | undefined,
  caps: IndexerCaps | null
): TypedTier[] {
  if (!caps || hints?.skipTyped) return [];
  const base = `${indexer.id}:${indexer.url}`;
  if (mediaType === "movie" || mediaType === "ppv") {
    const params: ApiParams | null =
      externalIds?.imdb && caps.movie?.has("imdbid")
        ? [["imdbid", externalIds.imdb.replace(/^tt/i, "")]]
        : externalIds?.tmdb && caps.movie?.has("tmdbid")
          ? [["tmdbid", externalIds.tmdb]]
          : null;
    const rejectKey = `${base}:movie:${params?.[0][0]}`;
    return params && !typedRejected(rejectKey) ? [{ kind: "id", t: "movie", params, rejectKey }] : [];
  }
  if ((mediaType !== "series" && mediaType !== "anime") || !caps.tv) return [];
  const tiers: TypedTier[] = [];
  const absolute = mediaType === "anime" && hints?.absolute != null && !hints.airDate && caps.tv.has("q");
  const form = hints?.airDate ? "daily" : absolute ? "absolute" : hints?.season === 0 ? "special" : "numbers";
  const idParam = externalIds ? tvIdParam(externalIds, caps.tv) : null;
  if (idParam) {
    const numbers: ApiParams | null = absolute ? [["q", pad(hints!.absolute!)]] : tvNumberParams(hints, caps.tv);
    const rejectKey = `${base}:tvsearch:${form}:${idParam[0]}`;
    if (numbers && !typedRejected(rejectKey)) tiers.push({ kind: "id", t: "tvsearch", params: [idParam, ...numbers], rejectKey });
  }
  // An anime episode is named by its absolute number, which the plain text search below asks for.
  const absoluteAnime = mediaType === "anime" && hints?.absolute != null && !hints.airDate;
  const titleKey = `${base}:tvsearch-title:${hints?.airDate ? "daily" : hints?.season === 0 ? "special" : "numbers"}`;
  if (hints?.queryTitle && !absoluteAnime && caps.tv.has("q") && !typedRejected(titleKey)) {
    const numbers = tvNumberParams(hints, caps.tv);
    if (numbers) tiers.push({ kind: "title", t: "tvsearch", params: [["q", hints.queryTitle], ...numbers], rejectKey: titleKey });
  }
  return tiers;
}

/**
 * Whether a typed search could be made at all, so the one-off capabilities probe is made only for an
 * indexer that is searched that way: a film with an imdb or tmdb id; an episode or season (or a
 * dated episode) of a show with a tvdb, imdb or tmdb id, or whose title is known.
 */
function mayBeSearchedTyped(mediaType: MediaType, externalIds: Record<string, string> | undefined, hints: SearchHints | undefined): boolean {
  if (hints?.skipTyped) return false;
  if (mediaType === "movie" || mediaType === "ppv") return !!(externalIds?.imdb || externalIds?.tmdb);
  if (mediaType !== "series" && mediaType !== "anime") return false;
  const numbered = hints?.season != null || !!hints?.airDate;
  return numbered && (!!(externalIds?.tvdb || externalIds?.imdb || externalIds?.tmdb) || !!hints?.queryTitle);
}

/** A positive provider id from an attribute (`imdb`/`imdbid` may carry the "tt"), or null. */
function positiveId(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = parseInt(String(raw).replace(/^tt/i, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rawItemCount(feed: any): number {
  return (feed?.rss?.channel?.[0]?.item ?? []).length;
}

/** The releases of a Torznab/Newznab feed, read the way Sonarr's TorznabRssParser and
 * NewznabRssParser do: attribute names without regard to case, the `size` attribute before the
 * enclosure's length (some trackers report the .torrent file's size there), provider ids as
 * positive integers, and no release without a title and a download URL. */
function torznabResults(parsed: any, indexer: Indexer, cats: string): IndexerSearchResult[] {
  const items: any[] = parsed.rss?.channel?.[0]?.item ?? [];
  const results: IndexerSearchResult[] = [];

  for (const item of items) {
    const rawTitle = item.title?.[0];
    const title: string = typeof rawTitle === "string" ? rawTitle : (rawTitle?._ ?? "");
    const enclosure = item.enclosure?.[0]?.$;
    // xml2js keeps namespace prefixes on element names: Torznab feeds use <torznab:attr>, Newznab
    // feeds (usenet indexers, NZBHydra, Prowlarr's usenet proxy) use <newznab:attr>.
    const attrs = new Map<string, string[]>();
    for (const attr of [...(item["torznab:attr"] ?? []), ...(item["newznab:attr"] ?? []), ...(item.attr ?? [])]) {
      const a = attr?.$;
      if (!a?.name) continue;
      const name = String(a.name).toLowerCase();
      const values = attrs.get(name) ?? [];
      values.push(String(a.value ?? ""));
      attrs.set(name, values);
    }
    const first = (name: string): string | undefined => attrs.get(name)?.[0];
    const num = (name: string): number | null => {
      const raw = first(name);
      if (raw == null || raw.trim() === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    const magnetUrl = first("magneturl")?.trim() || null;
    const rawLink = item.link?.[0];
    const link: string = typeof rawLink === "string" ? rawLink : (rawLink?._ ?? "");
    const downloadUrl: string = enclosure?.url || link || magnetUrl || "";
    if (!title || !downloadUrl) continue;

    // The size attribute is the release's; an enclosure's length is the .torrent file's on some trackers.
    const sizeAttr = parseSizeBytes(first("size"));
    const rawSize: unknown = Number.isFinite(sizeAttr) && sizeAttr > 0 ? sizeAttr : enclosure?.length;
    const seeders = num("seeders");
    const peers = num("peers");
    // Torznab's "peers" attr is the TOTAL peer count (seeders + leechers), not the leecher count
    // on its own — most indexers only emit seeders/peers, not a separate leechers attr, so derive
    // it the same way Sonarr/Radarr's own Torznab parsers do rather than misreporting the total.
    let leechers = num("leechers");
    if (leechers === null && peers !== null && seeders !== null) leechers = Math.max(0, peers - seeders);
    // Radarr/Sonarr's "freeleech"/"halfleech" custom-format specification reads the exact same
    // attribute — 0 means the download doesn't count against ratio at all (freeleech), 0.5 means
    // it counts at half (halfleech). Not every indexer emits this; absent means "unknown", not
    // "normal" — customFormatScoring.ts's indexerFlag condition treats those the same way (never
    // matches, so a "must be freeleech" condition group correctly excludes unknown-status results).
    const downloadVolumeFactor = num("downloadvolumefactor");
    // Not every indexer reports these, but when one does it's a far stronger identity signal
    // than anything parsed out of the title text — see scheduler.ts's chooseBestResult.
    const imdb = positiveId(first("imdb")) ?? positiveId(first("imdbid"));
    const tmdb = positiveId(first("tmdbid"));
    const tvdb = positiveId(first("tvdbid"));
    const tags = (attrs.get("tag") ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    // A usenet indexer's pubDate is when its feed was built; the post's own date is usenetdate.
    const publishDate = first("usenetdate") || item.pubDate?.[0] || null;

    results.push({
      indexerId: indexer.id,
      indexerName: indexer.name,
      title,
      ...sizeFields(rawSize),
      seeders,
      leechers,
      publishDate,
      downloadUrl,
      protocol: indexer.protocol === "torznab" ? "torrent" : "usenet",
      category: cats,
      downloadVolumeFactor,
      uploadVolumeFactor: num("uploadvolumefactor"),
      imdbId: imdb ? `tt${String(imdb).padStart(7, "0")}` : null,
      tmdbId: tmdb ? String(tmdb) : null,
      tvdbId: tvdb ? String(tvdb) : null,
      infoHash: first("infohash")?.trim().toLowerCase() || null,
      magnetUrl,
      indexerTags: tags,
    });
  }

  return results;
}

/** Results a page holds when the indexer's capabilities do not say (Sonarr's default page size). */
const DEFAULT_PAGE_SIZE = 100;
/** Pages one search reads at most: a season or an id search on a large show can run past the first. */
const MAX_SEARCH_PAGES = 3;

/**
 * The pages after the first, while each comes back full. Each page is a request against the
 * indexer's hourly limit; a failure after the first page keeps what was read. An indexer that
 * ignores `offset` sends the first page again, which ends the paging.
 */
async function followingPages(
  indexer: Indexer,
  urlFor: (offset: number, limit: number) => string,
  cats: string,
  pageSize: number,
  firstFeed: any,
  firstResults: IndexerSearchResult[],
  countRequest: () => void,
  interactive: boolean
): Promise<IndexerSearchResult[]> {
  const more: IndexerSearchResult[] = [];
  const seen = new Set(firstResults.map((r) => r.downloadUrl));
  let received = rawItemCount(firstFeed);
  let lastCount = received;
  for (let page = 1; page < MAX_SEARCH_PAGES && lastCount >= pageSize; page++) {
    if (queriesLeft(indexer) < 1) break;
    countRequest();
    try {
      const feed = await fetchTorznabFeed(indexer, urlFor(received, pageSize), interactive);
      if (indexerApiError(feed)) {
        // A request limit on a later page backs the indexer off like one on the first.
        try {
          throwIfIndexerApiError(indexer, feed);
        } catch (err) {
          noteSearchFailure(indexer, err);
        }
        break;
      }
      if (!hasRoot(feed, "rss")) break;
      lastCount = rawItemCount(feed);
      received += lastCount;
      const fresh = torznabResults(feed, indexer, cats).filter((r) => !seen.has(r.downloadUrl));
      if (fresh.length === 0) break;
      for (const r of fresh) seen.add(r.downloadUrl);
      more.push(...fresh);
    } catch (err) {
      log.info(`[indexerClient] "${indexer.name}": page ${page + 1} of the search failed (${(err as Error).message}); using the ${received} result(s) read`);
      noteSearchFailure(indexer, err);
      break;
    }
  }
  return more;
}

/** A Torznab/Newznab API request: `t` and its params, the categories, the key and extended=1 (without
 * it a Newznab indexer answers with the basic attributes only: no ids, no usenetdate, no grabs). */
function apiUrlFor(indexer: Indexer, cats: string, t: string, params: ApiParams, offset = 0, limit = 0): string {
  const url = new URL(indexer.url.replace(/\/+$/, "") + "/api");
  url.searchParams.set("t", t);
  for (const [name, value] of params) url.searchParams.set(name, value);
  url.searchParams.set("cat", cats);
  if (indexer.apiKey) url.searchParams.set("apikey", indexer.apiKey);
  url.searchParams.set("extended", "1");
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
    if (limit > 0) url.searchParams.set("limit", String(limit));
  }
  return url.toString();
}

async function searchTorznabNewznab(
  indexer: Indexer,
  query: string,
  mediaType: MediaType,
  externalIds?: Record<string, string>,
  hints?: SearchHints
): Promise<SearchResult[]> {
  const caps = mayBeSearchedTyped(mediaType, externalIds, hints) ? await getIndexerCaps(indexer) : null;
  const cats = categoriesFor(indexer.categories, categoriesForMediaType(mediaType));
  const pageSize = caps?.pageSize ?? DEFAULT_PAGE_SIZE;
  const idParamsKey = `${indexer.id}:${indexer.url}`;
  const interactive = !!hints?.fresh;

  const apiUrl = (t: string, params: ApiParams, offset = 0, limit = 0): string => apiUrlFor(indexer, cats, t, params, offset, limit);

  // searchIndexer has counted the first request against the hourly limit; every other is counted here.
  let requests = 0;
  const countRequest = () => {
    if (requests++ > 0) recordQueryLimitRequest(indexer);
  };
  type Attempt = { kind: "rejected"; feed: any } | { kind: "limited" } | { kind: "results"; results: IndexerSearchResult[] };
  /** One search, its following pages included: "rejected" for an answer that refuses the params,
   * "limited" when the indexer's hourly limit has no request left for it. */
  const attempt = async (t: string, params: ApiParams): Promise<Attempt> => {
    if (requests > 0 && queriesLeft(indexer) < 1) return { kind: "limited" };
    countRequest();
    const feed = await fetchTorznabFeed(indexer, apiUrl(t, params), interactive);
    if (ID_PARAMS_REJECTED_CODES.has(indexerApiError(feed)?.code ?? "")) return { kind: "rejected", feed };
    throwIfIndexerApiError(indexer, feed);
    if (!hasRoot(feed, "rss")) throw new Error(`Indexer "${indexer.name}" returned a response with no <rss> feed`);
    const results = torznabResults(feed, indexer, cats);
    const more = await followingPages(indexer, (offset, limit) => apiUrl(t, params, offset, limit), cats, pageSize, feed, results, countRequest, interactive);
    return { kind: "results", results: [...results, ...more] };
  };

  // The typed searches first (tvsearch by id, tv-search by title and numbers, movie by id); the
  // plain text search below stands in when the indexer has no such search, rejects it, or has
  // nothing under it.
  let titleSearchAnswered = false;
  for (const tier of typedTiersFor(indexer, mediaType, externalIds, hints, caps)) {
    try {
      const outcome = await attempt(tier.t, tier.params);
      if (outcome.kind === "limited") return [];
      if (outcome.kind === "rejected") {
        typedSearchRejectedBy.set(tier.rejectKey, Date.now());
        continue;
      }
      if (outcome.results.length > 0) return outcome.results;
      if (tier.kind === "title") titleSearchAnswered = true;
    } catch (err) {
      // A rate limit is the indexer's, not the typed search's, and an indexer that does not answer
      // at all will not answer a text search either (and would cost the same timeouts twice).
      // A server error says the indexer is failing, and the next request would only wait out the same.
      if (
        err instanceof IndexerRateLimitError ||
        err instanceof IndexerBackedOffError ||
        /HTTP 429/.test((err as Error).message) ||
        /returned HTTP 5\d\d/.test((err as Error).message) ||
        isTransientNetworkError(err)
      ) {
        throw err;
      }
      log.info(`[indexerClient] "${indexer.name}": typed ${tier.t} search failed (${(err as Error).message}); trying the next search`);
    }
  }
  // tv-search by title and numbers is the text search (the indexer filters by its own parsed
  // numbers): an empty answer from it is an answer.
  if (titleSearchAnswered) return [];

  // Best-effort narrowing for a film whose indexer's capabilities could not be read: it may take
  // Torznab's id-search params on a plain search, and is retried without them if it rejects them.
  // One whose capabilities are known was asked by id above where it takes them: repeating the id
  // search as a "text" search only repeats the empty answer. Only films have an id space this way.
  const sendIds =
    !caps && !hints?.skipTyped && (mediaType === "movie" || mediaType === "ppv") && !!(externalIds?.imdb || externalIds?.tmdb) && !idParamsRejectedBy.has(idParamsKey);
  const textParams = (withIds: boolean): ApiParams => {
    const params: ApiParams = [["q", query]];
    if (withIds) {
      if (externalIds?.imdb) params.push(["imdbid", externalIds.imdb.replace(/^tt/i, "")]);
      if (externalIds?.tmdb) params.push(["tmdbid", externalIds.tmdb]);
    }
    return params;
  };

  let outcome = await attempt("search", textParams(sendIds));
  if (outcome.kind === "rejected" && sendIds) {
    outcome = await attempt("search", textParams(false));
    if (outcome.kind === "results") idParamsRejectedBy.add(idParamsKey);
  }
  if (outcome.kind === "rejected") throwIfIndexerApiError(indexer, outcome.feed);
  return outcome.kind === "results" ? outcome.results : [];
}

/** An RSS item can point at a .torrent, a magnet link, an NZB or a direct file — tracker feeds
 * carry torrents, so hard-coding "http" would hand them to the Direct HTTP client, which saves the
 * .torrent itself as the "download" (or can't fetch a magnet: at all). */
function rssItemProtocol(downloadUrl: string, enclosureType: unknown): SearchResult["protocol"] {
  const url = String(downloadUrl);
  const type = typeof enclosureType === "string" ? enclosureType.trim().toLowerCase() : "";
  let path = url.toLowerCase();
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // not an absolute URL — match against the raw string
  }
  if (/^magnet:/i.test(url) || type === "application/x-bittorrent" || path.endsWith(".torrent")) return "torrent";
  if (type === "application/x-nzb" || path.endsWith(".nzb")) return "usenet";
  return "http";
}

/** A plain RSS feed is one list for every query: it is read once and kept for a few minutes, so an
 * automatic search of five hundred episodes does not download the same feed five hundred times. */
const RSS_FEED_TTL_MS = 5 * 60 * 1000;
const RSS_FEED_LIMIT = 200;
const rssFeeds = new Map<string, { expiresAt: number; items: any[] }>();

async function rssFeedItems(indexer: Indexer, fresh: boolean): Promise<any[]> {
  const key = `${indexer.id}:${indexer.url}`;
  const now = Date.now();
  const cached = rssFeeds.get(key);
  if (!fresh && cached && cached.expiresAt > now) return cached.items;
  const res = await inIndexerLane(indexer.id, () => fetchIndexerText(indexer.url, indexer, SEARCH_TIMEOUT_MS), fresh);
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  const parsed = await parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });
  const items: any[] = parsed?.rss?.channel?.[0]?.item ?? [];
  rssFeeds.delete(key);
  rssFeeds.set(key, { expiresAt: now + RSS_FEED_TTL_MS, items });
  // Map order is insertion order: the oldest feed goes first.
  while (rssFeeds.size > RSS_FEED_LIMIT) rssFeeds.delete(rssFeeds.keys().next().value as string);
  return items;
}

const RSS_COMMON_WORDS = new Set(["a", "an", "the", "and", "or", "of"]);

function comparableTitle(title: string): string {
  const tokens = identityKey(title).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !RSS_COMMON_WORDS.has(t));
  return (kept.length > 0 ? kept : tokens).join("");
}

/**
 * Whether a feed item is what the query asks for. The feed is a fixed "latest" list that cannot be
 * searched, so every item is judged here: the text of the query inside the item's title (what a
 * hand-typed query finds), or the same title and numbers once both are parsed ("Dune 2021" is
 * "Dune.2021.1080p.WEB-DL-GRP"; "Show S04E02" is "Show.S04E02.720p"). Sonarr runs every feed item
 * through its parser the same way.
 */
function rssItemMatches(itemTitle: string, query: string): boolean {
  if (itemTitle.toLowerCase().includes(query.toLowerCase())) return true;
  const wanted = parseReleaseTitle(query);
  const got = parseReleaseTitle(itemTitle);
  if (!wanted.title || !got.title || comparableTitle(wanted.title) !== comparableTitle(got.title)) return false;
  if (wanted.airDate) return got.airDate === wanted.airDate;
  if (wanted.seasonNumber != null) {
    if (got.seasonNumber !== wanted.seasonNumber) return false;
    return wanted.episodeNumbers?.length ? wanted.episodeNumbers.every((e) => got.episodeNumbers?.includes(e)) : !!got.isFullSeason || !got.episodeNumbers?.length;
  }
  if (wanted.absoluteEpisode != null) return got.absoluteEpisode === wanted.absoluteEpisode;
  if (wanted.year != null && got.year != null) return got.year === wanted.year;
  return true;
}

/** Plain RSS 2.0 — no Torznab search-attr extensions assumed, so no seeders/category, and the
 * query can't be sent to the feed (many such feeds are a fixed "latest" list); results are
 * title-matched client-side against the query (rssItemMatches). */
async function searchRss(indexer: Indexer, query: string, fresh = false): Promise<SearchResult[]> {
  const items = await rssFeedItems(indexer, fresh);

  const results: IndexerSearchResult[] = [];
  for (const item of items) {
    const title: string = item.title?.[0] ?? "unknown";
    if (!rssItemMatches(title, query)) continue;
    const result = rssItemResult(indexer, item);
    if (result) results.push(result);
  }
  return results;
}

/** A plain RSS item as a release, or null for one with no download URL. */
function rssItemResult(indexer: Indexer, item: any): IndexerSearchResult | null {
  const title: string = item.title?.[0] ?? "unknown";
  const enclosure = item.enclosure?.[0]?.$;
  const downloadUrl = enclosure?.url ?? item.link?.[0] ?? "";
  if (!downloadUrl) return null;
  return {
    indexerId: indexer.id,
    indexerName: indexer.name,
    title,
    ...sizeFields(enclosure?.length),
    seeders: null,
    leechers: null,
    publishDate: item.pubDate?.[0] ?? null,
    downloadUrl,
    protocol: rssItemProtocol(downloadUrl, enclosure?.type),
    category: null,
  };
}

function getByDotPath(obj: any, dotPath: string | null | undefined): any {
  if (!dotPath) return obj;
  return dotPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function fetchDdl(indexer: Indexer, url: string, timeoutMs: number): Promise<Response> {
  return withNetworkRetry(() =>
    fetch(url, {
      headers: indexer.apiKey ? { Authorization: `Bearer ${indexer.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
  );
}

/** Generic JSON search API adapter. The admin supplies `indexer.url` as a template containing
 * `{query}` (URL-encoded on substitution) and `indexer.config` as a DdlIndexerConfig describing
 * where the results array lives in the response and which fields map to what — this makes it
 * work with any JSON-returning search API without AoNarr knowing anything about the specific
 * site ahead of time. */
async function searchDdl(indexer: Indexer, query: string): Promise<SearchResult[]> {
  let cfg: DdlIndexerConfig;
  try {
    cfg = JSON.parse(indexer.config ?? "{}");
  } catch {
    throw new Error(`Indexer "${indexer.name}" has invalid DDL config JSON`);
  }
  if (!cfg.titleField || !cfg.downloadUrlField) {
    throw new Error(`Indexer "${indexer.name}" is missing titleField/downloadUrlField in its DDL config`);
  }

  const url = indexer.url.replace("{query}", encodeURIComponent(query));
  const res = await inIndexerLane(indexer.id, () => fetchDdl(indexer, url, SEARCH_TIMEOUT_MS));
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  const body = await res.json();

  const items = getByDotPath(body, cfg.resultsPath);
  if (!Array.isArray(items)) {
    throw new Error(`Indexer "${indexer.name}": resultsPath "${cfg.resultsPath ?? ""}" did not resolve to an array`);
  }

  const results: IndexerSearchResult[] = [];
  for (const item of items) {
    const title = getByDotPath(item, cfg.titleField);
    const downloadUrl = getByDotPath(item, cfg.downloadUrlField);
    if (!title || !downloadUrl) continue;
    const rawSize = cfg.sizeField ? getByDotPath(item, cfg.sizeField) : null;
    const rawSeeders = cfg.seedersField ? getByDotPath(item, cfg.seedersField) : null;

    results.push({
      indexerId: indexer.id,
      indexerName: indexer.name,
      title: String(title),
      ...sizeFields(rawSize),
      seeders: rawSeeders != null ? Number(rawSeeders) : null,
      leechers: null,
      publishDate: cfg.publishDateField ? (getByDotPath(item, cfg.publishDateField) ?? null) : null,
      downloadUrl: String(downloadUrl),
      protocol: "http",
      category: null,
    });
  }
  return results;
}

/** Once an indexer 429s, back off entirely for a while rather than keep hammering a source
 * that's already telling us to slow down — every subsequent auto-search/manual-search cycle
 * within the window skips it outright instead of making (and likely wasting) another request. */
const BACKOFF_MS = 15 * 60 * 1000;
const backoffUntil = new Map<number, number>();
/** Why an indexer is backed off: it asked ("rate-limit") or it kept failing ("failures"). */
const backoffReason = new Map<number, "rate-limit" | "failures">();
/** When the current backoff began, so a failure of a search that started before it is not counted again. */
const backoffSetAt = new Map<number, number>();

/**
 * An indexer that fails (no answer, a server error, a refused API key) is left alone for longer each
 * time it fails again in a row — 5 minutes, then 15 minutes, 1, 3, 6 and 24 hours — and the count
 * starts over after a search of it succeeds. Sonarr disables a failing indexer the same way; without
 * it every search of a down indexer waits out its 20-second timeouts, twice.
 */
const FAILURE_BACKOFF_MS = [5, 15, 60, 180, 360, 1440].map((minutes) => minutes * 60 * 1000);
const consecutiveFailures = new Map<number, number>();

/**
 * Proactive per-indexer "Query Limit" (requests/hour) — distinct from the reactive 429 backoff
 * above, which only kicks in *after* an indexer has already rejected a request. This stops AoNarr
 * from ever sending the request that would trigger a 429 (or a ban) in the first place, for an
 * indexer whose admin sets a cap. A rolling one-hour window of request timestamps per indexer,
 * in-memory only — resets on restart, which is fine for a soft self-imposed courtesy limit.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const requestTimestamps = new Map<number, number[]>();

function isOverQueryLimit(indexer: Indexer): boolean {
  const limit = indexer.queryLimitPerHour;
  if (!limit || limit <= 0) return false;
  const now = Date.now();
  const timestamps = (requestTimestamps.get(indexer.id) ?? []).filter((t) => now - t < ONE_HOUR_MS);
  requestTimestamps.set(indexer.id, timestamps);
  return timestamps.length >= limit;
}

/** How many more queries the indexer's hourly limit allows now (unlimited when it has none). */
function queriesLeft(indexer: Indexer): number {
  const limit = indexer.queryLimitPerHour;
  if (!limit || limit <= 0) return Infinity;
  const now = Date.now();
  const used = (requestTimestamps.get(indexer.id) ?? []).filter((t) => now - t < ONE_HOUR_MS).length;
  return Math.max(0, limit - used);
}

/** Only tracked for an indexer with a limit — isOverQueryLimit (which prunes the window) returns
 * early without one, so recording regardless grew an unlimited indexer's array forever. */
function recordQueryLimitRequest(indexer: Indexer): void {
  if (!indexer.queryLimitPerHour || indexer.queryLimitPerHour <= 0) {
    requestTimestamps.delete(indexer.id);
    return;
  }
  const timestamps = requestTimestamps.get(indexer.id) ?? [];
  timestamps.push(Date.now());
  requestTimestamps.set(indexer.id, timestamps);
}

export function isIndexerBackedOff(indexerId: number): boolean {
  const until = backoffUntil.get(indexerId);
  return !!until && until > Date.now();
}

/** Whether a search could ask the indexer now: it is not backed off and has room in its hourly limit. */
export function isIndexerAvailable(indexer: Indexer): boolean {
  return !isIndexerBackedOff(indexer.id) && !isOverQueryLimit(indexer);
}

/** What a search of the indexers reached: how many it asked, and how many of those answered (with
 * releases or with none; one that failed, was backed off or had no room left in its hourly limit did
 * not). An empty result says nothing about a target when none answered. */
export interface SearchReach {
  applicable: number;
  answered: number;
}

const searchReaches = new WeakMap<SearchResult[], SearchReach>();

/** The reach of the search that returned `results` (undefined for a list searchAllIndexers did not return). */
export function searchReachOf(results: SearchResult[]): SearchReach | undefined {
  return searchReaches.get(results);
}

/** Lets an indexer be searched again now, e.g. after the admin's own health check of it passed. */
export function clearIndexerBackoff(indexerId: number): void {
  backoffUntil.delete(indexerId);
  backoffReason.delete(indexerId);
  backoffSetAt.delete(indexerId);
  consecutiveFailures.delete(indexerId);
}

/** The admin's edit or test of an indexer ends a backoff it earned by failing (a key that has since
 * been fixed), but not one the indexer asked for with a rate limit. */
export function clearFailureBackoff(indexerId: number): void {
  if (backoffReason.get(indexerId) === "rate-limit") return;
  clearIndexerBackoff(indexerId);
  // What was learned while it failed (its capabilities, the forms of search it refused) may have
  // been the fault of the key or URL that has just been corrected.
  const prefix = `${indexerId}:`;
  for (const key of [...capsProbes.keys()]) if (key.startsWith(prefix)) capsProbes.delete(key);
  for (const key of [...typedSearchRejectedBy.keys()]) if (key.startsWith(prefix)) typedSearchRejectedBy.delete(key);
  for (const key of [...idParamsRejectedBy]) if (key.startsWith(prefix)) idParamsRejectedBy.delete(key);
}

function backoffText(ms: number): string {
  return ms >= 60 * 60 * 1000 ? `${Math.round(ms / (60 * 60 * 1000))}h` : `${Math.max(1, Math.round(ms / 60000))}m`;
}

function isRateLimit(err: unknown): err is IndexerRateLimitError | Error {
  return err instanceof IndexerRateLimitError || (err instanceof Error && /HTTP 429/.test(err.message));
}

/** Backs the indexer off when it asked to be left alone (for as long as it said, else 15 minutes). */
function noteSearchFailure(indexer: Indexer, err: unknown): void {
  if (!isRateLimit(err)) return;
  const ms = (err instanceof IndexerRateLimitError ? err.retryAfterMs : undefined) ?? BACKOFF_MS;
  backoffUntil.set(indexer.id, Date.now() + ms);
  backoffReason.set(indexer.id, "rate-limit");
  backoffSetAt.set(indexer.id, Date.now());
  log.warn(`[indexerClient] "${indexer.name}" is rate limiting requests — backing off for ${backoffText(ms)}`);
}

function recordSearchFailure(indexer: Indexer, err: unknown, startedAt: number, interactive: boolean): void {
  if (isRateLimit(err)) {
    noteSearchFailure(indexer, err);
    return;
  }
  // One outage, one failure: a search that began before the indexer was backed off ran into the
  // outage that did it. The admin's own search of a backed-off indexer tried it on purpose, and does
  // not lengthen the wait.
  if (isIndexerBackedOff(indexer.id) && ((backoffSetAt.get(indexer.id) ?? 0) >= startedAt || interactive)) return;
  const failures = (consecutiveFailures.get(indexer.id) ?? 0) + 1;
  consecutiveFailures.set(indexer.id, failures);
  const ms = FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1];
  backoffUntil.set(indexer.id, Date.now() + ms);
  backoffReason.set(indexer.id, "failures");
  backoffSetAt.set(indexer.id, Date.now());
  log.warn(`[indexerClient] "${indexer.name}" failed ${failures} search(es) in a row (${(err as Error).message}) — backing off for ${backoffText(ms)}`);
}

function backedOffMessage(indexer: Indexer): string {
  return backoffReason.get(indexer.id) === "failures"
    ? `Indexer "${indexer.name}" is backed off after recent failures — skipping`
    : `Indexer "${indexer.name}" is backed off after a recent 429 — skipping`;
}

export async function searchIndexer(
  indexer: Indexer,
  query: string,
  mediaType: MediaType,
  externalIds?: Record<string, string>,
  hints?: SearchHints
): Promise<SearchResult[]> {
  // A search the admin is waiting for tries an indexer that is backed off for failing (it may have
  // recovered), though not one that asked to be left alone.
  const interactive = !!hints?.fresh;
  if (isIndexerBackedOff(indexer.id) && !(interactive && backoffReason.get(indexer.id) === "failures")) {
    throw new Error(backedOffMessage(indexer));
  }
  if (isOverQueryLimit(indexer)) {
    throw new Error(`Indexer "${indexer.name}" has hit its configured query limit for this hour — skipping`);
  }
  recordQueryLimitRequest(indexer);
  const startedAt = Date.now();
  try {
    let results: SearchResult[];
    if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      results = await searchTorznabNewznab(indexer, query, mediaType, externalIds, hints);
    } else if (indexer.protocol === "rss") {
      results = await searchRss(indexer, query, hints?.fresh);
    } else if (indexer.protocol === "ddl") {
      results = await searchDdl(indexer, query);
    } else {
      throw new Error(`Unknown indexer protocol "${indexer.protocol}"`);
    }
    consecutiveFailures.delete(indexer.id);
    if (backoffReason.get(indexer.id) === "failures") clearIndexerBackoff(indexer.id);
    await recordIndexerHealth(indexer.id, true, Date.now() - startedAt, null);
    return results;
  } catch (err) {
    if (err instanceof IndexerBackedOffError) throw err;
    recordSearchFailure(indexer, err, startedAt, interactive);
    await recordIndexerHealth(indexer.id, false, Date.now() - startedAt, (err as Error).message);
    throw err;
  }
}

/** The newest release the RSS sync saw in a feed: where the next run stops reading. */
export interface RssMarker {
  url: string | null;
  at: string | null;
}

export interface RecentFeed {
  /** The releases newer than the marker, newest first. */
  results: IndexerSearchResult[];
  /** The newest release of the feed (the marker to keep), null for an empty one. */
  newest: RssMarker | null;
}

/** The feeds of an indexer an RSS sync reads for some media types: one per distinct set of categories. */
export function rssFeedGroups(indexer: Indexer, types: MediaType[]): { key: string; cats: string; types: MediaType[] }[] {
  const groups = new Map<string, { key: string; cats: string; types: MediaType[] }>();
  for (const type of types) {
    if (!indexer.mediaTypes.split(",").includes(type)) continue;
    const cats = categoriesFor(indexer.categories, categoriesForMediaType(type));
    const group = groups.get(cats) ?? { key: cats, cats, types: [] };
    group.types.push(type);
    groups.set(cats, group);
  }
  return Array.from(groups.values());
}

const MAX_RSS_PAGES = 3;

/** Whether a release is no newer than the marker: the one the marker names, or published before it. */
function reachedMarker(result: SearchResult, since: RssMarker): boolean {
  if (since.url && result.downloadUrl === since.url) return true;
  const sinceAt = since.at ? Date.parse(since.at) : NaN;
  const at = result.publishDate ? Date.parse(result.publishDate) : NaN;
  return Number.isFinite(sinceAt) && Number.isFinite(at) && at < sinceAt;
}

function markerOf(result: SearchResult | undefined): RssMarker | null {
  if (!result) return null;
  // A listing dated in the future (a wrong clock on the indexer) would hide every older release from the next read.
  const published = result.publishDate ? Date.parse(result.publishDate) : NaN;
  const at = Number.isFinite(published) && published > Date.now() ? new Date().toISOString() : result.publishDate;
  return { url: result.downloadUrl, at };
}

/**
 * The newest releases of an indexer's feed, read back to `since` (the newest release of the last
 * read; without one, the first page only). A Torznab/Newznab indexer is asked for the latest of the
 * categories with no query (tv-search or movie-search where it has them), a plain RSS indexer is its
 * whole feed. Counted against the indexer's hourly limit and its failure backoff like a search.
 */
export async function fetchRecentReleases(indexer: Indexer, group: { cats: string; types: MediaType[] }, since: RssMarker | null): Promise<RecentFeed> {
  if (isIndexerBackedOff(indexer.id)) throw new Error(backedOffMessage(indexer));
  if (isOverQueryLimit(indexer)) throw new Error(`Indexer "${indexer.name}" has hit its configured query limit for this hour — skipping`);
  recordQueryLimitRequest(indexer);
  const startedAt = Date.now();
  try {
    let feed: RecentFeed;
    if (indexer.protocol === "rss") {
      const items = await rssFeedItems(indexer, true);
      const all = items.map((item) => rssItemResult(indexer, item)).filter((r): r is IndexerSearchResult => r !== null);
      const results: IndexerSearchResult[] = [];
      for (const result of all) {
        if (since && reachedMarker(result, since)) break;
        results.push(result);
      }
      feed = { results, newest: markerOf(all[0]) };
    } else if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      feed = await recentFromApi(indexer, group, since);
    } else {
      return { results: [], newest: null };
    }
    consecutiveFailures.delete(indexer.id);
    if (backoffReason.get(indexer.id) === "failures") clearIndexerBackoff(indexer.id);
    await recordIndexerHealth(indexer.id, true, Date.now() - startedAt, null);
    return feed;
  } catch (err) {
    if (err instanceof IndexerBackedOffError) throw err;
    recordSearchFailure(indexer, err, startedAt, false);
    await recordIndexerHealth(indexer.id, false, Date.now() - startedAt, (err as Error).message);
    throw err;
  }
}

async function recentFromApi(indexer: Indexer, group: { cats: string; types: MediaType[] }, since: RssMarker | null): Promise<RecentFeed> {
  const caps = await getIndexerCaps(indexer);
  const allTv = group.types.every((t) => t === "series" || t === "anime");
  const allFilm = group.types.every((t) => t === "movie" || t === "ppv");
  const t = allTv && caps?.tv ? "tvsearch" : allFilm && caps?.movie ? "movie" : "search";
  const pageSize = caps?.pageSize ?? DEFAULT_PAGE_SIZE;
  const results: IndexerSearchResult[] = [];
  let newest: RssMarker | null = null;
  let received = 0;
  for (let page = 0; page < MAX_RSS_PAGES; page++) {
    if (page > 0) {
      if (queriesLeft(indexer) < 1) break;
      recordQueryLimitRequest(indexer);
    }
    const feed = await fetchTorznabFeed(indexer, apiUrlFor(indexer, group.cats, t, [], received, page > 0 ? pageSize : 0));
    throwIfIndexerApiError(indexer, feed);
    if (!hasRoot(feed, "rss")) throw new Error(`Indexer "${indexer.name}" returned a response with no <rss> feed`);
    const items = torznabResults(feed, indexer, group.cats);
    if (page === 0) newest = markerOf(items[0]);
    let reached = false;
    for (const result of items) {
      if (since && reachedMarker(result, since)) {
        reached = true;
        break;
      }
      results.push(result);
    }
    const count = rawItemCount(feed);
    received += count;
    // Without a marker (the first run) one page is the whole read; later the pages go on while they come back full and the marker has not been reached.
    if (!since || reached || count < pageSize) break;
  }
  return { results, newest };
}

async function searchIndexerCached(
  indexer: Indexer,
  query: string,
  mediaType: MediaType,
  externalIds?: Record<string, string>,
  hints?: SearchHints
): Promise<SearchResult[]> {
  const key = cacheKey(indexer.id, query, mediaType, externalIds, hints);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  if (cached) searchCache.delete(key);

  const results = await searchIndexer(indexer, query, mediaType, externalIds, hints);
  const now = Date.now();
  pruneSearchCache(now);
  searchCache.delete(key);
  searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, results });
  return results;
}

/**
 * Common scene-release title normalizations, tried in order when the literal query comes back
 * empty — release groups often drop punctuation and articles entirely (indexers doing exact/near
 * matching on the raw title can miss "Mr. & Mrs. Smith" when the release is named
 * "Mr And Mrs Smith"). Each variant is only tried if every earlier one (including the original
 * query) returned nothing, and only the first variant that returns results is used — this isn't
 * meant to broaden a search that already worked, just to give an exact-match indexer a second
 * shot before giving up entirely.
 */
function generateSceneVariants(query: string): string[] {
  const variants = new Set<string>();

  const noPunctuation = foldDiacritics(query).replace(/[.:'"!?,()[\]#]/g, "").replace(/\s+/g, " ").trim();
  if (noPunctuation && noPunctuation !== query) variants.add(noPunctuation);

  const ampersandToAnd = noPunctuation.replace(/&/g, "and");
  if (ampersandToAnd !== noPunctuation) variants.add(ampersandToAnd);

  const andToAmpersand = noPunctuation.replace(/\band\b/gi, "&");
  if (andToAmpersand !== noPunctuation) variants.add(andToAmpersand);

  const noLeadingArticle = noPunctuation.replace(/^(the|a|an)\s+/i, "");
  if (noLeadingArticle && noLeadingArticle !== noPunctuation) variants.add(noLeadingArticle);

  const dotted = noPunctuation.replace(/\s+/g, ".");
  if (dotted !== noPunctuation) variants.add(dotted);

  variants.delete(query);
  return Array.from(variants);
}

/** What one query got from a set of indexers: the releases, and the indexers that answered with none
 * (one that failed answered nothing, and is not asked again for another form of the same search). */
interface SearchRun {
  results: SearchResult[];
  empty: Indexer[];
  /** How many of the indexers asked answered at all. */
  answered: number;
}

async function runSearch(
  applicable: Indexer[],
  query: string,
  mediaType: MediaType,
  bypassCache: boolean,
  externalIds?: Record<string, string>,
  hints?: SearchHints
): Promise<SearchRun> {
  if (applicable.length > 0) {
    log.info(`[indexerClient] searching ${applicable.length} indexer(s) for "${query}"`);
  }
  const settled = await Promise.allSettled(
    applicable.map((i) =>
      bypassCache ? searchIndexer(i, query, mediaType, externalIds, hints) : searchIndexerCached(i, query, mediaType, externalIds, hints)
    )
  );

  const results: SearchResult[] = [];
  const empty: Indexer[] = [];
  let answered = 0;
  settled.forEach((s, index) => {
    if (s.status === "fulfilled") {
      answered++;
      results.push(...s.value);
      if (s.value.length === 0) empty.push(applicable[index]);
    } else {
      log.warn("Indexer search failed:", s.reason?.message ?? s.reason);
    }
  });
  log.info(`[indexerClient] "${query}": queried ${applicable.length} indexer(s), ${results.length} result(s)`);
  return { results, empty, answered };
}

/** The most alternate-title queries one search runs besides its main one (each is a query against
 * every indexer's hourly limit). */
const MAX_ALTERNATE_QUERIES = 4;
const MAX_ALSO_QUERIES = 1;

/** A release is the same release however many of a search's queries found it. */
function dedupeReleases(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.indexerId ?? r.indexerName}:${r.downloadUrl || `${r.title}:${r.size}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `bypassCache: true` (used by the manual search UI) always hits indexers live; the scheduler's
 * auto-search leaves it on so repeated identical queries within the TTL window reuse results.
 * `hints` carry what the text does not: the season and episode (or date, or absolute number) for a
 * typed search, and the item's other titles.
 *
 * The other titles and the scene-name variants of the query are for an indexer the main search
 * found nothing at: one that answered it (with the id search, or the title search) does not need
 * the same search asked three more ways, and every extra query is a request the tracker counts. */
export async function searchAllIndexers(
  indexers: Indexer[],
  query: string,
  mediaType: MediaType,
  bypassCache = false,
  externalIds?: Record<string, string>,
  hints?: SearchHints
): Promise<SearchResult[]> {
  // A plain RSS feed cannot be searched, only read: with the RSS sync running (rssSync.ts) it is read
  // there, as Sonarr's TorrentRss is, and an automatic search leaves it out. A search the admin is
  // waiting for (bypassCache), or one that asks for the feeds, still looks through it.
  const feedsReadBySync = config.rssSyncIntervalMinutes > 0 && !bypassCache && !hints?.includeFeeds;
  const applicable = indexers.filter(
    (i) => i.enabled && i.mediaTypes.split(",").includes(mediaType) && !(feedsReadBySync && i.protocol === "rss")
  );
  const mainHints: SearchHints | undefined = bypassCache ? { ...hints, fresh: true } : hints;
  const textOnly: SearchHints = { skipTyped: true, fresh: bypassCache };

  const seenQueries = new Set([query.toLowerCase()]);
  const alternates = (hints?.alternateQueries ?? [])
    .filter((q) => {
      const key = q.trim().toLowerCase();
      if (!key || seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    })
    .slice(0, MAX_ALTERNATE_QUERIES);
  const main = await runSearch(applicable, query, mediaType, bypassCache, externalIds, mainHints);
  let results = main.results;
  let stillEmpty = main.empty;

  // The other form of the search, asked of every indexer that can take it.
  const also = (hints?.alsoQueries ?? [])
    .filter((q) => {
      const key = q.trim().toLowerCase();
      if (!key || seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    })
    .slice(0, MAX_ALSO_QUERIES);
  if (also.length > 0) {
    const open = applicable.filter(
      (i) => (i.protocol === "torznab" || i.protocol === "newznab") && !isIndexerBackedOff(i.id) && queriesLeft(i) >= also.length * 2
    );
    if (open.length > 0) {
      const runs = await Promise.all(also.map((q) => runSearch(open, q, mediaType, bypassCache, externalIds, textOnly)));
      const found = runs.flatMap((run) => run.results);
      results = dedupeReleases([...results, ...found]);
      const answered = new Set(found.map((r) => r.indexerId));
      stillEmpty = stillEmpty.filter((i) => !answered.has(i.id));
    }
  }

  // The alternate titles run together, over the indexers that found nothing and can take them: a
  // Torznab/Newznab one that is not backed off (the main query may just have been rate limited)
  // and has room in its hourly limit for them twice over, so a search's extras never use up what
  // the next item's main query needs. A feed or API that ignores the query is not asked again.
  if (alternates.length > 0 && stillEmpty.length > 0) {
    const open = stillEmpty.filter(
      (i) => (i.protocol === "torznab" || i.protocol === "newznab") && !isIndexerBackedOff(i.id) && queriesLeft(i) >= alternates.length * 2
    );
    if (open.length > 0) {
      const runs = await Promise.all(alternates.map((q) => runSearch(open, q, mediaType, bypassCache, externalIds, textOnly)));
      const found = runs.flatMap((run) => run.results);
      results = dedupeReleases([...results, ...found]);
      const answered = new Set(found.map((r) => r.indexerId));
      stillEmpty = stillEmpty.filter((i) => !answered.has(i.id));
    }
  }

  // Release groups drop punctuation and articles: an exact-match indexer that found nothing gets
  // the query in the forms a scene name takes, one form at a time, until it finds something.
  let pending = stillEmpty.filter((i) => i.protocol !== "rss");
  for (const variant of generateSceneVariants(query)) {
    if (pending.length === 0) break;
    if (seenQueries.has(variant.toLowerCase())) continue;
    seenQueries.add(variant.toLowerCase());
    const run = await runSearch(pending, variant, mediaType, bypassCache, externalIds, textOnly);
    if (run.results.length > 0) {
      log.info(`[indexerClient] scene-name fallback "${variant}" found results where "${query}" found none`);
      results = dedupeReleases([...results, ...run.results]);
    }
    pending = run.empty;
  }

  const sorted = results.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  searchReaches.set(sorted, { applicable: applicable.length, answered: main.answered });
  return sorted;
}
