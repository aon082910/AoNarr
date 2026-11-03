import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageTimeoutError, createYielder, pathExistsAsync, resetFsAsyncStateForTests, statfsAsync } from "../src/services/fsAsync.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetFsAsyncStateForTests();
});

describe("pathExistsAsync (RB1, RB11)", () => {
  it("answers true for a file and false for a missing one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-fsasync-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    expect(await pathExistsAsync(file)).toBe(true);
    expect(await pathExistsAsync(path.join(dir, "missing.txt"))).toBe(false);
  });

  it("throws StorageTimeoutError, not 'missing', when the mount never answers", async () => {
    vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));
    await expect(pathExistsAsync("/mnt/dead/first.mkv", 30)).rejects.toBeInstanceOf(StorageTimeoutError);
  });

  it("does not leave the event loop blocked while it waits on a hung call", async () => {
    vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    await expect(pathExistsAsync("/mnt/dead/other.mkv", 80)).rejects.toThrow(/did not answer/);
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(0);
  });

  it("never issues the same call twice while one is still pending, so a dead mount holds one thread, not one per request", async () => {
    const access = vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));
    const first = pathExistsAsync("/mnt/dead/same.mkv", 200);
    const second = pathExistsAsync("/mnt/dead/same.mkv", 200);
    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(StorageTimeoutError);
    expect(access).toHaveBeenCalledTimes(1);
  });

  it("fails at once for a minute after a timeout instead of taking another thread", async () => {
    const access = vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));
    await expect(pathExistsAsync("/mnt/dead/again.mkv", 30)).rejects.toBeInstanceOf(StorageTimeoutError);
    const started = performance.now();
    await expect(pathExistsAsync("/mnt/dead/again.mkv", 5000)).rejects.toBeInstanceOf(StorageTimeoutError);
    expect(performance.now() - started).toBeLessThan(100);
    expect(access).toHaveBeenCalledTimes(1);
  });

  it("recovers after the remembered timeout has passed", async () => {
    vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));
    await expect(pathExistsAsync("/mnt/dead/back.mkv", 20)).rejects.toBeInstanceOf(StorageTimeoutError);
    vi.restoreAllMocks();
    const real = fs.promises.access;
    vi.spyOn(fs.promises, "access").mockImplementation(((...args: unknown[]) => (real as any)(...args)) as any);
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await pathExistsAsync(os.tmpdir(), 1000)).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe("statfsAsync", () => {
  it("returns the filesystem numbers for a real folder, and null for one that does not exist", async () => {
    const stat = await statfsAsync(os.tmpdir());
    expect(stat && stat.bsize).toBeGreaterThan(0);
    expect(await statfsAsync(path.join(os.tmpdir(), "aonarr-definitely-missing-folder"))).toBeNull();
  });

  it("throws StorageTimeoutError on a call that hangs", async () => {
    vi.spyOn(fs.promises, "statfs").mockImplementation(() => new Promise(() => {}));
    await expect(statfsAsync("/mnt/dead-statfs", 30)).rejects.toBeInstanceOf(StorageTimeoutError);
  });
});

describe("createYielder", () => {
  it("lets timers run during a loop of same-tick awaits that would otherwise starve them", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 2);
    const tick = createYielder(5);
    const stop = performance.now() + 60;
    // Every await here resolves in the same tick, like the SQLite wrapper's; only the yielder gives timers a turn.
    while (performance.now() < stop) {
      await Promise.resolve();
      await tick();
    }
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(0);
  });

  it("does nothing between slices, so a short loop pays no setImmediate per iteration", async () => {
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
    const tick = createYielder(10_000);
    for (let i = 0; i < 1000; i++) await tick();
    expect(setImmediateSpy).not.toHaveBeenCalled();
  });
});
