import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// The slot-wait tests move fake timers through up to 46 minutes, one poll after another, and each turn of the refresh
// is a database round trip: against Postgres on a slow runner that outlasts the 20 s default.
vi.setConfig({ testTimeout: 120_000 });

// Round 30a: a scheduled full refresh waits for the type's refresh slot instead of skipping the type; the cheap
// new-children pass shares that slot; an album folder that held no audio is not walked again until it changes; the
// folder walk reads each folder off the main thread and skips one that does not answer; a full scan records when it
// finished.

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();
const fetchSeriesEpisodesForProvider = vi.fn();
const fetchSeriesSeasonsFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const fetchCollectionChildrenFor = vi.fn();
const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    isEpisodeMonitoredByDefault: actual.isEpisodeMonitoredByDefault,
    upcomingEpisodes: actual.upcomingEpisodes,
    proxyScreenscraperArtwork: actual.proxyScreenscraperArtwork,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
    fetchSeriesSeasonsFor: (...args: unknown[]) => fetchSeriesSeasonsFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  };
});

// Taken before any test fakes it, so a fake never delegates to another fake.
const realReaddir = fs.promises.readdir;

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let libraryScan: typeof import("../src/services/libraryScan.js");
let getSetting: (typeof import("../src/services/settingsStore.js"))["getSetting"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let resetFsAsyncStateForTests: (typeof import("../src/services/fsAsync.js"))["resetFsAsyncStateForTests"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  libraryScan = await import("../src/services/libraryScan.js");
  ({ getSetting, setSetting } = await import("../src/services/settingsStore.js"));
  ({ resetFsAsyncStateForTests } = await import("../src/services/fsAsync.js"));
});

let tmpRoot: string;
/** Gates the test has left closed (a provider call that never returns on its own): opened in afterEach. */
const openGates: Array<() => void> = [];

beforeEach(async () => {
  for (const t of ["tracks", "episodes", "seasons", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  probeMediaInfo.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);
  fetchSeriesSeasonsFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});
  setSetting("albumBackfillEmpty", "");
  setSetting("lastFullScanAt", "");
  resetFsAsyncStateForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-libscan30a-"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const open of openGates.splice(0)) open();
  // Whatever a test left running ends before the next test needs the per-type slots.
  await new Promise((resolve) => setImmediate(resolve));
  resetFsAsyncStateForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A promise that stays pending until `open()`; opened in afterEach at the latest. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  openGates.push(open);
  return { promise, open };
}

/** Lets the event loop turn until `condition` holds, without moving any fake timer. */
async function until(condition: () => boolean): Promise<void> {
  // Bounded by real time, not a count of turns: against Postgres a query takes network round trips.
  const deadline = performance.now() + 5_000;
  while (!condition() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

async function insertMovie(title: string): Promise<number> {
  return Number(
    (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 0, 'missing')`).run(title, title.toLowerCase()))
      .lastInsertRowid
  );
}

async function insertSeries(title: string, externalIds: Record<string, string> | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('series', ?, ?, 1, 0, 'Returning Series', ?)`)
        .run(title, title.toLowerCase(), externalIds ? JSON.stringify(externalIds) : null)
    ).lastInsertRowid
  );
}

// ---------------------------------------------------------------------------
// The refresh slot
// ---------------------------------------------------------------------------

describe("refreshLibraryMetadata with a wait for the type's slot", () => {
  /** A movie refresh that holds the slot until the gate opens. */
  async function slotHeldByAMovieRefresh() {
    await insertMovie("Slow Movie");
    const held = gate();
    searchMetadata.mockImplementation(async () => {
      await held.promise;
      return [];
    });
    const first = libraryScan.refreshLibraryMetadata("movie");
    await until(() => searchMetadata.mock.calls.length === 1);
    return { first, held };
  }

  it("waits for the refresh that has the slot and then runs, instead of being skipped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { first, held } = await slotHeldByAMovieRefresh();

    let settled = false;
    const second = libraryScan.refreshLibraryMetadata("movie", undefined, undefined, { waitForSlotMs: 60_000 }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(searchMetadata).toHaveBeenCalledTimes(1); // it has not started a second walk of the same items

    held.open();
    expect(await first).toEqual({ updated: 0, failed: 1, childrenAdded: 0 });
    await vi.advanceTimersByTimeAsync(2_000); // its next look at the slot

    expect(await second).toEqual({ updated: 0, failed: 1, childrenAdded: 0 }); // no alreadyRunning: it ran
    expect(searchMetadata).toHaveBeenCalledTimes(2);
  });

  it("gives up once the wait is over and reports that a refresh is already running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { first, held } = await slotHeldByAMovieRefresh();

    const second = libraryScan.refreshLibraryMetadata("movie", undefined, undefined, { waitForSlotMs: 5_000 });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(await second).toEqual({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });
    expect(searchMetadata).toHaveBeenCalledTimes(1);
    held.open();
    await first;
  });

  it("stops waiting as soon as it is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { first, held } = await slotHeldByAMovieRefresh();
    const controller = new AbortController();

    const second = libraryScan.refreshLibraryMetadata("movie", controller.signal, undefined, { waitForSlotMs: 45 * 60_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000); // far short of the 45 minutes

    expect(await second).toEqual({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });
    held.open();
    await first;
  });

  it("does not wait at all when the slot is free", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await insertMovie("Quick Movie");

    // No timer is ever advanced: a needless wait would never end.
    expect(await libraryScan.refreshLibraryMetadata("movie", undefined, undefined, { waitForSlotMs: 60_000 })).toEqual({ updated: 0, failed: 1, childrenAdded: 0 });
  });

  it("is skipped at once, as before, when it was not asked to wait", async () => {
    const { first, held } = await slotHeldByAMovieRefresh();

    expect(await libraryScan.refreshLibraryMetadata("movie")).toEqual({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });
    expect(await libraryScan.refreshLibraryMetadata("movie", undefined, undefined, { waitForSlotMs: 0 })).toMatchObject({ alreadyRunning: true });

    held.open();
    await first;
  });
});

describe("the cheap new-children pass and the full refresh share one slot per type", () => {
  /** A returning, matched, monitored show: the cheap pass asks the provider for its episodes and holds the slot meanwhile. */
  async function slotHeldByTheCheapPass() {
    await insertSeries("Returning Show", { tmdb: "4242" });
    const held = gate();
    fetchSeriesEpisodesFor.mockImplementation(async () => {
      await held.promise;
      return [];
    });
    const cheap = libraryScan.refreshNewChildren();
    await until(() => fetchSeriesEpisodesFor.mock.calls.length === 1);
    return { cheap, held };
  }

  it("skips a refresh of the type that was not asked to wait while the cheap pass runs", async () => {
    const { cheap, held } = await slotHeldByTheCheapPass();

    expect(await libraryScan.refreshLibraryMetadata("series")).toEqual({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });
    expect(searchMetadata).not.toHaveBeenCalled();

    held.open();
    await cheap;
    // The cheap pass has let go of the slot.
    expect((await libraryScan.refreshLibraryMetadata("series")).alreadyRunning).toBeUndefined();
  });

  it("makes the weekly refresh wait for the cheap pass and then refresh the show", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { cheap, held } = await slotHeldByTheCheapPass();

    const full = libraryScan.refreshLibraryMetadata("series", undefined, undefined, { waitForSlotMs: 60 * 60_000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(searchMetadata).not.toHaveBeenCalled();
    expect(fetchByExternalId).not.toHaveBeenCalled();

    held.open();
    await cheap;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await full;

    expect(result.alreadyRunning).toBeUndefined();
    expect(fetchByExternalId.mock.calls.length + searchMetadata.mock.calls.length).toBeGreaterThan(0);
  });

  it("has refreshAllLibraries wait for it, and give a type up only after 45 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { cheap, held } = await slotHeldByTheCheapPass();

    let allDone = false;
    const all = libraryScan.refreshAllLibraries().then(() => (allDone = true));
    await vi.advanceTimersByTimeAsync(44 * 60_000);
    expect(allDone).toBe(false);
    expect(searchMetadata).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000); // past the 45 minutes: series is given up, the rest go on
    await all;
    expect(allDone).toBe(true);
    expect(searchMetadata).not.toHaveBeenCalled(); // the show was never refreshed: the cheap pass had the slot throughout

    held.open();
    await cheap;
  });

  it("has refreshAllLibraries refresh the type once the cheap pass is done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { cheap, held } = await slotHeldByTheCheapPass();

    const all = libraryScan.refreshAllLibraries();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(searchMetadata).not.toHaveBeenCalled();

    held.open();
    await cheap;
    await vi.advanceTimersByTimeAsync(2_000);
    await all;

    expect(fetchByExternalId.mock.calls.length + searchMetadata.mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// backfillMissingAlbumTracks remembers albums with no audio
// ---------------------------------------------------------------------------

describe("backfillMissingAlbumTracks: an album folder that held no audio", () => {
  const JAN_2020 = new Date("2020-01-01T00:00:00Z");
  const JAN_2021 = new Date("2021-01-01T00:00:00Z");

  async function album(name: string, mtime: Date = JAN_2020) {
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('audiobook', ?, ?, 1, 1, 'downloaded')`).run(`Author ${name}`, `author ${name}`))
        .lastInsertRowid
    );
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.utimesSync(dir, mtime, mtime);
    const id = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, ?, 1, 1, ?)").run(authorId, name, dir)).lastInsertRowid
    );
    return { id, dir };
  }

  /** How many times the backfill listed `dir`. */
  function listings(spy: { mock: { calls: unknown[][] } }, dir: string): number {
    return spy.mock.calls.filter((call) => call[0] === dir).length;
  }

  const remembered = () => JSON.parse(getSetting("albumBackfillEmpty") || "{}") as Record<string, number>;

  it("is not walked again at the next start, only once its folder has changed", async () => {
    const { id, dir } = await album("Empty Album");
    const readdir = vi.spyOn(fs.promises, "readdir");

    await libraryScan.backfillMissingAlbumTracks();
    expect(listings(readdir, dir)).toBe(2); // the change stamp lists the folder once, the audio walk once
    expect(remembered()).toEqual({ [id]: fs.statSync(dir).mtimeMs });

    await libraryScan.backfillMissingAlbumTracks();
    await libraryScan.backfillMissingAlbumTracks();
    expect(listings(readdir, dir)).toBe(4); // two more starts: the stamp only, no audio walk

    // Something is put in the folder (not audio): looked at once more, and remembered again as it now is.
    fs.writeFileSync(path.join(dir, "cover.jpg"), "x");
    fs.utimesSync(dir, JAN_2021, JAN_2021);
    await libraryScan.backfillMissingAlbumTracks();
    expect(listings(readdir, dir)).toBe(6); // stamp + audio walk again
    expect(remembered()).toEqual({ [id]: JAN_2021.getTime() });
    await libraryScan.backfillMissingAlbumTracks();
    expect(listings(readdir, dir)).toBe(7); // stamp only
    expect(await db.prepare("SELECT 1 FROM tracks WHERE sub_item_id = ?").get(id)).toBeUndefined();
  });

  it("is walked again when a disc subfolder changed, though the album folder itself did not", async () => {
    const { id, dir } = await album("Disc Album");
    const disc = path.join(dir, "CD1");
    fs.mkdirSync(disc);
    fs.utimesSync(disc, JAN_2020, JAN_2020);
    fs.utimesSync(dir, JAN_2020, JAN_2020);
    await libraryScan.backfillMissingAlbumTracks();
    expect(Object.keys(remembered())).toEqual([String(id)]);

    // Audio lands inside the existing disc folder: only CD1's own time moves.
    fs.writeFileSync(path.join(disc, "01 - Track.mp3"), "x");
    fs.utimesSync(disc, JAN_2021, JAN_2021);
    fs.utimesSync(dir, JAN_2020, JAN_2020);
    await libraryScan.backfillMissingAlbumTracks();

    expect(await db.prepare("SELECT 1 FROM tracks WHERE sub_item_id = ?").get(id)).toBeDefined();
    expect(remembered()).toEqual({});
  });

  it("drops the memory of an album that is no longer waiting for tracks", async () => {
    const { id } = await album("Gone Quiet Album");
    await libraryScan.backfillMissingAlbumTracks();
    expect(Object.keys(remembered())).toEqual([String(id)]);

    // A normal scan gave the album its tracks in the meantime.
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Track 1')").run(id);
    await libraryScan.backfillMissingAlbumTracks();

    expect(getSetting("albumBackfillEmpty")).toBe("");
  });

  it("is filled and forgotten once audio turns up in the folder", async () => {
    const { id, dir } = await album("Later Album");
    await libraryScan.backfillMissingAlbumTracks();
    expect(Object.keys(remembered())).toEqual([String(id)]);

    fs.writeFileSync(path.join(dir, "01 - Chapter One.mp3"), "x");
    fs.utimesSync(dir, JAN_2021, JAN_2021);
    await libraryScan.backfillMissingAlbumTracks();

    const tracks = (await db.prepare("SELECT title FROM tracks WHERE sub_item_id = ?").all(id)) as { title: string }[];
    expect(tracks.map((t) => t.title)).toEqual(["Chapter One"]);
    expect(getSetting("albumBackfillEmpty")).toBe(""); // nothing left to remember
  });

  it("remembers each album on its own and leaves one that does hold audio out of it", async () => {
    const empty = await album("Nothing Here");
    const full = await album("Has Audio");
    fs.writeFileSync(path.join(full.dir, "01 - Track.mp3"), "x");
    fs.utimesSync(full.dir, JAN_2020, JAN_2020);

    await libraryScan.backfillMissingAlbumTracks();

    expect(Object.keys(remembered())).toEqual([String(empty.id)]);
    expect(await db.prepare("SELECT 1 FROM tracks WHERE sub_item_id = ?").get(full.id)).toBeDefined();
  });

  it("does not remember an album whose folder is gone, which may be a share that is not mounted", async () => {
    const { dir } = await album("Missing Album");
    fs.rmSync(dir, { recursive: true });
    const readdir = vi.spyOn(fs.promises, "readdir");

    await expect(libraryScan.backfillMissingAlbumTracks()).resolves.toBeUndefined();

    expect(listings(readdir, dir)).toBe(0);
    expect(getSetting("albumBackfillEmpty")).toBe("");
  });

  it("starts over from a memory that cannot be read", async () => {
    const { id } = await album("Garbled Memory");
    setSetting("albumBackfillEmpty", "{not json");

    await expect(libraryScan.backfillMissingAlbumTracks()).resolves.toBeUndefined();

    expect(Object.keys(remembered())).toEqual([String(id)]);
  });
});

// ---------------------------------------------------------------------------
// The folder walk reads off the main thread
// ---------------------------------------------------------------------------

describe("the library scan's folder walk", () => {
  async function movieRoot() {
    const root = path.join(tmpRoot, "movie");
    fs.mkdirSync(root, { recursive: true });
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root);
    fs.writeFileSync(path.join(root, "Good Movie (2020).mkv"), "x");
    return root;
  }

  const titles = async () => ((await db.prepare("SELECT title FROM media_items ORDER BY title").all()) as { title: string }[]).map((r) => r.title);

  it("skips a folder that does not answer within the timeout and goes on with the rest", async () => {
    const root = await movieRoot();
    const dead = path.join(root, "Dead Share");
    fs.mkdirSync(dead);
    fs.writeFileSync(path.join(dead, "Dead Movie (2021).mkv"), "x");
    let deadListings = 0;
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: any, ...rest: any[]) => {
      if (p === dead) {
        deadListings++;
        return new Promise(() => {}); // a mount that never answers
      }
      return (realReaddir as any)(p, ...rest);
    }) as any);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let done = false;
    const scan = libraryScan.scanAndImportLibrary("movie").then((result) => {
      done = true;
      return result;
    });
    await until(() => deadListings === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(done).toBe(false); // still waiting for the dead folder
    await vi.advanceTimersByTimeAsync(10_000); // 30 seconds in all

    const result = await scan;
    expect(result.incomplete).toBe(true); // what is not found in a folder that did not answer says nothing about its files
    expect(result.created).toBe(1);
    expect(await titles()).toEqual(["Good Movie"]);
  });

  it("skips a folder that cannot be read and goes on with the rest", async () => {
    const root = await movieRoot();
    const locked = path.join(root, "Locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "Locked Movie (2021).mkv"), "x");
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: any, ...rest: any[]) =>
      p === locked ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) : (realReaddir as any)(p, ...rest)) as any);

    const result = await libraryScan.scanAndImportLibrary("movie");

    expect(result.created).toBe(1);
    expect(result.incomplete).toBeUndefined(); // a folder the scan may not read is no outage
    expect(await titles()).toEqual(["Good Movie"]);
  });

  it("finds the files of nested folders", async () => {
    const root = await movieRoot();
    const nested = path.join(root, "Collection", "Part Two");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "Nested Movie (2022).mkv"), "x");
    const readdir = vi.spyOn(fs.promises, "readdir");

    await libraryScan.scanAndImportLibrary("movie");

    expect(await titles()).toEqual(["Good Movie", "Nested Movie"]);
    // Each folder was listed through the async call.
    for (const dir of [root, path.join(root, "Collection"), nested]) expect(readdir.mock.calls.some((call) => call[0] === dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A scan that could not look at everything
// ---------------------------------------------------------------------------

describe("a scan that could not look at everything", () => {
  const HOUR = 3_600_000;

  /** A movie library with one good file and a subfolder (`Shaky`) holding another. */
  async function movieRootWithShakyFolder() {
    const root = path.join(tmpRoot, "movie");
    const shaky = path.join(root, "Shaky");
    fs.mkdirSync(shaky, { recursive: true });
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root);
    fs.writeFileSync(path.join(root, "Good Movie (2020).mkv"), "x");
    fs.writeFileSync(path.join(shaky, "Shaky Movie (2021).mkv"), "x");
    return { root, shaky };
  }

  /** The folder's listing fails with `code`; every other folder is listed for real. */
  function listingFails(folder: string, code: string) {
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: any, ...rest: any[]) =>
      p === folder ? Promise.reject(Object.assign(new Error(`${code}: the storage said no`), { code })) : (realReaddir as any)(p, ...rest)) as any);
  }

  it.each(["ENOTCONN", "EIO", "ESTALE", "ETIMEDOUT", "EHOSTDOWN"])("calls the result incomplete when a folder fails with %s, though the rest is scanned", async (code) => {
    const { shaky } = await movieRootWithShakyFolder();
    listingFails(shaky, code);

    const result = await libraryScan.scanAndImportLibrary("movie");

    expect(result.incomplete).toBe(true);
    expect(result.created).toBe(1);
  });

  it.each(["EACCES", "EPERM", "ENOENT"])("does not call the result incomplete for a folder that fails with %s", async (code) => {
    const { shaky } = await movieRootWithShakyFolder();
    listingFails(shaky, code);

    const result = await libraryScan.scanAndImportLibrary("movie");

    expect(result.incomplete).toBeUndefined();
    expect(result.created).toBe(1);
  });

  it("makes a full scan report false and keep the time of the last complete one when a folder does not answer", async () => {
    const { shaky } = await movieRootWithShakyFolder();
    const lastComplete = new Date(Date.now() - 10 * HOUR).toISOString();
    setSetting("lastFullScanAt", lastComplete);
    let shakyListings = 0;
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: any, ...rest: any[]) => {
      if (p === shaky) {
        shakyListings++;
        return new Promise(() => {}); // a mount that never answers
      }
      return (realReaddir as any)(p, ...rest);
    }) as any);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const all = libraryScan.scanAndImportAllLibraries();
    await until(() => shakyListings === 1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await all).toBe(false);
    expect(getSetting("lastFullScanAt")).toBe(lastComplete); // not stamped: the 05:00 job must still scan
    expect(libraryScan.recentFullScan()).toBe(false);
  });

  it("still counts a full scan in which a folder only refused to be read", async () => {
    const { shaky } = await movieRootWithShakyFolder();
    listingFails(shaky, "EACCES");

    expect(await libraryScan.scanAndImportAllLibraries()).toBe(true);

    expect(libraryScan.recentFullScan()).toBe(true);
  });

  it("makes a full scan report false and record nothing when a type is already being scanned", async () => {
    await movieRootWithShakyFolder();
    const held = gate();
    probeMediaInfo.mockImplementation(async () => {
      await held.promise;
      return null;
    });
    const first = libraryScan.scanAndImportLibrary("movie");
    await until(() => probeMediaInfo.mock.calls.length > 0); // the movie library is mid-scan

    expect((await libraryScan.scanAndImportLibrary("movie")).alreadyRunning).toBe(true);
    expect(await libraryScan.scanAndImportAllLibraries()).toBe(false);
    expect(getSetting("lastFullScanAt")).toBe("");
    expect(libraryScan.recentFullScan()).toBe(false);

    held.open();
    expect((await first).alreadyRunning).toBeUndefined();
    // With nothing running, the same full scan is complete.
    expect(await libraryScan.scanAndImportAllLibraries()).toBe(true);
    expect(libraryScan.recentFullScan()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lastFullScanAt
// ---------------------------------------------------------------------------

describe("recording when a full scan finished", () => {
  it("is set by a scan that looked at every library", async () => {
    expect(libraryScan.recentFullScan()).toBe(false);
    const before = Date.now();

    await libraryScan.scanAndImportAllLibraries();

    const recorded = Date.parse(getSetting("lastFullScanAt") || "");
    expect(recorded).toBeGreaterThanOrEqual(before - 1000);
    expect(recorded).toBeLessThanOrEqual(Date.now() + 1000);
    expect(libraryScan.recentFullScan()).toBe(true);
  });

  it("is left alone by a scan that was cancelled before it began", async () => {
    const controller = new AbortController();
    controller.abort();

    await libraryScan.scanAndImportAllLibraries(controller.signal);

    expect(getSetting("lastFullScanAt")).toBe("");
    expect(libraryScan.recentFullScan()).toBe(false);
  });

  it("is left alone by a scan that was cancelled part way through", async () => {
    const root = path.join(tmpRoot, "movie");
    fs.mkdirSync(root, { recursive: true });
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root);
    fs.writeFileSync(path.join(root, "Some Movie (2020).mkv"), "x");
    const controller = new AbortController();
    probeMediaInfo.mockImplementation(async () => {
      controller.abort(); // during the movie library, the first of the types
      return null;
    });

    await libraryScan.scanAndImportAllLibraries(controller.signal);

    expect(getSetting("lastFullScanAt")).toBe("");
  });

  it("counts as recent for 4 hours, and not at a time before it or from an unreadable value", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const at = (msAgo: number) => setSetting("lastFullScanAt", new Date(now - msAgo).toISOString());
    const HOUR = 3_600_000;

    at(0);
    expect(libraryScan.recentFullScan(now)).toBe(true);
    at(4 * HOUR - 1);
    expect(libraryScan.recentFullScan(now)).toBe(true);
    at(4 * HOUR);
    expect(libraryScan.recentFullScan(now)).toBe(false);
    at(-HOUR); // a clock that was set back since: not trusted
    expect(libraryScan.recentFullScan(now)).toBe(false);
    setSetting("lastFullScanAt", "not a date");
    expect(libraryScan.recentFullScan(now)).toBe(false);
    setSetting("lastFullScanAt", "");
    expect(libraryScan.recentFullScan(now)).toBe(false);
    expect(libraryScan.RECENT_FULL_SCAN_MS).toBe(4 * HOUR);
  });
});
