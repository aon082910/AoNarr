import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let modes: typeof import("../src/services/monitorModes.js");
let mergeEpisodesIntoItem: (typeof import("../src/services/libraryScan.js"))["mergeEpisodesIntoItem"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  modes = await import("../src/services/monitorModes.js");
  ({ mergeEpisodesIntoItem } = await import("../src/services/libraryScan.js"));
});

beforeEach(async () => {
  for (const t of ["episodes", "sub_items", "media_items"]) await db.prepare(`DELETE FROM ${t}`).run();
});

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("subItemsToMonitor (ST5): the Add choice for albums and books", () => {
  const albums = [
    { key: "a", releaseDate: "2001-05-01" },
    { key: "b", releaseDate: "2010-01-01" },
    { key: "c", releaseDate: day(40) },
    { key: "d", releaseDate: null },
  ];

  it("all and missing keep every album", () => {
    expect([...modes.subItemsToMonitor(albums, "all")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...modes.subItemsToMonitor(albums, "missing")].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("future keeps only what is not out yet", () => {
    expect([...modes.subItemsToMonitor(albums, "future")]).toEqual(["c"]);
  });

  it("first and latest each keep one dated album", () => {
    expect([...modes.subItemsToMonitor(albums, "first")]).toEqual(["a"]);
    expect([...modes.subItemsToMonitor(albums, "latest")]).toEqual(["c"]);
  });

  it("none, and existing on a brand new add, keep nothing", () => {
    expect(modes.subItemsToMonitor(albums, "none").size).toBe(0);
    expect(modes.subItemsToMonitor(albums, "existing").size).toBe(0);
  });
});

describe("applySubItemMonitorMode / applyEpisodeMonitorMode", () => {
  it("switches off the albums a mode does not keep", async () => {
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist', 'Band', 'band', 1, 'missing')").run()).lastInsertRowid);
    for (const [title, date] of [
      ["Old", "1999-01-01"],
      ["Newer", "2015-01-01"],
    ]) {
      await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored) VALUES (?, ?, ?, 1)").run(id, title, date);
    }
    await modes.applySubItemMonitorMode(id, "latest");
    const rows = (await db.prepare("SELECT title, monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(id)) as any[];
    expect(rows.map((r) => [r.title, Number(r.monitored)])).toEqual([
      ["Old", 0],
      ["Newer", 1],
    ]);
  });

  it("switches off the episodes a mode does not keep", async () => {
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('series', 'Show', 'show', 1, 'missing')").run()).lastInsertRowid);
    for (const [season, episode, airDate] of [
      [1, 1, "2020-01-01"],
      [1, 2, "2020-01-08"],
      [2, 1, day(30)],
    ] as const) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?, ?, ?, 'x', ?, 1)").run(id, season, episode, airDate);
    }
    await modes.applyEpisodeMonitorMode(id, "future");
    const rows = (await db.prepare("SELECT season_number, episode_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(id)) as any[];
    expect(rows.map((r) => Number(r.monitored))).toEqual([0, 0, 1]);
  });
});

describe("newSubItemMonitored (ST5): Monitor New Items", () => {
  it("monitors everything when no choice was made, as before", () => {
    expect(modes.newSubItemMonitored(null, "1990-01-01", "2020-01-01")).toBe(true);
  });
  it("none monitors nothing", () => {
    expect(modes.newSubItemMonitored("none", "2030-01-01", "2020-01-01")).toBe(false);
  });
  it("new monitors only what is newer than what the item has", () => {
    expect(modes.newSubItemMonitored("new", "2021-01-01", "2020-01-01")).toBe(true);
    expect(modes.newSubItemMonitored("new", "2015-01-01", "2020-01-01")).toBe(false);
    expect(modes.newSubItemMonitored("new", null, "2020-01-01")).toBe(false);
  });
  it("new on an item with nothing yet is a first list, so it is monitored", () => {
    expect(modes.newSubItemMonitored("new", "2015-01-01", null)).toBe(true);
  });
});

describe("a refresh honors the item's Monitor New Items choice for episodes", () => {
  async function seriesWithOneEpisode(monitorNewItems: string | null): Promise<number> {
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status, monitor_new_items) VALUES ('series', 'Show', 'show', 1, 'missing', ?)").run(monitorNewItems)).lastInsertRowid
    );
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?, 1, 1, 'Pilot', '2015-01-01', 1)").run(id);
    return id;
  }
  const listing = [
    { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2015-01-01", overview: null },
    { seasonNumber: 1, episodeNumber: 2, title: "Old Later Episode", airDate: "2016-01-01", overview: null },
    { seasonNumber: 3, episodeNumber: 1, title: "Upcoming", airDate: day(20), overview: null },
  ] as any[];
  const monitoredOf = async (id: number, episode: number, season = 1) =>
    Number(((await db.prepare("SELECT monitored FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?").get(id, season, episode)) as any).monitored);

  it("none: new episodes are added unmonitored", async () => {
    const id = await seriesWithOneEpisode("none");
    await mergeEpisodesIntoItem(id, listing, undefined, true, true, true);
    expect(await monitoredOf(id, 2)).toBe(0);
    expect(await monitoredOf(id, 1, 3)).toBe(0);
  });

  it("none still wants an upcoming or just aired episode of a season the show already tracks, and not one of a new season (L6)", async () => {
    const id = await seriesWithOneEpisode("none");
    const fresh = [
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2015-01-01", overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: "This Week", airDate: day(-2), overview: null },
      { seasonNumber: 1, episodeNumber: 3, title: "Old Back Catalogue", airDate: "2016-06-01", overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "New Season Opener", airDate: day(10), overview: null },
    ] as any[];
    await mergeEpisodesIntoItem(id, fresh, undefined, true, true, true);
    expect(await monitoredOf(id, 2)).toBe(1);
    expect(await monitoredOf(id, 3)).toBe(0);
    expect(await monitoredOf(id, 1, 2)).toBe(0);
  });

  it("all: every new regular episode is monitored, even an old one", async () => {
    const id = await seriesWithOneEpisode("all");
    await mergeEpisodesIntoItem(id, listing, undefined, true, true, true);
    expect(await monitoredOf(id, 2)).toBe(1);
    expect(await monitoredOf(id, 1, 3)).toBe(1);
  });

  it("new: only an upcoming or just aired episode is monitored", async () => {
    const id = await seriesWithOneEpisode("new");
    await mergeEpisodesIntoItem(id, listing, undefined, true, true, false);
    expect(await monitoredOf(id, 2)).toBe(0);
    expect(await monitoredOf(id, 1, 3)).toBe(1);
  });

  it("an item that has no regular episodes yet is getting its first list, which the choice does not touch", async () => {
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status, monitor_new_items) VALUES ('series', 'Fresh', 'fresh', 1, 'missing', 'none')").run()).lastInsertRowid
    );
    await mergeEpisodesIntoItem(id, listing, undefined, true, true, false);
    expect(await monitoredOf(id, 2)).toBe(1);
  });
});
