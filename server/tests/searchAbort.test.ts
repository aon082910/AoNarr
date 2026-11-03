import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// A search whose caller has gone away sends nothing to the indexers (each query counts against an hourly limit).
beforeAll(async () => {
  await setupTestDb();
});

const FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel></channel></rss>`;

const indexer = {
  id: 1,
  name: "A",
  protocol: "newznab",
  url: "http://a.invalid/api",
  apiKey: "k",
  categories: "",
  mediaTypes: "movie,series",
  enabled: 1,
  priority: 25,
  minimumSeeders: 0,
  config: null,
  useFlareSolverr: 0,
  queryLimitPerHour: null,
} as any;

describe("searchAllIndexers with a signal", () => {
  it("sends no request when the signal is already aborted", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(FEED, { status: 200, headers: { "content-type": "application/xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { searchAllIndexers } = await import("../src/services/indexerClient.js");
    const aborter = new AbortController();
    aborter.abort();

    const out = await searchAllIndexers([indexer], "Show S01", "series", true, {}, { signal: aborter.signal } as any);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("still asks the indexer while the signal is quiet", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(FEED, { status: 200, headers: { "content-type": "application/xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { searchAllIndexers } = await import("../src/services/indexerClient.js");

    await searchAllIndexers([indexer], "Show S01", "series", true, {}, { signal: new AbortController().signal } as any);

    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
