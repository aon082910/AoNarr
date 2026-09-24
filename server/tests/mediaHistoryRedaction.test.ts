import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let householdToken: string;

async function householdSession(username: string, allowedTypes: string[]): Promise<string> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')`).run(username, hashPassword("x"))).lastInsertRowid
  );
  for (const type of allowedTypes) {
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, type);
  }
  return (await createSession(userId)).token;
}

async function insertMovieWithHistory(title: string, data: string | null): Promise<number> {
  const id = Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 0, 'missing')`)
        .run(title, title.toLowerCase())
    ).lastInsertRowid
  );
  await db.prepare("INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)").run(id, data);
  return id;
}

/** A 'grabbed' event's data as the scheduler stores it: the release object, whose download link
 * carries the indexer's API key or a tracker passkey. */
const grabbedRelease = {
  title: "Some.Movie.2020.1080p.BluRay.x264-GROUP",
  indexer: "Private Tracker",
  size: 123456789,
  seeders: 12,
  downloadUrl: "https://indexer.example/api?t=get&id=1&apikey=SECRET-INDEXER-KEY",
  infoUrl: "https://indexer.example/details/1",
  guid: "https://indexer.example/details/1#guid",
  magnetLink: "magnet:?xt=urn:btih:abc&tr=https://tracker.example/SECRET-PASSKEY/announce",
  comments: "http://indexer.example/comments/1",
  mirror: "ftp://mirror.example/file.nzb",
  protocol: "torrent",
  attributes: { quality: "Bluray-1080p", details: "https://indexer.example/details/1?apikey=NESTED-KEY", group: "GROUP" },
  sources: [
    { name: "primary", link: "https://indexer.example/dl/1?passkey=ARRAY-KEY" },
    { name: "fallback", mirrorUrl: "https://mirror.example/dl/1" },
  ],
};

describe("GET /api/media/:id/history — household redaction", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    householdToken = await householdSession("history-household-user", ["movie"]);
  });

  it("strips every URL-ish key and every URL-valued string, recursively, for a household session", async () => {
    const id = await insertMovieWithHistory("Redacted Movie", JSON.stringify(grabbedRelease));

    const res = await request(app).get(`/api/media/${id}/history`).set("X-Session-Token", householdToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].eventType).toBe("grabbed");
    expect(JSON.parse(res.body[0].data)).toEqual({
      title: "Some.Movie.2020.1080p.BluRay.x264-GROUP",
      indexer: "Private Tracker",
      size: 123456789,
      seeders: 12,
      protocol: "torrent",
      attributes: { quality: "Bluray-1080p", group: "GROUP" },
      sources: [{ name: "primary" }, { name: "fallback" }],
    });
    expect(res.body[0].data).not.toMatch(/SECRET|NESTED-KEY|ARRAY-KEY/);
  });

  it("drops URL strings inside arrays, and a bare URL string as the whole payload, for a household session", async () => {
    const arrays = await insertMovieWithHistory(
      "Array URL Movie",
      JSON.stringify({ mirrors: ["https://indexer.example/dl?apikey=ARRAY-STRING-KEY"], nested: [["magnet:?xt=urn:btih:abc&tr=NESTED-PASSKEY", "keep"]], tags: ["a"] })
    );
    const bare = await insertMovieWithHistory("Bare URL Movie", JSON.stringify("https://indexer.example/dl?apikey=BARE-KEY"));

    const arraysRes = await request(app).get(`/api/media/${arrays}/history`).set("X-Session-Token", householdToken);
    const bareRes = await request(app).get(`/api/media/${bare}/history`).set("X-Session-Token", householdToken);

    expect(arraysRes.status).toBe(200);
    expect(JSON.parse(arraysRes.body[0].data)).toEqual({ mirrors: [], nested: [["keep"]], tags: ["a"] });
    expect(bareRes.status).toBe(200);
    expect(bareRes.body[0].data).toBeNull();
  });

  it("returns the data unchanged for an admin", async () => {
    const stored = JSON.stringify(grabbedRelease);
    const id = await insertMovieWithHistory("Admin Sees All Movie", stored);

    const res = await request(app).get(`/api/media/${id}/history`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body[0].data).toBe(stored);
  });

  it("drops unparseable data to null for a household session, but leaves it for an admin", async () => {
    const id = await insertMovieWithHistory("Unparseable History Movie", "not json {apikey=SECRET");

    const household = await request(app).get(`/api/media/${id}/history`).set("X-Session-Token", householdToken);
    const admin = await request(app).get(`/api/media/${id}/history`).set("X-Api-Key", apiKey);

    expect(household.status).toBe(200);
    expect(household.body[0].data).toBeNull();
    expect(admin.body[0].data).toBe("not json {apikey=SECRET");
  });

  it("passes null data through as null", async () => {
    const id = await insertMovieWithHistory("Null History Movie", null);

    const res = await request(app).get(`/api/media/${id}/history`).set("X-Session-Token", householdToken);

    expect(res.status).toBe(200);
    expect(res.body[0].data).toBeNull();
  });
});
