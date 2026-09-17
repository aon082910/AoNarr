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
});
