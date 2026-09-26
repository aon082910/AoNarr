import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const refreshOneMediaItem = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/libraryScan.js")>()),
  refreshOneMediaItem: (...args: unknown[]) => refreshOneMediaItem(...args),
}));

const searchMetadata = vi.fn();
const fetchSeriesEpisodesForProvider = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  searchMetadata: (...args: unknown[]) => searchMetadata(...args),
  fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
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
    // The new match's episode list is the item's first real one, monitored like an Add's.
    expect(refreshOneMediaItem).toHaveBeenCalledWith(id, undefined, { firstMatch: true });
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

  it("forgets which ids were merged in from other providers, keeping the rest of extra_metadata", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, extra_metadata) VALUES ('series', 'Long Show', 'long show', 1, 0, 'continuing', ?, ?)`
          )
          .run(
            JSON.stringify({ tvdb: "81189", tmdb: "1396" }),
            JSON.stringify({ tmdb: { title: "Long Show" }, performers: ["A"], additionalProviderIds: { tmdb: "1396" } })
          )
      ).lastInsertRowid
    );

    const res = await request(app)
      .post(`/api/media/${id}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Long Show", externalIds: { tmdb: "1396", tvdb: "81189" } });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as any;
    expect(JSON.parse(row.extra_metadata)).toEqual({ tmdb: { title: "Long Show" }, performers: ["A"], additionalProviderIds: {} });
  });

  it("never lets a later provider match infer the new match's own id as merged from the old match's staged results", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    // Added through TMDB, with TVDB's id merged in — then rematched to its TVDB entry.
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, extra_metadata) VALUES ('series', 'Rematched Show', 'rematched show', 1, 0, 'continuing', ?, ?)`
          )
          .run(
            JSON.stringify({ tmdb: "1396", tvdb: "81189" }),
            JSON.stringify({ tvdb: { title: "Rematched Show", externalIds: { tvdb: "81189", tmdb: "1396" } }, additionalProviderIds: { tvdb: "81189" } })
          )
      ).lastInsertRowid
    );

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Rematched Show", externalIds: { tvdb: "81189" } });
    expect(res.status).toBe(200);

    searchMetadata
      .mockReset()
      .mockImplementation(async (_type: string, _query: string, provider: string) =>
        provider === "tmdb" ? [{ title: "Rematched Show", year: null, overview: null, posterUrl: null, externalIds: { tmdb: "1396" } }] : []
      );
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);
    const { matchAdditionalProviders, childListProviderIds } = await import("../src/services/libraryScan.js");
    await matchAdditionalProviders(id);

    const row = (await db.prepare("SELECT type, external_ids, extra_metadata FROM media_items WHERE id = ?").get(id)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tvdb: "81189", tmdb: "1396" });
    expect(JSON.parse(row.extra_metadata).additionalProviderIds).toEqual({ tmdb: "1396" });
    expect(childListProviderIds(row)).toEqual({ tvdb: "81189" });
  });

  it("rematches an item whose extra_metadata an older version stored as null", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMismatchedMovie();
    await db.prepare("UPDATE media_items SET extra_metadata = 'null' WHERE id = ?").run(id);

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Correct Film", externalIds: { tmdb: "2" } });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as any;
    expect(JSON.parse(row.extra_metadata)).toEqual({ additionalProviderIds: {} });
  });

  it("still answers when the follow-up refresh fails", async () => {
    refreshOneMediaItem.mockReset().mockRejectedValue(new Error("provider down"));
    const id = await insertMismatchedMovie();

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Correct Film" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Correct Film");
  });
});
