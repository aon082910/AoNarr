import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
const checkIndexerHealth = vi.fn();
vi.mock("../src/services/indexerClient.js", () => ({
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
  checkIndexerHealth: (...args: unknown[]) => checkIndexerHealth(...args),
}));

const getDownloadClientAdapter = vi.fn();
const removeQueueItemDownload = vi.fn();
const applyRemotePathMapping = vi.fn();
vi.mock("../src/services/downloadClient.js", () => ({
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
  applyRemotePathMapping: (...args: unknown[]) => applyRemotePathMapping(...args),
}));

const importQueueItem = vi.fn();
vi.mock("../src/services/importer.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object; // keep the real ImportSkippedError class for instanceof checks
  return { ...actual, importQueueItem: (...args: unknown[]) => importQueueItem(...args) };
});

const notifyFailed = vi.fn();
const notifyGrabbed = vi.fn();
const notifyHealthIssue = vi.fn();
const notifyManualInteractionRequired = vi.fn();
const notifyUpdateAvailable = vi.fn();
vi.mock("../src/services/notifications.js", () => ({
  notifyFailed: (...args: unknown[]) => notifyFailed(...args),
  notifyGrabbed: (...args: unknown[]) => notifyGrabbed(...args),
  notifyHealthIssue: (...args: unknown[]) => notifyHealthIssue(...args),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
  notifyUpdateAvailable: (...args: unknown[]) => notifyUpdateAvailable(...args),
}));

const fetchCollectionChildrenFor = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
}));

const findUpgradeCandidates = vi.fn();
vi.mock("../src/services/upgradeCandidates.js", () => ({
  findUpgradeCandidates: (...args: unknown[]) => findUpgradeCandidates(...args),
}));

const registerJob = vi.fn();
const startAllJobs = vi.fn();
vi.mock("../src/services/jobRegistry.js", () => ({
  registerJob: (...args: unknown[]) => registerJob(...args),
  startAllJobs: (...args: unknown[]) => startAllJobs(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let isAlreadyQueued: (typeof import("../src/services/scheduler.js"))["isAlreadyQueued"];
let grab: (typeof import("../src/services/scheduler.js"))["grab"];
let pickClientForProtocol: (typeof import("../src/services/scheduler.js"))["pickClientForProtocol"];
let searchAndGrabTargets: (typeof import("../src/services/scheduler.js"))["searchAndGrabTargets"];
let isWithinTimeWindow: (typeof import("../src/services/scheduler.js"))["isWithinTimeWindow"];
let isReleaseAvailableForSearch: (typeof import("../src/services/scheduler.js"))["isReleaseAvailableForSearch"];
let runAutoSearch: (typeof import("../src/services/scheduler.js"))["runAutoSearch"];
let runAutoUpgrade: (typeof import("../src/services/scheduler.js"))["runAutoUpgrade"];
let checkVideoChannels: (typeof import("../src/services/scheduler.js"))["checkVideoChannels"];
let checkPodcastFeeds: (typeof import("../src/services/scheduler.js"))["checkPodcastFeeds"];
let retryFailedGrab: (typeof import("../src/services/scheduler.js"))["retryFailedGrab"];
let pollQueue: (typeof import("../src/services/scheduler.js"))["pollQueue"];
let cleanupStalledDownloads: (typeof import("../src/services/scheduler.js"))["cleanupStalledDownloads"];
let pruneOldFailedQueueItems: (typeof import("../src/services/scheduler.js"))["pruneOldFailedQueueItems"];
let checkHealthAndNotify: (typeof import("../src/services/scheduler.js"))["checkHealthAndNotify"];
let runSeedGoalCleanup: (typeof import("../src/services/scheduler.js"))["runSeedGoalCleanup"];
let startScheduler: (typeof import("../src/services/scheduler.js"))["startScheduler"];
let ImportSkippedError: (typeof import("../src/services/importer.js"))["ImportSkippedError"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ ImportSkippedError } = await import("../src/services/importer.js"));
  ({
    isAlreadyQueued,
    grab,
    pickClientForProtocol,
    searchAndGrabTargets,
    isWithinTimeWindow,
    isReleaseAvailableForSearch,
    runAutoSearch,
    runAutoUpgrade,
    checkVideoChannels,
    checkPodcastFeeds,
    retryFailedGrab,
    pollQueue,
    cleanupStalledDownloads,
    pruneOldFailedQueueItems,
    checkHealthAndNotify,
    runSeedGoalCleanup,
    startScheduler,
  } = await import("../src/services/scheduler.js"));
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "disk_usage_samples", "delay_profiles", "episodes", "sub_items", "tracks", "media_items", "root_folders", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  searchAllIndexers.mockReset().mockResolvedValue([]);
  checkIndexerHealth.mockReset().mockResolvedValue({ ok: true });
  getDownloadClientAdapter.mockReset();
  removeQueueItemDownload.mockReset().mockResolvedValue(undefined);
  applyRemotePathMapping.mockReset().mockImplementation(async (_id: number, p: string) => p);
  importQueueItem.mockReset().mockResolvedValue(undefined);
  notifyFailed.mockReset();
  notifyGrabbed.mockReset();
  notifyHealthIssue.mockReset();
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  notifyUpdateAvailable.mockReset();
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  findUpgradeCandidates.mockReset().mockResolvedValue([]);
  registerJob.mockReset();
  startAllJobs.mockReset();

  setSetting("quietHoursEnabled", "0");
  setSetting("searchWindowEnabled", "0");
  setSetting("autoUpgradeEnabled", "0");
  setSetting("removeFailedDownloads", "0");
  setSetting("failedDownloadBehavior", "");
  setSetting("maxAutoRetries", "2");
  setSetting("lastHealthIssueSummary", "");
  setSetting("stalledDownloadHours", "6");
});

afterEach(() => {
  vi.useRealTimers();
});

async function insertQualityProfile(overrides: Record<string, unknown> = {}): Promise<number> {
  const row = { name: `Profile ${Math.random()}`, allowed_qualities: "[]", cutoff: "", ...overrides };
  const result = await db
    .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
    .run(row.name, row.allowed_qualities, row.cutoff);
  return Number(result.lastInsertRowid);
}

async function insertMovie(overrides: Record<string, unknown> = {}): Promise<any> {
  const row = {
    title: "The Matrix",
    sort_title: "the matrix",
    year: 1999,
    monitored: 1,
    has_file: 0,
    quality_profile_id: null,
    minimum_availability: null,
    release_date: null,
    root_folder_id: null,
    ...overrides,
  };
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, quality_profile_id, minimum_availability, release_date, root_folder_id, status)
       VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')`
    )
    .run(row.title, row.sort_title, row.year, row.monitored, row.has_file, row.quality_profile_id, row.minimum_availability, row.release_date, row.root_folder_id);
  return { id: Number(result.lastInsertRowid), ...row };
}

async function insertClient(overrides: Record<string, unknown> = {}): Promise<any> {
  const row = { name: "Test Client", type: "qbittorrent", enabled: 1, ...overrides };
  const result = await db
    .prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, ?, ?)")
    .run(row.name, row.type, row.enabled);
  return { id: Number(result.lastInsertRowid), ...row };
}

function fakeResult(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    // null, not a literal id: queue.indexer_id has a real FK to indexers(id), and no test here
    // inserts an actual indexer row (nothing under test needs one to be real).
    indexerId: null,
    indexerName: "Test Indexer",
    title: "The.Matrix.1999.1080p.WEB-DL",
    size: 5_000_000_000,
    seeders: 100,
    leechers: 10,
    publishDate: new Date().toISOString(),
    downloadUrl: "magnet:?xt=urn:btih:abc",
    protocol: "torrent",
    category: null,
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<Record<string, any>> = {}) {
  return { addDownload: vi.fn().mockResolvedValue({ downloadId: "dl-1" }), getStatus: vi.fn().mockResolvedValue([]), ...overrides };
}

// ---------------------------------------------------------------------------
// Pure / simple helpers
// ---------------------------------------------------------------------------

describe("isWithinTimeWindow", () => {
  it("returns null for an unparseable or zero-width window", () => {
    expect(isWithinTimeWindow("bad", "22:00")).toBeNull();
    expect(isWithinTimeWindow("10:00", "10:00")).toBeNull();
  });
});

describe("isReleaseAvailableForSearch", () => {
  it("always allows an 'announced' (or unset) item, regardless of release date", () => {
    expect(isReleaseAvailableForSearch({ minimumAvailability: null, releaseDate: null } as any)).toBe(true);
    expect(isReleaseAvailableForSearch({ minimumAvailability: "announced", releaseDate: "2999-01-01" } as any)).toBe(true);
  });

  it("'inCinemas' waits until the release date has passed", () => {
    expect(isReleaseAvailableForSearch({ minimumAvailability: "inCinemas", releaseDate: "2999-01-01" } as any)).toBe(false);
    expect(isReleaseAvailableForSearch({ minimumAvailability: "inCinemas", releaseDate: "2000-01-01" } as any)).toBe(true);
  });

  it("'released' waits until releaseDate plus the configured delay", () => {
    setSetting("minimumAvailabilityReleasedDelayDays", "90");
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
    expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: soon } as any)).toBe(false);
    expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: longAgo } as any)).toBe(true);
  });

  it("never gates an item with no release date at all", () => {
    expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: null } as any)).toBe(true);
  });
});

describe("isAlreadyQueued", () => {
  it("matches by episode, sub-item, or bare media item independently", async () => {
    const movie = await insertMovie();
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'x', 'queued')").run(movie.id);

    expect(await isAlreadyQueued(movie.id, null, null)).toBe(true);
    expect(await isAlreadyQueued(movie.id, 999, null)).toBe(false);
    expect(await isAlreadyQueued(999999, null, null)).toBe(false);
  });

  it("ignores a queue row that's already failed", async () => {
    const movie = await insertMovie();
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'x', 'failed')").run(movie.id);

    expect(await isAlreadyQueued(movie.id, null, null)).toBe(false);
  });
});

describe("pickClientForProtocol", () => {
  it("prefers a client whose type matches the protocol, in preference order", () => {
    const clients = [{ type: "http" }, { type: "qbittorrent" }] as any[];
    expect(pickClientForProtocol(clients, "torrent")?.type).toBe("qbittorrent");
    expect(pickClientForProtocol(clients, "http")?.type).toBe("http");
  });

  it("returns null when no configured client speaks the protocol", () => {
    expect(pickClientForProtocol([{ type: "http" } as any], "torrent")).toBeNull();
  });

  it("defaults an unconfigured TorBox client to torrent-only, excluding it from usenet picks", () => {
    const clients = [{ type: "torbox", downloadTypes: null }] as any[];
    expect(pickClientForProtocol(clients, "torrent")?.type).toBe("torbox");
    expect(pickClientForProtocol(clients, "usenet")).toBeNull();
  });

  it("routes usenet releases to a TorBox client explicitly opted into Usenet", () => {
    const clients = [{ type: "sabnzbd", downloadTypes: null }, { type: "torbox", downloadTypes: ["usenet"] }] as any[];
    expect(pickClientForProtocol(clients, "usenet")?.type).toBe("sabnzbd"); // sabnzbd still wins by preference order
    expect(pickClientForProtocol([{ type: "torbox", downloadTypes: ["usenet"] }] as any[], "usenet")?.type).toBe("torbox");
    // A TorBox client scoped to usenet-only no longer matches a torrent release.
    expect(pickClientForProtocol([{ type: "torbox", downloadTypes: ["usenet"] }] as any[], "torrent")).toBeNull();
  });

  it("never routes usenet releases to Real-Debrid or AllDebrid, regardless of downloadTypes", () => {
    const clients = [{ type: "realdebrid", downloadTypes: ["usenet"] }, { type: "alldebrid", downloadTypes: ["usenet"] }] as any[];
    expect(pickClientForProtocol(clients, "usenet")).toBeNull();
  });
});

describe("grab", () => {
  it("adds the download, inserts queue and history rows, and notifies", async () => {
    const movie = await insertMovie();
    const client = await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);

    await grab(client, movie, null, null, { result: fakeResult(), quality: "WEBDL-1080p" });

    expect(adapter.addDownload).toHaveBeenCalledWith(client, fakeResult().downloadUrl, undefined, fakeResult().title, "torrent");
    const queueRow = (await db.prepare("SELECT * FROM queue WHERE media_item_id = ?").get(movie.id)) as any;
    expect(queueRow).toMatchObject({ download_id: "dl-1", quality: "WEBDL-1080p", status: "queued" });
    const historyRow = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").get(movie.id)) as any;
    expect(historyRow.event_type).toBe("grabbed");
    expect(notifyGrabbed).toHaveBeenCalledWith(movie.title, fakeResult().title);
  });
});

// ---------------------------------------------------------------------------
// searchAndGrabTargets (exercises chooseBestResult indirectly)
// ---------------------------------------------------------------------------

describe("searchAndGrabTargets", () => {
  it("reports an error for a target whose media item no longer exists", async () => {
    const results = await searchAndGrabTargets([{ mediaItemId: 999999 }]);
    expect(results).toEqual([{ mediaItemId: 999999, grabbed: false, error: "Media item not found" }]);
  });

  it("grabs the best result and reports grabbed:true", async () => {
    const movie = await insertMovie();
    const client = await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([fakeResult()]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result).toEqual({ mediaItemId: movie.id, grabbed: true });
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
  });

  it("reports 'No matching results' when nothing comes back from indexers", async () => {
    const movie = await insertMovie();
    searchAllIndexers.mockResolvedValue([]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result).toEqual({ mediaItemId: movie.id, grabbed: false, error: "No matching results" });
  });

  it("rejects a result whose quality isn't actually an upgrade over upgradeFromQuality", async () => {
    const movie = await insertMovie();
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.720p.WEB-DL" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id, upgradeFromQuality: "WEBDL-1080p" }]);

    expect(result.grabbed).toBe(false);
    expect(result.error).toContain("isn't an upgrade");
  });

  it("reports an error when no client speaks the winning result's protocol", async () => {
    const movie = await insertMovie();
    searchAllIndexers.mockResolvedValue([fakeResult()]);
    // No download clients inserted at all.

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result).toEqual({ mediaItemId: movie.id, grabbed: false, error: 'No "torrent" download client configured' });
  });

  it("never grabs a release that's in the item's blocklist", async () => {
    const movie = await insertMovie();
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    const blocked = fakeResult({ title: "Blocked.Release.1080p" });
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(movie.id, blocked.title);
    searchAllIndexers.mockResolvedValue([blocked]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result).toEqual({ mediaItemId: movie.id, grabbed: false, error: "No matching results" });
  });

  it("never rejects on size when no size bounds are configured for the quality (the default)", async () => {
    // sizeWithinQualityBounds only rejects when an admin has actually configured min/max bounds
    // for that quality (a settings-driven cache) — with nothing configured, a wildly implausible
    // size (a "1080p" release at 2KB) still isn't rejected on size grounds alone.
    const movie = await insertMovie();
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL", size: 2000 })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result.grabbed).toBe(true);
  });

  it("prefers the release with more seeders when qualities and format scores tie", async () => {
    const movie = await insertMovie();
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL", seeders: 5, downloadUrl: "magnet:?xt=low" }),
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL", seeders: 500, downloadUrl: "magnet:?xt=high" }),
    ]);

    await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    // category comes from the real DB-mapped client, which has no category set -> null, not
    // undefined; expect.anything() specifically excludes null, so it can't be used here either.
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=high");
  });

  it("builds an episode-shaped query and target for an episode grab", async () => {
    const show = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Breaking Bad','breaking bad',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    const epId = (
      await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,5,'Ep5',1,0)`).run(show)
    ).lastInsertRowid as number;
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Breaking.Bad.S01E05.1080p.WEB-DL" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: Number(show), episodeId: Number(epId) }]);

    expect(result.grabbed).toBe(true);
    expect(searchAllIndexers.mock.calls[0][1]).toBe("Breaking Bad S01E05");
  });

  it("continues past one target's exception and still reports the rest", async () => {
    // Branches on the query text rather than call order/mockRejectedValueOnce: both targets reach
    // searchAllIndexers exactly once each, but nothing guarantees the array order above is the
    // order the loop's awaits actually resolve the mock's queued once-values in.
    const willFail = await insertMovie({ title: "Will Fail", sort_title: "will fail" });
    const willSucceed = await insertMovie({ title: "Will Succeed", sort_title: "will succeed", year: 2001 });
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) => {
      if (query.startsWith("Will Fail")) throw new Error("indexer exploded");
      return [fakeResult()];
    });

    const results = await searchAndGrabTargets([{ mediaItemId: willFail.id }, { mediaItemId: willSucceed.id }]);

    expect(results[0]).toEqual({ mediaItemId: willFail.id, grabbed: false, error: "indexer exploded" });
    expect(results[1]).toEqual({ mediaItemId: willSucceed.id, grabbed: true });
  });
});

// ---------------------------------------------------------------------------
// runAutoSearch
// ---------------------------------------------------------------------------

describe("runAutoSearch", () => {
  it("skips entirely during configured quiet hours", async () => {
    setSetting("quietHoursEnabled", "1");
    setSetting("quietHoursStart", "00:00");
    setSetting("quietHoursEnd", "23:59");
    await insertMovie();
    await insertClient();

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
    setSetting("quietHoursEnabled", "0");
  });

  it("skips when no enabled download clients are configured", async () => {
    await insertMovie();

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("skips a movie whose root folder is over its configured quota", async () => {
    // isRootFolderOverQuota stats the real filesystem path directly (fs.statfsSync) — it has
    // nothing to do with the disk_usage_samples table (that only feeds checkHealthAndNotify's own,
    // separate low-disk-space warning) — and it also requires pause_grabs_at_quota to be truthy.
    const folderPath = "/quota-test-path";
    const folder = (
      await db.prepare("INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES (?, 'movie', 50, 1)").run(folderPath)
    ).lastInsertRowid as number;
    const originalStatfsSync = fs.statfsSync;
    vi.spyOn(fs, "statfsSync").mockImplementation((p: any, ...rest: any[]) =>
      p === folderPath ? ({ blocks: 1000, bsize: 1, bfree: 1 } as any) : (originalStatfsSync as any)(p, ...rest)
    );
    await insertMovie({ root_folder_id: Number(folder) });
    await insertClient();

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("skips a movie that already has a file or is already queued", async () => {
    await insertClient();
    const withFile = await insertMovie({ title: "Has File", sort_title: "has file", has_file: 1 });
    const queued = await insertMovie({ title: "Queued", sort_title: "queued" });
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'x', 'queued')").run(queued.id);

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("respects minimum availability before searching a movie", async () => {
    await insertClient();
    await insertMovie({ minimum_availability: "inCinemas", release_date: "2999-01-01" });

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("grabs a single-shape (movie) item when a result is found", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([fakeResult()]);
    await insertMovie();

    await runAutoSearch();

    expect(notifyGrabbed).toHaveBeenCalledTimes(1);
  });

  it("searches every monitored, fileless episode of a series independently", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([]);
    const showId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,3,'Ep3',1,1)`).run(showId); // already has file

    await runAutoSearch();

    expect(searchAllIndexers).toHaveBeenCalledTimes(2); // only the two fileless episodes
  });

  it("never searches a future-dated daily-series episode", async () => {
    await insertClient();
    const showId = (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, series_type, status) VALUES ('series','Show','show',1,0,'daily','missing')`)
        .run()
    ).lastInsertRowid as number;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?,1,1,'Ep1',1,0,?)`)
      .run(showId, tomorrow);

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("searches every monitored, fileless sub-item of a collection independently", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([]);
    const authorId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author','Author','author',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Book One', 1, 0)").run(authorId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Book Two', 1, 0)").run(authorId);

    await runAutoSearch();

    expect(searchAllIndexers).toHaveBeenCalledTimes(2);
  });

  it("grabs a YouTube video sub-item directly via yt-dlp, bypassing indexer search", async () => {
    const ytClient = await insertClient({ type: "ytdlp" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'A Video', 1, 0, 'youtube', 'abc123')")
      .run(channelId);

    await runAutoSearch();

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(adapter.addDownload).toHaveBeenCalledWith(expect.objectContaining({ id: ytClient.id }), "https://www.youtube.com/watch?v=abc123", null, "A Video", "http");
  });

  it("continues past one item's exception and still processes the rest", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([fakeResult()]);
    await insertMovie({ title: "Will Fail", sort_title: "aaa will fail" });
    await insertMovie({ title: "Will Succeed", sort_title: "zzz will succeed" });

    await runAutoSearch();

    expect(notifyGrabbed).toHaveBeenCalledTimes(1);
  });

  it("stops processing further items once the AbortSignal fires", async () => {
    await insertClient();
    await insertMovie({ title: "First", sort_title: "aaa first" });
    await insertMovie({ title: "Second", sort_title: "zzz second" });
    const controller = new AbortController();
    controller.abort();

    await runAutoSearch(controller.signal);

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runAutoUpgrade
// ---------------------------------------------------------------------------

describe("runAutoUpgrade", () => {
  it("does nothing when disabled (the default)", async () => {
    findUpgradeCandidates.mockResolvedValue([{ mediaItemId: 1, currentQuality: "SDTV", cutoff: "WEBDL-1080p", profileName: "P", target: "X" }]);

    await runAutoUpgrade();

    expect(findUpgradeCandidates).not.toHaveBeenCalled();
  });

  it("grabs an upgrade candidate when enabled", async () => {
    setSetting("autoUpgradeEnabled", "1");
    const movie = await insertMovie();
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    searchAllIndexers.mockResolvedValue([fakeResult()]);
    findUpgradeCandidates.mockResolvedValue([{ mediaItemId: movie.id, currentQuality: "SDTV", cutoff: "WEBDL-1080p", profileName: "P", target: movie.title }]);

    await runAutoUpgrade();

    expect(notifyGrabbed).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate that already has a grab in flight", async () => {
    setSetting("autoUpgradeEnabled", "1");
    const movie = await insertMovie();
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'x', 'downloading')").run(movie.id);
    findUpgradeCandidates.mockResolvedValue([{ mediaItemId: movie.id, currentQuality: "SDTV", cutoff: "WEBDL-1080p", profileName: "P", target: movie.title }]);

    await runAutoUpgrade();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkVideoChannels / checkPodcastFeeds
// ---------------------------------------------------------------------------

describe("checkVideoChannels", () => {
  it("inserts a new sub-item for each not-already-known video and grabs it when a yt-dlp client exists", async () => {
    const channelId = (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('video','Channel','channel',1,0,?,'missing')`)
        .run(JSON.stringify({ youtube: "UC123" }))
    ).lastInsertRowid as number;
    await insertClient({ type: "ytdlp" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    fetchCollectionChildrenFor.mockResolvedValue({ provider: "youtube", children: [{ title: "New Video", releaseDate: null, externalId: "vid1" }] });

    await checkVideoChannels();

    const subs = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(channelId)) as any[];
    expect(subs).toHaveLength(1);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
  });

  it("still records a new video without grabbing it when no yt-dlp client is configured", async () => {
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('video','Channel','channel',1,0,?,'missing')`)
      .run(JSON.stringify({ youtube: "UC123" }));
    fetchCollectionChildrenFor.mockResolvedValue({ provider: "youtube", children: [{ title: "New Video", releaseDate: null, externalId: "vid1" }] });

    await checkVideoChannels();

    expect(getDownloadClientAdapter).not.toHaveBeenCalled();
  });

  it("skips a channel with no youtube external id at all", async () => {
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('video','Channel','channel',1,0,'{}','missing')`)
      .run();

    await checkVideoChannels();

    expect(fetchCollectionChildrenFor).not.toHaveBeenCalled();
  });
});

describe("checkPodcastFeeds", () => {
  it("inserts a new episode and grabs it directly via its RSS enclosure URL", async () => {
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('podcast','Cast','cast',1,0,?,'missing')`)
      .run(JSON.stringify({ podcastFeed: "https://feed" }));
    await insertClient({ type: "http" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    fetchCollectionChildrenFor.mockResolvedValue({ provider: "rss", children: [{ title: "New Episode", releaseDate: null, externalId: "https://feed/ep1.mp3" }] });

    await checkPodcastFeeds();

    expect(adapter.addDownload).toHaveBeenCalledWith(expect.anything(), "https://feed/ep1.mp3", null, "New Episode");
  });
});

// ---------------------------------------------------------------------------
// pollQueue
// ---------------------------------------------------------------------------

describe("pollQueue", () => {
  async function insertQueueItem(clientId: number, overrides: Record<string, unknown> = {}): Promise<{ id: number; mediaItemId: number }> {
    const movie = await insertMovie({ title: `Movie ${Math.random()}`, sort_title: "x" });
    const row = { title: "Some Release", download_id: "dl-1", status: "downloading", progress: 0, ...overrides };
    const result = await db
      .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress) VALUES (?, ?, ?, ?, ?, ?)")
      .run(movie.id, row.title, clientId, row.download_id, row.status, row.progress);
    return { id: Number(result.lastInsertRowid), mediaItemId: movie.id };
  }

  it("updates progress/status for an active queue item and applies remote path mapping", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0.5, status: "downloading", remotePath: "/remote/x.mkv" }]) }));
    applyRemotePathMapping.mockResolvedValue("/local/x.mkv");
    const { id } = await insertQueueItem(client.id);

    await pollQueue();

    const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ progress: 0.5, status: "downloading", download_path: "/local/x.mkv" });
  });

  it("imports a completed download and removes the queue row on success", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 1, status: "completed" }]) }));
    importQueueItem.mockImplementation(async (queueId: number) => {
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId); // mimics the real importQueueItem's own behavior
    });
    const { id } = await insertQueueItem(client.id);

    await pollQueue();

    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)).toBeUndefined();
  });

  it("notifies for manual interaction (without retrying) when import is deliberately skipped", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 1, status: "completed" }]) }));
    importQueueItem.mockRejectedValue(new ImportSkippedError("no root folder configured"));
    await insertQueueItem(client.id);

    await pollQueue();

    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
    expect(searchAllIndexers).not.toHaveBeenCalled(); // no retry attempted
  });

  it("marks failed and retries when import fails for a real (non-skip) reason", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 1, status: "completed" }]) }));
    importQueueItem.mockRejectedValue(new Error("disk full"));
    searchAllIndexers.mockResolvedValue([]); // retry search comes up empty -> notifies instead of re-grabbing
    const { id } = await insertQueueItem(client.id);

    await pollQueue();

    const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)) as any;
    expect(row.status).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("removes the client-side download and retries when the client itself reports failure", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "failed" }]) }));
    setSetting("removeFailedDownloads", "1");
    searchAllIndexers.mockResolvedValue([]);
    await insertQueueItem(client.id);

    await pollQueue();

    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no active queue items at all", async () => {
    await insertClient();

    await pollQueue();

    expect(getDownloadClientAdapter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupStalledDownloads / pruneOldFailedQueueItems
// ---------------------------------------------------------------------------

describe("cleanupStalledDownloads", () => {
  it("fails and retries a download whose progress hasn't moved past the configured threshold", async () => {
    const client = await insertClient();
    const movie = await insertMovie();
    // SQLite-native date arithmetic, not a JS ISO string — the threshold query compares this
    // column against nowOffsetHoursExpr(db, ...)'s own SQL-generated value, and a JS
    // toISOString() ("...T...Z") doesn't lexicographically compare correctly against SQLite's own
    // "YYYY-MM-DD HH:MM:SS" datetime() format.
    const result = await db
      .prepare("INSERT INTO queue (media_item_id, title, download_client_id, status, last_progress_at) VALUES (?, 'x', ?, 'downloading', datetime('now', '-8 hours'))")
      .run(movie.id, client.id);
    const id = result.lastInsertRowid;
    searchAllIndexers.mockResolvedValue([]);

    await cleanupStalledDownloads();

    const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)) as any;
    expect(row.status).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("leaves a recently-progressing download alone", async () => {
    const client = await insertClient();
    const movie = await insertMovie();
    await db.prepare("INSERT INTO queue (media_item_id, title, download_client_id, status, last_progress_at) VALUES (?, 'x', ?, 'downloading', datetime('now'))").run(movie.id, client.id);

    await cleanupStalledDownloads();

    expect(notifyFailed).not.toHaveBeenCalled();
  });
});

describe("pruneOldFailedQueueItems", () => {
  it("removes a failed queue item untouched for over a week", async () => {
    const movie = await insertMovie();
    const weekAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const result = await db.prepare("INSERT INTO queue (media_item_id, title, status, updated_at) VALUES (?, 'x', 'failed', ?)").run(movie.id, weekAgo);

    await pruneOldFailedQueueItems();

    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid)).toBeUndefined();
  });

  it("leaves a recently-failed item in place", async () => {
    const movie = await insertMovie();
    const result = await db.prepare("INSERT INTO queue (media_item_id, title, status, updated_at) VALUES (?, 'x', 'failed', datetime('now'))").run(movie.id);

    await pruneOldFailedQueueItems();

    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// retryFailedGrab
// ---------------------------------------------------------------------------

describe("retryFailedGrab", () => {
  it("blocklists the release and grabs the next-best result", async () => {
    const movie = await insertMovie();
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "A.Different.Release.1080p" })]);
    const queueId = (await db.prepare("INSERT INTO queue (media_item_id, title, status, retry_count) VALUES (?, 'Bad.Release', 'failed', 0)").run(movie.id))
      .lastInsertRowid as number;

    await retryFailedGrab({ id: Number(queueId), mediaItemId: movie.id, title: "Bad.Release", episodeId: null, subItemId: null, retryCount: 0 } as any, "corrupt file");

    const blocklisted = (await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").get(movie.id)) as any;
    expect(blocklisted.release_title).toBe("Bad.Release");
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueId)).toBeUndefined(); // old row cleared
  });

  it("only blocklists and notifies (no retry) when failedDownloadBehavior is blocklistOnly", async () => {
    setSetting("failedDownloadBehavior", "blocklistOnly");
    const movie = await insertMovie();
    await retryFailedGrab({ id: 1, mediaItemId: movie.id, title: "Bad.Release", episodeId: null, subItemId: null, retryCount: 0 } as any, "corrupt file");

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the configured retry cap is reached", async () => {
    setSetting("maxAutoRetries", "1");
    const movie = await insertMovie();
    await retryFailedGrab({ id: 1, mediaItemId: movie.id, title: "Bad.Release", episodeId: null, subItemId: null, retryCount: 1 } as any, "corrupt file");

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("notifies instead of retrying when the retry search itself finds nothing", async () => {
    const movie = await insertMovie();
    searchAllIndexers.mockResolvedValue([]);

    await retryFailedGrab({ id: 1, mediaItemId: movie.id, title: "Bad.Release", episodeId: null, subItemId: null, retryCount: 0 } as any, "corrupt file");

    expect(notifyFailed).toHaveBeenCalledWith(movie.title, expect.stringContaining("no other releases found"));
  });
});

// ---------------------------------------------------------------------------
// checkHealthAndNotify
// ---------------------------------------------------------------------------

describe("checkHealthAndNotify", () => {
  it("notifies when a new issue appears, and does not re-notify for the same unchanged summary", async () => {
    checkIndexerHealth.mockResolvedValue({ ok: false });
    await db.prepare("INSERT INTO indexers (name, protocol, url, enabled) VALUES ('Bad Indexer', 'torznab', 'http://x', 1)").run();

    await checkHealthAndNotify();
    await checkHealthAndNotify();

    expect(notifyHealthIssue).toHaveBeenCalledTimes(1);
  });

  it("does not notify at all when nothing is wrong", async () => {
    await checkHealthAndNotify();
    expect(notifyHealthIssue).not.toHaveBeenCalled();
  });

  it("flags a root folder below its low-disk-space threshold", async () => {
    const folder = (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/x', 'movie')").run()).lastInsertRowid as number;
    await db.prepare("INSERT INTO disk_usage_samples (root_folder_id, free_bytes, total_bytes) VALUES (?, 1, 1000)").run(folder); // ~0% free

    await checkHealthAndNotify();

    expect(notifyHealthIssue).toHaveBeenCalledWith(expect.stringContaining("low on disk space"));
  });
});

// ---------------------------------------------------------------------------
// runSeedGoalCleanup
// ---------------------------------------------------------------------------

describe("runSeedGoalCleanup", () => {
  it("does nothing when no seed ratio/time goal is configured", async () => {
    await insertClient();
    await runSeedGoalCleanup();
    expect(getDownloadClientAdapter).not.toHaveBeenCalled();
  });

  it("calls removeSeededTorrents on every client that supports it, once a goal is configured", async () => {
    setSetting("torrentSeedRatioGoal", "2");
    await insertClient();
    const adapter = fakeAdapter({ removeSeededTorrents: vi.fn().mockResolvedValue(3) });
    getDownloadClientAdapter.mockReturnValue(adapter);

    await runSeedGoalCleanup();

    expect(adapter.removeSeededTorrents).toHaveBeenCalledWith(expect.anything(), 2, null);
    setSetting("torrentSeedRatioGoal", "");
  });
});

// ---------------------------------------------------------------------------
// startScheduler
// ---------------------------------------------------------------------------

describe("startScheduler", () => {
  it("registers a substantial set of jobs and starts them exactly once", () => {
    startScheduler();
    startScheduler(); // second call must be a no-op (the `started` guard)

    expect(registerJob.mock.calls.length).toBeGreaterThan(20); // one call per job; the second startScheduler() call registered nothing more
    expect(startAllJobs).toHaveBeenCalledTimes(1);
    const keys = registerJob.mock.calls.map((c) => c[0].key);
    expect(new Set(keys).size).toBe(keys.length); // every job key is unique
    expect(keys).toContain("autoSearch");
    expect(keys).toContain("queuePoll");
  });
});
