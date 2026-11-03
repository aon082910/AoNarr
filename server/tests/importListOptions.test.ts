import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const searchMetadata = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchAlbumTracksFor: async () => [],
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
  };
});

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncImportList: (typeof import("../src/services/importLists.js"))["syncImportList"];
let cleanListItems: (typeof import("../src/services/importLists.js"))["cleanListItems"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
type ImportListRow = import("../src/services/importLists.js").ImportListRow;
const rootIds: Record<string, number> = {};
let tagId: number;

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ syncImportList, cleanListItems } = await import("../src/services/importLists.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  setSetting("traktClientId", "test-client");
  for (const type of ["movie", "series", "artist"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-listopts-${type}-`));
    rootIds[type] = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, type)).lastInsertRowid);
  }
  tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('from-list')").run()).lastInsertRowid);
});

beforeEach(async () => {
  for (const t of ["episodes", "sub_items", "media_item_tags", "media_items", "import_lists"]) await db.prepare(`DELETE FROM ${t}`).run();
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeList(extra: Record<string, unknown> = {}): Promise<ImportListRow> {
  const result = await db
    .prepare("INSERT INTO import_lists (name, type, url, enabled) VALUES ('Opts', 'trakt', 'https://trakt.tv/users/t/lists/l', 1)")
    .run();
  const id = Number(result.lastInsertRowid);
  for (const [column, value] of Object.entries(extra)) await db.prepare(`UPDATE import_lists SET ${column} = ? WHERE id = ?`).run(value, id);
  return (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(id)) as ImportListRow;
}

function traktReturns(entries: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => entries }));
}

const itemByTmdb = async (type: string, tmdb: number) =>
  (await db.prepare("SELECT * FROM media_items WHERE type = ? AND external_ids LIKE ?").get(type, `%"${tmdb}"%`)) as any;

describe("an import list's options (ST4)", () => {
  it("tags what it adds, remembers the list as the source, and applies its minimum availability", async () => {
    const list = await makeList({ tag_ids: JSON.stringify([tagId]), minimum_availability: "released" });
    traktReturns([{ movie: { title: "Tagged Film", year: 2024, ids: { tmdb: 7001, trakt: 1 } } }]);

    expect((await syncImportList(list)).added).toBe(1);

    const item = await itemByTmdb("movie", 7001);
    expect(Number(item.source_list_id)).toBe(list.id);
    expect(item.minimum_availability).toBe("released");
    const tags = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(item.id)) as any[];
    expect(tags.map((t) => Number(t.tag_id))).toEqual([tagId]);
  });

  it("monitor none adds the title unmonitored, a catalogue-only entry", async () => {
    const list = await makeList({ monitor: "none" });
    traktReturns([{ movie: { title: "Catalogue Film", year: 2024, ids: { tmdb: 7002, trakt: 2 } } }]);
    await syncImportList(list);
    expect(Number((await itemByTmdb("movie", 7002)).monitored)).toBe(0);
  });

  it("monitor future leaves only the upcoming episodes of a show monitored", async () => {
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Aired", airDate: "2020-01-01", overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Coming", airDate: day(25), overview: null },
    ]);
    const list = await makeList({ monitor: "future" });
    traktReturns([{ show: { title: "Future Show", year: 2024, ids: { tmdb: 7003, trakt: 3 } } }]);
    await syncImportList(list);

    const show = await itemByTmdb("series", 7003);
    const rows = (await db.prepare("SELECT title, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number").all(show.id)) as any[];
    expect(rows.map((r) => [r.title, Number(r.monitored)])).toEqual([
      ["Aired", 0],
      ["Coming", 1],
    ]);
  });

  it("passes monitor new items on to the title", async () => {
    const list = await makeList({ monitor_new_items: "none" });
    traktReturns([{ movie: { title: "New Items Film", year: 2024, ids: { tmdb: 7004, trakt: 4 } } }]);
    await syncImportList(list);
    expect((await itemByTmdb("movie", 7004)).monitor_new_items).toBe("none");
  });
});

describe("the list clean-up (ST4)", () => {
  async function addedByList(list: ImportListRow, tmdb: number, extra: Record<string, unknown> = {}): Promise<number> {
    const id = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status, source_list_id) VALUES ('movie', ?, ?, ?, 1, 'missing', ?)")
          .run(`Film ${tmdb}`, `film ${tmdb}`, JSON.stringify({ tmdb: String(tmdb) }), list.id)
      ).lastInsertRowid
    );
    for (const [column, value] of Object.entries(extra)) await db.prepare(`UPDATE media_items SET ${column} = ? WHERE id = ?`).run(value, id);
    return id;
  }
  const monitoredOf = async (id: number) => (await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(id)) as any;
  const exists = async (id: number) => !!(await db.prepare("SELECT 1 AS ok FROM media_items WHERE id = ?").get(id));

  it("logOnly changes nothing", async () => {
    const list = await makeList({ clean_level: "logOnly" });
    const stay = await addedByList(list, 8001);
    const gone = await addedByList(list, 8002);
    await cleanListItems(list, new Set(["movie:tmdb:8001"]));
    expect(Number((await monitoredOf(gone)).monitored)).toBe(1);
    expect(await exists(stay)).toBe(true);
  });

  it("keepAndUnmonitor unmonitors a title that left the list and keeps one that is still on it", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    const stay = await addedByList(list, 8011);
    const gone = await addedByList(list, 8012);
    await cleanListItems(list, new Set(["movie:tmdb:8011"]));
    expect(Number((await monitoredOf(gone)).monitored)).toBe(0);
    expect(Number((await monitoredOf(stay)).monitored)).toBe(1);
  });

  it("removeAndKeep takes the title out of the library", async () => {
    const list = await makeList({ clean_level: "removeAndKeep" });
    const stay = await addedByList(list, 8021);
    const gone = await addedByList(list, 8022);
    expect(await cleanListItems(list, new Set(["movie:tmdb:8021"]))).toBe(1);
    expect(await exists(gone)).toBe(false);
    expect(await exists(stay)).toBe(true);
  });

  it("never touches a protected title or one another list added", async () => {
    const list = await makeList({ clean_level: "removeAndKeep" });
    const other = await makeList({ name: "Other" });
    const protectedId = await addedByList(list, 8031, { protected: 1 });
    const fromOther = await addedByList(other, 8032);
    await cleanListItems(list, new Set(["movie:tmdb:9999"]));
    expect(await exists(protectedId)).toBe(true);
    expect(await exists(fromOther)).toBe(true);
  });

  it("refuses to clean most of a list at once, since the list probably came back short", async () => {
    const list = await makeList({ clean_level: "removeAndKeep" });
    const ids: number[] = [];
    for (let n = 0; n < 14; n++) ids.push(await addedByList(list, 8100 + n));
    expect(await cleanListItems(list, new Set(["movie:tmdb:8100"]))).toBe(0);
    for (const id of ids) expect(await exists(id)).toBe(true);
  });

  it("a sync that read nothing from the list cleans nothing", async () => {
    const list = await makeList({ clean_level: "removeAndKeep" });
    const id = await addedByList(list, 8201);
    traktReturns([]);
    await syncImportList(list);
    expect(await exists(id)).toBe(true);
  });

  it("a sync cleans what left the list and keeps what is still on it", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    const stay = await addedByList(list, 8301);
    const gone = await addedByList(list, 8302);
    traktReturns([{ movie: { title: "Film 8301", year: 2024, ids: { tmdb: 8301, trakt: 1 } } }]);
    await syncImportList(list);
    expect(Number((await monitoredOf(stay)).monitored)).toBe(1);
    expect(Number((await monitoredOf(gone)).monitored)).toBe(0);
  });
});

describe("the import list routes carry the new options", () => {
  it("stores them on create and edit and rejects a bad value", async () => {
    const created = await request(app as any)
      .post("/api/import-lists")
      .set("X-Api-Key", apiKey)
      .send({
        name: "Route List",
        type: "trakt",
        url: "https://trakt.tv/users/t/lists/r",
        monitor: "none",
        searchOnAdd: true,
        minimumAvailability: "inCinemas",
        cleanLevel: "keepAndUnmonitor",
        monitorNewItems: "new",
        tagIds: [tagId],
      });
    expect(created.status).toBe(201);
    expect(created.body.monitor).toBe("none");
    expect(Number(created.body.search_on_add)).toBe(1);
    expect(created.body.minimum_availability).toBe("inCinemas");
    expect(created.body.clean_level).toBe("keepAndUnmonitor");
    expect(created.body.monitor_new_items).toBe("new");
    expect(JSON.parse(created.body.tag_ids)).toEqual([tagId]);

    const edited = await request(app as any).patch(`/api/import-lists/${created.body.id}`).set("X-Api-Key", apiKey).send({ cleanLevel: "disabled", tagIds: [] });
    expect(edited.status).toBe(200);
    expect(edited.body.clean_level).toBe("disabled");
    expect(edited.body.tag_ids).toBeNull();

    for (const bad of [{ monitor: "sometimes" }, { cleanLevel: "nuke" }, { minimumAvailability: "soon" }, { monitorNewItems: "maybe" }, { tagIds: [99999] }]) {
      const res = await request(app as any).patch(`/api/import-lists/${created.body.id}`).set("X-Api-Key", apiKey).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("the clean-up after the review", () => {
  const monitoredOf = async (id: number) => Number(((await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(id)) as any).monitored);
  async function movieOf(list: ImportListRow, tmdb: number, extra: Record<string, unknown> = {}): Promise<number> {
    const id = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status, source_list_id) VALUES ('movie', ?, ?, ?, 1, 'missing', ?)")
          .run(`Film ${tmdb}`, `film ${tmdb}`, JSON.stringify({ tmdb: String(tmdb) }), list.id)
      ).lastInsertRowid
    );
    for (const [column, value] of Object.entries(extra)) await db.prepare(`UPDATE media_items SET ${column} = ? WHERE id = ?`).run(value, id);
    return id;
  }
  async function listEntries(list: ImportListRow, keys: string[]) {
    for (const key of keys) await db.prepare("INSERT INTO import_list_entries (list_id, entry_key) VALUES (?, ?)").run(list.id, key);
  }

  it("an IMDb list does not clean up what it just added, in that sync or the next (H1)", async () => {
    const csv = ["Const,Title,Year,Title Type", "tt0000001,Alpha Film,2020,Movie", "tt0000002,Beta Film,2021,Movie"].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: async () => csv }));
    searchMetadata.mockImplementation(async (_type: string, query: string) => {
      const title = query.split(" ")[0] + " Film";
      const n = title.startsWith("Alpha") ? 9001 : 9002;
      return [{ title, year: title.startsWith("Alpha") ? 2020 : 2021, overview: null, posterUrl: null, releaseDate: null, externalIds: { tmdb: String(n) } }];
    });
    const list = await makeList({ type: "imdb", url: "https://www.imdb.com/list/ls123456789/", clean_level: "keepAndUnmonitor" });

    expect((await syncImportList(list)).added).toBe(2);
    const added = (await db.prepare("SELECT id, external_ids, monitored FROM media_items WHERE source_list_id = ?").all(list.id)) as any[];
    expect(added).toHaveLength(2);
    for (const item of added) {
      expect(Number(item.monitored)).toBe(1);
      expect(JSON.parse(item.external_ids).imdb).toMatch(/^tt000000[12]$/);
    }

    expect((await syncImportList(list)).added).toBe(0);
    for (const item of added) expect(await monitoredOf(item.id)).toBe(1);
  });

  it("an item is judged only by keys of a kind the sync produced (H1)", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    const id = await movieOf(list, 8501);
    await cleanListItems(list, new Set(["movie:imdb:tt0000009"]));
    expect(await monitoredOf(id)).toBe(1);
  });

  it("leaves a title another enabled list still holds (M4)", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    const other = await makeList({ name: "Watchlist" });
    await listEntries(other, ["movie:tmdb:8601"]);
    const heldByOther = await movieOf(list, 8601);
    const gone = await movieOf(list, 8602);
    await cleanListItems(list, new Set(["movie:tmdb:8699"]));
    expect(await monitoredOf(heldByOther)).toBe(1);
    expect(await monitoredOf(gone)).toBe(0);
  });

  it("waits while another enabled list has not recorded what it holds yet (M4)", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    await makeList({ name: "Never synced" });
    const id = await movieOf(list, 8611);
    const warnings: string[] = [];
    expect(await cleanListItems(list, new Set(["movie:tmdb:8699"]), (m) => warnings.push(m))).toBe(0);
    expect(await monitoredOf(id)).toBe(1);
    expect(warnings[0]).toMatch(/other enabled lists/);
  });

  it("refuses when the list came back with less than half of what it held, whatever its size (L9)", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    await listEntries(list, Array.from({ length: 8 }, (_, n) => `movie:tmdb:${8700 + n}`));
    const ids: number[] = [];
    for (let n = 0; n < 8; n++) ids.push(await movieOf(list, 8700 + n));
    const warnings: string[] = [];
    expect(await cleanListItems(list, new Set(["movie:tmdb:8700", "movie:tmdb:8701"]), (m) => warnings.push(m))).toBe(0);
    for (const id of ids) expect(await monitoredOf(id)).toBe(1);
    expect(warnings[0]).toMatch(/came back with 2 entries after 8/);
  });

  it("a sync records what the list holds, and shows a refusal as the list's warning", async () => {
    const list = await makeList({ clean_level: "keepAndUnmonitor" });
    await listEntries(list, Array.from({ length: 6 }, (_, n) => `movie:tmdb:${8800 + n}`));
    await movieOf(list, 8800);
    traktReturns([{ movie: { title: "Only One", year: 2024, ids: { tmdb: 8899, trakt: 1 } } }]);
    const result = await syncImportList(list);
    expect(result.warning).toMatch(/clean-up: it came back with 1 entries after 6/);
    const entries = (await db.prepare("SELECT entry_key FROM import_list_entries WHERE list_id = ?").all(list.id)) as any[];
    expect(entries.map((e) => e.entry_key)).toEqual(expect.arrayContaining(["movie:tmdb:8899"]));
    expect(entries).toHaveLength(1);
  });

  it("a ranking list (Last.fm) never removes a title that slips out of it (M5)", async () => {
    const list = await makeList({ type: "lastfm", url: "https://www.last.fm/user/x", clean_level: "removeAndDelete" });
    const artist = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status, source_list_id) VALUES ('artist', 'Slipper', 'slipper', '{}', 1, 'missing', ?)").run(list.id)).lastInsertRowid
    );
    const warnings: string[] = [];
    expect(await cleanListItems(list, new Set(["artist:name:someone else"]), (m) => warnings.push(m))).toBe(0);
    expect(await monitoredOf(artist)).toBe(1);
    expect(warnings[0]).toMatch(/ranking/);

    const refused = await request(app as any).post("/api/import-lists").set("X-Api-Key", apiKey).send({ name: "Rank", type: "lastfm", url: "https://www.last.fm/user/y", cleanLevel: "removeAndKeep" });
    expect(refused.status).toBe(400);
    const allowed = await request(app as any).post("/api/import-lists").set("X-Api-Key", apiKey).send({ name: "Rank2", type: "lastfm", url: "https://www.last.fm/user/z", cleanLevel: "keepAndUnmonitor" });
    expect(allowed.status).toBe(201);
  });
});
