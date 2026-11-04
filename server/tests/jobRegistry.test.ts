import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import cron from "node-cron";
import { setupTestDb } from "./helpers/testDb.js";

let registerJob: (typeof import("../src/services/jobRegistry.js"))["registerJob"];
let setJobEnabled: (typeof import("../src/services/jobRegistry.js"))["setJobEnabled"];
let runJobNow: (typeof import("../src/services/jobRegistry.js"))["runJobNow"];
let cancelJob: (typeof import("../src/services/jobRegistry.js"))["cancelJob"];
let updateJobSchedule: (typeof import("../src/services/jobRegistry.js"))["updateJobSchedule"];
let listJobs: (typeof import("../src/services/jobRegistry.js"))["listJobs"];
let stopAllJobs: (typeof import("../src/services/jobRegistry.js"))["stopAllJobs"];
let startAllJobs: (typeof import("../src/services/jobRegistry.js"))["startAllJobs"];
let isJobsStopped: (typeof import("../src/services/jobRegistry.js"))["isJobsStopped"];
let runJobWithResult: (typeof import("../src/services/jobRegistry.js"))["runJobWithResult"];
let hydrateJobHistory: (typeof import("../src/services/jobRegistry.js"))["hydrateJobHistory"];
let catchUpMissedJobs: (typeof import("../src/services/jobRegistry.js"))["catchUpMissedJobs"];
let getFailingJobs: (typeof import("../src/services/jobRegistry.js"))["getFailingJobs"];
let listJobRuns: (typeof import("../src/services/jobRegistry.js"))["listJobRuns"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (key: string, value: string) => void;
let getSetting: (key: string) => string | null;
let uniqueCounter = 0;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({
    registerJob,
    setJobEnabled,
    runJobNow,
    cancelJob,
    updateJobSchedule,
    listJobs,
    stopAllJobs,
    startAllJobs,
    isJobsStopped,
    runJobWithResult,
    hydrateJobHistory,
    catchUpMissedJobs,
    getFailingJobs,
    listJobRuns,
  } = await import("../src/services/jobRegistry.js"));
  ({ setSetting, getSetting } = await import("../src/services/settingsStore.js"));
});

// stopAllJobs also refuses every later run until startAllJobs, so each test starts from there.
beforeEach(() => {
  startAllJobs();
});

afterEach(() => {
  // startAllJobs and updateJobSchedule's success path start REAL cron/interval timers — clear every
  // registered job's timer after each test so nothing keeps firing into later tests or leaks past
  // the test run itself (defs/state are module-private and never reset between tests).
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
  it("reports an unknown job key", () => {
    expect(runJobNow("definitely-not-a-registered-job")).toBe("unknown");
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

    expect(runJobNow(key)).toBe("started");
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
    expect(runJobNow(key)).toBe("already-running");
    await tick();
    releaseFirstRun();
    await tick();

    expect(runCount).toBe(1);
  });
});

describe("stopAllJobs", () => {
  it("refuses to run a job, even on demand, until startAllJobs", async () => {
    const key = uniqueKey("stopped");
    let runCount = 0;
    registerJob({
      key,
      name: "Stopped Job",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async () => {
        runCount++;
      },
    });

    stopAllJobs();
    expect(isJobsStopped()).toBe(true);
    expect(runJobNow(key)).toBe("stopped");
    await tick();
    expect(runCount).toBe(0);
    expect(listJobs().find((j) => j.key === key)!.lastRunAt).toBeNull();

    startAllJobs();
    expect(isJobsStopped()).toBe(false);
    expect(runJobNow(key)).toBe("started");
    await tick();
    expect(runCount).toBe(1);
  });

  it("still reports an unknown job key as unknown while stopped", () => {
    stopAllJobs();
    expect(runJobNow("no-such-job-while-stopped")).toBe("unknown");
  });

  it("saves a schedule change made while stopped without restarting its timer", () => {
    const key = uniqueKey("stopped-schedule");
    registerJob({ key, name: "Stopped Schedule Job", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });

    stopAllJobs();
    vi.useFakeTimers();
    try {
      expect(updateJobSchedule(key, "30")).toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(listJobs().find((j) => j.key === key)!.schedule).toBe("30");
    expect(runJobNow(key)).toBe("stopped");
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

/** Resolves when `check` returns true, polling every few ms. */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await tick(5);
  }
  throw new Error("condition not met in time");
}

describe("job history is kept in job_runs (RB6)", () => {
  it("records a run with its status and duration, and a failure with its error", async () => {
    const ok = uniqueKey("hist-ok");
    const bad = uniqueKey("hist-bad");
    registerJob({ key: ok, name: "Ok", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    registerJob({
      key: bad,
      name: "Bad",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async () => {
        throw new Error("boom");
      },
    });

    runJobNow(ok);
    runJobNow(bad);
    // Both rows are written without the registry waiting for them (a database round trip against Postgres): wait until both runs have ended.
    await waitUntil(
      async () =>
        (await listJobRuns(ok)).length === 1 && (await listJobRuns(bad)).length === 1 && (await listJobRuns(ok))[0].status !== "running" && (await listJobRuns(bad))[0].status !== "running"
    );

    const [okRun] = await listJobRuns(ok);
    expect(okRun.status).toBe("success");
    expect(okRun.finished_at).not.toBeNull();
    expect(okRun.duration_ms).toBeGreaterThanOrEqual(0);
    const [badRun] = await listJobRuns(bad);
    expect(badRun).toMatchObject({ status: "error", error: "boom" });
  });

  it("brings the last result back after a restart (hydrateJobHistory) instead of 'Never'", async () => {
    const key = uniqueKey("hydrate");
    await db
      .prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error, duration_ms) VALUES (?, ?, ?, 'error', 'it broke', 1200)")
      .run(key, "2026-01-02T03:00:00.000Z", "2026-01-02T03:00:01.200Z");
    registerJob({ key, name: "Hydrated", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    expect(listJobs().find((j) => j.key === key)!.lastRunAt).toBeNull();

    await hydrateJobHistory();

    expect(listJobs().find((j) => j.key === key)).toMatchObject({
      lastRunAt: "2026-01-02T03:00:01.200Z",
      lastStatus: "error",
      lastError: "it broke",
      lastDurationMs: 1200,
    });
  });

  it("reads a run still marked 'running' as one a restart interrupted", async () => {
    const key = uniqueKey("interrupted");
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES (?, ?, 'running')").run(key, "2026-01-02T03:00:00.000Z");
    registerJob({ key, name: "Cut off", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    await hydrateJobHistory();

    expect(listJobs().find((j) => j.key === key)).toMatchObject({ lastStatus: "error", lastError: "Interrupted by a restart" });
  });

  it("reports a job whose last three runs all failed, and not one that has recovered or was cancelled", async () => {
    const failing = uniqueKey("failing");
    const recovered = uniqueKey("recovered");
    const cancelled = uniqueKey("cancelled");
    for (const key of [failing, recovered, cancelled]) registerJob({ key, name: key, scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    const add = async (key: string, status: string, minute: number) =>
      db
        .prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error) VALUES (?, ?, ?, ?, ?)")
        .run(key, `2026-02-01T0${minute}:00:00.000Z`, `2026-02-01T0${minute}:00:05.000Z`, status, status === "error" ? "nope" : null);
    for (const m of [1, 2, 3]) await add(failing, "error", m);
    await add(recovered, "error", 1);
    await add(recovered, "error", 2);
    await add(recovered, "success", 3);
    await add(cancelled, "error", 1);
    await add(cancelled, "cancelled", 2);
    await add(cancelled, "error", 3);

    const keys = (await getFailingJobs(3)).map((j) => j.key);

    expect(keys).toContain(failing);
    expect(keys).not.toContain(recovered);
    expect(keys).not.toContain(cancelled);
    expect((await getFailingJobs(3)).find((j) => j.key === failing)!.lastError).toBe("nope");
  });
});

describe("one heavy job at a time (RB7)", () => {
  it("makes a second heavy job wait for the first, while an ordinary job is not held up", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = uniqueKey("heavy-1");
    const second = uniqueKey("heavy-2");
    const light = uniqueKey("light");
    registerJob({
      key: first,
      name: "First",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      heavy: true,
      run: () =>
        new Promise<void>((resolve) => {
          events.push("first start");
          releaseFirst = () => {
            events.push("first end");
            resolve();
          };
        }),
    });
    registerJob({
      key: second,
      name: "Second",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      heavy: true,
      run: async () => {
        events.push("second start");
      },
    });
    registerJob({ key: light, name: "Light", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => void events.push("light") });

    runJobNow(first);
    await waitUntil(() => events.includes("first start"));
    runJobNow(second);
    runJobNow(light);
    await waitUntil(() => events.includes("light"));
    await tick(30);

    expect(events).toEqual(["first start", "light"]);
    expect(listJobs().find((j) => j.key === second)).toMatchObject({ queued: true, running: false, heavy: true });

    releaseFirst();
    await waitUntil(() => events.includes("second start"));
    expect(events).toEqual(["first start", "light", "first end", "second start"]);
    expect(listJobs().find((j) => j.key === second)!.queued).toBe(false);
  });

  it("treats a trigger for a job that is already waiting as a duplicate", async () => {
    let releaseFirst!: () => void;
    const first = uniqueKey("dup-1");
    const second = uniqueKey("dup-2");
    registerJob({ key: first, name: "A", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (releaseFirst = r)) });
    registerJob({ key: second, name: "B", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => {} });
    runJobNow(first);
    await waitUntil(() => listJobs().find((j) => j.key === first)!.running);
    expect(runJobNow(second)).toBe("started");
    expect(runJobNow(second)).toBe("already-running");
    releaseFirst();
    await waitUntil(() => listJobs().find((j) => j.key === second)!.lastStatus === "success");
  });

  it("lets a waiting job be cancelled before it ever starts", async () => {
    let releaseFirst!: () => void;
    const ran: string[] = [];
    const first = uniqueKey("cancel-1");
    const second = uniqueKey("cancel-2");
    registerJob({ key: first, name: "A", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (releaseFirst = r)) });
    registerJob({ key: second, name: "B", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void ran.push("b") });
    runJobNow(first);
    await waitUntil(() => listJobs().find((j) => j.key === first)!.running);
    runJobNow(second);
    await waitUntil(() => listJobs().find((j) => j.key === second)!.queued);

    expect(cancelJob(second)).toBe(true);
    await waitUntil(() => !listJobs().find((j) => j.key === second)!.queued);
    releaseFirst();
    await tick(30);

    expect(ran).toEqual([]);
    // and its slot was not lost: the next heavy job runs
    const third = uniqueKey("cancel-3");
    registerJob({ key: third, name: "C", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void ran.push("c") });
    runJobNow(third);
    await waitUntil(() => ran.includes("c"));
  });

  it("stopAllJobs sends the waiting jobs away and the slot is free again afterwards", async () => {
    let releaseFirst!: () => void;
    const ran: string[] = [];
    const first = uniqueKey("stop-1");
    const second = uniqueKey("stop-2");
    registerJob({ key: first, name: "A", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (releaseFirst = r)) });
    registerJob({ key: second, name: "B", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void ran.push("b") });
    runJobNow(first);
    await waitUntil(() => listJobs().find((j) => j.key === first)!.running);
    runJobNow(second);
    await waitUntil(() => listJobs().find((j) => j.key === second)!.queued);

    stopAllJobs();
    releaseFirst();
    await waitUntil(() => !listJobs().find((j) => j.key === first)!.running);
    await tick(20);
    expect(ran).toEqual([]);

    startAllJobs();
    const third = uniqueKey("stop-3");
    registerJob({ key: third, name: "C", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void ran.push("c") });
    runJobNow(third);
    await waitUntil(() => ran.includes("c"));
  });
});

describe("runJobWithResult (the manual buttons, RB7)", () => {
  it("runs the given function as a run of the job and returns its value", async () => {
    const key = uniqueKey("manual");
    let scheduledRuns = 0;
    registerJob({ key, name: "Manual", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => void scheduledRuns++ });

    const outcome = await runJobWithResult(key, async () => ({ added: 3 }));

    expect(outcome).toEqual({ status: "ran", value: { added: 3 } });
    expect(scheduledRuns).toBe(0);
    expect(listJobs().find((j) => j.key === key)!.lastStatus).toBe("success");
    await waitUntil(async () => (await listJobRuns(key)).length === 1 && (await listJobRuns(key))[0].status === "success");
  });

  it("refuses to run beside the same job already running", async () => {
    const key = uniqueKey("manual-busy");
    let release!: () => void;
    registerJob({ key, name: "Busy", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: () => new Promise<void>((r) => (release = r)) });
    runJobNow(key);
    await waitUntil(() => listJobs().find((j) => j.key === key)!.running);

    expect(await runJobWithResult(key, async () => 1)).toEqual({ status: "skipped", reason: "already-running" });
    release();
  });

  it("records a failure and throws it to the caller", async () => {
    const key = uniqueKey("manual-fail");
    registerJob({ key, name: "Fails", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    await expect(
      runJobWithResult(key, async () => {
        throw new Error("sync failed");
      })
    ).rejects.toThrow("sync failed");
    expect(listJobs().find((j) => j.key === key)).toMatchObject({ lastStatus: "error", lastError: "sync failed" });
  });

  it("is skipped for an unknown job and while jobs are stopped", async () => {
    expect(await runJobWithResult("no-such-job", async () => 1)).toEqual({ status: "skipped", reason: "unknown" });
    const key = uniqueKey("manual-stopped");
    registerJob({ key, name: "S", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    stopAllJobs();
    expect(await runJobWithResult(key, async () => 1)).toEqual({ status: "skipped", reason: "stopped" });
  });
});

describe("catching up a weekly job a restart skipped (RB6)", () => {
  async function hydratedJob(lastRunIso: string | null, catchUp = true): Promise<string> {
    const key = uniqueKey("catchup");
    if (lastRunIso) {
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, lastRunIso, lastRunIso);
    }
    registerJob({ key, name: "Weekly", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp, run: async () => {} });
    await hydrateJobHistory();
    return key;
  }

  it("schedules a job whose last run is older than its previous scheduled time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      // Sunday 2026-11-08 12:00 UTC: the previous scheduled run was that morning at 04:00.
      const key = await hydratedJob("2026-11-01T04:00:05.000Z");
      const scheduled = catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"));
      expect(scheduled).toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a job alone that ran after its previous scheduled time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = await hydratedJob("2026-11-08T04:00:05.000Z");
      expect(catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"))).not.toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a job with no history at all alone, so the first start after an upgrade does not run every weekly job", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = await hydratedJob(null);
      expect(catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"))).not.toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a job that did not ask for catch-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = await hydratedJob("2026-11-01T04:00:05.000Z", false);
      expect(catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"))).not.toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the missed job a couple of minutes later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let ran = false;
    try {
      const key = uniqueKey("catchup-run");
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-11-01T04:00:05.000Z", "2026-11-01T04:00:05.000Z");
      registerJob({ key, name: "Weekly", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp: true, run: async () => void (ran = true) });
      await hydrateJobHistory();
      catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"));
      expect(ran).toBe(false);
      // Earlier tests left other overdue jobs registered, which are staggered ahead of this one.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("review fixes: history, failing rule and catch-up (RB6)", () => {
  it("does not call three failures within a few minutes a failing job, and leaves interval jobs out", async () => {
    const quick = uniqueKey("quick-fails");
    const poll = uniqueKey("interval-fails");
    registerJob({ key: quick, name: "Quick", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    registerJob({ key: poll, name: "Poll", scheduleType: "interval", defaultSchedule: "20", run: async () => {} });
    for (const minute of [1, 2, 3]) {
      for (const key of [quick, poll]) {
        await db
          .prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error) VALUES (?, ?, ?, 'error', 'x')")
          .run(key, `2026-05-01T00:0${minute}:00.000Z`, `2026-05-01T00:0${minute}:01.000Z`);
      }
    }
    const keys = (await getFailingJobs(3)).map((j) => j.key);
    expect(keys).not.toContain(quick);
    expect(keys).not.toContain(poll);
  });

  it("records an interval job only when it fails or is slow, so the queue poll does not write 4,000 rows a day", async () => {
    const quiet = uniqueKey("poll-ok");
    const failing = uniqueKey("poll-bad");
    registerJob({ key: quiet, name: "Quiet", scheduleType: "interval", defaultSchedule: "3600", run: async () => {} });
    registerJob({
      key: failing,
      name: "Failing poll",
      scheduleType: "interval",
      defaultSchedule: "3600",
      run: async () => {
        throw new Error("client down");
      },
    });
    runJobNow(quiet);
    runJobNow(failing);
    // The failed run's row is written without the registry waiting for it: wait for it, then give a row that must NOT appear a moment to prove it does not.
    await waitUntil(async () => (await listJobRuns(failing)).length === 1);
    await tick(30);
    await tick(30);

    expect(await listJobRuns(quiet)).toEqual([]);
    const rows = await listJobRuns(failing);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "error", error: "client down" });
  });

  it("closes a run an earlier process left 'running', and does not count it as a completed run for catch-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = uniqueKey("cut-off");
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-10-25T04:00:05.000Z", "2026-10-25T05:00:00.000Z");
      // The run that was in progress on Sunday morning when the container was stopped.
      await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES (?, ?, 'running')").run(key, "2026-11-01T04:00:05.000Z");
      registerJob({ key, name: "Cut off weekly", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp: true, run: async () => {} });

      await hydrateJobHistory();

      const [newest] = await listJobRuns(key, 1);
      expect(newest).toMatchObject({ status: "error", error: "Interrupted by a restart" });
      expect(catchUpMissedJobs(new Date("2026-11-01T12:00:00.000Z"))).toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a catch-up job on a sub-daily schedule alone, so a restart does not run it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = uniqueKey("hourly-catchup");
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-11-01T01:00:00.000Z", "2026-11-01T01:00:05.000Z");
      registerJob({ key, name: "Hourly", scheduleType: "cron", defaultSchedule: "0 * * * *", catchUp: true, run: async () => {} });
      await hydrateJobHistory();
      expect(catchUpMissedJobs(new Date("2026-11-08T12:30:00.000Z"))).not.toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not label a job that is running right now as interrupted", async () => {
    const key = uniqueKey("running-now");
    let release!: () => void;
    registerJob({ key, name: "Running now", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: () => new Promise<void>((r) => (release = r)) });
    runJobNow(key);
    await waitUntil(() => listJobs().find((j) => j.key === key)!.running);

    await hydrateJobHistory();

    expect(listJobs().find((j) => j.key === key)!.lastStatus).toBeNull();
    expect((await listJobRuns(key))[0].status).toBe("running");
    release();
    await waitUntil(() => listJobs().find((j) => j.key === key)!.lastStatus === "success");
  });
});

describe("review fixes: the heavy slot (RB7)", () => {
  it("tells a caller that is waiting for the answer which job has the slot, instead of queueing it behind a long scan", async () => {
    let release!: () => void;
    const scan = uniqueKey("long-scan");
    const manual = uniqueKey("manual-heavy");
    registerJob({ key: scan, name: "Long Scan", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (release = r)) });
    registerJob({ key: manual, name: "Manual Heavy", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => {} });
    runJobNow(scan);
    await waitUntil(() => listJobs().find((j) => j.key === scan)!.running);

    const outcome = await runJobWithResult(manual, async () => 1, { immediate: true });

    expect(outcome).toEqual({ status: "skipped", reason: "busy", holder: "Long Scan" });
    expect(listJobs().find((j) => j.key === manual)!.queued).toBe(false);
    release();
  });

  it("shows which job a waiting job is waiting for", async () => {
    let release!: () => void;
    const first = uniqueKey("holder");
    const second = uniqueKey("waiter");
    registerJob({ key: first, name: "The Holder", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (release = r)) });
    registerJob({ key: second, name: "The Waiter", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => {} });
    runJobNow(first);
    await waitUntil(() => listJobs().find((j) => j.key === first)!.running);
    runJobNow(second);
    await waitUntil(() => listJobs().find((j) => j.key === second)!.queued);

    expect(listJobs().find((j) => j.key === second)!.waitingFor).toBe("The Holder");
    release();
    await waitUntil(() => listJobs().find((j) => j.key === second)!.lastStatus === "success");
  });

  it("gives the slot to the next heavy job a minute after the running one was cancelled and did not stop", async () => {
    let finishStuck!: () => void;
    const ran: string[] = [];
    const stuck = uniqueKey("stuck");
    const next = uniqueKey("after-stuck");
    registerJob({ key: stuck, name: "Stuck", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: () => new Promise<void>((r) => (finishStuck = r)) });
    registerJob({ key: next, name: "Next", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void ran.push("next") });
    runJobNow(stuck);
    await waitUntil(() => listJobs().find((j) => j.key === stuck)!.running);
    runJobNow(next);
    await waitUntil(() => listJobs().find((j) => j.key === next)!.queued);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      expect(cancelJob(stuck)).toBe(true);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    await waitUntil(() => ran.includes("next"));

    // The stuck job ending later must not hand the slot over a second time.
    finishStuck();
    await waitUntil(() => !listJobs().find((j) => j.key === stuck)!.running);
    const third = uniqueKey("third-heavy");
    const order: string[] = [];
    registerJob({ key: third, name: "Third", scheduleType: "cron", defaultSchedule: "0 3 * * *", heavy: true, run: async () => void order.push("third") });
    runJobNow(third);
    await waitUntil(() => order.includes("third"));
  });
});

describe("the per-job on/off switch (setJobEnabled)", () => {
  const statusOf = (key: string) => listJobs().find((j) => j.key === key)!;

  it("lists a new job as switched on and not essential", () => {
    const key = uniqueKey("switch-default");
    registerJob({ key, name: "Default On", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    expect(statusOf(key)).toMatchObject({ enabled: true, essential: false });
  });

  it("gives a switched-off job no next run, keeps its schedule, and brings the next run back when it is switched on again", () => {
    const key = uniqueKey("switch-next");
    registerJob({ key, name: "Switchable", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    expect(statusOf(key).nextRunAt).not.toBeNull();

    expect(setJobEnabled(key, false)).toEqual({ ok: true });
    expect(statusOf(key)).toMatchObject({ enabled: false, nextRunAt: null, schedule: "0 3 * * *" });

    expect(setJobEnabled(key, true)).toEqual({ ok: true });
    expect(statusOf(key).enabled).toBe(true);
    expect(statusOf(key).nextRunAt).not.toBeNull();
  });

  it("reports no next run for a switched-off interval job even after it has run", async () => {
    const key = uniqueKey("switch-interval-next");
    registerJob({ key, name: "Interval Switchable", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });
    runJobNow(key);
    await waitUntil(() => statusOf(key).lastStatus === "success");
    expect(statusOf(key).nextRunAt).not.toBeNull();

    setJobEnabled(key, false);

    expect(statusOf(key).nextRunAt).toBeNull();
    expect(statusOf(key).lastStatus).toBe("success"); // what it did before stays on the page
  });

  it("answers 'Unknown job' for a key that was never registered", () => {
    expect(setJobEnabled("no-such-job-to-switch", false)).toEqual({ ok: false, error: "Unknown job" });
  });

  it("starts no cron timer for a switched-off job, starts one when it is switched on, and stops it when it is switched off", () => {
    const schedule = "13 4 * * 2";
    const key = uniqueKey("switch-cron-timer");
    const spy = vi.spyOn(cron, "schedule");
    try {
      registerJob({ key, name: "Cron Timer", scheduleType: "cron", defaultSchedule: schedule, run: async () => {} });
      setJobEnabled(key, false);

      stopAllJobs();
      startAllJobs();
      const scheduledFor = () => spy.mock.calls.filter((call) => call[0] === schedule).length;
      expect(scheduledFor()).toBe(0);

      setJobEnabled(key, true);
      expect(scheduledFor()).toBe(1);
      const task = spy.mock.results.find((r, i) => spy.mock.calls[i][0] === schedule)!.value as cron.ScheduledTask;
      const stop = vi.spyOn(task, "stop");

      setJobEnabled(key, false);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(scheduledFor()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not start a second timer when a job that is already on is switched on again", () => {
    const schedule = "14 4 * * 2";
    const key = uniqueKey("switch-no-double");
    const spy = vi.spyOn(cron, "schedule");
    try {
      registerJob({ key, name: "No Double Timer", scheduleType: "cron", defaultSchedule: schedule, run: async () => {} });
      stopAllJobs();
      startAllJobs();
      const scheduledFor = () => spy.mock.calls.filter((call) => call[0] === schedule).length;
      expect(scheduledFor()).toBe(1);

      expect(setJobEnabled(key, true)).toEqual({ ok: true });

      expect(scheduledFor()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("never fires a switched-off interval job on its timer, fires it once it is switched on, and stops again when it is switched off", async () => {
    const key = uniqueKey("switch-interval-timer");
    let runs = 0;
    registerJob({ key, name: "Interval Timer", scheduleType: "interval", defaultSchedule: "5", run: async () => void runs++ });
    setJobEnabled(key, false);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      stopAllJobs();
      startAllJobs();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runs).toBe(0);

      setJobEnabled(key, true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runs).toBe(1);

      setJobEnabled(key, false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runs).toBe(1);
    } finally {
      stopAllJobs();
      vi.useRealTimers();
    }
  });

  it("does not start a timer for a job switched on while jobs are stopped, but does at the next start", () => {
    const key = uniqueKey("switch-while-stopped");
    registerJob({ key, name: "Switched On While Stopped", scheduleType: "interval", defaultSchedule: "60", run: async () => {} });
    stopAllJobs();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      setJobEnabled(key, false);
      setJobEnabled(key, true);
      expect(vi.getTimerCount()).toBe(0);
      expect(statusOf(key).enabled).toBe(true);

      startAllJobs();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } finally {
      stopAllJobs();
      vi.useRealTimers();
    }
  });

  it("still runs a switched-off job on Run now, and leaves it switched off", async () => {
    const key = uniqueKey("switch-run-now");
    let runs = 0;
    registerJob({ key, name: "Run Now Anyway", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => void runs++ });
    setJobEnabled(key, false);

    expect(runJobNow(key)).toBe("started");
    await waitUntil(() => statusOf(key).lastStatus === "success");

    expect(runs).toBe(1);
    expect(statusOf(key)).toMatchObject({ enabled: false, nextRunAt: null, running: false });
  });

  it("still runs a switched-off job through runJobWithResult (the System page's buttons)", async () => {
    const key = uniqueKey("switch-run-result");
    registerJob({ key, name: "Button Anyway", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    setJobEnabled(key, false);

    expect(await runJobWithResult(key, async () => 42)).toEqual({ status: "ran", value: 42 });
  });

  it("stores the choice as the setting jobEnabled_<key> and leaves the saved schedule alone", () => {
    const key = uniqueKey("switch-setting");
    registerJob({ key, name: "Stored Choice", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    updateJobSchedule(key, "0 5 * * *");

    setJobEnabled(key, false);
    expect(getSetting(`jobEnabled_${key}`)).toBe("0");

    setJobEnabled(key, true);
    expect(getSetting(`jobEnabled_${key}`)).toBe("1");
    expect(getSetting(`jobSchedule_${key}`)).toBe("0 5 * * *");
    expect(statusOf(key).schedule).toBe("0 5 * * *");
  });

  it("keeps the choice when the job is registered again, as after a restart", () => {
    const key = uniqueKey("switch-restart");
    const def = { key, name: "Survives Restart", scheduleType: "cron" as const, defaultSchedule: "0 3 * * *", run: async () => {} };
    registerJob(def);
    setJobEnabled(key, false);

    registerJob(def);
    expect(statusOf(key).enabled).toBe(false);
    expect(statusOf(key).nextRunAt).toBeNull();

    setJobEnabled(key, true);
    registerJob(def);
    expect(statusOf(key).enabled).toBe(true);
  });

  it("reads a choice that was saved before the job was first registered; no saved choice means on", () => {
    const off = uniqueKey("switch-saved-off");
    const on = uniqueKey("switch-saved-on");
    const none = uniqueKey("switch-saved-none");
    setSetting(`jobEnabled_${off}`, "0");
    setSetting(`jobEnabled_${on}`, "1");
    for (const key of [off, on, none]) registerJob({ key, name: key, scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });

    expect(statusOf(off).enabled).toBe(false);
    expect(statusOf(on).enabled).toBe(true);
    expect(statusOf(none).enabled).toBe(true);
  });

  it("leaves a switched-off job out of the catch-up after a restart, and catches it up again once it is switched on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = uniqueKey("switch-catchup");
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-11-01T04:00:05.000Z", "2026-11-01T04:00:05.000Z");
      registerJob({ key, name: "Weekly Switchable", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp: true, run: async () => {} });
      await hydrateJobHistory();
      const sunday = new Date("2026-11-08T12:00:00.000Z");

      setJobEnabled(key, false);
      expect(catchUpMissedJobs(sunday)).not.toContain(key);

      setJobEnabled(key, true);
      expect(catchUpMissedJobs(sunday)).toContain(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run a switched-off job when its catch-up timer would fire", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = uniqueKey("switch-catchup-timer");
      let runs = 0;
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-11-01T04:00:05.000Z", "2026-11-01T04:00:05.000Z");
      registerJob({ key, name: "Weekly Off", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp: true, run: async () => void runs++ });
      await hydrateJobHistory();
      setJobEnabled(key, false);

      catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"));
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(runs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a switched-off job out of the failing jobs, since it is not running, and lists it again when it is switched on", async () => {
    const key = uniqueKey("switch-failing");
    registerJob({ key, name: "Failing But Off", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    for (const hour of [1, 2, 3]) {
      await db
        .prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error) VALUES (?, ?, ?, 'error', 'HTTP 503')")
        .run(key, `2026-03-01T0${hour}:00:00.000Z`, `2026-03-01T0${hour}:00:01.000Z`);
    }
    expect((await getFailingJobs(3)).map((j) => j.key)).toContain(key);

    setJobEnabled(key, false);
    expect((await getFailingJobs(3)).map((j) => j.key)).not.toContain(key);

    setJobEnabled(key, true);
    expect((await getFailingJobs(3)).map((j) => j.key)).toContain(key);
  });

  describe("an essential job", () => {
    it("is listed as essential and cannot be switched off, with the reason in the error", () => {
      const key = uniqueKey("essential");
      registerJob({ key, name: "Queue Poll Stand-in", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });

      const result = setJobEnabled(key, false);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('"Queue Poll Stand-in" cannot be switched off');
      expect(statusOf(key)).toMatchObject({ essential: true, enabled: true });
      expect(statusOf(key).nextRunAt).not.toBeNull();
      expect(getSetting(`jobEnabled_${key}`)).toBeNull();
    });

    it("keeps its timer when someone tries to switch it off", () => {
      const schedule = "15 4 * * 2";
      const key = uniqueKey("essential-timer");
      const spy = vi.spyOn(cron, "schedule");
      try {
        registerJob({ key, name: "Essential Timer", scheduleType: "cron", defaultSchedule: schedule, essential: true, run: async () => {} });
        stopAllJobs();
        startAllJobs();
        const index = spy.mock.calls.findIndex((call) => call[0] === schedule);
        expect(index).toBeGreaterThanOrEqual(0);
        const stop = vi.spyOn(spy.mock.results[index].value as cron.ScheduledTask, "stop");

        setJobEnabled(key, false);

        expect(stop).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("ignores an 'off' choice saved for it earlier", () => {
      const key = uniqueKey("essential-stale-setting");
      setSetting(`jobEnabled_${key}`, "0");

      registerJob({ key, name: "Stale Off", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });

      expect(statusOf(key).enabled).toBe(true);
    });

    it("accepts being 'switched on', which changes nothing", () => {
      const key = uniqueKey("essential-on");
      registerJob({ key, name: "Already On", scheduleType: "cron", defaultSchedule: "0 3 * * *", essential: true, run: async () => {} });

      expect(setJobEnabled(key, true)).toEqual({ ok: true });
      expect(statusOf(key).enabled).toBe(true);
    });
  });
});

describe("JobDef.run(signal, info): who started the run", () => {
  it("tells the job it was started by hand when the run comes from Run now", async () => {
    const key = uniqueKey("info-manual");
    let seen: { manual: boolean } | undefined;
    let called = false;
    registerJob({
      key,
      name: "Manual Info",
      scheduleType: "cron",
      defaultSchedule: "0 3 * * *",
      run: async (_signal, info) => {
        called = true;
        seen = info;
      },
    });

    runJobNow(key);
    await waitUntil(() => called);

    expect(seen?.manual).toBe(true);
  });

  it("tells the job it was not started by hand when its own timer fires", async () => {
    const key = uniqueKey("info-timer");
    const seen: ({ manual: boolean } | undefined)[] = [];
    registerJob({ key, name: "Timer Info", scheduleType: "interval", defaultSchedule: "5", run: async (_signal, info) => void seen.push(info) });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      stopAllJobs();
      startAllJobs();
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      stopAllJobs();
      vi.useRealTimers();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.manual).toBeFalsy();
  });

  it("tells the job it was not started by hand when the run is a catch-up after a restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const key = uniqueKey("info-catchup");
      const seen: ({ manual: boolean } | undefined)[] = [];
      await db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status) VALUES (?, ?, ?, 'success')").run(key, "2026-11-01T04:00:05.000Z", "2026-11-01T04:00:05.000Z");
      registerJob({ key, name: "Catch-up Info", scheduleType: "cron", defaultSchedule: "0 4 * * 0", catchUp: true, run: async (_signal, info) => void seen.push(info) });
      await hydrateJobHistory();

      expect(catchUpMissedJobs(new Date("2026-11-08T12:00:00.000Z"))).toContain(key);
      // Earlier tests left other overdue jobs registered, which are staggered ahead of this one.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.manual).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a job started by hand the manual flag again on every Run now, not only the first", async () => {
    const key = uniqueKey("info-manual-twice");
    const seen: boolean[] = [];
    registerJob({ key, name: "Twice", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async (_signal, info) => void seen.push(info?.manual === true) });

    runJobNow(key);
    await waitUntil(() => seen.length === 1);
    await waitUntil(() => !listJobs().find((j) => j.key === key)!.running);
    runJobNow(key);
    await waitUntil(() => seen.length === 2);

    expect(seen).toEqual([true, true]);
  });
});
