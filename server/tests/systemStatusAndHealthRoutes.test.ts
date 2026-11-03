import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let jobs: typeof import("../src/services/jobRegistry.js");

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  jobs = await import("../src/services/jobRegistry.js");
});

afterEach(() => {
  jobs.stopAllJobs();
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const post = (url: string) => request(app).post(url).set("X-Api-Key", apiKey).send({});

describe("GET /api/system/status — what is running (RB16)", () => {
  it("reports the real version, start time, runtime and database, not a hard-coded 0.1.0", async () => {
    const res = await get("/api/system/status");
    expect(res.status).toBe(200);

    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
    expect(res.body.version).toBe(pkg.version);
    expect(res.body.build).toMatchObject({
      appVersion: pkg.version,
      runtime: `Node ${process.version}`,
      databaseType: process.env.AONARR_DATABASE_DRIVER === "postgres" ? "postgres" : "sqlite",
    });
    expect(typeof res.body.build.docker).toBe("boolean");
    expect(Date.parse(res.body.build.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(res.body.build.databaseVersion).toBeTruthy();
    // A test run is not an image build: it has no build time, tag or commit.
    expect(res.body.build).toMatchObject({ buildTime: null, imageTag: null, commit: null });
  });
});

describe("GET /api/system/health — kept between page loads (RB8)", () => {
  it("returns the new fields, and the same report to a second load until it is refreshed", async () => {
    const first = await get("/api/system/health?refresh=1");
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.issues)).toBe(true);
    expect(typeof first.body.checkedAt).toBe("string");

    const second = await get("/api/system/health");
    expect(second.body.checkedAt).toBe(first.body.checkedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshed = await get("/api/system/health?refresh=1");
    expect(refreshed.body.checkedAt).not.toBe(first.body.checkedAt);
  });
});

describe("the System page's run-now buttons go through the job registry (RB7)", () => {
  it("answers 409 while the same job is already running, instead of running beside it", async () => {
    jobs.startAllJobs();
    let release!: () => void;
    jobs.registerJob({ key: "autoArchival", name: "Auto Archival", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: () => new Promise<void>((r) => (release = r)) });
    jobs.runJobNow("autoArchival");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await post("/api/system/archival/run");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already running/);
    release();
  });

  it("runs the archival as a recorded run of its job when nothing else is running", async () => {
    jobs.startAllJobs();
    jobs.registerJob({ key: "autoArchival", name: "Auto Archival", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    await db.prepare("DELETE FROM job_runs WHERE job_key = 'autoArchival'").run();

    const res = await post("/api/system/archival/run");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: true });
    const runs = await jobs.listJobRuns("autoArchival");
    expect(runs).toHaveLength(1);
  });

  it("returns the sync's own result for Trakt and Plex, as the page shows it", async () => {
    jobs.startAllJobs();
    jobs.registerJob({ key: "traktSync", name: "Trakt", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    jobs.registerJob({ key: "plexWatchlistSync", name: "Plex", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    // Neither sync is configured in a test database: each answers { added: 0 } without calling out.
    expect((await post("/api/system/trakt-sync/run")).body).toMatchObject({ added: 0 });
    expect((await post("/api/system/plex-watchlist-sync/run")).body).toMatchObject({ added: 0 });
  });
});

describe("GET /api/jobs/:key/runs (RB6)", () => {
  it("lists a job's recent runs, newest first, and 404s for an unknown job", async () => {
    jobs.registerJob({ key: "runs-route-job", name: "Runs", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, duration_ms) VALUES ('runs-route-job', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:02.000Z', 'success', 2000)").run();
    await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error, duration_ms) VALUES ('runs-route-job', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:01.000Z', 'error', 'it broke', 1000)").run();

    const res = await get("/api/jobs/runs-route-job/runs");

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.status)).toEqual(["error", "success"]);
    expect(res.body[0]).toMatchObject({ error: "it broke", durationMs: 1000, startedAt: "2026-04-02T00:00:00.000Z" });
    expect((await get("/api/jobs/no-such-job/runs")).status).toBe(404);
  });
});

describe("the run-now buttons do not wait behind a heavy job (review F9)", () => {
  it("answers 409 at once, naming the job that has the slot", async () => {
    jobs.startAllJobs();
    let release!: () => void;
    jobs.registerJob({ key: "slot-holder", name: "Library Scan Stand-in", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (release = r)) });
    jobs.registerJob({ key: "autoArchival", name: "Auto Archival", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => {} });
    jobs.runJobNow("slot-holder");
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const started = Date.now();
      const res = await post("/api/system/archival/run");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('"Library Scan Stand-in" is running');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(jobs.listJobs().find((j) => j.key === "autoArchival")!.queued).toBe(false);
    } finally {
      release();
    }
  });
});
