import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

describe("GET /api/media genre filter and /api/media/stats genres list", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, genres) VALUES ('movie', 'Comedy Movie', 'comedy movie', 1, 1, 'downloaded', ?)`)
      .run(JSON.stringify(["Comedy", "Romance"]));
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, genres) VALUES ('movie', 'Action Movie', 'action movie', 1, 1, 'downloaded', ?)`)
      .run(JSON.stringify(["Action"]));
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'No Genre Movie', 'no genre movie', 1, 1, 'downloaded')`)
      .run();
  });

  it("/api/media/stats returns the distinct set of genres across matching items, flattened from every item's array", async () => {
    const res = await request(app).get("/api/media/stats").query({ type: "movie" }).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.genres.sort()).toEqual(["Action", "Comedy", "Romance"]);
  });

  it("/api/media?genre=... filters server-side to items whose genre array contains that genre", async () => {
    const res = await request(app).get("/api/media").query({ type: "movie", genre: "Comedy", limit: 100 }).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.title)).toEqual(["Comedy Movie"]);
  });
});
