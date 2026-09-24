import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const refreshOneMediaItem = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/libraryScan.js")>()),
  refreshOneMediaItem: (...args: unknown[]) => refreshOneMediaItem(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertMismatchedMovie(): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, content_rating, genres)
       VALUES ('movie', 'Wrong Family Film', 'wrong family film', 1, 0, 'missing', ?, 'G', ?)`
    )
    .run(JSON.stringify({ tmdb: "1" }), JSON.stringify(["Family", "Animation"]));
  return Number(result.lastInsertRowid);
}

describe("POST /api/media/:id/rematch", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("drops the previous match's content rating and genres, then refreshes from the new match", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMismatchedMovie();

    const res = await request(app)
      .post(`/api/media/${id}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Correct Film", year: 2001, externalIds: { tmdb: "2" } });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT title, content_rating, genres, external_ids FROM media_items WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ title: "Correct Film", content_rating: null, genres: null });
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "2" });
    expect(refreshOneMediaItem).toHaveBeenCalledWith(id);
  });

  it("takes the new match's content rating and genres when the request carries them", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMismatchedMovie();

    const res = await request(app)
      .post(`/api/media/${id}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Correct Film", contentRating: "NC-17", genres: ["Drama", 7] });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT content_rating, genres FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.content_rating).toBe("NC-17");
    expect(JSON.parse(row.genres)).toEqual(["Drama"]);
  });

  it("ignores an unrecognized content rating rather than storing it", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMismatchedMovie();

    await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Correct Film", contentRating: "bogus" });

    const row = (await db.prepare("SELECT content_rating FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.content_rating).toBeNull();
  });

  it("still answers when the follow-up refresh fails", async () => {
    refreshOneMediaItem.mockReset().mockRejectedValue(new Error("provider down"));
    const id = await insertMismatchedMovie();

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Correct Film" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Correct Film");
  });
});
