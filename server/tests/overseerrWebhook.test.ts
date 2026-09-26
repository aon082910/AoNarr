import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchMovieByTmdbId = vi.fn();
const fetchSeriesByTmdbId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();

vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  isEpisodeMonitoredByDefault: (await importOriginal<typeof import("../src/services/metadata.js")>()).isEpisodeMonitoredByDefault,
  fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  fetchSeriesByTmdbId: (...args: unknown[]) => fetchSeriesByTmdbId(...args),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let handleOverseerrWebhook: (typeof import("../src/services/overseerrWebhook.js"))["handleOverseerrWebhook"];
const rootFolderIds: Record<string, number> = {};

async function addRootFolder(mediaType: string): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-overseerr-${mediaType}-`));
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
}

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ handleOverseerrWebhook } = await import("../src/services/overseerrWebhook.js"));
  for (const type of ["movie", "series"]) rootFolderIds[type] = await addRootFolder(type);
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
    expect(row.root_folder_id).toBe(rootFolderIds.movie);
  });

  it("declines an approval when no root folder is configured for its media type", async () => {
    await db.prepare("DELETE FROM root_folders WHERE media_type = 'movie'").run();
    fetchMovieByTmdbId.mockClear();
    try {
      const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie", tmdbId: 1101 } });

      expect(result).toEqual({ added: false, reason: "No root folder is configured for movie" });
      expect(fetchMovieByTmdbId).not.toHaveBeenCalled();
      const rows = (await db.prepare("SELECT id FROM media_items WHERE external_ids LIKE ?").all('%"1101"%')) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      rootFolderIds.movie = await addRootFolder("movie");
    }
  });

  it("adds a title once when two approvals for it arrive back to back", async () => {
    // Both webhooks pass the "already in the library" check while their metadata fetches are in
    // flight; the fetches only resolve once both have started.
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    fetchSeriesByTmdbId.mockImplementation(async () => {
      if (++started === 2) release();
      await bothStarted;
      return { title: "Twice Approved Series", year: 2021, overview: "", posterUrl: null, externalIds: { tmdb: "2101" }, releaseDate: null };
    });
    fetchSeriesEpisodesFor.mockResolvedValue([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: null, overview: "" }]);
    const payload = { notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 2101 } };

    try {
      const results = await Promise.all([handleOverseerrWebhook(payload), handleOverseerrWebhook(payload)]);

      expect(started).toBe(2);
      expect(results.filter((r) => r.added)).toHaveLength(1);
      expect(results.find((r) => !r.added)).toEqual({ added: false, reason: "Already in the library" });
      const shows = (await db.prepare("SELECT id, root_folder_id FROM media_items WHERE title = 'Twice Approved Series'").all()) as any[];
      expect(shows).toHaveLength(1);
      expect(shows[0].root_folder_id).toBe(rootFolderIds.series);
      const episodes = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?").get(shows[0].id)) as { c: number | string };
      expect(Number(episodes.c)).toBe(1);
    } finally {
      fetchSeriesByTmdbId.mockReset();
      fetchSeriesEpisodesFor.mockReset();
    }
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
