import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  const { config } = await import("../src/config.js");
  downloadsDir = config.downloadsDir;
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-activity-import-"));
});

afterAll(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

/** A film waiting in the library with a completed queue row, and its downloaded file. */
async function setup(name: string) {
  const rootPath = path.join(libraryDir, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, ".keep"), "x");
  const rootId = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(rootPath)).lastInsertRowid);
  const movieId = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('movie', 'Film', 'film', 2020, ?, 1, 0, 'missing')").run(rootId)).lastInsertRowid
  );
  const queueId = Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, status, quality, import_skipped_reason, added_at, updated_at) VALUES (?, 'Film.2020.1080p.WEB-DL-GRP', 'completed', 'WEBDL-1080p', 'Nothing matched', '2020-01-01 00:00:00', '2020-01-01 00:00:00')")
        .run(movieId)
    ).lastInsertRowid
  );
  const source = path.join(downloadsDir, `${name}-Film.2020.1080p.WEB-DL-GRP.mkv`);
  fs.writeFileSync(source, "payload");
  return { rootPath, movieId, queueId, source };
}

describe("POST /api/activity/queue/:id/manual-import with preview and mode (round 30c)", () => {
  it("answers what would be placed where without moving anything", async () => {
    const { rootPath, queueId, source, movieId } = await setup("preview");

    const res = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: source, preview: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ preview: true, mode: "move", sourceKept: false, sourceFile: source });
    expect(res.body.destPath.startsWith(rootPath)).toBe(true);
    expect(res.body.destPath.endsWith(".mkv")).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    // Nothing moved, nothing written.
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(res.body.destPath)).toBe(false);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(movieId)) as any).has_file)).toBe(0);
    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(queueId)).toBeTruthy();
    expect(await db.prepare("SELECT 1 FROM history").get()).toBeFalsy();
  });

  it("says a copy keeps the download, and reads the mode of the request", async () => {
    const { queueId, source } = await setup("previewcopy");

    const res = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: source, preview: true, mode: "copy" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "copy", sourceKept: true });
  });

  it("warns about what an automatic import would have refused", async () => {
    const { queueId, source } = await setup("previewwarn");
    fs.mkdirSync(path.join(downloadsDir, "previewwarn-folder"), { recursive: true });
    const inFolder = path.join(downloadsDir, "previewwarn-folder", "Film.2020.1080p.mkv");
    fs.writeFileSync(inFolder, "x");
    fs.writeFileSync(path.join(downloadsDir, "previewwarn-folder", "trap.exe"), "x");

    const res = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: inFolder, preview: true });

    expect(res.status).toBe(200);
    expect(res.body.warnings.join(" ")).toMatch(/trap\.exe/);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("refuses a file outside the downloads folder, a queue row that is not there, and an unknown mode", async () => {
    const { queueId, source } = await setup("previewbad");
    const outside = path.join(libraryDir, "outside.mkv");
    fs.writeFileSync(outside, "x");

    const out = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: outside, preview: true });
    expect(out.status).toBe(422);
    expect(out.body.error).toMatch(/inside the downloads directory/);

    await authed(request(app).post("/api/activity/queue/999999/manual-import")).send({ sourceFile: source, preview: true }).expect(404);
    const mode = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: source, preview: true, mode: "teleport" });
    expect(mode.status).toBe(400);
  });

  it("imports with the mode asked for: a copy leaves the download in place", async () => {
    const { queueId, source, rootPath, movieId } = await setup("copyimport");

    const res = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: source, mode: "copy" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(source)).toBe(true);
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)) as { has_file: number; path: string };
    expect(Number(row.has_file)).toBe(1);
    expect(row.path.startsWith(rootPath)).toBe(true);
    expect(fs.readFileSync(row.path, "utf-8")).toBe("payload");
  });

  it("refuses an unknown mode before importing", async () => {
    const { queueId, source } = await setup("badmode");

    const res = await authed(request(app).post(`/api/activity/queue/${queueId}/manual-import`)).send({ sourceFile: source, mode: "teleport" });

    expect(res.status).toBe(400);
    expect(fs.existsSync(source)).toBe(true);
  });
});
