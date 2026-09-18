import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const getMediaServerConfig = vi.fn();
const fetchWatchedFiles = vi.fn();
vi.mock("../src/services/mediaServer.js", () => ({
  getMediaServerConfig: (...args: unknown[]) => getMediaServerConfig(...args),
  fetchWatchedFiles: (...args: unknown[]) => fetchWatchedFiles(...args),
}));

const fetchSeriesEpisodesFor = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let getRecommendations: (typeof import("../src/services/recommendations.js"))["getRecommendations"];
let runAutoRequestFromWatchHistory: (typeof import("../src/services/recommendations.js"))["runAutoRequestFromWatchHistory"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ getRecommendations, runAutoRequestFromWatchHistory } = await import("../src/services/recommendations.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  getMediaServerConfig.mockReset();
  getMediaServerConfig.mockReturnValue(null); // no media server by default — "added" only, no watch-history branch
  fetchWatchedFiles.mockReset();
  setSetting("tmdbApiKey", "");
  setSetting("lastfmApiKey", "");
  setSetting("autoRequestFromWatchHistoryEnabled", "0");
});

function mockFetchByUrlSubstring(handlers: [string, unknown][]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      for (const [needle, body] of handlers) {
        if (url.includes(needle)) return { ok: true, json: async () => body } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    })
  );
}

async function insertMovie(title: string, tmdbId: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), JSON.stringify({ tmdb: tmdbId }))
    ).lastInsertRowid
  );
}

async function insertSeries(title: string, tmdbId: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('series', ?, ?, 1, 0, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), JSON.stringify({ tmdb: tmdbId }))
    ).lastInsertRowid
  );
}

async function insertWatchedEpisode(mediaItemId: number, filePath: string): Promise<void> {
  await db
    .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path) VALUES (?, 1, 1, 1, ?)`)
    .run(mediaItemId, filePath);
}

describe("getRecommendations", () => {
  it("returns everything empty when neither TMDB nor Last.fm keys are configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await getRecommendations();

    expect(result).toEqual({ movies: [], series: [], artists: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recommends similar movies from TMDB, excluding ones already in the library", async () => {
    setSetting("tmdbApiKey", "tmdb-key");
    await insertMovie("Source Movie", "100");
    await insertMovie("Already Have This One", "200"); // will show up as a "similar" result but is already owned
    mockFetchByUrlSubstring([
      [
        "/movie/100/recommendations",
        { results: [{ id: 200, title: "Already Have This One", release_date: "2020-01-01" }, { id: 201, title: "New Suggestion", release_date: "2021-06-15", poster_path: "/p.jpg" }] },
      ],
    ]);

    const result = await getRecommendations();

    expect(result.movies.some((m) => m.title === "Already Have This One")).toBe(false);
    const suggestion = result.movies.find((m) => m.title === "New Suggestion");
    expect(suggestion).toBeDefined();
    expect(suggestion!.year).toBe(2021);
    expect(suggestion!.posterUrl).toBe("https://image.tmdb.org/t/p/w342/p.jpg");
    expect(suggestion!.sourceTitle).toBe("Source Movie");
    expect(suggestion!.basis).toBe("added");
  });

  it("excludes a recommendation whose title/id is on the exclusion list", async () => {
    setSetting("tmdbApiKey", "tmdb-key");
    await insertMovie("Exclusion Source Movie", "300");
    await db.prepare("INSERT INTO import_exclusions (type, title, external_id, external_provider) VALUES ('movie', 'Rejected Suggestion', '301', 'tmdb')").run();
    mockFetchByUrlSubstring([["/movie/300/recommendations", { results: [{ id: 301, title: "Rejected Suggestion", release_date: "2019-01-01" }] }]]);

    const result = await getRecommendations();

    expect(result.movies.some((m) => m.title === "Rejected Suggestion")).toBe(false);
  });

  it("sources 'watched' movie recommendations from actual watch history when a media server is configured", async () => {
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    await insertMovie("Watched Source Movie", "400");
    await db.prepare("UPDATE media_items SET path = ? WHERE title = 'Watched Source Movie'").run("/media/movies/Watched Source Movie/movie.mkv");
    // getRecommendations() calls fetchWatchedFiles() twice per run (once each for the movie and
    // series "watched" branches) — mockResolvedValue (persistent) rather than Once so the second
    // call doesn't fall through to an unconfigured mock returning undefined.
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/movies/Watched Source Movie/movie.mkv", lastPlayedAt: new Date() }]);
    mockFetchByUrlSubstring([["/movie/400/recommendations", { results: [{ id: 401, title: "Watched-Based Suggestion", release_date: "2022-01-01" }] }]]);

    const result = await getRecommendations();

    const suggestion = result.movies.find((m) => m.title === "Watched-Based Suggestion");
    expect(suggestion?.basis).toBe("watched");
    expect(suggestion?.sourceTitle).toBe("Watched Source Movie");
  });

  it("recommends similar artists from Last.fm, mapping mbid and the large image", async () => {
    setSetting("lastfmApiKey", "lastfm-key");
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Source Artist', 'source artist', 1, 1, 'unknown')`).run();
    mockFetchByUrlSubstring([
      [
        "artist.getsimilar",
        { similarartists: { artist: [{ name: "Similar Artist", mbid: "mbid-123", image: [{ size: "small", "#text": "small.jpg" }, { size: "large", "#text": "large.jpg" }] }] } },
      ],
    ]);

    const result = await getRecommendations();

    const artist = result.artists.find((a) => a.title === "Similar Artist");
    expect(artist).toBeDefined();
    expect(artist!.externalIds).toEqual({ musicbrainz: "mbid-123" });
    expect(artist!.posterUrl).toBe("large.jpg");
    expect(artist!.basis).toBe("added");
  });

  it("doesn't recommend an artist already in the library (case-insensitively)", async () => {
    setSetting("lastfmApiKey", "lastfm-key");
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Owned Artist', 'owned artist', 1, 1, 'unknown')`).run();
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Source Artist For Dupe Check', 'x', 1, 1, 'unknown')`).run();
    mockFetchByUrlSubstring([["artist.getsimilar", { similarartists: { artist: [{ name: "OWNED ARTIST" }] } }]]);

    const result = await getRecommendations();

    expect(result.artists.some((a) => a.title.toLowerCase() === "owned artist")).toBe(false);
  });

  it("recommends similar series from TMDB using the TV-shaped field names (name/first_air_date), sourced from watch history", async () => {
    // recommendSeries has its own field mapping (name/first_air_date, not title/release_date like
    // recommendMovies) and, until now, had zero coverage of its own — every prior "similar" test in
    // this file exercised recommendMovies only. Also exercises recentlyWatchedLibraryItems's SERIES
    // branch (joining episodes to media_items), likewise previously untested.
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    const seriesId = await insertSeries("Source Series", "800");
    await insertWatchedEpisode(seriesId, "/media/series/Source Series/S01E01.mkv");
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/series/Source Series/S01E01.mkv", lastPlayedAt: new Date() }]);
    mockFetchByUrlSubstring([
      ["/tv/800/recommendations", { results: [{ id: 801, name: "Suggested Series", first_air_date: "2021-05-01", poster_path: "/s.jpg" }] }],
    ]);

    const result = await getRecommendations();

    const suggestion = result.series.find((s) => s.title === "Suggested Series");
    expect(suggestion).toBeDefined();
    expect(suggestion!.year).toBe(2021);
    expect(suggestion!.posterUrl).toBe("https://image.tmdb.org/t/p/w342/s.jpg");
    expect(suggestion!.sourceTitle).toBe("Source Series");
    expect(suggestion!.basis).toBe("watched");
  });

  it("tmdbSimilar returns no results, rather than throwing, when the TMDB request itself fails", async () => {
    setSetting("tmdbApiKey", "tmdb-key");
    await insertMovie("Failed Fetch Source", "950");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any));

    const result = await getRecommendations();

    expect(result.movies).toEqual([]);
  });
});

describe("runAutoRequestFromWatchHistory", () => {
  it("does nothing when not enabled", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as { c: number };
    await runAutoRequestFromWatchHistory();
    const after = (await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it("does nothing when there are no watch-history-based candidates", async () => {
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    // No TMDB/Last.fm keys configured -> getRecommendations returns everything empty.
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as { c: number };

    await runAutoRequestFromWatchHistory();

    const after = (await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it("auto-adds a watched-basis recommendation, respecting the configured limit", async () => {
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    setSetting("autoRequestFromWatchHistoryLimit", "1");
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    await insertMovie("Auto Request Source Movie", "500");
    await db.prepare("UPDATE media_items SET path = ? WHERE title = 'Auto Request Source Movie'").run("/media/movies/Auto Request Source Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/movies/Auto Request Source Movie/movie.mkv", lastPlayedAt: new Date() }]);
    mockFetchByUrlSubstring([["/movie/500/recommendations", { results: [{ id: 501, title: "Auto Added Suggestion", release_date: "2023-01-01" }] }]]);

    await runAutoRequestFromWatchHistory();

    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Auto Added Suggestion'").get()) as any;
    expect(row).toBeDefined();
    expect(row.monitored).toBe(1);
    expect(row.status).toBe("missing");
  });

  it("never auto-adds a recommendation whose tmdb id is already in the library", async () => {
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    await insertMovie("Second Source Movie", "600");
    await insertMovie("Already Owned Recommended Movie", "601"); // same tmdb id as what TMDB will "recommend"
    await db.prepare("UPDATE media_items SET path = ? WHERE title = 'Second Source Movie'").run("/media/movies/Second Source Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/movies/Second Source Movie/movie.mkv", lastPlayedAt: new Date() }]);
    mockFetchByUrlSubstring([["/movie/600/recommendations", { results: [{ id: 601, title: "Already Owned Recommended Movie", release_date: "2018-01-01" }] }]]);
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Already Owned Recommended Movie'").get()) as { c: number };

    await runAutoRequestFromWatchHistory();

    const after = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Already Owned Recommended Movie'").get()) as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it("dedupes a recommendation that independently appears twice in the same run, from two different source items", async () => {
    // getRecommendations() computes "added" and "watched" (and, within "watched", each source
    // item) independently, each against its own fresh seen-in-library set -- nothing dedupes
    // ACROSS those results before runAutoRequestFromWatchHistory sees them. This is exactly the
    // scenario insertedThisRun (recommendations.ts) exists to guard against, per its own comment --
    // but nothing previously proved that guard still works.
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    setSetting("autoRequestFromWatchHistoryLimit", "5");
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    await insertMovie("Dedup Source A", "900");
    await insertMovie("Dedup Source B", "901");
    await db.prepare("UPDATE media_items SET path = ? WHERE title = 'Dedup Source A'").run("/media/movies/Dedup Source A/movie.mkv");
    await db.prepare("UPDATE media_items SET path = ? WHERE title = 'Dedup Source B'").run("/media/movies/Dedup Source B/movie.mkv");
    fetchWatchedFiles.mockResolvedValue([
      { path: "/mnt/aonarr/movies/Dedup Source A/movie.mkv", lastPlayedAt: new Date() },
      { path: "/mnt/aonarr/movies/Dedup Source B/movie.mkv", lastPlayedAt: new Date() },
    ]);
    // Both sources happen to recommend the exact same TMDB movie.
    mockFetchByUrlSubstring([
      ["/movie/900/recommendations", { results: [{ id: 999, title: "Duplicate Suggestion", release_date: "2020-01-01" }] }],
      ["/movie/901/recommendations", { results: [{ id: 999, title: "Duplicate Suggestion", release_date: "2020-01-01" }] }],
    ]);

    await runAutoRequestFromWatchHistory();

    const rows = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Duplicate Suggestion'").get()) as { c: number };
    expect(Number(rows.c)).toBe(1);
  });

  it("auto-adds a watched-basis series recommendation and populates its episodes", async () => {
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    const seriesId = await insertSeries("Episode Source Series", "850");
    await insertWatchedEpisode(seriesId, "/media/series/Episode Source Series/S01E01.mkv");
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/series/Episode Source Series/S01E01.mkv", lastPlayedAt: new Date() }]);
    mockFetchByUrlSubstring([["/tv/850/recommendations", { results: [{ id: 851, name: "Suggested Series With Episodes", first_air_date: "2020-01-01" }] }]]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-01", overview: "The first episode." },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2020-01-08", overview: "The second episode." },
    ]);

    await runAutoRequestFromWatchHistory();

    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Suggested Series With Episodes'").get()) as any;
    expect(row).toBeDefined();
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(row.id)) as any[];
    expect(episodes).toHaveLength(2);
    expect(episodes[0].title).toBe("Pilot");
    expect(episodes[1].episode_number).toBe(2);
  });
});
