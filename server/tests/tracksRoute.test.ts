import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function householdSession(username: string, allowedTypes: string[], maxContentRating: string | null = null): Promise<string> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (
      await db
        .prepare(`INSERT INTO users (username, password_hash, role, max_content_rating) VALUES (?, ?, 'user', ?)`)
        .run(username, hashPassword("x"), maxContentRating)
    ).lastInsertRowid
  );
  for (const type of allowedTypes) {
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, type);
  }
  return (await createSession(userId)).token;
}

/** An artist with one album holding two tracks (inserted out of order) — returns the album's id. */
async function insertAlbum(artistTitle: string, contentRating: string | null = null): Promise<number> {
  const artistId = Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, content_rating) VALUES ('artist', ?, ?, 1, 0, 'missing', ?)`)
        .run(artistTitle, artistTitle.toLowerCase(), contentRating)
    ).lastInsertRowid
  );
  const albumId = Number(
    (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album', 1, 0)`).run(artistId)).lastInsertRowid
  );
  await db.prepare(`INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Second')`).run(albumId);
  await db.prepare(`INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'First')`).run(albumId);
  return albumId;
}

describe("GET /api/media/subitems/:subItemId/tracks", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("lists an album's tracks for a household account with access to that library", async () => {
    const albumId = await insertAlbum("Household Artist");
    const token = await householdSession("tracks-music-user", ["artist"]);

    const res = await request(app).get(`/api/media/subitems/${albumId}/tracks`).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.body.map((t: { title: string }) => t.title)).toEqual(["First", "Second"]);
  });

  it("still lists them for an admin", async () => {
    const albumId = await insertAlbum("Admin Artist");

    const res = await request(app).get(`/api/media/subitems/${albumId}/tracks`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("refuses a household account without access to the album's library", async () => {
    const albumId = await insertAlbum("Other Library Artist");
    const token = await householdSession("tracks-movie-user", ["movie"]);

    const res = await request(app).get(`/api/media/subitems/${albumId}/tracks`).set("X-Session-Token", token);

    expect(res.status).toBe(403);
  });

  it("refuses a household account when the parent is above its content-rating cap", async () => {
    const albumId = await insertAlbum("Explicit Artist", "R");
    const token = await householdSession("tracks-capped-user", ["artist"], "PG-13");

    const res = await request(app).get(`/api/media/subitems/${albumId}/tracks`).set("X-Session-Token", token);

    expect(res.status).toBe(403);
  });

  it("404s for a sub-item that doesn't exist", async () => {
    const res = await request(app).get("/api/media/subitems/999999/tracks").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });

  it("keeps fetching a track list from the metadata provider admin-only", async () => {
    const albumId = await insertAlbum("Fetch Gate Artist");
    const token = await householdSession("tracks-fetch-user", ["artist"]);

    const res = await request(app).post(`/api/media/subitems/${albumId}/tracks/fetch`).set("X-Session-Token", token);

    expect(res.status).toBe(403);
  });
});
