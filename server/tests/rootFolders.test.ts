import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let baseDir: string;

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-root-move-"));
});

async function createRootFolder(name: string, mediaType: string): Promise<{ id: number; dir: string }> {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
  return { id, dir };
}

async function insertItem(type: string, title: string, rootFolderId: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          "INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, monitored, has_file, status) VALUES (?, ?, ?, 2020, ?, ?, 1, ?, 'unknown')"
        )
        .run(type, title, title.toLowerCase(), filePath, rootFolderId, filePath ? 1 : 0)
    ).lastInsertRowid
  );
}

async function itemRow(id: number): Promise<{ root_folder_id: number; path: string | null }> {
  return (await db.prepare("SELECT root_folder_id, path FROM media_items WHERE id = ?").get(id)) as { root_folder_id: number; path: string | null };
}

/** The move runs in the background after the response; its audit entry is written last. */
async function waitForMoveAudit(sourceDir: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const rows = (await db.prepare("SELECT detail FROM audit_log WHERE event_type = 'root_folder_moved'").all()) as { detail: string }[];
    const hit = rows.find((r) => r.detail.startsWith(`${sourceDir} → `));
    if (hit) return hit.detail;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("move-to background task never finished");
}

describe("POST /api/root-folders/:id/move-to/:destinationId", () => {
  it("moves a movie's file and repoints the item", async () => {
    const source = await createRootFolder("movies-a", "movie");
    const destination = await createRootFolder("movies-b", "movie");
    const oldFile = path.join(source.dir, "Moved Movie (2020)", "Moved Movie (2020).mkv");
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, "video");
    const id = await insertItem("movie", "Moved Movie", source.id, oldFile);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true, itemCount: 1 });

    const detail = await waitForMoveAudit(source.dir);
    expect(detail).toContain("(1 item(s))");
    const row = await itemRow(id);
    const newFile = path.join(destination.dir, "Moved Movie (2020)", "Moved Movie (2020).mkv");
    expect(Number(row.root_folder_id)).toBe(destination.id);
    expect(row.path).toBe(newFile);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  // renameOneMediaItem reports a failed file move in its result instead of throwing; the item
  // used to be repointed at the destination (and counted as moved) while its file stayed behind.
  it("keeps an item whose file couldn't be moved pointed at the source folder", async () => {
    const source = await createRootFolder("movies-c", "movie");
    const destination = await createRootFolder("movies-d", "movie");
    const missingFile = path.join(source.dir, "Ghost Movie (2020)", "Ghost Movie (2020).mkv");
    const brokenId = await insertItem("movie", "Ghost Movie", source.id, missingFile);
    const noFileId = await insertItem("movie", "Wanted Movie", source.id, null);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.itemCount).toBe(2);

    const detail = await waitForMoveAudit(source.dir);
    expect(detail).toContain("(1 item(s), 1 failed)");
    const broken = await itemRow(brokenId);
    expect(Number(broken.root_folder_id)).toBe(source.id);
    expect(broken.path).toBe(missingFile);
    // Nothing on disk to move, so repointing it is the whole move.
    expect(Number((await itemRow(noFileId)).root_folder_id)).toBe(destination.id);
  });

  it("refuses to move a Music root folder, whose album folders it can't relocate", async () => {
    const source = await createRootFolder("music-a", "artist");
    const destination = await createRootFolder("music-b", "artist");
    const id = await insertItem("artist", "Some Artist", source.id, null);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Music/);
    expect(Number((await itemRow(id)).root_folder_id)).toBe(source.id);
  });
});
