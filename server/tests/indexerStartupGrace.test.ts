import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { Indexer } from "../src/types/index.js";

// The grace is read when indexerClient.ts loads, so it is set before anything imports it.
const originalGrace = process.env.AONARR_INDEXER_STARTUP_GRACE_MS;
process.env.AONARR_INDEXER_STARTUP_GRACE_MS = String(15 * 60 * 1000);

let searchIndexer: (typeof import("../src/services/indexerClient.js"))["searchIndexer"];
let isIndexerBackedOff: (typeof import("../src/services/indexerClient.js"))["isIndexerBackedOff"];
let loadIndexerStatuses: (typeof import("../src/services/indexerClient.js"))["loadIndexerStatuses"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  vi.resetModules();
  ({ db } = await setupTestDb());
  ({ searchIndexer, isIndexerBackedOff, loadIndexerStatuses } = await import("../src/services/indexerClient.js"));
});

afterAll(() => {
  if (originalGrace === undefined) delete process.env.AONARR_INDEXER_STARTUP_GRACE_MS;
  else process.env.AONARR_INDEXER_STARTUP_GRACE_MS = originalGrace;
  vi.unstubAllGlobals();
});

async function realIndexer(name: string): Promise<Indexer> {
  const id = Number(
    (await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES (?, 'rss', 'https://idx.example.com/feed', 'movie', 1)").run(name)).lastInsertRowid
  );
  return { id, name, protocol: "rss", url: "https://idx.example.com/feed", apiKey: null, categories: "", mediaTypes: "movie", enabled: 1, priority: 25, config: null, useFlareSolverr: 0, queryLimitPerHour: null } as Indexer;
}

describe("start-up grace for indexer failures (RB13)", () => {
  it("does not back an indexer off for failures in the first minutes after a start", async () => {
    const indexer = await realIndexer("Booting");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));

    await expect(searchIndexer(indexer, "q1", "movie")).rejects.toThrow();
    await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow();
    await expect(searchIndexer(indexer, "q3", "movie")).rejects.toThrow();

    expect(isIndexerBackedOff(indexer.id)).toBe(false);
    expect(await db.prepare("SELECT * FROM indexer_status WHERE indexer_id = ?").get(indexer.id)).toBeUndefined();
  });

  it("still applies a level loaded from the database, holding it where it was instead of raising it", async () => {
    const indexer = await realIndexer("Known Bad");
    await db
      .prepare("INSERT INTO indexer_status (indexer_id, consecutive_failures, backoff_until, backoff_reason, backoff_set_at) VALUES (?, 3, ?, 'failures', ?)")
      .run(indexer.id, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 3_600_000).toISOString());
    await loadIndexerStatuses();
    expect(isIndexerBackedOff(indexer.id)).toBe(false); // its wait is over

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow();

    expect(isIndexerBackedOff(indexer.id)).toBe(true); // held at level 3 (an hour), not climbing to 4
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await db.prepare("SELECT consecutive_failures FROM indexer_status WHERE indexer_id = ?").get(indexer.id)) as any).toEqual({ consecutive_failures: 3 });
  });
});
