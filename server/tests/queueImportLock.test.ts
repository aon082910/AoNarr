import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let withQueueImportLock: (typeof import("../src/services/downloadClient.js"))["withQueueImportLock"];
let waitForQueueImports: (typeof import("../src/services/downloadClient.js"))["waitForQueueImports"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ withQueueImportLock, waitForQueueImports } = await import("../src/services/downloadClient.js"));
});

/** Starts an import of `queueId` under the lock that runs until the returned `finish` is called. */
function startImport(queueId: number, outcome: "resolve" | "reject" = "resolve") {
  let finish!: () => void;
  const locked = withQueueImportLock(
    queueId,
    () => new Promise<void>((resolve, reject) => (finish = () => (outcome === "resolve" ? resolve() : reject(new Error("import failed")))))
  );
  return { locked, finish: () => finish() };
}

describe("waitForQueueImports", () => {
  it("resolves true at once when no import is running", async () => {
    expect(await waitForQueueImports(1000)).toBe(true);
  });

  it("resolves true only once every running import has settled, failed ones included", async () => {
    const a = startImport(201);
    const b = startImport(202, "reject");
    b.locked.catch(() => {});
    let settled: boolean | undefined;
    const waiting = waitForQueueImports(5000).then((result) => (settled = result));

    a.finish();
    await a.locked;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined();

    b.finish();
    expect(await waiting).toBe(true);
  });

  it("also waits for an import that starts while it is waiting", async () => {
    const a = startImport(203);
    let settled: boolean | undefined;
    const waiting = waitForQueueImports(5000).then((result) => (settled = result));

    const b = startImport(204);
    a.finish();
    await a.locked;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined();

    b.finish();
    expect(await waiting).toBe(true);
  });

  it("resolves false when an import is still running at the timeout, without rejecting", async () => {
    vi.useFakeTimers();
    try {
      const a = startImport(205);
      const waiting = waitForQueueImports(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await waiting).toBe(false);

      a.finish();
      expect(await a.locked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out a poller that runs imports one after another, with database calls between them", async () => {
    let pollerRunning = true;
    const settledImports: number[] = [];
    const poller = (async () => {
      try {
        for (const id of [207, 208, 209]) {
          await withQueueImportLock(id, () => new Promise<void>((resolve) => setTimeout(resolve, 150)));
          settledImports.push(id);
          await db.prepare("SELECT COUNT(*) AS n FROM queue").get();
          await new Promise((resolve) => setTimeout(resolve, 120)); // longer than the recheck interval
        }
      } finally {
        pollerRunning = false;
      }
    })();

    expect(await waitForQueueImports(5000, () => pollerRunning)).toBe(true);
    expect(settledImports).toEqual([207, 208, 209]);
    expect(pollerRunning).toBe(false);
    await poller;
  });

  it("resolves false at the timeout while more may still start, even with nothing importing", async () => {
    const started = Date.now();
    expect(await waitForQueueImports(300, () => true)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await waitForQueueImports(300, () => false)).toBe(true);
  });

  it("leaves the lock refusing a second concurrent import of the same row", async () => {
    const a = startImport(206);
    const second = vi.fn(async () => {});
    expect(await withQueueImportLock(206, second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    expect(await waitForQueueImports(0)).toBe(false);

    a.finish();
    expect(await a.locked).toBe(true);
    expect(await waitForQueueImports(0)).toBe(true);
    expect(await withQueueImportLock(206, second)).toBe(true);
  });
});
