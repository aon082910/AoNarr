import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

type ExecFileCallback = (err: (Error & { stderr?: string }) | null, result?: { stdout: string; stderr: string }) => void;

let execFileBehavior: "success" | "failure" = "success";

vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    if (execFileBehavior === "success") {
      // Simulate ffsubsync actually writing its output file before exiting 0 — the "-o" flag's
      // value is the temp path syncSubtitleToVideo will try to rename from.
      const outIndex = args.indexOf("-o");
      fs.writeFileSync(args[outIndex + 1], "synced subtitle content");
      callback(null, { stdout: "", stderr: "" });
    } else {
      callback(Object.assign(new Error("ffsubsync exited 1"), { stderr: "no speech detected" }));
    }
  },
}));

let syncSubtitleToVideo: (typeof import("../src/services/subtitleSync.js"))["syncSubtitleToVideo"];
let tmpDir: string;

beforeAll(async () => {
  // subtitleSync.ts imports logger.js, whose LOG_DIR is computed from config.js's configDir at
  // first import — like every DB/config-touching module in this suite, it must load only after
  // setupTestDb() has set the env vars those modules read.
  await setupTestDb();
  ({ syncSubtitleToVideo } = await import("../src/services/subtitleSync.js"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-subsync-"));
});

afterEach(() => {
  execFileBehavior = "success";
});

describe("syncSubtitleToVideo", () => {
  it("replaces the subtitle with the synced output and returns true on success", async () => {
    execFileBehavior = "success";
    const subtitlePath = path.join(tmpDir, "success.srt");
    fs.writeFileSync(subtitlePath, "original unsynced content");

    const result = await syncSubtitleToVideo("/fake/video.mkv", subtitlePath);

    expect(result).toBe(true);
    expect(fs.readFileSync(subtitlePath, "utf-8")).toBe("synced subtitle content");
    expect(fs.existsSync(`${subtitlePath}.sync-tmp.srt`)).toBe(false); // renamed away, not left behind
  });

  it("leaves the original subtitle untouched and returns false when ffsubsync fails", async () => {
    execFileBehavior = "failure";
    const subtitlePath = path.join(tmpDir, "failure.srt");
    fs.writeFileSync(subtitlePath, "original content that must survive");

    const result = await syncSubtitleToVideo("/fake/video.mkv", subtitlePath);

    expect(result).toBe(false);
    expect(fs.readFileSync(subtitlePath, "utf-8")).toBe("original content that must survive");
  });

  it("never throws even when ffsubsync fails", async () => {
    execFileBehavior = "failure";
    const subtitlePath = path.join(tmpDir, "never-throws.srt");
    fs.writeFileSync(subtitlePath, "content");

    await expect(syncSubtitleToVideo("/fake/video.mkv", subtitlePath)).resolves.toBe(false);
  });

  it("doesn't leave a stray temp file behind after a failed sync", async () => {
    execFileBehavior = "failure";
    const subtitlePath = path.join(tmpDir, "no-stray-temp.srt");
    fs.writeFileSync(subtitlePath, "content");

    await syncSubtitleToVideo("/fake/video.mkv", subtitlePath);

    expect(fs.existsSync(`${subtitlePath}.sync-tmp.srt`)).toBe(false);
  });
});
