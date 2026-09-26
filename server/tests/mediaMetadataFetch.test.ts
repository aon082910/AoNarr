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
    // Unmonitored, so fetching a second opinion never queues anything as wanted.
    expect(Number(specialEp.monitored)).toBe(0);
  });

  it("adds only the other provider's specials, never its other seasons", async () => {
    const showId = await insertShow({ tmdb: "1" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([
      { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Other Numbering S2", airDate: null, overview: null },
      { seasonNumber: 3, episodeNumber: 1, title: "Other Numbering S3", airDate: null, overview: null },
    ]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.body.episodesAdded).toBe(1);
    const seasons = (await db.prepare("SELECT DISTINCT season_number FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(seasons.map((s) => Number(s.season_number))).toEqual([0]);
  });

  it("merges from the first hit that is really this show, not a differently-titled top hit", async () => {
    const showId = await insertShow({ tmdb: "1" });
    searchMetadata.mockResolvedValue([
      { title: "Fetch Test Show: The Spin-off", year: 2020, overview: "Wrong", posterUrl: null, externalIds: { tvdb: "77" } },
      { title: "Fetch Test Show (US)", year: 2020, overview: "Right", posterUrl: null, externalIds: { tvdb: "42" } },
    ]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "Right" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tmdb: "1", tvdb: "42" });
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledWith("tvdb", "42");
  });

  it("only stages an unverified hit for review: no id and no episodes are merged from it", async () => {
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES ('series', 'Remade Show', 'remade show', 2019, 1, 0, 'continuing', ?)`
          )
          .run(JSON.stringify({ tmdb: "5" }))
      ).lastInsertRowid
    );
    // Same title, but the 1985 original rather than the 2019 remake.
    searchMetadata.mockResolvedValue([{ title: "Remade Show", year: 1985, overview: "The original", posterUrl: null, externalIds: { tvdb: "88" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([{ seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: null }]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "The original" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tmdb: "5" });
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({});
    expect(res.body.episodesAdded).toBe(0);
    expect(fetchSeriesEpisodesForProvider).not.toHaveBeenCalled();
  });

  it("verifies a provider the item already has an id at by that id, even over a same-titled exact-year hit", async () => {
    // The item's own id is on the 1999 hit, and a same-titled show from the item's exact year is
    // listed first — the title/exact-year rule alone would pick that one.
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES ('series', 'Queer as Folk', 'queer as folk', 2000, 1, 0, 'ended', ?)`
          )
          .run(JSON.stringify({ tvdb: "UK" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([
      { title: "Queer as Folk (US)", year: 2000, overview: "US", posterUrl: null, externalIds: { tvdb: "US", imdb: "tt-us" } },
      { title: "Queer as Folk", year: 1999, overview: "UK", posterUrl: null, externalIds: { tvdb: "UK", imdb: "tt-uk" } },
    ]);
    fetchSeriesEpisodesForProvider
      .mockReset()
      .mockImplementation(async (_provider: string, id: string) =>
        id === "US" ? [{ seasonNumber: 0, episodeNumber: 1, title: "US Special", airDate: null, overview: null }] : [{ seasonNumber: 0, episodeNumber: 1, title: "UK Special", airDate: null, overview: null }]
      );

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledWith("tvdb", "UK");
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "UK", externalIds: { tvdb: "UK", imdb: "tt-uk" } });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tvdb: "UK", imdb: "tt-uk" });
    const titles = (await db.prepare("SELECT title FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(titles.map((t) => t.title)).toEqual(["UK Special"]);
  });

  it("prefers the exact-year hit over an earlier same-titled show a year apart when the item has no id at that provider", async () => {
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES ('series', 'Queer as Folk', 'queer as folk', 2000, 1, 0, 'ended', ?)`
          )
          .run(JSON.stringify({ tmdb: "US-TMDB" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([
      { title: "Queer as Folk", year: 1999, overview: "UK", posterUrl: null, externalIds: { tvdb: "UK", imdb: "tt-uk" } },
      { title: "Queer as Folk (US)", year: 2000, overview: "US", posterUrl: null, externalIds: { tvdb: "US", imdb: "tt-us" } },
    ]);
    fetchSeriesEpisodesForProvider
      .mockReset()
      .mockImplementation(async (_provider: string, id: string) =>
        id === "US" ? [{ seasonNumber: 0, episodeNumber: 1, title: "US Special", airDate: null, overview: null }] : [{ seasonNumber: 0, episodeNumber: 1, title: "UK Special", airDate: null, overview: null }]
      );

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledTimes(1);
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledWith("tvdb", "US");
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "US" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tmdb: "US-TMDB", tvdb: "US", imdb: "tt-us" });
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({ tvdb: "US", imdb: "tt-us" });
    const titles = (await db.prepare("SELECT title FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(titles.map((t) => t.title)).toEqual(["US Special"]);
  });

  it("still accepts a same-titled hit a year apart when no hit has the item's exact year", async () => {
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES ('series', 'Year Drift Show', 'year drift show', 2000, 1, 0, 'ended', ?)`
          )
          .run(JSON.stringify({ tmdb: "7" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([
      { title: "Year Drift Show", year: 1990, overview: "Too early", posterUrl: null, externalIds: { tvdb: "OLD" } },
      { title: "Year Drift Show", year: 2001, overview: "Drifted", posterUrl: null, externalIds: { tvdb: "D" } },
    ]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "Drifted" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tmdb: "7", tvdb: "D" });
    expect(fetchSeriesEpisodesForProvider).toHaveBeenCalledWith("tvdb", "D");
  });

  it("only stages the hit for review when no result carries the item's own id at that provider", async () => {
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids) VALUES ('series', 'Queer as Folk', 'queer as folk', 2000, 1, 0, 'ended', ?)`
          )
          .run(JSON.stringify({ tvdb: "US" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Queer as Folk", year: 1999, overview: "UK", posterUrl: null, externalIds: { tvdb: "UK", imdb: "tt-uk" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([{ seasonNumber: 0, episodeNumber: 1, title: "UK Special", airDate: null, overview: null }]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "UK" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ tvdb: "US" });
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({});
    expect(res.body.episodesAdded).toBe(0);
    expect(fetchSeriesEpisodesForProvider).not.toHaveBeenCalled();
  });

  it("records the ids it merged in apart from the item's own, so Refresh keeps using the item's own provider", async () => {
    const showId = await insertShow({ tvdb: "81189" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tmdb: "1396" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tmdb" });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT external_ids, extra_metadata FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tvdb: "81189", tmdb: "1396" });
    expect(JSON.parse(row.extra_metadata).additionalProviderIds).toEqual({ tmdb: "1396" });
  });

  it("adds to the ids already recorded as merged in, never recording one the item already had", async () => {
    const showId = await insertShow({ tvdb: "81189", tmdb: "1396" });
    await db
      .prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?")
      .run(JSON.stringify({ performers: ["A"], additionalProviderIds: { tmdb: "1396" } }), showId);
    searchMetadata.mockResolvedValue([
      { title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvmaze: "5", tvdb: "81189", imdb: "tt9" } },
    ]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvmaze" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({ tmdb: "1396", tvmaze: "5", imdb: "tt9" });
    expect(res.body.extraMetadata.performers).toEqual(["A"]);
    expect(JSON.parse(res.body.externalIds)).toEqual({ tvdb: "81189", tmdb: "1396", tvmaze: "5", imdb: "tt9" });
  });

  // Merged before the record existed: only the staged TMDB result shows tmdb was merged in.
  async function insertShowMergedBeforeTheRecord(): Promise<number> {
    const showId = await insertShow({ tvdb: "81189", tmdb: "1396" });
    await db
      .prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tmdb: { title: "Fetch Test Show", externalIds: { tmdb: "1396" } } }), showId);
    return showId;
  }

  async function childListIds(showId: number): Promise<Record<string, string>> {
    const { childListProviderIds } = await import("../src/services/libraryScan.js");
    const row = (await db.prepare("SELECT type, external_ids, extra_metadata FROM media_items WHERE id = ?").get(showId)) as any;
    return childListProviderIds(row);
  }

  it("keeps an older item's inferred merged ids when it records the ids merged from another provider", async () => {
    const showId = await insertShowMergedBeforeTheRecord();
    expect(await childListIds(showId)).toEqual({ tvdb: "81189" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvmaze: "5" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvmaze" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({ tmdb: "1396", tvmaze: "5" });
    expect(await childListIds(showId)).toEqual({ tvdb: "81189" });
  });

  it("never lets a fetch from the item's own provider make its own id look merged in", async () => {
    const showId = await insertShowMergedBeforeTheRecord();
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: "TVDB", posterUrl: null, externalIds: { tvdb: "81189" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "TVDB" });
    expect(res.body.extraMetadata.additionalProviderIds).toEqual({ tmdb: "1396" });
    expect(await childListIds(showId)).toEqual({ tvdb: "81189" });
  });

  it("leaves a Different Match made while the provider was being asked alone", async () => {
    const showId = await insertShow({ tmdb: "1" });
    searchMetadata.mockImplementation(async () => {
      await db.prepare("UPDATE media_items SET external_ids = ? WHERE id = ?").run(JSON.stringify({ tmdb: "2" }), showId);
      return [{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }];
    });
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([{ seasonNumber: 0, episodeNumber: 1, title: "Old Show Special", airDate: null, overview: null }]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });
    searchMetadata.mockReset();

    expect(res.status).toBe(409);
    const row = (await db.prepare("SELECT external_ids, extra_metadata FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "2" });
    expect(row.extra_metadata).toBeNull();
    const count = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(Number(count.c)).toBe(0);
  });

  it("never merges another provider's id or episodes into an AniList-numbered anime", async () => {
    const animeId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('anime', 'Cour Test Anime', 'cour test anime', 1, 0, 'continuing', ?)`
          )
          .run(JSON.stringify({ anilist: "123" }))
      ).lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Episode 1',1)`).run(animeId);
    searchMetadata.mockResolvedValue([{ title: "Cour Test Anime", year: 2021, overview: "TVDB overview", posterUrl: null, externalIds: { tvdb: "999" } }]);
    fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([
      { seasonNumber: 0, episodeNumber: 1, title: "OVA", airDate: null, overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Second Cour", airDate: null, overview: null },
    ]);

    const res = await request(app).post(`/api/media/${animeId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(200);
    expect(res.body.extraMetadata.tvdb).toMatchObject({ overview: "TVDB overview" });
    expect(JSON.parse(res.body.externalIds)).toEqual({ anilist: "123" });
    expect(res.body.episodesAdded).toBe(0);
    const count = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?").get(animeId)) as any;
    expect(Number(count.c)).toBe(1);
  });

  it("404s when the provider has no result at all", async () => {
    const showId = await insertShow();
    searchMetadata.mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(res.status).toBe(404);
  });

  it("never overwrites an id the item already has when merging in the fetched provider's ids", async () => {
    const showId = await insertShow({ tmdb: "1", tvdb: "9" });
    searchMetadata.mockResolvedValue([{ title: "Fetch Test Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "999" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "tvdb" });

    expect(JSON.parse(res.body.externalIds).tvdb).toBe("9");
  });

  it("400s without searching for the Unknown Author placeholder Scan & Import files unidentified books under", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Unknown Author', 'unknown author', 0, 1, 'unknown')`)
          .run()
      ).lastInsertRowid
    );
    searchMetadata.mockClear();

    const res = await request(app).post(`/api/media/${id}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "openlibrary" });

    expect(res.status).toBe(400);
    expect(searchMetadata).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.title).toBe("Unknown Author");
  });

  it("400s for a provider not configured for this item's type", async () => {
    const showId = await insertShow();
    const res = await request(app).post(`/api/media/${showId}/metadata/fetch`).set("X-Api-Key", apiKey).send({ provider: "musicbrainz" });
    expect(res.status).toBe(400);
  });
});
