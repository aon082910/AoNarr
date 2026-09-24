import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setSetting("mediaServerType", "");
  setSetting("mediaServerUrl", "");
  setSetting("mediaServerToken", "");
  await db.prepare("DELETE FROM watch_events").run();
});

function configurePlex(): void {
  setSetting("mediaServerType", "plex");
  setSetting("mediaServerUrl", "http://plex.local:32400");
  setSetting("mediaServerToken", "plex-token");
}

async function insertMovie(title: string, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', ?, ?, 1, 1, 'downloaded', ?)`)
        .run(title, title.toLowerCase(), filePath)
    ).lastInsertRowid
  );
}

async function insertWatchEvent(mediaItemId: number, watchedAt: string): Promise<void> {
  await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, watchedAt);
}

describe("GET /api/dashboard/recently-watched", () => {
  it("still answers with the webhook-recorded watches when the configured media server is unreachable", async () => {
    const id = await insertMovie("Offline Server Movie", "/media/movies/Offline Server Movie/movie.mkv");
    await insertWatchEvent(id, "2024-06-01 12:00:00");
    configurePlex();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));

    const res = await request(app).get("/api/dashboard/recently-watched").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mediaItemId: id, type: "movie", label: "Offline Server Movie", watchedAt: "2024-06-01T12:00:00.000Z" }]);
  });

  it("returns webhook timestamps as UTC ISO strings and orders them by real time against poll results", async () => {
    const webhookNewer = await insertMovie("Webhook Newer Movie", "/media/movies/Webhook Newer Movie/movie.mkv");
    const webhookOnly = await insertMovie("Webhook Only Movie", "/media/movies/Webhook Only Movie/movie.mkv");
    const pollOnly = await insertMovie("Poll Only Movie", "/media/movies/Poll Only Movie/movie.mkv");
    await insertWatchEvent(webhookNewer, "2024-06-01 23:00:00");
    await insertWatchEvent(webhookOnly, "2024-06-01 20:00:00");
    configurePlex();
    const seconds = (iso: string) => Date.parse(iso) / 1000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/library/sections?")) {
          return { ok: true, json: async () => ({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) } as any;
        }
        if (url.includes("/library/sections/1/all")) {
          return {
            ok: true,
            json: async () => ({
              MediaContainer: {
                Metadata: [
                  // An older play of the same movie the webhook already recorded later that day.
                  { viewCount: 2, lastViewedAt: seconds("2024-06-01T01:00:00Z"), Media: [{ Part: [{ file: "/plex/movies/Webhook Newer Movie/movie.mkv" }] }] },
                  { viewCount: 1, lastViewedAt: seconds("2024-06-01T10:00:00Z"), Media: [{ Part: [{ file: "/plex/movies/Poll Only Movie/movie.mkv" }] }] },
                ],
              },
            }),
          } as any;
        }
        throw new Error(`unmocked fetch call in test: ${url}`);
      })
    );

    const res = await request(app).get("/api/dashboard/recently-watched").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((e: any) => [e.mediaItemId, e.watchedAt])).toEqual([
      [webhookNewer, "2024-06-01T23:00:00.000Z"],
      [webhookOnly, "2024-06-01T20:00:00.000Z"],
      [pollOnly, "2024-06-01T10:00:00.000Z"],
    ]);
  });

  it("shows the most recent of several recorded watches of the same item", async () => {
    const id = await insertMovie("Rewatched Dashboard Movie", "/media/movies/Rewatched Dashboard Movie/movie.mkv");
    await insertWatchEvent(id, "2024-01-01 08:00:00");
    await insertWatchEvent(id, "2024-03-01 08:00:00");

    const res = await request(app).get("/api/dashboard/recently-watched").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mediaItemId: id, type: "movie", label: "Rewatched Dashboard Movie", watchedAt: "2024-03-01T08:00:00.000Z" }]);
  });
});

describe("GET /api/dashboard/library-sizes", () => {
  // One test on purpose: the route caches its computed sizes for 10 minutes per process.
  it("sums an album's track files (or its import-time size when no track row holds them) instead of the folder's own directory size", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-dashboard-sizes-"));
    const artistDir = path.join(root, "Size Artist");
    const albumDir = path.join(artistDir, "Size Album");
    const untrackedAlbumDir = path.join(artistDir, "Untracked Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.mkdirSync(untrackedAlbumDir, { recursive: true });
    const track1 = path.join(albumDir, "01.flac");
    const track2 = path.join(albumDir, "02.flac");
    fs.writeFileSync(track1, Buffer.alloc(1000));
    fs.writeFileSync(track2, Buffer.alloc(2000));
    const bookFile = path.join(root, "Size Book.epub");
    fs.writeFileSync(bookFile, Buffer.alloc(500));

    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('artist', 'Size Artist', 'size artist', 1, 1, 'downloaded', ?)`)
          .run(artistDir)
      ).lastInsertRowid
    );
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Size Album', 1, 1, ?)").run(artistId, albumDir))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'One', 1, ?)").run(albumId, track1);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 2, 'Two', 1, ?)").run(albumId, track2);
    // Imported before any track list existed: no track row holds its files, only the size recorded at import.
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path, size_bytes) VALUES (?, 'Untracked Album', 1, 1, ?, 4000)")
      .run(artistId, untrackedAlbumDir);
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Size Author', 'size author', 1, 1, 'downloaded')`).run())
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Size Book', 1, 1, ?)").run(authorId, bookFile);

    try {
      const res = await request(app).get("/api/dashboard/library-sizes").set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body.artist).toBe(3000 + 4000);
      expect(res.body.author).toBe(500);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
