import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { Indexer } from "../src/types/index.js";

let checkIndexerHealth: (typeof import("../src/services/indexerClient.js"))["checkIndexerHealth"];
let isIndexerBackedOff: (typeof import("../src/services/indexerClient.js"))["isIndexerBackedOff"];
let searchIndexer: (typeof import("../src/services/indexerClient.js"))["searchIndexer"];
let searchAllIndexers: (typeof import("../src/services/indexerClient.js"))["searchAllIndexers"];
let getMediaTypeConfig: (typeof import("../src/services/mediaTypes.js"))["getMediaTypeConfig"];

beforeAll(async () => {
  // indexerClient.ts imports logger.js/settingsStore.js, which touch config.js/db/index.js.
  await setupTestDb();
  ({ checkIndexerHealth, isIndexerBackedOff, searchIndexer, searchAllIndexers } = await import("../src/services/indexerClient.js"));
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
}): string {
  const attrs: string[] = [];
  if (opts.seeders !== undefined) attrs.push(`<torznab:attr name="seeders" value="${opts.seeders}"/>`);
  if (opts.peers !== undefined) attrs.push(`<torznab:attr name="peers" value="${opts.peers}"/>`);
  if (opts.leechers !== undefined) attrs.push(`<torznab:attr name="leechers" value="${opts.leechers}"/>`);
  if (opts.dlvf !== undefined) attrs.push(`<torznab:attr name="downloadvolumefactor" value="${opts.dlvf}"/>`);
  return `<item>
    <title>${opts.title}</title>
    <link>${opts.downloadUrl}</link>
    <enclosure url="${opts.downloadUrl}" length="${opts.size ?? 0}" type="application/x-bittorrent"/>
    ${opts.pubDate ? `<pubDate>${opts.pubDate}</pubDate>` : ""}
    ${attrs.join("\n")}
  </item>`;
}

function rssXml(itemsXml: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${itemsXml}</channel></rss>`;
}

describe("checkIndexerHealth", () => {
  it("builds the torznab/newznab caps URL with apikey", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
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

  it("returns ok:false with the HTTP status on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));

    await expect(checkIndexerHealth(makeIndexer())).resolves.toEqual({ ok: false, error: "HTTP 503" });
  });

  it("returns ok:true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }));

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
      },
    ]);
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
});
