import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";
import { nowExpr, nowOffsetHoursExpr } from "../src/db/asyncDb.js";

const searchAllIndexers = vi.fn();
const checkIndexerHealth = vi.fn();
vi.mock("../src/services/indexerClient.js", () => ({
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
  checkIndexerHealth: (...args: unknown[]) => checkIndexerHealth(...args),
}));

const getDownloadClientAdapter = vi.fn();
const removeQueueItemDownload = vi.fn();
const applyRemotePathMapping = vi.fn();
const withQueueImportLock = vi.fn();
const { DOWNLOAD_INTERRUPTED_REASON } = vi.hoisted(() => ({ DOWNLOAD_INTERRUPTED_REASON: "Download was interrupted by an AoNarr restart" }));
vi.mock("../src/services/downloadClient.js", () => ({
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
  applyRemotePathMapping: (...args: unknown[]) => applyRemotePathMapping(...args),
  withQueueImportLock: (...args: unknown[]) => withQueueImportLock(...args),
  DOWNLOAD_INTERRUPTED_REASON,
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
vi.mock("../src/services/upgradeCandidates.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findUpgradeCandidates: (...args: unknown[]) => findUpgradeCandidates(...args),
}));

const registerJob = vi.fn();
const startAllJobs = vi.fn();
// Every job definition ever registered, by key: startScheduler registers them only once per module.
const registeredJobs = new Map<string, { run: (signal?: AbortSignal) => Promise<unknown> }>();
vi.mock("../src/services/jobRegistry.js", () => ({
  registerJob: (...args: unknown[]) => {
    const def = args[0] as { key: string; run: (signal?: AbortSignal) => Promise<unknown> };
    registeredJobs.set(def.key, def);
    return registerJob(...args);
  },
  startAllJobs: (...args: unknown[]) => startAllJobs(...args),
}));

const runTraktSync = vi.fn();
vi.mock("../src/services/traktSync.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  runTraktSync: (...args: unknown[]) => runTraktSync(...args),
}));

const runPlexWatchlistSync = vi.fn();
vi.mock("../src/services/plexWatchlistSync.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  runPlexWatchlistSync: (...args: unknown[]) => runPlexWatchlistSync(...args),
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
let chooseBestResult: (typeof import("../src/services/scheduler.js"))["chooseBestResult"];
let matchTierFor: (typeof import("../src/services/scheduler.js"))["matchTierFor"];
let autoSearchCronSchedule: (typeof import("../src/services/scheduler.js"))["autoSearchCronSchedule"];

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
    chooseBestResult,
    matchTierFor,
    autoSearchCronSchedule,
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
  withQueueImportLock.mockReset().mockImplementation(async (_queueId: number, importFn: () => Promise<void>) => {
    await importFn();
    return true;
  });
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

async function insertSeries(title = "Show", seriesType: string | null = null): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, series_type, status) VALUES ('series', ?, ?, 1, 0, ?, 'missing')`)
    .run(title, title.toLowerCase(), seriesType);
  return Number(result.lastInsertRowid);
}

async function insertEpisode(showId: number, season: number, episode: number, airDate: string | null = null): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, ?, ?, 'Ep', 1, 0, ?)`)
    .run(showId, season, episode, airDate);
  return Number(result.lastInsertRowid);
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

  it("'released' prefers a real digital/physical date over the flat delay approximation, even when the approximation would already be satisfied", () => {
    setSetting("minimumAvailabilityReleasedDelayDays", "90");
    const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString(); // delay-based threshold already passed
    const futureDigital = new Date(Date.now() + 5 * 86_400_000).toISOString(); // but TMDB's own digital date hasn't arrived yet
    expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: longAgo, digitalReleaseDate: futureDigital } as any)).toBe(
      false
    );
  });

  it("'released' becomes available once the real digital date passes, even if the flat delay approximation wouldn't have allowed it yet", () => {
    setSetting("minimumAvailabilityReleasedDelayDays", "90");
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString(); // delay-based threshold NOT yet passed
    const pastDigital = new Date(Date.now() - 1 * 86_400_000).toISOString();
    expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: recent, digitalReleaseDate: pastDigital } as any)).toBe(
      true
    );
  });

  it("'released' uses the earliest of digital/physical when both are present", () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const earlyPhysical = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const laterDigital = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      isReleaseAvailableForSearch({
        minimumAvailability: "released",
        releaseDate: recent,
        digitalReleaseDate: laterDigital,
        physicalReleaseDate: earlyPhysical,
      } as any)
    ).toBe(true); // physical already passed, even though digital hasn't
  });

  it("'released' falls back to the flat delay approximation when TMDB has neither digital nor physical date for this movie", () => {
    setSetting("minimumAvailabilityReleasedDelayDays", "90");
    const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
    expect(
      isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: longAgo, digitalReleaseDate: null, physicalReleaseDate: null } as any)
    ).toBe(true);
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

  it("treats an in-flight season pack as covering every episode of that season only", async () => {
    const showId = await insertSeries();
    const s1e1 = await insertEpisode(showId, 1, 1);
    const s2e1 = await insertEpisode(showId, 2, 1);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 1, 'Show.S01.1080p.WEB-DL', 'downloading')").run(showId);

    expect(await isAlreadyQueued(showId, s1e1, null)).toBe(true);
    expect(await isAlreadyQueued(showId, s2e1, null)).toBe(false);
  });

  it("ignores a season pack that has already failed", async () => {
    const showId = await insertSeries();
    const s1e1 = await insertEpisode(showId, 1, 1);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 1, 'Show.S01.1080p.WEB-DL', 'failed')").run(showId);

    expect(await isAlreadyQueued(showId, s1e1, null)).toBe(false);
  });

  it("counts a single-episode release grabbed from a season search as covering only that episode", async () => {
    const showId = await insertSeries();
    const s2e5 = await insertEpisode(showId, 2, 5);
    const s2e6 = await insertEpisode(showId, 2, 6);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 2, 'Show.S02E05.1080p.WEB-DL', 'queued')").run(showId);

    expect(await isAlreadyQueued(showId, s2e5, null)).toBe(true);
    expect(await isAlreadyQueued(showId, s2e6, null)).toBe(false);
  });

  it("treats a season pack grabbed for one episode as covering the rest of its season", async () => {
    const showId = await insertSeries();
    const s1e1 = await insertEpisode(showId, 1, 1);
    const s1e2 = await insertEpisode(showId, 1, 2);
    const s2e1 = await insertEpisode(showId, 2, 1);
    await db
      .prepare("INSERT INTO queue (media_item_id, episode_id, season_number, title, status) VALUES (?, ?, 1, 'Show.S01.1080p.WEB-DL', 'downloading')")
      .run(showId, s1e1);

    expect(await isAlreadyQueued(showId, s1e2, null)).toBe(true);
    expect(await isAlreadyQueued(showId, s2e1, null)).toBe(false);
  });

  it("doesn't count another season's pack recorded against this season as covering it", async () => {
    const showId = await insertSeries();
    const s1e1 = await insertEpisode(showId, 1, 1);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 1, 'Show.S02.1080p.WEB-DL', 'queued')").run(showId);

    expect(await isAlreadyQueued(showId, s1e1, null)).toBe(false);
  });

  it("counts a queued ranged batch as covering only the episodes in its range", async () => {
    const showId = await insertSeries();
    const s2e3 = await insertEpisode(showId, 2, 3);
    const s2e14 = await insertEpisode(showId, 2, 14);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 2, '[Group] Show S2 - 13-24 [1080p]', 'queued')").run(showId);

    expect(await isAlreadyQueued(showId, s2e14, null)).toBe(true);
    expect(await isAlreadyQueued(showId, s2e3, null)).toBe(false);
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

  it("records the season of a full-season pack grabbed for one episode, but not of a single-episode release", async () => {
    const showId = await insertSeries();
    const s3e1 = await insertEpisode(showId, 3, 1);
    const s3e2 = await insertEpisode(showId, 3, 2);
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    const show = { id: showId, title: "Show" } as any;

    const adapter = fakeAdapter();
    adapter.addDownload.mockResolvedValueOnce({ downloadId: "dl-single" }).mockResolvedValueOnce({ downloadId: "dl-pack" });
    getDownloadClientAdapter.mockReturnValue(adapter);
    await grab(client, show, s3e2, null, { result: fakeResult({ title: "Show.S03E02.1080p.WEB-DL-GRP" }), quality: "WEBDL-1080p" });
    await grab(client, show, s3e1, null, { result: fakeResult({ title: "Show.S03.1080p.WEB-DL-GRP" }), quality: "WEBDL-1080p" });

    const rows = (await db.prepare("SELECT episode_id, season_number FROM queue WHERE media_item_id = ? ORDER BY id").all(showId)) as any[];
    expect(rows).toEqual([
      { episode_id: s3e2, season_number: null },
      { episode_id: s3e1, season_number: 3 },
    ]);
  });

  it("sends a season pack chosen for several sibling episodes at once only once", async () => {
    const showId = await insertSeries();
    const episodes = [await insertEpisode(showId, 1, 1), await insertEpisode(showId, 1, 2), await insertEpisode(showId, 1, 3)];
    const client = await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const show = { id: showId, title: "Show" } as any;
    const pack = { result: fakeResult({ title: "Show.S01.1080p.BluRay-GRP" }), quality: "Bluray-1080p" };

    const outcomes = await Promise.all(episodes.map((epId) => grab(client, show, epId, null, pack)));

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    const rows = (await db.prepare("SELECT season_number FROM queue WHERE media_item_id = ?").all(showId)) as any[];
    expect(rows).toEqual([{ season_number: 1 }]);
  });

  it("records no second queue row when the client hands back a download another active row already tracks", async () => {
    const first = await insertMovie({ title: "First", sort_title: "first" });
    const second = await insertMovie({ title: "Second", sort_title: "second" });
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ addDownload: vi.fn().mockResolvedValue({ downloadId: "same-hash" }) }));

    expect(await grab(client, first, null, null, { result: fakeResult(), quality: "WEBDL-1080p" })).toBe(true);
    expect(await grab(client, second, null, null, { result: fakeResult(), quality: "WEBDL-1080p" })).toBe(false);

    const rows = (await db.prepare("SELECT media_item_id FROM queue WHERE download_id = 'same-hash'").all()) as any[];
    expect(rows).toEqual([{ media_item_id: first.id }]);
  });

  it("stores an unusable size as NULL and rounds a fractional one, so the insert can't fail on Postgres", async () => {
    const nanMovie = await insertMovie({ title: "NaN Size", sort_title: "nan size" });
    const fractionMovie = await insertMovie({ title: "Fraction Size", sort_title: "fraction size" });
    const client = await insertClient();
    const adapter = fakeAdapter();
    adapter.addDownload.mockResolvedValueOnce({ downloadId: "dl-nan" }).mockResolvedValueOnce({ downloadId: "dl-fraction" });
    getDownloadClientAdapter.mockReturnValue(adapter);

    await grab(client, nanMovie, null, null, { result: fakeResult({ size: Number.NaN }), quality: "WEBDL-1080p" });
    await grab(client, fractionMovie, null, null, { result: fakeResult({ size: 1_400_000_000.6 }), quality: "WEBDL-1080p" });

    const nanRow = (await db.prepare("SELECT size FROM queue WHERE download_id = 'dl-nan'").get()) as any;
    const fractionRow = (await db.prepare("SELECT size FROM queue WHERE download_id = 'dl-fraction'").get()) as any;
    expect(nanRow.size).toBeNull();
    expect(Number(fractionRow.size)).toBe(1_400_000_001);
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
    await insertClient();
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.720p.WEB-DL" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id, upgradeFromQuality: "WEBDL-1080p" }]);

    expect(result.grabbed).toBe(false);
    expect(result.error).toBe("No release found that's an upgrade over WEBDL-1080p");
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

  it("searches a daily series' episode by air date and grabs a date-named release", async () => {
    const showId = await insertSeries("Daily Show", "daily");
    const epId = await insertEpisode(showId, 2024, 101, "2024-08-25");
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Daily.Show.2024.08.24.1080p.WEB-DL-GRP", seeders: 500, downloadUrl: "magnet:?xt=wrong-day" }),
      fakeResult({ title: "Daily.Show.2024.08.25.1080p.WEB-DL-GRP", seeders: 5, downloadUrl: "magnet:?xt=right-day" }),
    ]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: showId, episodeId: epId }]);

    expect(result.grabbed).toBe(true);
    expect(searchAllIndexers.mock.calls[0][1]).toBe("Daily Show 2024-08-25");
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=right-day");
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
      p === folderPath ? ({ blocks: 1000, bsize: 1, bfree: 1, bavail: 1 } as any) : (originalStatfsSync as any)(p, ...rest)
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

  it("doesn't re-grab a YouTube video whose direct grab failed and was blocklisted within the last day", async () => {
    await insertClient({ type: "ytdlp" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Members Only', 1, 0, 'youtube', 'locked1')")
      .run(channelId);
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Public Video', 1, 0, 'youtube', 'open1')")
      .run(channelId);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Members Only')").run(channelId);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("https://www.youtube.com/watch?v=open1");
  });

  it("doesn't re-grab a podcast episode whose enclosure download failed and was blocklisted within the last day", async () => {
    await insertClient({ type: "http" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const podcastId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('podcast','Cast','cast',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Dead Link', 1, 0, 'rss', 'https://cdn/gone.mp3')")
      .run(podcastId);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Dead Link')").run(podcastId);

    await runAutoSearch();

    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("retries a failed direct grab once its blocklist entry is over a day old", async () => {
    await insertClient({ type: "ytdlp" });
    await insertClient({ type: "http" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Failed During Outage', 1, 0, 'youtube', 'vid9')")
      .run(channelId);
    const podcastId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('podcast','Cast','cast',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'CDN Hiccup', 1, 0, 'rss', 'https://cdn/ep9.mp3')")
      .run(podcastId);
    for (const [mediaItemId, title] of [
      [channelId, "Failed During Outage"],
      [podcastId, "CDN Hiccup"],
    ] as const) {
      await db
        .prepare(`INSERT INTO blocklist (media_item_id, release_title, reason, created_at) VALUES (?, ?, 'Download failed at the download client', ${nowOffsetHoursExpr(db, -25)})`)
        .run(mediaItemId, title);
    }

    await runAutoSearch();

    const grabbedUrls = adapter.addDownload.mock.calls.map((c: any[]) => c[1]);
    expect(grabbedUrls).toEqual(expect.arrayContaining(["https://www.youtube.com/watch?v=vid9", "https://cdn/ep9.mp3"]));
    expect(grabbedUrls).toHaveLength(2);
  });

  it("keeps honouring an admin's own blocklisting of a video or episode however old it is", async () => {
    await insertClient({ type: "ytdlp" });
    await insertClient({ type: "http" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Unwanted Upload', 1, 0, 'youtube', 'vid10')")
      .run(channelId);
    const podcastId = (
      await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('podcast','Cast','cast',1,0,'missing')`).run()
    ).lastInsertRowid as number;
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Unwanted Episode', 1, 0, 'rss', 'https://cdn/ep10.mp3')")
      .run(podcastId);
    await db
      .prepare(`INSERT INTO blocklist (media_item_id, release_title, created_at) VALUES (?, 'Unwanted Upload', ${nowOffsetHoursExpr(db, -72)})`)
      .run(channelId);
    await db
      .prepare(`INSERT INTO blocklist (media_item_id, release_title, reason, created_at) VALUES (?, 'Unwanted Episode', 'Removed from queue by admin', ${nowOffsetHoursExpr(db, -72)})`)
      .run(podcastId);

    await runAutoSearch();

    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("doesn't search episodes of a season whose pack is already downloading", async () => {
    await insertClient();
    const showId = await insertSeries();
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    await insertEpisode(showId, 2, 1);
    await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status) VALUES (?, 1, 'Show.S01.1080p.WEB-DL', 'downloading')").run(showId);

    await runAutoSearch();

    expect(searchAllIndexers).toHaveBeenCalledTimes(1);
    expect(searchAllIndexers.mock.calls[0][1]).toBe("Show S02E01");
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

  async function insertPodcast(): Promise<number> {
    return Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('podcast','Cast','cast',1,0,?,'missing')`)
          .run(JSON.stringify({ podcastFeed: "https://feed" }))
      ).lastInsertRowid
    );
  }

  async function insertPodcastEpisode(podcastId: number, title: string, releaseDate: string, url: string): Promise<void> {
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored, has_file) VALUES (?, ?, ?, ?, 'rss', 1, 1)")
      .run(podcastId, title, releaseDate, url);
  }

  async function podcastEpisodes(podcastId: number): Promise<{ title: string; external_id: string }[]> {
    return (await db.prepare("SELECT title, external_id FROM sub_items WHERE media_item_id = ? ORDER BY external_id").all(podcastId)) as any[];
  }

  it("re-keys episodes whose enclosure URLs all changed instead of adding and downloading them again", async () => {
    const podcastId = await insertPodcast();
    await insertClient({ type: "http" });
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    await insertPodcastEpisode(podcastId, "Episode 1", "2024-01-01", "https://old.example/ep1.mp3");
    await insertPodcastEpisode(podcastId, "Episode 2", "2024-01-08", "https://old.example/ep2.mp3");
    fetchCollectionChildrenFor.mockResolvedValue({
      provider: "rss",
      children: [
        { title: "Episode 1", releaseDate: "2024-01-01", externalId: "https://tracker.example/new.example/ep1.mp3?stamp=2" },
        { title: "Episode 2", releaseDate: "2024-01-08", externalId: "https://tracker.example/new.example/ep2.mp3?stamp=2" },
      ],
    });

    await checkPodcastFeeds();

    expect(await podcastEpisodes(podcastId)).toEqual([
      { title: "Episode 1", external_id: "https://tracker.example/new.example/ep1.mp3?stamp=2" },
      { title: "Episode 2", external_id: "https://tracker.example/new.example/ep2.mp3?stamp=2" },
    ]);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("still adds and downloads a genuinely new episode, and keeps two same-titled episodes of one day apart", async () => {
    const podcastId = await insertPodcast();
    await insertClient({ type: "http" });
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    await insertPodcastEpisode(podcastId, "Bonus", "2024-02-01", "https://feed/bonus-a.mp3");
    fetchCollectionChildrenFor.mockResolvedValue({
      provider: "rss",
      children: [
        { title: "Bonus", releaseDate: "2024-02-01", externalId: "https://feed/bonus-a.mp3" },
        { title: "Bonus", releaseDate: "2024-02-01", externalId: "https://feed/bonus-b.mp3" },
        { title: "Episode 3", releaseDate: "2024-02-02", externalId: "https://feed/ep3.mp3" },
      ],
    });

    await checkPodcastFeeds();

    expect(await podcastEpisodes(podcastId)).toEqual([
      { title: "Bonus", external_id: "https://feed/bonus-a.mp3" },
      { title: "Bonus", external_id: "https://feed/bonus-b.mp3" },
      { title: "Episode 3", external_id: "https://feed/ep3.mp3" },
    ]);
    expect(adapter.addDownload.mock.calls.map((c) => c[1])).toEqual(["https://feed/bonus-b.mp3", "https://feed/ep3.mp3"]);
  });
});

describe("checkVideoChannels / checkPodcastFeeds — ids merged in from other providers", () => {
  it("lists a channel or playlist by its own ids, never by one merged in from another provider", async () => {
    const insertVideo = (title: string, externalIds: Record<string, string>, merged: Record<string, string>) =>
      db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, extra_metadata, status) VALUES ('video', ?, ?, 1, 0, ?, ?, 'missing')`)
        .run(title, title.toLowerCase(), JSON.stringify(externalIds), JSON.stringify({ additionalProviderIds: merged }));
    await insertVideo("Vimeo Channel", { vimeo: "vimeo-channel", youtube: "UCmerged" }, { youtube: "UCmerged" });
    await insertVideo("Playlist", { youtubePlaylist: "PL1", youtube: "UCsameName" }, { youtube: "UCsameName" });

    await checkVideoChannels();

    expect(fetchCollectionChildrenFor.mock.calls.map((c) => c[0])).toEqual([{ youtubePlaylist: "PL1" }]);
  });

  it("skips a channel whose external ids aren't valid JSON", async () => {
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('video','Broken','broken',1,0,'{not json','missing')`)
      .run();
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('podcast','Broken Cast','broken cast',1,0,'{not json','missing')`)
      .run();

    await checkVideoChannels();
    await checkPodcastFeeds();

    expect(fetchCollectionChildrenFor).not.toHaveBeenCalled();
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

  it("re-grabs a download a restart cut off without blocklisting it or using up a retry", async () => {
    const client = await insertClient({ type: "http" });
    const adapter = fakeAdapter({
      addDownload: vi.fn().mockResolvedValue({ downloadId: "dl-2" }),
      getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "failed", failureReason: DOWNLOAD_INTERRUPTED_REASON }]),
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    setSetting("removeFailedDownloads", "1");
    const release = "The.Matrix.1999.1080p.WEB-DL-RESTARTED";
    searchAllIndexers.mockResolvedValue([fakeResult({ title: release, protocol: "http", seeders: null, downloadUrl: "https://ddl.example/matrix.mkv" })]);
    const movie = await insertMovie();
    // Already at the retry cap: an interruption isn't the release failing, so it doesn't count.
    await db
      .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, retry_count) VALUES (?, ?, ?, 'dl-1', 'downloading', 0.4, 2)")
      .run(movie.id, release, client.id);

    await pollQueue();

    expect(await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").all(movie.id)).toEqual([]);
    expect(await db.prepare("SELECT * FROM release_group_stats WHERE LOWER(release_group) LIKE '%restarted%'").all()).toEqual([]);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("https://ddl.example/matrix.mkv");
    const rows = (await db.prepare("SELECT title, download_id, status, retry_count FROM queue WHERE media_item_id = ?").all(movie.id)) as any[];
    expect(rows).toEqual([{ title: release, download_id: "dl-2", status: "queued", retry_count: 2 }]);
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("does nothing when there are no active queue items at all", async () => {
    await insertClient();

    await pollQueue();

    expect(getDownloadClientAdapter).not.toHaveBeenCalled();
  });

  it("rewrites a provisional download id to the one the client resolved it to", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({
        getStatus: vi.fn().mockResolvedValue([{ downloadId: "tag:aonarr-pending-abc", resolvedDownloadId: "c12fe1c06bba254a9dc9f519b335aa7c1367a88a", progress: 0.2, status: "downloading" }]),
      })
    );
    const { id } = await insertQueueItem(client.id, { download_id: "tag:aonarr-pending-abc" });

    await pollQueue();

    const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ download_id: "c12fe1c06bba254a9dc9f519b335aa7c1367a88a", progress: 0.2 });
  });

  it("fails and retries a qBittorrent add whose placeholder id never resolved within 30 minutes", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([]) }));
    const stuck = await insertMovie({ title: "Stuck", sort_title: "stuck" });
    const fresh = await insertMovie({ title: "Fresh", sort_title: "fresh" });
    const stuckId = Number(
      (
        await db
          .prepare(
            `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, added_at) VALUES (?, 'Stuck.2020.1080p', ?, 'tag:aonarr-pending-old', 'queued', ${nowOffsetHoursExpr(db, -1)})`
          )
          .run(stuck.id, client.id)
      ).lastInsertRowid
    );
    const freshId = Number(
      (
        await db
          .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status) VALUES (?, 'Fresh.2020.1080p', ?, 'tag:aonarr-pending-new', 'queued')")
          .run(fresh.id, client.id)
      ).lastInsertRowid
    );

    await pollQueue();

    expect(((await db.prepare("SELECT status FROM queue WHERE id = ?").get(stuckId)) as any).status).toBe("failed");
    expect(((await db.prepare("SELECT status FROM queue WHERE id = ?").get(freshId)) as any).status).toBe("queued");
    const blocklisted = (await db.prepare("SELECT release_title FROM blocklist WHERE media_item_id = ?").all(stuck.id)) as any[];
    expect(blocklisted).toEqual([{ release_title: "Stuck.2020.1080p" }]);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("re-keys an unresolved placeholder to a torrent qBittorrent already has under the release's name", async () => {
    const client = await insertClient();
    const hash = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: hash, clientTitle: "Seeding.Show.S01.1080p", progress: 1, status: "completed" }]) })
    );
    const show = await insertMovie({ title: "Seeding", sort_title: "seeding" });
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, added_at) VALUES (?, 'Seeding.Show.S01.1080p', ?, 'tag:aonarr-pending-dupe', 'queued', ${nowOffsetHoursExpr(db, -1)})`
          )
          .run(show.id, client.id)
      ).lastInsertRowid
    );

    await pollQueue();

    expect(await db.prepare("SELECT download_id, status FROM queue WHERE id = ?").get(id)).toEqual({ download_id: hash, status: "queued" });
    expect(await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").all(show.id)).toEqual([]);
  });

  it("fails a legacy .torrent-URL-keyed row it can't find, without blocklisting or re-grabbing", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([]) }));
    const movie = await insertMovie({ title: "Legacy", sort_title: "legacy" });
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, added_at) VALUES (?, 'Legacy.2020.1080p', ?, 'https://indexer.example/dl/1.torrent', 'queued', ${nowOffsetHoursExpr(db, -48)})`
          )
          .run(movie.id, client.id)
      ).lastInsertRowid
    );

    await pollQueue();

    expect(((await db.prepare("SELECT status FROM queue WHERE id = ?").get(id)) as any).status).toBe("failed");
    expect(await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").all(movie.id)).toEqual([]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupStalledDownloads / pruneOldFailedQueueItems
// ---------------------------------------------------------------------------

describe("cleanupStalledDownloads", () => {
  it("fails and retries a download whose progress hasn't moved past the configured threshold", async () => {
    const client = await insertClient();
    const movie = await insertMovie();
    // Dialect-native date arithmetic, not a JS ISO string — the threshold query compares this
    // column against nowOffsetHoursExpr(db, ...)'s own SQL-generated value, and a JS toISOString()
    // ("...T...Z") doesn't lexicographically compare correctly against either dialect's own
    // "YYYY-MM-DD HH:MM:SS" text format.
    const result = await db
      .prepare(
        `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, last_progress_at) VALUES (?, 'x', ?, 'dl-1', 'downloading', 0.3, ${nowOffsetHoursExpr(db, -8)})`
      )
      .run(movie.id, client.id);
    const id = result.lastInsertRowid;
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0.3, status: "downloading" }]) }));
    searchAllIndexers.mockResolvedValue([]);

    await cleanupStalledDownloads();

    const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(id)) as any;
    expect(row.status).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("counts rows stalled on one shared download as one failure of its release, and still re-searches each row's target", async () => {
    const client = await insertClient();
    setSetting("removeFailedDownloads", "1");
    const release = "Some.Release.2020.1080p.WEB-DL-STALLEDSHARED";
    const movie = await insertMovie();
    const otherMovie = await insertMovie({ title: "Heat", sort_title: "heat", year: 1995 });
    const insertRow = async (mediaItemId: number) =>
      Number(
        (
          await db
            .prepare(
              `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, last_progress_at) VALUES (?, ?, ?, 'dl-shared', 'downloading', 0.3, ${nowOffsetHoursExpr(db, -8)})`
            )
            .run(mediaItemId, release, client.id)
        ).lastInsertRowid
      );
    const rows = [await insertRow(movie.id), await insertRow(otherMovie.id)];
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-shared", progress: 0.3, status: "downloading" }]) }));

    await cleanupStalledDownloads();

    for (const id of rows) expect(await queueStatus(id)).toBe("failed");
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(await blocklistedTitles(movie.id)).toEqual([release]);
    expect(await blocklistedTitles(otherMovie.id)).toEqual([release]);
    const stats = (await db.prepare("SELECT failures FROM release_group_stats WHERE LOWER(release_group) LIKE '%stalledshared%'").all()) as { failures: number }[];
    expect(stats.map((s) => Number(s.failures))).toEqual([1]);
    expect(searchAllIndexers).toHaveBeenCalledTimes(2);
  });

  it("leaves a recently-progressing download alone", async () => {
    const client = await insertClient();
    const movie = await insertMovie();
    await db
      .prepare(`INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, last_progress_at) VALUES (?, 'x', ?, 'dl-1', 'downloading', ${nowExpr(db)})`)
      .run(movie.id, client.id);

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
    const result = await db.prepare(`INSERT INTO queue (media_item_id, title, status, updated_at) VALUES (?, 'x', 'failed', ${nowExpr(db)})`).run(movie.id);

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

  it("replaces a failed season pack only with another full pack of the same season, keeping its season number", async () => {
    const showId = await insertSeries();
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Show.S04E07.1080p.WEB-DL-GRP", seeders: 1000, downloadUrl: "magnet:?xt=other-episode" }),
      fakeResult({ title: "Show.S02E03.1080p.WEB-DL-GRP", seeders: 900, downloadUrl: "magnet:?xt=single-episode" }),
      fakeResult({ title: "Show.S03.1080p.WEB-DL-GRP", seeders: 800, downloadUrl: "magnet:?xt=other-season" }),
      fakeResult({ title: "Show.S02.1080p.WEB-DL-GOOD", seeders: 5, downloadUrl: "magnet:?xt=right-pack" }),
    ]);
    const queueId = Number(
      (await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status, retry_count) VALUES (?, 2, 'Show.S02.1080p.WEB-DL-BAD', 'failed', 0)").run(showId))
        .lastInsertRowid
    );

    await retryFailedGrab(
      { id: queueId, mediaItemId: showId, title: "Show.S02.1080p.WEB-DL-BAD", episodeId: null, subItemId: null, seasonNumber: 2, retryCount: 0 } as any,
      "No matching file found"
    );

    expect(searchAllIndexers.mock.calls[0][1]).toBe("Show S02");
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=right-pack");
    const rows = (await db.prepare("SELECT * FROM queue WHERE media_item_id = ?").all(showId)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Show.S02.1080p.WEB-DL-GOOD", season_number: 2, episode_id: null, sub_item_id: null, retry_count: 1 });
  });

  it("notifies rather than grabbing an unrelated episode when no replacement season pack exists", async () => {
    const showId = await insertSeries();
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Show.S04E07.2160p.WEB-DL-GRP" })]);

    await retryFailedGrab(
      { id: 1, mediaItemId: showId, title: "Show.S02.1080p.WEB-DL-BAD", episodeId: null, subItemId: null, seasonNumber: 2, retryCount: 0 } as any,
      "Download failed at the download client"
    );

    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith("Show", expect.stringContaining("no other releases found"));
  });

  it("replaces a failed single-episode grab from a season search with another release of that episode", async () => {
    const showId = await insertSeries();
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Show.S02E06.1080p.WEB-DL-GRP", seeders: 1000, downloadUrl: "magnet:?xt=next-episode" }),
      fakeResult({ title: "Show.S03E05.1080p.WEB-DL-GRP", seeders: 900, downloadUrl: "magnet:?xt=other-season" }),
      fakeResult({ title: "Show.S02E05.1080p.WEB-DL-GOOD", seeders: 5, downloadUrl: "magnet:?xt=same-episode" }),
    ]);
    const queueId = Number(
      (await db.prepare("INSERT INTO queue (media_item_id, season_number, title, status, retry_count) VALUES (?, 2, 'Show.S02E05.1080p.WEB-DL-BAD', 'failed', 0)").run(showId))
        .lastInsertRowid
    );

    await retryFailedGrab(
      { id: queueId, mediaItemId: showId, title: "Show.S02E05.1080p.WEB-DL-BAD", episodeId: null, subItemId: null, seasonNumber: 2, retryCount: 0 } as any,
      "Download failed at the download client"
    );

    expect(searchAllIndexers.mock.calls[0][1]).toBe("Show S02E05");
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=same-episode");
    const rows = (await db.prepare("SELECT * FROM queue WHERE media_item_id = ?").all(showId)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Show.S02E05.1080p.WEB-DL-GOOD", season_number: 2, episode_id: null });
  });

  it("retries a failed daily-series episode by air date", async () => {
    const showId = await insertSeries("Daily Show", "daily");
    const epId = await insertEpisode(showId, 2024, 101, "2024-08-25");
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Daily.Show.2024.08.25.720p.WEB-DL-OTHER" })]);

    await retryFailedGrab(
      { id: 1, mediaItemId: showId, title: "Daily.Show.2024.08.25.1080p.WEB-DL-BAD", episodeId: epId, subItemId: null, seasonNumber: null, retryCount: 0 } as any,
      "corrupt file"
    );

    expect(searchAllIndexers.mock.calls[0][1]).toBe("Daily Show 2024-08-25");
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
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

describe("autoSearchCronSchedule", () => {
  it("keeps sub-hour intervals that divide an hour evenly in the minute field", () => {
    expect(autoSearchCronSchedule(30)).toBe("*/30 * * * *");
    expect(autoSearchCronSchedule(15)).toBe("*/15 * * * *");
  });

  it("moves intervals of an hour or more into the hour field instead of collapsing them to hourly", () => {
    expect(autoSearchCronSchedule(60)).toBe("0 */1 * * *");
    expect(autoSearchCronSchedule(120)).toBe("0 */2 * * *");
    expect(autoSearchCronSchedule(360)).toBe("0 */6 * * *");
  });

  it("rounds an interval its field can't divide evenly up, never down", () => {
    expect(autoSearchCronSchedule(7)).toBe("*/10 * * * *");
    expect(autoSearchCronSchedule(45)).toBe("0 */1 * * *");
    expect(autoSearchCronSchedule(90)).toBe("0 */2 * * *");
    expect(autoSearchCronSchedule(300)).toBe("0 */6 * * *");
  });

  it("uses the day field for a day or longer, and falls back to 30 minutes for a non-number", () => {
    expect(autoSearchCronSchedule(1440)).toBe("0 0 */1 * *");
    expect(autoSearchCronSchedule(2880)).toBe("0 0 */2 * *");
    expect(autoSearchCronSchedule(Number.NaN)).toBe("*/30 * * * *");
  });
});

// ---------------------------------------------------------------------------
// matchTierFor / chooseBestResult — Title/Year/external-id matching (Round 336)
// ---------------------------------------------------------------------------

describe("matchTierFor", () => {
  it("returns 0 when no identity is given at all (episodic/collection searches)", () => {
    expect(matchTierFor(fakeResult(), null)).toBe(0);
  });

  it("returns 2 when the result's own reported imdbId matches the target's", () => {
    const result = fakeResult({ imdbId: "tt1234567", title: "Some.Movie.1999.1080p-GROUP" }); // wrong year in title, id still wins
    expect(matchTierFor(result, { year: 2020, externalIds: { imdb: "tt1234567" } })).toBe(2);
  });

  it("returns 2 when the result's own reported tmdbId matches the target's", () => {
    const result = fakeResult({ tmdbId: "603" });
    expect(matchTierFor(result, { year: 2020, externalIds: { tmdb: "603" } })).toBe(2);
  });

  it("returns 2 for an imdb id embedded in the title itself when the indexer reported none", () => {
    const result = fakeResult({ title: "Some.Movie.2020.1080p.WEB-DL.x264-GROUP[tt1234567]" });
    expect(matchTierFor(result, { year: 1999, externalIds: { imdb: "tt1234567" } })).toBe(2); // id wins even though year doesn't match
  });

  it("returns 1 when only the parsed year matches, with no id at all", () => {
    const result = fakeResult({ title: "Some.Movie.2020.1080p.WEB-DL.x264-GROUP" });
    expect(matchTierFor(result, { year: 2020, externalIds: {} })).toBe(1);
  });

  it("returns 0 when neither the id nor the year match", () => {
    const result = fakeResult({ title: "Some.Movie.1999.1080p.WEB-DL.x264-GROUP" });
    expect(matchTierFor(result, { year: 2020, externalIds: { imdb: "tt9999999" } })).toBe(0);
  });
});

describe("chooseBestResult — identity as a tiebreaker (never a hard filter)", () => {
  it("prefers a confirmed external-id match over a higher-seeder release with no identity signal at all", async () => {
    const confirmed = fakeResult({ title: "Correct.Movie.2020.1080p.WEB-DL.x264-GROUP", imdbId: "tt1234567", seeders: 5 });
    const wrong = fakeResult({ title: "Different.Movie.2020.1080p.WEB-DL.x264-OTHER", seeders: 500 });

    const best = await chooseBestResult(
      [wrong, confirmed],
      [],
      "",
      null,
      0,
      null,
      new Set(),
      "movie",
      null,
      { year: 2020, externalIds: { imdb: "tt1234567" } }
    );

    expect(best?.result.title).toBe(confirmed.title);
  });

  it("prefers a year match over a release with neither year nor id, even with fewer seeders", async () => {
    const rightYear = fakeResult({ title: "Some.Movie.2020.1080p.WEB-DL.x264-GROUP", seeders: 2 });
    const noSignal = fakeResult({ title: "Some.Movie.1080p.WEB-DL.x264-OTHER", seeders: 200 }); // no year at all in the title

    const best = await chooseBestResult([noSignal, rightYear], [], "", null, 0, null, new Set(), "movie", null, { year: 2020, externalIds: {} });

    expect(best?.result.title).toBe(rightYear.title);
  });

  it("still returns a result when nothing matches the given identity — a mismatch never excludes a candidate", async () => {
    const onlyOption = fakeResult({ title: "Totally.Unrelated.1999.1080p.WEB-DL.x264-GROUP" });

    const best = await chooseBestResult([onlyOption], [], "", null, 0, null, new Set(), "movie", null, { year: 2020, externalIds: { imdb: "tt9999999" } });

    expect(best?.result.title).toBe(onlyOption.title);
  });

  it("passing no identity at all (the episodic/collection call sites) doesn't change existing behavior — highest seeders wins", async () => {
    const higherSeeders = fakeResult({ title: "Show.S01E01.1080p.WEB-DL.x264-GROUP", seeders: 100 });
    const lowerSeeders = fakeResult({ title: "Show.S01E01.1080p.WEB-DL.x264-OTHER", seeders: 5 });

    const best = await chooseBestResult(
      [lowerSeeders, higherSeeders],
      [],
      "",
      null,
      0,
      { season: 1, episode: 1 },
      new Set(),
      "series",
      null
    );

    expect(best?.result.title).toBe(higherSeeders.title);
  });
});

// ---------------------------------------------------------------------------
// Release decisions: rejection order, quality tiers, upgrades, protocols, direct downloads
// ---------------------------------------------------------------------------

async function insertProfile(allowed: string[], cutoff: string, extra: { maxSizeGb?: number } = {}): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, max_size_gb) VALUES (?, ?, ?, ?)")
        .run(`Profile ${Math.random()}`, JSON.stringify(allowed), cutoff, extra.maxSizeGb ?? null)
    ).lastInsertRowid
  );
}

async function giveFile(table: "media_items" | "episodes" | "sub_items", id: number, quality: string | null): Promise<void> {
  await db.prepare(`UPDATE ${table} SET has_file = 1, quality = ? WHERE id = ?`).run(quality, id);
}

/** An adapter whose download id is the release URL, so several grabs in one test never collide. */
function urlKeyedAdapter(overrides: Partial<Record<string, any>> = {}) {
  return fakeAdapter({ addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: url })), ...overrides });
}

function stubOverQuotaFolder(folderPath: string): void {
  const originalStatfsSync = fs.statfsSync;
  vi.spyOn(fs, "statfsSync").mockImplementation((p: any, ...rest: any[]) =>
    p === folderPath ? ({ blocks: 1000, bsize: 1, bfree: 1, bavail: 1 } as any) : (originalStatfsSync as any)(p, ...rest)
  );
}

describe("chooseBestResult — rejections, tiers and protocols", () => {
  it("falls back to the next allowed tier when every release of the top tier is rejected", async () => {
    const profileId = await insertProfile(["Bluray-1080p", "Remux-1080p"], "Remux-1080p", { maxSizeGb: 15 });
    const remux = fakeResult({ title: "Movie.2020.1080p.BluRay.REMUX.AVC-FGT", size: 32_000_000_000 });
    const bluray = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-SPARKS", size: 10_000_000_000 });

    const best = await chooseBestResult([remux, bluray], ["Bluray-1080p", "Remux-1080p"], "Remux-1080p", profileId, 0, null, new Set(), "movie", null, null, null);

    expect(best).toEqual({ result: bluray, quality: "Bluray-1080p" });
  });

  it("falls back to the next tier when the top tier only has releases below the minimum custom format score", async () => {
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p");
    await db.prepare("UPDATE quality_profiles SET min_format_score = 0 WHERE id = ?").run(profileId);
    const formatId = Number(
      (await db.prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)").run(`LQ ${Math.random()}`, JSON.stringify([{ type: "releaseGroup", patterns: ["^LQGRP$"] }])))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, -10000)").run(profileId, formatId);
    try {
      const lowQualityGroup = fakeResult({ title: "Movie.2020.1080p.WEB-DL-LQGRP" });
      const clean720 = fakeResult({ title: "Movie.2020.720p.WEB-DL-GOOD" });

      const best = await chooseBestResult([lowQualityGroup, clean720], ["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p", profileId, 0, null, new Set(), "movie");

      expect(best?.result.title).toBe(clean720.title);
    } finally {
      await db.prepare("DELETE FROM custom_formats WHERE id = ?").run(formatId);
    }
  });

  it("never chooses a release whose protocol no enabled client can take", async () => {
    const nzb = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-NZB", protocol: "usenet", downloadUrl: "https://nzb/1" });
    const torrent = fakeResult({ title: "Movie.2020.1080p.WEB-DL-TOR", downloadUrl: "magnet:?xt=torrent" });
    const allowed = ["WEBDL-1080p", "Bluray-1080p"];

    const best = await chooseBestResult([nzb, torrent], allowed, "Bluray-1080p", null, 0, null, new Set(), "movie", null, null, null, {
      clients: [{ id: 1, type: "qbittorrent" }] as any[],
    });

    expect(best?.result.downloadUrl).toBe("magnet:?xt=torrent");
  });

  it("accepts any quality for a type whose releases have no video quality vocabulary (music, books, ...)", async () => {
    const album = fakeResult({ title: "Pink Floyd - The Dark Side of the Moon (1973) [FLAC 24-96]" });
    const book = fakeResult({ title: "Author - Book (2010) [EPUB]" });
    const videoTiers = ["SD", "WEBDL-1080p", "Bluray-1080p"];

    expect((await chooseBestResult([album], videoTiers, "WEBDL-1080p", null, 0, null, new Set(), "artist"))?.result.title).toBe(album.title);
    expect((await chooseBestResult([book], videoTiers, "WEBDL-1080p", null, 0, null, new Set(), "author"))?.result.title).toBe(book.title);
    // A video type still holds releases to its profile's tiers.
    expect(await chooseBestResult([book], videoTiers, "WEBDL-1080p", null, 0, null, new Set(), "movie")).toBeNull();
  });

  it("only takes a release naming the album or book for a type with no quality tiers, never another one or a pack", async () => {
    const choose = (results: any[], mediaType: string, name: { title: string; parentTitle?: string }) =>
      chooseBestResult(results, [], "", null, 0, null, new Set(), mediaType, null, null, null, { name });

    const discography = fakeResult({ title: "Metallica - Discography 1983-2016 [FLAC]", seeders: 900 });
    const selfTitled = fakeResult({ title: "Metallica - Metallica (1991) [FLAC]", seeders: 500 });
    const puppets = fakeResult({ title: "Metallica - Master of Puppets (1986) [FLAC]", seeders: 5 });
    expect((await choose([discography, selfTitled, puppets], "artist", { title: "Master of Puppets", parentTitle: "Metallica" }))?.result).toBe(puppets);
    // A self-titled album has to name the artist and the album, not just the artist.
    expect((await choose([discography, puppets, selfTitled], "artist", { title: "Metallica", parentTitle: "Metallica" }))?.result).toBe(selfTitled);

    const cosmere = fakeResult({ title: "Brandon Sanderson - Cosmere Collection (epub)", seeders: 900 });
    const trilogy = fakeResult({ title: "Brandon Sanderson - Mistborn Trilogy (epub)", seeders: 800 });
    const finalEmpire = fakeResult({ title: "Brandon Sanderson - Mistborn - The Final Empire (2006) [EPUB]", seeders: 5 });
    const book = { title: "Mistborn: The Final Empire (Mistborn, #1)", parentTitle: "Brandon Sanderson" };
    expect((await choose([cosmere, trilogy, finalEmpire], "author", book))?.result).toBe(finalEmpire);
    expect(await choose([cosmere, trilogy], "author", book)).toBeNull();

    // Nor the next volume of the same title.
    const hitsII = fakeResult({ title: "Queen - Greatest Hits II (1991) [FLAC]", seeders: 900 });
    const hitsVol2 = fakeResult({ title: "Queen - Greatest Hits Vol. 2 [FLAC]", seeders: 800 });
    const hits = fakeResult({ title: "Queen - Greatest Hits (1981) [FLAC]", seeders: 5 });
    expect((await choose([hitsII, hitsVol2, hits], "artist", { title: "Greatest Hits", parentTitle: "Queen" }))?.result).toBe(hits);
    expect((await choose([hits, hitsII], "artist", { title: "Greatest Hits II", parentTitle: "Queen" }))?.result).toBe(hitsII);
    const hitsVol1 = fakeResult({ title: "Queen - Greatest Hits Vol. 1 [FLAC]", seeders: 5 });
    expect((await choose([hitsVol2, hitsVol1], "artist", { title: "Greatest Hits", parentTitle: "Queen" }))?.result).toBe(hitsVol1);
    const zeppelinII = fakeResult({ title: "Led Zeppelin - Led Zeppelin II (1969) [FLAC]", seeders: 900 });
    const zeppelin = fakeResult({ title: "Led Zeppelin - Led Zeppelin (1969) [FLAC]", seeders: 5 });
    expect((await choose([zeppelinII, zeppelin], "artist", { title: "Led Zeppelin", parentTitle: "Led Zeppelin" }))?.result).toBe(zeppelin);
    // A series-volume note elsewhere in a book's release title is no other volume.
    const volumeNoted = fakeResult({ title: "Brandon Sanderson - The Final Empire (Mistborn Vol 1) [EPUB]", seeders: 5 });
    expect((await choose([trilogy, volumeNoted], "author", book))?.result).toBe(volumeNoted);

    // A comic issue is named by its series and number, rarely by the issue's own title.
    const issue11 = fakeResult({ title: "Saga 011 (2013) (Digital) (Zone-Empire)", seeders: 900 });
    const issue12 = fakeResult({ title: "Saga 012 (2013) (Digital) (Zone-Empire)", seeders: 5 });
    expect((await choose([issue11, issue12], "comic", { title: "#12 - Chapter Twelve", parentTitle: "Saga" }))?.result).toBe(issue12);
  });

  it("takes a book release that leaves the title's subtitle off, but never one naming another subtitle", async () => {
    const choose = (results: any[], name: { title: string; parentTitle?: string }) =>
      chooseBestResult(results, [], "", null, 0, null, new Set(), "author", null, null, null, { name });

    const sapiens = fakeResult({ title: "Yuval Noah Harari - Sapiens (2014) [EPUB]" });
    expect((await choose([sapiens], { title: "Sapiens: A Brief History of Humankind", parentTitle: "Yuval Noah Harari" }))?.result).toBe(sapiens);
    const atomicHabits = { title: "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones", parentTitle: "James Clear" };
    for (const title of [
      "James Clear - Atomic Habits (2018) [EPUB]",
      "James Clear - Atomic Habits.azw3",
      "Atomic Habits - James Clear (2018) [EPUB]",
      "Atomic Habits by James Clear",
      "James Clear - Atomic Habits",
    ]) {
      const release = fakeResult({ title });
      expect((await choose([release], atomicHabits))?.result, title).toBe(release);
    }
    // An audiobook's metadata carries the same subtitles.
    const audiobook = fakeResult({ title: "James Clear - Atomic Habits (2018) [M4B]" });
    expect(
      (await chooseBestResult([audiobook], [], "", null, 0, null, new Set(), "audiobook", null, null, null, { name: atomicHabits }))?.result
    ).toBe(audiobook);

    const finalEmpire = { title: "Mistborn: The Final Empire (Mistborn, #1)", parentTitle: "Brandon Sanderson" };
    expect(await choose([fakeResult({ title: "Brandon Sanderson - Mistborn - The Well of Ascension (2007) [EPUB]" })], finalEmpire)).toBeNull();
    expect(await choose([fakeResult({ title: "Mistborn - The Well of Ascension - Brandon Sanderson" })], finalEmpire)).toBeNull();
    expect(await choose([fakeResult({ title: "Yuval Noah Harari - Sapiens Graphic Novel (2020) [EPUB]" })], { title: "Sapiens: A Brief History of Humankind" })).toBeNull();

    // Another book whose title only contains the main title's words.
    const hobbit = { title: "The Hobbit: Or There and Back Again", parentTitle: "J.R.R. Tolkien" };
    const annotated = fakeResult({ title: "J.R.R. Tolkien - The Annotated Hobbit (1988) [EPUB]", seeders: 900 });
    const theHobbit = fakeResult({ title: "J.R.R. Tolkien - The Hobbit (1937) [EPUB]", seeders: 5 });
    expect(await choose([annotated], hobbit)).toBeNull();
    expect((await choose([annotated, theHobbit], hobbit))?.result).toBe(theHobbit);
    expect(await choose([fakeResult({ title: "Brandon Sanderson - Secret History of Mistborn (2016) [EPUB]" })], finalEmpire)).toBeNull();
    // The author may still come first, in any order, bracketed, with initials run together or
    // followed by a year.
    const sapiensBook = { title: "Sapiens: A Brief History of Humankind", parentTitle: "Yuval Noah Harari" };
    for (const title of [
      "Harari, Yuval Noah - Sapiens (2014) [EPUB]",
      "[Yuval Noah Harari] Sapiens (2014)",
      "Yuval Noah Harari - 2015 - Sapiens (Unabridged) [M4B]",
      "Sapiens - Harari, Yuval Noah [EPUB]",
    ]) {
      const release = fakeResult({ title });
      expect((await choose([release], sapiensBook))?.result, title).toBe(release);
    }
    for (const title of ["JRR Tolkien - The Hobbit (1937) [EPUB]", "Tolkien, JRR - The Hobbit [EPUB]", "The Hobbit - JRR Tolkien [EPUB]"]) {
      const release = fakeResult({ title });
      expect((await choose([release], hobbit))?.result, title).toBe(release);
    }
    const babel = fakeResult({ title: "RF Kuang - Babel (2022) [EPUB]" });
    expect(
      (await choose([babel], { title: "Babel: Or the Necessity of Violence: An Arcane History of the Oxford Translators' Revolution", parentTitle: "R.F. Kuang" }))
        ?.result
    ).toBe(babel);
    // The author after the title is no licence for more words after it.
    expect(await choose([fakeResult({ title: "Mistborn Brandon Sanderson - The Well of Ascension [EPUB]" })], finalEmpire)).toBeNull();
    expect(await choose([fakeResult({ title: "JRR Tolkien - The Annotated Hobbit (1988) [EPUB]" })], hobbit)).toBeNull();

    // One naming the whole title wins over one naming only the part before the subtitle, however better seeded.
    const mistborn = fakeResult({ title: "Brandon Sanderson - Mistborn (2006) [EPUB]", seeders: 900 });
    const wholeTitle = fakeResult({ title: "Brandon Sanderson - Mistborn - The Final Empire (2006) [EPUB]", seeders: 5 });
    expect((await choose([mistborn, wholeTitle], finalEmpire))?.result).toBe(wholeTitle);
    expect((await choose([mistborn], finalEmpire))?.result).toBe(mistborn);
  });

  it("needs the whole title of a game or an album, whose subtitle is what tells it from the rest of its series", async () => {
    const choose = (results: any[], mediaType: string, name: { title: string; parentTitle?: string }) =>
      chooseBestResult(results, [], "", null, 0, null, new Set(), mediaType, null, null, null, { name });

    const nesCastlevania = fakeResult({ title: "Castlevania (USA)", seeders: 900 });
    const symphony = fakeResult({ title: "Castlevania - Symphony of the Night (USA)", seeders: 5 });
    const sotn = { title: "Castlevania: Symphony of the Night" };
    expect(await choose([nesCastlevania], "rom", sotn)).toBeNull();
    expect((await choose([nesCastlevania, symphony], "rom", sotn))?.result).toBe(symphony);
    expect(await choose([fakeResult({ title: "Legend of Zelda, The (USA)" })], "rom", { title: "The Legend of Zelda: A Link to the Past" })).toBeNull();

    const soundtrack = { title: "Star Wars: The Force Awakens (Original Motion Picture Soundtrack)", parentTitle: "John Williams" };
    const newHope = fakeResult({ title: "John Williams - Star Wars (1977) [FLAC]", seeders: 900 });
    const forceAwakens = fakeResult({ title: "John Williams - Star Wars - The Force Awakens (2015) [FLAC]", seeders: 5 });
    expect((await choose([newHope, forceAwakens], "artist", soundtrack))?.result).toBe(forceAwakens);
    expect(await choose([newHope], "artist", soundtrack)).toBeNull();
    expect(
      await choose([fakeResult({ title: "Herbert von Karajan - Beethoven (1963) [FLAC]" })], "artist", { title: "Beethoven: Symphony No. 9", parentTitle: "Herbert von Karajan" })
    ).toBeNull();
  });

  it("matches letters NFKD leaves whole, and never takes a pack or another artist for a title of symbols alone", async () => {
    const choose = (results: any[], name: { title: string; parentTitle?: string }) =>
      chooseBestResult(results, [], "", null, 0, null, new Set(), "artist", null, null, null, { name });

    const aenima = fakeResult({ title: "Tool - Aenima (1996) [FLAC]" });
    expect((await choose([aenima], { title: "Ænima", parentTitle: "Tool" }))?.result).toBe(aenima);
    const oresund = fakeResult({ title: "Band - Oresund Strasse (2001) [FLAC]" });
    expect((await choose([oresund], { title: "Øresund Straße", parentTitle: "Band" }))?.result).toBe(oresund);

    const divideAlbum = { title: "÷", parentTitle: "Ed Sheeran" };
    const discography = fakeResult({ title: "Ed Sheeran - Discography 2011-2023 [FLAC]", seeders: 900 });
    const otherArtist = fakeResult({ title: "Someone Else - Greatest Hits (2017) [FLAC]", seeders: 800 });
    const divide = fakeResult({ title: "Ed Sheeran - ÷ (Deluxe) (2017) [FLAC]", seeders: 5 });
    // The same artist's other albums, whose titles are symbols or a single letter too.
    const plus = fakeResult({ title: "Ed Sheeran - + (2011) [FLAC]", seeders: 700 });
    const multiply = fakeResult({ title: "Ed Sheeran - x (Multiply) (2014) [FLAC]", seeders: 600 });
    expect(await choose([discography, otherArtist, plus, multiply], divideAlbum)).toBeNull();
    expect((await choose([discography, otherArtist, plus, multiply, divide], divideAlbum))?.result).toBe(divide);

    // Symbols that are also a release name's punctuation: the " - " after the artist, a "FLAC+CUE" tag.
    const subtractAlbum = { title: "-", parentTitle: "Ed Sheeran" };
    const subtract = fakeResult({ title: "Ed Sheeran - - (Subtract) (2023) [FLAC]", seeders: 5 });
    expect(await choose([divide, multiply, plus], subtractAlbum)).toBeNull();
    expect((await choose([divide, multiply, plus, subtract], subtractAlbum))?.result).toBe(subtract);
    const plusAlbum = { title: "+", parentTitle: "Ed Sheeran" };
    const multiplyCue = fakeResult({ title: "Ed Sheeran - x (Multiply) (2014) [FLAC+CUE]", seeders: 900 });
    expect(await choose([multiplyCue, subtract, divide], plusAlbum)).toBeNull();
    expect((await choose([multiplyCue, subtract, divide, plus], plusAlbum))?.result).toBe(plus);
    // The symbols first, or after tags ahead of the name.
    for (const title of ["÷ - Ed Sheeran (2017) [FLAC]", "[FLAC] Ed Sheeran - ÷ (2017)", "Ed Sheeran ÷ (2017)"]) {
      const release = fakeResult({ title });
      expect((await choose([release], divideAlbum))?.result, title).toBe(release);
    }
    // A metadata source's typographic spelling ("×", "−") still finds the plain-ASCII release name.
    expect((await choose([divide, plus, multiply], { title: "×", parentTitle: "Ed Sheeran" }))?.result).toBe(multiply);
    expect((await choose([divide, multiply, plus, subtract], { title: "−", parentTitle: "Ed Sheeran" }))?.result).toBe(subtract);
  });

  it("ranks by indexer priority, then seeders, then the newer release for a type with no quality tiers", async () => {
    const indexers = [
      { id: 1, priority: 50 },
      { id: 2, priority: 10 },
    ];
    const lowPriority = fakeResult({ title: "Author - Book (2010) [EPUB]", indexerId: 1, seeders: 900, downloadUrl: "https://low" });
    const highPriority = fakeResult({ title: "Author - Book (2010) [EPUB]", indexerId: 2, seeders: 1, downloadUrl: "https://high" });
    const book = { title: "Book", parentTitle: "Author" };

    const best = await chooseBestResult([lowPriority, highPriority], [], "", null, 0, null, new Set(), "author", null, null, null, { name: book, indexers });
    expect(best?.result.downloadUrl).toBe("https://high");

    const older = fakeResult({ title: "Author - Book (2010) [EPUB]", protocol: "usenet", seeders: null, publishDate: "2020-01-01T00:00:00Z", downloadUrl: "https://older" });
    const newer = fakeResult({ title: "Author - Book (2010) [EPUB]", protocol: "usenet", seeders: null, publishDate: "2024-01-01T00:00:00Z", downloadUrl: "https://newer" });
    expect((await chooseBestResult([older, newer], [], "", null, 0, null, new Set(), "author", null, null, null, { name: book }))?.result.downloadUrl).toBe("https://newer");

    // A video type keeps ranking by seeders.
    const movieLow = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", indexerId: 1, seeders: 900, downloadUrl: "https://movie-low" });
    const movieHigh = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", indexerId: 2, seeders: 1, downloadUrl: "https://movie-high" });
    expect((await chooseBestResult([movieLow, movieHigh], [], "", null, 0, null, new Set(), "movie", null, null, null, { indexers }))?.result.downloadUrl).toBe(
      "https://movie-low"
    );
  });

  it("ranks a release with an unreported size after one near the preferred size", async () => {
    const { loadQualityCaches } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET preferred_size_mb = 4000 WHERE name = 'WEBDL-1080p'").run();
    await loadQualityCaches();
    try {
      const unknownSize = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", size: 0, downloadUrl: "https://unknown" });
      const nearPreferred = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", size: 4_200_000_000, downloadUrl: "https://near" });

      const best = await chooseBestResult([unknownSize, nearPreferred], [], "", null, 0, null, new Set(), "movie");

      expect(best?.result.downloadUrl).toBe("https://near");
    } finally {
      await db.prepare("UPDATE qualities SET preferred_size_mb = NULL WHERE name = 'WEBDL-1080p'").run();
      await loadQualityCaches();
    }
  });

  it("never treats a release as a quality upgrade for a type with no quality tiers", async () => {
    const book = fakeResult({ title: "Author - Book (2010) [EPUB]" });

    expect(await chooseBestResult([book], [], "", null, 0, null, new Set(), "author", null, null, null, { upgradeFromRank: -1 })).toBeNull();
  });

  it("only considers qualities above the file already on disk when upgrading", async () => {
    const allowed = ["HDTV-720p", "WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"];
    const results = [
      fakeResult({ title: "Movie.2020.720p.WEB-DL-GRP", seeders: 500 }),
      fakeResult({ title: "Movie.2020.720p.HDTV.x264-GRP", seeders: 400 }),
      fakeResult({ title: "Movie.2020.1080p.BluRay.x264-GRP", seeders: 5 }),
    ];
    const { qualityRank } = await import("../src/services/quality.js");

    const best = await chooseBestResult(results, allowed, "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, null, {
      upgradeFromRank: qualityRank("WEBDL-720p"),
    });

    expect(best?.quality).toBe("Bluray-1080p");
  });

  it("treats a size of 0 as unknown, not as a 0-byte file failing a minimum size or matching a size format", async () => {
    const { loadQualityCaches } = await import("../src/services/quality.js");
    const profileId = await insertProfile([], "");
    const formatId = Number(
      (await db.prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)").run(`Tiny ${Math.random()}`, JSON.stringify([{ type: "size", maxMb: 500 }])))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, -1000)").run(profileId, formatId);
    await db.prepare("UPDATE qualities SET min_size_mb = 1000 WHERE name = 'WEBDL-1080p'").run();
    await loadQualityCaches();
    try {
      const unknownSize = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", size: 0 });
      const tooSmall = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", size: 200_000_000 });

      expect((await chooseBestResult([unknownSize], [], "", profileId, 0, null, new Set(), "movie"))?.result).toBe(unknownSize);
      expect(await chooseBestResult([tooSmall], [], "", profileId, 0, null, new Set(), "movie")).toBeNull();
    } finally {
      await db.prepare("UPDATE qualities SET min_size_mb = NULL WHERE name = 'WEBDL-1080p'").run();
      await db.prepare("DELETE FROM custom_formats WHERE id = ?").run(formatId);
      await loadQualityCaches();
    }
  });
});

describe("pickClientForProtocol — deterministic choice between clients", () => {
  it("prefers the protocol's own preference order over list order", () => {
    const clients = [
      { id: 1, type: "realdebrid" },
      { id: 2, type: "qbittorrent" },
    ] as any[];
    expect(pickClientForProtocol(clients, "torrent")?.id).toBe(2);
  });

  it("breaks a tie between two clients of the same type by id, whatever order they're listed in", () => {
    const clients = [
      { id: 7, type: "qbittorrent" },
      { id: 3, type: "qbittorrent" },
    ] as any[];
    expect(pickClientForProtocol(clients, "torrent")?.id).toBe(3);
  });
});

describe("isReleaseAvailableForSearch — a zero-day 'released' delay", () => {
  it("honours a configured delay of 0 days instead of reading it as the 90-day default", () => {
    setSetting("minimumAvailabilityReleasedDelayDays", "0");
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      expect(isReleaseAvailableForSearch({ minimumAvailability: "released", releaseDate: yesterday } as any)).toBe(true);
    } finally {
      setSetting("minimumAvailabilityReleasedDelayDays", "90");
    }
  });
});

describe("runAutoSearch — decisions", () => {
  it("grabs the best torrent instead of skipping when the top release is an NZB and only a torrent client exists", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    await insertMovie({ quality_profile_id: profileId });
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "The.Matrix.1999.1080p.BluRay.x264-NZB", protocol: "usenet", downloadUrl: "https://nzb/1" }),
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-TOR", downloadUrl: "magnet:?xt=torrent" }),
    ]);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=torrent");
  });

  it("grabs a missing book even though the author's quality profile only lists video tiers", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter());
    const profileId = await insertProfile(["SD", "WEBDL-1080p"], "WEBDL-1080p");
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES ('author','Author','author',1,0,'missing',?)`)
          .run(profileId)
      ).lastInsertRowid
    );
    const bookId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Book', 1, 0)").run(authorId)).lastInsertRowid);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Author - Book (2010) [EPUB]" })]);

    await runAutoSearch();

    const row = (await db.prepare("SELECT sub_item_id FROM queue WHERE media_item_id = ?").get(authorId)) as any;
    expect(row).toEqual({ sub_item_id: bookId });
  });

  it("grabs only the release that names the missing album, not a better-seeded discography or other album", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist','Band','band',1,0,'missing')`).run()).lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Debut', 1, 0)").run(artistId);
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Band - Discography (2001-2020) [FLAC]", seeders: 900, downloadUrl: "magnet:?xt=discography" }),
      fakeResult({ title: "Band - Second Album (2004) [FLAC]", seeders: 800, downloadUrl: "magnet:?xt=other" }),
      fakeResult({ title: "Band - Debut (2001) [FLAC]", seeders: 5, downloadUrl: "magnet:?xt=debut" }),
    ]);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=debut");
  });

  it("sends a season pack found for several missing episodes only once", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const showId = await insertSeries();
    for (let e = 1; e <= 3; e++) await insertEpisode(showId, 1, e);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Show.S01.1080p.BluRay-GRP" })]);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    const rows = (await db.prepare("SELECT season_number FROM queue WHERE media_item_id = ?").all(showId)) as any[];
    expect(rows).toEqual([{ season_number: 1 }]);
  });

  it("tries the next-best release when the client refuses one, and still searches the remaining episodes", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter();
    adapter.addDownload.mockImplementation(async (_client: unknown, url: string) => {
      if (url === "https://dead/e1.torrent") throw new Error("Failed to fetch release file for blackhole: HTTP 404");
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const showId = await insertSeries();
    const e1 = await insertEpisode(showId, 1, 1);
    const e2 = await insertEpisode(showId, 1, 2);
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) =>
      query === "Show S01E01"
        ? [
            fakeResult({ title: "Show.S01E01.1080p.WEB-DL-DEAD", seeders: 900, downloadUrl: "https://dead/e1.torrent" }),
            fakeResult({ title: "Show.S01E01.1080p.WEB-DL-GOOD", seeders: 5, downloadUrl: "magnet:?xt=e1" }),
          ]
        : [fakeResult({ title: "Show.S01E02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=e2" })]
    );

    await runAutoSearch();

    const rows = (await db.prepare("SELECT episode_id, download_id FROM queue WHERE media_item_id = ? ORDER BY episode_id").all(showId)) as any[];
    expect(rows).toEqual([
      { episode_id: e1, download_id: "magnet:?xt=e1" },
      { episode_id: e2, download_id: "magnet:?xt=e2" },
    ]);
  });

  it("keeps searching a collection's remaining sub-items when one grab throws", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter();
    adapter.addDownload.mockImplementation(async (_client: unknown, url: string) => {
      if (url === "https://peer-offline/1") throw new Error("slskd enqueue failed: 404");
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist','Band','band',1,0,'missing')`).run()).lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'First', 1, 0)").run(artistId);
    const second = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Second', 1, 0)").run(artistId)).lastInsertRowid);
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) =>
      query === "Band First" ? [fakeResult({ title: "Band - First [FLAC]", downloadUrl: "https://peer-offline/1" })] : [fakeResult({ title: "Band - Second [FLAC]", downloadUrl: "magnet:?xt=second" })]
    );

    await runAutoSearch();

    const rows = (await db.prepare("SELECT sub_item_id FROM queue WHERE media_item_id = ?").all(artistId)) as any[];
    expect(rows).toEqual([{ sub_item_id: second }]);
  });

  it("stops sending grabs to a download client it can't reach instead of trying release after release, target after target", async () => {
    await insertClient();
    const unreachable = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }),
    });
    const adapter = urlKeyedAdapter({ addDownload: vi.fn().mockRejectedValue(unreachable) });
    getDownloadClientAdapter.mockReturnValue(adapter);
    await insertMovie({ title: "First", sort_title: "first" });
    await insertMovie({ title: "Second", sort_title: "second" });
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Movie.2020.1080p.WEB-DL-A", seeders: 900, downloadUrl: "magnet:?xt=a" }),
      fakeResult({ title: "Movie.2020.1080p.WEB-DL-B", seeders: 500, downloadUrl: "magnet:?xt=b" }),
      fakeResult({ title: "Movie.2020.1080p.WEB-DL-C", seeders: 100, downloadUrl: "magnet:?xt=c" }),
    ]);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(searchAllIndexers).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT * FROM queue").all()).toEqual([]);
  });

  it("reports a client refusing AoNarr's login after one attempt, and leaves it out of the rest of a bulk search", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter({ addDownload: vi.fn().mockRejectedValue(new Error('Failed to authenticate with qBittorrent client "Test Client"')) });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const first = await insertMovie();
    const second = await insertMovie({ title: "Heat", sort_title: "heat", year: 1995 });
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Movie.2020.1080p.WEB-DL-A", seeders: 900, downloadUrl: "magnet:?xt=a" }),
      fakeResult({ title: "Movie.2020.1080p.WEB-DL-B", seeders: 500, downloadUrl: "magnet:?xt=b" }),
    ]);

    const results = await searchAndGrabTargets([{ mediaItemId: first.id }, { mediaItemId: second.id }]);

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(searchAllIndexers).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.grabbed)).toEqual([false, false]);
    for (const r of results) expect(r.error).toContain("Failed to authenticate");
  });

  it("still tries the next release when only the release's own file couldn't be fetched", async () => {
    await insertClient({ type: "realdebrid" });
    const adapter = urlKeyedAdapter();
    adapter.addDownload.mockImplementation(async (_client: unknown, url: string) => {
      // A debrid client fetches a .torrent URL itself: the indexer behind it can be the one that's down.
      if (url === "https://indexer-down/1.torrent") {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      }
      if (url === "https://indexer/2.torrent") throw new Error("Failed to resolve download URL: HTTP 403");
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const movie = await insertMovie();
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-A", seeders: 900, downloadUrl: "https://indexer-down/1.torrent" }),
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-B", seeders: 500, downloadUrl: "https://indexer/2.torrent" }),
      fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-C", seeders: 100, downloadUrl: "magnet:?xt=c" }),
    ]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result.grabbed).toBe(true);
    expect(adapter.addDownload.mock.calls.map((c) => c[1])).toEqual(["https://indexer-down/1.torrent", "https://indexer/2.torrent", "magnet:?xt=c"]);
  });

  it("never reads an indexer's API key in a release URL quoted by a failed fetch as the client refusing its login", async () => {
    await insertClient({ type: "realdebrid" });
    const adapter = urlKeyedAdapter();
    adapter.addDownload.mockImplementation(async (_client: unknown, url: string) => {
      if (url.includes("/1/")) throw new Error(`Too many redirects resolving download URL "${url}"`);
      if (url.includes("/2/")) throw new Error(`Redirect from "${url}" had no Location header`);
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const first = await insertMovie();
    const second = await insertMovie({ title: "Heat", sort_title: "heat", year: 1995 });
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) => [
      fakeResult({ title: "Release.1080p.WEB-DL-A", seeders: 900, downloadUrl: `http://prowlarr:9696/1/download?apikey=abc&file=${query}` }),
      fakeResult({ title: "Release.1080p.WEB-DL-B", seeders: 500, downloadUrl: `http://prowlarr:9696/2/download?apikey=abc&file=${query}` }),
      fakeResult({ title: "Release.1080p.WEB-DL-C", seeders: 100, downloadUrl: `magnet:?xt=${query}` }),
    ]);

    const results = await searchAndGrabTargets([{ mediaItemId: first.id }, { mediaItemId: second.id }]);

    expect(results.map((r) => r.grabbed)).toEqual([true, true]);
    expect(adapter.addDownload).toHaveBeenCalledTimes(6);
  });

  it("starts only a few direct yt-dlp downloads per pass, counting ones already running", async () => {
    const ytClient = await insertClient({ type: "ytdlp" });
    const adapter = urlKeyedAdapter({
      getStatus: vi.fn(async (_client: unknown, ids: string[]) => ids.map((id) => ({ downloadId: id, progress: 0.5, status: "downloading" }))),
    });
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()).lastInsertRowid
    );
    for (let i = 1; i <= 6; i++) {
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, ?, 1, 0, 'youtube', ?)")
        .run(channelId, `Video ${i}`, `vid${i}`);
    }
    // One download from an earlier pass is still running.
    await db.prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status) VALUES (?, 'Earlier', ?, 'running-1', 'downloading')").run(channelId, ytClient.id);

    await runAutoSearch();

    expect(adapter.addDownload).toHaveBeenCalledTimes(2);
  });
});

describe("searchAndGrabTargets — upgrades and whole-item targets", () => {
  it("only grabs a real upgrade for a target that already has a file, even when the caller sends no upgradeFromQuality", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["HDTV-720p", "WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "WEBDL-1080p");
    const movie = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", movie.id, "WEBDL-720p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.720p.WEB-DL-GRP" }), fakeResult({ title: "The.Matrix.1999.720p.HDTV.x264-GRP" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result).toEqual({ mediaItemId: movie.id, grabbed: false, error: "No release found that's an upgrade over WEBDL-720p" });
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("never replaces a file above the cutoff with the cutoff quality", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["WEBDL-1080p", "Bluray-1080p", "Remux-2160p"], "WEBDL-1080p");
    const movie = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", movie.id, "Remux-2160p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-GRP" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id }]);

    expect(result.grabbed).toBe(false);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("never searches for a file that already meets the profile's cutoff, and still upgrades one below it", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p", "Remux-2160p"], "WEBDL-1080p");
    const atCutoff = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", atCutoff.id, "WEBDL-1080p");
    const belowCutoff = await insertMovie({ title: "Heat", sort_title: "heat", year: 1995, quality_profile_id: profileId });
    await giveFile("media_items", belowCutoff.id, "WEBDL-720p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Movie.2160p.BluRay.REMUX.HEVC.DTS-HD.MA-GRP", size: 70_000_000_000 })]);

    const results = await searchAndGrabTargets([{ mediaItemId: atCutoff.id }, { mediaItemId: belowCutoff.id }]);

    expect(results).toEqual([
      { mediaItemId: atCutoff.id, grabbed: false, error: "Already meets the profile's cutoff (WEBDL-1080p)" },
      { mediaItemId: belowCutoff.id, grabbed: true },
    ]);
    expect(searchAllIndexers).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
  });

  it("gates an episode that already has a file the same way", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const showId = await insertSeries();
    const epId = await insertEpisode(showId, 1, 1);
    await giveFile("episodes", epId, "WEBDL-1080p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Show.S01E01.720p.WEB-DL-GRP" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: showId, episodeId: epId }]);

    expect(result.grabbed).toBe(false);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("takes an allowed above-cutoff upgrade even when a release at the current quality is also on offer", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["HDTV-720p", "WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "WEBDL-1080p");
    const movie = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", movie.id, "WEBDL-720p");
    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "The.Matrix.1999.720p.WEB-DL-GRP", seeders: 500, downloadUrl: "magnet:?xt=same" }),
      fakeResult({ title: "The.Matrix.1999.720p.HDTV.x264-GRP", seeders: 400, downloadUrl: "magnet:?xt=worse" }),
      fakeResult({ title: "The.Matrix.1999.1080p.BluRay.x264-GRP", seeders: 5, downloadUrl: "magnet:?xt=upgrade" }),
    ]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: movie.id, upgradeFromQuality: "WEBDL-720p" }]);

    expect(result.grabbed).toBe(true);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=upgrade");
  });

  it("searches a show target's missing monitored episodes one by one instead of grabbing a release for the show", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(urlKeyedAdapter());
    const showId = await insertSeries();
    const e1 = await insertEpisode(showId, 1, 1);
    const e2 = await insertEpisode(showId, 1, 2);
    const withFile = await insertEpisode(showId, 1, 3);
    await giveFile("episodes", withFile, "WEBDL-1080p");
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) =>
      query === "Show S01E01"
        ? [fakeResult({ title: "Show.S01E01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=e1" }), fakeResult({ title: "Show.S03E07.2160p.WEB-DL-GRP", seeders: 999, downloadUrl: "magnet:?xt=wrong" })]
        : query === "Show S01E02"
        ? [fakeResult({ title: "Show.S01E02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=e2" })]
        : [fakeResult({ title: "Show.S03E07.2160p.WEB-DL-GRP", downloadUrl: "magnet:?xt=wrong" })]
    );

    const [result] = await searchAndGrabTargets([{ mediaItemId: showId }]);

    expect(result).toEqual({ mediaItemId: showId, grabbed: true, childrenSearched: 2, childrenGrabbed: 2 });
    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Show S01E01", "Show S01E02"]);
    const rows = (await db.prepare("SELECT episode_id, download_id FROM queue WHERE media_item_id = ? ORDER BY episode_id").all(showId)) as any[];
    expect(rows).toEqual([
      { episode_id: e1, download_id: "magnet:?xt=e1" },
      { episode_id: e2, download_id: "magnet:?xt=e2" },
    ]);
  });

  it("searches an artist target's missing albums one by one", async () => {
    await insertClient();
    getDownloadClientAdapter.mockReturnValue(urlKeyedAdapter());
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist','Band','band',1,0,'missing')`).run()).lastInsertRowid
    );
    const album = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album', 1, 0)").run(artistId)).lastInsertRowid);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Unwanted', 0, 0)").run(artistId);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Band - Album (2001) [FLAC]", downloadUrl: "magnet:?xt=album" })]);

    const [result] = await searchAndGrabTargets([{ mediaItemId: artistId }]);

    expect(result).toMatchObject({ grabbed: true, childrenSearched: 1, childrenGrabbed: 1 });
    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Band Album"]);
    const rows = (await db.prepare("SELECT sub_item_id FROM queue WHERE media_item_id = ?").all(artistId)) as any[];
    expect(rows).toEqual([{ sub_item_id: album }]);
  });

  it("doesn't search the rest of a show target's season once a pack for it has been grabbed", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const showId = await insertSeries();
    for (let e = 1; e <= 3; e++) await insertEpisode(showId, 1, e);
    await insertEpisode(showId, 2, 1);
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) =>
      query.startsWith("Show S01")
        ? [fakeResult({ title: "Show.S01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=s1-pack" })]
        : [fakeResult({ title: "Show.S02E01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=s2e1" })]
    );

    const [result] = await searchAndGrabTargets([{ mediaItemId: showId }]);

    expect(result).toEqual({ mediaItemId: showId, grabbed: true, childrenSearched: 2, childrenGrabbed: 2 });
    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Show S01E01", "Show S02E01"]);
    expect(adapter.addDownload).toHaveBeenCalledTimes(2);
  });

  it("reports a show with nothing left to search instead of searching the show as a whole", async () => {
    const showId = await insertSeries();

    const [result] = await searchAndGrabTargets([{ mediaItemId: showId }]);

    expect(result).toEqual({ mediaItemId: showId, grabbed: false, error: "No monitored episodes to search" });
    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("grabs a YouTube video target straight through yt-dlp rather than searching indexers for it", async () => {
    const ytClient = await insertClient({ type: "ytdlp" });
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const channelId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','Channel','channel',1,0,'missing')`).run()).lastInsertRowid
    );
    const videoId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'A Video', 1, 0, 'youtube', 'abc123')")
          .run(channelId)
      ).lastInsertRowid
    );

    const [result] = await searchAndGrabTargets([{ mediaItemId: channelId, subItemId: videoId }]);

    expect(result.grabbed).toBe(true);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(adapter.addDownload).toHaveBeenCalledWith(expect.objectContaining({ id: ytClient.id }), "https://www.youtube.com/watch?v=abc123", null, "A Video", "http");
  });
});

describe("runAutoUpgrade / retryFailedGrab — quota and upgrade gates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runAutoUpgrade skips a candidate whose root folder is over its quota", async () => {
    setSetting("autoUpgradeEnabled", "1");
    const folderPath = "/upgrade-quota-test";
    const folder = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES (?, 'movie', 50, 1)").run(folderPath)).lastInsertRowid
    );
    stubOverQuotaFolder(folderPath);
    const movie = await insertMovie({ root_folder_id: folder });
    await insertClient();
    findUpgradeCandidates.mockResolvedValue([{ mediaItemId: movie.id, currentQuality: "SD", cutoff: "WEBDL-1080p", profileName: "P", target: movie.title }]);

    await runAutoUpgrade();

    expect(searchAllIndexers).not.toHaveBeenCalled();
  });

  it("retryFailedGrab notifies instead of re-grabbing into a root folder that's over its quota", async () => {
    const folderPath = "/retry-quota-test";
    const folder = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES (?, 'movie', 50, 1)").run(folderPath)).lastInsertRowid
    );
    stubOverQuotaFolder(folderPath);
    const movie = await insertMovie({ root_folder_id: folder });

    await retryFailedGrab({ id: 1, mediaItemId: movie.id, title: "Bad.Release", episodeId: null, subItemId: null, retryCount: 0 } as any, "corrupt file");

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith(movie.title, expect.stringContaining("quota"));
  });

  it("retryFailedGrab only replaces a failed upgrade with a release that's still an upgrade over the file on disk", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    const movie = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", movie.id, "WEBDL-1080p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-OTHER" }), fakeResult({ title: "The.Matrix.1999.720p.WEB-DL-GRP" })]);

    await retryFailedGrab(
      { id: 1, mediaItemId: movie.id, title: "The.Matrix.1999.1080p.BluRay.x264-GRP", episodeId: null, subItemId: null, retryCount: 0 } as any,
      "Stalled: no progress for over 6h"
    );

    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith(movie.title, expect.stringContaining("upgrade over WEBDL-1080p"));
  });

  it("retryFailedGrab grabs no replacement for a file that already meets the profile's cutoff", async () => {
    await insertClient();
    const adapter = fakeAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const profileId = await insertProfile(["WEBDL-1080p", "Remux-2160p"], "WEBDL-1080p");
    const movie = await insertMovie({ quality_profile_id: profileId });
    await giveFile("media_items", movie.id, "WEBDL-1080p");
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.2160p.BluRay.REMUX.HEVC-OTHER" })]);

    await retryFailedGrab(
      { id: 1, mediaItemId: movie.id, title: "The.Matrix.1999.2160p.BluRay.REMUX.HEVC-BAD", episodeId: null, subItemId: null, retryCount: 0 } as any,
      "Download failed at the download client"
    );

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith(movie.title, expect.stringContaining("already meets the profile's cutoff (WEBDL-1080p)"));
  });

  it("retryFailedGrab only replaces a failed season pack with one better than every episode file it would replace", async () => {
    await insertClient();
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    const showId = await insertSeries();
    await giveFile("episodes", await insertEpisode(showId, 2, 1), "WEBDL-720p");
    await giveFile("episodes", await insertEpisode(showId, 2, 2), "Bluray-1080p");
    await insertEpisode(showId, 2, 3);
    const failed = { id: 1, mediaItemId: showId, title: "Show.S02.2160p.WEB-DL-BAD", episodeId: null, subItemId: null, seasonNumber: 2, retryCount: 0 } as any;

    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Show.S02.1080p.WEB-DL-GRP", seeders: 900, downloadUrl: "magnet:?xt=worse" })]);
    await retryFailedGrab(failed, "Download failed at the download client");
    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith("Show", expect.stringContaining("upgrade over Bluray-1080p"));

    searchAllIndexers.mockResolvedValue([
      fakeResult({ title: "Show.S02.1080p.WEB-DL-GRP", seeders: 900, downloadUrl: "magnet:?xt=worse" }),
      fakeResult({ title: "Show.S02.2160p.WEB-DL-GOOD", seeders: 5, downloadUrl: "magnet:?xt=better" }),
    ]);
    await retryFailedGrab(failed, "Download failed at the download client");
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=better");
  });

  it("retryFailedGrab never searches indexers to replace a failed yt-dlp grab", async () => {
    await insertClient();
    const channelId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video','First We Feast','first we feast',1,0,'missing')`).run())
        .lastInsertRowid
    );
    const videoId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, external_provider, external_id) VALUES (?, 'Hot Ones - Season 20 Finale', 1, 0, 'youtube', 'v1')")
          .run(channelId)
      ).lastInsertRowid
    );
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "Hot.Ones.S20E12.1080p.WEB-DL-GRP" })]);

    await retryFailedGrab(
      { id: 1, mediaItemId: channelId, title: "Hot Ones - Season 20 Finale", episodeId: null, subItemId: videoId, retryCount: 0 } as any,
      "Download failed at the download client"
    );

    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith("First We Feast", "Download failed at the download client");
  });
});

describe("checkVideoChannels — direct download budget", () => {
  it("grabs only a few of a channel's new uploads at once, leaving the rest monitored for auto-search", async () => {
    const channelId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('video','Channel','channel',1,0,?,'missing')`)
          .run(JSON.stringify({ youtube: "UC123" }))
      ).lastInsertRowid
    );
    await insertClient({ type: "ytdlp" });
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    notifyGrabbed.mockResolvedValue(undefined);
    const children = Array.from({ length: 6 }, (_, i) => ({ title: `Upload ${i}`, releaseDate: null, externalId: `up${i}` }));
    fetchCollectionChildrenFor.mockResolvedValue({ provider: "youtube", children });

    await checkVideoChannels();

    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    const monitored = (await db.prepare("SELECT COUNT(*) AS n FROM sub_items WHERE media_item_id = ? AND monitored = 1").get(channelId)) as { n: number | string };
    expect(Number(monitored.n)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Downloads that never progress, unseeded torrents, library-side import failures, skipped imports
// ---------------------------------------------------------------------------

async function insertActiveQueueRow(
  clientId: number | null,
  opts: { status?: string; downloadId?: string; progress?: number; addedHoursAgo?: number; updatedHoursAgo?: number } = {}
): Promise<{ id: number; mediaItemId: number }> {
  const { status = "downloading", downloadId = "dl-1", progress = 0, addedHoursAgo = 8, updatedHoursAgo = 0 } = opts;
  const movie = await insertMovie({ title: `Movie ${Math.random()}`, sort_title: "x" });
  const result = await db
    .prepare(
      `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, added_at, updated_at)
       VALUES (?, 'Some.Release.2020.1080p.WEB-DL-GRP', ?, ?, ?, ?, ${nowOffsetHoursExpr(db, -addedHoursAgo)}, ${nowOffsetHoursExpr(db, -updatedHoursAgo)})`
    )
    .run(movie.id, clientId, downloadId, status, progress);
  return { id: Number(result.lastInsertRowid), mediaItemId: movie.id };
}

/** Runs `fn` with Date.now() moved `hours` ahead; the database's own clock is left alone. */
async function atClockOffset<T>(hours: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now.bind(Date);
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + hours * 3_600_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

async function queueStatus(id: number): Promise<string | undefined> {
  return ((await db.prepare("SELECT status FROM queue WHERE id = ?").get(id)) as { status: string } | undefined)?.status;
}

async function blocklistedTitles(mediaItemId: number): Promise<string[]> {
  return ((await db.prepare("SELECT release_title FROM blocklist WHERE media_item_id = ?").all(mediaItemId)) as { release_title: string }[]).map(
    (r) => r.release_title
  );
}

describe("cleanupStalledDownloads — downloads that never made progress", () => {
  it("fails, blocklists and retries a download its client has flagged as stalled at 0% for longer than the threshold", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "downloading", stalled: true }]) })
    );
    const { id, mediaItemId } = await insertActiveQueueRow(client.id);

    await cleanupStalledDownloads();
    expect(await queueStatus(id)).toBe("downloading");
    await atClockOffset(7, () => cleanupStalledDownloads());

    expect(await queueStatus(id)).toBe("failed");
    expect(await blocklistedTitles(mediaItemId)).toEqual(["Some.Release.2020.1080p.WEB-DL-GRP"]);
    expect(notifyFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Stalled"));
  });

  it("doesn't fail a download its client has only just flagged as stalled, however long ago it was grabbed", async () => {
    // qBittorrent can hold a healthy torrent in its own queue for hours, then flag it stalled for the
    // minute it spends fetching the torrent's metadata.
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "downloading", stalled: true }]) })
    );
    const { id, mediaItemId } = await insertActiveQueueRow(client.id, { addedHoursAgo: 30 });

    await cleanupStalledDownloads();

    expect(await queueStatus(id)).toBe("downloading");
    expect(await blocklistedTitles(mediaItemId)).toEqual([]);
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("starts the stalled clock over when the client stops flagging the download in between", async () => {
    const client = await insertClient();
    const flagged = [{ downloadId: "dl-1", progress: 0, status: "downloading", stalled: true }];
    const getStatus = vi.fn().mockResolvedValue(flagged);
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus }));
    const { id } = await insertActiveQueueRow(client.id, { addedHoursAgo: 30 });

    await cleanupStalledDownloads();
    getStatus.mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "downloading" }]);
    await atClockOffset(4, () => cleanupStalledDownloads());
    getStatus.mockResolvedValue(flagged);
    await atClockOffset(7, () => cleanupStalledDownloads());
    expect(await queueStatus(id)).toBe("downloading");

    await atClockOffset(14, () => cleanupStalledDownloads());
    expect(await queueStatus(id)).toBe("failed");
  });

  it("counts the time the queue poller has already seen the download flagged stalled", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0, status: "downloading", stalled: true }]) })
    );
    const { id } = await insertActiveQueueRow(client.id);

    await pollQueue();
    await atClockOffset(7, () => cleanupStalledDownloads());

    expect(await queueStatus(id)).toBe("failed");
  });

  it("fails and re-searches a download whose client was deleted, whatever its age, without blocklisting its release", async () => {
    const release = "The.Matrix.1999.1080p.WEB-DL-ORPHANED";
    const movie = await insertMovie();
    await insertClient();
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    searchAllIndexers.mockResolvedValue([fakeResult({ title: "The.Matrix.1999.1080p.WEB-DL-OTHER", downloadUrl: "magnet:?xt=replacement" })]);
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, added_at) VALUES (?, ?, NULL, 'dl-gone', 'downloading', ${nowOffsetHoursExpr(db, -1)})`
          )
          .run(movie.id, release)
      ).lastInsertRowid
    );

    await cleanupStalledDownloads();

    expect(await queueStatus(id)).toBeUndefined();
    expect(await blocklistedTitles(movie.id)).toEqual([]);
    expect(await db.prepare("SELECT * FROM release_group_stats WHERE LOWER(release_group) LIKE '%orphaned%'").all()).toEqual([]);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(adapter.addDownload.mock.calls[0][1]).toBe("magnet:?xt=replacement");
    const history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'failed'").all(movie.id)) as { data: string }[];
    expect(history.map((h) => JSON.parse(h.data).reason)).toEqual(["Its download client no longer exists"]);
  });

  it("leaves a never-started download the client is still holding in its own queue", async () => {
    const client = await insertClient();
    setSetting("removeFailedDownloads", "1");
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({
        getStatus: vi.fn().mockResolvedValue([
          // How qBittorrent's queuedDL and SABnzbd's "Queued" slots are reported today.
          { downloadId: "waiting", progress: 0, status: "downloading" },
          { downloadId: "client-queued", progress: 0, status: "queued" },
        ]),
      })
    );
    const waiting = await insertActiveQueueRow(client.id, { downloadId: "waiting", addedHoursAgo: 30 });
    const clientQueued = await insertActiveQueueRow(client.id, { downloadId: "client-queued", status: "queued", addedHoursAgo: 30 });

    await cleanupStalledDownloads();

    expect(await queueStatus(waiting.id)).toBe("downloading");
    expect(await queueStatus(clientQueued.id)).toBe("queued");
    expect(await blocklistedTitles(waiting.mediaItemId)).toEqual([]);
    expect(await blocklistedTitles(clientQueued.mediaItemId)).toEqual([]);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("still fails a download that made progress once and then stopped, whether or not the client flags it", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([{ downloadId: "dl-1", progress: 0.3, status: "downloading" }]) }));
    const { id } = await insertActiveQueueRow(client.id, { progress: 0.3, addedHoursAgo: 30 });
    await db.prepare(`UPDATE queue SET last_progress_at = ${nowOffsetHoursExpr(db, -8)} WHERE id = ?`).run(id);

    await cleanupStalledDownloads();

    expect(await queueStatus(id)).toBe("failed");
  });

  it("fails a queued download its client no longer reports at all", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus: vi.fn().mockResolvedValue([]) }));
    const { id } = await insertActiveQueueRow(client.id, { status: "queued" });

    await cleanupStalledDownloads();

    expect(await queueStatus(id)).toBe("failed");
  });

  it("leaves a download that's moving again, or that was only grabbed recently", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({
        getStatus: vi.fn(async (_client: unknown, ids: string[]) =>
          ids.map((downloadId) => ({ downloadId, progress: downloadId === "moving" ? 0.4 : 0, status: "downloading" }))
        ),
      })
    );
    const moving = await insertActiveQueueRow(client.id, { downloadId: "moving" });
    const recent = await insertActiveQueueRow(client.id, { downloadId: "recent", addedHoursAgo: 1 });

    await cleanupStalledDownloads();

    expect(await queueStatus(moving.id)).toBe("downloading");
    expect(await queueStatus(recent.id)).toBe("downloading");
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("never fails downloads of an unreachable or disabled client, or of a blackhole", async () => {
    const unreachable = await insertClient({ name: "Down" });
    const disabled = await insertClient({ name: "Off", enabled: 0 });
    const blackhole = await insertClient({ name: "Watch folder", type: "blackhole" });
    const getStatus = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus }));
    const rows = [
      await insertActiveQueueRow(unreachable.id, { downloadId: "a" }),
      await insertActiveQueueRow(disabled.id, { downloadId: "b" }),
      await insertActiveQueueRow(blackhole.id, { downloadId: "c" }),
    ];

    await cleanupStalledDownloads();

    for (const row of rows) expect(await queueStatus(row.id)).toBe("downloading");
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(notifyFailed).not.toHaveBeenCalled();
  });
});

describe("chooseBestResult — torrents nobody seeds", () => {
  const allowed = ["WEBDL-1080p", "Bluray-1080p"];

  it("prefers a seeded release of a lower allowed tier over an unseeded one at the top tier", async () => {
    const dead = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-GRP", seeders: 0, downloadUrl: "magnet:?xt=dead" });
    const seeded = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", seeders: 300, downloadUrl: "magnet:?xt=seeded" });

    const best = await chooseBestResult([dead, seeded], allowed, "Bluray-1080p", null, 0, null, new Set(), "movie");

    expect(best).toEqual({ result: seeded, quality: "WEBDL-1080p" });
  });

  it("still takes an unseeded torrent when nothing else is on offer, and never counts unknown seeders or usenet as unseeded", async () => {
    const dead = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-GRP", seeders: 0, downloadUrl: "magnet:?xt=dead" });
    const seeded = fakeResult({ title: "Movie.2020.1080p.WEB-DL-GRP", seeders: 300, downloadUrl: "magnet:?xt=seeded" });
    const unknownSeeders = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-GRP", seeders: null, downloadUrl: "magnet:?xt=unknown" });
    const nzb = fakeResult({ title: "Movie.2020.1080p.BluRay.x264-NZB", protocol: "usenet", seeders: 0, downloadUrl: "https://nzb/1" });
    const choose = (results: any[]) => chooseBestResult(results, allowed, "Bluray-1080p", null, 0, null, new Set(), "movie");

    expect((await choose([dead]))?.result).toBe(dead);
    expect((await choose([seeded, unknownSeeders]))?.result).toBe(unknownSeeders);
    expect((await choose([seeded, nzb]))?.result).toBe(nzb);
  });
});

describe("pollQueue — imports that fail on the library side", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-sched-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function fsError(code: string, paths: { path?: string; dest?: string }): Error {
    return Object.assign(new Error(`${code}: import failed`), { code, ...paths });
  }

  function completesEverything() {
    return fakeAdapter({
      getStatus: vi.fn(async (_client: unknown, ids: string[]) => ids.map((downloadId) => ({ downloadId, progress: 1, status: "completed" }))),
    });
  }

  it("keeps a download whose import can't write to the library for a manual import, without blocklisting or re-grabbing it", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(completesEverything());
    importQueueItem.mockRejectedValue(fsError("EACCES", { path: "/media/movies/Movie (2020)" }));
    const { id, mediaItemId } = await insertActiveQueueRow(client.id, { addedHoursAgo: 1 });

    await pollQueue();

    expect(await queueStatus(id)).toBe("completed");
    expect(await blocklistedTitles(mediaItemId)).toEqual([]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("EACCES"));
  });

  it("tells a missing destination (kept for a manual import) apart from a download whose files are gone (retried)", async () => {
    const library = path.join(tmp, "library");
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(library);
    const source = path.join(tmp, "Some.Release.mkv");
    fs.writeFileSync(source, "x");
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(completesEverything());
    const destMissing = await insertActiveQueueRow(client.id, { downloadId: "dest-missing", addedHoursAgo: 1 });
    const sourceGone = await insertActiveQueueRow(client.id, { downloadId: "source-gone", addedHoursAgo: 1 });
    const libraryFolderMissing = await insertActiveQueueRow(client.id, { downloadId: "library-folder", addedHoursAgo: 1 });
    const downloadFolderMissing = await insertActiveQueueRow(client.id, { downloadId: "download-folder", addedHoursAgo: 1 });
    const errors = new Map<number, Error>([
      [destMissing.id, fsError("ENOENT", { path: source, dest: path.join(library, "Movie", "Movie.mkv") })],
      [sourceGone.id, fsError("ENOENT", { path: path.join(tmp, "gone.mkv"), dest: path.join(library, "Movie", "Movie.mkv") })],
      [libraryFolderMissing.id, fsError("ENOENT", { path: path.join(library, "Movie") })],
      [downloadFolderMissing.id, fsError("ENOENT", { path: path.join(tmp, "downloads", "Some.Release") })],
    ]);
    importQueueItem.mockImplementation(async (queueId: number) => {
      throw errors.get(queueId);
    });

    await pollQueue();

    expect(await queueStatus(destMissing.id)).toBe("completed");
    expect(await queueStatus(libraryFolderMissing.id)).toBe("completed");
    expect(await queueStatus(sourceGone.id)).toBe("failed");
    expect(await queueStatus(downloadFolderMissing.id)).toBe("failed");
    expect(await blocklistedTitles(destMissing.mediaItemId)).toEqual([]);
    expect(await blocklistedTitles(sourceGone.mediaItemId)).toEqual(["Some.Release.2020.1080p.WEB-DL-GRP"]);
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(2);
  });
});

describe("pollQueue — rows that change while a poll is running", () => {
  function reports(...updates: Record<string, unknown>[]) {
    return fakeAdapter({ getStatus: vi.fn().mockResolvedValue(updates) });
  }

  it("leaves a completed download alone while another import of it holds the import lock", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(reports({ downloadId: "dl-1", progress: 1, status: "completed" }));
    withQueueImportLock.mockResolvedValue(false);
    const { id, mediaItemId } = await insertActiveQueueRow(client.id, { addedHoursAgo: 1 });

    await pollQueue();

    expect(withQueueImportLock).toHaveBeenCalledWith(id, expect.any(Function));
    expect(importQueueItem).not.toHaveBeenCalled();
    expect(await queueStatus(id)).toBe("completed");
    expect(await blocklistedTitles(mediaItemId)).toEqual([]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
  });

  it("never imports, fails or replaces a row removed after the poll read it", async () => {
    const client = await insertClient();
    searchAllIndexers.mockResolvedValue([fakeResult({ downloadUrl: "magnet:?xt=replacement" })]);
    let removeFirst = 0;
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({
        addDownload: vi.fn().mockResolvedValue({ downloadId: "replacement" }),
        getStatus: vi.fn(async () => {
          await db.prepare("DELETE FROM queue WHERE id = ?").run(removeFirst);
          return [
            { downloadId: "removed-before-status", progress: 1, status: "completed" },
            { downloadId: "removed-during-import", progress: 1, status: "completed" },
          ];
        }),
      })
    );
    const beforeStatus = await insertActiveQueueRow(client.id, { downloadId: "removed-before-status", addedHoursAgo: 1 });
    const duringImport = await insertActiveQueueRow(client.id, { downloadId: "removed-during-import", addedHoursAgo: 1 });
    removeFirst = beforeStatus.id;
    importQueueItem.mockImplementation(async (queueId: number) => {
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
      throw new Error(`Queue item ${queueId} not found`);
    });

    await pollQueue();

    expect(importQueueItem.mock.calls.map((c) => c[0])).toEqual([duringImport.id]);
    expect(await queueStatus(beforeStatus.id)).toBeUndefined();
    expect(await queueStatus(duringImport.id)).toBeUndefined();
    expect(await blocklistedTitles(beforeStatus.mediaItemId)).toEqual([]);
    expect(await blocklistedTitles(duringImport.mediaItemId)).toEqual([]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("doesn't write a row back to downloading after deleting its client failed it mid-poll", async () => {
    const client = await insertClient();
    let rowId = 0;
    getDownloadClientAdapter.mockReturnValue(
      fakeAdapter({
        getStatus: vi.fn(async () => {
          // What deleting the client does meanwhile: its active rows fail, and the FK clears their client.
          await db.prepare("UPDATE queue SET status = 'failed', download_client_id = NULL WHERE id = ?").run(rowId);
          return [{ downloadId: "dl-1", progress: 0.5, status: "downloading" }];
        }),
      })
    );
    ({ id: rowId } = await insertActiveQueueRow(client.id, { addedHoursAgo: 1 }));

    await pollQueue();

    expect(await db.prepare("SELECT status, progress, download_client_id FROM queue WHERE id = ?").get(rowId)).toEqual({
      status: "failed",
      progress: 0,
      download_client_id: null,
    });
  });

  it("updates every row tracking the same download, and keeps a later one that can't import after an earlier one did, without blocklisting", async () => {
    const client = await insertClient();
    const getStatus = vi.fn().mockResolvedValue([{ downloadId: "dl-shared", progress: 0.5, status: "downloading" }]);
    getDownloadClientAdapter.mockReturnValue(fakeAdapter({ getStatus }));
    const first = await insertActiveQueueRow(client.id, { downloadId: "dl-shared", addedHoursAgo: 1 });
    const second = await insertActiveQueueRow(client.id, { downloadId: "dl-shared", addedHoursAgo: 1 });

    await pollQueue();

    const progressOf = async (id: number) => ((await db.prepare("SELECT progress FROM queue WHERE id = ?").get(id)) as { progress: number }).progress;
    expect([await progressOf(first.id), await progressOf(second.id)]).toEqual([0.5, 0.5]);

    getStatus.mockResolvedValue([{ downloadId: "dl-shared", progress: 1, status: "completed" }]);
    let imported = 0;
    importQueueItem.mockImplementation(async (queueId: number) => {
      // The first import takes the download's files with it.
      if (imported > 0) throw new Error("No video file found in the download");
      imported = queueId;
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
    });

    await pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(2);
    const leftOver = imported === first.id ? second : first;
    expect(await queueStatus(imported)).toBeUndefined();
    expect(await queueStatus(leftOver.id)).toBe("completed");
    expect(await blocklistedTitles(first.mediaItemId)).toEqual([]);
    expect(await blocklistedTitles(second.mediaItemId)).toEqual([]);
    expect(searchAllIndexers).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
  });

  it("counts a failed download tracked by several rows as one failure of its release, and still re-searches every row's target", async () => {
    const client = await insertClient();
    getDownloadClientAdapter.mockReturnValue(reports({ downloadId: "dl-shared", progress: 0, status: "failed" }));
    setSetting("removeFailedDownloads", "1");
    const release = "Some.Release.2020.1080p.WEB-DL-SHAREDFAILURE";
    const movie = await insertMovie();
    const otherMovie = await insertMovie({ title: "Heat", sort_title: "heat", year: 1995 });
    const insertRow = async (mediaItemId: number) =>
      Number(
        (
          await db
            .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status) VALUES (?, ?, ?, 'dl-shared', 'downloading')")
            .run(mediaItemId, release, client.id)
        ).lastInsertRowid
      );
    const rows = [await insertRow(movie.id), await insertRow(movie.id), await insertRow(otherMovie.id)];

    await pollQueue();

    for (const id of rows) expect(await queueStatus(id)).toBe("failed");
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(await blocklistedTitles(movie.id)).toEqual([release]);
    expect(await blocklistedTitles(otherMovie.id)).toEqual([release]);
    const stats = (await db.prepare("SELECT failures FROM release_group_stats WHERE LOWER(release_group) LIKE '%sharedfailure%'").all()) as { failures: number }[];
    expect(stats.map((s) => Number(s.failures))).toEqual([1]);
    expect(searchAllIndexers).toHaveBeenCalledTimes(3);
  });
});

describe("pruneOldFailedQueueItems — imports that were skipped", () => {
  it("prunes a week-old 'completed' row nobody imported, so its target can be searched again, and keeps a recent one", async () => {
    const old = await insertActiveQueueRow(null, { status: "completed", addedHoursAgo: 24 * 9, updatedHoursAgo: 24 * 8 });
    const recent = await insertActiveQueueRow(null, { status: "completed", addedHoursAgo: 2, updatedHoursAgo: 1 });

    await pruneOldFailedQueueItems();

    expect(await queueStatus(old.id)).toBeUndefined();
    expect(await isAlreadyQueued(old.mediaItemId, null, null)).toBe(false);
    expect(await queueStatus(recent.id)).toBe("completed");
  });
});

describe("scheduled Trakt / Plex watchlist syncs", () => {
  it("fail the job run when the sync reports an error, instead of recording a success", async () => {
    startScheduler();
    const trakt = registeredJobs.get("traktSync")!;
    const plex = registeredJobs.get("plexWatchlistSync")!;

    runTraktSync.mockResolvedValue({ added: 0, error: "Trakt returned HTTP 403" });
    await expect(trakt.run()).rejects.toThrow("HTTP 403");
    runPlexWatchlistSync.mockResolvedValue({ added: 0, error: "Plex returned HTTP 401" });
    await expect(plex.run()).rejects.toThrow("HTTP 401");

    runTraktSync.mockResolvedValue({ added: 2 });
    await expect(trakt.run()).resolves.toBeUndefined();
  });

  it("log a partial success's warning without failing the job run", async () => {
    startScheduler();
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      runPlexWatchlistSync.mockResolvedValue({ added: 1, warning: "2 item(s) not added: no root folder is configured for series" });
      await expect(registeredJobs.get("plexWatchlistSync")!.run()).resolves.toBeUndefined();
      runTraktSync.mockResolvedValue({ added: 0, warning: "1 item(s) not added: no root folder is configured for movie" });
      await expect(registeredJobs.get("traktSync")!.run()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith("[scheduler] Plex watchlist sync: 2 item(s) not added: no root folder is configured for series");
      expect(warn).toHaveBeenCalledWith("[scheduler] Trakt sync: 1 item(s) not added: no root folder is configured for movie");
    } finally {
      warn.mockRestore();
    }
  });
});
