import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * The tag ids of a title come back in ascending order, whatever order the rows were written in. Without an ORDER BY a database
 * answers in the order the rows sit on disk: Postgres kept the order of writing, so the list parity test (tags written in
 * parallel) passed in one CI run and failed in the next with the same tags in another order.
 */
let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);

async function insert(table: string, row: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(row);
  const res = await db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
  return Number(res.lastInsertRowid);
}

let movieId = 0;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  const profile = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
  const folder = await insert("root_folders", { path: "/movies", media_type: "movie" });
  movieId = await insert("media_items", {
    type: "movie",
    title: "Tagged",
    sort_title: "tagged",
    year: 2001,
    path: "/movies/Tagged (2001)",
    external_ids: JSON.stringify({ tmdb: "9001" }),
    monitored: 1,
    quality_profile_id: profile,
    root_folder_id: folder,
  });
  const tags = [await insert("tags", { name: "alpha" }), await insert("tags", { name: "beta" }), await insert("tags", { name: "gamma" })];
  // Written highest first, one after the other, so the physical order is the reverse of the id order.
  for (const tag of [...tags].reverse()) await insert("media_item_tags", { media_item_id: movieId, tag_id: tag });
});

describe("the tags of a title are listed in ascending order", () => {
  it("in the movie list", async () => {
    const res = await get("/radarr/api/v3/movie");
    expect(res.status).toBe(200);
    const movie = (res.body as any[]).find((m) => m.id === movieId);
    expect(movie.tags).toEqual([...movie.tags].sort((a: number, b: number) => a - b));
    expect(movie.tags).toHaveLength(3);
  });

  it("in a single movie", async () => {
    const res = await get(`/radarr/api/v3/movie/${movieId}`);
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([...res.body.tags].sort((a: number, b: number) => a - b));
    expect(res.body.tags).toHaveLength(3);
  });
});
