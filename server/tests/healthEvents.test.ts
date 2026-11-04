import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express, NextFunction, Request, Response } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let baseDir: string;
let onHealthChange: (typeof import("../src/services/healthEvents.js"))["onHealthChange"];
let emitHealthChange: (typeof import("../src/services/healthEvents.js"))["emitHealthChange"];
let healthStaleOnChange: (typeof import("../src/middleware/healthStale.js"))["healthStaleOnChange"];
let getHealthReport: (typeof import("../src/services/healthReport.js"))["getHealthReport"];
let markHealthStale: (typeof import("../src/services/healthReport.js"))["markHealthStale"];
let clearHealthReportCache: (typeof import("../src/services/healthReport.js"))["clearHealthReportCache"];
let noteManualBackupSucceeded: (typeof import("../src/services/scheduledBackup.js"))["noteManualBackupSucceeded"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ onHealthChange, emitHealthChange } = await import("../src/services/healthEvents.js"));
  ({ healthStaleOnChange } = await import("../src/middleware/healthStale.js"));
  ({ getHealthReport, markHealthStale, clearHealthReportCache } = await import("../src/services/healthReport.js"));
  ({ noteManualBackupSucceeded } = await import("../src/services/scheduledBackup.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-health-events-"));
});

beforeEach(async () => {
  clearHealthReportCache();
  for (const table of ["queue", "import_lists", "indexer_status", "indexers", "remote_path_mappings", "download_clients", "root_folders", "job_runs"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  setSetting("backupEnabled", "0");
  setSetting("backupProblem", "");
  setSetting("backupProblemAt", "");
  setSetting("recycleBinDir", "");
  // Every indexer and client probe fails fast and offline.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("healthEvents", () => {
  it("calls every registered listener each time a change is announced", () => {
    const first = vi.fn();
    const second = vi.fn();
    onHealthChange(first);
    onHealthChange(second);

    emitHealthChange();
    emitHealthChange();

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("still tells the other listeners, and does not throw, when one listener throws", () => {
    const before = vi.fn();
    const after = vi.fn();
    onHealthChange(before);
    onHealthChange(() => {
      throw new Error("a broken listener");
    });
    onHealthChange(after);

    expect(() => emitHealthChange()).not.toThrow();

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("calls a listener registered twice only once per announcement", () => {
    const listener = vi.fn();
    onHealthChange(listener);
    onHealthChange(listener);

    emitHealthChange();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("healthStaleOnChange", () => {
  const announced = vi.fn();
  beforeAll(() => {
    onHealthChange(() => announced());
  });
  beforeEach(() => {
    announced.mockClear();
  });

  function exchange(method: string, statusCode: number) {
    const req = { method } as Request;
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    res.statusCode = statusCode;
    const next = vi.fn();
    healthStaleOnChange(req, res, next as unknown as NextFunction);
    return { res, next };
  }

  it.each(["POST", "PUT", "PATCH", "DELETE"])("announces a change once a successful %s has been answered", (method) => {
    const { res, next } = exchange(method, 200);
    expect(next).toHaveBeenCalledTimes(1);
    expect(announced).not.toHaveBeenCalled(); // nothing has been saved until the response is out

    res.emit("finish");

    expect(announced).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("never announces a change for a %s", (method) => {
    const { res, next } = exchange(method, 200);
    res.emit("finish");

    expect(next).toHaveBeenCalledTimes(1);
    expect(announced).not.toHaveBeenCalled();
  });

  it.each([200, 201, 204, 302])("announces a change for a %i answer", (statusCode) => {
    const { res } = exchange("POST", statusCode);
    res.emit("finish");
    expect(announced).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 404, 409, 422, 500])("announces nothing for a %i answer, because nothing was saved", (statusCode) => {
    const { res } = exchange("POST", statusCode);
    res.emit("finish");
    expect(announced).not.toHaveBeenCalled();
  });

  it("judges the answer by the status it ends up with, not the one it had when the request came in", () => {
    const { res } = exchange("PUT", 200);
    res.statusCode = 500; // an error handler sets this after the middleware has run
    res.emit("finish");
    expect(announced).not.toHaveBeenCalled();
  });

  it("announces once even if the response reports finishing twice", () => {
    const { res } = exchange("DELETE", 204);
    res.emit("finish");
    res.emit("finish");
    expect(announced).toHaveBeenCalledTimes(1);
  });
});

describe("a saved change drops the kept health report", () => {
  async function insertIndexer(): Promise<number> {
    return Number(
      (await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Idx', 'torznab', 'http://idx.local', 'movie', 1)").run())
        .lastInsertRowid
    );
  }

  /** Builds the report, proves a second read is served from the kept copy, and returns that copy. */
  async function keptReport() {
    const first = await getHealthReport({ refresh: true });
    expect(await getHealthReport()).toBe(first);
    return first;
  }

  /** The kept report is dropped once the response has finished, which can be a moment after the client has it. */
  async function expectDropped(before: Awaited<ReturnType<typeof getHealthReport>>) {
    await vi.waitFor(async () => expect(await getHealthReport()).not.toBe(before));
  }

  it("is done by markHealthStale: the next plain read runs the checks again", async () => {
    const before = await keptReport();

    markHealthStale();

    const after = await getHealthReport();
    expect(after).not.toBe(before);
    expect(await getHealthReport()).toBe(after); // and the new one is kept in turn
  });

  it("is done by an announced health change, through the listener healthReport registers", async () => {
    const before = await keptReport();

    emitHealthChange();

    expect(await getHealthReport()).not.toBe(before);
  });

  it("is done by a manual backup that ends a stored backup problem", async () => {
    setSetting("backupEnabled", "1");
    setSetting("backupProblem", "Scheduled backup failed: disk full");
    const before = await keptReport();
    expect(before.issues.find((i) => i.source === "backup")?.message).toBe("Scheduled backup failed: disk full");

    noteManualBackupSucceeded();

    const after = await getHealthReport();
    expect(after).not.toBe(before);
    expect(after.issues.some((i) => i.source === "backup")).toBe(false);
  });

  it("is not done by a manual backup when there was no backup problem to end", async () => {
    const before = await keptReport();

    noteManualBackupSucceeded();

    expect(await getHealthReport()).toBe(before);
  });

  it("is done by deleting an indexer through the API", async () => {
    const id = await insertIndexer();
    const before = await keptReport();

    const res = await request(app).delete(`/api/indexers/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    await expectDropped(before);
  });

  it("is done by deleting a download client through the API", async () => {
    const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Dl', 'qbittorrent', 'h', 8080, 1)").run()).lastInsertRowid);
    const before = await keptReport();

    const res = await request(app).delete(`/api/download-clients/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    await expectDropped(before);
  });

  it("is done by deleting a root folder through the API", async () => {
    const dir = fs.mkdtempSync(path.join(baseDir, "root-"));
    const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(dir)).lastInsertRowid);
    const before = await keptReport();

    const res = await request(app).delete(`/api/root-folders/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    await expectDropped(before);
  });

  it("is done by deleting an import list through the API", async () => {
    const id = Number((await db.prepare("INSERT INTO import_lists (name, type, url, enabled) VALUES ('L', 'trakt', 'u', 1)").run()).lastInsertRowid);
    const before = await keptReport();

    const res = await request(app).delete(`/api/import-lists/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    await expectDropped(before);
  });

  it("is done by deleting a remote path mapping through the API", async () => {
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Dl', 'qbittorrent', 'h', 8080, 0)").run()).lastInsertRowid);
    const id = Number(
      (await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote', '/local')").run(clientId)).lastInsertRowid
    );
    const before = await keptReport();

    const res = await request(app).delete(`/api/remote-path-mappings/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    await expectDropped(before);
  });

  it("is done by saving a setting through the API", async () => {
    const before = await keptReport();

    const res = await request(app).put("/api/settings/backupEnabled").set("X-Api-Key", apiKey).send({ value: "0" });
    expect(res.status).toBe(200);

    await expectDropped(before);
  });

  it("shows a root folder added through the API on the next plain read of the report", async () => {
    const first = await request(app).get("/api/system/health").set("X-Api-Key", apiKey);
    expect(first.body.configWarnings.map((w: { key: string }) => w.key)).toContain("no_root_folder");

    const dir = fs.mkdtempSync(path.join(baseDir, "added-"));
    const added = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie" });
    expect(added.status).toBe(201);

    // No ?refresh=1: the kept copy must already be gone.
    await vi.waitFor(async () => {
      const second = await request(app).get("/api/system/health").set("X-Api-Key", apiKey);
      expect(second.body.configWarnings.map((w: { key: string }) => w.key)).not.toContain("no_root_folder");
    });
  });

  it("is not done by a request that failed", async () => {
    const before = await keptReport();

    const missing = await request(app).delete("/api/indexers/987654").set("X-Api-Key", apiKey);
    expect(missing.status).toBe(404);
    const rejected = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: path.join(baseDir, "nope"), mediaType: "movie" });
    expect(rejected.status).toBe(400);
    const unknownKey = await request(app).put("/api/settings/notARealSetting").set("X-Api-Key", apiKey).send({ value: "1" });
    expect(unknownKey.status).toBe(400);

    expect(await getHealthReport()).toBe(before);
  });

  it("is not done by reading from the guarded routers", async () => {
    await insertIndexer();
    const before = await keptReport();

    for (const route of ["/api/indexers", "/api/download-clients", "/api/root-folders", "/api/import-lists", "/api/remote-path-mappings", "/api/settings"]) {
      const res = await request(app).get(route).set("X-Api-Key", apiKey);
      expect(res.status, route).toBe(200);
    }

    expect(await getHealthReport()).toBe(before);
  });
});

describe("a change that arrives while the report is being built", () => {
  /** A fetch whose every call waits until the test lets it fail, so a build can be held part-way. */
  function gatedFetch() {
    const gates: (() => void)[] = [];
    const mock = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          gates.push(() => reject(new Error("offline")));
        })
    );
    vi.stubGlobal("fetch", mock);
    return {
      calls: () => mock.mock.calls.length,
      /** Lets the oldest held request fail, which lets its build carry on. */
      release: () => gates.shift()?.(),
    };
  }

  beforeEach(async () => {
    await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Slow', 'torznab', 'http://slow.local', 'movie', 1)").run();
  });

  it("is not kept as the answer: the run's own caller gets it, the next caller runs the checks again", async () => {
    const fetchGate = gatedFetch();
    const running = getHealthReport({ refresh: true });
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(1));

    markHealthStale(); // a setting is saved while the indexer is still being pinged
    fetchGate.release();
    const staleAnswer = await running;
    expect(staleAnswer.indexers).toHaveLength(1);

    // Had the old run been kept, this plain read would be served from it without another ping.
    const next = getHealthReport();
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(2));
    fetchGate.release();
    const fresh = await next;
    expect(fresh).not.toBe(staleAnswer);
  });

  it("makes a later caller start a new run instead of joining the one that is already out of date", async () => {
    const fetchGate = gatedFetch();
    const old = getHealthReport({ refresh: true });
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(1));

    markHealthStale();
    const current = getHealthReport();
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(2)); // a second run, not a shared one

    fetchGate.release();
    fetchGate.release();
    const [oldReport, currentReport] = await Promise.all([old, current]);
    expect(currentReport).not.toBe(oldReport);
    // Only the run that started after the change is kept.
    expect(await getHealthReport()).toBe(currentReport);
  });

  it("is not undone when the out-of-date run finishes first: a caller after that joins the newer run", async () => {
    const fetchGate = gatedFetch();
    const old = getHealthReport({ refresh: true });
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(1));
    markHealthStale();
    const newer = getHealthReport();
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(2));

    fetchGate.release(); // the old run (the oldest held request) ends while the newer one is still going
    await old;
    const joiner = getHealthReport();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchGate.calls()).toBe(2); // it did not start a third run

    fetchGate.release();
    const [newerReport, joinerReport] = await Promise.all([newer, joiner]);
    expect(joinerReport).toBe(newerReport);
    expect(await getHealthReport()).toBe(newerReport);
  });

  it("does not stop callers that arrive together, with no change in between, from sharing one run", async () => {
    const fetchGate = gatedFetch();
    const a = getHealthReport({ refresh: true });
    const b = getHealthReport({ refresh: true });
    await vi.waitFor(() => expect(fetchGate.calls()).toBe(1));

    fetchGate.release();

    expect(await a).toBe(await b);
    expect(fetchGate.calls()).toBe(1);
  });
});
