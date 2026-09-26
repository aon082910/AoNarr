import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const getDownloadClientAdapter = vi.fn();
const applyRemotePathMapping = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  applyRemotePathMapping: (...args: unknown[]) => applyRemotePathMapping(...args),
}));

const importQueueItem = vi.fn();
vi.mock("../src/services/importer.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  importQueueItem: (...args: unknown[]) => importQueueItem(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let pollQueue: (typeof import("../src/services/scheduler.js"))["pollQueue"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ pollQueue } = await import("../src/services/scheduler.js"));
});

/** Imports that delete their row like the real importer, recording how many ever ran at once. */
let running = 0;
let maxRunning = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "media_items", "download_clients"]) await db.prepare(`DELETE FROM ${t}`).run();
  running = 0;
  maxRunning = 0;
  getDownloadClientAdapter.mockReset();
  applyRemotePathMapping.mockReset().mockImplementation(async (_clientId: number, remotePath: string) => remotePath);
  importQueueItem.mockReset().mockImplementation(async (queueId: number) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.prepare("DELETE FROM queue WHERE id = ?").run(queueId);
    running--;
  });
});

async function insertClient(name: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, 'qbittorrent', 1)").run(name)).lastInsertRowid);
}

async function insertQueueRow(clientId: number, downloadId: string): Promise<number> {
  const movie = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, status) VALUES ('movie', ?, ?, 'missing')").run(`Movie ${downloadId}`, `movie ${downloadId}`))
      .lastInsertRowid
  );
  return Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress) VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP', ?, ?, 'downloading', 0)")
        .run(movie, clientId, downloadId)
    ).lastInsertRowid
  );
}

async function queueStatus(id: number): Promise<string | undefined> {
  return ((await db.prepare("SELECT status FROM queue WHERE id = ?").get(id)) as { status: string } | undefined)?.status;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const completed = (...downloadIds: string[]) => downloadIds.map((downloadId) => ({ downloadId, progress: 1, status: "completed" }));

describe("pollQueue with several download clients", () => {
  it("asks every client at once, then imports what they report one at a time", async () => {
    const slowClient = await insertClient("Slow");
    const fastClient = await insertClient("Fast");
    const rows = [await insertQueueRow(slowClient, "slow-1"), await insertQueueRow(slowClient, "slow-2"), await insertQueueRow(fastClient, "fast-1")];
    const answers = new Map([
      [slowClient, deferred<unknown[]>()],
      [fastClient, deferred<unknown[]>()],
    ]);
    const getStatus = vi.fn((client: { id: number }) => answers.get(client.id)!.promise);
    getDownloadClientAdapter.mockReturnValue({ getStatus });

    const polling = pollQueue();
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));

    answers.get(fastClient)!.resolve(completed("fast-1"));
    answers.get(slowClient)!.resolve(completed("slow-1", "slow-2"));
    await polling;

    expect(importQueueItem.mock.calls.map((c) => c[0])).toEqual(rows);
    expect(maxRunning).toBe(1);
    for (const id of rows) expect(await queueStatus(id)).toBeUndefined();
  });

  it("skips a client whose status call fails and still imports the others' completed downloads", async () => {
    const downClient = await insertClient("Down");
    const upClient = await insertClient("Up");
    const downRow = await insertQueueRow(downClient, "down-1");
    const upRow = await insertQueueRow(upClient, "up-1");
    getDownloadClientAdapter.mockReturnValue({
      getStatus: vi.fn(async (client: { id: number }) => {
        if (client.id === downClient) throw new Error("ECONNREFUSED");
        return completed("up-1");
      }),
    });
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await pollQueue();

      expect(warn).toHaveBeenCalledWith('[scheduler] queue poll failed for client "Down":', "ECONNREFUSED");
    } finally {
      warn.mockRestore();
    }
    expect(importQueueItem.mock.calls.map((c) => c[0])).toEqual([upRow]);
    expect(await queueStatus(upRow)).toBeUndefined();
    expect(await queueStatus(downRow)).toBe("downloading");
  });

  it("keeps handling the other clients when handling one client's report throws", async () => {
    const brokenClient = await insertClient("Broken mapping");
    const okClient = await insertClient("Fine");
    const brokenRow = await insertQueueRow(brokenClient, "broken-1");
    const okRow = await insertQueueRow(okClient, "ok-1");
    getDownloadClientAdapter.mockReturnValue({
      getStatus: vi.fn(async (_client: unknown, ids: string[]) => ids.map((downloadId) => ({ downloadId, progress: 1, status: "completed", remotePath: `/remote/${downloadId}` }))),
    });
    applyRemotePathMapping.mockImplementation(async (clientId: number, remotePath: string) => {
      if (clientId === brokenClient) throw new Error("mapping lookup failed");
      return remotePath;
    });
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await pollQueue();
    } finally {
      warn.mockRestore();
    }

    expect(importQueueItem.mock.calls.map((c) => c[0])).toEqual([okRow]);
    expect(await queueStatus(brokenRow)).toBe("downloading");
  });
});
