import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { nowExpr } from "../src/db/asyncDb.js";

// recycleBin.ts and notifications.ts each have their own dedicated test file covering their real
// internals -- mocked here (closure-indirection) so duplicateCheck.ts's own dispatch to them is
// what's under test.
const recycleFile = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/recycleBin.js", () => ({ recycleFile: (...args: unknown[]) => recycleFile(...args) }));
const notifyDuplicatesFound = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/notifications.js", () => ({ notifyDuplicatesFound: (...args: unknown[]) => notifyDuplicatesFound(...args) }));

afterEach(() => {
  vi.clearAllMocks();
  recycleFile.mockResolvedValue(undefined);
  notifyDuplicatesFound.mockResolvedValue(undefined);
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function insertMovie(title: string, year: number | null, hasFile: 0 | 1, overrides: Record<string, unknown> = {}) {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, overview, poster_url, external_ids)
       VALUES ('movie', ?, ?, ?, 1, ?, 'unknown', ?, ?, ?)`
    )
    .run(
      title,
      title.toLowerCase(),
      year,
      hasFile,
      (overrides.overview as string) ?? null,
      (overrides.posterUrl as string) ?? null,
      (overrides.externalIds as string) ?? "{}"
    );
  return Number(result.lastInsertRowid);
}

describe("duplicateCheck", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("findDuplicateGroups groups items by normalized title + year, ignoring case/punctuation", async () => {
    const { findDuplicateGroups } = await import("../src/services/duplicateCheck.js");

    await insertMovie("Dune: Part Two", 2024, 0);
    await insertMovie("dune part two", 2024, 1);
    await insertMovie("Dune", 1984, 0); // different year — must NOT be grouped with the above
    await insertMovie("Totally Unrelated Movie", 2024, 0);

    const groups = await findDuplicateGroups("movie");
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].year).toBe(2024);
  });

  it("findDuplicateGroups suggests the item with a file as the keeper", async () => {
    const { findDuplicateGroups } = await import("../src/services/duplicateCheck.js");

    const groups = await findDuplicateGroups("movie");
    const duneGroup = groups.find((g) => g.year === 2024)!;
    const keeper = duneGroup.items.find((i) => i.suggestedKeeper);
    expect(keeper?.hasFile).toBe(true);
  });

  it("mergeMediaItems moves the loser's file onto a fileless keeper and deletes the loser", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");

    const keeperId = await insertMovie("Merge Target", 2020, 0);
    const loserId = await insertMovie("Merge Target", 2020, 1, { overview: "loser overview" });
    await db.prepare("UPDATE media_items SET path = ? WHERE id = ?").run("/media/Merge Target/loser.mkv", loserId);

    const result = await mergeMediaItems(keeperId, [loserId], false);
    expect(result.merged).toBe(1);

    const keeperRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(keeperId)) as any;
    expect(keeperRow.has_file).toBe(1);
    expect(keeperRow.path).toBe("/media/Merge Target/loser.mkv");
    expect(keeperRow.overview).toBe("loser overview");

    const loserRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(loserId);
    expect(loserRow).toBeUndefined();
  });

  it("mergeMediaItems reassigns history rows from loser to keeper instead of losing them", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");

    const keeperId = await insertMovie("History Keeper", 2021, 1);
    const loserId = await insertMovie("History Keeper", 2021, 0);
    await db
      .prepare(`INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', '{}', ${nowExpr(db)})`)
      .run(loserId);

    await mergeMediaItems(keeperId, [loserId], false);

    const historyRows = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").all(keeperId)) as any[];
    expect(historyRows).toHaveLength(1);
  });

  it("mergeMediaItems merges episodic children without colliding on season/episode", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");

    const keeperId = (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 0, 'unknown')`)
        .run()
    ).lastInsertRowid as number;
    const loserId = (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 0, 'unknown')`)
        .run()
    ).lastInsertRowid as number;

    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 1, 1, 'Pilot', 1, 1)")
      .run(keeperId);
    // Loser has episode 1 (collides — should stay put, not move) and episode 2 (no collision — should move).
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 1, 1, 'Pilot (dupe)', 1, 0)")
      .run(loserId);
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 1, 2, 'Episode 2', 1, 1)")
      .run(loserId);

    await mergeMediaItems(keeperId, [loserId], false);

    const keeperEpisodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(keeperId)) as any[];
    expect(keeperEpisodes).toHaveLength(2);
    expect(keeperEpisodes[0].title).toBe("Pilot"); // the collision kept the keeper's own episode 1
    expect(keeperEpisodes[1].title).toBe("Episode 2");

    const keeperRow = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(keeperId)) as any;
    expect(keeperRow.has_file).toBe(1); // rollup: keeper now has at least one file'd episode
  });

  it("dismissDuplicateGroup removes a group from findDuplicateGroups without touching either item", async () => {
    const { findDuplicateGroups, dismissDuplicateGroup } = await import("../src/services/duplicateCheck.js");

    const idA = await insertMovie("Not Actually A Duplicate", 2022, 0);
    const idB = await insertMovie("Not Actually A Duplicate", 2022, 1);

    const before = await findDuplicateGroups("movie");
    const group = before.find((g) => g.title === "Not Actually A Duplicate");
    expect(group).toBeDefined();
    expect(group!.items).toHaveLength(2);

    await dismissDuplicateGroup(group!.key);

    const after = await findDuplicateGroups("movie");
    expect(after.find((g) => g.title === "Not Actually A Duplicate")).toBeUndefined();

    // Dismissing only hides the group from the sweep — neither item is deleted or modified.
    const rowA = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(idA);
    const rowB = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(idB);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
  });

  it("dismissDuplicateGroup is idempotent (dismissing twice doesn't error)", async () => {
    const { findDuplicateGroups, dismissDuplicateGroup } = await import("../src/services/duplicateCheck.js");

    await insertMovie("Dismiss Twice", 2021, 0);
    await insertMovie("Dismiss Twice", 2021, 1);

    const groups = await findDuplicateGroups("movie");
    const group = groups.find((g) => g.title === "Dismiss Twice")!;

    await dismissDuplicateGroup(group.key);
    await expect(dismissDuplicateGroup(group.key)).resolves.not.toThrow();
  });

  it("findPossibleDuplicates matches by normalized title, requiring agreement only when both sides have a year", async () => {
    const { findPossibleDuplicates } = await import("../src/services/duplicateCheck.js");

    const sameYearId = await insertMovie("Pre-Add Check", 2020, 0);
    await insertMovie("Pre-Add Check", 2021, 0); // different known year -> excluded
    const noYearId = await insertMovie("No Year Movie", null, 0);

    const withYear = await findPossibleDuplicates("movie", "pre add check", 2020);
    expect(withYear.map((d) => d.id)).toEqual([sameYearId]);

    // Neither side needs a year to agree when at least one is unknown -- looser than
    // mediaServerImport.ts's titleAndYearMatch, which requires an EXACT match in that case.
    const eitherUnknown = await findPossibleDuplicates("movie", "No Year Movie", 2020);
    expect(eitherUnknown.map((d) => d.id)).toEqual([noYearId]);

    expect(await findPossibleDuplicates("movie", "", 2020)).toEqual([]);
    expect(await findPossibleDuplicates("series", "Pre-Add Check", 2020)).toEqual([]); // scoped to type
  });

  it("findPossibleDuplicates also matches on a shared external id, even with a different title and year", async () => {
    const { findPossibleDuplicates } = await import("../src/services/duplicateCheck.js");

    const existingId = await insertMovie("Original Title", 2019, 0, { externalIds: JSON.stringify({ tmdb: "555", tvdb: "999" }) });

    // Same tmdb id, but a totally different title/year — the exact drift-between-providers case
    // this was added for (see services/libraryScan.ts's matchAdditionalProviders doc comment).
    const matches = await findPossibleDuplicates("movie", "A Completely Different Title", 2024, { tmdb: "555" });
    expect(matches.map((d) => d.id)).toEqual([existingId]);

    // A different id for the same provider does not match.
    expect(await findPossibleDuplicates("movie", "Yet Another Title", 2024, { tmdb: "556" })).toEqual([]);

    // No externalIds passed at all falls back to today's title/year-only behavior.
    expect(await findPossibleDuplicates("movie", "A Completely Different Title", 2024)).toEqual([]);
  });

  it("findDuplicateGroups also groups rows sharing an external id even when title/year differ", async () => {
    const { findDuplicateGroups } = await import("../src/services/duplicateCheck.js");

    const idA = await insertMovie("External Id Group A", 2018, 0, { externalIds: JSON.stringify({ tmdb: "42424" }) });
    const idB = await insertMovie("External Id Group B", 2021, 1, { externalIds: JSON.stringify({ tmdb: "42424", tvdb: "1" }) });

    const groups = await findDuplicateGroups("movie");
    const group = groups.find((g) => g.items.some((i) => i.id === idA) && g.items.some((i) => i.id === idB));
    expect(group).toBeDefined();
    expect(group!.key).toContain("ext::tmdb:42424");
    expect(group!.items.map((i) => i.matchedProviders).flat()).toEqual(expect.arrayContaining(["tmdb", "tvdb"]));
  });
});

describe("mergeMediaItems: guard branches", () => {
  it("returns {merged:0} without touching the DB when loserIds is empty or only contains the keeper itself", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Guard Test", 2020, 1);

    expect(await mergeMediaItems(keeperId, [], false)).toEqual({ merged: 0, skippedShapeMismatch: [] });
    expect(await mergeMediaItems(keeperId, [keeperId, keeperId], false)).toEqual({ merged: 0, skippedShapeMismatch: [] });
  });

  it("throws when the keeper doesn't exist", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    await expect(mergeMediaItems(999999, [1], false)).rejects.toThrow("Keeper item not found");
  });

  it("silently skips a loser id that doesn't exist, or whose type doesn't match the keeper's", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Type Guard Keeper", 2020, 1);
    const wrongTypeId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Wrong Type', 'wrong type', 1, 0, 'unknown')`).run()
    ).lastInsertRowid as number;

    const result = await mergeMediaItems(keeperId, [999999, wrongTypeId], false);

    expect(result).toEqual({ merged: 0, skippedShapeMismatch: [] });
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(wrongTypeId)).toBeDefined(); // untouched, not deleted
  });

  it("merges more than one loser into the same keeper in a single call", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Multi Merge", 2020, 0);
    const loser1 = await insertMovie("Multi Merge", 2020, 0, { overview: "from loser 1" });
    const loser2 = await insertMovie("Multi Merge", 2020, 0, { overview: "from loser 2" });

    const result = await mergeMediaItems(keeperId, [loser1, loser2], false);

    expect(result).toEqual({ merged: 2, skippedShapeMismatch: [] });
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(loser1)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(loser2)).toBeUndefined();
  });
});

describe("mergeMediaItems: collection shape (sub_items)", () => {
  async function insertArtist(): Promise<number> {
    return Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Band', 'band', 1, 0, 'unknown')`).run())
        .lastInsertRowid
    );
  }

  it("moves a non-colliding sub-item to the keeper, and rolls up has_file once it has a file'd child", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertArtist();
    const loserId = await insertArtist();
    const subId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Album One', 1)").run(loserId)).lastInsertRowid);

    await mergeMediaItems(keeperId, [loserId], false);

    const moved = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(moved.media_item_id).toBe(keeperId);
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(keeperId)) as any).has_file).toBe(1);
  });

  it("leaves a title-colliding sub-item's file alone (deleteFiles=false) or recycles it (deleteFiles=true), and it's gone once the loser is deleted", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    let keeperId = await insertArtist();
    let loserId = await insertArtist();
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Same Album', 1)").run(keeperId);
    let loserSubId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, 'Same Album', 1, '/music/dupe.mp3')").run(loserId)).lastInsertRowid
    );

    await mergeMediaItems(keeperId, [loserId], false);
    expect(recycleFile).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM sub_items WHERE id = ?").get(loserSubId)).toBeUndefined(); // gone via cascade with the loser row

    keeperId = await insertArtist();
    loserId = await insertArtist();
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Same Album', 1)").run(keeperId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, 'Same Album', 1, '/music/dupe2.mp3')").run(loserId);

    await mergeMediaItems(keeperId, [loserId], true);
    // null: recycling runs after the merge commits, when the loser row no longer exists to reference.
    expect(recycleFile).toHaveBeenCalledWith("/music/dupe2.mp3", "artist", expect.stringContaining("Same Album"), null);
  });
});

describe("mergeMediaItems: file recycling (single-shape) and episode-collision recycling", () => {
  it("single-shape: both keeper and loser have different files -- abandons the loser's file when deleteFiles=false, recycles it when true", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    let keeperId = await insertMovie("Both Have Files", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/keeper.mkv' WHERE id = ?").run(keeperId);
    let loserId = await insertMovie("Both Have Files", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/loser.mkv' WHERE id = ?").run(loserId);

    await mergeMediaItems(keeperId, [loserId], false);
    expect(recycleFile).not.toHaveBeenCalled();

    keeperId = await insertMovie("Both Have Files 2", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/keeper2.mkv' WHERE id = ?").run(keeperId);
    loserId = await insertMovie("Both Have Files 2", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/loser2.mkv' WHERE id = ?").run(loserId);

    await mergeMediaItems(keeperId, [loserId], true);
    expect(recycleFile).toHaveBeenCalledWith("/movies/loser2.mkv", "movie", "Both Have Files 2", null);
    // The keeper's own file is untouched by the merge.
    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(keeperId)) as any).path).toBe("/movies/keeper2.mkv");
  });

  it("episodic: a colliding episode's file is left alone (deleteFiles=false) or recycled (deleteFiles=true)", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Collision Show', 'collision show', 1, 1, 'unknown')`).run()
    ).lastInsertRowid as number;
    const loserId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Collision Show', 'collision show', 1, 1, 'unknown')`).run()
    ).lastInsertRowid as number;
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, has_file) VALUES (?, 1, 1, 1)").run(keeperId);
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path) VALUES (?, 1, 1, 1, '/tv/dupe.mkv')").run(loserId);

    await mergeMediaItems(keeperId, [loserId], true);

    expect(recycleFile).toHaveBeenCalledWith("/tv/dupe.mkv", "series", expect.stringContaining("Collision Show"), null);
  });

  it("recycles only after the merge transaction has committed, never while it is still open", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Recycle After Commit", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/rac-keeper.mkv' WHERE id = ?").run(keeperId);
    const loserId = await insertMovie("Recycle After Commit", 2020, 1);
    await db.prepare("UPDATE media_items SET path = '/movies/rac-loser.mkv' WHERE id = ?").run(loserId);

    let loserRowDuringRecycle: unknown = "recycleFile never ran";
    recycleFile.mockImplementationOnce(async () => {
      loserRowDuringRecycle = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(loserId);
    });

    await mergeMediaItems(keeperId, [loserId], true);

    expect(recycleFile).toHaveBeenCalledTimes(1);
    // Inside the transaction the loser row would still be visible; after COMMIT it's gone.
    expect(loserRowDuringRecycle).toBeUndefined();
  });
});

describe("mergeMediaItems: not-yet-converted (legacy_shape) course/adult items", () => {
  async function insertLegacy(type: "adult" | "course", title: string, legacyShape: string | null, hasFile: 0 | 1, path: string | null = null) {
    return Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, path, status, legacy_shape) VALUES (?, ?, ?, 2020, 1, ?, ?, 'unknown', ?)`
          )
          .run(type, title, title.toLowerCase(), hasFile, path, legacyShape)
      ).lastInsertRowid
    );
  }

  it("a legacy single-file adult item adopts the loser's file instead of looking for episodes it doesn't have", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertLegacy("adult", "Legacy Adult Merge", "single", 0);
    const loserId = await insertLegacy("adult", "Legacy Adult Merge", "single", 1, "/adult/legacy-clip.mp4");

    expect(await mergeMediaItems(keeperId, [loserId], false)).toEqual({ merged: 1, skippedShapeMismatch: [] });

    const keeperRow = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(keeperId)) as any;
    expect(keeperRow.has_file).toBe(1);
    expect(keeperRow.path).toBe("/adult/legacy-clip.mp4");
  });

  it("a legacy collection-shaped course moves the loser's lessons (sub_items) to the keeper instead of cascade-deleting them", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertLegacy("course", "Legacy Course Merge", "collection", 0);
    const loserId = await insertLegacy("course", "Legacy Course Merge", "collection", 1);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Lesson 1', 0)").run(keeperId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, 'Lesson 1', 1, '/courses/dupe-lesson1.mp4')").run(loserId);
    const lesson2Id = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, 'Lesson 2', 1, '/courses/lesson2.mp4')").run(loserId))
        .lastInsertRowid
    );

    await mergeMediaItems(keeperId, [loserId], true);

    const moved = (await db.prepare("SELECT media_item_id FROM sub_items WHERE id = ?").get(lesson2Id)) as any;
    expect(moved?.media_item_id).toBe(keeperId);
    expect(recycleFile).toHaveBeenCalledWith("/courses/dupe-lesson1.mp4", "course", expect.stringContaining("Lesson 1"), null);
    // Rolled up from sub_items (the legacy shape's children), not from the empty episodes table.
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(keeperId)) as any).has_file).toBe(1);
  });

  it("skips a loser whose effective shape differs from the keeper's (legacy vs converted) rather than deleting its data", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const convertedKeeperId = await insertLegacy("adult", "Mixed Shape Adult", null, 0);
    const legacyLoserId = await insertLegacy("adult", "Mixed Shape Adult", "single", 1, "/adult/mixed.mp4");

    expect(await mergeMediaItems(convertedKeeperId, [legacyLoserId], false)).toEqual({ merged: 0, skippedShapeMismatch: [legacyLoserId] });
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(legacyLoserId)).toBeDefined();
  });

  // The Duplicates page offers mixed-shape items as one group, so the caller has to be told which
  // losers were left behind or a Merge that changes nothing looks like it silently failed.
  it("reports only the shape-mismatched losers as skipped when merging them alongside a compatible one", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertLegacy("adult", "Partly Mixed Adult", null, 0);
    const compatibleLoserId = await insertLegacy("adult", "Partly Mixed Adult", null, 0);
    const legacyLoserId = await insertLegacy("adult", "Partly Mixed Adult", "single", 1, "/adult/partly-mixed.mp4");

    const result = await mergeMediaItems(keeperId, [compatibleLoserId, legacyLoserId], false);

    expect(result).toEqual({ merged: 1, skippedShapeMismatch: [legacyLoserId] });
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(compatibleLoserId)).toBeUndefined();
    const legacyRow = (await db.prepare("SELECT path FROM media_items WHERE id = ?").get(legacyLoserId)) as any;
    expect(legacyRow?.path).toBe("/adult/partly-mixed.mp4");
  });

  it("findDuplicateGroups counts a legacy course's lessons from sub_items when picking the suggested keeper", async () => {
    const { findDuplicateGroups } = await import("../src/services/duplicateCheck.js");
    const emptyId = await insertLegacy("course", "Legacy Course Counts", "collection", 0);
    const withLessonsId = await insertLegacy("course", "Legacy Course Counts", "collection", 0);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Lesson A', 0)").run(withLessonsId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Lesson B', 0)").run(withLessonsId);

    const group = (await findDuplicateGroups("course")).find((g) => g.title === "Legacy Course Counts")!;
    expect(group).toBeDefined();
    expect(group.items.find((i) => i.id === withLessonsId)).toMatchObject({ childCount: 2, suggestedKeeper: true });
    expect(group.items.find((i) => i.id === emptyId)).toMatchObject({ childCount: 0, suggestedKeeper: false });
  });
});

describe("mergeMediaItems: global search index (SQLite FTS)", () => {
  async function insertParent(type: "series" | "artist", title: string): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'unknown')`)
          .run(type, title, title.toLowerCase())
      ).lastInsertRowid
    );
  }

  async function idsMatchingSearch(q: string): Promise<number[]> {
    const { buildMediaQuery } = await import("../src/services/mediaQuery.js");
    const query = await buildMediaQuery({ q, allowedTypes: null });
    const rows = (await db.prepare(`SELECT m.id FROM ${query.fromClause} WHERE ${query.where}`).all(...query.params)) as { id: number }[];
    return rows.map((r) => Number(r.id));
  }

  it("a moved episode or sub-item is found by its own title under the keeper, not the deleted loser", async () => {
    // Postgres has no FTS index; its q filter matches the item's own title only.
    if (db.dialect === "postgres") return;
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");

    const seriesKeeperId = await insertParent("series", "FTS Merge Show");
    const seriesLoserId = await insertParent("series", "FTS Merge Show");
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 1, 7, 'Quokka Harbour Finale', 1, 0)")
      .run(seriesLoserId);

    const artistKeeperId = await insertParent("artist", "FTS Merge Band");
    const artistLoserId = await insertParent("artist", "FTS Merge Band");
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file) VALUES (?, 'Wombat Sessions', 0)").run(artistLoserId);

    await mergeMediaItems(seriesKeeperId, [seriesLoserId], false);
    await mergeMediaItems(artistKeeperId, [artistLoserId], false);

    expect(await idsMatchingSearch("Quokka Harbour")).toEqual([seriesKeeperId]);
    expect(await idsMatchingSearch("Wombat Sessions")).toEqual([artistKeeperId]);
  });
});

describe("mergeMediaItems: tag/collection membership and other REASSIGN_TABLES", () => {
  it("copies the loser's tags and collection membership to the keeper, without duplicating one it already has", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Tag Merge Keeper", 2020, 1);
    const loserId = await insertMovie("Tag Merge Loser", 2020, 0);
    const sharedTagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('Shared')").run()).lastInsertRowid);
    const loserOnlyTagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('LoserOnly')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(keeperId, sharedTagId);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(loserId, sharedTagId);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(loserId, loserOnlyTagId);
    const collectionId = Number((await db.prepare("INSERT INTO collections (name) VALUES ('A Collection')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO collection_items (collection_id, media_item_id, position) VALUES (?, ?, 1)").run(collectionId, loserId);

    await mergeMediaItems(keeperId, [loserId], false);

    const keeperTags = ((await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(keeperId)) as any[]).map((r) => r.tag_id).sort();
    expect(keeperTags).toEqual([sharedTagId, loserOnlyTagId].sort()); // shared tag not duplicated, loser-only tag adopted
    expect(await db.prepare("SELECT * FROM collection_items WHERE collection_id = ? AND media_item_id = ?").get(collectionId, keeperId)).toBeDefined();
  });

  it("reassigns blocklist and queue rows from the loser to the keeper", async () => {
    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    const keeperId = await insertMovie("Reassign Keeper", 2020, 1);
    const loserId = await insertMovie("Reassign Loser", 2020, 0);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Bad Release')").run(loserId);
    await db.prepare("INSERT INTO queue (media_item_id, title) VALUES (?, 'Queued Release')").run(loserId);

    await mergeMediaItems(keeperId, [loserId], false);

    expect((await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").get(keeperId)) as any).toMatchObject({ release_title: "Bad Release" });
    expect((await db.prepare("SELECT * FROM queue WHERE media_item_id = ?").get(keeperId)) as any).toMatchObject({ title: "Queued Release" });
  });
});

describe("runScheduledDuplicateCheck", () => {
  // runScheduledDuplicateCheck calls findDuplicateGroups() with no type/title filter at all -- it
  // scans literally every media_items row. Every other describe block in this file deliberately
  // accumulates state across tests (a later test re-finds an earlier one's group), so by the time
  // this block runs there are real, undismissed duplicate pairs (e.g. the Dune one from the very
  // first test) still sitting in the shared DB. Wipe just for this block, the same fix
  // runAllImportLists's own tests needed for the identical "scans the whole table" reason.
  beforeEach(async () => {
    await db.prepare("DELETE FROM media_items").run();
    await db.prepare("DELETE FROM duplicate_group_seen").run();
  });

  it("returns {newGroups:0} and never notifies when there are no duplicate groups", async () => {
    const { runScheduledDuplicateCheck } = await import("../src/services/duplicateCheck.js");
    await expect(runScheduledDuplicateCheck()).resolves.toEqual({ newGroups: 0 });
    expect(notifyDuplicatesFound).not.toHaveBeenCalled();
  });

  it("records and notifies about a newly-found group, formatting the title with its year", async () => {
    const { runScheduledDuplicateCheck } = await import("../src/services/duplicateCheck.js");
    await insertMovie("Scheduled Find", 2022, 0);
    await insertMovie("Scheduled Find", 2022, 1);

    const result = await runScheduledDuplicateCheck();

    expect(result).toEqual({ newGroups: 1 });
    expect(notifyDuplicatesFound).toHaveBeenCalledWith(1, ["Scheduled Find (2022)"]);
    expect(await db.prepare("SELECT * FROM duplicate_group_seen WHERE type = 'movie' AND normalized_key LIKE '%scheduled find%'").get()).toBeDefined();
  });

  it("does not re-notify about a group already recorded from an earlier run", async () => {
    const { findDuplicateGroups, runScheduledDuplicateCheck } = await import("../src/services/duplicateCheck.js");
    await insertMovie("Already Seen Group", 2019, 0);
    await insertMovie("Already Seen Group", 2019, 1);
    const [group] = (await findDuplicateGroups("movie")).filter((g) => g.title === "Already Seen Group");
    await db.prepare("INSERT INTO duplicate_group_seen (type, normalized_key) VALUES (?, ?)").run(group.type, group.key);

    const result = await runScheduledDuplicateCheck();

    expect(result.newGroups).toBe(0);
    expect(notifyDuplicatesFound).not.toHaveBeenCalled();
  });

  it("caps the notified title list at 5 while still reporting the true total new-group count", async () => {
    const { runScheduledDuplicateCheck } = await import("../src/services/duplicateCheck.js");
    for (let i = 0; i < 6; i++) {
      await insertMovie(`Bulk Group ${i}`, 2020, 0);
      await insertMovie(`Bulk Group ${i}`, 2020, 1);
    }

    const result = await runScheduledDuplicateCheck();

    expect(result.newGroups).toBe(6);
    expect(notifyDuplicatesFound).toHaveBeenCalledTimes(1);
    const [count, titles] = notifyDuplicatesFound.mock.calls[0];
    expect(count).toBe(6);
    expect(titles).toHaveLength(5);
  });

  it("swallows a notification failure rather than throwing, after the groups are still recorded", async () => {
    const { runScheduledDuplicateCheck } = await import("../src/services/duplicateCheck.js");
    notifyDuplicatesFound.mockRejectedValue(new Error("webhook down"));
    await insertMovie("Notify Fails", 2020, 0);
    await insertMovie("Notify Fails", 2020, 1);

    await expect(runScheduledDuplicateCheck()).resolves.toEqual({ newGroups: 1 });
  });
});
