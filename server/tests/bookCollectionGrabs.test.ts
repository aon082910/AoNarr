import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/indexerClient.js")>()),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
}));

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let scheduler: typeof import("../src/services/scheduler.js");
let backoff: typeof import("../src/services/searchBackoff.js");
let settings: typeof import("../src/services/settingsStore.js");
let collections: typeof import("../src/services/bookCollections.js");
let addDownload: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  backoff = await import("../src/services/searchBackoff.js");
  settings = await import("../src/services/settingsStore.js");
  collections = await import("../src/services/bookCollections.js");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "season_searches", "tracks", "sub_items", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  settings.setSetting("collectionGrabs", "");
  settings.setSetting("discographyGrabs", "");
  settings.setSetting("quietHoursEnabled", "0");
  settings.setSetting("searchWindowEnabled", "0");
  searchAllIndexers.mockReset().mockResolvedValue([]);
  addDownload = vi.fn(async (_client: unknown, url: string) => ({ downloadId: url }));
  getDownloadClientAdapter.mockReset().mockReturnValue({ addDownload, getStatus: vi.fn(async () => []), removeDownload: vi.fn(async () => undefined) });
});

function release(title: string, overrides: Record<string, unknown> = {}) {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title,
    size: 300_000_000,
    seeders: 10,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: `magnet:?xt=urn:btih:${encodeURIComponent(title)}`,
    protocol: "torrent",
    category: null,
    ...overrides,
  };
}

async function insertAuthor(title = "Terry Pratchett"): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', ?, ?, 1, 0, 'missing')").run(title, title.toLowerCase()))
      .lastInsertRowid
  );
}

async function insertBook(
  authorId: number,
  title: string,
  releaseDate: string | null,
  extra: { monitored?: number; hasFile?: number; seriesName?: string; seriesPosition?: number } = {}
): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file, series_name, series_position) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(authorId, title, releaseDate, extra.monitored ?? 1, extra.hasFile ?? 0, extra.seriesName ?? null, extra.seriesPosition ?? null)
    ).lastInsertRowid
  );
}

/** Terry Pratchett, with five Discworld books out and missing. */
async function terry(): Promise<{ authorId: number; books: number[] }> {
  const authorId = await insertAuthor("Terry Pratchett");
  const titles: [string, string][] = [
    ["The Colour of Magic", "1983-11-24"],
    ["The Light Fantastic", "1986-06-01"],
    ["Equal Rites", "1987-10-01"],
    ["Mort", "1987-11-12"],
    ["Sourcery", "1988-05-05"],
  ];
  const books: number[] = [];
  for (const [i, [title, date]] of titles.entries()) books.push(await insertBook(authorId, title, date, { seriesName: "Discworld", seriesPosition: i + 1 }));
  return { authorId, books };
}

async function insertClient(): Promise<void> {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run();
}

async function insertIndexer(): Promise<void> {
  await db.prepare("INSERT INTO indexers (name, protocol, url, enabled) VALUES ('Tracker', 'torznab', 'http://x', 1)").run();
}

/** What a search answers: by the words of its query. */
function answers(byQuery: (query: string) => ReturnType<typeof release>[]): void {
  searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) => byQuery(query));
}

const isCollectionQuery = (query: string) => /complete collection|complete works|bibliography/i.test(query);
const queriesAsked = () => searchAllIndexers.mock.calls.map((call) => String(call[1]));

async function queueRows(): Promise<any[]> {
  return (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
}

async function targetsOf(queueId: number): Promise<number[]> {
  return ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ? ORDER BY sub_item_id").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));
}

async function mediaItem(id: number) {
  const { mediaItemFromRow } = await import("../src/db/mappers.js");
  return mediaItemFromRow(await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
}

const COLLECTION = "Terry Pratchett - Complete Collection (Books 1-5) [EPUB]";

async function grabCollection(authorId: number, targets: number[], title = COLLECTION) {
  const item = await mediaItem(authorId);
  const client = (await db.prepare("SELECT * FROM download_clients LIMIT 1").get()) as any;
  const { downloadClientFromRow } = await import("../src/db/mappers.js");
  return scheduler.grab(downloadClientFromRow(client) as any, item, null, null, { result: release(title) as any, quality: "Unknown" }, 0, null, "auto", { targetSubItemIds: targets });
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("grab() for a collection", () => {
  it("queues one download for the books, with no book of its own, and records a grab for each", async () => {
    await insertClient();
    const { authorId, books } = await terry();

    expect(await grabCollection(authorId, books)).toBe(true);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sub_item_id).toBeNull();
    expect(rows[0].episode_id).toBeNull();
    expect(await targetsOf(rows[0].id)).toEqual(sorted(books));
    expect(addDownload).toHaveBeenCalledTimes(1);
    const grabbed = (await db.prepare("SELECT sub_item_id FROM history WHERE event_type = 'grabbed' ORDER BY sub_item_id").all()) as any[];
    expect(grabbed.map((h) => Number(h.sub_item_id))).toEqual(sorted(books));
  });

  it("counts every book it is for as queued, and no other", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    const other = await insertBook(authorId, "Pyramids", "1989-01-01");
    await grabCollection(authorId, books);

    for (const id of books) expect(await scheduler.isAlreadyQueued(authorId, null, id)).toBe(true);
    expect(await scheduler.isAlreadyQueued(authorId, null, other)).toBe(false);
    await db.prepare("UPDATE queue SET status = 'failed'").run();
    for (const id of books) expect(await scheduler.isAlreadyQueued(authorId, null, id)).toBe(false);
  });

  it("leaves out a book that got a download of its own while the release was being chosen", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Terry Pratchett - The Colour of Magic', 'downloading')").run(authorId, books[0]);

    expect(await grabCollection(authorId, books)).toBe(true);

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual(sorted(books.slice(1)));
  });

  it("writes nothing of the row when its books cannot be written", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await expect(grabCollection(authorId, [...books, 99999999])).rejects.toThrow();
    expect(await queueRows()).toHaveLength(0);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM history").get()) as any).c)).toBe(0);
  });
});

describe("searching for a collection", () => {
  it("asks for the collection first and files it against every missing book, without searching them one by one", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    answers((query) => (isCollectionQuery(query) ? [release(COLLECTION)] : []));

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(queriesAsked()).toEqual(["Terry Pratchett complete collection"]);
    expect(result).toMatchObject({ grabbed: true, childrenSearched: 1, childrenGrabbed: 1 });
    const [row] = await queueRows();
    expect(row.title).toBe(COLLECTION);
    expect(row.sub_item_id).toBeNull();
    expect(await targetsOf(row.id)).toEqual(sorted(books));
  });

  it("searches the books one by one when there is no collection", async () => {
    await insertClient();
    const { authorId } = await terry();

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(queriesAsked().filter(isCollectionQuery)).toEqual(["Terry Pratchett complete collection"]);
    expect(searchAllIndexers).toHaveBeenCalledTimes(6);
    expect(result.grabbed).toBe(false);
  });

  it("looks for the books the collection leaves out, one by one", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await insertBook(authorId, "Pyramids", "1989-06-01");
    await insertBook(authorId, "Eric", "1990-10-01");
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Bibliography (1983-1988) [EPUB]")] : /pyramids/i.test(query) ? [release("Terry Pratchett - Pyramids (1989) [EPUB]")] : []));

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    // Pyramids and Eric (1989, 1990) are outside 1983-1988; Pyramids was found on its own.
    expect(result.childrenGrabbed).toBe(2);
    const rows = await queueRows();
    expect(rows).toHaveLength(2);
    const collection = rows.find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(collection.id)).toEqual(sorted(books));
  });

  it("does not look for one when fewer than three books are missing", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    await insertBook(authorId, "Mort", "1987-11-12");
    await insertBook(authorId, "Sourcery", "1988-05-05");
    await insertBook(authorId, "Eric", "1990-10-01", { hasFile: 1 });
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Collection [EPUB]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("does nothing about collections when the setting is off", async () => {
    await insertClient();
    const { authorId } = await terry();
    settings.setSetting("collectionGrabs", "0");
    answers((query) => (isCollectionQuery(query) ? [release(COLLECTION)] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("never takes a collection in a book's own search", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    searchAllIndexers.mockResolvedValue([
      release("Terry Pratchett - Complete Collection (Books 1-5) [EPUB]"),
      release("Terry Pratchett - The Light Fantastic - Complete Collection [EPUB]"),
      release("Terry Pratchett - Bibliography [EPUB]"),
      release("Terry Pratchett - Collected Works [EPUB]"),
    ]);

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: authorId, subItemId: books[1] }]);

    expect(result.grabbed).toBe(false);
    expect(await queueRows()).toHaveLength(0);
  });

  it("does not take another author's collection", async () => {
    await insertClient();
    const { authorId } = await terry();
    answers((query) => (isCollectionQuery(query) ? [release("Neil Gaiman - Complete Collection [EPUB]"), release("Terry Pratchett Jr - Complete Collection [EPUB]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(await queueRows()).toHaveLength(0);
  });

  it("does not take an audiobook collection for an ebook library", async () => {
    await insertClient();
    const { authorId } = await terry();
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Audiobook Collection [M4B]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(await queueRows()).toHaveLength(0);
  });

  it("does not take one that would include a book that is not out yet, and takes one whose years stop before it", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await insertBook(authorId, "The Next Book", "2999-01-01");
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Collection [EPUB]")] : []));
    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);
    expect(await queueRows()).toHaveLength(0);

    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Bibliography (1983-2015) [EPUB]")] : []));
    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);
    const [row] = await queueRows();
    expect(await targetsOf(row.id)).toEqual(sorted(books));
  });

  it("is for the books that are missing and monitored, not those with files or not monitored", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    const wanted = [await insertBook(authorId, "Mort", "1987-11-12"), await insertBook(authorId, "Sourcery", "1988-05-05"), await insertBook(authorId, "Eric", "1990-10-01")];
    await insertBook(authorId, "Pyramids", "1989-06-01", { hasFile: 1 });
    await insertBook(authorId, "Moving Pictures", "1990-06-01", { monitored: 0 });
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Collection [EPUB]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    const [row] = await queueRows();
    expect(await targetsOf(row.id)).toEqual(sorted(wanted));
  });

  it("takes the better format first, then the better-seeded, and only then the one that adds more books", async () => {
    await insertClient();
    const { authorId } = await terry();
    // The format: an epub that adds fewer books beats a pdf that adds more.
    answers((query) =>
      isCollectionQuery(query)
        ? [release("Terry Pratchett - Bibliography (1983-1988) [PDF]", { seeders: 10 }), release("Terry Pratchett - Bibliography (1983-1987) [EPUB]", { seeders: 10 })]
        : []
    );
    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);
    expect((await queueRows())[0].title).toBe("Terry Pratchett - Bibliography (1983-1987) [EPUB]");

    // The peers: the better-seeded wins over the one that covers more.
    await db.prepare("DELETE FROM queue").run();
    await db.prepare("DELETE FROM season_searches").run();
    answers((query) =>
      isCollectionQuery(query)
        ? [release("Terry Pratchett - Bibliography (1983-1988) [EPUB]", { seeders: 1 }), release("Terry Pratchett - Bibliography (1983-1987) [EPUB]", { seeders: 500 })]
        : []
    );
    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);
    expect((await queueRows())[0].title).toBe("Terry Pratchett - Bibliography (1983-1987) [EPUB]");

    // The books added: with everything else alike, the one that fills more.
    await db.prepare("DELETE FROM queue").run();
    await db.prepare("DELETE FROM season_searches").run();
    answers((query) =>
      isCollectionQuery(query)
        ? [release("Terry Pratchett - Bibliography (1983-1987) [EPUB]", { seeders: 10 }), release("Terry Pratchett - Bibliography (1983-1988) [EPUB]", { seeders: 10 })]
        : []
    );
    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);
    expect((await queueRows())[0].title).toBe("Terry Pratchett - Bibliography (1983-1988) [EPUB]");
  });

  it("does not take a collection of a whole library for three missing books, and leaves them to their own searches", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    await insertBook(authorId, "Missing One", "1983-11-24");
    await insertBook(authorId, "Missing Two", "1986-06-01");
    await insertBook(authorId, "Missing Three", "1987-10-01");
    for (let i = 0; i < 9; i++) await insertBook(authorId, `Owned ${i}`, `${1988 + i}-01-01`, { hasFile: 1 });
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Collection [EPUB]")] : []));

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    // Three of twelve is a quarter: a discography would do, a collection wants 30%.
    expect(result.grabbed).toBe(false);
    expect(await queueRows()).toHaveLength(0);
    expect(queriesAsked().filter((q) => /missing/i.test(q))).toHaveLength(3);
  });

  it("does not take a blocklisted collection, nor one that already filled books of the author", async () => {
    await insertClient();
    const { authorId } = await terry();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(authorId, COLLECTION);
    answers((query) => (isCollectionQuery(query) ? [release(COLLECTION), release("Terry Pratchett - Complete Collection (Books 1-4) [EPUB]")] : []));
    await insertBook(authorId, "Imported Before", "1980-01-01", { hasFile: 1 });
    await db.prepare("UPDATE sub_items SET file_release_title = ? WHERE title = 'Imported Before'").run("Terry Pratchett - Complete Collection (Books 1-4) [EPUB]");

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    expect(await queueRows()).toHaveLength(0);
  });

  it("covers a book that is already downloading without counting it as wanted", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    const more = [await insertBook(authorId, "Pyramids", "1989-06-01"), await insertBook(authorId, "Eric", "1990-10-01")];
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Terry Pratchett - Pyramids', 'downloading')").run(authorId, more[0]);
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Terry Pratchett - Eric', 'downloading')").run(authorId, more[1]);
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Complete Collection [EPUB]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual(sorted(books));
  });

  it("takes a series collection by the numbers of its books", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await insertBook(authorId, "Pyramids", "1989-06-01", { seriesName: "Discworld", seriesPosition: 7 });
    answers((query) => (isCollectionQuery(query) ? [release("Terry Pratchett - Discworld Books 1-5 [EPUB]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: authorId }]);

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual(sorted(books));
  });
});

describe("the collection search plan", () => {
  it("asks for the complete collection, with the other words releases use as alternates", async () => {
    const { collectionPlanFor } = await import("../src/services/searchPlan.js");
    const plan = await collectionPlanFor(await mediaItem(await insertAuthor("Terry Pratchett")));
    expect(plan.query).toBe("Terry Pratchett complete collection");
    expect(plan.alternateQueries).toEqual(["Terry Pratchett collection", "Terry Pratchett complete works", "Terry Pratchett bibliography"]);
    expect(plan.hints).toEqual({});
  });

  it("writes an author's initials the way a scene does, and tries the other spelling", async () => {
    const { collectionPlanFor } = await import("../src/services/searchPlan.js");
    const plan = await collectionPlanFor(await mediaItem(await insertAuthor("J.K. Rowling")));
    expect(plan.query).toBe("JK Rowling complete collection");
    expect(plan.alternateQueries).toContain("JK Rowling collection");
    expect(plan.alternateQueries).toContain("J K Rowling complete collection");
  });
});

describe("what is left to the books' own searches", () => {
  it("does not look for a collection of audiobooks: those are searched one by one", async () => {
    await insertClient();
    const audiobookId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('audiobook', 'Terry Pratchett', 'terry pratchett', 1, 0, 'missing')").run()).lastInsertRowid
    );
    for (const [i, title] of ["Mort", "Sourcery", "Eric", "Pyramids"].entries()) await insertBook(audiobookId, title, `${1987 + i}-01-01`);

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
  });
});

describe("merging two copies of an author while a collection downloads", () => {
  it("moves the books it is for to the keeper's books, and keeps the row", async () => {
    await insertClient();
    const keeper = await insertAuthor("Terry Pratchett");
    const keeperColour = await insertBook(keeper, "The Colour of Magic", "1983-11-24");
    const keeperMort = await insertBook(keeper, "Mort", "1987-11-12");
    const { authorId: loser, books } = await terry();
    await grabCollection(loser, books.slice(0, 4));

    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    await mergeMediaItems(keeper, [loser], false);

    const [row] = await queueRows();
    expect(row.media_item_id).toBe(keeper);
    const targets = await targetsOf(row.id);
    expect(targets).toContain(keeperColour);
    expect(targets).toContain(keeperMort);
    expect(targets).toHaveLength(4);
    const owners = (await db.prepare(`SELECT DISTINCT media_item_id FROM sub_items WHERE id IN (${targets.map(() => "?").join(",")})`).all(...targets)) as any[];
    expect(owners.map((o) => Number(o.media_item_id))).toEqual([keeper]);
  });
});

describe("the automatic search", () => {
  it("looks for the collection before the books, and then skips the books it covers", async () => {
    await insertClient();
    const { authorId } = await terry();
    answers((query) => (isCollectionQuery(query) ? [release(COLLECTION)] : []));

    await scheduler.runAutoSearch();

    expect(queriesAsked()).toEqual(["Terry Pratchett complete collection"]);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].media_item_id).toBe(authorId);
  });

  it("keeps to a wait of its own after it finds nothing, and starts over when the backoff does", async () => {
    await insertClient();
    await insertIndexer();
    const { authorId } = await terry();
    const key = collections.COLLECTION_SEARCH_KEY;
    expect(key).toBe(-2);
    const missesOf = async () => Number(((await db.prepare("SELECT misses FROM season_searches WHERE media_item_id = ? AND season_number = ?").get(authorId, key)) as any)?.misses ?? 0);

    await scheduler.runAutoSearch();
    expect(await missesOf()).toBe(1);
    expect(await backoff.seasonSearchDue(authorId, key)).toBe(true);

    await scheduler.runAutoSearch();
    expect(await missesOf()).toBe(2);
    expect(await backoff.seasonSearchDue(authorId, key)).toBe(false);

    searchAllIndexers.mockClear();
    await scheduler.runAutoSearch();
    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);

    await backoff.resetSearchBackoff(authorId);
    expect(await backoff.seasonSearchDue(authorId, key)).toBe(true);
  });

  it("does not look for a collection when the setting is off", async () => {
    await insertClient();
    await terry();
    settings.setSetting("collectionGrabs", "0");

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
  });

  it("does not look for one for an author with two books missing", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    await insertBook(authorId, "Mort", "1987-11-12");
    await insertBook(authorId, "Sourcery", "1988-05-05");
    await insertBook(authorId, "Eric", "1990-10-01", { hasFile: 1 });

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
  });

  it("leaves artists to their discography search", async () => {
    await insertClient();
    const artistId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', 1, 0, 'missing')").run()).lastInsertRowid);
    for (const [i, title] of ["Queen", "Queen II", "Innuendo"].entries()) await insertBook(artistId, title, `${1973 + i}-01-01`);

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter((q) => /collection/i.test(q))).toEqual([]);
    expect(queriesAsked().filter((q) => /discography/i.test(q))).toEqual(["Queen discography"]);
  });
});

describe("a collection that failed or was removed", () => {
  it("is blocklisted and its books are woken, with no other release grabbed in its place", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await grabCollection(authorId, books);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 5").run();
    await backoff.recordSeasonSearch(authorId, collections.COLLECTION_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(authorId, collections.COLLECTION_SEARCH_KEY, false);
    const { queueItemFromRow } = await import("../src/db/mappers.js");
    const match = queueItemFromRow((await queueRows())[0]);
    searchAllIndexers.mockClear();
    addDownload.mockClear();

    await scheduler.retryFailedGrab(match, "Download client reported failure");

    const blocked = (await db.prepare("SELECT release_title FROM blocklist WHERE media_item_id = ?").all(authorId)) as any[];
    expect(blocked.map((b) => b.release_title)).toEqual([COLLECTION]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(addDownload).not.toHaveBeenCalled();
    const misses = (await db.prepare("SELECT auto_search_misses FROM sub_items").all()) as any[];
    expect(misses.every((m) => Number(m.auto_search_misses) === 0)).toBe(true);
    expect(await backoff.seasonSearchDue(authorId, collections.COLLECTION_SEARCH_KEY)).toBe(true);
  });

  it("wakes its books and the collection search when removed from the queue and blocklisted", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await grabCollection(authorId, books);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 5").run();
    await backoff.recordSeasonSearch(authorId, collections.COLLECTION_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(authorId, collections.COLLECTION_SEARCH_KEY, false);
    const [row] = await queueRows();

    const res = await request(app).delete(`/api/activity/queue/${row.id}?blocklist=1&removeFromClient=0`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(await queueRows()).toHaveLength(0);
    const misses = (await db.prepare("SELECT auto_search_misses FROM sub_items").all()) as any[];
    expect(misses.every((m) => Number(m.auto_search_misses) === 0)).toBe(true);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(1);
    expect(await backoff.seasonSearchDue(authorId, collections.COLLECTION_SEARCH_KEY)).toBe(true);
  });

  it("lists the books it is for in the queue, as books", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await grabCollection(authorId, books);

    const res = await request(app).get("/api/activity/queue").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.items[0].subItemId).toBeNull();
    expect(res.body.items[0].targetKind).toBe("book");
    expect(res.body.items[0].albums.map((a: any) => a.title)).toEqual(["The Colour of Magic", "The Light Fantastic", "Equal Rites", "Mort", "Sourcery"]);
  });
});

describe("picking a collection by hand", () => {
  it("lists it with what it covers, asked for by name, and marks another author's", async () => {
    await insertClient();
    const { authorId } = await terry();
    await insertBook(authorId, "Pyramids", "1989-06-01", { hasFile: 1 });
    answers((query) =>
      isCollectionQuery(query)
        ? [release("Terry Pratchett - Complete Collection [EPUB]"), release("Neil Gaiman - Complete Collection [EPUB]"), release("Terry Pratchett - Bibliography (1983-1987) [MOBI]")]
        : []
    );

    const res = await request(app).get(`/api/search/${authorId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(queriesAsked()).toContain("Terry Pratchett complete collection");
    const all = res.body.find((r: any) => r.title === "Terry Pratchett - Complete Collection [EPUB]");
    expect(all.collection).toEqual({ booksCovered: 6, booksMissing: 5 });
    expect(all.rejected).toBe(false);
    const short = res.body.find((r: any) => r.title === "Terry Pratchett - Bibliography (1983-1987) [MOBI]");
    expect(short.collection).toEqual({ booksCovered: 4, booksMissing: 4 });
    const other = res.body.find((r: any) => r.title === "Neil Gaiman - Complete Collection [EPUB]");
    expect(other.rejected).toBe(true);
    expect(other.rejectReason).toBe("It is not named for this author");
  });

  it("does not ask for one when the setting is off", async () => {
    await insertClient();
    const { authorId } = await terry();
    settings.setSetting("collectionGrabs", "0");

    await request(app).get(`/api/search/${authorId}`).set("X-Api-Key", apiKey);

    expect(queriesAsked().filter(isCollectionQuery)).toEqual([]);
  });

  it("fits a book's search when it is the author's and covers the book, and says why not otherwise", async () => {
    const { authorId, books } = await terry();
    searchAllIndexers.mockResolvedValue([
      release("Terry Pratchett - Complete Collection [EPUB]"),
      release("Terry Pratchett - Bibliography (1986-1988) [EPUB]"),
      release("Terry Pratchett - Bibliography (1990-2000) [EPUB]"),
      release("Neil Gaiman - Complete Collection [EPUB]"),
    ]);

    const res = await request(app).get(`/api/search/${authorId}?subItemId=${books[1]}`).set("X-Api-Key", apiKey);

    const byTitle = (title: string) => res.body.find((r: any) => r.title === title);
    expect(byTitle("Terry Pratchett - Complete Collection [EPUB]")).toMatchObject({ nameOk: true, nameReason: null });
    expect(byTitle("Terry Pratchett - Bibliography (1986-1988) [EPUB]")).toMatchObject({ nameOk: true });
    expect(byTitle("Terry Pratchett - Bibliography (1990-2000) [EPUB]")).toMatchObject({ nameOk: false, nameReason: "What it spans does not include this book" });
    expect(byTitle("Neil Gaiman - Complete Collection [EPUB]")).toMatchObject({ nameOk: false, nameReason: "It is not named for this author" });
  });

  it("queues it for every missing book it covers, whichever book the search was opened from", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await insertBook(authorId, "Pyramids", "1989-06-01", { hasFile: 1 });

    const res = await request(app)
      .post(`/api/search/${authorId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: COLLECTION, downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", size: 300_000_000, subItemId: books[1] });

    expect(res.status).toBe(201);
    expect(res.body.subItemId).toBeNull();
    expect(await targetsOf(res.body.id)).toEqual(sorted(books));
    expect(res.body.title).toBe(COLLECTION);
  });

  it("leaves out the books that already have a download, and says so when that is all of them", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Terry Pratchett - The Colour of Magic', 'downloading')").run(authorId, books[0]);
    const body = { title: "Terry Pratchett - Complete Collection [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" };

    const res = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send(body);
    expect(res.status).toBe(201);
    expect(await targetsOf(res.body.id)).toEqual(sorted(books.slice(1)));

    await db.prepare("DELETE FROM queue WHERE sub_item_id IS NULL").run();
    for (const id of books.slice(1)) await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, ?, 'downloading')").run(authorId, id, `Book ${id}`);
    addDownload.mockClear();
    const none = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send({ ...body, downloadUrl: "magnet:?xt=urn:btih:def" });
    expect(none.status).toBe(400);
    expect(none.text).toContain("already downloading");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("refuses one that covers nothing that is missing", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    await insertBook(authorId, "Mort", "1987-11-12", { hasFile: 1 });

    const res = await request(app)
      .post(`/api/search/${authorId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Terry Pratchett - Complete Collection [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("It covers no book that is missing");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("refuses one that is another author's", async () => {
    await insertClient();
    const { authorId } = await terry();

    const res = await request(app)
      .post(`/api/search/${authorId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Neil Gaiman - Complete Collection [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("It is not named for Terry Pratchett");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("asks once about one that includes a book not out yet, and takes it when told to (with the code the list sends)", async () => {
    await insertClient();
    const { authorId, books } = await terry();
    await insertBook(authorId, "The Next Book", "2999-01-01");
    const body = { title: "Terry Pratchett - Complete Collection [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" };

    const asked = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send(body);
    expect(asked.status).toBe(409);
    expect(asked.text).toContain("not out yet");
    expect(addDownload).not.toHaveBeenCalled();

    const told = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send({ ...body, overrides: ["season-pack"] });
    expect(told.status).toBe(201);
    expect(await targetsOf(told.body.id)).toEqual(sorted(books));
  });

  it("asks about a range the library cannot place, and then queues every book it leaves open", async () => {
    await insertClient();
    const authorId = await insertAuthor();
    const unplaced = [await insertBook(authorId, "Mort", "1987-11-12"), await insertBook(authorId, "Sourcery", "1988-05-05")];
    const body = { title: "Terry Pratchett - Books 1-9 [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" };

    const asked = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send(body);
    expect(asked.status).toBe(409);
    expect(asked.text).toContain("series position");

    const told = await request(app).post(`/api/search/${authorId}/grab`).set("X-Api-Key", apiKey).send({ ...body, overrides: ["collection"] });
    expect(told.status).toBe(201);
    expect(await targetsOf(told.body.id)).toEqual(sorted(unplaced));
  });

  it("grabs a book that has the word in its own title as that book", async () => {
    await insertClient();
    const authorId = await insertAuthor("Flannery O'Connor");
    const stories = await insertBook(authorId, "The Complete Stories", "1971-01-01");
    await insertBook(authorId, "Wise Blood", "1952-01-01");

    const res = await request(app)
      .post(`/api/search/${authorId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Flannery O'Connor - The Complete Stories [EPUB]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", subItemId: stories });

    expect(res.status).toBe(201);
    expect(res.body.subItemId).toBe(stories);
    expect(await targetsOf(res.body.id)).toEqual([]);
  });
});
