import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncFromProwlarr: (typeof import("../src/services/prowlarrSync.js"))["syncFromProwlarr"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let decryptValue: (typeof import("../src/services/encryption.js"))["decryptValue"];
let isEncryptedValue: (typeof import("../src/services/encryption.js"))["isEncryptedValue"];
let DEFAULT_INDEXER_MEDIA_TYPES: string;

beforeAll(async () => {
  // prowlarrSync.ts imports db/index.js directly — must load after setupTestDb() has set env vars.
  ({ db } = await setupTestDb());
  ({ syncFromProwlarr } = await import("../src/services/prowlarrSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ decryptValue, isEncryptedValue } = await import("../src/services/encryption.js"));
  ({ DEFAULT_INDEXER_MEDIA_TYPES } = await import("../src/services/indexerClient.js"));
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
      enabled: 1,
      media_types: DEFAULT_INDEXER_MEDIA_TYPES,
    });
    expect(nzb.media_types.split(",")).toEqual(expect.arrayContaining(["sports", "ppv", "anime"]));
    // api_key is encrypted at rest (see app.ts's reencryptLegacyCredentials doc comment) — the
    // sync writes ciphertext, not the plaintext Prowlarr API key.
    expect(isEncryptedValue(nzb.api_key)).toBe(true);
    expect(decryptValue(nzb.api_key)).toBe("test-api-key");
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
      json: async () => [{ id: 9101, name: "Renamed", protocol: "usenet", enable: true }],
    }));
    const result = await syncFromProwlarr();

    expect(result).toEqual({ synced: 1 });
    const rows = await indexerRowsByPattern("9101");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Renamed", protocol: "newznab" });
  });

  it("never re-enables (or otherwise flips) an indexer the admin disabled in AoNarr", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9151, name: "Admin Disabled", protocol: "torrent", enable: true }],
    }));
    await syncFromProwlarr();
    await db.prepare(`UPDATE indexers SET enabled = 0 WHERE config LIKE ?`).run(`%"prowlarrId":9151}%`);

    await syncFromProwlarr();

    const rows = await indexerRowsByPattern("9151");
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(0);
  });

  it("mirrors a change made to Prowlarr's own enable flag, in both directions", async () => {
    const sync = async (enable: boolean) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 9155, name: "Toggled In Prowlarr", protocol: "torrent", enable }],
      }));
      await syncFromProwlarr();
      const rows = await indexerRowsByPattern("9155");
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    expect((await sync(true)).enabled).toBe(1);
    const disabled = await sync(false); // disabled in Prowlarr, which now answers every search with 410
    expect(disabled.enabled).toBe(0);
    expect(JSON.parse(disabled.config)).toEqual({ prowlarrEnabled: false, prowlarrId: 9155 });
    expect((await sync(false)).enabled).toBe(0);
    expect((await sync(true)).enabled).toBe(1); // re-enabled in Prowlarr

    await db.prepare(`UPDATE indexers SET enabled = 0 WHERE config LIKE ?`).run(`%"prowlarrId":9155}%`);
    expect((await sync(true)).enabled).toBe(0); // Prowlarr's flag didn't change, so AoNarr's choice stands
  });

  it("a row synced before the flag was recorded only ever has a Prowlarr-side disable mirrored", async () => {
    const insert = (id: number, enabled: number) =>
      db
        .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Old Sync', 'torznab', ?, ?, ?)")
        .run(`http://prowlarr.local:9696/${id}`, enabled, JSON.stringify({ prowlarrId: id }));
    await insert(9156, 1);
    await insert(9157, 0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 9156, name: "Disabled In Prowlarr", protocol: "torrent", enable: false },
        { id: 9157, name: "Disabled In AoNarr", protocol: "torrent", enable: true },
      ],
    }));

    await syncFromProwlarr();

    expect((await indexerRowsByPattern("9156"))[0].enabled).toBe(0);
    expect((await indexerRowsByPattern("9157"))[0].enabled).toBe(0);
  });

  it("re-adopts a row whose config (and so its Prowlarr id) was lost, by its proxy URL, instead of inserting a duplicate", async () => {
    await db
      .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Edited By Admin', 'torznab', 'http://prowlarr.local:9696/9161', 1, NULL)")
      .run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9161, name: "Lost Config", protocol: "torrent", enable: true }],
    }));

    await expect(syncFromProwlarr()).resolves.toEqual({ synced: 1 });

    const rows = (await db.prepare("SELECT * FROM indexers WHERE url = ?").all("http://prowlarr.local:9696/9161")) as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].config)).toEqual({ prowlarrEnabled: true, prowlarrId: 9161 });
    expect(await indexerRowsByPattern("9161")).toHaveLength(1); // findable by id again on the next sync
  });

  it("disables leftover copies of a synced indexer (same URL, no Prowlarr id) instead of letting every search query it twice", async () => {
    const url = "http://prowlarr.local:9696/9171";
    const insert = (name: string, enabled: number, config: string | null) =>
      db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES (?, 'torznab', ?, ?, ?)").run(name, url, enabled, config);
    const original = Number((await insert("Admin Edited", 1, null)).lastInsertRowid);
    const synced = Number((await insert("Sync Copy", 1, JSON.stringify({ prowlarrId: 9171 }))).lastInsertRowid);
    const alreadyOff = Number((await insert("Already Off", 0, null)).lastInsertRowid);
    const unrelated = Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url, enabled) VALUES ('Other', 'torznab', 'http://prowlarr.local:9696/9172', 1)").run())
        .lastInsertRowid
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9171, name: "Synced", protocol: "torrent", enable: true }],
    }));

    await expect(syncFromProwlarr()).resolves.toEqual({ synced: 1 });

    const enabledOf = async (id: number) => Number(((await db.prepare("SELECT enabled FROM indexers WHERE id = ?").get(id)) as any).enabled);
    expect(await enabledOf(synced)).toBe(1);
    expect(await enabledOf(original)).toBe(0);
    expect(await enabledOf(alreadyOff)).toBe(0);
    expect(await enabledOf(unrelated)).toBe(1);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS n FROM indexers WHERE url = ?").get(url)) as any).n)).toBe(3); // disabled, not deleted
  });

  it("disables a copy only once: one the admin re-enables stays enabled on later syncs, its other config kept", async () => {
    const url = "http://prowlarr.local:9696/9175";
    const copy = Number(
      (
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Second Row', 'torznab', ?, 1, ?)")
          .run(url, JSON.stringify({ note: "kept" }))
      ).lastInsertRowid
    );
    const synced = Number(
      (
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Sync Row', 'torznab', ?, 1, ?)")
          .run(url, JSON.stringify({ prowlarrEnabled: true, prowlarrId: 9175 }))
      ).lastInsertRowid
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9175, name: "Synced", protocol: "torrent", enable: true }],
    }));
    const copyRow = async () => (await db.prepare("SELECT enabled, config FROM indexers WHERE id = ?").get(copy)) as any;

    await syncFromProwlarr();
    expect(Number((await copyRow()).enabled)).toBe(0);
    expect(JSON.parse((await copyRow()).config)).toEqual({ note: "kept", duplicateOf: synced });

    await db.prepare("UPDATE indexers SET enabled = 1 WHERE id = ?").run(copy);
    await syncFromProwlarr();
    await syncFromProwlarr();

    expect(Number((await copyRow()).enabled)).toBe(1);
    expect(Number(((await db.prepare("SELECT enabled FROM indexers WHERE id = ?").get(synced)) as any).enabled)).toBe(1);
  });

  it("keeps a copy's duplicate mark through an edit that replaces its config", async () => {
    const { mergeSyncedIndexerConfig } = await import("../src/services/prowlarrSync.js");
    expect(JSON.parse(mergeSyncedIndexerConfig(JSON.stringify({ duplicateOf: 7 }), JSON.stringify({ note: "edited" }))!)).toEqual({
      note: "edited",
      duplicateOf: 7,
    });
  });

  it("leaves a copy alone while the synced row itself is disabled (the copy is the one the admin uses)", async () => {
    const url = "http://prowlarr.local:9696/9181";
    const copy = Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('In Use', 'torznab', ?, 1, NULL)").run(url)).lastInsertRowid
    );
    await db
      .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Sync Copy', 'torznab', ?, 0, ?)")
      .run(url, JSON.stringify({ prowlarrEnabled: true, prowlarrId: 9181 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9181, name: "Synced", protocol: "torrent", enable: true }],
    }));

    await syncFromProwlarr();

    expect(Number(((await db.prepare("SELECT enabled FROM indexers WHERE id = ?").get(copy)) as any).enabled)).toBe(1);
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
