import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

const queryAi = vi.fn(async () => "Mocked Reply");
vi.mock("../src/services/aiClient.js", () => ({
  queryAi: (...args: unknown[]) => queryAi(...args),
}));

type ExecFileCallback = (err: (Error & { stderr?: string }) | null, result?: { stdout: string; stderr: string }) => void;
let execFileBehavior: "real-binaries-absent" | "ffprobe-duration" | "ffmpeg-frame" | "ffprobe-tags" = "real-binaries-absent";

vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    if (execFileBehavior === "real-binaries-absent") {
      callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }));
      return;
    }
    if (file === "ffprobe" && execFileBehavior === "ffprobe-duration") {
      callback(null, { stdout: JSON.stringify({ format: { duration: "120.5" } }), stderr: "" });
      return;
    }
    if (file === "ffmpeg" && execFileBehavior === "ffmpeg-frame") {
      const tmpFile = args[args.length - 1];
      fs.writeFileSync(tmpFile, Buffer.from("fake-png-bytes"));
      callback(null, { stdout: "", stderr: "" });
      return;
    }
    if (file === "ffprobe" && execFileBehavior === "ffprobe-tags") {
      callback(null, { stdout: JSON.stringify({ format: { tags: { artist: "Test Artist", title: "Test Track" } } }), stderr: "" });
      return;
    }
    callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }));
  },
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let identifyMediaFile: (typeof import("../src/services/aiIdentify.js"))["identifyMediaFile"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ identifyMediaFile } = await import("../src/services/aiIdentify.js"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-aiidentify-"));
});

afterEach(async () => {
  execFileBehavior = "real-binaries-absent";
  queryAi.mockClear();
  queryAi.mockResolvedValue("Mocked Reply");
  await db.prepare("DELETE FROM ai_providers").run();
});

async function insertProvider(overrides: Record<string, unknown> = {}): Promise<number> {
  const { name = "Test Provider", type = "cloud", baseUrl = "https://api.example.com", apiKey = "key", model = "gpt-test", enabled = 1, isDefault = 1 } = overrides;
  return Number(
    (
      await db
        .prepare("INSERT INTO ai_providers (name, type, base_url, api_key, model, enabled, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(name, type, baseUrl, apiKey, model, enabled, isDefault)
    ).lastInsertRowid
  );
}

function realFile(name: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, "x");
  return p;
}

describe("identifyMediaFile — provider selection", () => {
  it("throws when no AI provider is configured at all", async () => {
    await expect(identifyMediaFile(realFile("no-provider.mkv"), "movie")).rejects.toThrow(/No enabled AI provider/);
  });

  it("throws when a specific requested provider id doesn't exist or is disabled", async () => {
    const id = await insertProvider({ enabled: 0 });
    await expect(identifyMediaFile(realFile("disabled-provider.mkv"), "movie", id)).rejects.toThrow(/No enabled AI provider/);
  });

  it("uses the default provider when no specific id is requested", async () => {
    await insertProvider({ model: "default-model", isDefault: 1 });
    await insertProvider({ name: "Non Default", model: "other-model", isDefault: 0 });

    await identifyMediaFile(realFile("default-provider.mkv"), "movie");

    expect(queryAi.mock.calls[0][0]).toMatchObject({ model: "default-model" });
  });

  it("uses the specifically requested provider even when it isn't the default", async () => {
    await insertProvider({ model: "default-model", isDefault: 1 });
    const otherId = await insertProvider({ name: "Non Default", model: "other-model", isDefault: 0 });

    await identifyMediaFile(realFile("specific-provider.pdf"), "book", otherId);

    expect(queryAi.mock.calls[0][0]).toMatchObject({ model: "other-model" });
  });
});

describe("identifyMediaFile — filename-only fallback", () => {
  it("falls back to a filename-only prompt for a video file when frame extraction fails", async () => {
    await insertProvider();
    execFileBehavior = "real-binaries-absent"; // no ffmpeg/ffprobe in this environment
    queryAi.mockResolvedValueOnce("  The Movie (2020)  ");

    const result = await identifyMediaFile(realFile("The Movie 2020.mkv"), "movie");

    expect(result).toEqual({ guess: "The Movie (2020)", usedFrame: false, usedTags: false });
    expect(queryAi.mock.calls[0][1]).toContain("no other information is available");
    expect(queryAi.mock.calls[0][1]).toContain("The Movie 2020.mkv");
  });

  it("falls back to a filename-only prompt for an audio file with no embedded tags", async () => {
    await insertProvider();
    execFileBehavior = "real-binaries-absent";

    const result = await identifyMediaFile(realFile("Some Track.mp3"), "audiobook");

    expect(result.usedTags).toBe(false);
    expect(result.usedFrame).toBe(false);
  });

  it("goes straight to the filename-only prompt for a non-video/audio file type", async () => {
    await insertProvider();

    const result = await identifyMediaFile(realFile("Some Book.epub"), "book");

    expect(result.usedFrame).toBe(false);
    expect(result.usedTags).toBe(false);
    expect(queryAi.mock.calls[0][1]).toContain("book file is named");
  });
});

describe("identifyMediaFile — frame/tag extraction succeeding", () => {
  it("sends a vision prompt with the extracted frame when frame extraction succeeds", async () => {
    await insertProvider();
    execFileBehavior = "ffmpeg-frame"; // duration probe still fails, frame extraction succeeds with the 60s fallback seek

    const result = await identifyMediaFile(realFile("Vision Test.mkv"), "movie");

    expect(result.usedFrame).toBe(true);
    expect(result.usedTags).toBe(false);
    const [, prompt, image] = queryAi.mock.calls[0];
    expect(prompt).toContain("single frame extracted");
    expect(image).toBe(Buffer.from("fake-png-bytes").toString("base64"));
  });

  it("sends a tags-based prompt when the audio file has embedded metadata", async () => {
    await insertProvider();
    execFileBehavior = "ffprobe-tags";

    const result = await identifyMediaFile(realFile("Tagged Track.mp3"), "audiobook");

    expect(result.usedTags).toBe(true);
    expect(result.usedFrame).toBe(false);
    expect(queryAi.mock.calls[0][1]).toContain("artist: Test Artist");
    expect(queryAi.mock.calls[0][1]).toContain("title: Test Track");
  });
});
