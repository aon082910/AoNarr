import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

describe("pathTail", () => {
  it("compares the last three path segments, case-insensitively, across mixed separators", async () => {
    const { pathTail } = await import("../src/services/archival.js");
    expect(pathTail("/data/movies/Dune (2021)/Dune.mkv")).toBe(pathTail("C:\\media\\Movies\\DUNE (2021)\\dune.mkv"));
  });

  it("distinguishes two shows with the same generic season/episode filename by the third segment", async () => {
    const { pathTail } = await import("../src/services/archival.js");
    const showA = pathTail("/tv/Show A/Season 01/S01E01.mkv");
    const showB = pathTail("/tv/Show B/Season 01/S01E01.mkv");
    expect(showA).not.toBe(showB);
  });
});

describe("findWatchedMatch", () => {
  it("matches a watched file by path tail regardless of mount-point prefix", async () => {
    const { findWatchedMatch } = await import("../src/services/archival.js");
    const watched = [{ path: "/plex/movies/Dune (2021)/Dune.mkv", lastPlayedAt: new Date() }];
    const match = findWatchedMatch("/aonarr/movies/Dune (2021)/Dune.mkv", watched);
    expect(match).toBe(watched[0]);
  });

  it("returns null for a null path or when nothing matches", async () => {
    const { findWatchedMatch } = await import("../src/services/archival.js");
    expect(findWatchedMatch(null, [{ path: "/x/y/z.mkv", lastPlayedAt: new Date() }])).toBeNull();
    expect(findWatchedMatch("/a/b/c.mkv", [])).toBeNull();
  });
});

describe("effectiveRetentionDays", () => {
  async function insertMovie(): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'X', 'x', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
  }

  it("falls back to the global default when nothing overrides it", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    expect(await effectiveRetentionDays(itemId, 30)).toBe(30);
  });

  it("uses a tag's own retention override", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Comfort', 365)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(365);
  });

  it("uses a collection's own retention override", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const collectionId = Number((await db.prepare("INSERT INTO collections (name, retention_days) VALUES ('Long Keep', 90)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO collection_items (collection_id, media_item_id) VALUES (?, ?)").run(collectionId, itemId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(90);
  });

  it("-1 (never archive) wins over any duration, from either a tag or a collection", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Kids', -1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);
    const collectionId = Number(
      (await db.prepare("INSERT INTO collections (name, retention_days) VALUES ('Also Long Keep', 365)").run()).lastInsertRowid
    );
    await db.prepare("INSERT INTO collection_items (collection_id, media_item_id) VALUES (?, ?)").run(collectionId, itemId);

    expect(await effectiveRetentionDays(itemId, 30)).toBeNull();
  });

  it("among multiple duration overrides, the longest (most protective) wins", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const shortTagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Short', 7)").run()).lastInsertRowid);
    const longTagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Long', 180)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, shortTagId);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, longTagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(180);
  });

  it("ignores a tag/collection with no retention override set", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('Untagged Retention')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(30);
  });
});
