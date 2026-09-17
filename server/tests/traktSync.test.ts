import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let runTraktSync: (typeof import("../src/services/traktSync.js"))["runTraktSync"];
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ runTraktSync } = await import("../src/services/traktSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting("traktSyncEnabled", "0");
  setSetting("traktSyncUrl", "");
  setSetting("traktClientId", "");
});

function enableSync(url = "https://trakt.tv/users/aonarr/watchlist"): void {
  setSetting("traktSyncEnabled", "1");
  setSetting("traktSyncUrl", url);
  setSetting("traktClientId", "trakt-client-id-value");
}

function mockTraktResponse(items: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => items }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function movieEntry(overrides: Record<string, unknown> = {}) {
  return { movie: { title: "Trakt Movie", year: 2020, ids: { tmdb: 4001, trakt: 9001 }, ...overrides } };
}

describe("runTraktSync — gating", () => {
  it("does nothing when the sync isn't enabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await runTraktSync()).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when enabled but no list URL is configured", async () => {
    setSetting("traktSyncEnabled", "1");
    setSetting("traktClientId", "some-client-id");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await runTraktSync()).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when enabled but no client id is configured", async () => {
    setSetting("traktSyncEnabled", "1");
    setSetting("traktSyncUrl", "https://trakt.tv/users/aonarr/watchlist");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await runTraktSync()).toEqual({ added: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an error for a URL that isn't a recognized Trakt list/watchlist format", async () => {
    enableSync("https://example.com/not-a-trakt-url");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runTraktSync();

    expect(result).toEqual({ added: 0, error: "Trakt list URL is not in a recognized format" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runTraktSync — list URL parsing", () => {
  it("requests the watchlist endpoint for a /watchlist URL", async () => {
    enableSync("https://trakt.tv/users/someuser/watchlist");
    const fetchMock = mockTraktResponse([]);

    await runTraktSync();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/someuser/watchlist");
  });

  it("requests the named list's items endpoint for a /lists/<slug> URL", async () => {
    enableSync("https://trakt.tv/users/someuser/lists/to-watch");
    const fetchMock = mockTraktResponse([]);

    await runTraktSync();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/someuser/lists/to-watch/items");
  });

  it("reports an error (not a throw) when the Trakt request fails", async () => {
    enableSync();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 }) as any));

    const result = await runTraktSync();

    expect(result.added).toBe(0);
    expect(result.error).toContain("429");
  });
});

describe("runTraktSync — movies", () => {
  it("adds a new movie with both tmdb and trakt ids recorded", async () => {
    enableSync();
    mockTraktResponse([movieEntry()]);

    const result = await runTraktSync();

    expect(result.added).toBe(1);
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Trakt Movie'").get()) as any;
    expect(row.type).toBe("movie");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "4001", trakt: "9001" });
  });

  it("skips a movie with no tmdb id", async () => {
    enableSync();
    mockTraktResponse([movieEntry({ title: "No Tmdb Movie", ids: { trakt: 9002 } })]);

    const result = await runTraktSync();

    expect(result.added).toBe(0);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'No Tmdb Movie'").get()).toBeUndefined();
  });

  it("skips a movie already in the library", async () => {
    enableSync();
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids)
         VALUES ('movie', 'Already Have This Trakt Movie', 'already have this trakt movie', 1, 0, 'unknown', ?)`
      )
      .run(JSON.stringify({ tmdb: "4002" }));
    mockTraktResponse([movieEntry({ title: "Already Have This Trakt Movie", ids: { tmdb: 4002, trakt: 9003 } })]);

    const result = await runTraktSync();

    expect(result.added).toBe(0);
  });

  it("skips a movie that's been excluded", async () => {
    enableSync();
    await db
      .prepare("INSERT INTO import_exclusions (type, title, external_id, external_provider) VALUES ('movie', 'Excluded Trakt Movie', '4003', 'tmdb')")
      .run();
    mockTraktResponse([movieEntry({ title: "Excluded Trakt Movie", ids: { tmdb: 4003, trakt: 9004 } })]);

    const result = await runTraktSync();

    expect(result.added).toBe(0);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Excluded Trakt Movie'").get()).toBeUndefined();
  });
});

describe("runTraktSync — shows", () => {
  it("adds a new show along with its fetched episodes", async () => {
    enableSync();
    mockTraktResponse([{ show: { title: "Trakt Show", year: 2017, ids: { tmdb: 5001, trakt: 9101 } } }]);
    fetchSeriesEpisodesFor.mockResolvedValueOnce([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2017-01-01", overview: "" }]);

    const result = await runTraktSync();

    expect(result.added).toBe(1);
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'Trakt Show'").get()) as any;
    expect(show.type).toBe("series");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(show.id)) as any[];
    expect(episodes).toHaveLength(1);
  });

  it("still adds the show even when fetching its episode list fails", async () => {
    enableSync();
    mockTraktResponse([{ show: { title: "Episode Fetch Fails Trakt Show", ids: { tmdb: 5002, trakt: 9102 } } }]);
    fetchSeriesEpisodesFor.mockRejectedValueOnce(new Error("provider down"));

    const result = await runTraktSync();

    expect(result.added).toBe(1);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Episode Fetch Fails Trakt Show'").get()).toBeDefined();
  });
});

describe("runTraktSync — malformed entries", () => {
  it("ignores a list entry that is neither a movie nor a show, without crashing", async () => {
    enableSync();
    mockTraktResponse([
      { person: { name: "Not a media entry" } },
      movieEntry({ title: "Valid Movie After Junk", ids: { tmdb: 4004, trakt: 9005 } }),
    ]);

    const result = await runTraktSync();

    expect(result.added).toBe(1);
    expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Valid Movie After Junk'").get()).toBeDefined();
  });
});
