import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncFromProwlarr: (typeof import("../src/services/prowlarrSync.js"))["syncFromProwlarr"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  // prowlarrSync.ts imports db/index.js directly — must load after setupTestDb() has set env vars.
  ({ db } = await setupTestDb());
  ({ syncFromProwlarr } = await import("../src/services/prowlarrSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  setSetting("prowlarrUrl", "http://prowlarr.local:9696");
  setSetting("prowlarrApiKey", "test-api-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function indexerRowsByPattern(idPattern: string): Promise<any[]> {
  return (await db.prepare(`SELECT * FROM indexers WHERE config LIKE ?`).all(`%"prowlarrId":${idPattern}}%`)) as any[];
}

describe("syncFromProwlarr — configuration guard", () => {
  it("returns an error and never calls fetch when the URL/API key aren't configured", async () => {
    setSetting("prowlarrUrl", "");
    setSetting("prowlarrApiKey", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncFromProwlarr();

    expect(result).toEqual({ synced: 0, error: "Prowlarr URL and API key must both be set" });
    expect(fetchMock).not.toHaveBeenCalled();

    setSetting("prowlarrUrl", "http://prowlarr.local:9696");
    setSetting("prowlarrApiKey", "test-api-key");
  });
});

describe("syncFromProwlarr — network failure handling", () => {
  it("reports the HTTP status when Prowlarr responds with a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const result = await syncFromProwlarr();

    expect(result.synced).toBe(0);
    expect(result.error).toContain("HTTP 401");
  });

  it("reports the underlying error message when the request itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await syncFromProwlarr();

    expect(result.synced).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("syncFromProwlarr — success path", () => {
  it("calls the Prowlarr indexer API with the configured URL and API key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await syncFromProwlarr();

    expect(fetchMock).toHaveBeenCalledWith("http://prowlarr.local:9696/api/v1/indexer", {
      headers: { "X-Api-Key": "test-api-key" },
    });
  });

  it("inserts a new row per indexer, mapping usenet/torrent protocols and building the proxy URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 9001, name: "NZB Haven", protocol: "usenet", enable: true },
        { id: 9002, name: "Torrent Town", protocol: "torrent", enable: false },
      ],
    }));

    const result = await syncFromProwlarr();

    expect(result).toEqual({ synced: 2 });
    const [nzb] = await indexerRowsByPattern("9001");
    expect(nzb).toMatchObject({
      name: "NZB Haven",
      protocol: "newznab",
      url: "http://prowlarr.local:9696/9001",
      api_key: "test-api-key",
      enabled: 1,
    });
    const [torrent] = await indexerRowsByPattern("9002");
    expect(torrent).toMatchObject({ name: "Torrent Town", protocol: "torznab", enabled: 0 });
  });

  it("updates the existing row on a re-sync instead of duplicating it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9101, name: "Original Name", protocol: "torrent", enable: true }],
    }));
    await syncFromProwlarr();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9101, name: "Renamed", protocol: "torrent", enable: false }],
    }));
    const result = await syncFromProwlarr();

    expect(result).toEqual({ synced: 1 });
    const rows = await indexerRowsByPattern("9101");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Renamed", enabled: 0 });
  });

  it("does not let a shorter indexer id's row match a longer one sharing the same prefix (5 vs 50 vs 500)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 9250, name: "Fifty", protocol: "torrent", enable: true },
        { id: 92500, name: "Five Hundred", protocol: "torrent", enable: true },
      ],
    }));
    await syncFromProwlarr();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 925, name: "Just Five", protocol: "torrent", enable: true }],
    }));
    const result = await syncFromProwlarr();

    expect(result).toEqual({ synced: 1 }); // a genuinely new row, not an update of 9250 or 92500
    expect(await indexerRowsByPattern("9250")).toHaveLength(1);
    expect(await indexerRowsByPattern("92500")).toHaveLength(1);
    expect(await indexerRowsByPattern("925")).toHaveLength(1);
  });

  it("skips a malformed indexer (DB constraint violation) but still syncs the others in the same batch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 9301, name: "Good One", protocol: "torrent", enable: true },
        { id: 9302, name: null, protocol: "torrent", enable: true }, // violates indexers.name NOT NULL
        { id: 9303, name: "Good Two", protocol: "torrent", enable: true },
      ],
    }));

    const result = await syncFromProwlarr();

    expect(result.synced).toBe(2);
    expect(await indexerRowsByPattern("9301")).toHaveLength(1);
    expect(await indexerRowsByPattern("9302")).toHaveLength(0);
    expect(await indexerRowsByPattern("9303")).toHaveLength(1);
  });
});
