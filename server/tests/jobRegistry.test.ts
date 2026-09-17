import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let registerJob: (typeof import("../src/services/jobRegistry.js"))["registerJob"];
let runJobNow: (typeof import("../src/services/jobRegistry.js"))["runJobNow"];
let cancelJob: (typeof import("../src/services/jobRegistry.js"))["cancelJob"];
let updateJobSchedule: (typeof import("../src/services/jobRegistry.js"))["updateJobSchedule"];
let listJobs: (typeof import("../src/services/jobRegistry.js"))["listJobs"];
let stopAllJobs: (typeof import("../src/services/jobRegistry.js"))["stopAllJobs"];
let setSetting: (key: string, value: string) => void;
let uniqueCounter = 0;

beforeAll(async () => {
  await setupTestDb();
  ({ registerJob, runJobNow, cancelJob, updateJobSchedule, listJobs, stopAllJobs } = await import("../src/services/jobRegistry.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  // updateJobSchedule's success path starts a REAL cron/interval timer — unconditionally clear
  // every registered job's timer after each test so nothing keeps firing into later tests or
  // leaks past the test run itself (defs/state are module-private and never reset between tests).
  stopAllJobs();
});

function uniqueKey(prefix: string): string {
  uniqueCounter++;
  return `${prefix}-${uniqueCounter}`;
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("registerJob / listJobs", () => {
  it("registers a job with its default schedule and initial idle state", () => {
    const key = uniqueKey("basic");
    registerJob({ key, name: "Basic Job", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const job = listJobs().find((j) => j.key === key)!;
    expect(job.schedule).toBe("0 3 * * *");
    expect(job.running).toBe(false);
    expect(job.lastStatus).toBeNull();
    expect(job.nextRunAt).not.toBeNull();
  });

  it("picks up a previously persisted schedule instead of the default", () => {
    const key = uniqueKey("persisted");
    setSetting(`jobSchedule_${key}`, "0 4 * * *");

    registerJob({ key, name: "Persisted Schedule Job", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    expect(listJobs().find((j) => j.key === key)!.schedule).toBe("0 4 * * *");
  });

  it("reports null nextRunAt for an interval job that hasn't run yet", () => {
    const key = uniqueKey("interval-fresh");
    registerJob({ key, name: "Fresh Interval Job", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });

    expect(listJobs().find((j) => j.key === key)!.nextRunAt).toBeNull();
  });
});

describe("runJobNow", () => {
  it("returns false for an unknown job key", () => {
    expect(runJobNow("definitely-not-a-registered-job")).toBe(false);
  });

  it("runs the job and records a success status", async () => {
    const key = uniqueKey("success");
    let ran = false;
    registerJob({
      key,
      name: "Success Job",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async () => {
        ran = true;
      },
    });

    expect(runJobNow(key)).toBe(true);
    await tick();

    expect(ran).toBe(true);
    const job = listJobs().find((j) => j.key === key)!;
    expect(job.lastStatus).toBe("success");
    expect(job.running).toBe(false);
    expect(job.lastRunAt).not.toBeNull();
  });

  it("records an error status and message when the job throws", async () => {
    const key = uniqueKey("failure");
    registerJob({
      key,
      name: "Failure Job",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async () => {
        throw new Error("job blew up");
      },
    });

    runJobNow(key);
    await tick();

    const job = listJobs().find((j) => j.key === key)!;
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("job blew up");
  });

  it("skips a trigger while the job is already running, instead of running it twice", async () => {
    const key = uniqueKey("already-running");
    let runCount = 0;
    let releaseFirstRun: () => void = () => {};
    const firstRunGate = new Promise<void>((resolve) => (releaseFirstRun = resolve));
    registerJob({
      key,
      name: "Already Running Job",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async () => {
        runCount++;
        await firstRunGate;
      },
    });

    runJobNow(key);
    await tick(); // let the first run actually start and set running=true
    runJobNow(key); // should be skipped — the job is still "running"
    await tick();
    releaseFirstRun();
    await tick();

    expect(runCount).toBe(1);
  });
});

describe("cancelJob", () => {
  it("returns false for a job that isn't currently running", () => {
    const key = uniqueKey("not-running");
    registerJob({ key, name: "Not Running Job", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    expect(cancelJob(key)).toBe(false);
  });

  it("aborts a running job's signal and marks it cancelled once it settles", async () => {
    const key = uniqueKey("cancellable");
    let sawAborted = false;
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => (releaseRun = resolve));
    registerJob({
      key,
      name: "Cancellable Job",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async (signal) => {
        await runGate;
        sawAborted = signal.aborted;
      },
    });

    runJobNow(key);
    await tick();
    expect(cancelJob(key)).toBe(true);
    releaseRun();
    await tick();

    expect(sawAborted).toBe(true);
    expect(listJobs().find((j) => j.key === key)!.lastStatus).toBe("cancelled");
  });
});

describe("updateJobSchedule", () => {
  it("returns an error for an unknown job key", () => {
    expect(updateJobSchedule("no-such-job-at-all", "0 5 * * *")).toEqual({ ok: false, error: "Unknown job" });
  });

  it("rejects an invalid cron expression for a cron-type job", () => {
    const key = uniqueKey("bad-cron");
    registerJob({ key, name: "Bad Cron Job", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const result = updateJobSchedule(key, "not a cron expression");

    expect(result).toEqual({ ok: false, error: "Invalid cron expression" });
    expect(listJobs().find((j) => j.key === key)!.schedule).toBe("0 3 * * *"); // unchanged
  });

  it("rejects an interval below the 5-second minimum", () => {
    const key = uniqueKey("bad-interval");
    registerJob({ key, name: "Bad Interval Job", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });

    const result = updateJobSchedule(key, "3");

    expect(result).toEqual({ ok: false, error: "Interval must be a whole number of seconds, at least 5" });
  });

  it("rejects a non-numeric interval", () => {
    const key = uniqueKey("non-numeric-interval");
    registerJob({ key, name: "Non Numeric Interval Job", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });

    expect(updateJobSchedule(key, "soon")).toEqual({ ok: false, error: "Interval must be a whole number of seconds, at least 5" });
  });

  it("accepts and persists a valid new schedule", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    const key = uniqueKey("good-cron");
    registerJob({ key, name: "Good Cron Job", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    const result = updateJobSchedule(key, "0 5 * * *");

    expect(result).toEqual({ ok: true });
    expect(listJobs().find((j) => j.key === key)!.schedule).toBe("0 5 * * *");
    expect(getSetting(`jobSchedule_${key}`)).toBe("0 5 * * *");
  });

  it("accepts a valid interval schedule", () => {
    const key = uniqueKey("good-interval");
    registerJob({ key, name: "Good Interval Job", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });

    expect(updateJobSchedule(key, "30")).toEqual({ ok: true });
    expect(listJobs().find((j) => j.key === key)!.schedule).toBe("30");
  });
});
