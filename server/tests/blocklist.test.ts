import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function insertMovie(): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'X', 'x', 1, 0, 'unknown')`)
        .run()
    ).lastInsertRowid
  );
}

describe("isBlocklisted", () => {
  it("matches an exact release title blocklisted for that media item", async () => {
    const { isBlocklisted } = await import("../src/services/blocklist.js");
    const itemId = await insertMovie();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(itemId, "Movie.2023.1080p.BluRay-GROUP");

    expect(await isBlocklisted(itemId, "Movie.2023.1080p.BluRay-GROUP")).toBe(true);
  });

  it("does not match a similar-but-different release title — exact match only, no fuzziness", async () => {
    const { isBlocklisted } = await import("../src/services/blocklist.js");
    const itemId = await insertMovie();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(itemId, "Movie.2023.1080p.BluRay-GROUP");

    expect(await isBlocklisted(itemId, "Movie.2023.720p.BluRay-GROUP")).toBe(false);
  });

  it("scopes blocklist entries to their own media item — a title blocklisted on one item doesn't block it on another", async () => {
    const { isBlocklisted } = await import("../src/services/blocklist.js");
    const itemA = await insertMovie();
    const itemB = await insertMovie();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(itemA, "Shared.Release.Title");

    expect(await isBlocklisted(itemA, "Shared.Release.Title")).toBe(true);
    expect(await isBlocklisted(itemB, "Shared.Release.Title")).toBe(false);
  });
});

describe("getBlocklistedTitles", () => {
  it("returns every blocklisted release title for an item as a Set", async () => {
    const { getBlocklistedTitles } = await import("../src/services/blocklist.js");
    const itemId = await insertMovie();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(itemId, "Release.One");
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(itemId, "Release.Two");

    const titles = await getBlocklistedTitles(itemId);
    expect(titles).toEqual(new Set(["Release.One", "Release.Two"]));
  });

  it("returns an empty Set for an item with nothing blocklisted", async () => {
    const { getBlocklistedTitles } = await import("../src/services/blocklist.js");
    const itemId = await insertMovie();
    expect(await getBlocklistedTitles(itemId)).toEqual(new Set());
  });
});
