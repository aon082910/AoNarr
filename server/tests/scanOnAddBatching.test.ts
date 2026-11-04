import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const scanAndImportItems = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/libraryScan.js")>();
  return { ...actual, scanAndImportItems: (...args: unknown[]) => scanAndImportItems(...args) };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let queueScanAfterAdd: (typeof import("../src/services/scanOnAdd.js"))["queueScanAfterAdd"];
let setScanOnAddTiming: (typeof import("../src/services/scanOnAdd.js"))["setScanOnAddTiming"];
let startBackgroundJob: (typeof import("../src/services/backgroundJobs.js"))["startBackgroundJob"];
let finishBackgroundJob: (typeof import("../src/services/backgroundJobs.js"))["finishBackgroundJob"];

const quiet = { matched: 0, created: 0, skipped: 0, skippedFiles: [] };
const FAKE = { toFake: ["setTimeout", "clearTimeout", "Date"] } as const;

// The real timer, kept before the fake ones replace it: the batch reads the database when its timer fires, and against Postgres
// that read takes real time the fake clock does not wait for. The clock is moved in small steps with a real pause after each.
const realSetTimeout = globalThis.setTimeout;
async function advance(ms: number): Promise<void> {
  const step = 100;
  for (let moved = 0; moved < ms; moved += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - moved));
    await new Promise<void>((resolve) => realSetTimeout(resolve, 3));
  }
}

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ queueScanAfterAdd, setScanOnAddTiming } = await import("../src/services/scanOnAdd.js"));
  ({ startBackgroundJob, finishBackgroundJob } = await import("../src/services/backgroundJobs.js"));
  process.env.AONARR_SCAN_ON_ADD = "1";
});

afterAll(() => {
  process.env.AONARR_SCAN_ON_ADD = "0";
});

beforeEach(() => {
  scanAndImportItems.mockReset();
  scanAndImportItems.mockResolvedValue(quiet);
  setScanOnAddTiming({ debounceMs: 3000, maxWaitMs: 20_000, retryPollMs: 2000 });
  vi.useFakeTimers(FAKE);
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;
async function insertItem(type: string): Promise<number> {
  counter++;
  const title = `Batch ${type} ${counter}`;
  return Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'missing')").run(type, title, title.toLowerCase())).lastInsertRowid);
}

describe("the scan after an add is shared by the adds that come together", () => {
  it("scans ten adds of one type once, after the quiet period, with every title", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(await insertItem("movie"));

    for (const id of ids) queueScanAfterAdd(id);
    await advance(2900);
    expect(scanAndImportItems).not.toHaveBeenCalled();

    await advance(200);
    expect(scanAndImportItems).toHaveBeenCalledTimes(1);
    const [type, targets, linkOnly] = scanAndImportItems.mock.calls[0];
    expect(type).toBe("movie");
    expect((targets as { id: number }[]).map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(linkOnly).toBe(true);
  });

  it("makes one scan per media type", async () => {
    const movie = await insertItem("movie");
    const series = await insertItem("series");

    queueScanAfterAdd(movie);
    queueScanAfterAdd(series);
    await advance(3100);

    expect(scanAndImportItems.mock.calls.map((c) => c[0]).sort()).toEqual(["movie", "series"]);
  });

  it("does not wait for ever when adds keep coming: the batch starts at the longest wait", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(await insertItem("movie"));

    // One add every 2 seconds never leaves the 3 second quiet period.
    for (const id of ids.slice(0, 11)) {
      queueScanAfterAdd(id);
      await advance(2000);
    }
    expect(scanAndImportItems).toHaveBeenCalledTimes(1);
    expect(scanAndImportItems.mock.calls[0][1].length).toBeGreaterThan(5);

    // The add after that starts the next batch.
    queueScanAfterAdd(ids[11]);
    await advance(3100);
    expect(scanAndImportItems).toHaveBeenCalledTimes(2);
  });

  it("leaves out an item that was deleted before the batch started", async () => {
    const kept = await insertItem("movie");
    const gone = await insertItem("movie");

    queueScanAfterAdd(kept);
    queueScanAfterAdd(gone);
    await db.prepare("DELETE FROM media_items WHERE id = ?").run(gone);
    await advance(3100);

    expect(scanAndImportItems).toHaveBeenCalledTimes(1);
    expect((scanAndImportItems.mock.calls[0][1] as { id: number }[]).map((t) => t.id)).toEqual([kept]);
  });
});

describe("a scan that met a running whole-library scan is retried", () => {
  it("scans again once the running scan has ended, and not before", async () => {
    const id = await insertItem("book");
    scanAndImportItems.mockResolvedValueOnce({ ...quiet, alreadyRunning: true });
    const jobId = startBackgroundJob("scan", "book", "Scan & Import — Books");

    queueScanAfterAdd(id);
    await advance(3100);
    expect(scanAndImportItems).toHaveBeenCalledTimes(1);

    // Still running: it keeps waiting.
    await advance(10_000);
    expect(scanAndImportItems).toHaveBeenCalledTimes(1);

    finishBackgroundJob(jobId);
    await advance(2100);
    expect(scanAndImportItems).toHaveBeenCalledTimes(2);
    expect((scanAndImportItems.mock.calls[1][1] as { id: number }[]).map((t) => t.id)).toEqual([id]);
  });

  it("retries only once: a second refusal is dropped", async () => {
    const id = await insertItem("book");
    scanAndImportItems.mockResolvedValue({ ...quiet, alreadyRunning: true });

    queueScanAfterAdd(id);
    await advance(3100);
    await advance(10_000);

    expect(scanAndImportItems).toHaveBeenCalledTimes(2);
  });
});

describe("a batch that fails before its scans", () => {
  it("does not leave its titles queued: a later add of the same title scans again", async () => {
    const id = await insertItem("movie");
    // The proxy the services import forwards to this instance, so a spy on it reaches the batch's query.
    const instance = await (await import("../src/db/index.js")).initDb();
    const realPrepare = instance.prepare.bind(instance);
    const prepare = vi.spyOn(instance, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("FROM media_items WHERE id IN")) throw new Error("database is busy");
      return realPrepare(sql);
    }) as typeof instance.prepare);

    queueScanAfterAdd(id);
    await advance(3100);
    expect(scanAndImportItems).not.toHaveBeenCalled();
    prepare.mockRestore();

    queueScanAfterAdd(id);
    await advance(3100);

    expect(scanAndImportItems).toHaveBeenCalledTimes(1);
    expect((scanAndImportItems.mock.calls[0][1] as { id: number }[]).map((t) => t.id)).toEqual([id]);
  });
});
