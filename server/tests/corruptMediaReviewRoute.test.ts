import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// This environment has no ffprobe binary, so every probe fails ("corrupt") unless a test says a
// file now reads as healthy video.
const healthyFiles = new Set<string>();
vi.mock("../src/services/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ffprobe.js")>();
  return {
    ...actual,
    probeMediaInfo: async (filePath: string) => (healthyFiles.has(filePath) ? { videoCodec: "h264" } : null),
  };
});

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let libraryDir: string;

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-review-lib-"));
});

afterEach(() => {
  healthyFiles.clear();
});

function libraryFile(name: string, content = "bad data"): string {
  const p = path.join(libraryDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path, quality) VALUES ('movie', 'Movie', 'movie', 1, 1, 'unknown', ?, 'HD-1080p')`
        )
        .run(filePath)
    ).lastInsertRowid
  );
}

async function insertReviewEntry(table: string, rowId: number, mediaItemId: number, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO corrupt_media_review (table_name, row_id, media_item_id, media_type, file_path, title, reason)
           VALUES (?, ?, ?, 'movie', ?, 'Movie', 'ffprobe couldn''t read this file (corrupt or unrecognized data)')`
        )
        .run(table, rowId, mediaItemId, filePath)
    ).lastInsertRowid
  );
}

async function reviewEntryExists(id: number): Promise<boolean> {
  return !!(await db.prepare("SELECT id FROM corrupt_media_review WHERE id = ?").get(id));
}

describe("POST /api/corrupt-media-review/:id/recycle", () => {
  it("recycles a file that still fails validation and marks the row missing", async () => {
    const file = libraryFile("Still Bad (2020)/Still Bad (2020).mkv");
    const movieId = await insertMovie(file);
    const entryId = await insertReviewEntry("media_items", movieId, movieId, file);

    const res = await request(app).post(`/api/corrupt-media-review/${entryId}/recycle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect(await db.prepare("SELECT id FROM recycle_bin WHERE original_path = ?").get(file)).toBeDefined();
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)).toEqual({ has_file: 0, path: null });
    expect(await reviewEntryExists(entryId)).toBe(false);
  });

  it("drops the entry without recycling when a good replacement now sits at the same path", async () => {
    const file = libraryFile("Replaced (2020)/Replaced (2020).mkv", "good replacement");
    healthyFiles.add(file);
    const movieId = await insertMovie(file);
    const entryId = await insertReviewEntry("media_items", movieId, movieId, file);

    const res = await request(app).post(`/api/corrupt-media-review/${entryId}/recycle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recycled: false, stale: true });
    expect(fs.readFileSync(file, "utf-8")).toBe("good replacement");
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)).toEqual({ has_file: 1, path: file });
    expect(await reviewEntryExists(entryId)).toBe(false);
  });

  it("drops the entry without touching anything when the row has a different file now", async () => {
    const flagged = libraryFile("Upgraded (2020)/Upgraded (2020).mp4");
    const current = libraryFile("Upgraded (2020)/Upgraded (2020).mkv", "the upgrade");
    const movieId = await insertMovie(current);
    const entryId = await insertReviewEntry("media_items", movieId, movieId, flagged);

    const res = await request(app).post(`/api/corrupt-media-review/${entryId}/recycle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stale: true });
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)).toEqual({ has_file: 1, path: current });
    expect(fs.readFileSync(current, "utf-8")).toBe("the upgrade");
    expect(fs.existsSync(flagged)).toBe(true);
    expect(await reviewEntryExists(entryId)).toBe(false);
  });

  it("drops the entry without recycling when its episode row no longer exists", async () => {
    const file = libraryFile("Merged Show/Season 01/S01E01.mkv");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Merged Show', 'merged show', 1, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    const episodeId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)")
          .run(showId, file)
      ).lastInsertRowid
    );
    const entryId = await insertReviewEntry("episodes", episodeId, showId, file);
    await db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeId);

    const res = await request(app).post(`/api/corrupt-media-review/${entryId}/recycle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stale: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(await reviewEntryExists(entryId)).toBe(false);
  });

  it("refuses, and keeps the entry, while the root folder holding a missing file is offline", async () => {
    const offlineRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-review-root-")), "nas"); // never mounted
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(offlineRoot);
    const file = path.join(offlineRoot, "Offline (2020)", "Offline (2020).mkv");
    const movieId = await insertMovie(file);
    const entryId = await insertReviewEntry("media_items", movieId, movieId, file);

    const res = await request(app).post(`/api/corrupt-media-review/${entryId}/recycle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)).toEqual({ has_file: 1, path: file });
    expect(await reviewEntryExists(entryId)).toBe(true);
  });

  it("404s for an unknown entry", async () => {
    const res = await request(app).post("/api/corrupt-media-review/999999/recycle").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });
});
