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

const patchEnabled = (key: string) => request(app).patch(`/api/jobs/${key}/enabled`).set("X-Api-Key", apiKey);
const statusOf = (key: string) => jobs.listJobs().find((j) => j.key === key)!;

describe("PATCH /api/jobs/:key/enabled", () => {
  it("switches a job off and on, answering 204 and keeping its schedule", async () => {
    jobs.registerJob({ key: "routeSwitchJob", name: "Route Switch", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const off = await patchEnabled("routeSwitchJob").send({ enabled: false });
    expect(off.status).toBe(204);
    expect(statusOf("routeSwitchJob")).toMatchObject({ enabled: false, nextRunAt: null, schedule: "0 3 * * *" });

    const on = await patchEnabled("routeSwitchJob").send({ enabled: true });
    expect(on.status).toBe(204);
    expect(statusOf("routeSwitchJob").enabled).toBe(true);
    expect(statusOf("routeSwitchJob").nextRunAt).not.toBeNull();
  });

  it("shows the switch and the essential flag in the job list the Jobs page reads", async () => {
    jobs.registerJob({ key: "routeListOff", name: "Listed Off", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    jobs.registerJob({ key: "routeListEssential", name: "Listed Essential", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });
    await patchEnabled("routeListOff").send({ enabled: false });

    const res = await request(app).get("/api/jobs").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.find((j: any) => j.key === "routeListOff")).toMatchObject({ enabled: false, essential: false, nextRunAt: null });
    expect(res.body.find((j: any) => j.key === "routeListEssential")).toMatchObject({ enabled: true, essential: true });
  });

  it("still lets Run now start a job that is switched off", async () => {
    jobs.startAllJobs();
    const job = registerGatedJob("routeOffButRuns");
    try {
      await patchEnabled("routeOffButRuns").send({ enabled: false });

      const res = await runJob("routeOffButRuns");

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ started: true });
      expect(job.runs()).toBe(1);
    } finally {
      job.finish();
    }
  });

  it("answers 404 for an unknown job", async () => {
    const res = await patchEnabled("noSuchJobToSwitch").send({ enabled: false });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown job");
  });

  it("answers 409 with the reason for an essential job, and leaves it switched on", async () => {
    jobs.registerJob({ key: "routeEssentialJob", name: "Queue Poll Stand-in", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });

    const res = await patchEnabled("routeEssentialJob").send({ enabled: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("cannot be switched off");
    expect(statusOf("routeEssentialJob")).toMatchObject({ enabled: true, essential: true });
  });

  it("accepts switching an essential job on, which changes nothing", async () => {
    jobs.registerJob({ key: "routeEssentialOn", name: "Essential On", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });

    const res = await patchEnabled("routeEssentialOn").send({ enabled: true });

    expect(res.status).toBe(204);
    expect(statusOf("routeEssentialOn").enabled).toBe(true);
  });

  it.each([
    ["a string", { enabled: "false" }],
    ["a number", { enabled: 0 }],
    ["null", { enabled: null }],
    ["a missing field", {}],
    ["another field only", { schedule: "0 5 * * *" }],
  ])("answers 400 and changes nothing when enabled is %s", async (_label, body) => {
    jobs.registerJob({ key: "routeBadBodyJob", name: "Bad Body", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const res = await patchEnabled("routeBadBodyJob").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("enabled must be true or false");
    expect(statusOf("routeBadBodyJob").enabled).toBe(true);
  });

  it("answers 400 when the request has no body at all", async () => {
    jobs.registerJob({ key: "routeNoBodyJob", name: "No Body", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const res = await patchEnabled("routeNoBodyJob");

    expect(res.status).toBe(400);
    expect(statusOf("routeNoBodyJob").enabled).toBe(true);
  });

  it("refuses a caller without the API key and leaves the job alone", async () => {
    jobs.registerJob({ key: "routeNoAuthJob", name: "No Auth", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const res = await request(app).patch("/api/jobs/routeNoAuthJob/enabled").send({ enabled: false });

    expect(res.status).toBe(401);
    expect(statusOf("routeNoAuthJob").enabled).toBe(true);
  });
});
