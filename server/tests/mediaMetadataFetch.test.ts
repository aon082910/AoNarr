import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

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

async function insertShow(externalIds: Record<string, string> = { tmdb: "1" }): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('series', 'Fetch Test Show', 'fetch test show', 1, 0, 'missing', ?)`
    )
    .run(JSON.stringify(externalIds));
  return Number(result.lastInsertRowid);
}

describe("POST /api/media/:id/metadata/fetch", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("stages the provider's result under extraMetadata and returns externalIds as valid JSON, not a spread-string", async () => {
    // Regression test: externalIds comes back from mediaItemFromRow as a raw JSON *string* (unlike
    // extraMetadata, which the mapper already parses) — an earlier version of this route did
    // `{ ...item.externalIds }`, which spread the string into one object key per character
    // (`{"0":"{","1":"\"",...}`) instead of parsing it.
    const showId = await insertShow({ tmdb: "1" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: "O", posterUrl: "P", externalIds: { tvdb: "42" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ title: "Fetch Test Show" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tmdb: "1", tvdb: "42" });
  });

  it("merges in the provider's missing episodes and reports episodesAdded", async () => {
    const showId = await insertShow({ tmdb: "1" });
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Existing Episode',1)`).run(showId);
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Provider Title", airDate: null, overview: null },
      { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: null },
    ]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.episodesAdded).toBe(1); // only the season-0 special is new; episode 1 already existed
    const specialEp = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = 0").get(showId)) as any;
    expect(specialEp).toMatchObject({ title: "Special" });
  });

  it("never overwrites an id the item already has when merging in the fetched provider's ids", async () => {
    const showId = await insertShow({ tmdb: "1", tvdb: "9" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "999" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(JSON.parse(res.body.externalIds).tvdb).toBe("9");
  });

  it("400s for a provider not configured for this item's type", async () => {
    const showId = await insertShow();
    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "musicbrainz" });
    expect(res.status).toBe(400);
  });
});
