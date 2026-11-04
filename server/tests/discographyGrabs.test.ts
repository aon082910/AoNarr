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
let addDownload: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  backoff = await import("../src/services/searchBackoff.js");
  settings = await import("../src/services/settingsStore.js");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "season_searches", "tracks", "sub_items", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
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
    size: 3_000_000_000,
    seeders: 10,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: `magnet:?xt=urn:btih:${encodeURIComponent(title)}`,
    protocol: "torrent",
    category: null,
    ...overrides,
  };
}

async function insertArtist(title = "Queen"): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', ?, ?, 1, 0, 'missing')").run(title, title.toLowerCase()))
      .lastInsertRowid
  );
}

async function insertAlbum(artistId: number, title: string, releaseDate: string | null, extra: { monitored?: number; hasFile?: number } = {}): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, ?, ?)")
        .run(artistId, title, releaseDate, extra.monitored ?? 1, extra.hasFile ?? 0)
    ).lastInsertRowid
  );
}

/** Queen, with four albums out and missing. */
async function queen(): Promise<{ artistId: number; albums: number[] }> {
  const artistId = await insertArtist("Queen");
  const albums = [
    await insertAlbum(artistId, "Queen", "1973-07-13"),
    await insertAlbum(artistId, "Queen II", "1974-03-08"),
    await insertAlbum(artistId, "Sheer Heart Attack", "1974-11-08"),
    await insertAlbum(artistId, "Innuendo", "1991-02-04"),
  ];
  return { artistId, albums };
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

const isDiscographyQuery = (query: string) => /discograph/i.test(query);
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

async function grabDiscography(artistId: number, targets: number[], title = "Queen - Discography (1973-1995) [FLAC]") {
  const item = await mediaItem(artistId);
  const client = (await db.prepare("SELECT * FROM download_clients LIMIT 1").get()) as any;
  const { downloadClientFromRow } = await import("../src/db/mappers.js");
  return scheduler.grab(downloadClientFromRow(client) as any, item, null, null, { result: release(title) as any, quality: "Unknown" }, 0, null, "auto", { targetSubItemIds: targets });
}

describe("grab() for a discography", () => {
  it("queues one download for the albums, with no album of its own, and records a grab for each", async () => {
    await insertClient();
    const { artistId, albums } = await queen();

    expect(await grabDiscography(artistId, albums)).toBe(true);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sub_item_id).toBeNull();
    expect(rows[0].episode_id).toBeNull();
    expect(await targetsOf(rows[0].id)).toEqual([...albums].sort((a, b) => a - b));
    expect(addDownload).toHaveBeenCalledTimes(1);
    const grabbed = (await db.prepare("SELECT sub_item_id FROM history WHERE event_type = 'grabbed' ORDER BY sub_item_id").all()) as any[];
    expect(grabbed.map((h) => Number(h.sub_item_id))).toEqual([...albums].sort((a, b) => a - b));
  });

  it("counts every album it is for as queued, and no other", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    const other = await insertAlbum(artistId, "The Miracle", "1989-05-22");
    await grabDiscography(artistId, albums);

    for (const id of albums) expect(await scheduler.isAlreadyQueued(artistId, null, id)).toBe(true);
    expect(await scheduler.isAlreadyQueued(artistId, null, other)).toBe(false);

    await db.prepare("UPDATE queue SET status = 'failed'").run();
    for (const id of albums) expect(await scheduler.isAlreadyQueued(artistId, null, id)).toBe(false);
  });

  it("refuses a second download when every album it is for is already on its way, and takes one for the rest", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await grabDiscography(artistId, albums.slice(0, 2));

    expect(await grabDiscography(artistId, albums.slice(0, 2), "Queen - Discography [MP3]")).toBe(false);
    expect(await grabDiscography(artistId, albums, "Queen - Discography (1973-1995) [MP3]")).toBe(true);
    expect(await queueRows()).toHaveLength(2);
  });

  it("drops an album's link when the album goes, and every link when the download does", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await grabDiscography(artistId, albums);
    const [row] = await queueRows();

    await db.prepare("DELETE FROM sub_items WHERE id = ?").run(albums[0]);
    expect(await queueRows()).toHaveLength(1);
    expect(await targetsOf(row.id)).toHaveLength(3);

    await db.prepare("DELETE FROM queue WHERE id = ?").run(row.id);
    expect(await targetsOf(row.id)).toEqual([]);
  });

  it("leaves out an album that got a download of its own while the release was being chosen", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen (1973)', 'downloading')").run(artistId, albums[0]);

    expect(await grabDiscography(artistId, albums)).toBe(true);

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual(albums.slice(1).sort((a, b) => a - b));
    // And with every album already on its way, nothing is added to the client.
    addDownload.mockClear();
    expect(await grabDiscography(artistId, albums, "Queen - Discography [MP3]")).toBe(false);
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("writes nothing of the row when its albums cannot be written, and keeps no half-made row", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await expect(grabDiscography(artistId, [...albums, 99999999])).rejects.toThrow();
    expect(await queueRows()).toHaveLength(0);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM history").get()) as any).c)).toBe(0);
  });

  it("is not for one album as well", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    const item = await mediaItem(artistId);
    const client = (await db.prepare("SELECT * FROM download_clients LIMIT 1").get()) as any;
    const { downloadClientFromRow } = await import("../src/db/mappers.js");
    await expect(
      scheduler.grab(downloadClientFromRow(client) as any, item, null, albums[0], { result: release("Queen - Discography") as any, quality: "Unknown" }, 0, null, "auto", { targetSubItemIds: albums })
    ).rejects.toThrow(/several albums/);
  });
});

describe("searching for a discography", () => {
  it("asks for the discography first and files it against every missing album, without searching them one by one", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(queriesAsked()).toEqual(["Queen discography"]);
    expect(result).toMatchObject({ grabbed: true, childrenSearched: 1, childrenGrabbed: 1 });
    const [row] = await queueRows();
    expect(row.title).toBe("Queen - Discography (1973-1995) [FLAC]");
    expect(row.sub_item_id).toBeNull();
    expect(await targetsOf(row.id)).toEqual([...albums].sort((a, b) => a - b));
  });

  it("searches the albums one by one when there is no discography", async () => {
    await insertClient();
    const { artistId } = await queen();

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual(["Queen discography"]);
    expect(searchAllIndexers).toHaveBeenCalledTimes(5);
    expect(result.grabbed).toBe(false);
  });

  it("looks for the albums that the discography leaves out, one by one", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await insertAlbum(artistId, "The Miracle", "1989-05-22");
    answers((query) =>
      isDiscographyQuery(query)
        ? [release("Queen - Discography (1973-1977) [FLAC]")]
        : /miracle/i.test(query)
        ? [release("Queen - The Miracle (1989) [FLAC]")]
        : []
    );

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    // Innuendo (1991) and The Miracle (1989) are outside 1973-1977.
    expect(result.childrenGrabbed).toBe(2);
    const rows = await queueRows();
    expect(rows).toHaveLength(2);
    const discography = rows.find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(discography.id)).toEqual(albums.slice(0, 3).sort((a, b) => a - b));
  });

  it("does not look for one when only one album is missing", async () => {
    await insertClient();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Queen", "1973-07-13");
    await insertAlbum(artistId, "Queen II", "1974-03-08", { hasFile: 1 });
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("does nothing about discographies when the setting is off", async () => {
    await insertClient();
    const { artistId } = await queen();
    settings.setSetting("discographyGrabs", "0");
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("never takes a discography in an album's own search", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    searchAllIndexers.mockResolvedValue([release("Queen - Discography (1973-1995) [FLAC]")]);

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId, subItemId: albums[1] }]);

    expect(result.grabbed).toBe(false);
    expect(await queueRows()).toHaveLength(0);
  });

  it("does not take another artist's discography", async () => {
    await insertClient();
    const { artistId } = await queen();
    answers((query) => (isDiscographyQuery(query) ? [release("Queen Latifah - Discography (1973-1995) [FLAC]"), release("Queens of the Stone Age - Discography [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(await queueRows()).toHaveLength(0);
  });

  it("does not take one that would include an album that is not out yet, and takes one whose years stop before it", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography [FLAC]")] : []));
    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);
    expect(await queueRows()).toHaveLength(0);

    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));
    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);
    const [row] = await queueRows();
    expect(await targetsOf(row.id)).toEqual([...albums].sort((a, b) => a - b));
  });

  it("is for the albums that are missing and monitored, not those with files or not monitored", async () => {
    await insertClient();
    const artistId = await insertArtist("Queen");
    const wanted = [await insertAlbum(artistId, "Queen", "1973-07-13"), await insertAlbum(artistId, "Queen II", "1974-03-08"), await insertAlbum(artistId, "Innuendo", "1991-02-04")];
    await insertAlbum(artistId, "Sheer Heart Attack", "1974-11-08", { hasFile: 1 });
    await insertAlbum(artistId, "The Miracle", "1989-05-22", { monitored: 0 });
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    const [row] = await queueRows();
    expect(await targetsOf(row.id)).toEqual([...wanted].sort((a, b) => a - b));
  });

  it("takes the lossless discography, and then the one that adds more missing albums", async () => {
    await insertClient();
    const { artistId } = await queen();
    answers((query) =>
      isDiscographyQuery(query)
        ? [
            release("Queen - Discography (1973-1974) [FLAC]", { seeders: 10 }),
            release("Queen - Discography (1973-1995) [MP3 320]", { seeders: 10 }),
            release("Queen - Discography (1973-1995) [FLAC]", { seeders: 10 }),
          ]
        : []
    );

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    const [row] = await queueRows();
    expect(row.title).toBe("Queen - Discography (1973-1995) [FLAC]");
  });

  it("leaves the choice to the better-seeded release before it counts albums, as Lidarr's comparer does", async () => {
    await insertClient();
    const { artistId } = await queen();
    answers((query) =>
      isDiscographyQuery(query)
        ? [release("Queen - Discography (1973-1995) [FLAC]", { seeders: 1 }), release("Queen - Discography (1973-1977) [FLAC]", { seeders: 500 })]
        : []
    );

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    const [row] = await queueRows();
    expect(row.title).toBe("Queen - Discography (1973-1977) [FLAC]");
  });

  it("does not take a discography of forty albums for two missing ones, and leaves them to their own searches", async () => {
    await insertClient();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Missing One", "1973-07-13");
    await insertAlbum(artistId, "Missing Two", "1974-03-08");
    for (let i = 0; i < 38; i++) await insertAlbum(artistId, `Owned ${i}`, `${1975 + (i % 20)}-01-01`, { hasFile: 1 });
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography [FLAC]")] : []));

    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(result.grabbed).toBe(false);
    expect(await queueRows()).toHaveLength(0);
    // Both albums were searched on their own.
    expect(queriesAsked().filter((q) => /missing/i.test(q))).toHaveLength(2);
  });

  it("does not take a blocklisted discography", async () => {
    await insertClient();
    const { artistId } = await queen();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(artistId, "Queen - Discography (1973-1995) [FLAC]");
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(await queueRows()).toHaveLength(0);
  });

  it("covers an album that is already downloading without counting it as wanted", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    // Two albums have a download of their own on the way; two are left.
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen (1973)', 'downloading')").run(artistId, albums[0]);
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen II (1974)', 'downloading')").run(artistId, albums[1]);
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));

    await scheduler.searchAndGrabTargets([{ mediaItemId: artistId }]);

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual([albums[2], albums[3]].sort((a, b) => a - b));
  });
});

describe("merging two copies of an artist while a discography downloads", () => {
  it("moves the albums it is for to the keeper's albums, and keeps the row", async () => {
    await insertClient();
    const keeper = await insertArtist("Queen");
    const keeperQueen = await insertAlbum(keeper, "Queen", "1973-07-13");
    const keeperQueen2 = await insertAlbum(keeper, "Queen II", "1974-03-08");
    const { artistId: loser, albums } = await queen();
    await grabDiscography(loser, albums.slice(0, 3));

    const { mergeMediaItems } = await import("../src/services/duplicateCheck.js");
    await mergeMediaItems(keeper, [loser], false);

    const [row] = await queueRows();
    expect(row.media_item_id).toBe(keeper);
    const targets = await targetsOf(row.id);
    expect(targets).toContain(keeperQueen);
    expect(targets).toContain(keeperQueen2);
    expect(targets).toHaveLength(3);
    const owners = (await db.prepare(`SELECT DISTINCT media_item_id FROM sub_items WHERE id IN (${targets.map(() => "?").join(",")})`).all(...targets)) as any[];
    expect(owners.map((o) => Number(o.media_item_id))).toEqual([keeper]);
  });
});

describe("the automatic search", () => {
  it("looks for the discography before the albums, and then skips the albums it covers", async () => {
    await insertClient();
    const { artistId } = await queen();
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1973-1995) [FLAC]")] : []));

    await scheduler.runAutoSearch();

    expect(queriesAsked()).toEqual(["Queen discography"]);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].media_item_id).toBe(artistId);
  });

  it("keeps to a wait after it finds nothing, and starts over when the backoff does", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId } = await queen();
    const missesOf = async () => Number(((await db.prepare("SELECT misses FROM season_searches WHERE media_item_id = ? AND season_number = ?").get(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)) as any)?.misses ?? 0);

    await scheduler.runAutoSearch();
    expect(await missesOf()).toBe(1);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(true);

    await scheduler.runAutoSearch();
    expect(await missesOf()).toBe(2);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(false);

    searchAllIndexers.mockClear();
    await scheduler.runAutoSearch();
    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);

    await backoff.resetSearchBackoff(artistId);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(true);
  });

  it("does not look for a discography when the setting is off", async () => {
    await insertClient();
    await queen();
    settings.setSetting("discographyGrabs", "0");

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);
  });

  it("does not look for one for an artist with a single album missing", async () => {
    await insertClient();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Queen", "1973-07-13");
    await insertAlbum(artistId, "A Night at the Opera", "1975-11-21", { hasFile: 1 });

    await scheduler.runAutoSearch();

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);
  });
});

describe("a discography that failed or was removed", () => {
  it("is blocklisted and its albums are woken, with no other release grabbed in its place", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await grabDiscography(artistId, albums);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 5").run();
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    const { queueItemFromRow } = await import("../src/db/mappers.js");
    const match = queueItemFromRow((await queueRows())[0]);
    searchAllIndexers.mockClear();
    addDownload.mockClear();

    await scheduler.retryFailedGrab(match, "Download client reported failure");

    const blocked = (await db.prepare("SELECT release_title FROM blocklist WHERE media_item_id = ?").all(artistId)) as any[];
    expect(blocked.map((b) => b.release_title)).toEqual(["Queen - Discography (1973-1995) [FLAC]"]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(addDownload).not.toHaveBeenCalled();
    const misses = (await db.prepare("SELECT auto_search_misses FROM sub_items").all()) as any[];
    expect(misses.every((m) => Number(m.auto_search_misses) === 0)).toBe(true);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(true);
  });

  it("wakes its albums when removed from the queue and blocklisted", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await grabDiscography(artistId, albums);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 5").run();
    const [row] = await queueRows();

    const res = await request(app).delete(`/api/activity/queue/${row.id}?blocklist=1&removeFromClient=0`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(await queueRows()).toHaveLength(0);
    const misses = (await db.prepare("SELECT auto_search_misses FROM sub_items").all()) as any[];
    expect(misses.every((m) => Number(m.auto_search_misses) === 0)).toBe(true);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(1);
  });

  it("lists the albums it is for in the queue", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await grabDiscography(artistId, albums);

    const res = await request(app).get("/api/activity/queue").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.items[0].subItemId).toBeNull();
    expect(res.body.items[0].albums.map((a: any) => a.title)).toEqual(["Queen", "Queen II", "Sheer Heart Attack", "Innuendo"]);
  });
});

describe("picking a discography by hand", () => {
  it("lists it with what it covers, asked for by name, and marks another artist's", async () => {
    await insertClient();
    const { artistId } = await queen();
    await insertAlbum(artistId, "The Miracle", "1989-05-22", { hasFile: 1 });
    answers((query) =>
      isDiscographyQuery(query)
        ? [release("Queen - Discography (1973-1995) [FLAC]"), release("Queen Latifah - Discography [FLAC]"), release("Queen - Discography (1973-1974) [MP3]")]
        : []
    );

    const res = await request(app).get(`/api/search/${artistId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(queriesAsked()).toContain("Queen discography");
    const all = res.body.find((r: any) => r.title === "Queen - Discography (1973-1995) [FLAC]");
    expect(all.discography).toEqual({ albumsCovered: 5, albumsMissing: 4 });
    expect(all.rejected).toBe(false);
    const short = res.body.find((r: any) => r.title === "Queen - Discography (1973-1974) [MP3]");
    // 1973 and 1974 hold three of the albums (the record of 1974-11 included).
    expect(short.discography).toEqual({ albumsCovered: 3, albumsMissing: 3 });
    const latifah = res.body.find((r: any) => r.title === "Queen Latifah - Discography [FLAC]");
    expect(latifah.rejected).toBe(true);
    expect(latifah.rejectReason).toBe("It is another artist's discography");
  });

  it("does not ask for one when the setting is off", async () => {
    await insertClient();
    const { artistId } = await queen();
    settings.setSetting("discographyGrabs", "0");

    await request(app).get(`/api/search/${artistId}`).set("X-Api-Key", apiKey);

    expect(queriesAsked().filter(isDiscographyQuery)).toEqual([]);
  });

  it("fits an album's search when it is the artist's and covers the album, and says why not otherwise", async () => {
    const { artistId, albums } = await queen();
    searchAllIndexers.mockResolvedValue([
      release("Queen - Discography (1973-1995) [FLAC]"),
      release("Queen - Discography (1980-1995) [FLAC]"),
      release("Queen Latifah - Discography [FLAC]"),
    ]);

    const res = await request(app).get(`/api/search/${artistId}?subItemId=${albums[1]}`).set("X-Api-Key", apiKey);

    const byTitle = (title: string) => res.body.find((r: any) => r.title === title);
    expect(byTitle("Queen - Discography (1973-1995) [FLAC]")).toMatchObject({ nameOk: true, nameReason: null });
    expect(byTitle("Queen - Discography (1980-1995) [FLAC]")).toMatchObject({ nameOk: false, nameReason: "The years it spans do not include this album" });
    expect(byTitle("Queen Latifah - Discography [FLAC]")).toMatchObject({ nameOk: false, nameReason: "It is another artist's discography" });
  });

  it("queues it for every missing album it covers, whichever album the search was opened from", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await insertAlbum(artistId, "The Miracle", "1989-05-22", { hasFile: 1 });
    const title = "Queen - Discography (1973-1995) [FLAC]";

    const res = await request(app)
      .post(`/api/search/${artistId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title, downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", size: 3_000_000_000, subItemId: albums[1] });

    expect(res.status).toBe(201);
    expect(res.body.subItemId).toBeNull();
    expect(await targetsOf(res.body.id)).toEqual([...albums].sort((a, b) => a - b));
    expect(res.body.title).toBe(title);
  });

  it("leaves out the albums that already have a download, and says so when that is all of them", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen (1973)', 'downloading')").run(artistId, albums[0]);
    const body = { title: "Queen - Discography (1973-1995) [FLAC]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" };

    const res = await request(app).post(`/api/search/${artistId}/grab`).set("X-Api-Key", apiKey).send(body);
    expect(res.status).toBe(201);
    expect(await targetsOf(res.body.id)).toEqual(albums.slice(1).sort((a, b) => a - b));

    await db.prepare("DELETE FROM queue WHERE sub_item_id IS NULL").run();
    for (const id of albums.slice(1)) await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, ?, 'downloading')").run(artistId, id, `Album ${id}`);
    addDownload.mockClear();
    const none = await request(app).post(`/api/search/${artistId}/grab`).set("X-Api-Key", apiKey).send({ ...body, downloadUrl: "magnet:?xt=urn:btih:def" });
    expect(none.status).toBe(400);
    expect(none.text).toContain("already downloading");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("takes the confirmation the list sends for a pack, as well as its own", async () => {
    await insertClient();
    const { artistId } = await queen();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    const res = await request(app)
      .post(`/api/search/${artistId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Queen - Discography [FLAC]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", overrides: ["season-pack"] });
    expect(res.status).toBe(201);
  });

  it("grabs an album that has the word in its own title as that album", async () => {
    await insertClient();
    const artistId = await insertArtist("Pet Shop Boys");
    const singles = await insertAlbum(artistId, "Discography: The Complete Singles Collection", "1991-01-01");
    await insertAlbum(artistId, "Actually", "1987-09-07");

    const res = await request(app)
      .post(`/api/search/${artistId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Pet Shop Boys - Discography: The Complete Singles Collection (1991) [FLAC]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", subItemId: singles });

    expect(res.status).toBe(201);
    expect(res.body.subItemId).toBe(singles);
    expect(await targetsOf(res.body.id)).toEqual([]);
  });

  it("refuses one that covers nothing that is missing", async () => {
    await insertClient();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Queen", "1973-07-13", { hasFile: 1 });

    const res = await request(app)
      .post(`/api/search/${artistId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Queen - Discography [FLAC]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("It covers no album that is missing");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("asks once about one that includes an album not out yet, and takes it when told to", async () => {
    await insertClient();
    const { artistId, albums } = await queen();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    const body = { title: "Queen - Discography [FLAC]", downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent" };

    const asked = await request(app).post(`/api/search/${artistId}/grab`).set("X-Api-Key", apiKey).send(body);
    expect(asked.status).toBe(409);
    expect(asked.text).toContain("not out yet");
    expect(addDownload).not.toHaveBeenCalled();

    const told = await request(app).post(`/api/search/${artistId}/grab`).set("X-Api-Key", apiKey).send({ ...body, overrides: ["discography"] });
    expect(told.status).toBe(201);
    expect(await targetsOf(told.body.id)).toEqual([...albums].sort((a, b) => a - b));
  });
});
