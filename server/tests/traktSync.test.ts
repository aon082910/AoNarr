import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  isEpisodeMonitoredByDefault: (await importOriginal<typeof import("../src/services/metadata.js")>()).isEpisodeMonitoredByDefault,
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
}));

/** Pass-through root-folder auto-select with an optional hook that runs once the sync has taken
 * its existing-ids snapshot. */
const rootFolderGate = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
vi.mock("../src/services/rootFolderSelect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/rootFolderSelect.js")>();
  return {
    ...actual,
    autoSelectRootFolderId: async (mediaType: string) => {
      if (rootFolderGate.hook) await rootFolderGate.hook();
      return actual.autoSelectRootFolderId(mediaType);
    },
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let runTraktSync: (typeof import("../src/services/traktSync.js"))["runTraktSync"];
let setSetting: (key: string, value: string) => void;
const rootFolderIds: Record<string, number> = {};

async function addRootFolder(mediaType: string): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-traktsync-${mediaType}-`));
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
}

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ runTraktSync } = await import("../src/services/traktSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  for (const type of ["movie", "series"]) rootFolderIds[type] = await addRootFolder(type);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rootFolderGate.hook = null;
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

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/someuser/watchlist?extended=full");
  });

  it("requests the named list's items endpoint for a /lists/<slug> URL", async () => {
    enableSync("https://trakt.tv/users/someuser/lists/to-watch");
    const fetchMock = mockTraktResponse([]);

    await runTraktSync();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/someuser/lists/to-watch/items?extended=full");
  });

  it("sends a User-Agent along with the Trakt API headers (Cloudflare blocks requests without one)", async () => {
    enableSync();
    const fetchMock = mockTraktResponse([]);

    await runTraktSync();

    const headers = (fetchMock.mock.calls[0] as any[])[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("AoNarr");
    expect(headers["trakt-api-key"]).toBe("trakt-client-id-value");
    expect(headers["trakt-api-version"]).toBe("2");
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
    expect(row.root_folder_id).toBe(rootFolderIds.movie);
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "4001", trakt: "9001" });
  });

  it("skips a movie when no movie root folder is configured, and reports why as a warning, not a failure", async () => {
    enableSync();
    await db.prepare("DELETE FROM root_folders WHERE media_type = 'movie'").run();
    const { log } = await import("../src/services/logger.js");
    const warn = vi.spyOn(log, "warn");
    try {
      mockTraktResponse([movieEntry({ title: "No Root Folder Trakt Movie", ids: { tmdb: 4101, trakt: 9101 } })]);

      const result = await runTraktSync();

      // Recurs on every run while the list holds the title, so it must not fail each scheduled run
      // that finds nothing else new.
      expect(result).toEqual({ added: 0, warning: "1 item(s) not added: no root folder is configured for movie" });
      expect(await db.prepare("SELECT id FROM media_items WHERE title = 'No Root Folder Trakt Movie'").get()).toBeUndefined();
      // The caller (scheduler job or Run-now route) reports the warning; logging it here too duplicates it.
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("item(s) not added"));
    } finally {
      warn.mockRestore();
      rootFolderIds.movie = await addRootFolder("movie");
    }
  });

  it("reports skipped items as a warning, not a failure, when it still added others", async () => {
    enableSync();
    await db.prepare("DELETE FROM root_folders WHERE media_type = 'movie'").run();
    try {
      mockTraktResponse([
        movieEntry({ title: "Skipped No Root Trakt Movie", ids: { tmdb: 4111, trakt: 9111 } }),
        { show: { title: "Added Alongside Trakt Show", ids: { tmdb: 5111, trakt: 9112 } } },
      ]);
      fetchSeriesEpisodesFor.mockResolvedValueOnce([]);

      const result = await runTraktSync();

      expect(result).toEqual({ added: 1, warning: "1 item(s) not added: no root folder is configured for movie" });
      expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Skipped No Root Trakt Movie'").get()).toBeUndefined();
      const show = (await db.prepare("SELECT root_folder_id FROM media_items WHERE title = 'Added Alongside Trakt Show'").get()) as any;
      expect(show.root_folder_id).toBe(rootFolderIds.series);
    } finally {
      rootFolderIds.movie = await addRootFolder("movie");
    }
  });

  it("does not add a movie another source inserted after this sync's start-of-run snapshot", async () => {
    enableSync();
    mockTraktResponse([movieEntry({ title: "Raced Trakt Movie", ids: { tmdb: 4201, trakt: 9201 } })]);
    // Root-folder selection runs after the existing-ids snapshot; another source (an import list, a
    // request approval) adds the same title while this sync is in flight.
    rootFolderGate.hook = async () => {
      rootFolderGate.hook = null;
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, status, external_ids) VALUES ('movie', 'Raced Trakt Movie', 'raced trakt movie', 1, 'missing', ?)`)
        .run(JSON.stringify({ tmdb: "4201" }));
    };

    const result = await runTraktSync();

    expect(result).toEqual({ added: 0 });
    const count = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Raced Trakt Movie'").get()) as { c: number | string };
    expect(Number(count.c)).toBe(1);
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
    expect(show.root_folder_id).toBe(rootFolderIds.series);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(show.id)) as any[];
    expect(episodes).toHaveLength(1);
  });

  it("adds Season 0 specials unmonitored and regular episodes monitored", async () => {
    enableSync();
    mockTraktResponse([{ show: { title: "Trakt Show With Specials", year: 2019, ids: { tmdb: 5003, trakt: 9103 } } }]);
    fetchSeriesEpisodesFor.mockResolvedValueOnce([
      { seasonNumber: 0, episodeNumber: 1, title: "Making Of", airDate: "2019-01-01", overview: "" },
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2019-02-01", overview: "" },
    ]);

    const result = await runTraktSync();

    expect(result).toEqual({ added: 1 });
    const show = (await db.prepare("SELECT id FROM media_items WHERE title = 'Trakt Show With Specials'").get()) as any;
    const episodes = (await db
      .prepare("SELECT season_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number")
      .all(show.id)) as any[];
    expect(episodes.map((e) => [e.season_number, Number(e.monitored)])).toEqual([
      [0, 0],
      [1, 1],
    ]);
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
