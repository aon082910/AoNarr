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

describe("GET /api/system/orphaned-scan", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("doesn't report a Music library's tracked track files as orphaned", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-orphan-music-"));
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'Music')").run(root);

    const artistDir = path.join(root, "Artist");
    const albumDir = path.join(artistDir, "Album");
    const trackOne = touch(path.join(albumDir, "01 - First.flac"));
    const trackTwo = touch(path.join(albumDir, "02 - Second.flac"));
    // Imported into the album folder without a matching track row (no leading track number).
    touch(path.join(albumDir, "hidden bonus.flac"));
    // An album whose folder isn't recorded on its sub_item — only the track rows know its files.
    const looseTrack = touch(path.join(artistDir, "Loose Album", "01 - Loose.flac"));
    const strayInArtist = touch(path.join(artistDir, "stray.flac"));
    const unknownArtist = touch(path.join(root, "Unknown Artist", "x.mp3"));

    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('artist', 'Artist', 'artist', 1, 1, 'downloaded', ?)`)
          .run(artistDir)
      ).lastInsertRowid
    );
    const albumId = Number(
      (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)`).run(artistId, albumDir))
        .lastInsertRowid
    );
    const looseAlbumId = Number(
      (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Loose Album', 1, 1)`).run(artistId)).lastInsertRowid
    );
    const insertTrack = db.prepare(`INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, ?, ?, 1, ?)`);
    await insertTrack.run(albumId, 1, "First", trackOne);
    await insertTrack.run(albumId, 2, "Second", trackTwo);
    await insertTrack.run(looseAlbumId, 1, "Loose", looseTrack);

    const res = await request(app).get("/api/system/orphaned-scan?full=1").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const orphaned = res.body.orphaned.map((o: { path: string }) => o.path).filter((p: string) => p.startsWith(root)).sort();
    expect(orphaned).toEqual([strayInArtist, unknownArtist].sort());

    fs.rmSync(root, { recursive: true, force: true });
  });
});
