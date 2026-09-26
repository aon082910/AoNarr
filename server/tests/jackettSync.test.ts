import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncFromJackett: (typeof import("../src/services/jackettSync.js"))["syncFromJackett"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let decryptValue: (typeof import("../src/services/encryption.js"))["decryptValue"];
let isEncryptedValue: (typeof import("../src/services/encryption.js"))["isEncryptedValue"];
let DEFAULT_INDEXER_MEDIA_TYPES: string;

beforeAll(async () => {
  // jackettSync.ts imports db/index.js directly — must load after setupTestDb() has set env vars.
  ({ db } = await setupTestDb());
  ({ syncFromJackett } = await import("../src/services/jackettSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ decryptValue, isEncryptedValue } = await import("../src/services/encryption.js"));
  ({ DEFAULT_INDEXER_MEDIA_TYPES } = await import("../src/services/indexerClient.js"));
  setSetting("jackettUrl", "http://jackett.local:9117");
  setSetting("jackettApiKey", "test-api-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function indexerRowsByJackettId(id: string): Promise<any[]> {
  return (await db.prepare(`SELECT * FROM indexers WHERE config LIKE ?`).all(`%"jackettId":"${id}"%`)) as any[];
}

/** The shape Jackett's Torznab `t=indexers` listing returns. */
function jackettIndexersXml(indexers: { id: string; title?: string | null; configured?: boolean }[]): string {
  const entries = indexers
    .map(
      (i) =>
        `<indexer id="${i.id}" configured="${i.configured ?? true}">` +
        (i.title == null ? "" : `<title>${i.title}</title>`) +
        `<description>desc</description><link>https://example.com/</link><language>en-US</language><type>public</type>` +
        `<caps><server title="Jackett" /><searching><search available="yes" supportedParams="q" /></searching></caps></indexer>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<indexers>${entries}</indexers>`;
}

function xmlResponse(xml: string) {
  return { ok: true, status: 200, text: async () => xml };
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

  it("reports Jackett's <error> document (sent with HTTP 200) instead of reading it as zero indexers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse('<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Invalid API Key" />')));

    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 0, error: "Failed to reach Jackett: Jackett error 100: Invalid API Key" });
  });

  it("fails loudly when the response isn't an indexer list (e.g. Jackett's login page)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse("<html><head><title>Login</title></head><body></body></html>")));

    const result = await syncFromJackett();

    expect(result.synced).toBe(0);
    expect(result.error).toContain("no <indexers> list");
  });
});

describe("syncFromJackett — success path", () => {
  it("lists indexers through the API-key-authenticated Torznab endpoint, not the cookie-only management API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncFromJackett()).resolves.toEqual({ synced: 0 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe("http://jackett.local:9117/api/v2.0/indexers/all/results/torznab/api");
    expect(calledUrl.searchParams.get("t")).toBe("indexers");
    expect(calledUrl.searchParams.get("configured")).toBe("true");
    expect(calledUrl.searchParams.get("apikey")).toBe("test-api-key");
    expect((fetchMock.mock.calls[0][1] as any)?.headers?.["X-Api-Key"]).toBeUndefined();
  });

  it("inserts a new torznab row per indexer with a URL-encoded proxy path and every indexer-searchable media type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "my indexer", title: "My Indexer" }]))));

    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 1 });
    const [row] = await indexerRowsByJackettId("my indexer");
    expect(row).toMatchObject({
      name: "My Indexer",
      protocol: "torznab",
      url: "http://jackett.local:9117/api/v2.0/indexers/my%20indexer/results/torznab",
      enabled: 1,
      media_types: DEFAULT_INDEXER_MEDIA_TYPES,
    });
    expect(row.media_types.split(",")).toEqual(expect.arrayContaining(["sports", "ppv", "anime"]));
    // api_key is encrypted at rest (see app.ts's reencryptLegacyCredentials doc comment) — the
    // sync writes ciphertext, not the plaintext Jackett API key.
    expect(isEncryptedValue(row.api_key)).toBe(true);
    expect(decryptValue(row.api_key)).toBe("test-api-key");
  });

  it("skips an entry Jackett marks as not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "unconfigured-one", title: "Nope", configured: false }])))
    );

    await expect(syncFromJackett()).resolves.toEqual({ synced: 0 });
    expect(await indexerRowsByJackettId("unconfigured-one")).toHaveLength(0);
  });

  it("updates the existing row on a re-sync instead of duplicating it, leaving AoNarr's enabled flag alone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "eztv-sync", title: "EZTV Original" }]))));
    await syncFromJackett();
    await db.prepare(`UPDATE indexers SET enabled = 0 WHERE config LIKE ?`).run(`%"jackettId":"eztv-sync"%`);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "eztv-sync", title: "EZTV Renamed" }]))));
    const result = await syncFromJackett();

    expect(result).toEqual({ synced: 1 });
    const rows = await indexerRowsByJackettId("eztv-sync");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "EZTV Renamed", enabled: 0 });
  });

  it("re-adopts a row whose config (and so its Jackett id) was lost, by its proxy URL, instead of inserting a duplicate", async () => {
    const url = "http://jackett.local:9117/api/v2.0/indexers/lost-config/results/torznab";
    await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Edited By Admin', 'torznab', ?, 0, NULL)").run(url);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "lost-config", title: "Lost Config" }]))));
    await expect(syncFromJackett()).resolves.toEqual({ synced: 1 });

    const rows = (await db.prepare("SELECT * FROM indexers WHERE url = ?").all(url)) as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].config)).toEqual({ jackettId: "lost-config" });
    expect(rows[0].enabled).toBe(0);
  });

  it("disables a leftover copy of a synced indexer (same URL, no Jackett id) instead of letting every search query it twice", async () => {
    const url = "http://jackett.local:9117/api/v2.0/indexers/dupe-tracker/results/torznab";
    const insert = (name: string, config: string | null) =>
      db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES (?, 'torznab', ?, 1, ?)").run(name, url, config);
    const original = Number((await insert("Admin Edited", null)).lastInsertRowid);
    const synced = Number((await insert("Sync Copy", JSON.stringify({ jackettId: "dupe-tracker" }))).lastInsertRowid);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "dupe-tracker", title: "Dupe Tracker" }]))));
    await expect(syncFromJackett()).resolves.toEqual({ synced: 1 });

    const enabledOf = async (id: number) => Number(((await db.prepare("SELECT enabled FROM indexers WHERE id = ?").get(id)) as any).enabled);
    expect(await enabledOf(synced)).toBe(1);
    expect(await enabledOf(original)).toBe(0);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS n FROM indexers WHERE url = ?").get(url)) as any).n)).toBe(2); // disabled, not deleted
  });

  it("disables a copy only once: one the admin re-enables stays enabled on later syncs", async () => {
    const url = "http://jackett.local:9117/api/v2.0/indexers/kept-copy/results/torznab";
    const synced = Number(
      (
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Sync Row', 'torznab', ?, 1, ?)")
          .run(url, JSON.stringify({ jackettId: "kept-copy" }))
      ).lastInsertRowid
    );
    const copy = Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES ('Second Row', 'torznab', ?, 1, NULL)").run(url))
        .lastInsertRowid
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "kept-copy", title: "Kept Copy" }]))));
    const copyRow = async () => (await db.prepare("SELECT enabled, config FROM indexers WHERE id = ?").get(copy)) as any;

    await syncFromJackett();
    expect(Number((await copyRow()).enabled)).toBe(0);
    expect(JSON.parse((await copyRow()).config)).toEqual({ duplicateOf: synced });

    await db.prepare("UPDATE indexers SET enabled = 1 WHERE id = ?").run(copy);
    await syncFromJackett();
    await syncFromJackett();

    expect(Number((await copyRow()).enabled)).toBe(1);
    expect(await indexerRowsByJackettId("kept-copy")).toHaveLength(1);
  });

  it("when two id-less copies share the URL, adopts the oldest and disables the other", async () => {
    const url = "http://jackett.local:9117/api/v2.0/indexers/two-copies/results/torznab";
    const insert = (name: string) =>
      db.prepare("INSERT INTO indexers (name, protocol, url, enabled, config) VALUES (?, 'torznab', ?, 1, NULL)").run(name, url);
    const first = Number((await insert("First")).lastInsertRowid);
    const second = Number((await insert("Second")).lastInsertRowid);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse(jackettIndexersXml([{ id: "two-copies", title: "Two Copies" }]))));
    await syncFromJackett();

    const rows = await indexerRowsByJackettId("two-copies");
    expect(rows.map((r) => r.id)).toEqual([first]);
    expect(Number(rows[0].enabled)).toBe(1);
    expect(Number(((await db.prepare("SELECT enabled FROM indexers WHERE id = ?").get(second)) as any).enabled)).toBe(0);
  });

  it("skips a malformed indexer (DB constraint violation) but still syncs the others in the same batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        xmlResponse(
          jackettIndexersXml([
            { id: "batch-good-1", title: "Good One" },
            { id: "batch-bad", title: null }, // no <title> -> violates indexers.name NOT NULL
            { id: "batch-good-2", title: "Good Two" },
          ])
        )
      )
    );

    const result = await syncFromJackett();

    expect(result.synced).toBe(2);
    expect(await indexerRowsByJackettId("batch-good-1")).toHaveLength(1);
    expect(await indexerRowsByJackettId("batch-bad")).toHaveLength(0);
    expect(await indexerRowsByJackettId("batch-good-2")).toHaveLength(1);
  });
});
