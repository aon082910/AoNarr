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
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-root-move-throw-"));
});

async function createRootFolder(name: string, mediaType: string): Promise<{ id: number; dir: string }> {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
  return { id, dir };
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

// renameOneMediaItem can throw (rather than report an error in its result) from the setup it does
// before touching any file — here, parsing a malformed genres column. The item was already
// repointed at the destination by then, so it claimed a folder its file never moved into.
describe("POST /api/root-folders/:id/move-to/:destinationId — rename throws", () => {
  it("points the item back at the source folder and counts it as failed", async () => {
    const source = await createRootFolder("movies-throw-a", "movie");
    const destination = await createRootFolder("movies-throw-b", "movie");
    const file = path.join(source.dir, "Broken Row (2020)", "Broken Row (2020).mkv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "video");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, monitored, has_file, status, genres) VALUES ('movie', 'Broken Row', 'broken row', 2020, ?, ?, 1, 1, 'unknown', 'not json')"
          )
          .run(file, source.id)
      ).lastInsertRowid
    );

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true, itemCount: 1 });

    const detail = await waitForMoveAudit(source.dir);
    expect(detail).toContain("(0 item(s), 1 failed)");
    const row = (await db.prepare("SELECT root_folder_id, path FROM media_items WHERE id = ?").get(id)) as { root_folder_id: number; path: string };
    expect(Number(row.root_folder_id)).toBe(source.id);
    expect(row.path).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});
