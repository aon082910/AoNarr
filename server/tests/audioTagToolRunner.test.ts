import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tool runner against a stand-in for child_process: what happens to a run when the process will not die.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { KILL_GRACE_MS, defaultToolRunner } from "../src/services/audioTagFfmpeg.js";
import { writeAudioTags } from "../src/services/audioTagWriter.js";
import type { ToolRunner } from "../src/services/audioTagCommon.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-toolrunner-"));
});

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

/** A process that ignores SIGKILL unless it is `dies` (a process stuck in I/O on a share that went away). */
function fakeChild(options: { dies?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => {
    if (options.dies) setImmediate(() => child.emit("close", null));
    return true;
  });
  return child;
}

describe("a tool run that is killed", () => {
  it("is settled with a clear error when the process does not die within the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const outcome = defaultToolRunner("ffmpeg", ["-i", "x"], { timeoutMs: 1_000 }).then(
      (value) => ({ value }),
      (error: Error) => ({ error })
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    // Not settled yet: a process killed a moment ago may still be on its way out.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await outcome;
    expect(result).toHaveProperty("error");
    expect((result as { error: Error }).error.message).toMatch(/ffmpeg did not stop 5 s after it was killed \(process 4242\)/);
    // And a late close does nothing: the run is over.
    child.emit("close", null);
  });

  it("is settled by an abort the same way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    const outcome = defaultToolRunner("ffprobe", [], { timeoutMs: 60_000, signal: controller.signal }).then(
      (value) => ({ value }),
      (error: Error) => ({ error })
    );

    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);

    expect(((await outcome) as { error: Error }).error.message).toMatch(/ffprobe did not stop/);
  });

  it("still reports an ordinary timeout as a timeout when the process does die", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = fakeChild({ dies: true });
    spawnMock.mockReturnValue(child);
    const outcome = defaultToolRunner("ffmpeg", [], { timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({ code: null, timedOut: true, aborted: false });
    // The grace timer was cleared with the run: nothing is left waiting.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hold on to a slot: tagging goes on after two hung files", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = [path.join(dir, "hung-1.flac"), path.join(dir, "hung-2.flac")];
    for (const file of hung) fs.writeFileSync(file, Buffer.alloc(2048, 7));
    spawnMock.mockImplementation(() => fakeChild());
    const info = { title: "Song", artist: "Artist", album: "Album" };

    // Both slots are taken by an ffprobe that never answers and cannot be killed.
    const stuck = hung.map((file) => writeAudioTags(file, info));
    // Until both have started their ffprobe (file system calls take real time, the clock is only moved by the test).
    while (spawnMock.mock.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(60_000 + KILL_GRACE_MS);
    const results = await Promise.all(stuck);

    for (const result of results) {
      expect(result.outcome).toBe("failed");
      expect(result.reason).toMatch(/ffprobe did not stop/);
    }
    // A third file gets a slot at once.
    const third = path.join(dir, "third.flac");
    fs.writeFileSync(third, Buffer.alloc(2048, 7));
    const runner: ToolRunner = async (tool, args) => {
      if (tool === "ffprobe") {
        const tags = args[args.length - 1] === third ? {} : { title: "Song", artist: "Artist", album: "Album" };
        return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "flac" }], format: { duration: "10", tags } }), stderr: "", timedOut: false, aborted: false };
      }
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(2048, 1));
      return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
    };
    expect(await writeAudioTags(third, info, { runner })).toMatchObject({ outcome: "written" });
    for (const file of hung) expect(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(".aonarr-tmp-"))).toEqual([]);
  });
});
