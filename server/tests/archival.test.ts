import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

// getMediaServerConfig is left real (driven by real settings below, already thoroughly covered by
// mediaServer.test.ts) -- only fetchWatchedFiles is replaced, so archival.ts never needs a real
// media server to test its own matching/retention/archive-or-delete logic against.
const fetchWatchedFiles = vi.fn();
vi.mock("../src/services/mediaServer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/mediaServer.js")>();
  return { ...actual, fetchWatchedFiles: (...args: unknown[]) => fetchWatchedFiles(...args) };
});

// recycleBin.ts has its own dedicated test file covering its real recycle-vs-permanent-delete
// mechanics; mocked here so runAutoArchival's own dispatch to it (permanentDelete=1) is what's
// under test, not recycleBin's internals.
const recycleFile = vi.fn();
vi.mock("../src/services/recycleBin.js", () => ({ recycleFile: (...args: unknown[]) => recycleFile(...args) }));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let getUpcomingArchivals: (typeof import("../src/services/archival.js"))["getUpcomingArchivals"];
let runAutoArchival: (typeof import("../src/services/archival.js"))["runAutoArchival"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ getUpcomingArchivals, runAutoArchival } = await import("../src/services/archival.js"));
});

const ARCHIVAL_SETTINGS = ["archiveEnabled", "archiveAfterDays", "archiveFolder", "archivePermanentDelete", "mediaServerType", "mediaServerUrl", "mediaServerToken"];

let libraryDir: string;
let archiveDir: string;

beforeEach(async () => {
  for (const key of ARCHIVAL_SETTINGS) setSetting(key, "");
  fetchWatchedFiles.mockReset();
  recycleFile.mockReset().mockResolvedValue(undefined);
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM history").run();
  await db.prepare("DELETE FROM tags").run();
  await db.prepare("DELETE FROM collections").run();
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-archival-lib-"));
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-archival-arc-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.rmSync(archiveDir, { recursive: true, force: true });
});

function configureMediaServer(): void {
  setSetting("mediaServerType", "plex");
  setSetting("mediaServerUrl", "http://plex.local:32400");
  setSetting("mediaServerToken", "tok");
}

// getUpcomingArchivals() mirrors runAutoArchival()'s own archiveEnabled/archiveFolder gates (a
// preview should only ever show candidates a real run would actually process) — tests that expect
// real candidates back need this configured, the same way runAutoArchival's own tests already do.
function configureArchival(): void {
  setSetting("archiveEnabled", "1");
  setSetting("archiveFolder", archiveDir);
}

function makeFile(relPath: string): string {
  const full = path.join(libraryDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "fake content");
  return full;
}

function watchedNow(filePath: string, daysAgo = 0): { path: string; lastPlayedAt: Date } {
  return { path: filePath, lastPlayedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) };
}

async function insertMovie(overrides: Record<string, unknown> = {}): Promise<number> {
  const row = { title: "Movie X", path: null as string | null, has_file: 1, protected: 0, ...overrides };
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, path, monitored, has_file, protected, status) VALUES ('movie', ?, ?, ?, 1, ?, ?, 'unknown')`)
    .run(row.title, String(row.title).toLowerCase(), row.path, row.has_file, row.protected);
  return Number(result.lastInsertRowid);
}

async function insertShowWithEpisode(episodeOverrides: Record<string, unknown> = {}): Promise<{ showId: number; episodeId: number }> {
  const showId = Number(
    (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, protected, status) VALUES ('series','Show X','show x',1,1,0,'unknown')`).run())
      .lastInsertRowid
  );
  const ep = { path: null as string | null, season: 1, episode: 1, ...episodeOverrides };
  const epResult = await db
    .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path) VALUES (?, ?, ?, 1, ?)")
    .run(showId, ep.season, ep.episode, ep.path);
  return { showId, episodeId: Number(epResult.lastInsertRowid) };
}

describe("pathTail", () => {
  it("compares the last three path segments, case-insensitively, across mixed separators", async () => {
    const { pathTail } = await import("../src/services/archival.js");
    expect(pathTail("/data/movies/Dune (2021)/Dune.mkv")).toBe(pathTail("C:\\media\\Movies\\DUNE (2021)\\dune.mkv"));
  });

  it("distinguishes two shows with the same generic season/episode filename by the third segment", async () => {
    const { pathTail } = await import("../src/services/archival.js");
    const showA = pathTail("/tv/Show A/Season 01/S01E01.mkv");
    const showB = pathTail("/tv/Show B/Season 01/S01E01.mkv");
    expect(showA).not.toBe(showB);
  });
});

describe("findWatchedMatch", () => {
  it("matches a watched file by path tail regardless of mount-point prefix", async () => {
    const { findWatchedMatch } = await import("../src/services/archival.js");
    const watched = [{ path: "/plex/movies/Dune (2021)/Dune.mkv", lastPlayedAt: new Date() }];
    const match = findWatchedMatch("/aonarr/movies/Dune (2021)/Dune.mkv", watched);
    expect(match).toBe(watched[0]);
  });

  it("returns null for a null path or when nothing matches", async () => {
    const { findWatchedMatch } = await import("../src/services/archival.js");
    expect(findWatchedMatch(null, [{ path: "/x/y/z.mkv", lastPlayedAt: new Date() }])).toBeNull();
    expect(findWatchedMatch("/a/b/c.mkv", [])).toBeNull();
  });
});

describe("effectiveRetentionDays", () => {
  async function insertMovie(): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'X', 'x', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
  }

  it("falls back to the global default when nothing overrides it", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    expect(await effectiveRetentionDays(itemId, 30)).toBe(30);
  });

  it("uses a tag's own retention override", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Comfort', 365)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(365);
  });

  it("uses a collection's own retention override", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const collectionId = Number((await db.prepare("INSERT INTO collections (name, retention_days) VALUES ('Long Keep', 90)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO collection_items (collection_id, media_item_id) VALUES (?, ?)").run(collectionId, itemId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(90);
  });

  it("-1 (never archive) wins over any duration, from either a tag or a collection", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Kids', -1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);
    const collectionId = Number(
      (await db.prepare("INSERT INTO collections (name, retention_days) VALUES ('Also Long Keep', 365)").run()).lastInsertRowid
    );
    await db.prepare("INSERT INTO collection_items (collection_id, media_item_id) VALUES (?, ?)").run(collectionId, itemId);

    expect(await effectiveRetentionDays(itemId, 30)).toBeNull();
  });

  it("among multiple duration overrides, the longest (most protective) wins", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const shortTagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Short', 7)").run()).lastInsertRowid);
    const longTagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Long', 180)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, shortTagId);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, longTagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(180);
  });

  it("ignores a tag/collection with no retention override set", async () => {
    const { effectiveRetentionDays } = await import("../src/services/archival.js");
    const itemId = await insertMovie();
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('Untagged Retention')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    expect(await effectiveRetentionDays(itemId, 30)).toBe(30);
  });
});

describe("getUpcomingArchivals", () => {
  it("returns [] without calling fetchWatchedFiles when no media server is configured", async () => {
    await expect(getUpcomingArchivals()).resolves.toEqual([]);
    expect(fetchWatchedFiles).not.toHaveBeenCalled();
  });

  it("returns [] when fetchWatchedFiles throws, and when it returns no watched files at all", async () => {
    configureMediaServer();
    configureArchival();
    fetchWatchedFiles.mockRejectedValue(new Error("media server unreachable"));
    await expect(getUpcomingArchivals()).resolves.toEqual([]);

    fetchWatchedFiles.mockResolvedValue([]);
    await expect(getUpcomingArchivals()).resolves.toEqual([]);
  });

  it("a watched movie becomes a candidate scheduled at lastPlayedAt + effective retention days; an unwatched one doesn't", async () => {
    configureMediaServer();
    configureArchival();
    setSetting("archiveAfterDays", "10");
    const file = makeFile("movies/Watched.mkv");
    const watched = watchedNow(file, 5);
    fetchWatchedFiles.mockResolvedValue([watched]);
    await insertMovie({ title: "Watched Movie", path: file });
    await insertMovie({ title: "Unwatched Movie", path: makeFile("movies/Unwatched.mkv") });

    const candidates = await getUpcomingArchivals();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: "Watched Movie", type: "movie", filePath: file });
    expect(candidates[0].scheduledFor.getTime()).toBe(watched.lastPlayedAt.getTime() + 10 * 24 * 60 * 60 * 1000);
  });

  it("excludes an item with a never-archive (-1) retention override", async () => {
    configureMediaServer();
    configureArchival();
    const file = makeFile("movies/NeverArchive.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file)]);
    const itemId = await insertMovie({ title: "Protected By Tag", path: file });
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Never', -1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    await expect(getUpcomingArchivals()).resolves.toEqual([]);
  });

  it("includes watched episodes and sub-items with their own composed labels", async () => {
    configureMediaServer();
    configureArchival();
    const epFile = makeFile("tv/S01E01.mkv");
    const { showId } = await insertShowWithEpisode({ path: epFile });
    const subFile = makeFile("music/track1.mp3");
    const artistId = Number((await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, protected, status) VALUES ('artist','Band','band',1,1,0,'unknown')`).run()).lastInsertRowid);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'Track One', 1, ?, 1)").run(artistId, subFile);
    fetchWatchedFiles.mockResolvedValue([watchedNow(epFile), watchedNow(subFile)]);

    const candidates = await getUpcomingArchivals();

    expect(candidates.map((c) => c.title).sort()).toEqual(["Band - Track One", "Show X S01E01"]);
    expect(showId).toBeGreaterThan(0);
  });

  it("sorts candidates by scheduledFor ascending", async () => {
    configureMediaServer();
    configureArchival();
    const soonFile = makeFile("movies/Soon.mkv");
    const laterFile = makeFile("movies/Later.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(soonFile, 20), watchedNow(laterFile, 1)]);
    await insertMovie({ title: "Soon", path: soonFile });
    await insertMovie({ title: "Later", path: laterFile });

    const candidates = await getUpcomingArchivals();

    expect(candidates.map((c) => c.title)).toEqual(["Soon", "Later"]); // watched longer ago -> cutoff arrives sooner
  });
});

describe("runAutoArchival", () => {
  it("is a no-op when archiving isn't enabled, when no media server is configured, or when neither an archive folder nor permanent delete is set", async () => {
    configureMediaServer();
    setSetting("archiveFolder", archiveDir);
    // archiveEnabled left unset
    await runAutoArchival();
    expect(fetchWatchedFiles).not.toHaveBeenCalled();

    setSetting("archiveEnabled", "1");
    setSetting("mediaServerType", "");
    await runAutoArchival();
    expect(fetchWatchedFiles).not.toHaveBeenCalled();

    configureMediaServer();
    setSetting("archiveFolder", "");
    setSetting("archivePermanentDelete", "");
    await runAutoArchival();
    expect(fetchWatchedFiles).not.toHaveBeenCalled();
  });

  it("does nothing (and doesn't throw) when fetchWatchedFiles fails or returns no watched files", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    fetchWatchedFiles.mockRejectedValue(new Error("media server unreachable"));
    await expect(runAutoArchival()).resolves.toBeUndefined();

    fetchWatchedFiles.mockResolvedValue([]);
    await expect(runAutoArchival()).resolves.toBeUndefined();
  });

  it("archives a watched, aged movie: moves the real file, clears has_file/path/quality, and logs history", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveAfterDays", "10");
    setSetting("archiveFolder", archiveDir);
    const file = makeFile("movies/Old.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file, 30)]); // watched 30 days ago, 10-day retention -> well past cutoff
    const itemId = await insertMovie({ title: "Old Movie", path: file, quality: "1080p" });
    await db.prepare("UPDATE media_items SET quality = '1080p' WHERE id = ?").run(itemId);

    await runAutoArchival();

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, "Old.mkv"))).toBe(true);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
    expect(row).toMatchObject({ has_file: 0, path: null, quality: null });
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").get(itemId)) as any;
    expect(history.event_type).toBe("auto_archived");
    expect(JSON.parse(history.data)).toEqual({ title: "Old Movie", mode: "archived" });
  });

  it("does not archive a watched movie that hasn't yet reached its retention cutoff", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveAfterDays", "30");
    setSetting("archiveFolder", archiveDir);
    const file = makeFile("movies/Recent.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file, 2)]); // watched 2 days ago, 30-day retention
    await insertMovie({ title: "Recent Movie", path: file });

    await runAutoArchival();

    expect(fs.existsSync(file)).toBe(true);
  });

  it("does not archive an item with a never-archive retention override", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const file = makeFile("movies/Protected.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file, 999)]);
    const itemId = await insertMovie({ title: "Protected", path: file });
    const tagId = Number((await db.prepare("INSERT INTO tags (name, retention_days) VALUES ('Never', -1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);

    await runAutoArchival();

    expect(fs.existsSync(file)).toBe(true);
  });

  it("permanentDelete routes through recycleFile instead of moving to an archive folder, and logs 'deleted'", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archivePermanentDelete", "1");
    // No archiveFolder needed at all when permanentDelete is on.
    const file = makeFile("movies/ToDelete.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file, 60)]);
    const itemId = await insertMovie({ title: "To Delete", path: file });

    await runAutoArchival();

    expect(recycleFile).toHaveBeenCalledWith(file, "movie", "To Delete", itemId);
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").get(itemId)) as any;
    expect(JSON.parse(history.data).mode).toBe("deleted");
  });

  it("one item's archive failure is caught and logged, without stopping the rest of the run", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const missingFile = path.join(libraryDir, "movies/AlreadyGone.mkv"); // never actually created -> fsp.rename fails
    const goodFile = makeFile("movies/Good.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(missingFile, 60), watchedNow(goodFile, 60)]);
    const failingId = await insertMovie({ title: "Missing File", path: missingFile });
    const goodId = await insertMovie({ title: "Good Movie", path: goodFile });

    await expect(runAutoArchival()).resolves.toBeUndefined();

    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(failingId)) as any).has_file).toBe(1); // untouched, the failure didn't silently mark it archived
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(goodId)) as any).has_file).toBe(0); // the other item still succeeded
    expect(fs.existsSync(path.join(archiveDir, "Good.mkv"))).toBe(true);
  });

  it("archives a watched episode with its own label, and a watched sub-item likewise", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const epFile = makeFile("tv/S01E01.mkv");
    const { showId, episodeId } = await insertShowWithEpisode({ path: epFile });
    fetchWatchedFiles.mockResolvedValue([watchedNow(epFile, 60)]);

    await runAutoArchival();

    expect(fs.existsSync(epFile)).toBe(false);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
    expect(ep).toMatchObject({ has_file: 0, file_path: null });
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").get(showId)) as any;
    expect(JSON.parse(history.data).title).toBe("Show X S01E01");
  });

  it("also unmonitors whatever it archives (movie, episode, sub-item) so auto-search doesn't re-grab it — an unwatched sibling stays monitored", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const movieFile = makeFile("movies/Watched Movie.mkv");
    const movieId = await insertMovie({ title: "Watched Movie", path: movieFile });
    const watchedEpFile = makeFile("tv/Show X/S01E01.mkv");
    const { showId, episodeId } = await insertShowWithEpisode({ path: watchedEpFile, season: 1, episode: 1 });
    const unwatchedEpFile = makeFile("tv/Show X/S01E02.mkv");
    const unwatchedEpisodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 2, 1, 1, ?)")
          .run(showId, unwatchedEpFile)
      ).lastInsertRowid
    );
    await db.prepare("UPDATE episodes SET monitored = 1 WHERE id = ?").run(episodeId);
    const albumFile = makeFile("music/Band/Album One");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, protected, status) VALUES ('artist','Band','band',1,1,0,'unknown')`).run())
        .lastInsertRowid
    );
    const subItemId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album One', 1, 1, ?)").run(artistId, albumFile))
        .lastInsertRowid
    );
    fetchWatchedFiles.mockResolvedValue([watchedNow(movieFile, 60), watchedNow(watchedEpFile, 60), watchedNow(albumFile, 60)]);

    await runAutoArchival();

    expect(((await db.prepare("SELECT has_file, monitored FROM media_items WHERE id = ?").get(movieId)) as any)).toMatchObject({ has_file: 0, monitored: 0 });
    expect(((await db.prepare("SELECT has_file, monitored FROM episodes WHERE id = ?").get(episodeId)) as any)).toMatchObject({ has_file: 0, monitored: 0 });
    expect(((await db.prepare("SELECT has_file, monitored FROM sub_items WHERE id = ?").get(subItemId)) as any)).toMatchObject({ has_file: 0, monitored: 0 });
    expect(((await db.prepare("SELECT has_file, monitored FROM episodes WHERE id = ?").get(unwatchedEpisodeId)) as any)).toMatchObject({ has_file: 1, monitored: 1 });
    // Only the archived child is unmonitored, never its parent series/artist.
    expect(((await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(showId)) as any).monitored).toBe(1);
    expect(((await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(artistId)) as any).monitored).toBe(1);
  });

  it("a parent's has_file rolls back to 0 once its last remaining episode is archived, but not while others still have files", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const ep1File = makeFile("tv/S01E01.mkv");
    const { showId } = await insertShowWithEpisode({ path: ep1File, season: 1, episode: 1 });
    const ep2File = makeFile("tv/S01E02.mkv");
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path) VALUES (?, 1, 2, 1, ?)").run(showId, ep2File);
    fetchWatchedFiles.mockResolvedValue([watchedNow(ep1File, 60)]); // only episode 1 watched/archived

    await runAutoArchival();

    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any).has_file).toBe(1); // episode 2 still has a file

    fetchWatchedFiles.mockResolvedValue([watchedNow(ep2File, 60)]);
    await runAutoArchival();

    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any).has_file).toBe(0); // now both episodes are gone
  });

  it("falls back to a copy+delete when the archive folder is on a different filesystem (EXDEV)", async () => {
    configureMediaServer();
    setSetting("archiveEnabled", "1");
    setSetting("archiveFolder", archiveDir);
    const file = makeFile("movies/CrossFs.mkv");
    fetchWatchedFiles.mockResolvedValue([watchedNow(file, 60)]);
    await insertMovie({ title: "Cross FS", path: file });
    vi.spyOn(fsp, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));

    await runAutoArchival();

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, "CrossFs.mkv"))).toBe(true);
  });
});
