import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import {
  IMPORT_TAG_LIMITS,
  isAudioFileLocked,
  lockAudioFile,
  lockAudioFiles,
  resetAudioFileLocksForTests,
  runWithin,
  tryLockAudioFile,
  unlockAudioFile,
} from "../src/services/audioFileLock.js";

afterEach(() => {
  resetAudioFileLocksForTests();
});

const a = path.join("music", "Artist", "Album", "01 - One.mp3");
const b = path.join("music", "Artist", "Album", "02 - Two.mp3");
const c = path.join("music", "Artist", "Album", "03 - Three.mp3");

describe("the per-file lock", () => {
  it("is taken by one holder at a time, whichever way the path is written", () => {
    expect(tryLockAudioFile(a)).toBe(true);
    expect(tryLockAudioFile(a)).toBe(false);
    expect(tryLockAudioFile(path.join("music", "Artist", "Album", "..", "Album", "01 - One.mp3"))).toBe(false);
    expect(isAudioFileLocked(a)).toBe(true);
    expect(tryLockAudioFile(b)).toBe(true);
    unlockAudioFile(a);
    expect(isAudioFileLocked(a)).toBe(false);
    expect(tryLockAudioFile(a)).toBe(true);
  });

  it("an unlock of a file nobody holds does nothing", () => {
    unlockAudioFile(a);
    expect(isAudioFileLocked(a)).toBe(false);
  });

  it("a waiter gets the lock the moment the holder gives it back, in the order they asked", async () => {
    tryLockAudioFile(a);
    const order: string[] = [];
    const first = lockAudioFile(a, 5_000).then((got) => order.push(`first:${got}`));
    const second = lockAudioFile(a, 5_000).then((got) => order.push(`second:${got}`));
    // Never free in between: a caller that does not wait cannot take it from under the first waiter.
    unlockAudioFile(a);
    expect(tryLockAudioFile(a)).toBe(false);
    await first;
    expect(order).toEqual(["first:true"]);
    unlockAudioFile(a);
    await second;
    expect(order).toEqual(["first:true", "second:true"]);
    unlockAudioFile(a);
    expect(isAudioFileLocked(a)).toBe(false);
  });

  it("gives up after the time it was given, leaving the holder's lock as it was", async () => {
    tryLockAudioFile(a);
    const started = Date.now();
    expect(await lockAudioFile(a, 60)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(isAudioFileLocked(a)).toBe(true);
    // A caller that does not want to wait does not.
    expect(await lockAudioFile(a, 0)).toBe(false);
    // The timed-out waiter is gone: giving the lock back frees it.
    unlockAudioFile(a);
    expect(isAudioFileLocked(a)).toBe(false);
  });

  it("takes all of a set of files or none, and gives them back one by one or together", async () => {
    tryLockAudioFile(c);
    expect(await lockAudioFiles([a, b, c], 40)).toBeNull();
    // The two it got on the way were given back.
    expect(isAudioFileLocked(a)).toBe(false);
    expect(isAudioFileLocked(b)).toBe(false);
    unlockAudioFile(c);

    const held = await lockAudioFiles([a, b, c, a], 1_000);
    expect(held).not.toBeNull();
    expect([a, b, c].map(isAudioFileLocked)).toEqual([true, true, true]);
    held!.release(b);
    held!.release(b);
    expect([a, b, c].map(isAudioFileLocked)).toEqual([true, false, true]);
    held!.releaseAll();
    expect([a, b, c].map(isAudioFileLocked)).toEqual([false, false, false]);
  });

  it("waits for the holder of one of the files, up to the total time", async () => {
    tryLockAudioFile(b);
    setTimeout(() => unlockAudioFile(b), 40);
    const held = await lockAudioFiles([a, b], 2_000);
    expect(held).not.toBeNull();
    held!.releaseAll();
  });

  it("keeps the limits an import works to", () => {
    expect(IMPORT_TAG_LIMITS.lockWaitMs).toBe(60_000);
    // An import is never held up by one file's tags for more than two minutes.
    expect(IMPORT_TAG_LIMITS.fileTimeoutMs).toBe(120_000);
  });
});

describe("running work within a time", () => {
  it("answers with the work's result when it is in time", async () => {
    expect(await runWithin(1_000, async () => "done")).toBe("done");
  });

  it("answers null at the deadline, aborting the signal the work was given, and ignores its later failure", async () => {
    let signal!: AbortSignal;
    const started = Date.now();
    const result = await runWithin(40, (s) => {
      signal = s;
      return new Promise<string>((_, reject) => s.addEventListener("abort", () => setTimeout(() => reject(new Error("late failure")), 10)));
    });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal.aborted).toBe(true);
    // The late rejection must not surface as an unhandled one.
    await new Promise((r) => setTimeout(r, 40));
  });
});
