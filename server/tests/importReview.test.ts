import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function countRows(title: string): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM import_review_items WHERE title = ?").get(title)) as { c: number };
  return Number(row.c);
}

describe("queueForReview", () => {
  it("inserts a new pending row for a title with no existing match", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    await queueForReview({ source: "watchlist", importListId: null, type: "movie", title: "Brand New Title", year: 2020 });

    const row = (await db.prepare("SELECT * FROM import_review_items WHERE title = 'Brand New Title'").get()) as any;
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(row.source).toBe("watchlist");
    expect(row.year).toBe(2020);
  });

  it("does not insert a duplicate for the exact same source/list/type/title/year", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    const params = { source: "trakt", importListId: null, type: "movie", title: "Repeated Title", year: 2021 };
    await queueForReview(params);
    await queueForReview(params);

    expect(await countRows("Repeated Title")).toBe(1);
  });

  it("treats two null import_list_id values as matching (IS NOT DISTINCT FROM semantics)", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    await queueForReview({ source: "plex-watchlist", importListId: null, type: "movie", title: "Null List Title", year: 2022 });
    await queueForReview({ source: "plex-watchlist", importListId: null, type: "movie", title: "Null List Title", year: 2022 });

    expect(await countRows("Null List Title")).toBe(1);
  });

  it("treats two null year values as matching", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "No Year Title", year: null });
    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "No Year Title", year: null });

    expect(await countRows("No Year Title")).toBe(1);
  });

  it("creates separate rows for the same title under different import list ids", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    const listAId = Number(
      (await db.prepare("INSERT INTO import_lists (name, type, url) VALUES ('List A', 'trakt', 'https://a.example.com')").run())
        .lastInsertRowid
    );
    const listBId = Number(
      (await db.prepare("INSERT INTO import_lists (name, type, url) VALUES ('List B', 'trakt', 'https://b.example.com')").run())
        .lastInsertRowid
    );

    await queueForReview({ source: "importlist", importListId: listAId, type: "movie", title: "Multi List Title", year: 2023 });
    await queueForReview({ source: "importlist", importListId: listBId, type: "movie", title: "Multi List Title", year: 2023 });

    expect(await countRows("Multi List Title")).toBe(2);
  });

  it("does not re-queue a title whose existing row was already dismissed", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "Already Dismissed Title", year: 2024 });
    await db.prepare("UPDATE import_review_items SET status = 'dismissed' WHERE title = 'Already Dismissed Title'").run();

    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "Already Dismissed Title", year: 2024 });

    expect(await countRows("Already Dismissed Title")).toBe(1);
    const row = (await db.prepare("SELECT status FROM import_review_items WHERE title = 'Already Dismissed Title'").get()) as any;
    expect(row.status).toBe("dismissed");
  });

  it("does not dedupe across a different title", async () => {
    const { queueForReview } = await import("../src/services/importReview.js");
    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "First Distinct Title", year: 2025 });
    await queueForReview({ source: "trakt", importListId: null, type: "movie", title: "Second Distinct Title", year: 2025 });

    expect(await countRows("First Distinct Title")).toBe(1);
    expect(await countRows("Second Distinct Title")).toBe(1);
  });
});
