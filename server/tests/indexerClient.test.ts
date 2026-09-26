import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { Indexer } from "../src/types/index.js";

let checkIndexerHealth: (typeof import("../src/services/indexerClient.js"))["checkIndexerHealth"];
let isIndexerBackedOff: (typeof import("../src/services/indexerClient.js"))["isIndexerBackedOff"];
let searchIndexer: (typeof import("../src/services/indexerClient.js"))["searchIndexer"];
let searchAllIndexers: (typeof import("../src/services/indexerClient.js"))["searchAllIndexers"];
let getMediaTypeConfig: (typeof import("../src/services/mediaTypes.js"))["getMediaTypeConfig"];
let searchCacheSize: (typeof import("../src/services/indexerClient.js"))["searchCacheSize"];
let INDEXER_MEDIA_TYPES: string[];
let DEFAULT_INDEXER_MEDIA_TYPES: string;

beforeAll(async () => {
  // indexerClient.ts imports logger.js/settingsStore.js, which touch config.js/db/index.js.
  await setupTestDb();
  ({
    checkIndexerHealth,
    isIndexerBackedOff,
    searchIndexer,
    searchAllIndexers,
    searchCacheSize,
    INDEXER_MEDIA_TYPES,
    DEFAULT_INDEXER_MEDIA_TYPES,
  } = await import("../src/services/indexerClient.js"));
  ({ getMediaTypeConfig } = await import("../src/services/mediaTypes.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// backoffUntil/requestTimestamps/searchCache are module-private Maps keyed by indexer id that
// persist across every test in this file — a unique id per indexer keeps tests fully isolated
// without needing to reset that state.
let nextId = 100_000;
function makeIndexer(overrides: Partial<Indexer> = {}): Indexer {
  return {
    id: nextId++,
    name: "Test Indexer",
    protocol: "torznab",
    url: "https://idx.example.com",
    apiKey: "test-api-key",
    categories: "",
    mediaTypes: "movie,series",
    enabled: 1,
    priority: 25,
    config: null,
    useFlareSolverr: 0,
    queryLimitPerHour: null,
    ...overrides,
  };
}

function torznabXml(itemsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel><title>Test Indexer</title>
${itemsXml}
</channel></rss>`;
}

function torznabItem(opts: {
  title: string;
  downloadUrl: string;
  size?: number;
  pubDate?: string;
  seeders?: number;
  peers?: number;
  leechers?: number;
  dlvf?: number;
  imdb?: string;
  tmdbid?: string;
}): string {
  const attrs: string[] = [];
  if (opts.seeders !== undefined) attrs.push(`<torznab:attr name="seeders" value="${opts.seeders}"/>`);
  if (opts.peers !== undefined) attrs.push(`<torznab:attr name="peers" value="${opts.peers}"/>`);
  if (opts.leechers !== undefined) attrs.push(`<torznab:attr name="leechers" value="${opts.leechers}"/>`);
  if (opts.dlvf !== undefined) attrs.push(`<torznab:attr name="downloadvolumefactor" value="${opts.dlvf}"/>`);
  if (opts.imdb !== undefined) attrs.push(`<torznab:attr name="imdb" value="${opts.imdb}"/>`);
  if (opts.tmdbid !== undefined) attrs.push(`<torznab:attr name="tmdbid" value="${opts.tmdbid}"/>`);
  return `<item>
    <title>${opts.title}</title>
    <link>${opts.downloadUrl}</link>
    <enclosure url="${opts.downloadUrl}" length="${opts.size ?? 0}" type="application/x-bittorrent"/>
    ${opts.pubDate ? `<pubDate>${opts.pubDate}</pubDate>` : ""}
    ${attrs.join("\n")}
  </item>`;
}

const CAPS_XML = '<?xml version="1.0" encoding="UTF-8"?><caps><searching><search available="yes" supportedParams="q"/></searching></caps>';

function rssXml(itemsXml: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${itemsXml}</channel></rss>`;
}

describe("checkIndexerHealth", () => {
  it("builds the torznab/newznab caps URL with apikey", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => CAPS_XML });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", url: "https://idx.example.com/", apiKey: "abc123" });

    await checkIndexerHealth(indexer);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://idx.example.com/api");
    expect(calledUrl.searchParams.get("t")).toBe("caps");
    expect(calledUrl.searchParams.get("apikey")).toBe("abc123");
  });

  it("uses the indexer's URL directly for rss/ddl protocols", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "rss", url: "https://feed.example.com/rss.xml" });

    await checkIndexerHealth(indexer);

    expect(fetchMock.mock.calls[0][0]).toBe("https://feed.example.com/rss.xml");
  });

  it("ddl: probes the substituted template with the same bearer key a search sends, never via FlareSolverr", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("flaresolverrUrl", "http://fs.local");
    try {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal("fetch", fetchMock);
      const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", apiKey: "ddl-key", useFlareSolverr: 1 });

      await expect(checkIndexerHealth(indexer)).resolves.toEqual({ ok: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://ddl.example.com/search?q=test");
      expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer ddl-key");
    } finally {
      setSetting("flaresolverrUrl", "");
    }
  });

  it("ddl: reports the HTTP status when the API rejects the probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}" });

    await expect(checkIndexerHealth(indexer)).resolves.toEqual({ ok: false, error: "HTTP 401" });
  });

  it("returns ok:false with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));

    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: false, error: "HTTP 503" });
  });

  it("returns ok:true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => CAPS_XML }));

    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: true });
  });

  it("returns ok:false with the error message when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const health = await checkIndexerHealth(makeIndexer());

    expect(health.ok).toBe(false);
    expect(health.error).toContain("ENOTFOUND");
  });

  it("short-circuits without calling fetch when the indexer is already backed off", async () => {
    const indexer = makeIndexer({ protocol: "rss" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }));
    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow(); // triggers backoff as a side effect

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const health = await checkIndexerHealth(indexer);

    expect(health).toEqual({ ok: false, error: "Backed off after a recent 429" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("network retry — transient failures get one retry, real HTTP responses never do", () => {
  it("retries once after a transient error (message-matched 'fetch failed') and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => CAPS_XML });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once after a transient error identified by err.code, including when nested under err.cause.code", async () => {
    const codeErr = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    let fetchMock = vi.fn().mockRejectedValueOnce(codeErr).mockResolvedValueOnce({ ok: true, status: 200, text: async () => CAPS_XML });
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const causeErr = Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    fetchMock = vi.fn().mockRejectedValueOnce(causeErr).mockResolvedValueOnce({ ok: true, status: 200, text: async () => CAPS_XML });
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient error, and only retries once (not in a loop) for a repeatedly-failing transient one", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("totally unrelated failure"));
    vi.stubGlobal("fetch", fetchMock);
    const health = await checkIndexerHealth(makeIndexer());
    expect(health).toEqual({ ok: false, error: "totally unrelated failure" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const flakyMock = vi.fn().mockRejectedValue(Object.assign(new Error("still down"), { code: "ECONNREFUSED" }));
    vi.stubGlobal("fetch", flakyMock);
    const stillFailing = await checkIndexerHealth(makeIndexer());
    expect(stillFailing.ok).toBe(false);
    expect(flakyMock).toHaveBeenCalledTimes(2); // exactly one retry attempted, then gives up
  });

  it("the retry also applies to a real search, so a transient blip doesn't fail an otherwise-healthy indexer's search", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("dns blip"), { code: "ENOTFOUND" }))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: "Recovered", downloadUrl: "https://idx.example.com/dl/retry" })) });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");
    expect(results[0].title).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("FlareSolverr proxying", () => {
  it("POSTs through FlareSolverr's /v1 endpoint only for an indexer that opted in, stripping a trailing slash from the configured URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok", solution: { status: 200, response: torznabXml("") } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("flaresolverrUrl", "http://fs.local/");

    await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000", useFlareSolverr: 1 }), "q", "movie");

    expect(fetchMock.mock.calls[0][0]).toBe("http://fs.local/v1"); // not a double slash
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.cmd).toBe("request.get");
    expect(body.url).toContain("idx.example.com");
  });

  it("an indexer that hasn't opted in never uses FlareSolverr even when it's configured instance-wide", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("flaresolverrUrl", "http://fs.local");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);

    await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000", useFlareSolverr: 0 }), "q", "movie");

    expect(fetchMock.mock.calls[0][0]).toContain("idx.example.com"); // hit the indexer directly, not fs.local
  });

  it("throws using FlareSolverr's own message when it reports it couldn't resolve the page, and surfaces its own HTTP failure", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("flaresolverrUrl", "http://fs.local");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "error", message: "Cloudflare challenge failed" }) }));
    await expect(checkIndexerHealth(makeIndexer({ useFlareSolverr: 1 }))).resolves.toEqual({ ok: false, error: 'FlareSolverr could not resolve "https://idx.example.com/api?t=caps&apikey=test-api-key": Cloudflare challenge failed' });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(checkIndexerHealth(makeIndexer({ useFlareSolverr: 1 }))).resolves.toEqual({ ok: false, error: "FlareSolverr request failed: HTTP 502" });

    setSetting("flaresolverrUrl", "");
  });
});

describe("searchIndexer — torznab/newznab", () => {
  it("builds the search URL with t=search, q, cat, and apikey", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", categories: "2000,2010", apiKey: "key1" });

    await searchIndexer(indexer, "The Matrix", "movie");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://idx.example.com/api");
    expect(url.searchParams.get("t")).toBe("search");
    expect(url.searchParams.get("q")).toBe("The Matrix");
    expect(url.searchParams.get("cat")).toBe("2000,2010");
    expect(url.searchParams.get("apikey")).toBe("key1");
  });

  it("falls back to the media type's default category when the indexer has none configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);

    await searchIndexer(makeIndexer({ protocol: "torznab", categories: "" }), "q", "movie");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("cat")).toBe(getMediaTypeConfig("movie").indexerCategory);
  });

  it("parses items into SearchResult[], deriving leechers from peers-seeders when no leechers attr is present", async () => {
    const xml = torznabXml(
      torznabItem({
        title: "The.Matrix.1999.1080p",
        downloadUrl: "https://idx.example.com/dl/1",
        size: 5_000_000_000,
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
        seeders: 100,
        peers: 130,
        dlvf: 0,
      })
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));
    const indexer = makeIndexer({ protocol: "torznab", categories: "2000" });

    const results = await searchIndexer(indexer, "q", "movie");

    expect(results).toEqual([
      {
        indexerId: indexer.id,
        indexerName: indexer.name,
        title: "The.Matrix.1999.1080p",
        size: 5_000_000_000,
        seeders: 100,
        leechers: 30,
        publishDate: "Mon, 01 Jan 2024 00:00:00 GMT",
        downloadUrl: "https://idx.example.com/dl/1",
        protocol: "torrent",
        category: "2000",
        downloadVolumeFactor: 0,
        imdbId: null,
        tmdbId: null,
      },
    ]);
  });

  it("reads imdb/tmdbid torznab:attr fields off a result, when the indexer reports them", async () => {
    const xml = torznabXml(torznabItem({ title: "The.Matrix.1999.1080p", downloadUrl: "https://idx.example.com/dl/9", imdb: "0133093", tmdbid: "603" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(results[0].imdbId).toBe("tt0133093"); // "tt" prefix added when the indexer reports a bare number
    expect(results[0].tmdbId).toBe("603");
  });

  it("keeps an indexer-reported imdb id that already carries the tt prefix as-is", async () => {
    const xml = torznabXml(torznabItem({ title: "x", downloadUrl: "https://idx.example.com/dl/10", imdb: "tt0133093" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(results[0].imdbId).toBe("tt0133093");
  });

  it("appends imdbid/tmdbid query params for a movie-shaped search when given, stripping any 'tt' prefix from the imdb id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);

    await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "The Matrix", "movie", { imdb: "tt0133093", tmdb: "603" });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("imdbid")).toBe("0133093");
    expect(url.searchParams.get("tmdbid")).toBe("603");
  });

  it("never appends imdbid/tmdbid for a non movie/TV-shaped type (no such id space for it)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);

    await searchIndexer(makeIndexer({ protocol: "torznab", categories: "3000", mediaTypes: "artist" }), "Some Artist", "artist", { imdb: "tt0133093" });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.has("imdbid")).toBe(false);
  });

  it("uses an explicit leechers attr instead of deriving it, when present", async () => {
    const xml = torznabXml(torznabItem({ title: "x", downloadUrl: "https://idx.example.com/dl/2", seeders: 10, peers: 50, leechers: 5 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(results[0].leechers).toBe(5); // not the derived 50-10=40
  });

  it("maps newznab to the usenet protocol", async () => {
    const xml = torznabXml(torznabItem({ title: "x", downloadUrl: "https://idx.example.com/dl/3" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "newznab", categories: "5000" }), "q", "movie");

    expect(results[0].protocol).toBe("usenet");
  });

  it("falls back to <link> when an item has no enclosure", async () => {
    const xml = torznabXml(`<item><title>No Enclosure</title><link>https://idx.example.com/dl/4</link></item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(results[0].downloadUrl).toBe("https://idx.example.com/dl/4");
  });

  it("returns an empty array when the feed has no items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") }));

    await expect(searchIndexer(makeIndexer({ protocol: "torznab" }), "q", "movie")).resolves.toEqual([]);
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));

    await expect(searchIndexer(makeIndexer({ protocol: "torznab" }), "q", "movie")).rejects.toThrow("HTTP 500");
  });
});

describe("searchIndexer — rss", () => {
  it("only returns items whose title matches the query, case-insensitively", async () => {
    const xml = rssXml(`
      <item><title>The Matrix 1999</title><link>https://feed.example.com/1</link></item>
      <item><title>Some Other Movie</title><link>https://feed.example.com/2</link></item>
    `);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const results = await searchIndexer(makeIndexer({ protocol: "rss" }), "matrix", "movie");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("The Matrix 1999");
    expect(results[0]).toMatchObject({ seeders: null, leechers: null, protocol: "http", category: null });
  });

  it("skips a matching item that has no resolvable downloadUrl", async () => {
    const xml = rssXml(`<item><title>Matrix No Link</title></item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    await expect(searchIndexer(makeIndexer({ protocol: "rss" }), "matrix", "movie")).resolves.toEqual([]);
  });
});

describe("searchIndexer — ddl", () => {
  const ddlConfig = {
    titleField: "name",
    downloadUrlField: "dl",
    resultsPath: "results",
    sizeField: "size",
    seedersField: "peers",
    publishDateField: "date",
  };

  it("throws when the indexer's config isn't valid JSON", async () => {
    await expect(searchIndexer(makeIndexer({ protocol: "ddl", config: "{not json" }), "q", "movie")).rejects.toThrow(
      "invalid DDL config JSON"
    );
  });

  it("throws when titleField/downloadUrlField are missing from the config", async () => {
    await expect(
      searchIndexer(makeIndexer({ protocol: "ddl", config: JSON.stringify({ resultsPath: "results" }) }), "q", "movie")
    ).rejects.toThrow("missing titleField/downloadUrlField");
  });

  it("substitutes {query} into the URL and sends a Bearer auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({
      protocol: "ddl",
      url: "https://ddl.example.com/search?q={query}",
      apiKey: "ddl-key",
      config: JSON.stringify(ddlConfig),
    });

    await searchIndexer(indexer, "Some Movie", "movie");

    expect(fetchMock.mock.calls[0][0]).toBe("https://ddl.example.com/search?q=Some%20Movie");
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer ddl-key");
  });

  it("maps fields via dot path and skips an item missing a title or downloadUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { name: "Good Release", dl: "https://ddl.example.com/dl/1", size: 123456, peers: 42, date: "2024-01-01" },
          { name: "Missing Download URL" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", config: JSON.stringify(ddlConfig) });

    const results = await searchIndexer(indexer, "q", "movie");

    expect(results).toEqual([
      {
        indexerId: indexer.id,
        indexerName: indexer.name,
        title: "Good Release",
        size: 123456,
        seeders: 42,
        leechers: null,
        publishDate: "2024-01-01",
        downloadUrl: "https://ddl.example.com/dl/1",
        protocol: "http",
        category: null,
      },
    ]);
  });

  it("reads a human-readable size (1024-based units, thousands separators) as whole bytes", async () => {
    const sizes: [unknown, number][] = [
      ["1.4 GB", Math.round(1.4 * 1024 ** 3)],
      ["700 MB", 700 * 1024 ** 2],
      ["1,234.5 MiB", Math.round(1234.5 * 1024 ** 2)],
      ["2.1GiB", Math.round(2.1 * 1024 ** 3)],
      ["512 kb", 512 * 1024],
      ["1 TiB", 1024 ** 4],
      ["123456", 123456],
      ["1,234,567", 1234567],
      [123456.7, 123457],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: sizes.map(([size], i) => ({ name: `Release ${i}`, dl: `https://ddl.example.com/dl/${i}`, size })) }),
      })
    );
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", config: JSON.stringify(ddlConfig) });

    const results = await searchIndexer(indexer, "q", "movie");

    expect(results.map((r) => r.size)).toEqual(sizes.map(([, bytes]) => bytes));
    for (const r of results) expect((r as { sizeKnown?: boolean }).sizeKnown).toBeUndefined();
  });

  it("leaves an unparseable or non-positive size unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: ["about 2 GB", "-5 MB", "0", "GB"].map((size, i) => ({ name: `Release ${i}`, dl: `https://ddl.example.com/dl/${i}`, size })),
        }),
      })
    );
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", config: JSON.stringify(ddlConfig) });

    for (const r of await searchIndexer(indexer, "q", "movie")) expect(r).toMatchObject({ size: 0, sizeKnown: false });
  });

  it("throws when resultsPath doesn't resolve to an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: "nope" }) }));
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", config: JSON.stringify(ddlConfig) });

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow('resultsPath "results" did not resolve to an array');
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const indexer = makeIndexer({ protocol: "ddl", url: "https://ddl.example.com/search?q={query}", config: JSON.stringify(ddlConfig) });

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow("HTTP 502");
  });
});

it("throws for an unrecognized protocol", async () => {
  await expect(searchIndexer(makeIndexer({ protocol: "carrier-pigeon" }), "q", "movie")).rejects.toThrow(
    'Unknown indexer protocol "carrier-pigeon"'
  );
});

describe("searchIndexer — 429 backoff", () => {
  it("backs off after a 429 and skips (without another request) on the next attempt", async () => {
    const indexer = makeIndexer({ protocol: "rss" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }));
    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow("HTTP 429");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow("backed off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not back off on a non-429 failure", async () => {
    const indexer = makeIndexer({ protocol: "rss" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow("HTTP 500");
    expect(isIndexerBackedOff(indexer.id)).toBe(false);
  });
});

describe("searchIndexer — per-hour query limit", () => {
  it("stops making requests once the configured hourly limit is hit, counting failed attempts too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "rss", queryLimitPerHour: 2 });

    await expect(searchIndexer(indexer, "q1", "movie")).rejects.toThrow("HTTP 500");
    await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow("HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(searchIndexer(indexer, "q3", "movie")).rejects.toThrow("hit its configured query limit");
    expect(fetchMock).toHaveBeenCalledTimes(2); // the third attempt never actually made a request
  });

  it("never limits when queryLimitPerHour is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", queryLimitPerHour: null });

    for (let i = 0; i < 5; i++) await searchIndexer(indexer, `q${i}`, "movie");

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("the limit is a rolling 1-hour window: a request older than an hour no longer counts against it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", queryLimitPerHour: 1 });

    vi.useFakeTimers();
    try {
      await searchIndexer(indexer, "q1", "movie");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow("hit its configured query limit");
      expect(fetchMock).toHaveBeenCalledTimes(1); // still just the first, blocked before any request

      vi.setSystemTime(Date.now() + 61 * 60 * 1000); // just past the 1-hour window
      await searchIndexer(indexer, "q3", "movie");
      expect(fetchMock).toHaveBeenCalledTimes(2); // the aged-out first request no longer counts
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("searchAllIndexers", () => {
  it("only searches enabled indexers whose mediaTypes include the target type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);
    const disabled = makeIndexer({ protocol: "torznab", enabled: 0 });
    const wrongType = makeIndexer({ protocol: "torznab", mediaTypes: "series,anime" });
    const applicable = makeIndexer({ protocol: "torznab", mediaTypes: "movie" });

    await searchAllIndexers([disabled, wrongType, applicable], "q-filter-test", "movie");

    // Only the applicable indexer's URL should ever have been requested.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(`idx.example.com`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sorts combined results by seeders descending, treating a missing seeders count as 0", async () => {
    const low = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000", url: "https://low.example.com" });
    const high = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000", url: "https://high.example.com" });
    const none = makeIndexer({ protocol: "rss", mediaTypes: "movie", url: "https://none.example.com/feed.xml" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://low.example.com")) {
          return { ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: "Low", downloadUrl: "https://low.example.com/dl", seeders: 5 })) };
        }
        if (url.startsWith("https://high.example.com")) {
          return { ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: "High", downloadUrl: "https://high.example.com/dl", seeders: 500 })) };
        }
        return { ok: true, status: 200, text: async () => rssXml(`<item><title>No Seeders q-sort-test</title><link>https://none.example.com/dl</link></item>`) };
      })
    );

    const results = await searchAllIndexers([low, high, none], "q-sort-test", "movie");

    expect(results.map((r) => r.title)).toEqual(["High", "Low", "No Seeders q-sort-test"]);
  });

  it("tries scene-name variants only when the literal query returns nothing, and stops at the first variant that works", async () => {
    // generateSceneVariants("Mr. & Mrs. Smith") strips punctuation first ("Mr & Mrs Smith"), then
    // among other variants produces "Mr and Mrs Smith" (a literal, lowercase "&"->"and" swap).
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      if (q === "Mr and Mrs Smith") {
        return { ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: "Mr.And.Mrs.Smith.2005", downloadUrl: "https://idx.example.com/dl/scene" })) };
      }
      return { ok: true, status: 200, text: async () => torznabXml("") };
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    const results = await searchAllIndexers([indexer], "Mr. & Mrs. Smith", "movie");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Mr.And.Mrs.Smith.2005");
    const queriesTried = fetchMock.mock.calls.map((c) => new URL(c[0] as string).searchParams.get("q"));
    expect(queriesTried[0]).toBe("Mr. & Mrs. Smith"); // literal query tried first
    expect(queriesTried).toContain("Mr and Mrs Smith"); // the variant that eventually worked
  });

  it("also tries the and->&, drop-leading-article, and space->dot variants (each in isolation)", async () => {
    async function tryVariant(query: string, matchingVariant: string, expectedResultTitle: string) {
      const fetchMock = vi.fn(async (url: string) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q === matchingVariant) {
          return { ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: expectedResultTitle, downloadUrl: `https://idx.example.com/dl/${encodeURIComponent(matchingVariant)}` })) };
        }
        return { ok: true, status: 200, text: async () => torznabXml("") };
      });
      vi.stubGlobal("fetch", fetchMock);
      const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });
      const results = await searchAllIndexers([indexer], query, "movie");
      expect(results.map((r) => r.title)).toEqual([expectedResultTitle]);
    }

    await tryVariant("Fast and Furious", "Fast & Furious", "Fast.And.Furious.2001"); // "and" -> "&"
    await tryVariant("The Office", "Office", "The.Office.US"); // drop leading "The "
    await tryVariant("Random Words Here", "Random.Words.Here", "Random.Words.Here.2020"); // spaces -> dots
  });

  it("returns [] without error when every scene variant also comes back empty, and tries nothing extra when the query has no applicable variant at all", async () => {
    const emptyMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", emptyMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    await expect(searchAllIndexers([indexer], "Random Words Here", "movie")).resolves.toEqual([]);

    // "Inception": no punctuation, no "&"/"and", no leading article, and a single word (so the
    // space->dot transform is a no-op too) -- every generateSceneVariants() branch is a no-op.
    emptyMock.mockClear();
    await expect(searchAllIndexers([indexer], "Inception", "movie")).resolves.toEqual([]);
    expect(emptyMock).toHaveBeenCalledTimes(1); // only the literal query -- no variants existed to try
  });

  it("never tries scene variants when the literal query already returns results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "Found It", downloadUrl: "https://idx.example.com/dl/found" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    await searchAllIndexers([indexer], "The Matrix!", "movie");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still returns one indexer's results when another indexer in the same search fails", async () => {
    const failing = makeIndexer({ protocol: "torznab", mediaTypes: "movie", apiKey: "failing" });
    const working = makeIndexer({ protocol: "torznab", mediaTypes: "movie", apiKey: "working" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get("apikey") === "failing") return { ok: false, status: 500, text: async () => "" };
        return { ok: true, status: 200, text: async () => torznabXml(torznabItem({ title: "Survivor", downloadUrl: "https://idx.example.com/dl/survivor" })) };
      })
    );

    const results = await searchAllIndexers([failing, working], "q-partial-failure", "movie");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Survivor");
  });
});

describe("searchAllIndexers — caching", () => {
  it("reuses cached results for the same indexer+query+mediaType (bypassCache=false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "Cached", downloadUrl: "https://idx.example.com/dl/c1", seeders: 5 })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    const first = await searchAllIndexers([indexer], "same query for caching", "movie");
    const second = await searchAllIndexers([indexer], "same query for caching", "movie");

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second call was served entirely from cache
  });

  it("always re-fetches when bypassCache is true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "Not Cached", downloadUrl: "https://idx.example.com/dl/nc1" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    await searchAllIndexers([indexer], "bypass query", "movie", true);
    await searchAllIndexers([indexer], "bypass query", "movie", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached plain-query result for the same query once external ids are given (they change the actual request URL)", async () => {
    // A non-empty response, so the empty-result scene-variant retry loop (generateSceneVariants)
    // never kicks in and adds extra fetch calls this test isn't about.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "id-cache query result", downloadUrl: "https://idx.example.com/dl/idcache" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    await searchAllIndexers([indexer], "id-cache query", "movie", false, undefined);
    await searchAllIndexers([indexer], "id-cache query", "movie", false, { imdb: "tt0133093" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("imdbid")).toBe("0133093");
  });
});

/** A result's size for size-bound checks: null when the indexer didn't report one. */
function reportedSize(result: { size: number }): number | null {
  return (result as { sizeKnown?: boolean }).sizeKnown === false ? null : result.size;
}

describe("Torznab/Newznab <error> documents", () => {
  const errorXml = (code: string, description: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><error code="${code}" description="${description}"/>`;

  it("a search that gets an <error> document with HTTP 200 fails with the indexer's code/description instead of returning 0 results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => errorXml("100", "Invalid API Key") }));
    const indexer = makeIndexer({ protocol: "torznab", categories: "2000" });

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow('Indexer "Test Indexer" error 100: Invalid API Key');
    expect(isIndexerBackedOff(indexer.id)).toBe(false);
  });

  it("records the failure in the indexer's health history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => errorXml("100", "Invalid API Key") }));
    const { db } = await import("../src/db/index.js");
    const id = Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Error Doc', 'torznab', 'https://idx.example.com')").run()).lastInsertRowid
    );

    await expect(searchIndexer(makeIndexer({ id, protocol: "torznab", categories: "2000" }), "q", "movie")).rejects.toThrow("error 100");

    const row = (await db.prepare("SELECT success, error FROM indexer_health WHERE indexer_id = ?").get(id)) as { success: number; error: string };
    expect(Number(row.success)).toBe(0);
    expect(row.error).toContain("Invalid API Key");
  });

  it("a request-limit error code (newznab 500) triggers the same backoff as an HTTP 429", async () => {
    const indexer = makeIndexer({ protocol: "newznab", categories: "2000" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => errorXml("500", "Request limit reached") }));
    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow("error 500: Request limit reached");
    expect(isIndexerBackedOff(indexer.id)).toBe(true);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow("backed off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 200 response that isn't an RSS feed at all (e.g. an HTML login page) fails instead of reading as 0 results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html><body><p>Login</p></body></html>" }));

    await expect(searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie")).rejects.toThrow("no <rss> feed");
  });

  it("the health check reports an <error> caps response as unhealthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => errorXml("100", "Invalid API Key") }));

    await expect(checkIndexerHealth(makeIndexer({ protocol: "torznab" }))).resolves.toEqual({
      ok: false,
      error: "Indexer error 100: Invalid API Key",
    });
  });

  it("the health check reports a 200 response with no <caps> element as unhealthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html><body>Jackett</body></html>" }));

    const health = await checkIndexerHealth(makeIndexer({ protocol: "newznab" }));
    expect(health.ok).toBe(false);
    expect(health.error).toContain("<caps>");
  });

  it("an empty channel is still a healthy search with no results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<rss version="2.0"><channel></channel></rss>' }));

    await expect(searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie")).resolves.toEqual([]);
  });
});

describe("imdbid/tmdbid rejected by the indexer (Jackett's 201 on an indexer without movie-imdb search)", () => {
  const unsupportedXml = (code = "201") =>
    `<?xml version="1.0" encoding="UTF-8"?><error code="${code}" description="eztv does not support the requested query. Please check the capabilities (t=caps)"/>`;
  const resultsXml = torznabXml(torznabItem({ title: "Show S01E01", downloadUrl: "https://idx.example.com/dl/ids" }));
  /** Rejects any request carrying an id param, answers a plain one with results. */
  function rejectIdsFetch() {
    return vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url).searchParams;
      const text = params.has("imdbid") || params.has("tmdbid") ? unsupportedXml() : resultsXml;
      return { ok: true, status: 200, text: async () => text };
    });
  }

  it("retries once without the id params and records a success, not a failure", async () => {
    const fetchMock = rejectIdsFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = await import("../src/db/index.js");
    const id = Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Id Reject', 'torznab', 'https://idx.example.com')").run()).lastInsertRowid
    );

    const results = await searchIndexer(makeIndexer({ id, categories: "5000" }), "Show", "series", { imdb: "tt0944947", tmdb: "1399" });

    expect(results.map((r) => r.title)).toEqual(["Show S01E01"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("imdbid")).toBe("0944947");
    const retryParams = new URL(fetchMock.mock.calls[1][0] as string).searchParams;
    expect(retryParams.has("imdbid")).toBe(false);
    expect(retryParams.has("tmdbid")).toBe(false);
    expect(retryParams.get("q")).toBe("Show");
    const rows = (await db.prepare("SELECT success FROM indexer_health WHERE indexer_id = ?").all(id)) as { success: number }[];
    expect(rows.map((r) => Number(r.success))).toEqual([1]);
  });

  it("later searches on that indexer leave the ids off instead of paying for a rejected request first", async () => {
    const indexer = makeIndexer({ categories: "2000" });
    vi.stubGlobal("fetch", rejectIdsFetch());
    await searchIndexer(indexer, "Movie", "movie", { imdb: "tt0133093" });

    const fetchMock = rejectIdsFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchIndexer(indexer, "Movie Two", "movie", { imdb: "tt0234215" })).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("imdbid")).toBe(false);
    // A different indexer still gets the ids.
    const other = rejectIdsFetch();
    vi.stubGlobal("fetch", other);
    await searchIndexer(makeIndexer({ categories: "2000" }), "Movie", "movie", { imdb: "tt0133093" });
    expect(new URL(other.mock.calls[0][0] as string).searchParams.get("imdbid")).toBe("0133093");
  });

  it("a 203 'function not available' reply to the id params is retried the same way", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (new URL(url).searchParams.has("tmdbid") ? unsupportedXml("203") : resultsXml),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchIndexer(makeIndexer({ categories: "2000" }), "Movie", "movie", { tmdb: "603" })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still fails when the plain query is rejected too, and keeps sending ids next time", async () => {
    const indexer = makeIndexer({ categories: "2000" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => unsupportedXml() }));
    await expect(searchIndexer(indexer, "Movie", "movie", { imdb: "tt0133093" })).rejects.toThrow("error 201");

    const fetchMock = rejectIdsFetch();
    vi.stubGlobal("fetch", fetchMock);
    await searchIndexer(indexer, "Movie", "movie", { imdb: "tt0133093" });
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("imdbid")).toBe("0133093");
  });

  it("never retries a 201 on a request that carried no id params, or any other error code", async () => {
    const plain = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => unsupportedXml() });
    vi.stubGlobal("fetch", plain);
    await expect(searchIndexer(makeIndexer({ categories: "2000" }), "Movie", "movie")).rejects.toThrow("error 201");
    expect(plain).toHaveBeenCalledTimes(1);

    const badKey = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Invalid API Key"/>',
    });
    vi.stubGlobal("fetch", badKey);
    await expect(searchIndexer(makeIndexer({ categories: "2000" }), "Movie", "movie", { imdb: "tt0133093" })).rejects.toThrow("error 100");
    expect(badKey).toHaveBeenCalledTimes(1);
  });
});

describe("Newznab attributes", () => {
  function newznabXml(itemsXml: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel><title>Usenet Indexer</title>${itemsXml}</channel></rss>`;
  }

  it("reads <newznab:attr> imdb/tmdbid/size the same way as <torznab:attr>", async () => {
    const xml = newznabXml(`<item>
      <title>The.Matrix.1999.1080p.BluRay-GRP</title>
      <link>https://nzb.example.com/get/1</link>
      <enclosure url="https://nzb.example.com/get/1.nzb" type="application/x-nzb"/>
      <newznab:attr name="size" value="8500000000"/>
      <newznab:attr name="imdb" value="0133093"/>
      <newznab:attr name="tmdbid" value="603"/>
    </item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const [result] = await searchIndexer(makeIndexer({ protocol: "newznab", categories: "2000" }), "q", "movie");

    expect(result).toMatchObject({ protocol: "usenet", imdbId: "tt0133093", tmdbId: "603", size: 8_500_000_000 });
    expect(reportedSize(result)).toBe(8_500_000_000);
  });

  it("uses a torznab size attr when the enclosure length is 0", async () => {
    const xml = torznabXml(`<item>
      <title>Sized By Attr</title>
      <enclosure url="https://idx.example.com/dl/attr" length="0" type="application/x-bittorrent"/>
      <torznab:attr name="size" value="1234567"/>
    </item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const [result] = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(result.size).toBe(1_234_567);
    expect(reportedSize(result)).toBe(1_234_567);
  });
});

describe("unknown release size", () => {
  it("torznab: an item with no length and no size attr is marked size-unknown, not a real 0 bytes", async () => {
    const xml = torznabXml(`<item><title>No Size</title><link>https://idx.example.com/dl/nosize</link></item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const [result] = await searchIndexer(makeIndexer({ protocol: "torznab", categories: "2000" }), "q", "movie");

    expect(result.size).toBe(0);
    expect((result as { sizeKnown?: boolean }).sizeKnown).toBe(false);
    expect(reportedSize(result)).toBeNull();
  });

  it("rss: an enclosure without a length is size-unknown", async () => {
    const xml = rssXml(`<item><title>Matrix Feed Item</title><enclosure url="https://feed.example.com/f.mkv" type="video/x-matroska"/></item>`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }));

    const [result] = await searchIndexer(makeIndexer({ protocol: "rss" }), "matrix", "movie");

    expect(reportedSize(result)).toBeNull();
  });

  it("ddl: no sizeField configured (or a non-numeric size) is size-unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ name: "No Size Field", dl: "https://ddl.example.com/1", size: "about 2 GB" }] }),
      })
    );
    const withoutField = makeIndexer({
      protocol: "ddl",
      url: "https://ddl.example.com/search?q={query}",
      config: JSON.stringify({ resultsPath: "results", titleField: "name", downloadUrlField: "dl" }),
    });
    const nonNumeric = makeIndexer({
      protocol: "ddl",
      url: "https://ddl.example.com/search?q={query}",
      config: JSON.stringify({ resultsPath: "results", titleField: "name", downloadUrlField: "dl", sizeField: "size" }),
    });

    expect((await searchIndexer(withoutField, "q", "movie"))[0]).toMatchObject({ size: 0, sizeKnown: false });
    expect((await searchIndexer(nonNumeric, "q", "movie"))[0]).toMatchObject({ size: 0, sizeKnown: false });
  });
});

describe("rss: protocol follows each item's enclosure", () => {
  async function protocolOf(itemXml: string): Promise<string> {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => rssXml(itemXml) }));
    const [result] = await searchIndexer(makeIndexer({ protocol: "rss" }), "release", "movie");
    return result.protocol;
  }

  it("a .torrent enclosure or a magnet link is a torrent, not a direct HTTP download", async () => {
    expect(
      await protocolOf(`<item><title>Release A</title><enclosure url="https://tracker.example.com/dl/1" length="1000" type="application/x-bittorrent"/></item>`)
    ).toBe("torrent");
    expect(await protocolOf(`<item><title>Release B</title><link>https://tracker.example.com/files/b.torrent?passkey=x</link></item>`)).toBe("torrent");
    expect(await protocolOf(`<item><title>Release C</title><link>magnet:?xt=urn:btih:abcdef&amp;dn=Release+C</link></item>`)).toBe("torrent");
  });

  it("an NZB enclosure is usenet, and anything else stays a direct HTTP download", async () => {
    expect(await protocolOf(`<item><title>Release D</title><enclosure url="https://nzb.example.com/get/4" type="application/x-nzb"/></item>`)).toBe("usenet");
    expect(await protocolOf(`<item><title>Release E</title><link>https://files.example.com/e.mkv</link></item>`)).toBe("http");
  });
});

describe("in-memory request state stays bounded", () => {
  it("expired search-cache entries are dropped instead of kept for the life of the process", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "Cache Bound", downloadUrl: "https://idx.example.com/dl/bound", size: 100 })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: "movie", categories: "2000" });

    vi.useFakeTimers();
    try {
      await searchAllIndexers([indexer], "cache bound one", "movie");
      await searchAllIndexers([indexer], "cache bound two", "movie");
      expect(searchCacheSize()).toBeGreaterThanOrEqual(2);

      vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past the 5-minute TTL
      await searchAllIndexers([indexer], "cache bound three", "movie");
      expect(searchCacheSize()).toBe(1); // every older entry, from this and earlier tests, is gone

      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
      await searchAllIndexers([indexer], "cache bound three", "movie"); // expired lookup, then a failed refetch
      expect(searchCacheSize()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests made while an indexer has no query limit aren't tracked (so they can't pile up or count later)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => torznabXml("") });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", queryLimitPerHour: null });

    for (let i = 0; i < 3; i++) await searchIndexer(indexer, `untracked ${i}`, "movie");

    indexer.queryLimitPerHour = 1;
    await searchIndexer(indexer, "first limited", "movie");
    await expect(searchIndexer(indexer, "second limited", "movie")).rejects.toThrow("hit its configured query limit");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("default indexer media types", () => {
  it("cover every indexer-searchable library type, including sports/ppv/anime, but not Online Videos or Podcasts", () => {
    for (const type of ["movie", "series", "anime", "sports", "ppv", "artist", "author", "audiobook", "comic", "manga", "rom", "course", "adult"]) {
      expect(INDEXER_MEDIA_TYPES).toContain(type);
    }
    expect(INDEXER_MEDIA_TYPES).not.toContain("video");
    expect(INDEXER_MEDIA_TYPES).not.toContain("podcast");
    expect(DEFAULT_INDEXER_MEDIA_TYPES.split(",")).toEqual(INDEXER_MEDIA_TYPES);
  });

  it("an indexer on the default list is searched for a Sports item", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => torznabXml(torznabItem({ title: "UFC.300.1080p", downloadUrl: "https://idx.example.com/dl/ufc" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const indexer = makeIndexer({ protocol: "torznab", mediaTypes: DEFAULT_INDEXER_MEDIA_TYPES });

    const results = await searchAllIndexers([indexer], "UFC 300", "sports");

    expect(results.map((r) => r.title)).toEqual(["UFC.300.1080p"]);
  });
});
