import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

describe("isExcluded", () => {
  it("matches by external id + provider, regardless of title differences", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    await db
      .prepare("INSERT INTO import_exclusions (type, title, external_id, external_provider) VALUES ('movie', 'Old Title', '12345', 'tmdb')")
      .run();

    expect(await isExcluded("movie", "A Completely Different Title", null, "12345", "tmdb")).toBe(true);
  });

  it("does not match on external id if the provider is different (and the title doesn't otherwise match)", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    await db
      .prepare("INSERT INTO import_exclusions (type, title, external_id, external_provider) VALUES ('movie', 'Provider Mismatch Source', '999', 'tmdb')")
      .run();

    expect(await isExcluded("movie", "Unrelated Query Title", null, "999", "imdb")).toBe(false);
  });

  it("falls back to normalized title + year matching when no external id is given", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    await db.prepare("INSERT INTO import_exclusions (type, title, year) VALUES ('movie', 'Excluded Movie', 2020)").run();

    expect(await isExcluded("movie", "excluded movie!!", 2020)).toBe(true);
    expect(await isExcluded("movie", "Excluded Movie", 2021)).toBe(false);
  });

  it("matches on title alone when either side has no year recorded", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    await db.prepare("INSERT INTO import_exclusions (type, title) VALUES ('movie', 'No Year Recorded')").run();

    expect(await isExcluded("movie", "No Year Recorded", 2020)).toBe(true);
  });

  it("only matches within the same media type", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    await db.prepare("INSERT INTO import_exclusions (type, title) VALUES ('movie', 'Cross Type')").run();

    expect(await isExcluded("series", "Cross Type", null)).toBe(false);
  });

  it("returns false for a title that isn't excluded at all", async () => {
    const { isExcluded } = await import("../src/services/importExclusions.js");
    expect(await isExcluded("movie", "Never Excluded Anywhere", null)).toBe(false);
  });
});
