import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncFromJackett: (typeof import("../src/services/jackettSync.js"))["syncFromJackett"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  // jackettSync.ts imports db/index.js directly — must load after setupTestDb() has set env vars.
  ({ db } = await setupTestDb());
  ({ syncFromJackett } = await import("../src/services/jackettSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  setSetting("jackettUrl", "http://jackett.local:9117");
  setSetting("jackettApiKey", "test-api-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function indexerRowsByJackettId(id: string): Promise<any[]> {
  return (await db.prepare(`SELECT * FROM indexers WHERE config LIKE ?`).all(`%"jackettId":"${id}"%`)) as any[];
}

describe("syncFromJackett — configuration guard", () => {
  it("returns an error and never calls fetch when the URL/API key aren't configured", async () => {
    setSetting("jackettUrl", "");
    setSetting("jackettApiKey", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 0, error: "Jackett URL and API key must both be set" });
    expect(fetchMock).not.toHaveBeenCalled();

    setSetting("jackettUrl", "http://jackett.local:9117");
    setSetting("jackettApiKey", "test-api-key");
  });
});

describe("syncFromJackett — network failure handling", () => {
  it("reports the HTTP status when Jackett responds with a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await syncFromJackett();

    expect(result.synced).toBe(0);
    expect(result.error).toContain("HTTP 500");
  });

  it("reports the underlying error message when the request itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const result = await syncFromJackett();

    expect(result.synced).toBe(0);
    expect(result.error).toContain("getaddrinfo ENOTFOUND");
  });
});

describe("syncFromJackett — success path", () => {
  it("calls the Jackett configured-indexers endpoint with the API key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await syncFromJackett();

    expect(fetchMock).toHaveBeenCalledWith("http://jackett.local:9117/api/v2.0/indexers?configured=true", {
      headers: { "X-Api-Key": "test-api-key" },
    });
  });

  it("inserts a new torznab row per indexer with a URL-encoded proxy path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "my indexer", name: "My Indexer", configured: true }],
    }));

    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 1 });
    const [row] = await indexerRowsByJackettId("my indexer");
    expect(row).toMatchObject({
      name: "My Indexer",
      protocol: "torznab",
      url: "http://jackett.local:9117/api/v2.0/indexers/my%20indexer/results/torznab",
      api_key: "test-api-key",
      enabled: 1,
    });
  });

  it("updates the existing row on a re-sync instead of duplicating it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "eztv-sync", name: "EZTV Original", configured: true }],
    }));
    await syncFromJackett();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "eztv-sync", name: "EZTV Renamed", configured: true }],
    }));
    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 1 });
    const rows = await indexerRowsByJackettId("eztv-sync");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("EZTV Renamed");
  });

  it("skips a malformed indexer (DB constraint violation) but still syncs the others in the same batch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "batch-good-1", name: "Good One", configured: true },
        { id: "batch-bad", name: null, configured: true }, // violates indexers.name NOT NULL
        { id: "batch-good-2", name: "Good Two", configured: true },
      ],
    }));

    const result = await syncFromJackett();

    expect(result.synced).toBe(2);
    expect(await indexerRowsByJackettId("batch-good-1")).toHaveLength(1);
    expect(await indexerRowsByJackettId("batch-bad")).toHaveLength(0);
    expect(await indexerRowsByJackettId("batch-good-2")).toHaveLength(1);
  });
});
