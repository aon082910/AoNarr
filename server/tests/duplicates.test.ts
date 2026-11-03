import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function insertMovie(title: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 1, 'unknown')`)
        .run(title, title.toLowerCase())
    ).lastInsertRowid
  );
}

async function insertImportEvent(mediaItemId: number, quality: string | null, secondsAgo: number): Promise<void> {
  const createdAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
  await db
    .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
    .run(mediaItemId, JSON.stringify({ itemId: mediaItemId, quality }), createdAt);
}

describe("findRepeatedImports", () => {
  it("ignores an item imported only once — that's the normal case, not a repeat", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const itemId = await insertMovie("Imported Once");
    await insertImportEvent(itemId, "1080p", 100);

    const repeats = await findRepeatedImports();
    expect(repeats.find((r) => r.mediaItemId === itemId)).toBeUndefined();
  });

  it("flags an item imported more than once, listing every quality it was imported at", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const itemId = await insertMovie("Imported Twice");
    await insertImportEvent(itemId, "720p", 200);
    await insertImportEvent(itemId, "1080p", 100);

    const repeats = await findRepeatedImports();
    const entry = repeats.find((r) => r.mediaItemId === itemId);
    expect(entry).toBeDefined();
    expect(entry!.importCount).toBe(2);
    expect(entry!.qualities).toEqual(["720p", "1080p"]);
    expect(entry!.target).toBe("Imported Twice");
  });

  it("labels a repeated episode import with its season/episode instead of just the show's title", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'A Show', 'a show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 5, 1, 1)")
          .run(showId)
      ).lastInsertRowid
    );
    for (const secondsAgo of [200, 100]) {
      await db
        .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
        .run(showId, JSON.stringify({ itemId: showId, episodeId, quality: "1080p" }), new Date(Date.now() - secondsAgo * 1000).toISOString());
    }

    const repeats = await findRepeatedImports();
    const entry = repeats.find((r) => r.mediaItemId === showId);
    expect(entry?.target).toBe("A Show S01E05");
  });

  it("keeps a repeated episode import for one show separate from a repeated import of a different episode of the same show", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Split Show', 'split show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const ep1 = Number(
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 1, 1, 1)").run(showId))
        .lastInsertRowid
    );
    const ep2 = Number(
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 2, 1, 1)").run(showId))
        .lastInsertRowid
    );
    // Episode 1 imported twice (a real repeat); episode 2 imported once (not a repeat).
    for (const secondsAgo of [200, 100]) {
      await db
        .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
        .run(showId, JSON.stringify({ itemId: showId, episodeId: ep1, quality: "1080p" }), new Date(Date.now() - secondsAgo * 1000).toISOString());
    }
    await db
      .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
      .run(showId, JSON.stringify({ itemId: showId, episodeId: ep2, quality: "1080p" }), new Date().toISOString());

    const repeats = await findRepeatedImports();
    const matches = repeats.filter((r) => r.mediaItemId === showId);
    expect(matches).toHaveLength(1);
    expect(matches[0].importCount).toBe(2);
  });

  it("sorts the most-repeated item first", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const twiceId = await insertMovie("Twice Sort");
    await insertImportEvent(twiceId, null, 200);
    await insertImportEvent(twiceId, null, 190);
    const thriceId = await insertMovie("Thrice Sort");
    await insertImportEvent(thriceId, null, 180);
    await insertImportEvent(thriceId, null, 170);
    await insertImportEvent(thriceId, null, 160);

    const repeats = await findRepeatedImports();
    const thriceIndex = repeats.findIndex((r) => r.mediaItemId === thriceId);
    const twiceIndex = repeats.findIndex((r) => r.mediaItemId === twiceId);
    expect(thriceIndex).toBeLessThan(twiceIndex);
  });

  it("skips a malformed history row instead of throwing", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const itemId = await insertMovie("Malformed Data Row");
    await db
      .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
      .run(itemId, "{not valid json", new Date().toISOString());

    await expect(findRepeatedImports()).resolves.not.toThrow();
  });

  it("reuses one scan for repeated calls until the cache is cleared (RB4)", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const itemId = await insertMovie("Cached Scan");
    await insertImportEvent(itemId, "720p", 50);
    await insertImportEvent(itemId, "1080p", 40);

    const first = await findRepeatedImports();
    expect(first.some((r) => r.mediaItemId === itemId)).toBe(true);

    const laterId = await insertMovie("Cached Scan Later");
    await insertImportEvent(laterId, "720p", 30);
    await insertImportEvent(laterId, "1080p", 20);

    expect(await findRepeatedImports()).toBe(first);
    expect(first.some((r) => r.mediaItemId === laterId)).toBe(false);

    clearRepeatedImportsCache();
    expect((await findRepeatedImports()).some((r) => r.mediaItemId === laterId)).toBe(true);
  });

  it("answers two calls that overlap from the same scan", async () => {
    const { findRepeatedImports, clearRepeatedImportsCache } = await import("../src/services/duplicates.js");
    clearRepeatedImportsCache();
    const [a, b] = await Promise.all([findRepeatedImports(), findRepeatedImports()]);
    expect(a).toBe(b);
  });
});

describe("dashboard indexes (RB4)", () => {
  it("watch_events has an index on watched_at, so the recently-watched list does not scan and sort the table", async () => {
    if (db.dialect === "sqlite") {
      const plan = (await db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM watch_events ORDER BY watched_at DESC LIMIT 50")
        .all()) as { detail: string }[];
      const detail = plan.map((r) => r.detail).join(" | ");
      expect(detail).toContain("idx_watch_events_watched_at");
      expect(detail).not.toContain("TEMP B-TREE");
    } else {
      const rows = (await db.prepare("SELECT indexname FROM pg_indexes WHERE tablename = 'watch_events'").all()) as { indexname: string }[];
      expect(rows.map((r) => r.indexname)).toContain("idx_watch_events_watched_at");
    }
  });
});
