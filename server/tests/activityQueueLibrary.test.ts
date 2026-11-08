import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// The Activity queue says which library item each grab is for.
let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

beforeEach(async () => {
  for (const t of ["queue_targets", "queue", "episodes", "sub_items", "media_items"]) await db.prepare(`DELETE FROM ${t}`).run();
});

const id = async (sql: string, ...args: unknown[]) => Number((await db.prepare(sql).run(...args)).lastInsertRowid);
const queueItems = async () => ((await request(app).get("/api/activity/queue").set("X-Api-Key", apiKey)).body.items as any[]);

describe("GET /api/activity/queue: the library item of each grab", () => {
  it("names the title and year for a film, with no part", async () => {
    const movie = await id("INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('movie', 'Elio', 'elio', 2025, 1, 'missing')");
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'Elio.2025.iTA-ENG.PROPER.Bluray.1080p.x264-CYBER', 'downloading')").run(movie);
    const [row] = await queueItems();
    expect(row.library).toEqual({ mediaItemId: movie, title: "Elio", year: 2025, type: "movie", label: null, nameMismatch: null });
    expect(row.title).toBe("Elio.2025.iTA-ENG.PROPER.Bluray.1080p.x264-CYBER"); // the release name is still there
  });

  it("adds the episode for a series grab, the album for an artist's, and the season for a pack", async () => {
    const show = await id("INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('series', 'Old Show', 'old show', 2005, 1, 'missing')");
    const ep = await id("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 2, 5, 'The Fifth', 1, 0)", show);
    const untitled = await id("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 10, 11, NULL, 1, 0)", show);
    const artist = await id("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist', 'Some Band', 'some band', 1, 'missing')");
    const album = await id("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'First Album', 1, 0)", artist);
    await db.prepare("INSERT INTO queue (media_item_id, episode_id, title, status) VALUES (?, ?, 'Old.Show.S02E05.1080p', 'queued')").run(show, ep);
    await db.prepare("INSERT INTO queue (media_item_id, episode_id, title, status) VALUES (?, ?, 'Old.Show.S10E11.1080p', 'queued')").run(show, untitled);
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Some.Band.First.Album.FLAC', 'queued')").run(artist, album);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 3, 'Old.Show.S03.1080p.Pack', 'queued')").run(show);

    const byTitle = new Map((await queueItems()).map((r) => [r.title, r.library]));
    expect(byTitle.get("Old.Show.S02E05.1080p")).toMatchObject({ title: "Old Show", year: 2005, type: "series", label: "S02E05 · The Fifth" });
    expect(byTitle.get("Old.Show.S10E11.1080p")).toMatchObject({ label: "S10E11" });
    expect(byTitle.get("Some.Band.First.Album.FLAC")).toMatchObject({ title: "Some Band", year: null, type: "artist", label: "First Album" });
    expect(byTitle.get("Old.Show.S03.1080p.Pack")).toMatchObject({ title: "Old Show", label: "Season 3" });
  });

  it("flags a grab whose release name is another title, and leaves the right ones alone", async () => {
    const elio = await id("INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('movie', 'Elio', 'elio', 2025, 1, 'missing')");
    const show = await id("INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('series', 'Old Show', 'old show', 2005, 1, 'missing')");
    const ep = await id("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 2, 5, 'The Fifth', 1, 0)", show);
    const q = (item: number, title: string, episode: number | null = null) =>
      db.prepare("INSERT INTO queue (media_item_id, episode_id, title, status, match_type) VALUES (?, ?, ?, 'downloading', 'id')").run(item, episode, title);
    await q(elio, "Elio.2025.1080p.BluRay.x264-GRP"); // right
    await q(elio, "Soul.2020.BluRay.1080p.DDP.Atmos.5.1.x264-hallowed"); // another film, accepted on an indexer id
    await q(elio, "Elio.1999.1080p.BluRay.x264-GRP"); // the right title, the wrong year
    await q(show, "Old.Show.S02E05.1080p.WEB-DL-GRP", ep); // right
    await q(show, "Another.Show.S02E05.1080p.WEB-DL-GRP", ep); // another show

    const byTitle = new Map((await queueItems()).map((r) => [r.title, r]));
    expect(byTitle.get("Elio.2025.1080p.BluRay.x264-GRP").library.nameMismatch).toBeNull();
    expect(byTitle.get("Soul.2020.BluRay.1080p.DDP.Atmos.5.1.x264-hallowed").library.nameMismatch).toEqual(expect.any(String));
    expect(byTitle.get("Elio.1999.1080p.BluRay.x264-GRP").library.nameMismatch).toEqual(expect.any(String));
    expect(byTitle.get("Old.Show.S02E05.1080p.WEB-DL-GRP").library.nameMismatch).toBeNull();
    expect(byTitle.get("Another.Show.S02E05.1080p.WEB-DL-GRP").library.nameMismatch).toEqual(expect.any(String));
    // The queue row still says how the grab was accepted, so the page can show "accepted by: id".
    expect(byTitle.get("Soul.2020.BluRay.1080p.DDP.Atmos.5.1.x264-hallowed").matchType).toBe("id");
  });

  it("does not judge a type that has no quality tiers by name", async () => {
    const artist = await id("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist', 'Some Band', 'some band', 1, 'missing')");
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'Totally.Different.Name.FLAC', 'queued')").run(artist);
    const [row] = await queueItems();
    expect(row.library.nameMismatch).toBeNull();
  });

  it("answers an empty queue", async () => {
    expect(await queueItems()).toEqual([]);
  });
});
