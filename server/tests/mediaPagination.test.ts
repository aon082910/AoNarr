import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertMovies(count: number) {
  for (let i = 1; i <= count; i++) {
    const title = `Paginated Movie ${String(i).padStart(3, "0")}`;
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status)
         VALUES ('movie', ?, ?, ?, 1, ?, 'unknown')`
      )
      .run(title, title.toLowerCase(), 2000 + (i % 20), i % 3 === 0 ? 1 : 0);
  }
}

describe("GET /api/media pagination (Round 113)", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    await insertMovies(75);
  });

  it("paginates: page 1 of 75 items at limit=60 returns 60 items, correct total", async () => {
    const res = await request(app)
      .get("/api/media")
      .query({ type: "movie", sort: "title", limit: 60, offset: 0 })
      .set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(75);
    expect(res.body.items).toHaveLength(60);
    expect(res.body.items[0].title).toBe("Paginated Movie 001");
    expect(res.body.items[59].title).toBe("Paginated Movie 060");
  });

  it("paginates: page 2 returns the remaining 15 items", async () => {
    const res = await request(app)
      .get("/api/media")
      .query({ type: "movie", sort: "title", limit: 60, offset: 60 })
      .set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(75);
    expect(res.body.items).toHaveLength(15);
    expect(res.body.items[0].title).toBe("Paginated Movie 061");
  });

  it("status=downloaded filters server-side and matches the has_file=1 count", async () => {
    const res = await request(app).get("/api/media").query({ type: "movie", status: "downloaded", limit: 100 }).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(25); // every 3rd of 75
    expect(res.body.items).toHaveLength(25);
    expect(res.body.items.every((i: any) => i.hasFile === 1)).toBe(true);
  });

  it("status=missing is the complement of status=downloaded", async () => {
    const res = await request(app).get("/api/media").query({ type: "movie", status: "missing", limit: 100 }).set("X-Api-Key", apiKey);
    expect(res.body.total).toBe(50);
  });

  it("GET /api/media/stats reports the unfiltered total regardless of any filter", async () => {
    const res = await request(app).get("/api/media/stats").query({ type: "movie" }).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(75);
    expect(res.body.haveCount).toBe(25);
    expect(res.body.missingCount).toBe(50);
  });

  it("rejects requests with no/invalid API key", async () => {
    const res = await request(app).get("/api/media").query({ type: "movie" });
    expect(res.status).toBe(401);
  });
});
