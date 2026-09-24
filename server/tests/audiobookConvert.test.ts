import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

const probeDurationSeconds = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeDurationSeconds: (...args: unknown[]) => probeDurationSeconds(...args),
}));

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
let ffmpegShouldFail = false;
const ffmpegCalls: string[][] = [];
// The chapter file is deleted as soon as ffmpeg returns, so its content is captured mid-call.
const chapterMetadata: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    ffmpegCalls.push(args);
    const metaPath = args.find((a) => a.includes(".aonarr-chapters-"));
    if (metaPath) chapterMetadata.push(fs.readFileSync(metaPath, "utf-8"));
    if (ffmpegShouldFail) {
      callback(new Error("ffmpeg merge failed"));
      return;
    }
    callback(null, { stdout: "", stderr: "" });
  },
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let convertSubItemToM4b: (typeof import("../src/services/audiobookConvert.js"))["convertSubItemToM4b"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ convertSubItemToM4b } = await import("../src/services/audiobookConvert.js"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-audiobookconvert-"));
});

afterEach(() => {
  ffmpegShouldFail = false;
  ffmpegCalls.length = 0;
  chapterMetadata.length = 0;
  probeDurationSeconds.mockReset();
  probeDurationSeconds.mockResolvedValue(60);
});

async function insertAuthorAndBook(title: string, bookDir: string): Promise<number> {
  const authorId = Number(
    (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Test Author', 'test author', 1, 1, 'unknown')`).run())
      .lastInsertRowid
  );
  return Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, ?, 1, 1, ?)")
        .run(authorId, title, bookDir)
    ).lastInsertRowid
  );
}

async function insertTrack(subItemId: number, trackNumber: number, title: string, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, ?, ?, 1, ?)")
        .run(subItemId, trackNumber, title, filePath)
    ).lastInsertRowid
  );
}

function bookDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function realTrackFile(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "fake audio bytes");
  return p;
}

describe("convertSubItemToM4b — validation", () => {
  it("throws when the sub-item doesn't exist", async () => {
    await expect(convertSubItemToM4b(999999)).rejects.toThrow(/Sub-item not found/);
  });

  it("throws when the sub-item has no downloaded folder", async () => {
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'A', 'a', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    const subId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'No Folder Book', 1, 0)").run(authorId))
        .lastInsertRowid
    );

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/no downloaded folder/);
  });

  it("throws when fewer than 2 tracks have a file", async () => {
    const dir = bookDir("one-track-book");
    const subId = await insertAuthorAndBook("One Track Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/at least 2 downloaded tracks/);
  });

  it("throws when a track's file is missing on disk", async () => {
    const dir = bookDir("missing-track-book");
    const subId = await insertAuthorAndBook("Missing Track Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", path.join(dir, "02-does-not-exist.mp3"));

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/Track file missing on disk/);
  });

  it("throws when ffprobe can't read a track's duration", async () => {
    const dir = bookDir("no-duration-book");
    const subId = await insertAuthorAndBook("No Duration Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));
    probeDurationSeconds.mockResolvedValueOnce(60).mockResolvedValueOnce(null);

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/Couldn't read duration/);
  });

  it("throws when the computed output path collides with a source track", async () => {
    const dir = bookDir("Collision Book"); // safeFileName(title) will produce "Collision Book", matching the dir name
    const subId = await insertAuthorAndBook("Collision Book", dir);
    // Force a collision: a "track" that happens to already be named exactly like the eventual output.
    await insertTrack(subId, 1, "Chapter 1", path.join(dir, "Collision Book.m4b"));
    fs.writeFileSync(path.join(dir, "Collision Book.m4b"), "x");
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/collides with one of the source track files/);
  });
});

describe("convertSubItemToM4b — success", () => {
  it("merges tracks into one m4b, replacing the track rows and deleting the source files", async () => {
    const dir = bookDir("merge-success-book");
    const subId = await insertAuthorAndBook("Merge Success Book", dir);
    const track1Path = realTrackFile(dir, "01.mp3");
    const track2Path = realTrackFile(dir, "02.mp3");
    await insertTrack(subId, 1, "Chapter 1", track1Path);
    await insertTrack(subId, 2, "Chapter 2", track2Path);
    probeDurationSeconds.mockResolvedValueOnce(60).mockResolvedValueOnce(90);

    const result = await convertSubItemToM4b(subId);

    expect(result.path).toBe(path.join(dir, "Merge Success Book.m4b"));
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(subId)) as any[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0].track_number).toBe(1);
    expect(tracks[0].file_path).toBe(result.path);
    expect(tracks[0].duration_seconds).toBe(150); // 60 + 90
    expect(fs.existsSync(track1Path)).toBe(false);
    expect(fs.existsSync(track2Path)).toBe(false);
  });

  it("passes both input tracks and a chapter metadata file to ffmpeg", async () => {
    const dir = bookDir("ffmpeg-args-book");
    const subId = await insertAuthorAndBook("Ffmpeg Args Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));

    await convertSubItemToM4b(subId);

    expect(ffmpegCalls).toHaveLength(1);
    const args = ffmpegCalls[0];
    expect(args).toContain(path.join(dir, "01.mp3"));
    expect(args).toContain(path.join(dir, "02.mp3"));
    expect(args.some((a) => a.includes("concat=n=2"))).toBe(true);
  });

  it("places chapter markers from the exact (fractional) track durations, without cumulative drift", async () => {
    const dir = bookDir("fractional-chapters-book");
    const subId = await insertAuthorAndBook("Fractional Chapters Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));
    await insertTrack(subId, 3, "Chapter 3", realTrackFile(dir, "03.mp3"));
    // Whole-second rounding would have made these 300/300/0 — shifting chapter 3 by 800ms and
    // rejecting the sub-half-second last track outright.
    probeDurationSeconds.mockResolvedValueOnce(300.4).mockResolvedValueOnce(300.4).mockResolvedValueOnce(0.3);

    await convertSubItemToM4b(subId);

    expect(chapterMetadata).toHaveLength(1);
    const meta = chapterMetadata[0];
    expect(meta).toContain("START=0\nEND=300400");
    expect(meta).toContain("START=300400\nEND=600800");
    expect(meta).toContain("START=600800\nEND=601100");
    const tracks = (await db.prepare("SELECT duration_seconds FROM tracks WHERE sub_item_id = ?").all(subId)) as any[];
    expect(tracks[0].duration_seconds).toBe(601);
  });

  it("cleans up the chapter metadata temp file after a successful merge", async () => {
    const dir = bookDir("cleanup-book");
    const subId = await insertAuthorAndBook("Cleanup Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));

    await convertSubItemToM4b(subId);

    expect(fs.existsSync(path.join(dir, `.aonarr-chapters-${subId}.txt`))).toBe(false);
  });

  it("cleans up the chapter metadata temp file even when ffmpeg itself fails", async () => {
    const dir = bookDir("cleanup-on-failure-book");
    const subId = await insertAuthorAndBook("Cleanup On Failure Book", dir);
    await insertTrack(subId, 1, "Chapter 1", realTrackFile(dir, "01.mp3"));
    await insertTrack(subId, 2, "Chapter 2", realTrackFile(dir, "02.mp3"));
    ffmpegShouldFail = true;

    await expect(convertSubItemToM4b(subId)).rejects.toThrow(/ffmpeg merge failed/);

    expect(fs.existsSync(path.join(dir, `.aonarr-chapters-${subId}.txt`))).toBe(false);
    // A failed merge must never touch the DB or delete the original tracks.
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(subId)) as any[];
    expect(tracks).toHaveLength(2);
  });
});
