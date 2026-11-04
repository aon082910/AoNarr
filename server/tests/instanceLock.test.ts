import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  startInstanceHeartbeat,
  HEARTBEAT_MS,
  LOCK_FILE_NAME,
  OBSERVE_MS,
  type LockRecord,
} from "../src/services/instanceLock.js";

let dir: string;
let lockFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-lock-"));
  lockFile = path.join(dir, LOCK_FILE_NAME);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

/** A clock the lock code reads through its `now` option, moved only by the `sleep` option. */
function fakeClock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function writeLockFile(record: Partial<LockRecord> & { at: number }): void {
  fs.writeFileSync(lockFile, JSON.stringify({ id: "holder", pid: 4321, host: "some-other-host", ...record }));
}

function readLockFile(): LockRecord {
  return JSON.parse(fs.readFileSync(lockFile, "utf-8")) as LockRecord;
}

describe("acquireInstanceLock", () => {
  it("takes a free lock and records who holds it, without leaving a temp file behind", () => {
    const clock = fakeClock();

    const result = acquireInstanceLock(dir, { instanceId: "first", now: clock.now });

    expect(result).toEqual({ ok: true, id: "first" });
    expect(readLockFile()).toEqual({ id: "first", pid: process.pid, host: os.hostname(), at: NOW });
    expect(fs.readdirSync(dir)).toEqual([LOCK_FILE_NAME]);
  });

  it("makes up an instance id when none is given", () => {
    const result = acquireInstanceLock(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id.length).toBeGreaterThan(8);
    expect(readLockFile().id).toBe(result.id);
  });

  it("refuses to start while the holder is alive, and names it", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW });
    const sleep = vi.fn((ms: number) => {
      clock.advance(ms);
      writeLockFile({ at: clock.now() }); // the holder's heartbeat
    });

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

    expect(result).toEqual({ ok: false, holder: { id: "holder", pid: 4321, host: "some-other-host", at: NOW + 1000 } });
    expect(sleep).toHaveBeenCalledTimes(1); // it needed one beat to see the holder move
    expect(readLockFile().id).toBe("holder"); // the newcomer did not write its own lock
  });

  it("names a holder that was replaced by another instance while it was watching", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW });
    const sleep = (ms: number) => {
      clock.advance(ms);
      writeLockFile({ id: "someone-else", pid: 99, at: clock.now() });
    };

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

    expect(result).toMatchObject({ ok: false, holder: { id: "someone-else", pid: 99 } });
  });

  it("takes the lock over when the holder's heartbeat does not move for one observation window", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW });
    const sleep = vi.fn((ms: number) => clock.advance(ms));

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

    expect(result).toEqual({ ok: true, id: "newcomer" });
    expect(clock.now() - NOW).toBeGreaterThanOrEqual(OBSERVE_MS); // waited about one heartbeat and a margin
    expect(clock.now() - NOW).toBeLessThan(OBSERVE_MS + 1000);
    expect(readLockFile()).toMatchObject({ id: "newcomer", pid: process.pid });
  });

  it("honors a shorter observation window and poll interval", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW });
    const sleep = vi.fn((ms: number) => clock.advance(ms));

    acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, observeMs: 3000, pollMs: 500 });

    expect(sleep).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("stops waiting as soon as the holder removes its lock", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW });
    const sleep = vi.fn((ms: number) => {
      clock.advance(ms);
      fs.rmSync(lockFile); // a clean exit
    });

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

    expect(result).toEqual({ ok: true, id: "newcomer" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(readLockFile().id).toBe("newcomer");
  });

  it("does not wait on a lock that is more than three heartbeats old", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW - 3 * HEARTBEAT_MS - 1 });
    const sleep = vi.fn();

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

    expect(result).toEqual({ ok: true, id: "newcomer" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("still waits on a lock that is just under three heartbeats old", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW - 3 * HEARTBEAT_MS + 1 });
    const sleep = vi.fn((ms: number) => clock.advance(ms));

    acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, observeMs: 1000, pollMs: 1000 });

    expect(sleep).toHaveBeenCalledTimes(1);
  });

  describe("a holder on this host", () => {
    it("is taken over at once when its process no longer exists", () => {
      const clock = fakeClock();
      writeLockFile({ at: NOW, host: os.hostname(), pid: 4321 });
      const sleep = vi.fn();
      const isProcessAlive = vi.fn(() => false);

      const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, isProcessAlive });

      expect(result).toEqual({ ok: true, id: "newcomer" });
      expect(isProcessAlive).toHaveBeenCalledWith(4321);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("is taken over at once when the process id it recorded belongs to a process that has exited (the real check)", () => {
      const finished = spawnSync(process.execPath, ["-e", "0"]);
      expect(finished.pid).toBeGreaterThan(0);
      const clock = fakeClock(Date.now());
      writeLockFile({ at: clock.now(), host: os.hostname(), pid: finished.pid });
      const sleep = vi.fn();

      const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep });

      expect(result).toEqual({ ok: true, id: "newcomer" });
      expect(sleep).not.toHaveBeenCalled();
    });

    it("is waited for while its process is alive", () => {
      const clock = fakeClock();
      writeLockFile({ at: NOW, host: os.hostname(), pid: 4321 });
      const sleep = vi.fn((ms: number) => {
        clock.advance(ms);
        writeLockFile({ at: clock.now(), host: os.hostname(), pid: 4321 });
      });

      const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, isProcessAlive: () => true });

      expect(result).toMatchObject({ ok: false, holder: { id: "holder", pid: 4321 } });
      expect(sleep).toHaveBeenCalled();
    });

    it("is waited for while a real process with the recorded id is running (the real check)", () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      try {
        expect(child.pid).toBeGreaterThan(0);
        const clock = fakeClock();
        writeLockFile({ at: NOW, host: os.hostname(), pid: child.pid });
        const sleep = vi.fn((ms: number) => clock.advance(ms));

        acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, observeMs: 2000, pollMs: 1000 });

        expect(sleep).toHaveBeenCalledTimes(2); // it did not treat a live process as gone
      } finally {
        child.kill();
      }
    });

    it("is taken over at once when the leftover carries our own process id, as after a container restart", () => {
      const clock = fakeClock();
      writeLockFile({ at: NOW, host: os.hostname(), pid: process.pid, id: "previous-run" });
      const sleep = vi.fn();

      const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, isProcessAlive: () => true });

      expect(result).toEqual({ ok: true, id: "newcomer" });
      expect(sleep).not.toHaveBeenCalled();
    });

    it("is waited for when the lock records no process id at all", () => {
      const clock = fakeClock();
      writeLockFile({ at: NOW, host: os.hostname(), pid: 0 });
      const sleep = vi.fn((ms: number) => clock.advance(ms));

      acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, observeMs: 1000, pollMs: 1000, isProcessAlive: () => false });

      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });

  it("does not take a process id that is missing here for proof that a holder on another host is gone", () => {
    const clock = fakeClock();
    writeLockFile({ at: NOW, host: "another-host", pid: 4321 });
    const sleep = vi.fn((ms: number) => clock.advance(ms));
    const isProcessAlive = vi.fn(() => false);

    acquireInstanceLock(dir, { instanceId: "newcomer", now: clock.now, sleep, observeMs: 1000, pollMs: 1000, isProcessAlive });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it("does not wait on a lock that is already its own instance's", () => {
    const clock = fakeClock();
    acquireInstanceLock(dir, { instanceId: "same", now: clock.now });
    clock.advance(5000);
    const sleep = vi.fn();

    const again = acquireInstanceLock(dir, { instanceId: "same", now: clock.now, sleep });

    expect(again).toEqual({ ok: true, id: "same" });
    expect(sleep).not.toHaveBeenCalled();
    expect(readLockFile().at).toBe(NOW + 5000);
  });

  it.each([
    ["text that is not JSON", "not json at all"],
    ["an empty file", ""],
    ["a record with no time", JSON.stringify({ id: "holder", pid: 1, host: "h" })],
    ["a record with no id", JSON.stringify({ at: NOW, pid: 1, host: "h" })],
    ["a record whose time is a string", JSON.stringify({ id: "holder", at: "yesterday" })],
  ])("treats %s as no lock", (_label, content) => {
    fs.writeFileSync(lockFile, content);
    const sleep = vi.fn();

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", now: () => NOW, sleep });

    expect(result).toEqual({ ok: true, id: "newcomer" });
    expect(sleep).not.toHaveBeenCalled();
    expect(readLockFile().id).toBe("newcomer");
  });

  it("really waits (a blocking sleep) when no sleep is injected", () => {
    writeLockFile({ at: Date.now() });
    const started = Date.now();

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", observeMs: 60, pollMs: 20 });

    expect(result).toEqual({ ok: true, id: "newcomer" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

describe("releaseInstanceLock", () => {
  it("removes the lock when it is still ours", () => {
    acquireInstanceLock(dir, { instanceId: "mine" });

    releaseInstanceLock(dir, "mine");

    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("leaves another instance's lock alone", () => {
    writeLockFile({ at: NOW, id: "theirs" });

    releaseInstanceLock(dir, "mine");

    expect(readLockFile().id).toBe("theirs");
  });

  it("does nothing, and does not throw, when there is no lock", () => {
    expect(() => releaseInstanceLock(dir, "mine")).not.toThrow();
    expect(() => releaseInstanceLock(path.join(dir, "missing-folder"), "mine")).not.toThrow();
  });

  it("lets the next start take the lock at once without waiting", () => {
    acquireInstanceLock(dir, { instanceId: "first" });
    releaseInstanceLock(dir, "first");
    const sleep = vi.fn();

    const result = acquireInstanceLock(dir, { instanceId: "second", sleep });

    expect(result).toEqual({ ok: true, id: "second" });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("startInstanceHeartbeat", () => {
  const T0 = 1_900_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
  });

  it("rewrites the lock with the current time on every beat, and stops when told to", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    const onLost = vi.fn();

    const stop = startInstanceHeartbeat(dir, "mine", onLost, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readLockFile()).toEqual({ id: "mine", pid: process.pid, host: os.hostname(), at: T0 + 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(readLockFile().at).toBe(T0 + 3000);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readLockFile().at).toBe(T0 + 3000);
    expect(onLost).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([LOCK_FILE_NAME]);
  });

  it("beats every HEARTBEAT_MS when no interval is given", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    startInstanceHeartbeat(dir, "mine", vi.fn());

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(readLockFile().at).toBe(T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(readLockFile().at).toBe(T0 + HEARTBEAT_MS);
  });

  it("keeps a heartbeating instance visible to a newcomer, who then refuses to start", () => {
    // The running instance wrote its lock from another host; its heartbeat rewrites it on every beat.
    writeLockFile({ id: "running", at: T0 });
    startInstanceHeartbeat(dir, "running", vi.fn(), 1000);
    // The newcomer watches the file; each poll lets one heartbeat go by.
    const sleep = (ms: number) => {
      vi.advanceTimersByTime(ms);
    };

    const result = acquireInstanceLock(dir, { instanceId: "newcomer", sleep, pollMs: 1000, observeMs: 5000 });

    expect(result).toEqual({ ok: false, holder: { id: "running", pid: process.pid, host: os.hostname(), at: T0 + 1000 } });
  });

  it("calls onLost with the instance that took the lock over, and does not overwrite its lock", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    const onLost = vi.fn();
    startInstanceHeartbeat(dir, "mine", onLost, 1000);
    writeLockFile({ id: "usurper", pid: 77, host: "usurper-host", at: T0 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith({ id: "usurper", pid: 77, host: "usurper-host", at: T0 });
    expect(readLockFile()).toEqual({ id: "usurper", pid: 77, host: "usurper-host", at: T0 });
  });

  it("does not call onLost while the lock is ours", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    const onLost = vi.fn();
    startInstanceHeartbeat(dir, "mine", onLost, 1000);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(onLost).not.toHaveBeenCalled();
  });

  it("writes the lock again when the file has disappeared, without reporting a loss", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    const onLost = vi.fn();
    startInstanceHeartbeat(dir, "mine", onLost, 1000);
    fs.rmSync(lockFile);

    await vi.advanceTimersByTimeAsync(1000);

    expect(readLockFile()).toMatchObject({ id: "mine", at: T0 + 1000 });
    expect(onLost).not.toHaveBeenCalled();
  });

  it("carries on when the config folder cannot be written, and recovers when it can again", async () => {
    acquireInstanceLock(dir, { instanceId: "mine" });
    const onLost = vi.fn();
    startInstanceHeartbeat(dir, "mine", onLost, 1000);
    fs.rmSync(dir, { recursive: true, force: true });

    await expect(vi.advanceTimersByTimeAsync(3000)).resolves.toBeDefined(); // no throw out of the timer
    expect(onLost).not.toHaveBeenCalled();

    fs.mkdirSync(dir, { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(readLockFile()).toMatchObject({ id: "mine", at: T0 + 4000 });
  });
});
