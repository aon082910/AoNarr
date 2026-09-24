import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let runPlexWatchlistSync: (typeof import("../src/services/plexWatchlistSync.js"))["runPlexWatchlistSync"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ runPlexWatchlistSync } = await import("../src/services/plexWatchlistSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting("plexWatchlistSyncEnabled", "0");
  setSetting("mediaServerType", "");
  setSetting("mediaServerToken", "");
});

function enableSync(): void {
  setSetting("plexWatchlistSyncEnabled", "1");
  setSetting("mediaServerType", "plex");
  setSetting("mediaServerToken", "plex-token-value");
}

function mockWatchlist(items: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ MediaContainer: { Metadata: items } }) }) as any));
}

function movieItem(overrides: Record<string, unknown> = {}) {
  return {
    type: "movie",
    title: "Watchlist Movie",
    year: 2021,
    summary: "A watchlist movie.",
    thumb: "/library/metadata/1/thumb",
    Guid: [{ id: "tmdb://5001" }],
    ...overrides,
  };
}

describe("runPlexWatchlistSync — gating", () => {
  it("does nothing when the sync isn't enabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runPlexWatchlistSync();

    expect(result).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the media server type isn't plex", async () => {
    setSetting("plexWatchlistSyncEnabled", "1");
    setSetting("mediaServerType", "jellyfin");
    setSetting("mediaServerToken", "some-token");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runPlexWatchlistSync();

    expect(result).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when no media server token is configured", async () => {
    setSetting("plexWatchlistSyncEnabled", "1");
    setSetting("mediaServerType", "plex");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runPlexWatchlistSync();

    expect(result).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an error (not a throw) when the watchlist request fails", async () => {
    enableSync();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 }) as any));

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(0);
    expect(result.error).toContain("401");
  });
});

describe("runPlexWatchlistSync — movies", () => {
  it("adds a new movie parsed from the watchlist", async () => {
    enableSync();
    mockWatchlist([movieItem()]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(1);
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Watchlist Movie'").get()) as any;
    expect(row).toBeDefined();
    expect(row.type).toBe("movie");
    expect(row.poster_url).toBe("https://metadata-static.plex.tv/library/metadata/1/thumb");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "5001" });
  });

  it("skips a movie already in the library (matched by tmdb id)", async () => {
    enableSync();
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids)
         VALUES ('movie', 'Existing Movie', 'existing movie', 1, 0, 'unknown', ?)`
      )
      .run(JSON.stringify({ tmdb: "6002" }));
    mockWatchlist([movieItem({ title: "Existing Movie", Guid: [{ id: "tmdb://6002" }] })]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(0);
    const count = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Existing Movie'").get()) as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it("skips a watchlist item with no matching external id", async () => {
    enableSync();
    mockWatchlist([movieItem({ title: "No Id Movie", Guid: [] })]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(0);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'No Id Movie'").get()).toBeUndefined();
  });

  it("skips a movie whose title/tmdb id has been excluded", async () => {
    enableSync();
    await db
      .prepare("INSERT INTO import_exclusions (type, title, external_id, external_provider) VALUES ('movie', 'Excluded Movie', '7003', 'tmdb')")
      .run();
    mockWatchlist([movieItem({ title: "Excluded Movie", Guid: [{ id: "tmdb://7003" }] })]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(0);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Excluded Movie'").get()).toBeUndefined();
  });
});

describe("runPlexWatchlistSync — real Discover response shapes", () => {
  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as any;
  }

  it("looks up tmdb ids on each item's Discover metadata when the listing only carries a plex:// guid", async () => {
    enableSync();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/library/sections/watchlist/all")) {
        return jsonResponse({
          MediaContainer: {
            totalSize: 2,
            Metadata: [
              { type: "movie", title: "Listing Only Movie", year: 2022, ratingKey: "5d776b59ad5437001f79c6f8", guid: "plex://movie/5d776b59ad5437001f79c6f8" },
              { type: "show", title: "Listing Only Show", year: 2019, ratingKey: "5d9c086c46115600200aa2fe", guid: "plex://show/5d9c086c46115600200aa2fe" },
            ],
          },
        });
      }
      if (url.endsWith("/library/metadata/5d776b59ad5437001f79c6f8")) {
        return jsonResponse({ MediaContainer: { Metadata: [{ Guid: [{ id: "imdb://tt9000001" }, { id: "tmdb://9101" }] }] } });
      }
      if (url.endsWith("/library/metadata/5d9c086c46115600200aa2fe")) {
        return jsonResponse({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://9102" }, { id: "tvdb://9103" }] }] } });
      }
      throw new Error(`unmocked fetch call in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    fetchSeriesEpisodesFor.mockResolvedValueOnce([]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(2);
    const movie = (await db.prepare("SELECT * FROM media_items WHERE title = 'Listing Only Movie'").get()) as any;
    expect(JSON.parse(movie.external_ids)).toEqual({ tmdb: "9101", imdb: "tt9000001" });
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'Listing Only Show'").get()) as any;
    expect(show.type).toBe("series");
    expect(JSON.parse(show.external_ids)).toEqual({ tmdb: "9102" });
    const detailCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/library/metadata/"));
    expect(String(detailCall![0])).toContain("https://discover.provider.plex.tv/library/metadata/");
    expect((detailCall as any)[1].headers["X-Plex-Token"]).toBe("plex-token-value");
  });

  it("keeps going when one item's metadata lookup fails", async () => {
    enableSync();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/library/sections/watchlist/all")) {
          return jsonResponse({
            MediaContainer: {
              Metadata: [
                { type: "movie", title: "Lookup Fails Movie", ratingKey: "bad-key", guid: "plex://movie/bad-key" },
                { type: "movie", title: "Lookup Works Movie", ratingKey: "good-key", guid: "plex://movie/good-key" },
              ],
            },
          });
        }
        if (url.endsWith("/library/metadata/bad-key")) return { ok: false, status: 500 } as any;
        if (url.endsWith("/library/metadata/good-key")) return jsonResponse({ MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://9201" }] }] } });
        throw new Error(`unmocked fetch call in test: ${url}`);
      })
    );

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(1);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Lookup Works Movie'").get()).toBeDefined();
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Lookup Fails Movie'").get()).toBeUndefined();
  });

  it("pages through the whole watchlist, not just the first page", async () => {
    enableSync();
    const starts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (!url.includes("/library/sections/watchlist/all")) throw new Error(`unmocked fetch call in test: ${url}`);
        const start = init?.headers?.["X-Plex-Container-Start"] ?? "0";
        starts.push(start);
        const pages: Record<string, unknown[]> = {
          "0": [movieItem({ title: "Page One Movie A", Guid: [{ id: "tmdb://9301" }] }), movieItem({ title: "Page One Movie B", Guid: [{ id: "tmdb://9302" }] })],
          "2": [movieItem({ title: "Page Two Movie", Guid: [{ id: "tmdb://9303" }] })],
        };
        return jsonResponse({ MediaContainer: { totalSize: 3, Metadata: pages[start] ?? [] } });
      })
    );

    const result = await runPlexWatchlistSync();

    expect(starts).toEqual(["0", "2"]);
    expect(result.added).toBe(3);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Page Two Movie'").get()).toBeDefined();
  });
});

describe("runPlexWatchlistSync — shows", () => {
  it("adds a new show along with its fetched episodes", async () => {
    enableSync();
    mockWatchlist([
      { type: "show", title: "Watchlist Show", year: 2018, summary: "A show.", thumb: "https://already-absolute.example.com/t.jpg", Guid: [{ id: "tmdb://8004" }] },
    ]);
    fetchSeriesEpisodesFor.mockResolvedValueOnce([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2018-01-01", overview: "" }]);

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(1);
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'Watchlist Show'").get()) as any;
    expect(show.type).toBe("series");
    expect(show.poster_url).toBe("https://already-absolute.example.com/t.jpg");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(show.id)) as any[];
    expect(episodes).toHaveLength(1);
    expect(episodes[0].title).toBe("Pilot");
  });

  it("still adds the show even when fetching its episode list fails", async () => {
    enableSync();
    mockWatchlist([{ type: "show", title: "Episode Fetch Fails Show", Guid: [{ id: "tmdb://8005" }] }]);
    fetchSeriesEpisodesFor.mockRejectedValueOnce(new Error("provider down"));

    const result = await runPlexWatchlistSync();

    expect(result.added).toBe(1);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Episode Fetch Fails Show'").get()).toBeDefined();
  });
});
