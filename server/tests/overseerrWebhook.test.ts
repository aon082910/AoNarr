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

// A series added with a TVDB id asks TheXEM for scene numbering; none of these tests may reach out.
const syncSceneNumbering = vi.fn(async () => ({ updated: 0 }));
vi.mock("../src/services/sceneNumbering.js", () => ({
  syncSceneNumbering: (...args: unknown[]) => (syncSceneNumbering as any)(...args),
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

// API6: the webhook used to add every season as monitored, and left out what the Add Media screen
// stores (the instance's minimum availability, absolute episode numbers, scene numbering).
describe("handleOverseerrWebhook honours what was requested (API6)", () => {
  const threeSeasons = [
    { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: "" },
    { seasonNumber: 1, episodeNumber: 1, title: "S1E1", airDate: "2019-01-01", overview: "" },
    { seasonNumber: 1, episodeNumber: 2, title: "S1E2", airDate: "2019-01-08", overview: "" },
    { seasonNumber: 2, episodeNumber: 1, title: "S2E1", airDate: "2020-01-01", overview: "" },
    { seasonNumber: 3, episodeNumber: 1, title: "S3E1", airDate: "2021-01-01", overview: "" },
  ];

  async function episodesOf(title: string) {
    const show = (await db.prepare("SELECT id FROM media_items WHERE title = ?").get(title)) as { id: number };
    return (await db
      .prepare("SELECT season_number, episode_number, monitored, absolute_episode_number FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
      .all(show.id)) as { season_number: number; episode_number: number; monitored: number; absolute_episode_number: number | null }[];
  }

  it("monitors only the seasons named in the payload's extra list, and still stores the others", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Season Two Only", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3101" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(threeSeasons);

    const result = await handleOverseerrWebhook({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3101 },
      extra: [{ name: "Requested Seasons", value: "2" }],
    });

    expect(result).toEqual({ added: true });
    const eps = await episodesOf("Season Two Only");
    expect(eps).toHaveLength(5);
    expect(eps.filter((e) => Number(e.monitored) === 1).map((e) => `${e.season_number}x${e.episode_number}`)).toEqual(["2x1"]);
  });

  it("monitors the usual episodes when the payload names no seasons (a plain request)", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Whole Show", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3102" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(threeSeasons);

    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3102 } });

    const eps = await episodesOf("Whole Show");
    expect(eps.filter((e) => Number(e.monitored) === 1)).toHaveLength(4); // everything but the season 0 special
  });

  it("numbers the episodes absolutely, as the Add Media screen does, for anime matching", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Absolute Numbers", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3103" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(threeSeasons);

    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3103 } });

    const eps = await episodesOf("Absolute Numbers");
    expect(eps.map((e) => e.absolute_episode_number)).toEqual([null, 1, 2, 3, 4]);
  });

  it("asks for scene numbering once the series has a TVDB id", async () => {
    syncSceneNumbering.mockClear();
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Scene Numbered", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3104", tvdb: "9104" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(threeSeasons);

    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3104 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(syncSceneNumbering).toHaveBeenCalledTimes(1);
  });

  it("monitors the requested season of a series the library already has, instead of doing nothing", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Already Here", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3105" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(threeSeasons);
    await handleOverseerrWebhook({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3105 },
      extra: [{ name: "Requested Seasons", value: "1" }],
    });
    expect((await episodesOf("Already Here")).filter((e) => Number(e.monitored) === 1).map((e) => e.season_number)).toEqual([1, 1]);

    const result = await handleOverseerrWebhook({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3105 },
      extra: [{ name: "Requested Seasons", value: "1, 3" }],
    });

    expect(result.added).toBe(false);
    expect(result.reason).toContain("season");
    expect((await episodesOf("Already Here")).filter((e) => Number(e.monitored) === 1).map((e) => e.season_number)).toEqual([1, 1, 3]);
  });

  it("gives a new movie the instance's default minimum availability and its release date", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("defaultMinimumAvailability", "released");
    try {
      fetchMovieByTmdbId.mockResolvedValueOnce(fakeMovieMeta({ title: "Gated Movie", externalIds: { tmdb: "3106" }, releaseDate: "2031-05-01" }));

      await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie", tmdbId: 3106 } });

      const row = (await db.prepare("SELECT minimum_availability, release_date FROM media_items WHERE title = 'Gated Movie'").get()) as any;
      expect(row.minimum_availability).toBe("released");
      expect(row.release_date).toBe("2031-05-01");
    } finally {
      setSetting("defaultMinimumAvailability", "");
    }
  });
});

// Review F3, F4, F7 of Round 23.
describe("handleOverseerrWebhook edge cases (review F3, F4, F7)", () => {
  const fourSeasons = [1, 2, 3, 4].map((season) => ({ seasonNumber: season, episodeNumber: 1, title: `S${season}E1`, airDate: "2020-01-01", overview: "" }));

  async function seasonsMonitored(title: string): Promise<number[]> {
    const show = (await db.prepare("SELECT id FROM media_items WHERE title = ?").get(title)) as { id: number };
    const rows = (await db.prepare("SELECT season_number FROM episodes WHERE media_item_id = ? AND monitored = 1 ORDER BY season_number").all(show.id)) as { season_number: number }[];
    return rows.map((r) => Number(r.season_number));
  }

  it("adds the episodes of a season TMDB listed after the show was added, then monitors them (F3)", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Grew A Season", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3201" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons.slice(0, 2));
    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3201 }, extra: [{ name: "Requested Seasons", value: "1" }] });
    expect(await seasonsMonitored("Grew A Season")).toEqual([1]);

    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons);
    const result = await handleOverseerrWebhook({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3201 },
      extra: [{ name: "Requested Seasons", value: "3" }],
    });

    expect(result.added).toBe(false);
    expect(result.reason).toContain("monitored 1 episode(s) of season(s) 3");
    expect(await seasonsMonitored("Grew A Season")).toEqual([1, 3]);
  });

  it("says so when the provider has no episodes for the requested season either (F3)", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "No Such Season", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3202" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons.slice(0, 1));
    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3202 } });

    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons.slice(0, 1));
    const result = await handleOverseerrWebhook({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3202 },
      extra: [{ name: "Requested Seasons", value: "9" }],
    });

    expect(result.reason).toContain("no episodes found for season(s) 9");
  });

  it("monitors both requests' seasons when two requests for different seasons of a new show overlap (F4)", async () => {
    fetchSeriesByTmdbId.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { title: "Overlapping Requests", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3203" }, releaseDate: null };
    });
    fetchSeriesEpisodesFor.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return fourSeasons;
    });
    const request = (season: string) => ({
      notification_type: "MEDIA_APPROVED",
      media: { media_type: "tv", tmdbId: 3203 },
      extra: [{ name: "Requested Seasons", value: season }],
    });

    try {
      const first = handleOverseerrWebhook(request("1"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = handleOverseerrWebhook(request("2"));
      const results = await Promise.all([first, second]);

      expect(results.filter((r) => r.added)).toHaveLength(1);
      expect(await seasonsMonitored("Overlapping Requests")).toEqual([1, 2]);
    } finally {
      fetchSeriesByTmdbId.mockReset();
      fetchSeriesEpisodesFor.mockReset();
    }
  });

  it("uses the TVDB id the payload carries, so scene numbering has something to look up (F7)", async () => {
    syncSceneNumbering.mockClear();
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Payload Tvdb", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3204" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons.slice(0, 1));

    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3204, tvdbId: "81189" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const row = (await db.prepare("SELECT external_ids FROM media_items WHERE title = 'Payload Tvdb'").get()) as { external_ids: string };
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "3204", tvdb: "81189" });
    expect(syncSceneNumbering).toHaveBeenCalledTimes(1);
  });

  it("ignores a TVDB id of 0 or an empty one", async () => {
    fetchSeriesByTmdbId.mockResolvedValueOnce({ title: "Zero Tvdb", year: 2019, overview: "", posterUrl: null, externalIds: { tmdb: "3205" }, releaseDate: null });
    fetchSeriesEpisodesFor.mockResolvedValueOnce(fourSeasons.slice(0, 1));

    await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "tv", tmdbId: 3205, tvdbId: "0" } });

    const row = (await db.prepare("SELECT external_ids FROM media_items WHERE title = 'Zero Tvdb'").get()) as { external_ids: string };
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "3205" });
  });
});
