import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { nowExpr } from "../src/db/asyncDb.js";

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
});
