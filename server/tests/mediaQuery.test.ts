import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { buildMediaQuery, toFts5Query, clampLimit, clampOffset } from "../src/services/mediaQuery.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function insertItem(overrides: Record<string, unknown> = {}): Promise<number> {
  const row = {
    title: "Item",
    path: null as string | null,
    has_file: 0,
    quality: null as string | null,
    quality_profile_id: null as number | null,
    content_rating: null as string | null,
    external_ids: null as string | null,
    genres: null as string | null,
    ...overrides,
  };
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, path, has_file, quality, quality_profile_id, content_rating, external_ids, genres, monitored, status)
       VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unknown')`
    )
    .run(row.title, String(row.title).toLowerCase(), row.path, row.has_file, row.quality, row.quality_profile_id, row.content_rating, row.external_ids, row.genres);
  return Number(result.lastInsertRowid);
}

async function runQueryFor(id: number, filters: Parameters<typeof buildMediaQuery>[0]): Promise<boolean> {
  const q = await buildMediaQuery(filters);
  if (q.where === null) return false;
  const row = await db.prepare(`SELECT m.id FROM ${q.fromClause} WHERE ${q.where} AND m.id = ?`).get(...q.params, id);
  return !!row;
}

describe("toFts5Query", () => {
  it("phrase-quotes each token and suffixes it for prefix matching", () => {
    expect(toFts5Query("aveng")).toBe(`"aveng"*`);
    expect(toFts5Query("the matrix")).toBe(`"the"* "matrix"*`);
  });

  it("escapes a literal double quote in the input rather than breaking the FTS5 syntax", () => {
    expect(toFts5Query('the "matrix"')).toBe(`"the"* """matrix"""*`);
  });

  it("neutralizes FTS5 operator-like words (AND/OR/NOT/-) by quoting them as literal terms", () => {
    expect(toFts5Query("rocky -2")).toContain(`"-2"*`);
  });
});

describe("clampLimit / clampOffset", () => {
  it("clampLimit falls back to the default for missing/invalid/non-positive input", () => {
    expect(clampLimit(undefined, 60)).toBe(60);
    expect(clampLimit("not a number", 60)).toBe(60);
    expect(clampLimit(0, 60)).toBe(60);
    expect(clampLimit(-5, 60)).toBe(60);
  });

  it("clampLimit caps at the max rather than trusting an arbitrarily large request", () => {
    expect(clampLimit(10_000, 60, 500)).toBe(500);
  });

  it("clampLimit accepts a valid value within bounds", () => {
    expect(clampLimit(25, 60)).toBe(25);
  });

  it("clampOffset floors at zero and falls back for invalid input", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-10)).toBe(0);
    expect(clampOffset("garbage")).toBe(0);
    expect(clampOffset(40)).toBe(40);
  });
});

describe("buildMediaQuery", () => {
  it("short-circuits to an unsatisfiable query for a restricted user with an empty allowedTypes list", async () => {
    const result = await buildMediaQuery({ allowedTypes: [] });
    expect(result.where).toBeNull();
  });

  it("scopes to the requesting user's allowed types when no explicit type filter is given", async () => {
    const result = await buildMediaQuery({ allowedTypes: ["movie", "series"] });
    expect(result.where).toContain("m.type IN (?,?)");
    expect(result.params).toEqual(["movie", "series"]);
  });

  it("an explicit type filter is trusted as already validated against allowedTypes by the caller", async () => {
    // No allowedTypes restriction condition should be added when `type` is already given — the
    // route itself is responsible for rejecting a type outside the user's allowedTypes up front.
    const result = await buildMediaQuery({ type: "movie", allowedTypes: ["movie"] });
    expect(result.where).toBe("m.type = ?");
    expect(result.params).toEqual(["movie"]);
  });

  it("excludes every content rating above the requesting user's maxContentRating", async () => {
    const result = await buildMediaQuery({ allowedTypes: null, maxContentRating: "PG-13" });
    expect(result.where).toContain("m.content_rating IS NULL OR m.content_rating NOT IN");
    // Every rating stricter than PG-13 should be in the exclusion list, and nothing at or below it.
    expect(result.params).toEqual(expect.arrayContaining(["R", "NC-17"]));
    expect(result.params).not.toContain("PG-13");
    expect(result.params).not.toContain("G");
  });

  it("applies no content-rating restriction at all for an admin (maxContentRating null)", async () => {
    const result = await buildMediaQuery({ allowedTypes: null, maxContentRating: null });
    expect(result.where).toBe("1=1");
  });

  it("joins media_item_tags only when filtering by tag", async () => {
    const withTag = await buildMediaQuery({ tagId: "3", allowedTypes: null });
    expect(withTag.fromClause).toContain("JOIN media_item_tags");
    const withoutTag = await buildMediaQuery({ allowedTypes: null });
    expect(withoutTag.fromClause).not.toContain("JOIN");
  });

  it("groupId 'none' combined with a type filters to that type with no group assigned", async () => {
    const result = await buildMediaQuery({ type: "movie", groupId: "none", allowedTypes: ["movie"] });
    expect(result.where).toBe("m.type = ? AND m.group_id IS NULL");
  });

  it("maps monitored/unmonitored to a plain condition", async () => {
    expect((await buildMediaQuery({ status: "monitored", allowedTypes: null })).where).toBe("m.monitored = 1");
    expect((await buildMediaQuery({ status: "unmonitored", allowedTypes: null })).where).toBe("m.monitored = 0");
  });

  it("status downloaded/missing on a single-shape item (movie) still just checks has_file", async () => {
    const downloadedId = await insertItem({ title: "Downloaded Movie", has_file: 1 });
    const missingId = await insertItem({ title: "Missing Movie", has_file: 0 });

    expect(await runQueryFor(downloadedId, { status: "downloaded", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(downloadedId, { status: "missing", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(missingId, { status: "downloaded", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(missingId, { status: "missing", allowedTypes: null })).toBe(true);
  });

  // Regression test: a series' own has_file only means "at least one episode has a file" (see
  // services/childCounts.ts) — status=downloaded/missing used to check that flag directly, so a
  // series with 1 of 5 episodes downloaded showed up as "Downloaded" and never as "Missing".
  it("status downloaded/missing on an episodic item (series) is based on ALL episodes, not has_file", async () => {
    async function insertSeriesWithEpisodes(hasFileFlags: number[]): Promise<number> {
      const result = await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, has_file, monitored, status) VALUES ('series', ?, ?, ?, 1, 'unknown')`
        )
        .run("Fixture Series", "fixture series", hasFileFlags.some(Boolean) ? 1 : 0);
      const mediaItemId = Number(result.lastInsertRowid);
      for (const [i, hasFile] of hasFileFlags.entries()) {
        await db
          .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,?)`)
          .run(mediaItemId, i + 1, `Ep${i + 1}`, hasFile);
      }
      return mediaItemId;
    }

    const fullyDownloaded = await insertSeriesWithEpisodes([1, 1]);
    const partiallyDownloaded = await insertSeriesWithEpisodes([1, 0, 0]); // has_file=1 on the parent row (the old, misleading flag)
    const fullyMissing = await insertSeriesWithEpisodes([0, 0]);

    expect(await runQueryFor(fullyDownloaded, { status: "downloaded", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(fullyDownloaded, { status: "missing", allowedTypes: null })).toBe(false);

    // The old bug: this used to satisfy status=downloaded (has_file=1) and never satisfy
    // status=missing, even with 2 of 3 episodes missing.
    expect(await runQueryFor(partiallyDownloaded, { status: "downloaded", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(partiallyDownloaded, { status: "missing", allowedTypes: null })).toBe(true);

    expect(await runQueryFor(fullyMissing, { status: "downloaded", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(fullyMissing, { status: "missing", allowedTypes: null })).toBe(true);
  });

  // Regression coverage for the course/adult -> episodic shape switch: a not-yet-converted item
  // (see media_items.legacy_shape) must keep being evaluated under its OLD, real shape, not the
  // type's new "episodic" one — its data still lives in the old structure until Convert to
  // Episodic runs, so evaluating it as episodic would wrongly call it "missing" forever.
  it("status downloaded/missing on a legacy_shape='single' item (a not-yet-converted adult item) still just checks has_file, even though its type is now episodic", async () => {
    const result = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, has_file, path, monitored, status, legacy_shape) VALUES ('adult', 'Legacy Adult', 'legacy adult', 1, '/clip.mp4', 1, 'downloaded', 'single')`
      )
      .run();
    const id = Number(result.lastInsertRowid);

    expect(await runQueryFor(id, { status: "downloaded", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(id, { status: "missing", allowedTypes: null })).toBe(false);
  });

  it("status downloaded/missing on a legacy_shape='collection' item (a not-yet-converted course) is based on its sub_items, even though its type is now episodic", async () => {
    const result = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, has_file, monitored, status, legacy_shape) VALUES ('course', 'Legacy Course', 'legacy course', 1, 1, 'downloaded', 'collection')`
      )
      .run();
    const id = Number(result.lastInsertRowid);
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, has_file, monitored) VALUES (?, 'Lesson 1', 1, 1)`).run(id);
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, has_file, monitored) VALUES (?, 'Lesson 2', 0, 1)`).run(id);

    // 1 of 2 lessons downloaded — if this were wrongly treated as episodic (0 episodes exist for
    // it), it would satisfy neither downloaded nor missing at all.
    expect(await runQueryFor(id, { status: "downloaded", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(id, { status: "missing", allowedTypes: null })).toBe(true);
  });

  it("systemGroupId matches an item grouped at a descendant (Maker) level under that System, not just the System group itself", async () => {
    const systemId = Number(
      (await db.prepare(`INSERT INTO library_groups (media_type, kind, name, sort_name) VALUES ('rom','system','SNES','snes')`).run()).lastInsertRowid
    );
    const otherSystemId = Number(
      (await db.prepare(`INSERT INTO library_groups (media_type, kind, name, sort_name) VALUES ('rom','system','NES','nes')`).run()).lastInsertRowid
    );
    const makerId = Number(
      (
        await db
          .prepare(`INSERT INTO library_groups (media_type, kind, name, sort_name, parent_group_id) VALUES ('rom','maker','Nintendo','nintendo',?)`)
          .run(systemId)
      ).lastInsertRowid
    );
    const romResult = await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, has_file, monitored, status, group_id) VALUES ('rom', 'Some Game', 'some game', 1, 1, 'downloaded', ?)`)
      .run(makerId);
    const romId = Number(romResult.lastInsertRowid);

    expect(await runQueryFor(romId, { systemGroupId: String(systemId), allowedTypes: null })).toBe(true);
    expect(await runQueryFor(romId, { systemGroupId: String(otherSystemId), allowedTypes: null })).toBe(false);
  });

  it("systemGroupId short-circuits to no rows for a group id that doesn't exist", async () => {
    const result = await buildMediaQuery({ systemGroupId: "999999", allowedTypes: null });
    expect(result.where).toBeNull();
  });

  it("status:unmatched includes an item with null, empty, or bare-'{}' external_ids, but not a real match", async () => {
    const nullIds = await insertItem({ title: "Unmatched Null", external_ids: null });
    const emptyIds = await insertItem({ title: "Unmatched Empty", external_ids: "" });
    const emptyObjectIds = await insertItem({ title: "Unmatched Object", external_ids: "{}" });
    const matchedIds = await insertItem({ title: "Matched", external_ids: '{"tmdb":"1"}' });

    const filters = { status: "unmatched", allowedTypes: null } as const;
    expect(await runQueryFor(nullIds, filters)).toBe(true);
    expect(await runQueryFor(emptyIds, filters)).toBe(true);
    expect(await runQueryFor(emptyObjectIds, filters)).toBe(true);
    expect(await runQueryFor(matchedIds, filters)).toBe(false);
  });

  it("contentRating filters to exactly one rating, and 'all' applies no restriction", async () => {
    const pgId = await insertItem({ title: "PG Item", content_rating: "PG" });
    const rId = await insertItem({ title: "R Item", content_rating: "R" });

    expect(await runQueryFor(pgId, { contentRating: "PG", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(rId, { contentRating: "PG", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(rId, { contentRating: "all", allowedTypes: null })).toBe(true);
  });

  it("genre filters via a substring match on the JSON array text, and 'all' applies no restriction", async () => {
    const comedyId = await insertItem({ title: "Comedy Item", genres: JSON.stringify(["Comedy", "Drama"]) });
    const actionId = await insertItem({ title: "Action Item", genres: JSON.stringify(["Action"]) });
    const noGenreId = await insertItem({ title: "No Genre Item" });

    expect(await runQueryFor(comedyId, { genre: "Comedy", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(comedyId, { genre: "Drama", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(actionId, { genre: "Comedy", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(noGenreId, { genre: "Comedy", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(actionId, { genre: "all", allowedTypes: null })).toBe(true);
  });

  it("genre filter doesn't false-positive-match a genre name that's a substring of a different genre", async () => {
    // "Action" is a substring of "Live Action" — the LIKE '%"<name>"%' match wraps in quotes
    // specifically so this can't happen (the quoted JSON boundary makes "Action" and "Live Action"
    // distinct strings to match against, unlike a bare substring search would).
    const liveActionId = await insertItem({ title: "Live Action Item", genres: JSON.stringify(["Live Action"]) });

    expect(await runQueryFor(liveActionId, { genre: "Action", allowedTypes: null })).toBe(false);
    expect(await runQueryFor(liveActionId, { genre: "Live Action", allowedTypes: null })).toBe(true);
  });

  // findCutoffUnmetIds/findFilenameMismatchIds (below) scan literally every media_items row with
  // no type filter at all -- allowedTypes only ever applies to the SEPARATE m.type IN (...)
  // condition, never to whether either ids list comes back empty. Each test below is fully
  // self-contained (an explicit cleanup of the exact criterion each helper filters on, first)
  // rather than depending on running before any sibling test that might otherwise leave a
  // qualifying row behind -- this file has no cleanup between tests by its own established
  // convention, and relying on declaration order alone proved fragile under a full-suite run.
  it("status:cutoffUnmet: where:null when nothing qualifies, then includes/excludes items relative to the cutoff", async () => {
    await db.prepare("DELETE FROM media_items WHERE quality IS NOT NULL").run();
    await db.prepare("DELETE FROM quality_profiles WHERE name = 'Cutoff Test Profile'").run();
    expect((await buildMediaQuery({ status: "cutoffUnmet", allowedTypes: null })).where).toBeNull();

    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Cutoff Test Profile', '[]', 'Bluray-1080p')").run())
        .lastInsertRowid
    );
    const belowId = await insertItem({ title: "Below Cutoff", has_file: 1, quality: "SD", quality_profile_id: profileId });
    const atId = await insertItem({ title: "At Cutoff", has_file: 1, quality: "Bluray-1080p", quality_profile_id: profileId });
    const aboveId = await insertItem({ title: "Above Cutoff", has_file: 1, quality: "Remux-2160p", quality_profile_id: profileId });

    const filters = { status: "cutoffUnmet", allowedTypes: null } as const;
    expect(await runQueryFor(belowId, filters)).toBe(true);
    expect(await runQueryFor(atId, filters)).toBe(false);
    expect(await runQueryFor(aboveId, filters)).toBe(false);
  });

  it("status:filenameMismatch: where:null when nothing qualifies, then flags a mismatched file but not a well-matched one", async () => {
    await db.prepare("DELETE FROM media_items WHERE path IS NOT NULL").run();
    expect((await buildMediaQuery({ status: "filenameMismatch", allowedTypes: null })).where).toBeNull();

    const mismatchedId = await insertItem({ title: "The Matrix", has_file: 1, path: "/movies/Completely.Different.Release.Name.2160p.mkv" });
    const matchedId = await insertItem({ title: "The Matrix", has_file: 1, path: "/movies/The.Matrix.1999.1080p.mkv" });

    const filters = { status: "filenameMismatch", allowedTypes: null } as const;
    expect(await runQueryFor(mismatchedId, filters)).toBe(true);
    expect(await runQueryFor(matchedId, filters)).toBe(false);
  });

  it("wires a free-text search into the SQLite FTS5 subquery with the toFts5Query-transformed term, or a plain ILIKE under Postgres (no FTS5 there)", async () => {
    const result = await buildMediaQuery({ q: "the matrix", allowedTypes: null });
    if (db.dialect === "postgres") {
      expect(result.where).toContain("m.title ILIKE ?");
      expect(result.params).toContain("%the matrix%");
    } else {
      expect(result.where).toContain("library_search_fts MATCH ?");
      expect(result.params).toContain(toFts5Query("the matrix"));
    }
  });

  it("a blank/whitespace-only search term adds no condition at all", async () => {
    const result = await buildMediaQuery({ q: "   ", allowedTypes: null });
    expect(result.where).toBe("1=1");
  });

  it("free-text search also matches against genres, not just the title", async () => {
    const comedyId = await insertItem({ title: "Totally Unrelated Title", genres: JSON.stringify(["Comedy"]) });
    const dramaId = await insertItem({ title: "Another Unrelated Title", genres: JSON.stringify(["Drama"]) });

    expect(await runQueryFor(comedyId, { q: "comedy", allowedTypes: null })).toBe(true);
    expect(await runQueryFor(dramaId, { q: "comedy", allowedTypes: null })).toBe(false);
  });

  it("tagId combined with an explicit type adds both conditions and still joins media_item_tags", async () => {
    const result = await buildMediaQuery({ tagId: "5", type: "movie", allowedTypes: ["movie"] });
    expect(result.where).toBe("mit.tag_id = ? AND m.type = ?");
    expect(result.params).toEqual(["5", "movie"]);
    expect(result.fromClause).toContain("JOIN media_item_tags");
  });

  it("a plain (non-'none') groupId filters to that group alone", async () => {
    const result = await buildMediaQuery({ groupId: "12", allowedTypes: null });
    expect(result.where).toBe("m.group_id = ?");
    expect(result.params).toEqual(["12"]);
  });
});

// SQLite only: Postgres has no FTS index, and its q filter matches an item's own title only.
describe("free-text search follows episodes/sub-items moved to a different item", () => {
  async function insertParent(type: "series" | "artist", title: string): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'unknown')`)
          .run(type, title, title.toLowerCase())
      ).lastInsertRowid
    );
  }

  async function insertSubItem(mediaItemId: number, title: string): Promise<number> {
    return Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, ?, 0)").run(mediaItemId, title)).lastInsertRowid);
  }

  async function idsMatchingSearch(q: string): Promise<number[]> {
    const query = await buildMediaQuery({ q, allowedTypes: null });
    const rows = (await db.prepare(`SELECT m.id FROM ${query.fromClause} WHERE ${query.where}`).all(...query.params)) as { id: number }[];
    return rows.map((r) => Number(r.id));
  }

  it("a re-parented episode or sub-item is found under its new item, not the old one (e.g. a series split)", async () => {
    if (db.dialect === "postgres") return;
    const oldShow = await insertParent("series", "Split Source Show");
    const newShow = await insertParent("series", "Split Target Show");
    const episodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 2, 1, 'Platypus Reunion', 1, 0)")
          .run(oldShow)
      ).lastInsertRowid
    );
    await db.prepare("UPDATE episodes SET media_item_id = ? WHERE id = ?").run(newShow, episodeId);
    expect(await idsMatchingSearch("Platypus Reunion")).toEqual([newShow]);

    const oldArtist = await insertParent("artist", "Move Source Band");
    const newArtist = await insertParent("artist", "Move Target Band");
    const subItemId = await insertSubItem(oldArtist, "Echidna Anthology");
    await db.prepare("UPDATE sub_items SET media_item_id = ? WHERE id = ?").run(newArtist, subItemId);
    expect(await idsMatchingSearch("Echidna Anthology")).toEqual([newArtist]);
  });

  it("the startup upgrade replaces an outdated title-only trigger and re-points entries that already drifted", async () => {
    if (db.dialect === "postgres") return;
    const { db: rawDb, upgradeFtsReparentTriggers } = await import("../src/db/client.js");
    // The trigger as it shipped before it tracked media_item_id.
    rawDb.exec(`
      DROP TRIGGER trg_fts_sub_items_au;
      CREATE TRIGGER trg_fts_sub_items_au AFTER UPDATE OF title ON sub_items BEGIN
        UPDATE library_search_fts SET title = new.title, match_detail = new.title WHERE match_type = 'child' AND source_id = old.id;
      END;
    `);
    const from = await insertParent("artist", "Drift Source Band");
    const to = await insertParent("artist", "Drift Target Band");
    const subItemId = await insertSubItem(from, "Numbat Rarities");
    await db.prepare("UPDATE sub_items SET media_item_id = ? WHERE id = ?").run(to, subItemId);
    expect(await idsMatchingSearch("Numbat Rarities")).toEqual([from]); // the stale entry the old trigger left behind

    upgradeFtsReparentTriggers();

    const trigger = rawDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_fts_sub_items_au'").get() as { sql: string };
    expect(trigger.sql).toContain("media_item_id");
    expect(await idsMatchingSearch("Numbat Rarities")).toEqual([to]);

    // Idempotent, and later moves are tracked by the recreated trigger.
    upgradeFtsReparentTriggers();
    await db.prepare("UPDATE sub_items SET media_item_id = ? WHERE id = ?").run(from, subItemId);
    expect(await idsMatchingSearch("Numbat Rarities")).toEqual([from]);
  });
});
