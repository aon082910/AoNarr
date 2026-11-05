import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * The Starr list endpoints (Round 30g): a fixed number of queries however long the list is, the paged envelope when `page` or
 * `pageSize` is sent, an ETag that follows the body, and the kept resources never serving what has changed.
 */
let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let realDb: any;
let profileId: number;

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const put = (url: string, body: unknown) => request(app).put(url).set("X-Api-Key", apiKey).send(body as object);

async function insert(table: string, row: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(row);
  return Number((await db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]))).lastInsertRowid);
}

async function movie(title: string, over: Record<string, unknown> = {}): Promise<number> {
  return insert("media_items", { type: "movie", title, sort_title: title.toLowerCase(), year: 2000, monitored: 1, has_file: 0, status: "unknown", quality_profile_id: profileId, added_at: "2024-01-01 00:00:00", release_date: "2001-01-01", external_ids: JSON.stringify({ tmdb: String(100 + title.length * 7 + title.charCodeAt(0)) }), ...over });
}

/** How many statements the database ran while `work` did. */
async function queriesDuring(work: () => Promise<unknown>): Promise<number> {
  const original = realDb.prepare;
  let count = 0;
  realDb.prepare = (sql: string) => {
    count++;
    return original.call(realDb, sql);
  };
  try {
    await work();
  } finally {
    realDb.prepare = original;
  }
  return count;
}

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  realDb = await (await import("../src/db/index.js")).initDb();
});

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "sub_items", "media_item_tags", "media_items", "root_folders", "tags"]) await db.prepare(`DELETE FROM ${t}`).run();
  (await import("../src/starr/libraryList.js")).clearListCache();
  profileId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
  await insert("root_folders", { path: "/movies", media_type: "movie" });
});

describe("the number of queries of a list", () => {
  it("does not grow with the length of the list", async () => {
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    for (let i = 0; i < 5; i++) await movie(`Small ${i}`, { root_folder_id: rootId, has_file: 1, path: `/movies/Small ${i}/f.mkv`, quality: "Bluray-1080p" });
    const few = await queriesDuring(() => get("/radarr/api/v3/movie").expect(200));
    for (let i = 0; i < 80; i++) await movie(`Large ${i}`, { root_folder_id: rootId, has_file: 1, path: `/movies/Large ${i}/f.mkv`, quality: "WEBDL-720p" });
    const many = await queriesDuring(() => get("/radarr/api/v3/movie").expect(200));
    expect((await get("/radarr/api/v3/movie")).body).toHaveLength(85);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(5);
  });

  it("is the same few queries for a series list whose series have episodes, and for artists", async () => {
    const tv = await insert("root_folders", { path: "/tv", media_type: "series" });
    for (let i = 0; i < 3; i++) {
      const id = await insert("media_items", { type: "series", title: `Show ${i}`, sort_title: `show ${i}`, year: 2010, monitored: 1, has_file: 0, status: "Ended", root_folder_id: tv, quality_profile_id: profileId, external_ids: "{}" });
      for (let e = 1; e <= 3; e++) await insert("episodes", { media_item_id: id, season_number: 1, episode_number: e, air_date: "2011-01-0" + e, monitored: 1, has_file: e % 2 });
    }
    const few = await queriesDuring(() => get("/sonarr/api/v3/series").expect(200));
    for (let i = 3; i < 40; i++) {
      const id = await insert("media_items", { type: "series", title: `Show ${i}`, sort_title: `show ${i}`, year: 2010, monitored: 1, has_file: 0, status: "Ended", root_folder_id: tv, quality_profile_id: profileId, external_ids: "{}" });
      await insert("episodes", { media_item_id: id, season_number: 1, episode_number: 1, air_date: "2011-01-01", monitored: 1, has_file: 0 });
    }
    expect(await queriesDuring(() => get("/sonarr/api/v3/series").expect(200))).toBe(few);
    expect(few).toBeLessThanOrEqual(6);
  });
});

describe("paging a list", () => {
  beforeEach(async () => {
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    // Seven movies whose title order, year order and size order all differ.
    const rows: [string, number | null, number | null][] = [
      ["Delta", 1990, 500],
      ["Alpha", 2005, null],
      ["Echo", 1980, 300],
      ["Bravo", 2010, 100],
      ["Charlie", null, 200],
      ["Foxtrot", 2001, 700],
      ["Golf", 1999, null],
    ];
    for (const [title, year, size] of rows) await movie(title, { root_folder_id: rootId, year, size_bytes: size, has_file: size ? 1 : 0, path: size ? `/movies/${title}/f.mkv` : null });
  });

  it("answers the plain array without page, pageSize, and an array even when only a sort is asked for", async () => {
    const plain = await get("/radarr/api/v3/movie");
    expect(Array.isArray(plain.body)).toBe(true);
    expect(plain.body.map((m: any) => m.title)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"]);
    const sorted = await get("/radarr/api/v3/movie?sortKey=year&sortDirection=descending");
    expect(Array.isArray(sorted.body)).toBe(true);
    expect(sorted.body.map((m: any) => m.title)).toEqual(plain.body.map((m: any) => m.title));
  });

  it("answers the same envelope as the wanted pages, with the same resources", async () => {
    const plain = (await get("/radarr/api/v3/movie")).body as any[];
    const res = await get("/radarr/api/v3/movie?page=2&pageSize=3");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, pageSize: 3, sortKey: "sortTitle", sortDirection: "ascending", totalRecords: 7 });
    expect(res.body.records).toEqual(plain.slice(3, 6));
    // The last page is short, and a page past the end is empty with the count still right.
    expect((await get("/radarr/api/v3/movie?page=3&pageSize=3")).body.records).toEqual(plain.slice(6));
    expect((await get("/radarr/api/v3/movie?page=9&pageSize=3")).body).toMatchObject({ totalRecords: 7, records: [] });
    // pageSize alone pages from the first page; a page number alone takes the default size of ten.
    expect((await get("/radarr/api/v3/movie?pageSize=2")).body).toMatchObject({ page: 1, pageSize: 2, totalRecords: 7 });
    expect((await get("/radarr/api/v3/movie?page=1")).body).toMatchObject({ page: 1, pageSize: 10, totalRecords: 7 });
  });

  it("answers 200 for a page number the database cannot count to, and for text", async () => {
    const first = (await get("/radarr/api/v3/movie?page=1&pageSize=3")).body;
    // Not a number at all: the first page, as when no page is sent. (1e300 and Infinity raised "datatype mismatch" before.)
    for (const page of ["Infinity", "-Infinity", "NaN", "-5", "0", "abc", "", "1e300x"]) {
      const res = await get(`/radarr/api/v3/movie?page=${page}&pageSize=3`);
      expect(res.status, `page=${page}`).toBe(200);
      expect(res.body, `page=${page}`).toEqual(first);
    }
    // A number that is too large is clamped to the last page a request may name: empty, with the count still right.
    for (const page of ["1e300", "1e21", "5000000000", "1000001"]) {
      const res = await get(`/radarr/api/v3/movie?page=${page}&pageSize=1000`);
      expect(res.status, `page=${page}`).toBe(200);
      expect(res.body, `page=${page}`).toMatchObject({ page: 1_000_000, pageSize: 1000, totalRecords: 7, records: [] });
    }
    // The same helper pages the older routes.
    for (const route of ["wanted/missing", "wanted/cutoff", "queue", "history"]) expect((await get(`/radarr/api/v3/${route}?page=1e300&pageSize=2`)).status, route).toBe(200);
  });

  it("sorts by a key a Starr client sends, in either direction, with a missing value last", async () => {
    const titles = async (query: string) => ((await get(`/radarr/api/v3/movie?page=1&pageSize=20&${query}`)).body.records as any[]).map((m) => m.title);
    expect(await titles("sortKey=title&sortDirection=descending")).toEqual(["Golf", "Foxtrot", "Echo", "Delta", "Charlie", "Bravo", "Alpha"]);
    expect(await titles("sortKey=year&sortDirection=ascending")).toEqual(["Echo", "Delta", "Golf", "Foxtrot", "Alpha", "Bravo", "Charlie"]);
    expect(await titles("sortKey=year&sortDirection=descending")).toEqual(["Bravo", "Alpha", "Foxtrot", "Golf", "Delta", "Echo", "Charlie"]);
    expect(await titles("sortKey=sizeOnDisk&sortDirection=ascending")).toEqual(["Bravo", "Charlie", "Echo", "Delta", "Foxtrot", "Alpha", "Golf"]);
    const unknown = await get("/radarr/api/v3/movie?page=1&pageSize=20&sortKey=nonsense");
    expect(unknown.body.sortKey).toBe("sortTitle");
    expect(unknown.body.records.map((m: any) => m.title)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"]);
  });

  it("pages a filtered list too", async () => {
    const all = (await get("/radarr/api/v3/movie")).body as any[];
    const one = all[2];
    const res = await get(`/radarr/api/v3/movie?tmdbId=${one.tmdbId}&page=1&pageSize=5`);
    expect(res.body.totalRecords).toBe(1);
    expect(res.body.records.map((m: any) => m.id)).toEqual([one.id]);
    const plain = await get(`/radarr/api/v3/movie?tmdbId=${one.tmdbId}`);
    expect(plain.body.map((m: any) => m.id)).toEqual([one.id]);
    expect((await get("/radarr/api/v3/movie?tmdbId=99999999")).body).toEqual([]);
  });

  it("pages series with the statistics of the page's own series", async () => {
    const tv = await insert("root_folders", { path: "/tv", media_type: "series" });
    for (const name of ["Aaa", "Bbb", "Ccc"]) {
      const id = await insert("media_items", { type: "series", title: name, sort_title: name.toLowerCase(), year: 2010, monitored: 1, has_file: 0, status: "Ended", root_folder_id: tv, quality_profile_id: profileId, external_ids: "{}" });
      for (let e = 1; e <= name.length; e++) await insert("episodes", { media_item_id: id, season_number: 1, episode_number: e, air_date: "2011-01-01", monitored: 1, has_file: name === "Bbb" ? 1 : 0, size_bytes: 10 });
    }
    const plain = (await get("/sonarr/api/v3/series")).body as any[];
    const res = await get("/sonarr/api/v3/series?page=2&pageSize=1&sortKey=title");
    expect(res.body).toMatchObject({ page: 2, pageSize: 1, totalRecords: 3 });
    expect(res.body.records).toEqual([plain[1]]);
    expect(res.body.records[0].statistics.episodeFileCount).toBe(3);
  });

  it("pages artists, authors, albums and books", async () => {
    const music = await insert("root_folders", { path: "/music", media_type: "artist" });
    const books = await insert("root_folders", { path: "/books", media_type: "author" });
    const artists: number[] = [];
    for (const name of ["Zed", "Abe", "Mia"]) {
      artists.push(await insert("media_items", { type: "artist", title: name, sort_title: name.toLowerCase(), monitored: 1, has_file: 0, status: "unknown", root_folder_id: music, quality_profile_id: profileId, external_ids: "{}" }));
    }
    const authors: number[] = [];
    for (const name of ["Yan", "Bo"]) authors.push(await insert("media_items", { type: "author", title: name, sort_title: name.toLowerCase(), monitored: 1, has_file: 0, status: "unknown", root_folder_id: books, quality_profile_id: profileId, external_ids: "{}" }));
    for (const [i, date] of ["2003-01-01", "1999-01-01", "2011-01-01", "2007-01-01"].entries()) {
      await insert("sub_items", { media_item_id: artists[0], title: `Album ${i}`, release_date: date, monitored: 1, has_file: 0 });
      await insert("sub_items", { media_item_id: authors[0], title: `Book ${i}`, release_date: date, monitored: 1, has_file: 0 });
    }

    const artistPage = (await get("/lidarr/api/v1/artist?page=1&pageSize=2")).body;
    expect(artistPage).toMatchObject({ page: 1, pageSize: 2, totalRecords: 3 });
    expect(artistPage.records.map((a: any) => a.artistName)).toEqual(["Abe", "Mia"]);
    expect((await get("/readarr/api/v1/author?page=1&pageSize=1&sortKey=authorName&sortDirection=descending")).body.records.map((a: any) => a.authorName)).toEqual(["Yan"]);

    const albums = (await get("/lidarr/api/v1/album")).body as any[];
    expect(albums.map((a) => a.title)).toEqual(["Album 1", "Album 0", "Album 3", "Album 2"]); // by release date, as before
    const albumPage = (await get("/lidarr/api/v1/album?page=2&pageSize=3")).body;
    expect(albumPage).toMatchObject({ page: 2, pageSize: 3, sortKey: "releaseDate", totalRecords: 4 });
    expect(albumPage.records).toEqual(albums.slice(3));
    expect((await get("/lidarr/api/v1/album?page=1&pageSize=4&sortKey=title&sortDirection=descending")).body.records.map((a: any) => a.title)).toEqual(["Album 3", "Album 2", "Album 1", "Album 0"]);
    const bookPage = (await get(`/readarr/api/v1/book?authorId=${authors[0]}&page=1&pageSize=2`)).body;
    expect(bookPage.totalRecords).toBe(4);
    expect(bookPage.records.map((b: any) => b.title)).toEqual(["Book 1", "Book 0"]);
    // The list that embeds the artist pages the same way.
    const embedded = (await get("/lidarr/api/v1/album?includeArtist=true&page=1&pageSize=2")).body;
    expect(embedded.totalRecords).toBe(4);
    expect(embedded.records[0].artist.artistName).toBe("Zed");
  });
});

describe("the cap of the kept resources", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    (await import("../src/starr/libraryList.js")).clearListCache();
  });

  const capWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => String(c[0]).includes("kept list resources")).length;

  it("keeps an exact count when an entry is replaced while the cache is over the cap", async () => {
    const lib = await import("../src/starr/libraryList.js");
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    const id = await movie("Replaced", { root_folder_id: rootId });
    lib.clearListCache(1); // every entry is over the cap, so the next build starts the cache over
    await get("/radarr/api/v3/movie").expect(200);
    expect(lib.listCacheStats().cachedSize).toBeGreaterThan(1);
    await db.prepare("UPDATE media_items SET title = 'Replaced again' WHERE id = ?").run(id);
    await get("/radarr/api/v3/movie").expect(200);
    const stats = lib.listCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.cachedSize).toBeGreaterThan(0); // it went negative by one entry per overflow
    expect(stats.cachedSize).toBe(stats.recounted);
  });

  it("stays between zero and the cap plus one entry through many overflows, and says so once in ten minutes", async () => {
    const lib = await import("../src/starr/libraryList.js");
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn");
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push(await movie(`Capped ${i}`, { root_folder_id: rootId, overview: "o".repeat(300) }));
    const CAP = 8 * 1024;
    lib.clearListCache(CAP);
    let biggest = 0;
    for (let round = 0; round < 6; round++) {
      // Edit a few rows so that replaced entries meet the overflow too.
      for (const id of ids.filter((_, i) => (i + round) % 5 === 0)) await db.prepare("UPDATE media_items SET overview = ? WHERE id = ?").run(`edited ${round} ${id}`, id);
      const res = await get("/radarr/api/v3/movie").expect(200);
      expect(res.body).toHaveLength(24);
      const stats = lib.listCacheStats();
      biggest = Math.max(biggest, Math.round(stats.recounted / Math.max(1, stats.entries)));
      expect(stats.cachedSize).toBeGreaterThanOrEqual(0);
      expect(stats.cachedSize).toBe(stats.recounted);
      expect(stats.cachedSize).toBeLessThanOrEqual(CAP + 4 * biggest);
    }
    expect(capWarnings(warn)).toBe(1);
    skew = 11 * 60 * 1000;
    await db.prepare("UPDATE media_items SET overview = 'again'").run();
    await get("/radarr/api/v3/movie").expect(200);
    expect(capWarnings(warn)).toBe(2);
  });

  it("counts a fingerprint at two bytes a character, because one character outside Latin-1 makes it so", async () => {
    const lib = await import("../src/starr/libraryList.js");
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    await movie("漢字", { root_folder_id: rootId, overview: "x".repeat(1000) });
    const res = await get("/radarr/api/v3/movie").expect(200);
    const jsonBytes = Buffer.byteLength(JSON.stringify(res.body[0]), "utf8");
    // The overview alone is 1000 characters of the fingerprint.
    expect(lib.listCacheStats().cachedSize - jsonBytes).toBeGreaterThanOrEqual(2000);
  });
});

describe("the ETag of a list", () => {
  beforeEach(async () => {
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    for (let i = 0; i < 4; i++) await movie(`Tagged ${i}`, { root_folder_id: rootId });
  });

  it("answers 304 with no body to a client that holds the current list", async () => {
    const first = await get("/radarr/api/v3/movie");
    const tag = first.headers.etag;
    expect(tag).toMatch(/^W\/"/);
    const again = await get("/radarr/api/v3/movie").set("If-None-Match", tag);
    expect(again.status).toBe(304);
    expect(again.text ?? "").toBe("");
    // The tag is for this list: another list, or a page, has its own.
    expect((await get("/radarr/api/v3/movie?page=1&pageSize=2")).headers.etag).not.toBe(tag);
    expect((await get("/radarr/api/v3/movie?page=1&pageSize=2").set("If-None-Match", tag)).status).toBe(200);
    // A tag of anything else is no match.
    expect((await get("/radarr/api/v3/movie").set("If-None-Match", 'W/"nothing"')).status).toBe(200);
  });

  it("changes when anything listed changes: a title, a file, a tag, a root folder, a statistic", async () => {
    const tagOf = async (url = "/radarr/api/v3/movie") => (await get(url)).headers.etag as string;
    let tag = await tagOf();
    expect(await tagOf()).toBe(tag);

    const first = ((await get("/radarr/api/v3/movie")).body as any[])[0];
    await db.prepare("UPDATE media_items SET title = 'Renamed' WHERE id = ?").run(first.id);
    let next = await tagOf();
    expect(next).not.toBe(tag);
    expect(((await get("/radarr/api/v3/movie")).body as any[]).some((m) => m.title === "Renamed")).toBe(true);
    tag = next;

    await db.prepare("UPDATE media_items SET has_file = 1, path = '/movies/x/x.mkv', size_bytes = 5, quality = 'Bluray-1080p' WHERE id = ?").run(first.id);
    next = await tagOf();
    expect(next).not.toBe(tag);
    const withFile = ((await get("/radarr/api/v3/movie")).body as any[]).find((m) => m.id === first.id);
    expect(withFile).toMatchObject({ hasFile: true, sizeOnDisk: 5 });
    tag = next;

    const label = await insert("tags", { name: "kept" });
    await insert("media_item_tags", { media_item_id: first.id, tag_id: label });
    next = await tagOf();
    expect(next).not.toBe(tag);
    expect(((await get("/radarr/api/v3/movie")).body as any[]).find((m) => m.id === first.id).tags).toEqual([label]);
    tag = next;

    await db.prepare("UPDATE root_folders SET path = '/films'").run();
    next = await tagOf();
    expect(next).not.toBe(tag);
    expect(((await get("/radarr/api/v3/movie")).body as any[])[0].rootFolderPath).toBe("/films");
    tag = next;

    await db.prepare("DELETE FROM media_items WHERE id = ?").run(first.id);
    next = await tagOf();
    expect(next).not.toBe(tag);
    expect(((await get("/radarr/api/v3/movie")).body as any[]).some((m) => m.id === first.id)).toBe(false);
  });

  it("follows the statistics of a series, which are not in its own row", async () => {
    const tv = await insert("root_folders", { path: "/tv", media_type: "series" });
    const id = await insert("media_items", { type: "series", title: "Counted", sort_title: "counted", year: 2010, monitored: 1, has_file: 0, status: "Ended", root_folder_id: tv, quality_profile_id: profileId, external_ids: "{}" });
    const episode = await insert("episodes", { media_item_id: id, season_number: 1, episode_number: 1, air_date: "2011-01-01", monitored: 1, has_file: 0 });
    const before = await get("/sonarr/api/v3/series");
    expect(before.body[0].statistics.episodeFileCount).toBe(0);
    await db.prepare("UPDATE episodes SET has_file = 1, size_bytes = 99 WHERE id = ?").run(episode);
    const after = await get("/sonarr/api/v3/series");
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.body[0].statistics).toMatchObject({ episodeFileCount: 1, sizeOnDisk: 99 });
    // And a change through the Starr API itself shows at once.
    const edited = await put(`/sonarr/api/v3/series/${id}`, { id, monitored: false });
    expect(edited.status).toBe(200);
    expect((await get("/sonarr/api/v3/series")).body[0].monitored).toBe(false);
  });
});

describe("what the resource builders may read from a title's row", () => {
  it("is only what the list selects", async () => {
    const { TITLE_COLUMNS } = await import("../src/starr/libraryList.js");
    const lib = await import("../src/starr/libraryResources.js");
    const { STARR_APPS } = await import("../src/starr/apps.js");
    const rootId = Number(((await db.prepare("SELECT id FROM root_folders").get()) as { id: number }).id);
    const ids = {
      radarr: await movie("Probe", { root_folder_id: rootId, has_file: 1, path: "/movies/p/p.mkv", quality: "Bluray-1080p", size_bytes: 3, media_info: "{}" }),
      sonarr: await insert("media_items", { type: "series", title: "Probe", sort_title: "probe", monitored: 1, has_file: 0, status: "Ended", external_ids: "{}" }),
      lidarr: await insert("media_items", { type: "artist", title: "Probe", sort_title: "probe", monitored: 1, has_file: 0, status: "unknown", external_ids: "{}" }),
      readarr: await insert("media_items", { type: "author", title: "Probe", sort_title: "probe", monitored: 1, has_file: 0, status: "unknown", external_ids: "{}" }),
    };
    const allowed = new Set<string>([...TITLE_COLUMNS, "root_folder_path"]);
    for (const key of ["radarr", "sonarr", "lidarr", "readarr"] as const) {
      const app = STARR_APPS[key];
      const ctx = await lib.loadContext(app);
      const [row] = await lib.titleRows(app, [ids[key]]); // every column
      const read = new Set<string>();
      const watched = new Proxy(row, {
        get(target, prop, receiver) {
          if (typeof prop === "string") read.add(prop);
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          if (typeof prop === "string") read.add(prop);
          return Reflect.has(target, prop);
        },
      });
      if (key === "radarr") lib.movieResource(ctx, watched);
      else if (key === "sonarr") lib.seriesResource(ctx, watched, []);
      else if (key === "lidarr") lib.artistResource(ctx, watched, undefined);
      else lib.authorResource(ctx, watched, undefined);
      const unlisted = [...read].filter((column) => !allowed.has(column));
      expect(unlisted, `${key}: columns a resource reads that the list does not select (add them to TITLE_COLUMNS in starr/libraryList.ts)`).toEqual([]);
    }
  });
});
