import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function insertIndexer(name: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES (?, 'torznab', 'https://example.com')").run(name)).lastInsertRowid
  );
}

describe("attachIndexerHealth", () => {
  it("attaches an empty summary for an indexer with no recorded checks", async () => {
    const { attachIndexerHealth } = await import("../src/services/indexerHealth.js");
    const id = await insertIndexer("No History");
    const indexers: any[] = [{ id }];
    await attachIndexerHealth(indexers);
    expect(indexers[0].health).toEqual({
      totalChecks: 0,
      successCount: 0,
      successRate: null,
      avgResponseTimeMs: null,
      lastCheckedAt: null,
      lastSuccess: null,
      lastError: null,
    });
  });

  it("computes success rate and average response time across recorded checks", async () => {
    const { recordIndexerHealth } = await import("../src/services/indexerHealth.js");
    const { attachIndexerHealth } = await import("../src/services/indexerHealth.js");
    const id = await insertIndexer("Mixed History");
    await recordIndexerHealth(id, true, 100, null);
    await recordIndexerHealth(id, true, 200, null);
    await recordIndexerHealth(id, false, null, "timeout");

    const indexers: any[] = [{ id }];
    await attachIndexerHealth(indexers);
    expect(indexers[0].health.totalChecks).toBe(3);
    expect(indexers[0].health.successCount).toBe(2);
    expect(indexers[0].health.successRate).toBe(67); // 2/3 rounded
    expect(indexers[0].health.avgResponseTimeMs).toBe(150); // only the two timed checks average in
  });

  it("reports the most recent check's outcome as lastSuccess/lastError", async () => {
    const { recordIndexerHealth, attachIndexerHealth } = await import("../src/services/indexerHealth.js");
    const id = await insertIndexer("Last Check Matters");
    await recordIndexerHealth(id, true, 50, null);
    await recordIndexerHealth(id, false, null, "connection refused");

    const indexers: any[] = [{ id }];
    await attachIndexerHealth(indexers);
    expect(indexers[0].health.lastSuccess).toBe(false);
    expect(indexers[0].health.lastError).toBe("connection refused");
  });

  it("clears lastError once the most recent check succeeds again", async () => {
    const { recordIndexerHealth, attachIndexerHealth } = await import("../src/services/indexerHealth.js");
    const id = await insertIndexer("Recovered");
    await recordIndexerHealth(id, false, null, "was down");
    await recordIndexerHealth(id, true, 80, null);

    const indexers: any[] = [{ id }];
    await attachIndexerHealth(indexers);
    expect(indexers[0].health.lastSuccess).toBe(true);
    expect(indexers[0].health.lastError).toBeNull();
  });

  it("prunes older rows past the per-indexer cap", async () => {
    const { recordIndexerHealth } = await import("../src/services/indexerHealth.js");
    const id = await insertIndexer("Pruned History");
    for (let i = 0; i < 55; i++) await recordIndexerHealth(id, true, 10, null);

    const count = (await db.prepare("SELECT COUNT(*) AS c FROM indexer_health WHERE indexer_id = ?").get(id)) as { c: number };
    expect(Number(count.c)).toBe(50);
  });

  it("keeps each indexer's health independent of the others", async () => {
    const { recordIndexerHealth, attachIndexerHealth } = await import("../src/services/indexerHealth.js");
    const idA = await insertIndexer("Independent A");
    const idB = await insertIndexer("Independent B");
    await recordIndexerHealth(idA, true, 10, null);
    await recordIndexerHealth(idB, false, null, "down");

    const indexers: any[] = [{ id: idA }, { id: idB }];
    await attachIndexerHealth(indexers);
    expect(indexers[0].health.lastSuccess).toBe(true);
    expect(indexers[1].health.lastSuccess).toBe(false);
  });
});
