import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30a: the queue poll hands finished downloads to an import lane (one import at a time) instead of waiting for
// each import itself, a row parked because "no library entry tracks it" is retried after a full library scan, and
// the 05:00 library scan skips itself right after another full scan.

const searchAllIndexers = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
}));

const getDownloadClientAdapter = vi.fn();
// Not the real lock (its own tests are queueImportLock.test.ts): it just runs the import and can be made to throw.
const withQueueImportLock = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  withQueueImportLock: (...args: unknown[]) => withQueueImportLock(...args),
}));

const importQueueItem = vi.fn();
vi.mock("../src/services/importer.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  importQueueItem: (...args: unknown[]) => importQueueItem(...args),
}));

const notifyManualInteractionRequired = vi.fn();
const notifyFailed = vi.fn();
vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
  notifyFailed: (...args: unknown[]) => notifyFailed(...args),
}));

// The scan itself is not under test here, only whether the 05:00 job starts it. recentFullScan stays the real one.
const scanAndImportAllLibraries = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  scanAndImportAllLibraries: (...args: unknown[]) => scanAndImportAllLibraries(...args),
}));

// startScheduler registers its jobs here instead of starting real timers; stopAllJobs/startAllJobs stay the real ones.
type RegisteredJob = { key: string; essential?: boolean; run: (signal: AbortSignal, info?: { manual: boolean }) => Promise<unknown> };
const registeredJobs = new Map<string, RegisteredJob>();
vi.mock("../src/services/jobRegistry.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  registerJob: (def: RegisteredJob) => registeredJobs.set(def.key, def),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let registry: typeof import("../src/services/jobRegistry.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let ImportSkippedError: (typeof import("../src/services/importer.js"))["ImportSkippedError"];
let ReleaseFaultError: (typeof import("../src/services/importer.js"))["ReleaseFaultError"];
let nowExpr: (typeof import("../src/db/asyncDb.js"))["nowExpr"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  registry = await import("../src/services/jobRegistry.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ ImportSkippedError, ReleaseFaultError } = await import("../src/services/importer.js"));
  ({ nowExpr } = await import("../src/db/asyncDb.js"));
});

/** Imports that have started and are waiting for the test to let them finish, by queue row id. */
const importGates = new Map<number, () => void>();

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "media_items", "download_clients"]) await db.prepare(`DELETE FROM ${t}`).run();
  searchAllIndexers.mockReset().mockResolvedValue([]);
  getDownloadClientAdapter.mockReset().mockReturnValue(reportsEverythingCompleted());
  withQueueImportLock.mockReset().mockImplementation(async (_queueId: number, importFn: () => Promise<void>) => {
    await importFn();
    return true;
  });
  importQueueItem.mockReset().mockResolvedValue(undefined);
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  notifyFailed.mockReset().mockResolvedValue(undefined);
  scanAndImportAllLibraries.mockReset().mockResolvedValue(undefined);
  setSetting("lastFullScanAt", "");
  importGates.clear();
  // Table ids restart after the wipe: this forgets what the poller remembers about rows that no longer exist
  // (retries already made, scans already retried after), so a new row with an old id starts clean.
  await scheduler.pollQueue();
});

afterEach(async () => {
  vi.useRealTimers();
  registry.startAllJobs(); // a test that stopped the jobs must not leave the lane refusing work
  for (const release of importGates.values()) release();
  await scheduler.whenImportLaneIdle();
});

function reportsEverythingCompleted() {
  return {
    getStatus: vi.fn(async (_client: unknown, ids: string[]) => [...new Set(ids)].map((downloadId) => ({ downloadId, progress: 1, status: "completed" }))),
  };
}

async function insertClient(): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run()).lastInsertRowid);
}

interface RowOptions {
  importStarted?: boolean;
  skippedReason?: string | null;
  updatedAt?: string;
  resumeState?: number;
}

async function insertQueueRow(clientId: number, status: string, downloadId: string, options: RowOptions = {}): Promise<number> {
  const movie = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, status) VALUES ('movie', ?, ?, 'missing')").run(`Movie ${downloadId}`, `movie ${downloadId}`))
      .lastInsertRowid
  );
  const id = Number(
    (
      await db
        .prepare(
          `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, import_started_at, import_skipped_reason, import_resume_state)
           VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP', ?, ?, ?, 1, ${options.importStarted ? nowExpr(db) : "NULL"}, ?, ?)`
        )
        .run(movie, clientId, downloadId, status, options.skippedReason ?? null, options.resumeState ?? 0)
    ).lastInsertRowid
  );
  if (options.updatedAt) await db.prepare("UPDATE queue SET updated_at = ? WHERE id = ?").run(options.updatedAt, id);
  return id;
}

async function importState(id: number) {
  const row = (await db.prepare("SELECT status, import_started_at, import_skipped_reason, import_resume_state FROM queue WHERE id = ?").get(id)) as
    | { status: string; import_started_at: string | null; import_skipped_reason: string | null; import_resume_state: number | string }
    | undefined;
  return row && { status: row.status, started: row.import_started_at !== null, skippedReason: row.import_skipped_reason, resumeState: Number(row.import_resume_state) };
}

/**
 * Replaces the importer with one whose imports each wait until the test releases them, and that records the order
 * and overlap of what ran. A finished import removes its row, as the real importer does.
 */
function controlledImporter(options: { failFor?: number[] } = {}) {
  const started: number[] = [];
  const finished: number[] = [];
  let running = 0;
  let mostAtOnce = 0;
  importQueueItem.mockImplementation(async (queueId: number) => {
    const startedBefore = started.includes(queueId);
    started.push(queueId);
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    // A row imported a second time (which only a bug lets happen) does not wait, so that the test fails on what it
    // recorded instead of hanging.
    if (!startedBefore) await new Promise<void>((resolve) => importGates.set(queueId, resolve));
    running--;
    finished.push(queueId);
    // A row listed in failFor ends with a file error (the row stays, parked again) instead of being imported.
    if (options.failFor?.includes(queueId)) throw Object.assign(new Error("EIO: i/o error again"), { code: "EIO" });
    await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
  });
  return {
    started,
    finished,
    mostAtOnce: () => mostAtOnce,
    release: (queueId: number) => importGates.get(queueId)?.(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the import lane", () => {
  it("lets a background poll return while a slow import is still running, and imports the row on the lane", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "downloading", "dl-slow");
    const importer = controlledImporter();

    await scheduler.pollQueue({ background: true }); // would never return if it waited for the import

    await vi.waitFor(() => expect(importer.started).toEqual([id]));
    expect(importer.finished).toEqual([]);
    expect(scheduler.importLaneBusy()).toBe(true);
    // The row was claimed in the same write that completed it, so a restart now would still find it.
    expect(await importState(id)).toMatchObject({ status: "completed", started: true });

    importer.release(id);
    await scheduler.whenImportLaneIdle();

    expect(importer.finished).toEqual([id]);
    expect(scheduler.importLaneBusy()).toBe(false);
    expect(await importState(id)).toBeUndefined();
  });

  it("imports two completed downloads one at a time, in the order the client listed them", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-first");
    const second = await insertQueueRow(clientId, "downloading", "dl-second");
    const importer = controlledImporter();

    await scheduler.pollQueue({ background: true });

    await vi.waitFor(() => expect(importer.started).toEqual([first]));
    await sleep(60); // long enough for a second import to start beside the first, if it were going to
    expect(importer.started).toEqual([first]);
    expect(scheduler.importLaneBusy()).toBe(true);

    importer.release(first);
    await vi.waitFor(() => expect(importer.started).toEqual([first, second]));
    expect(importer.finished).toEqual([first]);
    expect(scheduler.importLaneBusy()).toBe(true); // the second is still running

    importer.release(second);
    await scheduler.whenImportLaneIdle();

    expect(importer.finished).toEqual([first, second]);
    expect(importer.mostAtOnce()).toBe(1);
    expect(scheduler.importLaneBusy()).toBe(false);
  });

  it("queues the imports of a second poll behind those of the first", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-poll-one");
    const importer = controlledImporter();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([first]));

    const second = await insertQueueRow(clientId, "downloading", "dl-poll-two");
    await scheduler.pollQueue({ background: true }); // the first poll's import is still running
    await sleep(60);
    expect(importer.started).toEqual([first]);

    importer.release(first);
    await vi.waitFor(() => expect(importer.started).toEqual([first, second]));
    importer.release(second);
    await scheduler.whenImportLaneIdle();
    expect(importer.mostAtOnce()).toBe(1);
  });

  it("imports every row that shares one download, and tells a later row that an earlier one took the files", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-shared");
    const second = await insertQueueRow(clientId, "downloading", "dl-shared");
    importQueueItem.mockImplementation(async (queueId: number) => {
      if (queueId === first) {
        await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
        return;
      }
      throw new ReleaseFaultError('No matching file found in downloads directory for "Movie.2020.1080p.WEB-DL-GRP"');
    });

    await scheduler.pollQueue({ background: true });
    await scheduler.whenImportLaneIdle();

    expect(importQueueItem.mock.calls.map((call) => call[0])).toEqual([first, second]);
    // Not the release's fault (the files went to the first row): left for the admin, not failed, not blocklisted.
    const state = await importState(second);
    expect(state).toMatchObject({ status: "completed", started: false });
    expect(state?.skippedReason).toMatch(/^Another queue entry for the same download was already imported: No matching file found/);
    expect(await db.prepare("SELECT * FROM blocklist").all()).toEqual([]);
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
  });

  it("does not call a later row's failure shared when the earlier row of the download was not imported", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-shared-none");
    const second = await insertQueueRow(clientId, "downloading", "dl-shared-none");
    importQueueItem.mockImplementation(async (queueId: number) => {
      if (queueId === first) throw new ImportSkippedError("No root folder is configured for movie");
      throw new ReleaseFaultError("No matching file found in downloads directory");
    });

    await scheduler.pollQueue({ background: true });
    await scheduler.whenImportLaneIdle();

    expect(importQueueItem.mock.calls.map((call) => call[0])).toEqual([first, second]);
    expect(await importState(first)).toMatchObject({ status: "completed", started: false, skippedReason: "No root folder is configured for movie" });
    // Nothing took the files, so this one is the release's own fault, as it would be on an inline poll.
    expect(await importState(second)).toMatchObject({ status: "failed", started: false });
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("skips a row that was removed or changed in Activity between the hand-over and its turn", async () => {
    const clientId = await insertClient();
    const running = await insertQueueRow(clientId, "downloading", "dl-running");
    const removed = await insertQueueRow(clientId, "downloading", "dl-removed");
    const failedMeanwhile = await insertQueueRow(clientId, "downloading", "dl-failed-meanwhile");
    const last = await insertQueueRow(clientId, "downloading", "dl-last");
    const importer = controlledImporter();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([running]));

    await db.prepare("DELETE FROM queue WHERE id = ?").run(removed);
    await db.prepare("UPDATE queue SET status = 'failed' WHERE id = ?").run(failedMeanwhile);
    importer.release(running);
    await vi.waitFor(() => expect(importer.started).toEqual([running, last]));
    importer.release(last);
    await scheduler.whenImportLaneIdle();

    expect(importer.started).toEqual([running, last]);
    expect(await importState(failedMeanwhile)).toMatchObject({ status: "failed" }); // left as the admin (or a failure) made it
  });

  it("skips the later row of a shared download that was removed while the earlier one was importing", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-pair");
    const second = await insertQueueRow(clientId, "downloading", "dl-pair");
    const importer = controlledImporter();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([first]));

    await db.prepare("DELETE FROM queue WHERE id = ?").run(second);
    importer.release(first);
    await scheduler.whenImportLaneIdle();

    expect(importer.started).toEqual([first]);
    expect(scheduler.importLaneBusy()).toBe(false);
  });

  it("does not hand a parked row to the lane again while it is still waiting there", async () => {
    const clientId = await insertClient();
    const parked = await insertQueueRow(clientId, "completed", "dl-parked", { skippedReason: "Couldn't place the file: EIO: i/o error" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    await scheduler.pollQueue({ background: true }); // sees the parked row and schedules the first retry

    const blocker = await insertQueueRow(clientId, "downloading", "dl-blocker");
    // The parked row's retry ends parked again, so a second hand-over would claim it again and import it a second time.
    const importer = controlledImporter({ failFor: [parked] });
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([blocker])); // the lane is busy

    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    await scheduler.pollQueue({ background: true }); // the first retry is due: handed over, waiting behind the blocker
    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    await scheduler.pollQueue({ background: true }); // the second would be due, but the row is still on the lane
    expect(importer.started).toEqual([blocker]);

    importer.release(blocker);
    await vi.waitFor(() => expect(importer.started).toEqual([blocker, parked]));
    importer.release(parked);
    await scheduler.whenImportLaneIdle();

    expect(importer.started).toEqual([blocker, parked]);
    expect(await importState(parked)).toMatchObject({ status: "completed", started: false });
  });

  it("keeps the one retry of a resumed import unclaimed while it waits for its turn on the lane", async () => {
    const clientId = await insertClient();
    const blocker = await insertQueueRow(clientId, "downloading", "dl-blocker");
    const importer = controlledImporter();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([blocker])); // the lane is busy

    // A restart cut this one off earlier and handed it back (resume state 1, not claimed).
    const cutOff = await insertQueueRow(clientId, "completed", "dl-cut-off", { resumeState: 1 });
    await scheduler.pollQueue({ background: true });
    await scheduler.pollQueue({ background: true }); // a second poll must not hand it over again
    expect(importer.started).toEqual([blocker]);
    expect(await importState(cutOff)).toMatchObject({ status: "completed", started: false, resumeState: 1 });

    importer.release(blocker);
    await vi.waitFor(() => expect(importer.started).toEqual([blocker, cutOff]));
    // Claimed when its turn came: its one retry is now used.
    expect(await importState(cutOff)).toMatchObject({ status: "completed", started: true, resumeState: 2 });
    importer.release(cutOff);
    await scheduler.whenImportLaneIdle();

    expect(importer.started).toEqual([blocker, cutOff]);
    expect(importer.mostAtOnce()).toBe(1);
  });

  it("starts nothing that was still waiting on the lane once the jobs were stopped, and leaves its claim for the next start", async () => {
    const clientId = await insertClient();
    const running = await insertQueueRow(clientId, "downloading", "dl-running");
    const waiting = await insertQueueRow(clientId, "downloading", "dl-waiting");
    const importer = controlledImporter();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([running]));

    registry.stopAllJobs(); // a shutdown or a backup restore
    importer.release(running);
    await scheduler.whenImportLaneIdle();

    expect(importer.started).toEqual([running]);
    expect(scheduler.importLaneBusy()).toBe(false);
    // Still claimed, so the restart's hand-back (resumeInterruptedImports) finds it and gives it its one retry.
    expect(await importState(waiting)).toMatchObject({ status: "completed", started: true });
    await scheduler.resumeInterruptedImports();
    expect(await importState(waiting)).toMatchObject({ status: "completed", started: false, resumeState: 1 });

    registry.startAllJobs();
    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importer.started).toEqual([running, waiting]));
    importer.release(waiting);
    await scheduler.whenImportLaneIdle();
    expect(await importState(waiting)).toBeUndefined();
  });

  it("goes on with the imports behind one that failed unexpectedly, and ends idle", async () => {
    const clientId = await insertClient();
    const broken = await insertQueueRow(clientId, "downloading", "dl-broken");
    const behind = await insertQueueRow(clientId, "downloading", "dl-behind");
    withQueueImportLock.mockRejectedValueOnce(new Error("lock exploded"));
    importQueueItem.mockImplementation(async (queueId: number) => {
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
    });

    await scheduler.pollQueue({ background: true });
    await scheduler.whenImportLaneIdle();

    expect(importQueueItem.mock.calls.map((call) => call[0])).toEqual([behind]);
    expect(await importState(behind)).toBeUndefined();
    expect(await importState(broken)).toMatchObject({ status: "completed", started: true }); // still claimed for the restart's hand-back
    expect(scheduler.importLaneBusy()).toBe(false);
  });

  it("is not busy when nothing was handed over", async () => {
    expect(scheduler.importLaneBusy()).toBe(false);
    await scheduler.pollQueue({ background: true });
    expect(scheduler.importLaneBusy()).toBe(false);
    await scheduler.whenImportLaneIdle();
  });
});

describe("the default poll", () => {
  it("still waits for every import before it returns, without using the lane", async () => {
    const clientId = await insertClient();
    const first = await insertQueueRow(clientId, "downloading", "dl-inline-one");
    const second = await insertQueueRow(clientId, "downloading", "dl-inline-two");
    const importer = controlledImporter();
    let polled = false;

    const poll = scheduler.pollQueue().then(() => (polled = true));
    await vi.waitFor(() => expect(importer.started).toEqual([first]));
    await sleep(40);
    expect(polled).toBe(false);
    expect(scheduler.importLaneBusy()).toBe(false);

    importer.release(first);
    await vi.waitFor(() => expect(importer.started).toEqual([first, second]));
    await sleep(40);
    expect(polled).toBe(false);

    importer.release(second);
    await poll;
    expect(polled).toBe(true);
    expect(importer.finished).toEqual([first, second]);
    expect(importer.mostAtOnce()).toBe(1);
  });
});

describe("the Queue Poll job", () => {
  it("cannot be switched off and hands its imports to the lane", async () => {
    scheduler.startScheduler(); // registers once per process; the tables are empty after beforeEach
    const job = registeredJobs.get("queuePoll")!;
    expect(job.essential).toBe(true);

    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "downloading", "dl-job");
    const importer = controlledImporter();

    await job.run(new AbortController().signal); // returns although the import has not finished

    await vi.waitFor(() => expect(importer.started).toEqual([id]));
    expect(scheduler.importLaneBusy()).toBe(true);
    importer.release(id);
    await scheduler.whenImportLaneIdle();
    expect(await importState(id)).toBeUndefined();
  });
});

describe("a row parked because no library entry tracks its destination", () => {
  const UNTRACKED = `"/media/Movie (2020)/Movie (2020).mkv" already exists and no library entry tracks it — not overwriting it. Scan the library to link it, or move it away, then retry the import.`;
  const HOUR = 3_600_000;

  /** The time as the database writes it. */
  const sqlTime = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
  const scanFinished = (msAgo: number) => setSetting("lastFullScanAt", new Date(Date.now() - msAgo).toISOString());
  const parkedRow = (clientId: number, parkedMsAgo: number, reason = UNTRACKED) =>
    insertQueueRow(clientId, "completed", `dl-untracked-${Math.random()}`, { skippedReason: reason, updatedAt: sqlTime(parkedMsAgo) });

  it("is imported again once a full scan has finished after it was parked, and the row goes when that works", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 2 * HOUR);
    scanFinished(HOUR);
    importQueueItem.mockImplementation(async (queueId: number) => {
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
    });

    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(importQueueItem).toHaveBeenCalledWith(id);
    expect(await importState(id)).toBeUndefined();
  });

  it("waits while the last full scan is older than the parking, and is retried after the next scan", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, HOUR);
    scanFinished(3 * HOUR);

    await scheduler.pollQueue();
    expect(importQueueItem).not.toHaveBeenCalled();

    scanFinished(0);
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(importQueueItem).toHaveBeenCalledWith(id);
  });

  it("is not retried at all before any full scan was recorded", async () => {
    const clientId = await insertClient();
    await parkedRow(clientId, 5 * HOUR);

    await scheduler.pollQueue();

    expect(importQueueItem).not.toHaveBeenCalled();
  });

  it("is retried once per scan, and a retry that ends with the same reason is not announced again", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 3 * HOUR);
    scanFinished(2 * HOUR);
    importQueueItem.mockRejectedValue(new ImportSkippedError(UNTRACKED)); // the file is still not linked

    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(await importState(id)).toEqual({ status: "completed", started: false, skippedReason: UNTRACKED, resumeState: 0 });

    // Polls with no new scan leave it alone.
    await scheduler.pollQueue();
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(1);

    // The next scan earns one more try, still with nothing new to tell the admin.
    scanFinished(0);
    await scheduler.pollQueue();
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(2);
    expect(await importState(id)).toEqual({ status: "completed", started: false, skippedReason: UNTRACKED, resumeState: 0 });
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("announces a retry that ends with a different reason", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 2 * HOUR);
    scanFinished(HOUR);
    const newReason = "Not an upgrade: the library already has a \"Bluray-1080p\" file here and this download is \"HDTV-720p\" — left in the download for a manual import";
    importQueueItem.mockRejectedValue(new ImportSkippedError(newReason));

    await scheduler.pollQueue();

    expect(await importState(id)).toMatchObject({ status: "completed", started: false, skippedReason: newReason });
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
    expect(notifyManualInteractionRequired.mock.calls[0][1]).toBe(newReason);
  });

  it("is the only kind of parked row the scan retries", async () => {
    const clientId = await insertClient();
    await parkedRow(clientId, 2 * HOUR, "Not an upgrade: the library has Remux-2160p");
    await parkedRow(clientId, 2 * HOUR, "No root folder is configured for movie");
    scanFinished(HOUR);

    await scheduler.pollQueue();

    expect(importQueueItem).not.toHaveBeenCalled();
  });

  // Built when a test runs: ReleaseFaultError is imported only once the test database is up.
  const gone = () =>
    Object.assign(new Error("ENOENT: no such file or directory, stat '/downloads/Movie.2020.1080p.WEB-DL-GRP.mkv'"), {
      code: "ENOENT",
      path: "/downloads/Movie.2020.1080p.WEB-DL-GRP.mkv",
    });
  const noFile = () => new ReleaseFaultError('No matching file found in downloads directory for "Movie.2020.1080p.WEB-DL-GRP"');

  const retryErrors: [string, () => Error][] = [
    ["its source is gone from the downloads folder", gone],
    ["nothing importable is found for the release", noFile],
  ];

  it.each(retryErrors)("stays parked for the admin, never failed or grabbed again, when its retry finds that %s", async (_what, makeError) => {
    const error = makeError();
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 2 * HOUR);
    scanFinished(HOUR);
    importQueueItem.mockRejectedValue(error);

    await scheduler.pollQueue();

    const expected = `${UNTRACKED} (retried after the library scan: ${error.message})`;
    expect(await importState(id)).toEqual({ status: "completed", started: false, skippedReason: expected, resumeState: 0 });
    expect(await db.prepare("SELECT * FROM blocklist").all()).toEqual([]);
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(searchAllIndexers).not.toHaveBeenCalled(); // no other release is looked for
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
    expect(notifyManualInteractionRequired.mock.calls[0][1]).toBe(expected);
  });

  it("keeps one note of its last retry on the row, and does not announce the same note twice", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 3 * HOUR);
    scanFinished(2 * HOUR);
    importQueueItem.mockRejectedValue(noFile());

    await scheduler.pollQueue();
    const afterFirst = await importState(id);
    scanFinished(-60_000); // the next full scan, finishing after the first retry parked the row again
    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(2);
    expect(await importState(id)).toEqual(afterFirst);
    expect(afterFirst?.skippedReason?.match(/\(retried after the library scan:/g)).toHaveLength(1);
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
  });

  /** When the database says the row last changed. */
  async function updatedAt(id: number): Promise<number> {
    const row = (await db.prepare("SELECT updated_at FROM queue WHERE id = ?").get(id)) as { updated_at: string | Date };
    if (row.updated_at instanceof Date) return row.updated_at.getTime();
    return Date.parse(`${row.updated_at.replace(" ", "T")}Z`); // SQLite writes UTC without a zone
  }

  it("moves the row's change time forward when an import is parked again, so only a later scan retries it", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 3 * HOUR);
    scanFinished(2 * HOUR);
    importQueueItem.mockRejectedValue(new ImportSkippedError(UNTRACKED));
    const parkedBefore = await updatedAt(id);

    await scheduler.pollQueue(); // the retry ends parked again
    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(await updatedAt(id)).toBeGreaterThan(parkedBefore + HOUR); // moved to about now

    // A scan that finished after the old parking but before the new one has nothing new to offer.
    scanFinished(HOUR);
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(1);

    // One that finishes after it does.
    scanFinished(-60_000);
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a scan that finished while the import that parked the row was still running", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "downloading", "dl-parked-late");
    let finishImport!: () => void;
    const importRunning = new Promise<void>((resolve) => (finishImport = resolve));
    importGates.set(id, finishImport); // opened in afterEach at the latest
    importQueueItem.mockImplementationOnce(async () => {
      await importRunning;
      throw new ImportSkippedError(UNTRACKED); // the destination holds a file nothing tracks
    });

    await scheduler.pollQueue({ background: true });
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(1));
    scanFinished(0); // a full scan ends while the import is still going ...
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // (the database keeps whole seconds)
    finishImport(); // ... and only then does the import park the row
    await scheduler.whenImportLaneIdle();
    expect(await importState(id)).toMatchObject({ status: "completed", started: false, skippedReason: UNTRACKED });

    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(1); // that scan came before the parking: no retry
  });

  it("is retried on the import lane by a background poll", async () => {
    const clientId = await insertClient();
    const id = await parkedRow(clientId, 2 * HOUR);
    scanFinished(HOUR);
    const importer = controlledImporter();

    await scheduler.pollQueue({ background: true }); // returns while the retry is still running

    await vi.waitFor(() => expect(importer.started).toEqual([id]));
    expect(scheduler.importLaneBusy()).toBe(true);
    expect(await importState(id)).toMatchObject({ status: "completed", started: true });
    importer.release(id);
    await scheduler.whenImportLaneIdle();
    expect(importer.finished).toEqual([id]);
    expect(scheduler.importLaneBusy()).toBe(false);
  });
});

describe("the 05:00 library scan job", () => {
  const HOUR = 3_600_000;
  const scanFinished = (msAgo: number) => setSetting("lastFullScanAt", new Date(Date.now() - msAgo).toISOString());
  const runScheduled = (signal = new AbortController().signal) => registeredJobs.get("libraryScan")!.run(signal, { manual: false });

  beforeEach(() => {
    scheduler.startScheduler(); // registers once per process
  });

  it("is a heavy cron job that runs at 05:00", () => {
    expect(registeredJobs.get("libraryScan")).toMatchObject({ heavy: true, scheduleType: "cron", defaultSchedule: "0 5 * * *" });
  });

  it("skips itself when a full scan finished within the last 4 hours", async () => {
    scanFinished(HOUR);

    await runScheduled();

    expect(scanAndImportAllLibraries).not.toHaveBeenCalled();
  });

  it("skips itself on a run that carries no trigger information, as a scheduled one", async () => {
    scanFinished(HOUR);

    await registeredJobs.get("libraryScan")!.run(new AbortController().signal);

    expect(scanAndImportAllLibraries).not.toHaveBeenCalled();
  });

  it("scans when 'Run now' asks for it, however recent the last scan", async () => {
    scanFinished(5 * 60_000);
    const signal = new AbortController().signal;

    await registeredJobs.get("libraryScan")!.run(signal, { manual: true });

    expect(scanAndImportAllLibraries).toHaveBeenCalledTimes(1);
    expect(scanAndImportAllLibraries).toHaveBeenCalledWith(signal);
  });

  it("scans when the last full scan is older than 4 hours", async () => {
    scanFinished(4 * HOUR + 10 * 60_000);
    const signal = new AbortController().signal;

    await runScheduled(signal);

    expect(scanAndImportAllLibraries).toHaveBeenCalledTimes(1);
    expect(scanAndImportAllLibraries).toHaveBeenCalledWith(signal);
  });

  it("still skips just inside the 4 hours", async () => {
    scanFinished(4 * HOUR - 10 * 60_000);

    await runScheduled();

    expect(scanAndImportAllLibraries).not.toHaveBeenCalled();
  });

  it("scans when no full scan was ever recorded", async () => {
    await runScheduled();

    expect(scanAndImportAllLibraries).toHaveBeenCalledTimes(1);
  });
});
