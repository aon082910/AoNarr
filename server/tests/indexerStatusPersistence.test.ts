import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { Indexer } from "../src/types/index.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let searchIndexer: (typeof import("../src/services/indexerClient.js"))["searchIndexer"];
let isIndexerBackedOff: (typeof import("../src/services/indexerClient.js"))["isIndexerBackedOff"];
let clearIndexerBackoff: (typeof import("../src/services/indexerClient.js"))["clearIndexerBackoff"];
let loadIndexerStatuses: (typeof import("../src/services/indexerClient.js"))["loadIndexerStatuses"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ searchIndexer, isIndexerBackedOff, clearIndexerBackoff, loadIndexerStatuses } = await import("../src/services/indexerClient.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function realIndexer(name: string): Promise<Indexer> {
  const id = Number(
    (await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES (?, 'rss', 'https://idx.example.com/feed', 'movie', 1)").run(name)).lastInsertRowid
  );
  return {
    id,
    name,
    protocol: "rss",
    url: "https://idx.example.com/feed",
    apiKey: null,
    categories: "",
    mediaTypes: "movie",
    enabled: 1,
    priority: 25,
    config: null,
    useFlareSolverr: 0,
    queryLimitPerHour: null,
  } as Indexer;
}

async function statusRow(indexerId: number): Promise<any> {
  return db.prepare("SELECT * FROM indexer_status WHERE indexer_id = ?").get(indexerId);
}

/** The writes are fire and forget; give them a moment. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the failure backoff survives a restart (RB13)", () => {
  it("writes the failure count and the wait when an indexer fails, and deletes the row when it recovers", async () => {
    const indexer = await realIndexer("Persisted");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow();
    await settled();

    const row = await statusRow(indexer.id);
    expect(row).toMatchObject({ consecutive_failures: 1, backoff_reason: "failures" });
    expect(Date.parse(row.backoff_until)).toBeGreaterThan(Date.now());

    clearIndexerBackoff(indexer.id);
    await settled();
    expect(await statusRow(indexer.id)).toBeUndefined();
  });

  it("writes the longer wait after each failure in a row", async () => {
    const indexer = await realIndexer("Escalating");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    vi.useFakeTimers({ toFake: ["Date"] });

    await expect(searchIndexer(indexer, "q1", "movie")).rejects.toThrow();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past the first 5 minute wait
    await expect(searchIndexer(indexer, "q2", "movie")).rejects.toThrow();
    vi.useRealTimers();
    await settled();

    expect((await statusRow(indexer.id)).consecutive_failures).toBe(2);
  });

  it("writes a rate-limit wait too, with its reason", async () => {
    const indexer = await realIndexer("Limited");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }));

    await expect(searchIndexer(indexer, "q", "movie")).rejects.toThrow("HTTP 429");
    await settled();

    expect(await statusRow(indexer.id)).toMatchObject({ backoff_reason: "rate-limit" });
  });

  it("reads the waits back after a restart: a live wait applies, an expired one does not but its failure count stays", async () => {
    const waiting = await realIndexer("Still Waiting");
    const over = await realIndexer("Wait Over");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await db.prepare("INSERT INTO indexer_status (indexer_id, consecutive_failures, backoff_until, backoff_reason, backoff_set_at) VALUES (?, 4, ?, 'failures', ?)").run(waiting.id, future, past);
    await db.prepare("INSERT INTO indexer_status (indexer_id, consecutive_failures, backoff_until, backoff_reason, backoff_set_at) VALUES (?, 2, ?, 'failures', ?)").run(over.id, past, past);

    await loadIndexerStatuses();

    expect(isIndexerBackedOff(waiting.id)).toBe(true);
    expect(isIndexerBackedOff(over.id)).toBe(false);

    // The next failure of the indexer whose wait ended continues the ladder (3rd failure: an hour), not a restart from 5 minutes.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    await expect(searchIndexer(over, "q", "movie")).rejects.toThrow();
    await settled();
    const row = await statusRow(over.id);
    expect(row.consecutive_failures).toBe(3);
    expect(Date.parse(row.backoff_until) - Date.now()).toBeGreaterThan(30 * 60 * 1000);
  });

  it("removes the row with its indexer", async () => {
    const indexer = await realIndexer("Deleted Soon");
    await db.prepare("INSERT INTO indexer_status (indexer_id, consecutive_failures) VALUES (?, 1)").run(indexer.id);
    await db.prepare("DELETE FROM indexers WHERE id = ?").run(indexer.id);
    expect(await statusRow(indexer.id)).toBeUndefined();
  });
});
