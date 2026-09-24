import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchTrendingMovies = vi.fn();
const fetchTrendingSeries = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchTrendingMovies: (...args: unknown[]) => fetchTrendingMovies(...args),
  fetchTrendingSeries: (...args: unknown[]) => fetchTrendingSeries(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let rMovieId: number;
let pgMovieId: number;

function trending(tmdb: string, title: string) {
  return { title, year: 2020, overview: null, posterUrl: null, externalIds: { tmdb } };
}

async function insertMovie(title: string, externalIds: string | null, contentRating: string | null): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, content_rating) VALUES ('movie', ?, ?, 1, 0, 'missing', ?, ?)`
    )
    .run(title, title.toLowerCase(), externalIds, contentRating);
  return Number(result.lastInsertRowid);
}

async function householdSession(username: string, maxContentRating: string | null): Promise<string> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (
      await db
        .prepare(`INSERT INTO users (username, password_hash, role, max_content_rating) VALUES (?, ?, 'user', ?)`)
        .run(username, hashPassword("x"), maxContentRating)
    ).lastInsertRowid
  );
  await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, 'movie')").run(userId);
  return (await createSession(userId)).token;
}

describe("GET /api/discover", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    rMovieId = await insertMovie("Restricted Trending Movie", JSON.stringify({ tmdb: "100" }), "R");
    pgMovieId = await insertMovie("Family Trending Movie", JSON.stringify({ tmdb: "200" }), "PG");
    // A legacy row with unparseable external_ids must not take the whole page down.
    await insertMovie("Broken Ids Movie", "{not json", null);
    fetchTrendingMovies.mockResolvedValue([trending("100", "Restricted Trending Movie"), trending("200", "Family Trending Movie"), trending("300", "Not Owned")]);
    fetchTrendingSeries.mockResolvedValue([]);
  });

  it("marks every owned title as in the library for an admin, despite a malformed external_ids row", async () => {
    const res = await request(app).get("/api/discover").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.movies.map((m: any) => [m.externalIds.tmdb, m]));
    expect(byTmdb["100"]).toMatchObject({ inLibrary: true, mediaItemId: rMovieId });
    expect(byTmdb["200"]).toMatchObject({ inLibrary: true, mediaItemId: pgMovieId });
    expect(byTmdb["300"]).toMatchObject({ inLibrary: false, mediaItemId: null });
  });

  it("doesn't reveal an owned title above a household account's content-rating cap", async () => {
    const token = await householdSession("discover-capped-user", "PG-13");

    const res = await request(app).get("/api/discover").set("X-Session-Token", token);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.movies.map((m: any) => [m.externalIds.tmdb, m]));
    expect(byTmdb["100"]).toMatchObject({ inLibrary: false, mediaItemId: null });
    expect(byTmdb["200"]).toMatchObject({ inLibrary: true, mediaItemId: pgMovieId });
  });

  it("shows everything owned to a household account with no rating cap", async () => {
    const token = await householdSession("discover-uncapped-user", null);

    const res = await request(app).get("/api/discover").set("X-Session-Token", token);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.movies.map((m: any) => [m.externalIds.tmdb, m]));
    expect(byTmdb["100"]).toMatchObject({ inLibrary: true, mediaItemId: rMovieId });
  });
});
