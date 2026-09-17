import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchMovieByTmdbId = vi.fn();
const fetchSeriesByTmdbId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();

vi.mock("../src/services/metadata.js", () => ({
  fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  fetchSeriesByTmdbId: (...args: unknown[]) => fetchSeriesByTmdbId(...args),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let handleOverseerrWebhook: (typeof import("../src/services/overseerrWebhook.js"))["handleOverseerrWebhook"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ handleOverseerrWebhook } = await import("../src/services/overseerrWebhook.js"));
});

function fakeMovieMeta(overrides: Record<string, unknown> = {}) {
  return {
    title: "Fake Movie",
    year: 2022,
    overview: "A fake overview.",
    posterUrl: "https://image.tmdb.org/poster.jpg",
    externalIds: { tmdb: "555" },
    releaseDate: "2022-05-01",
    ...overrides,
  };
}

describe("handleOverseerrWebhook", () => {
  it("ignores a notification type other than approved media", async () => {
    const result = await handleOverseerrWebhook({ notification_type: "TEST_NOTIFICATION" });
    expect(result.added).toBe(false);
    expect(result.reason).toContain("TEST_NOTIFICATION");
  });

  it("rejects an unrecognized media_type", async () => {
    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "music", tmdbId: 1 } });
    expect(result.added).toBe(false);
    expect(result.reason).toContain("music");
  });

  it("rejects a payload with no tmdbId", async () => {
    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie" } });
    expect(result).toEqual({ added: false, reason: "No tmdbId in webhook payload" });
  });

  it("declines to add a tmdb id that's already in the library, without fetching metadata", async () => {
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids)
         VALUES ('movie', 'Already Have This', 'already have this', 1, 0, 'unknown', ?)`
      )
      .run(JSON.stringify({ tmdb: "999" }));
    fetchMovieByTmdbId.mockClear();

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie", tmdbId: 999 } });

    expect(result).toEqual({ added: false, reason: "Already in the library" });
    expect(fetchMovieByTmdbId).not.toHaveBeenCalled();
  });

  it("adds a new movie for MEDIA_APPROVED", async () => {
    fetchMovieByTmdbId.mockResolvedValueOnce(fakeMovieMeta({ externalIds: { tmdb: "1001" } }));

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie", tmdbId: 1001 } });

    expect(result).toEqual({ added: true });
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Fake Movie'").get()) as any;
    expect(row).toBeDefined();
    expect(row.type).toBe("movie");
    expect(row.year).toBe(2022);
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "1001" });
  });

  it("adds a new movie for MEDIA_AUTO_APPROVED too", async () => {
    fetchMovieByTmdbId.mockResolvedValueOnce(fakeMovieMeta({ title: "Auto Approved Movie", externalIds: { tmdb: "1002" } }));

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_AUTO_APPROVED", media: { media_type: "movie", tmdbId: 1002 } });

    expect(result).toEqual({ added: true });
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Auto Approved Movie'").get()).toBeDefined();
  });

  it("adds a new series along with its fetched episodes", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({
      title: "Fake Series",
      year: 2019,
      overview: "A fake series overview.",
      posterUrl: null,
      externalIds: { tmdb: "2001", tvdb: "3001" },
      releaseDate: null,
    });
    fetchSeriesEpisodesFor.mockResolvedValueOnce([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2019-01-01", overview: "First episode" },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2019-01-08", overview: "Second episode" },
    ]);

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 2001 } });

    expect(result).toEqual({ added: true });
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'Fake Series'").get()) as any;
    expect(show.type).toBe("series");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(show.id)) as any[];
    expect(episodes).toHaveLength(2);
    expect(episodes[0].title).toBe("Pilot");
    expect(episodes[1].title).toBe("Second");
  });

  it("still adds the series even when fetching its episode list fails", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({
      title: "Episode Fetch Fails Series",
      year: 2020,
      overview: "",
      posterUrl: null,
      externalIds: { tmdb: "2002" },
      releaseDate: null,
    });
    fetchSeriesEpisodesFor.mockRejectedValueOnce(new Error("provider unreachable"));

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 2002 } });

    expect(result).toEqual({ added: true });
    const show = (await db.prepare("SELECT id FROM media_items WHERE title = 'Episode Fetch Fails Series'").get()) as any;
    const count = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?").get(show.id)) as { c: number };
    expect(Number(count.c)).toBe(0);
  });
});
