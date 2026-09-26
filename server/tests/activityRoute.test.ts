import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// The real importer needs real downloads to work on; these tests are about when the routes let an
// import run at all, so only importQueueItem itself is replaced.
const importQueueItem = vi.fn();
vi.mock("../src/services/importer.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, importQueueItem: (...args: unknown[]) => importQueueItem(...args) };
});

// Runs just before a route takes a row's import lock — where the queue poller can act on the row
// after the route has read it.
const beforeQueueImportLock = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../src/services/downloadClient.js");
  return {
    ...actual,
    withQueueImportLock: async (queueId: number, importFn: () => Promise<void>) => {
      await beforeQueueImportLock(queueId);
      return actual.withQueueImportLock(queueId, importFn);
    },
  };
});

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let mediaItemId: number;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  mediaItemId = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Activity Movie', 'activity movie')").run()).lastInsertRowid
  );
});

beforeEach(async () => {
  await db.prepare("DELETE FROM queue").run();
  await db.prepare("DELETE FROM blocklist").run();
  importQueueItem.mockReset();
  importQueueItem.mockResolvedValue(undefined);
  beforeQueueImportLock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertQueueRow(fields: { title?: string; status?: string; clientId?: number | null; downloadId?: string | null; addedAt?: string } = {}) {
  return Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, status, download_client_id, download_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          mediaItemId,
          fields.title ?? "Activity.Movie.2020.1080p",
          fields.status ?? "queued",
          fields.clientId ?? null,
          fields.downloadId ?? null,
          fields.addedAt ?? "2026-01-01 00:00:00",
          "2020-01-01 00:00:00"
        )
    ).lastInsertRowid
  );
}

/** What the queue poller does to a row it moves to completed or failed. */
async function touchQueueRow(id: number) {
  const { nowExpr } = await import("../src/db/asyncDb.js");
  await db.prepare(`UPDATE queue SET updated_at = ${nowExpr(db)} WHERE id = ?`).run(id);
}

/** Registers a stand-in queue poller whose run lasts until the returned function is called. */
async function startFakeQueuePoll(): Promise<() => Promise<void>> {
  const { registerJob, runJobNow, isJobRunning } = await import("../src/services/jobRegistry.js");
  let finishPoll!: () => void;
  registerJob({
    key: "queuePoll",
    name: "Queue Poll",
    scheduleType: "interval",
    defaultSchedule: "60",
    run: () => new Promise<void>((resolve) => (finishPoll = resolve)),
  });
  runJobNow("queuePoll");
  await vi.waitFor(() => expect(isJobRunning("queuePoll")).toBe(true));
  return async () => {
    finishPoll();
    await vi.waitFor(() => expect(isJobRunning("queuePoll")).toBe(false));
  };
}

async function insertQbittorrentClient(): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO download_clients (name, type, host, port, use_ssl, enabled, audio_only) VALUES ('qBit', 'qbittorrent', 'qbit.local', 8080, 0, 1, 0)")
        .run()
    ).lastInsertRowid
  );
}

function qbittorrentFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/auth/login")) return { ok: true, status: 200, headers: new Headers({ "set-cookie": "SID=abc; Path=/" }), text: async () => "Ok." };
    if (url.includes("/torrents/delete")) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unmocked fetch call: ${url}`);
  });
}

describe("GET /api/activity/queue", () => {
  it("pages through rows added in the same second without repeating or skipping any", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await insertQueueRow({ title: `Burst.${i}` }));

    const seen: number[] = [];
    for (const offset of [0, 3, 6]) {
      const res = await request(app).get(`/api/activity/queue?limit=3&offset=${offset}`).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(7);
      seen.push(...res.body.items.map((q: { id: number }) => q.id));
    }

    expect(seen).toEqual([...ids].sort((a, b) => b - a));
  });
});

describe("DELETE /api/activity/queue/:id", () => {
  it("removes the download from its client, data included, along with the queue row", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "downloading", clientId, downloadId: "fakehash1" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).delete(`/api/activity/queue/${id}?blocklist=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    const deleteCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/delete")) as any[] | undefined;
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1].body.get("hashes")).toBe("fakehash1");
    expect(deleteCall![1].body.get("deleteFiles")).toBe("true");
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(id)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM blocklist WHERE release_title = 'Activity.Movie.2020.1080p'").get()).toBeDefined();
  });

  it("leaves the download at the client with ?removeFromClient=0", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "downloading", clientId, downloadId: "fakehash2" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).delete(`/api/activity/queue/${id}?removeFromClient=0`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(id)).toBeUndefined();
  });

  it("keeps a download another queue row still points at", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "downloading", clientId, downloadId: "sharedpack" });
    const other = await insertQueueRow({ status: "downloading", clientId, downloadId: "sharedpack" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).delete(`/api/activity/queue/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(other)).toBeDefined();
  });

  it("keeps the data under the symlink import strategy, which library files may still point into", async () => {
    const { getSetting, setSetting, deleteSetting } = await import("../src/services/settingsStore.js");
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "failed", clientId, downloadId: "linkedpack" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);
    const previousStrategy = getSetting("importStrategy");
    setSetting("importStrategy", "symlink");
    try {
      const res = await request(app).delete(`/api/activity/queue/${id}`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(204);
      const deleteCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/delete")) as any[] | undefined;
      expect(deleteCall![1].body.get("hashes")).toBe("linkedpack");
      expect(deleteCall![1].body.get("deleteFiles")).toBe("false");
    } finally {
      if (previousStrategy === null) deleteSetting("importStrategy");
      else setSetting("importStrategy", previousStrategy);
    }
  });

  it("refuses while an import of the row is running, leaving the client's files alone", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "completed", clientId, downloadId: "importing1" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);
    let finishImport!: () => void;
    importQueueItem.mockImplementationOnce(() => new Promise<void>((resolve) => (finishImport = resolve)));

    const importing = request(app).post(`/api/activity/queue/${id}/retry-import`).set("X-Api-Key", apiKey).then((r) => r);
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(1));
    const res = await request(app).delete(`/api/activity/queue/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(id)).toBeDefined();
    finishImport();
    expect((await importing).status).toBe(200);
  });

  it("refuses a row the running queue poller just completed, since it imports it inline", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "completed", clientId, downloadId: "polling1" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);
    const finishPoll = await startFakeQueuePoll();
    await touchQueueRow(id);

    const during = await request(app).delete(`/api/activity/queue/${id}?blocklist=1`).set("X-Api-Key", apiKey);
    expect(during.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM blocklist").get()).toBeUndefined();

    await finishPoll();
    expect((await request(app).delete(`/api/activity/queue/${id}`).set("X-Api-Key", apiKey)).status).toBe(204);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/torrents/delete"))).toBe(true);
  });

  it("refuses a row the poller completes after it was read, before anything is removed", async () => {
    const clientId = await insertQbittorrentClient();
    const id = await insertQueueRow({ status: "downloading", clientId, downloadId: "racing1" });
    const fetchMock = qbittorrentFetch();
    vi.stubGlobal("fetch", fetchMock);
    beforeQueueImportLock.mockImplementationOnce(async (queueId: number) => {
      await db.prepare("UPDATE queue SET status = 'completed' WHERE id = ?").run(queueId);
    });

    const res = await request(app).delete(`/api/activity/queue/${id}?blocklist=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT status FROM queue WHERE id = ?").get(id)).toEqual({ status: "completed" });
    expect(await db.prepare("SELECT id FROM blocklist").get()).toBeUndefined();
  });
});

describe("POST /api/activity/queue/:id/retry-import and /manual-import", () => {
  it("imports a failed or completed row", async () => {
    const failed = await insertQueueRow({ status: "failed" });
    const completed = await insertQueueRow({ status: "completed" });

    expect((await request(app).post(`/api/activity/queue/${failed}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(200);
    const manual = await request(app)
      .post(`/api/activity/queue/${completed}/manual-import`)
      .set("X-Api-Key", apiKey)
      .send({ sourceFile: "/downloads/x.mkv", quality: "Bluray-1080p" });

    expect(manual.status).toBe(200);
    expect(importQueueItem).toHaveBeenCalledWith(failed);
    expect(importQueueItem).toHaveBeenCalledWith(completed, "/downloads/x.mkv", "Bluray-1080p");
  });

  it("422s with the importer's own message when the import fails", async () => {
    const id = await insertQueueRow({ status: "failed" });
    importQueueItem.mockRejectedValueOnce(new Error("No matching file found"));

    const res = await request(app).post(`/api/activity/queue/${id}/retry-import`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("No matching file found");
  });

  it("refuses a row the poller still owns (queued or downloading)", async () => {
    const queued = await insertQueueRow({ status: "queued" });
    const downloading = await insertQueueRow({ status: "downloading" });

    expect((await request(app).post(`/api/activity/queue/${queued}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(409);
    const manual = await request(app).post(`/api/activity/queue/${downloading}/manual-import`).set("X-Api-Key", apiKey).send({ sourceFile: "/downloads/x.mkv" });
    expect(manual.status).toBe(409);
    expect(importQueueItem).not.toHaveBeenCalled();
  });

  it("refuses a second import of a row while the first is still running", async () => {
    const id = await insertQueueRow({ status: "completed" });
    let finishFirst!: () => void;
    importQueueItem.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)));

    const first = request(app).post(`/api/activity/queue/${id}/retry-import`).set("X-Api-Key", apiKey).then((r) => r);
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(1));

    const second = await request(app).post(`/api/activity/queue/${id}/manual-import`).set("X-Api-Key", apiKey).send({ sourceFile: "/downloads/x.mkv" });
    expect(second.status).toBe(409);
    expect(importQueueItem).toHaveBeenCalledTimes(1);

    finishFirst();
    expect((await first).status).toBe(200);
  });

  it("refuses only rows the running queue poller moved, since it imports those inline", async () => {
    const justCompleted = await insertQueueRow({ status: "completed" });
    const justFailed = await insertQueueRow({ status: "failed" });
    const idle = await insertQueueRow({ status: "completed" });
    const finishPoll = await startFakeQueuePoll();
    await touchQueueRow(justCompleted);
    await touchQueueRow(justFailed);

    expect((await request(app).post(`/api/activity/queue/${justCompleted}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(409);
    const manual = await request(app).post(`/api/activity/queue/${justFailed}/manual-import`).set("X-Api-Key", apiKey).send({ sourceFile: "/downloads/x.mkv" });
    expect(manual.status).toBe(409);
    expect(importQueueItem).not.toHaveBeenCalled();
    // A row finished in an earlier run is idle, however long this run takes.
    expect((await request(app).post(`/api/activity/queue/${idle}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(200);
    expect(importQueueItem).toHaveBeenCalledWith(idle);

    await finishPoll();
    expect((await request(app).post(`/api/activity/queue/${justCompleted}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(200);
  });

  it("marks the row while its import runs, clearing the mark when it fails and recording why when it was skipped", async () => {
    const { ImportSkippedError } = await import("../src/services/importer.js");
    const id = await insertQueueRow({ status: "completed" });
    const importMark = async () =>
      (await db.prepare("SELECT import_started_at, import_skipped_reason FROM queue WHERE id = ?").get(id)) as {
        import_started_at: string | null;
        import_skipped_reason: string | null;
      };
    let markDuringImport: string | null = null;
    importQueueItem.mockImplementationOnce(async () => {
      markDuringImport = (await importMark()).import_started_at;
      throw new ImportSkippedError("No root folder is configured for movie");
    });

    expect((await request(app).post(`/api/activity/queue/${id}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(422);
    expect(markDuringImport).not.toBeNull();
    expect(await importMark()).toEqual({ import_started_at: null, import_skipped_reason: "No root folder is configured for movie" });

    importQueueItem.mockRejectedValueOnce(new Error("No matching file found"));
    const manual = await request(app).post(`/api/activity/queue/${id}/manual-import`).set("X-Api-Key", apiKey).send({ sourceFile: "/downloads/x.mkv" });
    expect(manual.status).toBe(422);
    expect(await importMark()).toEqual({ import_started_at: null, import_skipped_reason: "No root folder is configured for movie" });
  });

  it("takes the place of an automatic retry the queue poller still owes a row a restart cut off", async () => {
    const id = await insertQueueRow({ status: "completed" });
    await db.prepare("UPDATE queue SET import_resume_state = 1 WHERE id = ?").run(id);
    importQueueItem.mockRejectedValueOnce(new Error("No matching file found"));

    expect((await request(app).post(`/api/activity/queue/${id}/retry-import`).set("X-Api-Key", apiKey)).status).toBe(422);

    const row = (await db.prepare("SELECT import_started_at, import_resume_state FROM queue WHERE id = ?").get(id)) as {
      import_started_at: string | null;
      import_resume_state: number | string;
    };
    expect({ ...row, import_resume_state: Number(row.import_resume_state) }).toEqual({ import_started_at: null, import_resume_state: 2 });
  });

  it("leaves a Manual import a restart cut off for the admin, and hands a Retry import back to the queue poller", async () => {
    const { resumeInterruptedImports, pollQueue } = await import("../src/services/scheduler.js");
    const manualRow = await insertQueueRow({ status: "completed" });
    const retryRow = await insertQueueRow({ status: "completed" });
    const importMark = async (id: number) => {
      const row = (await db.prepare("SELECT import_started_at, import_skipped_reason, import_resume_state FROM queue WHERE id = ?").get(id)) as {
        import_started_at: string | null;
        import_skipped_reason: string | null;
        import_resume_state: number | string;
      };
      return { ...row, import_resume_state: Number(row.import_resume_state) };
    };
    const finishImports: Array<() => void> = [];
    importQueueItem.mockImplementation(() => new Promise<void>((resolve) => finishImports.push(resolve)));

    const manual = request(app)
      .post(`/api/activity/queue/${manualRow}/manual-import`)
      .set("X-Api-Key", apiKey)
      .send({ sourceFile: "/downloads/picked.mkv", quality: "Bluray-1080p" })
      .then((r) => r);
    const retry = request(app).post(`/api/activity/queue/${retryRow}/retry-import`).set("X-Api-Key", apiKey).then((r) => r);
    await vi.waitFor(() => expect(importQueueItem).toHaveBeenCalledTimes(2));
    expect((await importMark(manualRow)).import_started_at).not.toBeNull();

    // The process dies with both imports running; this is the next start's pass.
    await resumeInterruptedImports();
    expect(await importMark(manualRow)).toEqual({
      import_started_at: null,
      import_skipped_reason: "Manual import was interrupted by a restart — run it again",
      import_resume_state: 0,
    });
    expect(await importMark(retryRow)).toEqual({ import_started_at: null, import_skipped_reason: null, import_resume_state: 1 });

    for (const finish of finishImports) finish();
    await Promise.all([manual, retry]);
    importQueueItem.mockReset().mockResolvedValue(undefined);
    await pollQueue();
    await pollQueue();
    // Only the Retry import runs again; the automatic importer never stands in for a Manual one.
    expect(importQueueItem).toHaveBeenCalledTimes(1);
    expect(importQueueItem).toHaveBeenCalledWith(retryRow);
  });

  it("404s an unknown row", async () => {
    expect((await request(app).post("/api/activity/queue/999999/retry-import").set("X-Api-Key", apiKey)).status).toBe(404);
    expect((await request(app).post("/api/activity/queue/not-a-number/retry-import").set("X-Api-Key", apiKey)).status).toBe(404);
  });
});

describe("SSE streams", () => {
  it("tell a reverse proxy not to buffer them (the Activity queue stream and the log tail)", async () => {
    const http = await import("node:http");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      for (const route of ["/api/activity/stream", "/api/system/logs/stream"]) {
        const ticket = (await request(app).post("/api/auth/stream-ticket").set("X-Api-Key", apiKey)).body.ticket;
        const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}${route}?ticket=${ticket}`, (response) => {
            response.on("error", () => {});
            resolve(response);
            req.destroy();
          });
          req.on("error", reject);
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.headers["x-accel-buffering"]).toBe("no");
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
