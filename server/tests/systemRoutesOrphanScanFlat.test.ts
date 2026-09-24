import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

function touch(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x");
  return filePath;
}

describe("GET /api/system/orphaned-scan — flat-layout album", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("doesn't treat an album recorded at the artist folder itself as covering every file under that artist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-orphan-flat-"));
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'Music')").run(root);

    const artistDir = path.join(root, "Artist");
    // "Artist/track.mp3" with no album subfolder: libraryScan records the album's folder as the artist folder.
    const flatTrack = touch(path.join(artistDir, "01 - Flat.mp3"));
    const untrackedInLaterAlbum = touch(path.join(artistDir, "Later Album", "untracked.mp3"));

    const artistId = Number(
      (
        await db
          // No path of its own, exactly as Scan & Import creates an artist.
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 1, 'downloaded')`)
          .run()
      ).lastInsertRowid
    );
    const flatAlbumId = Number(
      (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Artist', 1, 1, ?)`).run(artistId, artistDir))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Flat', 1, ?)`).run(flatAlbumId, flatTrack);

    const res = await request(app).get("/api/system/orphaned-scan?full=1").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const orphaned = res.body.orphaned.map((o: { path: string }) => o.path).filter((p: string) => p.startsWith(root));
    expect(orphaned).toEqual([untrackedInLaterAlbum]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
