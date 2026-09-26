import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("../src/services/notifications.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, notifyImported: vi.fn(async () => {}), notifyUpgraded: vi.fn(async () => {}) };
});

vi.mock("../src/services/ffprobe.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, probeMediaInfo: vi.fn(async () => null) };
});

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let downloadsDir: string;
let fixturesDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  const { config } = await import("../src/config.js");
  downloadsDir = config.downloadsDir;
  // setupTestDb() makes the downloads dir the config dir too (the database lives there), so every
  // test file this suite writes stays inside one folder of its own.
  fixturesDir = path.join(downloadsDir, "route-fixtures");
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("skipFreeSpaceCheck", "1");
});

beforeEach(async () => {
  await db.prepare("DELETE FROM history").run();
  await db.prepare("DELETE FROM recycle_bin").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();
  fs.rmSync(fixturesDir, { recursive: true, force: true });
  fs.mkdirSync(fixturesDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-import-route-library-"));
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

/** Writes a file under the fixtures folder and returns its downloads-relative, "/"-joined path. */
function writeDownload(relative: string, content: string): string {
  const full = path.join(fixturesDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return `route-fixtures/${relative}`;
}

async function insertShow(): Promise<{ showId: number; episodeIds: number[]; rootPath: string }> {
  const rootPath = path.join(libraryDir, "series");
  fs.mkdirSync(rootPath, { recursive: true });
  const folderId = Number(
    (await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'series', 'series')").run(rootPath)).lastInsertRowid
  );
  const showId = Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`)
        .run(folderId)
    ).lastInsertRowid
  );
  const episodeIds: number[] = [];
  for (const [n, title] of [
    [1, "One"],
    [2, "Two"],
  ] as const) {
    episodeIds.push(
      Number(
        (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, title))
          .lastInsertRowid
      )
    );
  }
  return { showId, episodeIds, rootPath };
}

describe("POST /api/import/manual-batch", () => {
  it("imports the first of two files mapped to one episode and refuses the second", async () => {
    const { showId, episodeIds } = await insertShow();
    const real = writeDownload("Show.S01E01.720p/Show.S01E01.720p.mkv", "REAL EPISODE");
    const sample = writeDownload("Show.S01E01.720p/Show.S01E01.720p.sample.mkv", "sample");

    const res = await request(app)
      .post("/api/import/manual-batch")
      .set("X-Api-Key", apiKey)
      .send({
        mediaItemId: showId,
        files: [
          { sourcePath: real, episodeId: episodeIds[0] },
          { sourcePath: sample, episodeId: episodeIds[0] },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ sourcePath: real, ok: true });
    expect(res.body.results[1]).toMatchObject({ sourcePath: sample, ok: false, error: "Another file in this import is already mapped to that target" });
    const ep = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(episodeIds[0])) as any;
    expect(Number(ep.has_file)).toBe(1);
    expect(ep.file_path).toBe(res.body.results[0].destPath);
    expect(fs.readFileSync(ep.file_path, "utf-8")).toBe("REAL EPISODE");
    expect(fs.readFileSync(path.join(downloadsDir, ...sample.split("/")), "utf-8")).toBe("sample");
  });

  it("keeps an episode's file from earlier in the batch when a later multi-episode file also covers it", async () => {
    const { showId, episodeIds, rootPath } = await insertShow();
    const e02 = writeDownload("Show.S01E02.mkv", "episode two");
    const e01e02 = writeDownload("Show.S01E01E02.mkv", "episodes one and two");

    const res = await request(app)
      .post("/api/import/manual-batch")
      .set("X-Api-Key", apiKey)
      .send({
        mediaItemId: showId,
        files: [
          { sourcePath: e02, episodeId: episodeIds[1] },
          { sourcePath: e01e02, episodeId: episodeIds[0] },
        ],
      });

    expect(res.body.results.map((r: any) => r.ok)).toEqual([true, true]);
    const rows = (await db.prepare("SELECT file_path FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(rows.map((r) => fs.readFileSync(r.file_path, "utf-8"))).toEqual(["episodes one and two", "episode two"]);
    expect(rows[0].file_path).toBe(path.join(rootPath, "Show", "Season 01", "Show - S01E01 - One.mkv"));
    expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
  });

  it("refuses a batch for a media item that doesn't exist", async () => {
    const file = writeDownload("Some.File.mkv", "x");

    const res = await request(app)
      .post("/api/import/manual-batch")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemId: 999999, files: [{ sourcePath: file }] });

    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(downloadsDir, ...file.split("/")))).toBe(true);
  });
});

describe("GET /api/import/browse", () => {
  async function browse(p: string) {
    const res = await request(app).get(`/api/import/browse?path=${encodeURIComponent(p)}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    return res.body as { path: string; parent: string | null; entries: { name: string; path: string; isDirectory: boolean; isMediaFile: boolean }[] };
  }

  it("returns '/'-joined paths relative to the downloads folder and the parent of each level", async () => {
    writeDownload("browse/a/b/Show.S01E01.mkv", "x");

    const root = await browse("");
    expect(root.path).toBe("");
    expect(root.parent).toBeNull();
    expect(root.entries.find((e) => e.name === "route-fixtures")).toMatchObject({ path: "route-fixtures", isDirectory: true });

    const first = await browse("route-fixtures");
    expect(first).toMatchObject({ path: "route-fixtures", parent: "" });
    expect(first.entries.map((e) => e.path)).toEqual(["route-fixtures/browse"]);

    const second = await browse("route-fixtures/browse/");
    expect(second).toMatchObject({ path: "route-fixtures/browse", parent: "route-fixtures" });
    expect(second.entries.map((e) => e.path)).toEqual(["route-fixtures/browse/a"]);

    const deepest = await browse("route-fixtures/browse/a/b");
    expect(deepest).toMatchObject({ path: "route-fixtures/browse/a/b", parent: "route-fixtures/browse/a" });
    expect(deepest.entries).toEqual([expect.objectContaining({ path: "route-fixtures/browse/a/b/Show.S01E01.mkv", isMediaFile: true })]);
  });

  it("refuses a path outside the downloads folder", async () => {
    const res = await request(app).get(`/api/import/browse?path=${encodeURIComponent("../")}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
  });
});
