import { log } from "./logger.js";
import { parseStringPromise } from "xml2js";
import { getMediaTypeConfig, MEDIA_TYPE_KEYS } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";
import { recordIndexerHealth } from "./indexerHealth.js";
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

class IndexerRateLimitError extends Error {}

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

function cacheKey(indexerId: number, query: string, mediaType: MediaType, externalIds?: Record<string, string>): string {
  // imdb/tmdb ids (when present) change the actual request URL sent to the indexer (see
  // searchTorznabNewznab) — folded into the key so a cached result for the plain-title query can't
  // be wrongly reused for an id-narrowed request, or vice versa.
  const idPart = externalIds?.imdb || externalIds?.tmdb ? `:${externalIds.imdb ?? ""}:${externalIds.tmdb ?? ""}` : "";
  return `${indexerId}:${mediaType}:${query.toLowerCase()}${idPart}`;
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
async function fetchIndexerText(url: string, indexer: Indexer, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  const flaresolverrUrl = indexer.useFlareSolverr ? getSetting("flaresolverrUrl") : null;
  if (!flaresolverrUrl) {
    return withNetworkRetry(async () => {
      const res = await fetch(url, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
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
  if (isIndexerBackedOff(indexer.id)) {
    return { ok: false, error: "Backed off after a recent 429" };
  }
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

async function fetchTorznabFeed(indexer: Indexer, url: string): Promise<any> {
  const res = await fetchIndexerText(url, indexer, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  return parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });
}

async function searchTorznabNewznab(
  indexer: Indexer,
  query: string,
  mediaType: MediaType,
  externalIds?: Record<string, string>
): Promise<SearchResult[]> {
  const cats = indexer.categories?.trim() || categoriesForMediaType(mediaType);
  const searchUrl = (withIds: boolean): string => {
    const url = new URL(indexer.url.replace(/\/+$/, "") + "/api");
    url.searchParams.set("t", "search");
    url.searchParams.set("q", query);
    url.searchParams.set("cat", cats);
    if (indexer.apiKey) url.searchParams.set("apikey", indexer.apiKey);
    if (withIds) {
      if (externalIds?.imdb) url.searchParams.set("imdbid", externalIds.imdb.replace(/^tt/i, ""));
      if (externalIds?.tmdb) url.searchParams.set("tmdbid", externalIds.tmdb);
    }
    return url.toString();
  };
  // Best-effort narrowing for indexers that support Torznab's id-search params, retried without
  // them for one that rejects them. Only meaningful for movie/TV-shaped categories; other shapes
  // (music, books, ROMs, ...) have no such id space in Torznab's spec.
  const idParamsKey = `${indexer.id}:${indexer.url}`;
  const sendIds =
    ["movie", "series", "anime", "sports", "ppv"].includes(mediaType) &&
    !!(externalIds?.imdb || externalIds?.tmdb) &&
    !idParamsRejectedBy.has(idParamsKey);

  let parsed = await fetchTorznabFeed(indexer, searchUrl(sendIds));
  if (sendIds && ID_PARAMS_REJECTED_CODES.has(indexerApiError(parsed)?.code ?? "")) {
    parsed = await fetchTorznabFeed(indexer, searchUrl(false));
    if (!indexerApiError(parsed) && hasRoot(parsed, "rss")) idParamsRejectedBy.add(idParamsKey);
  }
  throwIfIndexerApiError(indexer, parsed);
  if (!hasRoot(parsed, "rss")) throw new Error(`Indexer "${indexer.name}" returned a response with no <rss> feed`);

  const items: any[] = parsed.rss?.channel?.[0]?.item ?? [];
  const results: IndexerSearchResult[] = [];

  for (const item of items) {
    const title = item.title?.[0] ?? "unknown";
    const enclosure = item.enclosure?.[0]?.$;
    const downloadUrl = enclosure?.url ?? item.link?.[0] ?? "";
    let rawSize: unknown = enclosure?.length;
    const pubDate = item.pubDate?.[0] ?? null;

    let seeders: number | null = null;
    let peers: number | null = null;
    let leechers: number | null = null;
    let downloadVolumeFactor: number | null = null;
    let imdbId: string | null = null;
    let tmdbId: string | null = null;
    // xml2js keeps namespace prefixes on element names: Torznab feeds use <torznab:attr>, Newznab
    // feeds (usenet indexers, NZBHydra, Prowlarr's usenet proxy) use <newznab:attr>.
    const torznabAttrs: any[] = [...(item["torznab:attr"] ?? []), ...(item["newznab:attr"] ?? []), ...(item.attr ?? [])];
    for (const attr of torznabAttrs) {
      const a = attr?.$;
      if (!a) continue;
      if (a.name === "size" && !(Number(rawSize) > 0)) rawSize = a.value;
      if (a.name === "seeders") seeders = Number(a.value);
      if (a.name === "peers") peers = Number(a.value);
      if (a.name === "leechers") leechers = Number(a.value);
      // Radarr/Sonarr's "freeleech"/"halfleech" custom-format specification reads the exact same
      // attribute — 0 means the download doesn't count against ratio at all (freeleech), 0.5 means
      // it counts at half (halfleech). Not every indexer emits this; absent means "unknown", not
      // "normal" — customFormatScoring.ts's indexerFlag condition treats those the same way (never
      // matches, so a "must be freeleech" condition group correctly excludes unknown-status results).
      if (a.name === "downloadvolumefactor") downloadVolumeFactor = Number(a.value);
      // Not every indexer reports these, but when one does it's a far stronger identity signal
      // than anything parsed out of the title text — see scheduler.ts's chooseBestResult.
      if (a.name === "imdb" || a.name === "imdbid") imdbId = /^tt/i.test(String(a.value)) ? String(a.value).toLowerCase() : `tt${a.value}`;
      if (a.name === "tmdbid") tmdbId = String(a.value);
    }
    // Torznab's "peers" attr is the TOTAL peer count (seeders + leechers), not the leecher count
    // on its own — most indexers only emit seeders/peers, not a separate leechers attr, so derive
    // it the same way Sonarr/Radarr's own Torznab parsers do rather than misreporting the total.
    if (leechers === null && peers !== null && seeders !== null) leechers = Math.max(0, peers - seeders);

    results.push({
      indexerId: indexer.id,
      indexerName: indexer.name,
      title,
      ...sizeFields(rawSize),
      seeders,
      leechers,
      publishDate: pubDate,
      downloadUrl,
      protocol: indexer.protocol === "torznab" ? "torrent" : "usenet",
      category: cats,
      downloadVolumeFactor,
      imdbId,
      tmdbId,
    });
  }

  return results;
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

/** Plain RSS 2.0 — no Torznab search-attr extensions assumed, so no seeders/category, and the
 * query can't be sent to the feed (many such feeds are a fixed "latest" list); results are
 * simply title-filtered client-side against the query. */
async function searchRss(indexer: Indexer, query: string): Promise<SearchResult[]> {
  const res = await fetchIndexerText(indexer.url, indexer, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  const parsed = await parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });
  const items: any[] = parsed?.rss?.channel?.[0]?.item ?? [];
  const needle = query.toLowerCase();

  const results: IndexerSearchResult[] = [];
  for (const item of items) {
    const title: string = item.title?.[0] ?? "unknown";
    if (!title.toLowerCase().includes(needle)) continue;
    const enclosure = item.enclosure?.[0]?.$;
    const downloadUrl = enclosure?.url ?? item.link?.[0] ?? "";
    if (!downloadUrl) continue;

    results.push({
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
    });
  }
  return results;
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
  const res = await fetchDdl(indexer, url, SEARCH_TIMEOUT_MS);
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

function recordIfRateLimited(indexer: Indexer, err: unknown): void {
  if (err instanceof IndexerRateLimitError || (err instanceof Error && /HTTP 429/.test(err.message))) {
    backoffUntil.set(indexer.id, Date.now() + BACKOFF_MS);
    log.warn(`[indexerClient] "${indexer.name}" is rate limiting requests — backing off for ${BACKOFF_MS / 60000}m`);
  }
}

export async function searchIndexer(
  indexer: Indexer,
  query: string,
  mediaType: MediaType,
  externalIds?: Record<string, string>
): Promise<SearchResult[]> {
  if (isIndexerBackedOff(indexer.id)) {
    throw new Error(`Indexer "${indexer.name}" is backed off after a recent 429 — skipping`);
  }
  if (isOverQueryLimit(indexer)) {
    throw new Error(`Indexer "${indexer.name}" has hit its configured query limit for this hour — skipping`);
  }
  recordQueryLimitRequest(indexer);
  const startedAt = Date.now();
  try {
    let results: SearchResult[];
    if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      results = await searchTorznabNewznab(indexer, query, mediaType, externalIds);
    } else if (indexer.protocol === "rss") {
      results = await searchRss(indexer, query);
    } else if (indexer.protocol === "ddl") {
      results = await searchDdl(indexer, query);
    } else {
      throw new Error(`Unknown indexer protocol "${indexer.protocol}"`);
    }
    await recordIndexerHealth(indexer.id, true, Date.now() - startedAt, null);
    return results;
  } catch (err) {
    recordIfRateLimited(indexer, err);
    await recordIndexerHealth(indexer.id, false, Date.now() - startedAt, (err as Error).message);
    throw err;
  }
}

async function searchIndexerCached(indexer: Indexer, query: string, mediaType: MediaType, externalIds?: Record<string, string>): Promise<SearchResult[]> {
  const key = cacheKey(indexer.id, query, mediaType, externalIds);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  if (cached) searchCache.delete(key);

  const results = await searchIndexer(indexer, query, mediaType, externalIds);
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

  const noPunctuation = query.replace(/[.:'"!?,]/g, "").replace(/\s+/g, " ").trim();
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

async function runSearch(
  applicable: Indexer[],
  query: string,
  mediaType: MediaType,
  bypassCache: boolean,
  externalIds?: Record<string, string>
): Promise<SearchResult[]> {
  const settled = await Promise.allSettled(
    applicable.map((i) =>
      bypassCache ? searchIndexer(i, query, mediaType, externalIds) : searchIndexerCached(i, query, mediaType, externalIds)
    )
  );

  const results: SearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value);
    else log.warn("Indexer search failed:", s.reason?.message ?? s.reason);
  }
  log.info(`[indexerClient] "${query}": queried ${applicable.length} indexer(s), ${results.length} result(s)`);
  return results;
}

/** `bypassCache: true` (used by the manual search UI) always hits indexers live; the scheduler's
 * auto-search leaves it on so repeated identical queries within the TTL window reuse results. */
export async function searchAllIndexers(
  indexers: Indexer[],
  query: string,
  mediaType: MediaType,
  bypassCache = false,
  externalIds?: Record<string, string>
): Promise<SearchResult[]> {
  const applicable = indexers.filter(
    (i) => i.enabled && i.mediaTypes.split(",").includes(mediaType)
  );

  let results = await runSearch(applicable, query, mediaType, bypassCache, externalIds);

  if (results.length === 0) {
    for (const variant of generateSceneVariants(query)) {
      results = await runSearch(applicable, variant, mediaType, bypassCache, externalIds);
      if (results.length > 0) {
        log.info(`[indexerClient] scene-name fallback "${variant}" found results where "${query}" found none`);
        break;
      }
    }
  }

  return results.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
}
