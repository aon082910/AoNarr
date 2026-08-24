import { log } from "./logger.js";
import { parseStringPromise } from "xml2js";
import { getMediaTypeConfig } from "./mediaTypes.js";
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

function cacheKey(indexerId: number, query: string, mediaType: MediaType): string {
  return `${indexerId}:${mediaType}:${query.toLowerCase()}`;
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
    const res = await fetch(url, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

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
    } else {
      url = indexer.url;
    }
    const res = await fetchIndexerText(url, indexer, 10_000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function searchTorznabNewznab(indexer: Indexer, query: string, mediaType: MediaType): Promise<SearchResult[]> {
  const url = new URL(indexer.url.replace(/\/+$/, "") + "/api");
  url.searchParams.set("t", "search");
  url.searchParams.set("q", query);
  const cats = indexer.categories?.trim() || categoriesForMediaType(mediaType);
  url.searchParams.set("cat", cats);
  if (indexer.apiKey) url.searchParams.set("apikey", indexer.apiKey);

  const res = await fetchIndexerText(url.toString(), indexer, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  const parsed = await parseStringPromise(res.text, { explicitArray: true, mergeAttrs: false });

  const items: any[] = parsed?.rss?.channel?.[0]?.item ?? [];
  const results: SearchResult[] = [];

  for (const item of items) {
    const title = item.title?.[0] ?? "unknown";
    const enclosure = item.enclosure?.[0]?.$;
    const downloadUrl = enclosure?.url ?? item.link?.[0] ?? "";
    const size = enclosure?.length ? Number(enclosure.length) : 0;
    const pubDate = item.pubDate?.[0] ?? null;

    let seeders: number | null = null;
    let peers: number | null = null;
    let leechers: number | null = null;
    const torznabAttrs: any[] = item["torznab:attr"] ?? item.attr ?? [];
    for (const attr of torznabAttrs) {
      const a = attr?.$;
      if (!a) continue;
      if (a.name === "seeders") seeders = Number(a.value);
      if (a.name === "peers") peers = Number(a.value);
      if (a.name === "leechers") leechers = Number(a.value);
    }
    // Torznab's "peers" attr is the TOTAL peer count (seeders + leechers), not the leecher count
    // on its own — most indexers only emit seeders/peers, not a separate leechers attr, so derive
    // it the same way Sonarr/Radarr's own Torznab parsers do rather than misreporting the total.
    if (leechers === null && peers !== null && seeders !== null) leechers = Math.max(0, peers - seeders);

    results.push({
      indexerId: indexer.id,
      indexerName: indexer.name,
      title,
      size,
      seeders,
      leechers,
      publishDate: pubDate,
      downloadUrl,
      protocol: indexer.protocol === "torznab" ? "torrent" : "usenet",
      category: cats,
    });
  }

  return results;
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

  const results: SearchResult[] = [];
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
      size: enclosure?.length ? Number(enclosure.length) : 0,
      seeders: null,
      leechers: null,
      publishDate: item.pubDate?.[0] ?? null,
      downloadUrl,
      protocol: "http",
      category: null,
    });
  }
  return results;
}

function getByDotPath(obj: any, dotPath: string | null | undefined): any {
  if (!dotPath) return obj;
  return dotPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
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
  const res = await fetch(url, {
    headers: indexer.apiKey ? { Authorization: `Bearer ${indexer.apiKey}` } : {},
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Indexer "${indexer.name}" returned HTTP ${res.status}`);
  const body = await res.json();

  const items = getByDotPath(body, cfg.resultsPath);
  if (!Array.isArray(items)) {
    throw new Error(`Indexer "${indexer.name}": resultsPath "${cfg.resultsPath ?? ""}" did not resolve to an array`);
  }

  const results: SearchResult[] = [];
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
      size: rawSize != null ? Number(rawSize) : 0,
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

export function isIndexerBackedOff(indexerId: number): boolean {
  const until = backoffUntil.get(indexerId);
  return !!until && until > Date.now();
}

function recordIfRateLimited(indexer: Indexer, err: unknown): void {
  if (err instanceof Error && /HTTP 429/.test(err.message)) {
    backoffUntil.set(indexer.id, Date.now() + BACKOFF_MS);
    log.warn(`[indexerClient] "${indexer.name}" returned 429 — backing off for ${BACKOFF_MS / 60000}m`);
  }
}

export async function searchIndexer(
  indexer: Indexer,
  query: string,
  mediaType: MediaType
): Promise<SearchResult[]> {
  if (isIndexerBackedOff(indexer.id)) {
    throw new Error(`Indexer "${indexer.name}" is backed off after a recent 429 — skipping`);
  }
  const startedAt = Date.now();
  try {
    let results: SearchResult[];
    if (indexer.protocol === "torznab" || indexer.protocol === "newznab") {
      results = await searchTorznabNewznab(indexer, query, mediaType);
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

async function searchIndexerCached(indexer: Indexer, query: string, mediaType: MediaType): Promise<SearchResult[]> {
  const key = cacheKey(indexer.id, query, mediaType);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const results = await searchIndexer(indexer, query, mediaType);
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, results });
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
  bypassCache: boolean
): Promise<SearchResult[]> {
  const settled = await Promise.allSettled(
    applicable.map((i) => (bypassCache ? searchIndexer(i, query, mediaType) : searchIndexerCached(i, query, mediaType)))
  );

  const results: SearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value);
    else log.warn("Indexer search failed:", s.reason?.message ?? s.reason);
  }
  return results;
}

/** `bypassCache: true` (used by the manual search UI) always hits indexers live; the scheduler's
 * auto-search leaves it on so repeated identical queries within the TTL window reuse results. */
export async function searchAllIndexers(
  indexers: Indexer[],
  query: string,
  mediaType: MediaType,
  bypassCache = false
): Promise<SearchResult[]> {
  const applicable = indexers.filter(
    (i) => i.enabled && i.mediaTypes.split(",").includes(mediaType)
  );

  let results = await runSearch(applicable, query, mediaType, bypassCache);

  if (results.length === 0) {
    for (const variant of generateSceneVariants(query)) {
      results = await runSearch(applicable, variant, mediaType, bypassCache);
      if (results.length > 0) {
        log.info(`[indexerClient] scene-name fallback "${variant}" found results where "${query}" found none`);
        break;
      }
    }
  }

  return results.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
}
