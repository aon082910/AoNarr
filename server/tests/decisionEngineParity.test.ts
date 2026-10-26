import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let sched: typeof import("../src/services/scheduler.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let quality: typeof import("../src/services/quality.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  sched = await import("../src/services/scheduler.js");
  quality = await import("../src/services/quality.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  await quality.loadQualityCaches();
});

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

let counter = 0;
function release(over: Record<string, unknown> = {}): any {
  counter++;
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title: `Some.Movie.2020.1080p.WEB-DL.x264-GRP${counter}`,
    size: 5_000_000_000,
    seeders: 100,
    leechers: 10,
    publishDate: ago(10_000),
    downloadUrl: `magnet:?xt=urn:btih:${counter}`,
    protocol: "torrent",
    category: null,
    ...over,
  };
}
const nzb = (over: Record<string, unknown> = {}) => release({ protocol: "usenet", seeders: null, leechers: null, downloadUrl: "https://indexer/nzb", ...over });

async function insertItem(type: string, over: { title?: string; runtime?: number | null; rootFolderId?: number | null } = {}): Promise<number> {
  const title = over.title ?? `Parity ${type} ${++counter}`;
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, runtime_minutes, root_folder_id) VALUES (?, ?, ?, 1, 0, 'unknown', ?, ?)")
        .run(type, title, title.toLowerCase(), over.runtime ?? null, over.rootFolderId ?? null)
    ).lastInsertRowid
  );
}

describe("the blocklist matches the release, not just its name (D13)", () => {
  let match: typeof import("../src/services/blocklistMatch.js");
  beforeAll(async () => {
    match = await import("../src/services/blocklistMatch.js");
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    releaseTitle: "Movie.2020.1080p.WEB-DL-GRP",
    protocol: null,
    indexerId: null,
    size: null,
    publishDate: null,
    infoHash: null,
    ...over,
  });
  const result = (over: Record<string, unknown> = {}): any => release({ title: "Movie.2020.1080p.WEB-DL-GRP", ...over });

  it("a failed torrent does not block the healthy NZB of the same name", () => {
    const blocked = entry({ protocol: "torrent", indexerId: 1 });
    expect(match.entryBlocksResult(blocked, result({ indexerId: 1 }))).toBe(true);
    expect(match.entryBlocksResult(blocked, nzb({ title: "Movie.2020.1080p.WEB-DL-GRP", indexerId: 1 }))).toBe(false);
  });

  it("ignores case in the title", () => {
    expect(match.entryBlocksResult(entry({ protocol: "torrent" }), result({ title: "movie.2020.1080p.web-dl-grp" }))).toBe(true);
  });

  it("matches a torrent by its info hash when both sides have one, whatever the name", () => {
    const blocked = entry({ protocol: "torrent", infoHash: "ABCDEF" });
    expect(match.entryBlocksResult(blocked, result({ title: "Movie 2020 1080p WEB-DL GRP", infoHash: "abcdef" }))).toBe(true);
    expect(match.entryBlocksResult(blocked, result({ infoHash: "123456" }))).toBe(false);
  });

  it("without a hash, a torrent of the same name on another indexer is another release", () => {
    const blocked = entry({ protocol: "torrent", indexerId: 1 });
    expect(match.entryBlocksResult(blocked, result({ indexerId: 2 }))).toBe(false);
    expect(match.entryBlocksResult(blocked, result({ indexerId: null }))).toBe(true);
  });

  it("matches a usenet post by name and publish date, or by size when a side has no date", () => {
    const date = "2026-10-01T10:00:00.000Z";
    const blocked = entry({ protocol: "usenet", publishDate: date, size: 4_000_000_000 });
    const same = nzb({ title: "Movie.2020.1080p.WEB-DL-GRP", publishDate: date, size: 4_000_000_000 });
    expect(match.entryBlocksResult(blocked, same)).toBe(true);
    expect(match.entryBlocksResult(blocked, { ...same, publishDate: "2026-10-02T10:00:00.000Z" })).toBe(false);
    const noDate = entry({ protocol: "usenet", size: 4_000_000_000 });
    expect(match.entryBlocksResult(noDate, { ...same, publishDate: null, size: 5_000_000_000 })).toBe(false);
    expect(match.entryBlocksResult(noDate, { ...same, publishDate: null })).toBe(true);
  });

  it("a row from before the details were kept blocks a result of that name on any protocol", () => {
    const legacy = entry();
    expect(match.entryBlocksResult(legacy, result())).toBe(true);
    expect(match.entryBlocksResult(legacy, nzb({ title: "Movie.2020.1080p.WEB-DL-GRP" }))).toBe(true);
  });

  it("a plain Set of titles still blocks by exact title", () => {
    expect(match.isBlockedRelease(new Set(["Movie.2020.1080p.WEB-DL-GRP"]), result())).toBe(true);
    expect(match.isBlockedRelease(new Set(["movie.2020.1080p.web-dl-grp"]), result())).toBe(false);
  });

  it("keeps what a Remove-and-Blocklist knew about the release and uses it in a search", async () => {
    const { addToBlocklist, getBlocklistedTitles } = await import("../src/services/blocklist.js");
    const itemId = await insertItem("movie");
    await addToBlocklist({
      mediaItemId: itemId,
      releaseTitle: "Stalled.Movie.2020.1080p.WEB-DL.x264-GRP",
      reason: "stalled",
      protocol: "torrent",
      size: 5_000_000_000,
      infoHash: "deadbeef",
    });
    const blocklist = await getBlocklistedTitles(itemId);
    const torrent = release({ title: "Stalled.Movie.2020.1080p.WEB-DL.x264-GRP" });
    const healthyNzb = nzb({ title: "Stalled.Movie.2020.1080p.WEB-DL.x264-GRP" });
    const best = await sched.chooseBestResult([torrent, healthyNzb], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, blocklist, "movie", null, null, itemId);
    expect(best?.result).toBe(healthyNzb);
  });

  it("the blocklist route stores the details it is given", async () => {
    const itemId = await insertItem("movie");
    const res = await request(app)
      .post("/api/blocklist")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemId: itemId, releaseTitle: "Route.Release", protocol: "usenet", size: 1234567, publishDate: "2026-10-01T00:00:00Z", infoHash: null });
    expect(res.status).toBe(201);
    const row = (await db.prepare("SELECT * FROM blocklist WHERE id = ?").get(res.body.id)) as any;
    expect(row).toMatchObject({ protocol: "usenet", publish_date: "2026-10-01T00:00:00Z" });
    expect(Number(row.size)).toBe(1234567);
  });
});

describe("size limits per minute (D9)", () => {
  let runtime: typeof import("../src/services/releaseRuntime.js");
  beforeAll(async () => {
    runtime = await import("../src/services/releaseRuntime.js");
  });
  afterEach(async () => {
    setSetting("sizeLimitMode", "absolute");
    await db.prepare("UPDATE qualities SET max_size_mb = NULL, min_size_mb = NULL, preferred_size_mb = NULL").run();
    await quality.loadQualityCaches();
  });

  async function setMax(maxMb: number) {
    await db.prepare("UPDATE qualities SET max_size_mb = ? WHERE name = 'WEBDL-1080p'").run(maxMb);
    await quality.loadQualityCaches();
  }

  it("reads the runtime of what a release holds, with Sonarr/Radarr defaults", () => {
    const film = { isFullSeason: false, seasonNumber: null, episodeNumbers: null, episodeRange: null };
    expect(runtime.releaseRuntimeMinutes(film, { runtimeMinutes: 142, episodic: false })).toBe(142);
    expect(runtime.releaseRuntimeMinutes(film, { runtimeMinutes: null, episodic: false })).toBe(110);
    const ctx = { runtimeMinutes: 40, episodic: true, seasonEpisodeCount: () => 8 };
    expect(runtime.releaseRuntimeMinutes({ ...film, seasonNumber: 1, episodeNumbers: [3] }, ctx)).toBe(40);
    expect(runtime.releaseRuntimeMinutes({ ...film, seasonNumber: 1, episodeNumbers: [3, 4] }, ctx)).toBe(80);
    expect(runtime.releaseRuntimeMinutes({ ...film, seasonNumber: 1, isFullSeason: true }, ctx)).toBe(320);
    expect(runtime.releaseRuntimeMinutes({ ...film, seasonNumber: 1, isFullSeason: true, episodeRange: [1, 4] }, ctx)).toBe(160);
    expect(runtime.releaseRuntimeMinutes({ ...film, seasonNumber: 1, episodeNumbers: [1] }, { runtimeMinutes: null, episodic: true })).toBe(45);
  });

  it("absolute mode (the default) reads the limits as megabytes, whatever the runtime", async () => {
    await setMax(4000);
    const movieId = await insertItem("movie", { runtime: 150 });
    const big = release({ size: 8_000_000_000 });
    const small = release({ size: 3_900_000_000 });
    const pick = (r: any) => sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, movieId);
    expect(await pick(big)).toBeNull();
    expect((await pick(small))?.result).toBe(small);
  });

  it("per-minute mode accepts a long film an absolute limit would refuse", async () => {
    setSetting("sizeLimitMode", "perMinute");
    await setMax(40); // 40 MB per minute
    const movieId = await insertItem("movie", { runtime: 150 }); // 6,000 MB allowed
    const fits = release({ size: 5_900_000_000 });
    const tooBig = release({ size: 7_000_000_000 });
    const pick = (r: any) => sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, movieId);
    expect((await pick(fits))?.result).toBe(fits);
    expect(await pick(tooBig)).toBeNull();
  });

  it("per-minute mode judges a season pack by every episode it holds", async () => {
    setSetting("sizeLimitMode", "perMinute");
    await setMax(40);
    const showId = await insertItem("series", { runtime: 45 });
    for (let n = 1; n <= 10; n++) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, ?, 1, 0)").run(showId, n);
    }
    // 1.5 GB per 45-minute episode is 33 MB per minute: fine as a pack of ten (15 GB), too big as one 3 GB episode.
    const pack = release({ title: "Some.Show.S01.1080p.WEB-DL.x264-GRP", size: 15_000_000_000 });
    const bloatedEpisode = release({ title: "Some.Show.S01E02.1080p.WEB-DL.x264-GRP", size: 3_000_000_000 });
    const pick = (r: any) => sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "series", null, null, showId);
    expect((await pick(pack))?.result).toBe(pack);
    expect(await pick(bloatedEpisode)).toBeNull();
  });

  it("bounds are untouched by the mode when no runtime is given", () => {
    expect(quality.sizeWithinQualityBounds("WEBDL-1080p", 5_000_000_000)).toBe(true);
    expect(quality.sizeWithinQualityBounds("WEBDL-1080p", 5_000_000_000, 100)).toBe(true);
  });
});

describe("free space at grab time (D18)", () => {
  let freeSpace: typeof import("../src/services/freeSpace.js");
  beforeAll(async () => {
    freeSpace = await import("../src/services/freeSpace.js");
  });
  afterEach(() => {
    setSetting("grabFreeSpaceCheck", "1");
    setSetting("minimumFreeSpaceMb", "100");
    freeSpace.clearFreeSpaceCache();
  });

  it("refuses a release that would leave less than the reserve", () => {
    expect(freeSpace.exceedsFreeSpace(50e9, 40e9, 100e6)).toBe(true);
    expect(freeSpace.exceedsFreeSpace(30e9, 40e9, 100e6)).toBe(false);
    expect(freeSpace.exceedsFreeSpace(39.95e9, 40e9, 100e6)).toBe(true);
    expect(freeSpace.exceedsFreeSpace(null, 40e9, 100e6)).toBe(false);
    expect(freeSpace.exceedsFreeSpace(50e9, null, 100e6)).toBe(false);
  });

  async function itemOnRealFolder(): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-space-"));
    const folder = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(dir)).lastInsertRowid);
    return insertItem("movie", { rootFolderId: folder });
  }

  it("rejects a release when the folder cannot hold it, and takes it when the reserve is small enough", async () => {
    const itemId = await itemOnRealFolder();
    const r = release({ size: 2_000_000_000 });
    const pick = () => sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, itemId);
    expect((await pick())?.result).toBe(r);
    setSetting("minimumFreeSpaceMb", String(1e12)); // a reserve of a petabyte can never be met
    expect(await pick()).toBeNull();
  });

  it("can be switched off", async () => {
    const itemId = await itemOnRealFolder();
    const r = release({ size: 2_000_000_000 });
    setSetting("minimumFreeSpaceMb", String(1e12));
    setSetting("grabFreeSpaceCheck", "0");
    expect((await sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, itemId))?.result).toBe(r);
  });

  it("does not judge an item with no root folder", async () => {
    const itemId = await insertItem("movie");
    setSetting("minimumFreeSpaceMb", String(1e12));
    const r = release({ size: 2_000_000_000 });
    expect((await sched.chooseBestResult([r], ["WEBDL-1080p"], "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, itemId))?.result).toBe(r);
  });
});
