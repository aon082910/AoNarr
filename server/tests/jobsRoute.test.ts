import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let jobs: typeof import("../src/services/jobRegistry.js");

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  jobs = await import("../src/services/jobRegistry.js");
});

afterEach(() => {
  // Clears the timers startAllJobs started; the next test that needs runs re-enables them.
  jobs.stopAllJobs();
});

function registerGatedJob(key: string): { runs: () => number; finish: () => void } {
  let runs = 0;
  let release: () => void = () => {};
  jobs.registerJob({
    key,
    name: key,
    scheduleType: "cron",
    defaultSchedule: "0 3 * * *",
    run: () => {
      runs++;
      return new Promise<void>((resolve) => (release = resolve));
    },
  });
  return { runs: () => runs, finish: () => release() };
}

const runJob = (key: string) => request(app).post(`/api/jobs/${key}/run`).set("X-Api-Key", apiKey);

describe("POST /api/jobs/:key/run", () => {
  it("starts a job, and reports a second trigger while it runs as already running", async () => {
    jobs.startAllJobs();
    const job = registerGatedJob("routeRunJob");
    try {
      const first = await runJob("routeRunJob");
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ started: true });

      const second = await runJob("routeRunJob");
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ started: false, reason: "already-running" });
      expect(job.runs()).toBe(1);
    } finally {
      job.finish();
    }
  });

  it("answers 404 for an unknown job", async () => {
    jobs.startAllJobs();
    const res = await runJob("noSuchJobHere");
    expect(res.status).toBe(404);
  });

  it("answers 409 without running the job once jobs are stopped for a shutdown or restore", async () => {
    jobs.startAllJobs();
    const job = registerGatedJob("routeStoppedJob");
    try {
      jobs.stopAllJobs();
      const res = await runJob("routeStoppedJob");
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/stopped for a shutdown or restore/);
      expect(job.runs()).toBe(0);

      // Unknown keys still read as unknown while stopped.
      expect((await runJob("noSuchJobHere")).status).toBe(404);
    } finally {
      job.finish();
    }
  });
});
