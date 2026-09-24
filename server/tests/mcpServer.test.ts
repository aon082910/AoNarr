import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupTestDb } from "./helpers/testDb.js";

interface ApiCall {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: any;
}

let client: Client | null = null;

beforeAll(async () => {
  await setupTestDb();
});

afterEach(async () => {
  await client?.close();
  client = null;
  vi.unstubAllGlobals();
});

/** Every MCP tool is a loopback call onto AoNarr's own REST API — record those calls instead. */
function stubApi(responseBody: unknown = { id: 1 }): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      calls.push({
        method: String(init.method),
        pathname: parsed.pathname,
        query: parsed.searchParams,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
  return calls;
}

async function connect(): Promise<Client> {
  const { createAoNarrMcpServer } = await import("../src/mcp/server.js");
  const server = createAoNarrMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "aonarr-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// POST /api/media only inserts the row; episodes/albums/books are fetched from the externalIds by
// POST /api/metadata/import alone, so add_media used to create series/artists with no children.
describe("MCP add_media", () => {
  it("imports through /api/metadata/import when externalIds are given, passing search-result fields through", async () => {
    const calls = stubApi();
    const c = await connect();
    const result = await c.callTool({
      name: "add_media",
      arguments: {
        type: "series",
        title: "Some Show",
        year: 2020,
        externalIds: { tmdb: "1234" },
        releaseDate: "2020-01-05",
        backdropUrl: "https://img.example/backdrop.jpg",
        contentRating: "TV-14",
        genres: ["Drama"],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].pathname).toBe("/api/metadata/import");
    expect(calls[0].body).toMatchObject({
      type: "series",
      title: "Some Show",
      externalIds: { tmdb: "1234" },
      releaseDate: "2020-01-05",
      backdropUrl: "https://img.example/backdrop.jpg",
      contentRating: "TV-14",
      genres: ["Drama"],
      monitored: 1,
    });
  });

  it("falls back to the manual-add route when there are no externalIds", async () => {
    const calls = stubApi();
    const c = await connect();
    await c.callTool({ name: "add_media", arguments: { type: "movie", title: "Home Video", monitored: false } });
    await c.callTool({ name: "add_media", arguments: { type: "movie", title: "Home Video 2", externalIds: {} } });
    expect(calls.map((call) => call.pathname)).toEqual(["/api/media", "/api/media"]);
    expect(calls[0].body).toMatchObject({ type: "movie", title: "Home Video", monitored: 0 });
  });

  it("rejects an unknown media type without calling the API", async () => {
    const calls = stubApi();
    const c = await connect();
    const result = await c.callTool({ name: "add_media", arguments: { type: "movies", title: "Typo", externalIds: { tmdb: "1" } } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('Unknown media type "movies"');
    expect(calls).toHaveLength(0);
  });
});

// GET /api/media defaults to a 60-item page; list_media had no way to see past it.
describe("MCP list_media", () => {
  it("requests a 500-item first page by default", async () => {
    const calls = stubApi({ items: [], total: 0 });
    const c = await connect();
    await c.callTool({ name: "list_media", arguments: { type: "movie" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe("/api/media");
    expect(calls[0].query.get("type")).toBe("movie");
    expect(calls[0].query.get("limit")).toBe("500");
    expect(calls[0].query.get("offset")).toBe("0");
    expect(calls[0].query.has("status")).toBe(false);
  });

  it("passes status, limit and offset through for paging", async () => {
    const calls = stubApi({ items: [], total: 900 });
    const c = await connect();
    await c.callTool({ name: "list_media", arguments: { type: "movie", status: "missing", limit: 100, offset: 200 } });
    expect(calls[0].query.get("status")).toBe("missing");
    expect(calls[0].query.get("limit")).toBe("100");
    expect(calls[0].query.get("offset")).toBe("200");
  });
});
