import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
}));

// Imports run one at a time in these tests; the lock itself is covered by queueImportLock.test.ts,
// and a restart clears it along with everything else in memory, which a test can't.
const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  withQueueImportLock: async (_queueId: number, importFn: () => Promise<void>) => {
    await importFn();
    return true;
  },
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

// startScheduler registers its jobs here instead of starting real timers.
const registeredJobs = new Map<string, { run: (signal?: AbortSignal) => Promise<unknown> }>();
vi.mock("../src/services/jobRegistry.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  registerJob: (def: { key: string; run: (signal?: AbortSignal) => Promise<unknown> }) => registeredJobs.set(def.key, def),
  startAllJobs: () => {},
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let ImportSkippedError: (typeof import("../src/services/importer.js"))["ImportSkippedError"];
let nowExpr: (typeof import("../src/db/asyncDb.js"))["nowExpr"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  ({ ImportSkippedError } = await import("../src/services/importer.js"));
  ({ nowExpr } = await import("../src/db/asyncDb.js"));
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "media_items", "download_clients"]) await db.prepare(`DELETE FROM ${t}`).run();
  searchAllIndexers.mockReset().mockResolvedValue([]);
  getDownloadClientAdapter.mockReset().mockReturnValue(reportsEverythingCompleted());
  importQueueItem.mockReset().mockResolvedValue(undefined);
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  notifyFailed.mockReset().mockResolvedValue(undefined);
});

function reportsEverythingCompleted() {
  return { getStatus: vi.fn(async (_client: unknown, ids: string[]) => ids.map((downloadId) => ({ downloadId, progress: 1, status: "completed" }))) };
}

async function insertClient(): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run()).lastInsertRowid);
}

async function insertQueueRow(clientId: number, status: string, downloadId: string, importStarted = false): Promise<number> {
  const movie = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, status) VALUES ('movie', ?, ?, 'missing')").run(`Movie ${downloadId}`, `movie ${downloadId}`))
      .lastInsertRowid
  );
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, import_started_at)
           VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP', ?, ?, ?, 1, ${importStarted ? nowExpr(db) : "NULL"})`
        )
        .run(movie, clientId, downloadId, status)
    ).lastInsertRowid
  );
}

async function importState(id: number) {
  const row = (await db.prepare("SELECT status, import_started_at, import_skipped_reason, import_resume_state FROM queue WHERE id = ?").get(id)) as
    | { status: string; import_started_at: string | null; import_skipped_reason: string | null; import_resume_state: number | string }
    | undefined;
  return row && { status: row.status, started: row.import_started_at !== null, skippedReason: row.import_skipped_reason, resumeState: Number(row.import_resume_state) };
}

/** An import that never returns, the way one cut off by a restart looks to the database. */
function hangingImport() {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => (finish = resolve));
  importQueueItem.mockImplementationOnce(() => settled);
  return finish;
}

describe("queue imports cut off by a restart", () => {
  // Runs first: startScheduler's startup pass runs once per process.
  it("are retried once by the queue poller after a restart, and left for a manual import when cut off again", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "downloading", "dl-resume");

    // The client reports the download complete; the process dies while it's being imported.
    const finishFirst = hangingImport();
    const firstPoll = scheduler.pollQueue();
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(1));
    expect(await importState(id)).toMatchObject({ status: "completed", started: true, resumeState: 0 });

    // Restart: the startup pass hands it back, and the first poll imports it again.
    scheduler.startScheduler();
    const finishSecond = hangingImport();
    const resumingPoll = registeredJobs.get("queuePoll")!.run();
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(2));
    expect(importQueueItem).toHaveBeenLastCalledWith(id);
    expect(await importState(id)).toMatchObject({ status: "completed", started: true, resumeState: 2 });

    // Cut off again: the next restart leaves it for a manual import, without notifying.
    await scheduler.resumeInterruptedImports();
    expect(await importState(id)).toEqual({
      status: "completed",
      started: false,
      skippedReason: "Import was interrupted by a restart twice — use Manual import",
      resumeState: 2,
    });
    await scheduler.pollQueue();
    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(2);
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();

    finishFirst();
    finishSecond();
    await Promise.all([firstPoll, resumingPoll]);
  });

  it("resumes a row that was completed but not yet imported, and a resumed import that succeeds removes it", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "completed", "dl-once", true);
    importQueueItem.mockImplementation(async (queueId: number) => {
      await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
    });

    await scheduler.resumeInterruptedImports();
    expect(await importState(id)).toMatchObject({ status: "completed", started: false, resumeState: 1 });
    // A second restart before any poll keeps the one retry it's owed.
    await scheduler.resumeInterruptedImports();
    expect(await importState(id)).toMatchObject({ started: false, skippedReason: null, resumeState: 1 });

    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(await importState(id)).toBeUndefined();
  });

  it("never re-runs or re-notifies an import that was skipped on purpose, or a row from before the import was marked", async () => {
    const clientId = await insertClient();
    const skipped = await insertQueueRow(clientId, "downloading", "dl-skip");
    const legacy = await insertQueueRow(clientId, "completed", "dl-legacy");
    importQueueItem.mockRejectedValue(new ImportSkippedError("No root folder is configured for movie"));

    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(importQueueItem).toHaveBeenCalledWith(skipped);
    expect(await importState(skipped)).toEqual({ status: "completed", started: false, skippedReason: "No root folder is configured for movie", resumeState: 0 });
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);

    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();
    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
    expect(await importState(skipped)).toMatchObject({ status: "completed", started: false, resumeState: 0 });
    expect(await importState(legacy)).toEqual({ status: "completed", started: false, skippedReason: null, resumeState: 0 });
  });

  it("never retries a Manual import a restart cut off, and one that ends leaves the row as it was", async () => {
    const clientId = await insertClient();
    const cutOff = await insertQueueRow(clientId, "completed", "dl-manual-cut");
    const failed = await insertQueueRow(clientId, "completed", "dl-manual-fail");
    await scheduler.markQueueImportStarted(cutOff, true);
    await scheduler.markQueueImportStarted(failed, true);
    expect(await importState(cutOff)).toMatchObject({ status: "completed", started: true });
    await scheduler.markQueueImportFailed(failed, new Error("Not a video file"));
    expect(await importState(failed)).toEqual({ status: "completed", started: false, skippedReason: null, resumeState: 0 });

    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();
    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();

    expect(importQueueItem).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
    expect(await importState(cutOff)).toEqual({
      status: "completed",
      started: false,
      skippedReason: "Manual import was interrupted by a restart — run it again",
      resumeState: 0,
    });
    expect(await importState(failed)).toEqual({ status: "completed", started: false, skippedReason: null, resumeState: 0 });
  });

  it("sends a resumed Retry import of a skipped row back to the admin when it fails, without blocklisting the release", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "completed", "dl-skipped-retry");
    await db.prepare("UPDATE queue SET import_skipped_reason = 'No root folder is configured for movie' WHERE id = ?").run(id);
    // Activity's Retry import starts, then a restart cuts it off.
    await scheduler.markQueueImportStarted(id);
    await scheduler.resumeInterruptedImports();
    importQueueItem.mockRejectedValue(new Error("No matching file found in downloads directory"));

    await scheduler.pollQueue();

    expect(importQueueItem).toHaveBeenCalledWith(id);
    const state = await importState(id);
    expect(state).toMatchObject({ status: "completed", started: false });
    expect(state?.skippedReason).toContain("No root folder is configured for movie");
    expect(await db.prepare("SELECT * FROM blocklist").all()).toEqual([]);
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
  });

  it("clears the mark when an import fails, so the failed row is never resumed", async () => {
    const clientId = await insertClient();
    const id = await insertQueueRow(clientId, "downloading", "dl-fail");
    importQueueItem.mockRejectedValue(new Error("No matching file found in downloads directory"));

    await scheduler.pollQueue();

    expect(await importState(id)).toMatchObject({ status: "failed", started: false, resumeState: 0 });
    expect(notifyFailed).toHaveBeenCalledTimes(1);

    await scheduler.resumeInterruptedImports();
    await scheduler.pollQueue();
    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(await importState(id)).toMatchObject({ status: "failed", started: false });
  });
});
