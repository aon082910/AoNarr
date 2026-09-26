import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function householdToken(username: string, allowedTypes: string[], maxContentRating: string | null = null): Promise<string> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (
      await db
        .prepare("INSERT INTO users (username, password_hash, role, max_content_rating) VALUES (?, ?, 'user', ?)")
        .run(username, hashPassword("x"), maxContentRating)
    ).lastInsertRowid
  );
  for (const type of allowedTypes) {
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, type);
  }
  return (await createSession(userId)).token;
}

async function insertItem(type: string, title: string, contentRating: string | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, content_rating) VALUES (?, ?, ?, ?)")
        .run(type, title, title.toLowerCase(), contentRating)
    ).lastInsertRowid
  );
}

describe("GET /api/library-search", () => {
  let oldShowId: number;
  let movieId: number;

  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());

    // An older series whose episodes alone outnumber any raw-hit cap, indexed before the movie.
    oldShowId = await insertItem("series", "Old Show");
    await db.transaction(async () => {
      for (let n = 1; n <= 400; n++) {
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title) VALUES (?, 1, ?, ?)")
          .run(oldShowId, n, `Man of the Hour ${n}`);
      }
    });
    movieId = await insertItem("movie", "Man on Fire", "R");
    await insertItem("movie", "Mankind Unrated");
    await insertItem("movie", "Manhattan Family", "PG");
  });

  it("finds an item added after a series with hundreds of matching episodes", async () => {
    const res = await request(app).get("/api/library-search").query({ q: "man" }).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.title).sort()).toEqual(["Man on Fire", "Manhattan Family", "Mankind Unrated", "Old Show"]);
    expect(res.body.find((r: any) => r.mediaItemId === movieId).matchedOn).toBe("title");
    expect(res.body.find((r: any) => r.mediaItemId === oldShowId)).toMatchObject({ matchedOn: "episode" });
  });

  it("returns a movies-only household account's movies even when episode hits dominate", async () => {
    const token = await householdToken("search-movies-only", ["movie"]);

    const res = await request(app).get("/api/library-search").query({ q: "man" }).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.title).sort()).toEqual(["Man on Fire", "Manhattan Family", "Mankind Unrated"]);
  });

  it("hides items above a household account's max content rating but keeps unrated ones", async () => {
    const token = await householdToken("search-pg13", ["movie", "series"], "PG-13");

    const res = await request(app).get("/api/library-search").query({ q: "man" }).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.title).sort()).toEqual(["Manhattan Family", "Mankind Unrated", "Old Show"]);
  });

  it("returns nothing for a household account with no library access", async () => {
    const token = await householdToken("search-no-access", []);

    const res = await request(app).get("/api/library-search").query({ q: "man" }).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("reports a direct title match over an episode match for the same item", async () => {
    const showId = await insertItem("series", "Hourglass Saga");
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title) VALUES (?, 1, 1, 'Hourglass Begins')")
      .run(showId);

    const res = await request(app).get("/api/library-search").query({ q: "hourglass" }).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ mediaItemId: showId, matchedOn: "title", matchDetail: null })]);
  });
});
