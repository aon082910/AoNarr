import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
const fetchRecentReleases = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/indexerClient.js")>()),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
  fetchRecentReleases: (...args: unknown[]) => fetchRecentReleases(...args),
}));

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

const notifyGrabbed = vi.fn();
const notifyImported = vi.fn();
vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyGrabbed: (...args: unknown[]) => notifyGrabbed(...args),
  notifyImported: (...args: unknown[]) => notifyImported(...args),
}));

vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));
vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));
const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let scheduler: typeof import("../src/services/scheduler.js");
let backoff: typeof import("../src/services/searchBackoff.js");
let settings: typeof import("../src/services/settingsStore.js");
let registry: typeof import("../src/services/settingsRegistry.js");
let rss: typeof import("../src/services/rssSync.js");
let irc: typeof import("../src/services/ircAnnounce.js");
let pendingJob: typeof import("../src/services/pendingReleases.js");
let importer: typeof import("../src/services/importer.js");
let config: (typeof import("../src/config.js"))["config"];
let addDownload: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  backoff = await import("../src/services/searchBackoff.js");
  settings = await import("../src/services/settingsStore.js");
  registry = await import("../src/services/settingsRegistry.js");
  rss = await import("../src/services/rssSync.js");
  irc = await import("../src/services/ircAnnounce.js");
  pendingJob = await import("../src/services/pendingReleases.js");
  importer = await import("../src/services/importer.js");
  ({ config } = await import("../src/config.js"));
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "pending_releases", "rss_decisions", "rss_sync_state", "season_searches", "queue_targets", "queue", "delay_profiles", "tracks", "sub_items", "media_items", "root_folders", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  settings.setSetting("discographyGrabs", "");
  settings.setSetting("discographyFallbackSingle", "");
  settings.setSetting("quietHoursEnabled", "0");
  settings.setSetting("searchWindowEnabled", "0");
  settings.setSetting("autoUpgradeEnabled", "0");
  searchAllIndexers.mockReset().mockResolvedValue([]);
  fetchRecentReleases.mockReset().mockResolvedValue({ results: [], newest: null });
  notifyGrabbed.mockReset().mockResolvedValue(undefined);
  notifyImported.mockReset().mockResolvedValue(undefined);
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
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
    publishDate: "2020-01-01T00:00:00Z",
    downloadUrl: `magnet:?xt=urn:btih:${encodeURIComponent(title)}`,
    protocol: "torrent",
    category: null,
    ...overrides,
  };
}

const byId = (a: number, b: number) => a - b;

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

/** Queen with one album missing and three in the library. */
async function queenMissingOne(): Promise<{ artistId: number; missing: number }> {
  const artistId = await insertArtist("Queen");
  await insertAlbum(artistId, "Queen", "1973-07-13", { hasFile: 1 });
  await insertAlbum(artistId, "Queen II", "1974-03-08", { hasFile: 1 });
  const missing = await insertAlbum(artistId, "A Night at the Opera", "1975-11-21");
  await insertAlbum(artistId, "Innuendo", "1991-02-04", { hasFile: 1 });
  return { artistId, missing };
}

async function insertClient(): Promise<void> {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run();
}

async function insertIndexer(): Promise<number> {
  return Number((await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, media_types) VALUES ('Tracker', 'torznab', 'http://x', 1, 'artist')").run()).lastInsertRowid);
}

const queueRows = async (): Promise<any[]> => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const decisionRows = async (): Promise<any[]> => (await db.prepare("SELECT title, outcome, reason, media_item_id FROM rss_decisions ORDER BY id").all()) as any[];

async function targetsOf(queueId: number): Promise<number[]> {
  return ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ? ORDER BY sub_item_id").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));
}

/** The feed answers with these releases (newest first). */
function feed(...releases: ReturnType<typeof release>[]): void {
  fetchRecentReleases.mockResolvedValue({ results: releases, newest: releases[0] ? { url: releases[0].downloadUrl, at: releases[0].publishDate } : null });
}

/** What a search answers: by the words of its query. */
function answers(byQuery: (query: string) => ReturnType<typeof release>[]): void {
  searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) => byQuery(query));
}
const isDiscographyQuery = (query: string) => /discograph/i.test(query);
const queriesAsked = () => searchAllIndexers.mock.calls.map((call) => String(call[1]));
const discographyQueries = () => queriesAsked().filter(isDiscographyQuery);

const DISCOGRAPHY = "Queen - Discography (1973-1995) [FLAC]";

describe("the setting", () => {
  it("is a known key that takes 1 or 0, off until it is switched on", async () => {
    expect(registry.isKnownSettingKey("discographyFallbackSingle")).toBe(true);
    expect(registry.settingValueProblem("discographyFallbackSingle", "1")).toBeNull();
    expect(registry.settingValueProblem("discographyFallbackSingle", "0")).toBeNull();
    expect(registry.settingValueProblem("discographyFallbackSingle", "yes")).not.toBeNull();
    const { discographyFallbackSingleEnabled } = await import("../src/services/discography.js");
    expect(discographyFallbackSingleEnabled()).toBe(false);
    settings.setSetting("discographyFallbackSingle", "1");
    expect(discographyFallbackSingleEnabled()).toBe(true);
  });
});

describe("an RSS feed that lists a discography", () => {
  it("grabs it once, for the albums it adds, and records the grab", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId, albums } = await queen();
    const wanted = release(DISCOGRAPHY, { indexerId });
    feed(wanted, release("Some Other Band - Discography [FLAC]", { indexerId }));

    const summary = await rss.runRssSync();

    expect(summary).toMatchObject({ releases: 2, grabbed: 1 });
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ media_item_id: artistId, sub_item_id: null, episode_id: null, title: DISCOGRAPHY, grab_source: "rss" });
    expect(await targetsOf(rows[0].id)).toEqual([...albums].sort(byId));
    expect(addDownload).toHaveBeenCalledTimes(1);
    const grabbed = (await db.prepare("SELECT sub_item_id FROM history WHERE event_type = 'grabbed' ORDER BY sub_item_id").all()) as any[];
    expect(grabbed.map((h) => Number(h.sub_item_id))).toEqual([...albums].sort(byId));
    const decisions = await decisionRows();
    expect(decisions.find((d) => d.title === DISCOGRAPHY)).toMatchObject({ outcome: "grabbed", media_item_id: artistId });
    expect(decisions.find((d) => d.title.startsWith("Some Other Band"))).toMatchObject({ outcome: "unmatched" });
  });

  it("does not take it for one missing album, and records why", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId } = await queenMissingOne();
    feed(release(DISCOGRAPHY, { indexerId }));

    const summary = await rss.runRssSync();

    expect(summary.grabbed).toBe(0);
    expect(await queueRows()).toHaveLength(0);
    const [decision] = await decisionRows();
    expect(decision).toMatchObject({ outcome: "rejected", media_item_id: artistId });
    expect(decision.reason).toContain("only 1 missing album");
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("does not take a discography of forty albums for two missing ones", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Missing One", "1973-07-13");
    await insertAlbum(artistId, "Missing Two", "1974-03-08");
    for (let i = 0; i < 38; i++) await insertAlbum(artistId, `Owned ${i}`, `${1975 + (i % 20)}-01-01`, { hasFile: 1 });
    feed(release("Queen - Discography [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect(await queueRows()).toHaveLength(0);
    expect((await decisionRows())[0].reason).toContain("better searched one by one");
  });

  it("does not take one that would include an album that is not out yet", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId } = await queen();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    feed(release("Queen - Discography [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect(await queueRows()).toHaveLength(0);
    expect((await decisionRows())[0]).toMatchObject({ outcome: "rejected" });
    expect((await decisionRows())[0].reason).toContain("not out yet");
  });

  it("takes nothing when discography grabs are switched off, and says so", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await queen();
    settings.setSetting("discographyGrabs", "0");
    feed(release(DISCOGRAPHY, { indexerId }));

    const summary = await rss.runRssSync();

    expect(summary.grabbed).toBe(0);
    expect(await queueRows()).toHaveLength(0);
    expect(await decisionRows()).toEqual([expect.objectContaining({ outcome: "unmatched", reason: expect.stringContaining("switched off") })]);
  });

  it("leaves another artist's discography alone", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await queen();
    feed(release("Queen Latifah - Discography (1973-1995) [FLAC]", { indexerId }), release("Queens of the Stone Age - Discography [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect(await queueRows()).toHaveLength(0);
    const decisions = await decisionRows();
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) expect(decision).toMatchObject({ outcome: "unmatched" });
    expect(decisions[0].reason).toContain("no monitored artist is named");
  });

  it("is judged for no artist when a complete namesake of the artist is monitored too (L5), as an announce is", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    // "Pink" has every album and "P!nk" is missing three: the release names both spellings, so it names one artist for sure of neither.
    const complete = await insertArtist("Pink");
    await insertAlbum(complete, "Can't Take Me Home", "2000-04-04", { hasFile: 1 });
    const incomplete = await insertArtist("P!nk");
    for (const [title, date] of [["Funhouse", "2008-10-24"], ["The Truth About Love", "2012-09-14"], ["Beautiful Trauma", "2017-10-13"]]) await insertAlbum(incomplete, title, date);
    feed(release("Pink - Discography (2000-2019) [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect(await queueRows()).toHaveLength(0);
    expect(addDownload).not.toHaveBeenCalled();
    const [decision] = await decisionRows();
    expect(decision).toMatchObject({ outcome: "unmatched" });
    expect(decision.reason).toContain("more than one artist");
  });

  it("is judged for the one artist when the namesake is not monitored", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const complete = await insertArtist("Pink");
    await insertAlbum(complete, "Can't Take Me Home", "2000-04-04", { hasFile: 1 });
    await db.prepare("UPDATE media_items SET monitored = 0 WHERE id = ?").run(complete);
    const incomplete = await insertArtist("P!nk");
    for (const [title, date] of [["Funhouse", "2008-10-24"], ["The Truth About Love", "2012-09-14"]]) await insertAlbum(incomplete, title, date);
    feed(release("Pink - Discography (2000-2019) [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect((await queueRows()).map((r) => r.media_item_id)).toEqual([incomplete]);
  });

  it("says the artist it names has nothing missing, when it is the one monitored artist of that name", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const artistId = await insertArtist("Queen");
    await insertAlbum(artistId, "Queen", "1973-07-13", { hasFile: 1 });
    // Something else is wanted, or the sync has nothing to do at all.
    await insertAlbum(await insertArtist("Other Band"), "Record", "2000-01-01");
    feed(release(DISCOGRAPHY, { indexerId }));

    await rss.runRssSync();

    expect(await queueRows()).toHaveLength(0);
    expect(await decisionRows()).toEqual([expect.objectContaining({ outcome: "unmatched", media_item_id: artistId, reason: expect.stringContaining("has no missing album") })]);
  });

  it("does not grab it twice: a second listing of it, or another copy of it, finds the albums on their way", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { albums } = await queen();
    feed(release(DISCOGRAPHY, { indexerId }));
    await rss.runRssSync();
    expect(await queueRows()).toHaveLength(1);

    // Listed again, and listed again as an MP3 copy.
    feed(release(DISCOGRAPHY, { indexerId }), release("Queen - Discography (1973-1995) [MP3 320]", { indexerId }));
    const second = await rss.runRssSync();

    expect(second.grabbed).toBe(0);
    expect(await queueRows()).toHaveLength(1);
    expect(addDownload).toHaveBeenCalledTimes(1);
    expect(await targetsOf((await queueRows())[0].id)).toEqual([...albums].sort(byId));
    const decisions = await decisionRows();
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.outcome === "skipped" && d.reason.includes("already covers"))).toBe(true);
  });

  it("takes only the albums nothing is downloading yet", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen (1973)', 'downloading')").run(artistId, albums[0]);
    feed(release(DISCOGRAPHY, { indexerId }));

    await rss.runRssSync();

    const row = (await queueRows()).find((r) => r.sub_item_id == null)!;
    expect(await targetsOf(row.id)).toEqual(albums.slice(1).sort(byId));
  });

  it("takes the lossless discography among two, as the search does", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await queen();
    feed(release("Queen - Discography (1973-1995) [MP3 320]", { indexerId }), release("Queen - Discography (1973-1995) [FLAC]", { indexerId }));

    await rss.runRssSync();

    expect((await queueRows()).map((r) => r.title)).toEqual(["Queen - Discography (1973-1995) [FLAC]"]);
    const decisions = await decisionRows();
    expect(decisions.find((d) => d.title.includes("MP3"))!.outcome).toBe("rejected");
  });

  it("wakes the artist's discography search when a delay profile holds the release back", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId } = await queen();
    await db.prepare("INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, 600, 0, 0)").run();
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(false);
    feed(release(DISCOGRAPHY, { indexerId, publishDate: new Date().toISOString() }));

    const summary = await rss.runRssSync();

    expect(summary).toMatchObject({ grabbed: 0, woken: 1 });
    expect(await queueRows()).toHaveLength(0);
    expect((await decisionRows())[0].outcome).toBe("held");
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(true);
  });

  it("keeps a discography the delay profile holds against its artist, and grabs it as a discography once the delay has ended (L6)", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, 600, 0, 0)").run();
    feed(release(DISCOGRAPHY, { indexerId, publishDate: new Date().toISOString() }));

    await rss.runRssSync();

    const held = (await db.prepare("SELECT * FROM pending_releases").all()) as any[];
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ media_item_id: artistId, leaf_table: "media_items" });
    expect(Number(held[0].leaf_id)).toBe(artistId);
    expect(JSON.parse(held[0].release).title).toBe(DISCOGRAPHY);
    expect(await queueRows()).toHaveLength(0);

    // Inside its delay it waits.
    expect(await pendingJob.runPendingReleases()).toEqual({ checked: 1, grabbed: 0 });
    expect(await queueRows()).toHaveLength(0);

    // The delay ends: the release is judged again as a discography and queued for the albums it adds.
    const stored = JSON.parse(held[0].release);
    await db.prepare("UPDATE pending_releases SET release = ? WHERE id = ?").run(JSON.stringify({ ...stored, publishDate: "2020-01-01T00:00:00Z" }), held[0].id);
    expect(await pendingJob.runPendingReleases()).toEqual({ checked: 1, grabbed: 1 });
    const [row] = await queueRows();
    expect(row).toMatchObject({ media_item_id: artistId, sub_item_id: null, episode_id: null, title: DISCOGRAPHY });
    expect(await targetsOf(row.id)).toEqual([...albums].sort(byId));
    expect(addDownload).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT id FROM pending_releases").all()).toHaveLength(0);
  });

  it("drops a held discography whose albums were taken meanwhile, and when discography grabs are switched off", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, 600, 0, 0)").run();
    const keep = async () => {
      await db.prepare("DELETE FROM pending_releases").run();
      await db
        .prepare("INSERT INTO pending_releases (media_item_id, leaf_table, leaf_id, release, pending_key) VALUES (?, 'media_items', ?, ?, ?)")
        .run(artistId, artistId, JSON.stringify(release(DISCOGRAPHY, { indexerId, publishDate: "2020-01-01T00:00:00Z" })), `media_items:${artistId}:${Math.random()}`);
    };

    await keep();
    for (const id of albums) await db.prepare("UPDATE sub_items SET has_file = 1 WHERE id = ?").run(id);
    expect(await pendingJob.runPendingReleases()).toEqual({ checked: 1, grabbed: 0 });
    expect(await db.prepare("SELECT id FROM pending_releases").all()).toHaveLength(0);
    expect(await queueRows()).toHaveLength(0);

    await db.prepare("UPDATE sub_items SET has_file = 0").run();
    settings.setSetting("discographyGrabs", "0");
    await keep();
    expect(await pendingJob.runPendingReleases()).toEqual({ checked: 1, grabbed: 0 });
    expect(await db.prepare("SELECT id FROM pending_releases").all()).toHaveLength(0);
    expect(await queueRows()).toHaveLength(0);
  });

  it("resets the discography search's wait when it grabs one", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId } = await queen();
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    feed(release(DISCOGRAPHY, { indexerId }));

    await rss.runRssSync();

    const row = (await db.prepare("SELECT misses FROM season_searches WHERE media_item_id = ? AND season_number = ?").get(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)) as any;
    expect(Number(row.misses)).toBe(0);
  });
});

describe("a pushed release (POST /release/push)", () => {
  const lidarr = (body: unknown) => request(app).post("/lidarr/api/v1/release/push").set("X-Api-Key", apiKey).send(body as object);
  const push = (over: Record<string, unknown> = {}) => ({
    title: DISCOGRAPHY,
    downloadUrl: "https://tracker.example/dl/discography.torrent",
    protocol: "Torrent",
    publishDate: "2020-01-01T00:00:00Z",
    size: 3_000_000_000,
    indexer: "Tracker",
    ...over,
  });

  it("is a discography of the artist it names: grabbed for the albums it adds", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId, albums } = await queen();

    const res = await lidarr(push());

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: true, rejected: false, mappedArtistId: artistId });
    const [row] = await queueRows();
    expect(row).toMatchObject({ media_item_id: artistId, sub_item_id: null, grab_source: "push", title: DISCOGRAPHY });
    expect(await targetsOf(row.id)).toEqual([...albums].sort(byId));
    expect((await decisionRows())[0]).toMatchObject({ outcome: "grabbed" });
  });

  it("answers why it was not taken for one missing album, and takes nothing", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId } = await queenMissingOne();

    const res = await lidarr(push());

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true, mappedArtistId: artistId });
    expect(JSON.stringify(res.body[0].rejections)).toContain("only 1 missing album");
    expect(await queueRows()).toHaveLength(0);
  });

  it("is not taken a second time, and is refused when the setting is off", async () => {
    await insertClient();
    await insertIndexer();
    await queen();

    expect((await lidarr(push())).body[0].approved).toBe(true);
    const again = await lidarr(push({ downloadUrl: "https://tracker.example/dl/discography-2.torrent" }));
    expect(again.body[0].approved).toBe(false);
    expect(JSON.stringify(again.body[0].rejections)).toContain("already covers");
    expect(await queueRows()).toHaveLength(1);

    await db.prepare("DELETE FROM queue").run();
    settings.setSetting("discographyGrabs", "0");
    const off = await lidarr(push({ downloadUrl: "https://tracker.example/dl/discography-3.torrent" }));
    expect(off.body[0].approved).toBe(false);
    expect(await queueRows()).toHaveLength(0);
  });

  it("is judged for no artist when a complete namesake is monitored too (L5)", async () => {
    await insertClient();
    await insertIndexer();
    const complete = await insertArtist("Pink");
    await insertAlbum(complete, "Can't Take Me Home", "2000-04-04", { hasFile: 1 });
    const incomplete = await insertArtist("P!nk");
    await insertAlbum(incomplete, "Funhouse", "2008-10-24");
    await insertAlbum(incomplete, "The Truth About Love", "2012-09-14");

    const res = await lidarr(push({ title: "Pink - Discography (2008-2012) [FLAC]" }));

    expect(res.body[0]).toMatchObject({ approved: false });
    expect(JSON.stringify(res.body[0].rejections)).toContain("more than one artist");
    expect(await queueRows()).toHaveLength(0);
  });

  it("names an artist whose spelling only the discography matcher reads (P!nk as Pink)", async () => {
    await insertClient();
    await insertIndexer();
    const artistId = await insertArtist("P!nk");
    await insertAlbum(artistId, "Funhouse", "2008-10-24");
    await insertAlbum(artistId, "The Truth About Love", "2012-09-14");

    const res = await lidarr(push({ title: "Pink - Discography (2008-2012) [FLAC]" }));

    expect(res.body[0]).toMatchObject({ approved: true, mappedArtistId: artistId });
  });
});

describe("an IRC announce of a discography", () => {
  const FEED = { id: 1, name: "TestFeed", announce_regex: "(?<title>.+?) - (?<url>https?://\\S+)", protocol: "torrent" as const };
  const announce = (title: string, url = "https://example.com/dl/1") => irc.handleAnnounce(FEED, `${title} - ${url}`);

  it("is grabbed for the albums it adds, as an IRC grab", async () => {
    await insertClient();
    const { artistId, albums } = await queen();

    await announce(DISCOGRAPHY);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ media_item_id: artistId, sub_item_id: null, title: DISCOGRAPHY, grab_source: "irc" });
    expect(await targetsOf(rows[0].id)).toEqual([...albums].sort(byId));
    expect(addDownload).toHaveBeenCalledTimes(1);
  });

  it("is not grabbed for one missing album, another artist, or an album that is not out yet", async () => {
    await insertClient();
    const { artistId } = await queenMissingOne();
    await announce(DISCOGRAPHY);
    expect(await queueRows()).toHaveLength(0);

    await db.prepare("UPDATE sub_items SET has_file = 0").run();
    await announce("Queen Latifah - Discography (1973-1995) [FLAC]", "https://example.com/dl/2");
    expect(await queueRows()).toHaveLength(0);

    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    await announce("Queen - Discography [FLAC]", "https://example.com/dl/3");
    expect(await queueRows()).toHaveLength(0);
    expect(addDownload).not.toHaveBeenCalled();
  });

  it("is not grabbed when the setting is off, or when the release is blocklisted", async () => {
    await insertClient();
    const { artistId } = await queen();
    settings.setSetting("discographyGrabs", "0");
    await announce(DISCOGRAPHY);
    expect(await queueRows()).toHaveLength(0);

    settings.setSetting("discographyGrabs", "");
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(artistId, DISCOGRAPHY);
    await announce(DISCOGRAPHY);
    expect(await queueRows()).toHaveLength(0);
  });

  it("is not grabbed twice, whichever copy of it is announced", async () => {
    await insertClient();
    await queen();

    await announce(DISCOGRAPHY, "https://example.com/dl/1");
    await announce("Queen - Discography (1973-1995) [MP3 320]", "https://example.com/dl/2");
    await announce(DISCOGRAPHY, "https://example.com/dl/3");

    expect(await queueRows()).toHaveLength(1);
    expect(addDownload).toHaveBeenCalledTimes(1);
  });

  it("is held back by a delay profile, and wakes the artist's discography search", async () => {
    await insertClient();
    const { artistId } = await queen();
    await db.prepare("INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, 600, 0, 0)").run();
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);
    await backoff.recordSeasonSearch(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY, false);

    await announce(DISCOGRAPHY);

    expect(await queueRows()).toHaveLength(0);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(true);
  });

  it("is not grabbed when a complete namesake is monitored too (L5): the feed and the announce agree", async () => {
    await insertClient();
    const complete = await insertArtist("Pink");
    await insertAlbum(complete, "Can't Take Me Home", "2000-04-04", { hasFile: 1 });
    const incomplete = await insertArtist("P!nk");
    await insertAlbum(incomplete, "Funhouse", "2008-10-24");
    await insertAlbum(incomplete, "The Truth About Love", "2012-09-14");

    await announce("Pink - Discography (2008-2012) [FLAC]");

    expect(await queueRows()).toHaveLength(0);
  });

  it("is not mistaken for a film of the same name", async () => {
    await insertClient();
    const { artistId } = await queen();
    await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie', 'Queen', 'queen', 1973, 1, 0, 'missing')").run();

    await announce(DISCOGRAPHY);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].media_item_id).toBe(artistId);
  });
});

describe("the fallback for one missing album", () => {
  const discographyAnswer = () => answers((query) => (isDiscographyQuery(query) ? [release(DISCOGRAPHY)] : []));

  it("is off until it is switched on: the album's own search is all there is", async () => {
    await insertClient();
    await insertIndexer();
    await queenMissingOne();
    discographyAnswer();

    await scheduler.runAutoSearch();

    expect(queriesAsked()).toHaveLength(1);
    expect(discographyQueries()).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("looks for a discography once the album's search found nothing, and takes it for the one album", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId, missing } = await queenMissingOne();
    settings.setSetting("discographyFallbackSingle", "1");
    discographyAnswer();

    await scheduler.runAutoSearch();

    // The album's own search comes first, then the discography is asked for once.
    expect(isDiscographyQuery(queriesAsked()[0])).toBe(false);
    expect(discographyQueries()).toEqual(["Queen discography"]);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ media_item_id: artistId, sub_item_id: null, title: DISCOGRAPHY, grab_source: "auto" });
    expect(await targetsOf(rows[0].id)).toEqual([missing]);
    // The album counts as found, so its own search does not wait.
    expect(Number(((await db.prepare("SELECT auto_search_misses FROM sub_items WHERE id = ?").get(missing)) as any).auto_search_misses)).toBe(0);
  });

  // The fallback takes a discography for ONE album, so a release that covers a library of dozens is not the download for it: the
  // folders of the albums it did not need stay in the download (M4).
  describe("the most albums it takes a discography for", () => {
    async function artistWithOwned(owned: number): Promise<number> {
      const artistId = await insertArtist("Queen");
      const missing = await insertAlbum(artistId, "A Night at the Opera", "1975-11-21");
      for (let i = 0; i < owned; i++) await insertAlbum(artistId, `Owned ${i}`, `${1976 + i}-01-01`, { hasFile: 1 });
      return missing;
    }

    it("refuses a discography that covers more than fifteen albums", async () => {
      await insertClient();
      await insertIndexer();
      await artistWithOwned(15);
      settings.setSetting("discographyFallbackSingle", "1");
      discographyAnswer();

      await scheduler.runAutoSearch();

      expect(discographyQueries()).toEqual(["Queen discography"]);
      expect(await queueRows()).toHaveLength(0);
      expect(addDownload).not.toHaveBeenCalled();
    });

    it("takes one that covers fifteen", async () => {
      await insertClient();
      await insertIndexer();
      const missing = await artistWithOwned(14);
      settings.setSetting("discographyFallbackSingle", "1");
      discographyAnswer();

      await scheduler.runAutoSearch();

      const rows = await queueRows();
      expect(rows).toHaveLength(1);
      expect(await targetsOf(rows[0].id)).toEqual([missing]);
    });

    it("counts only the albums the years of the release span", async () => {
      await insertClient();
      await insertIndexer();
      const missing = await artistWithOwned(20);
      settings.setSetting("discographyFallbackSingle", "1");
      // 1975-1980 holds six of the twenty-one albums.
      answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1975-1980) [FLAC]")] : []));

      await scheduler.runAutoSearch();

      const rows = await queueRows();
      expect(rows).toHaveLength(1);
      expect(await targetsOf(rows[0].id)).toEqual([missing]);
    });
  });

  it("still takes the album's own release when it has one, and does not look for a discography", async () => {
    await insertClient();
    await insertIndexer();
    const { missing } = await queenMissingOne();
    settings.setSetting("discographyFallbackSingle", "1");
    answers((query) => (isDiscographyQuery(query) ? [release(DISCOGRAPHY)] : [release("Queen - A Night at the Opera (1975) [FLAC]")]));

    await scheduler.runAutoSearch();

    expect(discographyQueries()).toEqual([]);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sub_item_id).toBe(missing);
    expect(rows[0].title).toBe("Queen - A Night at the Opera (1975) [FLAC]");
  });

  it("never takes a discography that would include an album that is not out yet", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId } = await queenMissingOne();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    settings.setSetting("discographyFallbackSingle", "1");
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography [FLAC]")] : []));

    await scheduler.runAutoSearch();

    expect(discographyQueries()).toEqual(["Queen discography"]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("takes a discography whose years stop before the album that is not out yet", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId } = await queenMissingOne();
    await insertAlbum(artistId, "The Next Record", "2999-01-01");
    settings.setSetting("discographyFallbackSingle", "1");
    discographyAnswer();

    await scheduler.runAutoSearch();

    expect(await queueRows()).toHaveLength(1);
  });

  it("takes only a discography that covers the album", async () => {
    await insertClient();
    await insertIndexer();
    await queenMissingOne();
    settings.setSetting("discographyFallbackSingle", "1");
    // 1990-1995 holds Innuendo (in the library) but not A Night at the Opera (1975).
    answers((query) => (isDiscographyQuery(query) ? [release("Queen - Discography (1990-1995) [FLAC]")] : []));

    await scheduler.runAutoSearch();

    expect(discographyQueries()).toEqual(["Queen discography"]);
    expect(await queueRows()).toHaveLength(0);
  });

  it("looks only once per wait of the discography's backoff", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId, missing } = await queenMissingOne();
    settings.setSetting("discographyFallbackSingle", "1");
    answers(() => []);
    const wakeAlbum = async () => {
      await db.prepare("UPDATE sub_items SET auto_search_misses = 0, last_auto_searched_at = NULL WHERE id = ?").run(missing);
    };

    await scheduler.runAutoSearch();
    await wakeAlbum();
    await scheduler.runAutoSearch();
    expect(discographyQueries()).toHaveLength(2);
    expect(await backoff.seasonSearchDue(artistId, scheduler.DISCOGRAPHY_SEARCH_KEY)).toBe(false);

    // The album itself is due again, the artist's discography is not.
    searchAllIndexers.mockClear();
    await wakeAlbum();
    await scheduler.runAutoSearch();
    expect(queriesAsked()).toHaveLength(1);
    expect(discographyQueries()).toEqual([]);

    // The backoff starting over (an indexer was added) lets it look again.
    searchAllIndexers.mockClear();
    await backoff.resetSearchBackoff(artistId);
    await scheduler.runAutoSearch();
    expect(discographyQueries()).toHaveLength(1);
  });

  it("does not look again for an artist whose discography the cycle just searched for", async () => {
    await insertClient();
    await insertIndexer();
    await queen();
    settings.setSetting("discographyFallbackSingle", "1");
    answers(() => []);

    await scheduler.runAutoSearch();

    // Four albums are missing: the discography search before the albums is the one search, not one per album.
    expect(discographyQueries()).toEqual(["Queen discography"]);
    expect(queriesAsked()).toHaveLength(5);
  });

  it("does nothing when discography grabs are off, and leaves the admin's own search as it was", async () => {
    await insertClient();
    await insertIndexer();
    const { artistId, missing } = await queenMissingOne();
    settings.setSetting("discographyFallbackSingle", "1");
    discographyAnswer();

    settings.setSetting("discographyGrabs", "0");
    await scheduler.runAutoSearch();
    expect(discographyQueries()).toEqual([]);

    settings.setSetting("discographyGrabs", "");
    searchAllIndexers.mockClear();
    const [result] = await scheduler.searchAndGrabTargets([{ mediaItemId: artistId, subItemId: missing }]);
    expect(result.grabbed).toBe(false);
    expect(discographyQueries()).toEqual([]);
    expect(await queueRows()).toHaveLength(0);
  });
});

describe("one notification for a whole discography", () => {
  it("tells of a grab once, naming the artist and how many albums, with the artist for the tag filter", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId } = await queen();
    feed(release(DISCOGRAPHY, { indexerId }));

    await rss.runRssSync();

    expect(notifyGrabbed).toHaveBeenCalledTimes(1);
    const [title, releaseTitle, context] = notifyGrabbed.mock.calls[0];
    expect(title).toBe("Queen - Discography: 4 albums");
    expect(releaseTitle).toBe(DISCOGRAPHY);
    expect(context).toMatchObject({ mediaItemId: artistId, release: { title: DISCOGRAPHY } });
  });

  it("counts only the albums the grab is for", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const { artistId, albums } = await queen();
    await db.prepare("INSERT INTO queue (media_item_id, sub_item_id, title, status) VALUES (?, ?, 'Queen - Queen (1973)', 'downloading')").run(artistId, albums[0]);
    feed(release(DISCOGRAPHY, { indexerId }));

    await rss.runRssSync();

    expect(notifyGrabbed.mock.calls[0][0]).toBe("Queen - Discography: 3 albums");
  });

  it("tells of the grab of a single album as before", async () => {
    await insertClient();
    const { artistId, missing } = await queenMissingOne();
    const item = (await import("../src/db/mappers.js")).mediaItemFromRow(await db.prepare("SELECT * FROM media_items WHERE id = ?").get(artistId)) as any;
    const client = (await import("../src/db/mappers.js")).downloadClientFromRow(await db.prepare("SELECT * FROM download_clients LIMIT 1").get()) as any;

    await scheduler.grab(client, item, null, missing, { result: release("Queen - A Night at the Opera (1975) [FLAC]") as any, quality: "Unknown" });

    expect(notifyGrabbed).toHaveBeenCalledTimes(1);
    expect(notifyGrabbed.mock.calls[0][0]).toBe("Queen");
    expect(notifyGrabbed.mock.calls[0][1]).toBe("Queen - A Night at the Opera (1975) [FLAC]");
  });

  describe("on import", () => {
    let downloadsDir: string;
    let libraryDir: string;
    let rootFolder: { id: number; path: string };
    const RELEASE = "Queen - Discography (1973-1995) [FLAC]";

    beforeEach(async () => {
      downloadsDir = path.join(config.downloadsDir, "test-discography-feeds");
      fs.rmSync(downloadsDir, { recursive: true, force: true });
      fs.mkdirSync(downloadsDir, { recursive: true });
      libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-discography-feeds-"));
      settings.setSetting("skipFreeSpaceCheck", "1");
      settings.setSetting("removeCompletedDownloads", "0");
      settings.setSetting("writeAudioTagsOnImport", "0");
      settings.setSetting("setPermissionsEnabled", "0");
      settings.setSetting("importStrategy", "move");
      settings.setSetting("recycleBinEnabled", "1");
      settings.setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
      const p = path.join(libraryDir, "artist");
      fs.mkdirSync(p, { recursive: true });
      // A library that has files recorded in it holds something: an empty root would read as a share that is not mounted.
      fs.writeFileSync(path.join(p, ".library-in-use"), "");
      rootFolder = { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'artist')").run(p)).lastInsertRowid), path: p };
    });

    afterEach(() => {
      fs.rmSync(libraryDir, { recursive: true, force: true });
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    });

    function writeTracks(release: string, folder: string, names: string[]): void {
      for (const name of names) {
        const file = path.join(downloadsDir, release, folder, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `audio ${folder} ${name}`);
      }
    }

    async function libraryQueen(): Promise<{ artistId: number; albums: Record<string, number> }> {
      const artistId = Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', ?, 1, 0, 'missing')")
            .run(rootFolder.id)
        ).lastInsertRowid
      );
      return {
        artistId,
        albums: {
          queen: await insertAlbum(artistId, "Queen", "1973-07-13"),
          queen2: await insertAlbum(artistId, "Queen II", "1974-03-08"),
          sheer: await insertAlbum(artistId, "Sheer Heart Attack", "1974-11-08"),
          innuendo: await insertAlbum(artistId, "Innuendo", "1991-02-04"),
        },
      };
    }

    async function queueDiscography(artistId: number, targets: number[]): Promise<number> {
      const queueId = Number(
        (
          await db
            .prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source) VALUES (?, ?, ?, NULL, 'completed', 'auto')")
            .run(artistId, RELEASE, path.join(downloadsDir, RELEASE))
        ).lastInsertRowid
      );
      for (const id of targets) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, id);
      return queueId;
    }

    it("tells of the import once for all its albums, keeping a history row for each", async () => {
      const { artistId, albums } = await libraryQueen();
      writeTracks(RELEASE, "1973 - Queen [FLAC]", ["01 - Keep Yourself Alive.flac", "02 - Doing All Right.flac"]);
      writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac", "02 - Father to Son.flac"]);
      writeTracks(RELEASE, "1991 - Innuendo (Remastered)", ["01 - Innuendo.flac"]);
      const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2, albums.innuendo]);

      await importer.importQueueItem(queueId);

      expect(notifyImported).toHaveBeenCalledTimes(1);
      const [title, text, filePath, context] = notifyImported.mock.calls[0];
      expect(title).toBe("Queen - Discography: 3 albums");
      expect(text).toBe("imported 3 of 3 albums");
      expect(String(filePath).startsWith(rootFolder.path)).toBe(true);
      expect(context).toEqual({ mediaItemId: artistId });
      const imported = (await db.prepare("SELECT data FROM history WHERE event_type = 'imported'").all()) as any[];
      expect(imported.map((h) => JSON.parse(h.data).subItemId).sort(byId)).toEqual([albums.queen, albums.queen2, albums.innuendo].sort(byId));
    });

    it("says what is left when the release did not hold every album", async () => {
      const { artistId, albums } = await libraryQueen();
      writeTracks(RELEASE, "1973 - Queen [FLAC]", ["01 - Keep Yourself Alive.flac"]);
      writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
      const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2, albums.sheer, albums.innuendo]);

      await importer.importQueueItem(queueId);

      expect(notifyImported).toHaveBeenCalledTimes(1);
      const [title, text] = notifyImported.mock.calls[0];
      expect(title).toBe("Queen - Discography: 4 albums");
      expect(text).toBe("imported 2 of 4 albums, 2 left: Sheer Heart Attack, Innuendo");
    });

    it("tells once for a manual import of one album of it, and what is left", async () => {
      const { artistId, albums } = await libraryQueen();
      writeTracks(RELEASE, "1973 - Queen [FLAC]", ["01 - Keep Yourself Alive.flac"]);
      writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
      const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

      await importer.importQueueItem(queueId, path.join(downloadsDir, RELEASE, "1974 - Queen II", "01 - Procession.flac"));

      expect(notifyImported).toHaveBeenCalledTimes(1);
      expect(notifyImported.mock.calls[0][1]).toBe("imported 1 of 2 albums, 1 left: Queen");
    });

    it("sends nothing when no album went in", async () => {
      const { artistId, albums } = await libraryQueen();
      writeTracks(RELEASE, "Some Other Band - Record", ["01 - Song.flac"]);
      const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

      await importer.importQueueItem(queueId).catch(() => undefined);

      expect(notifyImported).not.toHaveBeenCalled();
    });

    it("still tells of every album of a plain album download", async () => {
      const { artistId, albums } = await libraryQueen();
      const album = "Queen - Queen II (1974) [FLAC]";
      writeTracks(album, "", ["01 - Procession.flac", "02 - Father to Son.flac"]);
      const queueId = Number(
        (
          await db
            .prepare("INSERT INTO queue (media_item_id, sub_item_id, title, download_path, quality, status, grab_source) VALUES (?, ?, ?, ?, NULL, 'completed', 'auto')")
            .run(artistId, albums.queen2, album, path.join(downloadsDir, album))
        ).lastInsertRowid
      );

      await importer.importQueueItem(queueId);

      expect(notifyImported).toHaveBeenCalledTimes(1);
      const [title, text, , context] = notifyImported.mock.calls[0];
      expect(title).toBe("Queen");
      expect(text).toMatch(/^2 file\(s\) into /);
      expect(context).toEqual({ mediaItemId: artistId });
    });
  });
});
