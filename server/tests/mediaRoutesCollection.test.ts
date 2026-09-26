import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchTmdbCollectionFor = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  fetchTmdbCollectionFor: (...args: unknown[]) => fetchTmdbCollectionFor(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let salvationId: number;
let rPartId: number;

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

function part(tmdbId: number, title: string) {
  return { tmdbId, title, year: 2000, overview: null, posterUrl: null, releaseDate: null };
}

describe("GET /api/media/:id/collection", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    salvationId = await insertMovie("Terminator Salvation", JSON.stringify({ tmdb: "534" }), "PG-13");
    rPartId = await insertMovie("The Terminator", JSON.stringify({ tmdb: "218" }), "R");
    // A legacy row with unparseable external_ids must not take the whole panel down.
    await insertMovie("Broken Ids Movie", "{not json", null);
    fetchTmdbCollectionFor.mockResolvedValue({
      id: 528,
      name: "The Terminator Collection",
      overview: null,
      posterUrl: null,
      parts: [part(218, "The Terminator"), part(534, "Terminator Salvation"), part(999, "Not Owned")],
    });
  });

  it("links every owned part for an admin", async () => {
    const res = await request(app).get(`/api/media/${salvationId}/collection`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.parts.map((p: any) => [p.tmdbId, p.libraryItemId]));
    expect(byTmdb).toEqual({ 218: rPartId, 534: salvationId, 999: null });
  });

  it("doesn't reveal the library id of a part above a household account's rating cap", async () => {
    const token = await householdSession("collection-capped-user", "PG-13");

    const res = await request(app).get(`/api/media/${salvationId}/collection`).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.parts.map((p: any) => [p.tmdbId, p.libraryItemId]));
    expect(byTmdb).toEqual({ 218: null, 534: salvationId, 999: null });
  });

  it("links every owned part for a household account with no rating cap", async () => {
    const token = await householdSession("collection-uncapped-user", null);

    const res = await request(app).get(`/api/media/${salvationId}/collection`).set("X-Session-Token", token);

    expect(res.status).toBe(200);
    const byTmdb = Object.fromEntries(res.body.parts.map((p: any) => [p.tmdbId, p.libraryItemId]));
    expect(byTmdb[218]).toBe(rPartId);
  });
});
