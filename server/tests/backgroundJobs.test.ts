import { describe, it, expect, vi } from "vitest";
import {
  startBackgroundJob,
  updateBackgroundJob,
  incrementBackgroundJobDone,
  finishBackgroundJob,
  isBackgroundJobRunning,
  listBackgroundJobs,
} from "../src/services/backgroundJobs.js";

// Every test below uses its own unique `type` string (never reused across tests) — the module's
// job map is a real singleton shared across this whole file, so this is what keeps tests from
// seeing each other's entries, the same isolation approach used for every other module-singleton
// store in this suite (e.g. metadata.ts's Trakt request spacer).

describe("backgroundJobs", () => {
  it("tracks a job from start through completion", () => {
    const id = startBackgroundJob("scan", "test-basic", "Scan & Import — Test Basic", 10);
    expect(isBackgroundJobRunning("scan", "test-basic")).toBe(true);

    incrementBackgroundJobDone("scan", "test-basic");
    incrementBackgroundJobDone("scan", "test-basic");
    let job = listBackgroundJobs().find((j) => j.id === id);
    expect(job).toMatchObject({ kind: "scan", type: "test-basic", label: "Scan & Import — Test Basic", total: 10, done: 2, running: true, error: null });
    expect(job!.finishedAt).toBeNull();

    finishBackgroundJob(id);
    expect(isBackgroundJobRunning("scan", "test-basic")).toBe(false);
    job = listBackgroundJobs().find((j) => j.id === id);
    expect(job!.running).toBe(false);
    expect(job!.finishedAt).not.toBeNull();
    expect(job!.error).toBeNull();
  });

  it("throws if the same (kind, type) pair is started again while still running", () => {
    startBackgroundJob("matchProviders", "test-double-start", "Match — Test Double Start");
    expect(() => startBackgroundJob("matchProviders", "test-double-start", "Match — Test Double Start")).toThrow(/already running/);
  });

  it("allows starting again once the previous run for that (kind, type) has finished", () => {
    const id1 = startBackgroundJob("scan", "test-restart", "Scan — Test Restart");
    finishBackgroundJob(id1);
    expect(() => startBackgroundJob("scan", "test-restart", "Scan — Test Restart")).not.toThrow();
  });

  it("records an error message when finished with one, distinct from a clean finish", () => {
    const id = startBackgroundJob("matchProviders", "test-error", "Match — Test Error");
    finishBackgroundJob(id, "boom");
    const job = listBackgroundJobs().find((j) => j.id === id);
    expect(job!.error).toBe("boom");
    expect(job!.running).toBe(false);
  });

  it("updateBackgroundJob and incrementBackgroundJobDone no-op for a (kind, type) that was never started", () => {
    expect(() => updateBackgroundJob("scan", "test-never-started", { total: 5 })).not.toThrow();
    expect(() => incrementBackgroundJobDone("scan", "test-never-started")).not.toThrow();
    expect(listBackgroundJobs().some((j) => j.type === "test-never-started")).toBe(false);
  });

  it("updateBackgroundJob sets total once the real count is known", () => {
    const id = startBackgroundJob("scan", "test-update-total", "Scan — Test Update Total");
    updateBackgroundJob("scan", "test-update-total", { total: 42 });
    expect(listBackgroundJobs().find((j) => j.id === id)!.total).toBe(42);
  });

  it("finishBackgroundJob on an unknown id is a harmless no-op", () => {
    expect(() => finishBackgroundJob("scan:does-not-exist")).not.toThrow();
  });

  it("lists jobs newest-started first", () => {
    const idA = startBackgroundJob("scan", "test-sort-a", "A");
    const idB = startBackgroundJob("scan", "test-sort-b", "B");
    const [a, b] = [idA, idB].map((id) => listBackgroundJobs().find((j) => j.id === id)!);
    expect(a.startedAt).toBeLessThanOrEqual(b.startedAt);
    const jobs = listBackgroundJobs().filter((j) => j.id === idA || j.id === idB);
    expect(jobs[0].startedAt).toBeGreaterThanOrEqual(jobs[1].startedAt);
  });

  it("prunes a finished job once it's older than the retention window, but keeps it while fresh", () => {
    vi.useFakeTimers();
    try {
      const id = startBackgroundJob("scan", "test-prune", "Scan — Test Prune");
      finishBackgroundJob(id);
      expect(listBackgroundJobs().some((j) => j.id === id)).toBe(true);
      vi.advanceTimersByTime(59_000);
      expect(listBackgroundJobs().some((j) => j.id === id)).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(listBackgroundJobs().some((j) => j.id === id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never prunes a still-running job regardless of age", () => {
    vi.useFakeTimers();
    try {
      const id = startBackgroundJob("matchProviders", "test-never-prune-running", "Match — Test Never Prune");
      vi.advanceTimersByTime(10 * 60_000);
      expect(listBackgroundJobs().some((j) => j.id === id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
