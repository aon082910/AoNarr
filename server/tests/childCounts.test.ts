import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

describe("attachChildCounts", () => {
  it("attaches childCount/childHaveCount for an episodic item, counting downloaded vs. total episodes", async () => {
    const { attachChildCounts } = await import("../src/services/childCounts.js");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 1, 1, 1)").run(showId);
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 2, 1, 0)").run(showId);
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 3, 1, 1)").run(showId);

    const items: any[] = [{ id: showId, type: "series" }];
    await attachChildCounts(items);
    expect(items[0].childCount).toBe(3);
    expect(items[0].childHaveCount).toBe(2);
  });

  it("attaches counts for a collection-shape item using sub_items instead of episodes", async () => {
    const { attachChildCounts } = await import("../src/services/childCounts.js");
    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album A', 1, 1)").run(artistId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album B', 1, 0)").run(artistId);

    const items: any[] = [{ id: artistId, type: "artist" }];
    await attachChildCounts(items);
    expect(items[0].childCount).toBe(2);
    expect(items[0].childHaveCount).toBe(1);
  });

  it("leaves a single-shape item (movie) untouched — it has no children to count", async () => {
    const { attachChildCounts } = await import("../src/services/childCounts.js");
    const items: any[] = [{ id: 999999, type: "movie" }];
    await attachChildCounts(items);
    expect(items[0].childCount).toBeUndefined();
    expect(items[0].childHaveCount).toBeUndefined();
  });

  it("handles a batch mixing multiple shapes and an episodic item with zero episodes yet", async () => {
    const { attachChildCounts } = await import("../src/services/childCounts.js");
    const emptyShowId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Empty Show', 'empty show', 1, 0, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const movieId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'A Movie', 'a movie', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );

    const items: any[] = [
      { id: emptyShowId, type: "series" },
      { id: movieId, type: "movie" },
    ];
    await attachChildCounts(items);
    // No episodes rows at all yet — nothing to attach, same as a single-shape item.
    expect(items[0].childCount).toBeUndefined();
    expect(items[1].childCount).toBeUndefined();
  });
});
