import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const fetchSeriesEpisodesFor = vi.fn();
const fetchMovieByTmdbId = vi.fn();
const fetchSeriesByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
    fetchSeriesByTmdbId: (...args: unknown[]) => fetchSeriesByTmdbId(...args),
    fetchArtistAlbumsFor: async () => null,
    fetchAlbumTracksFor: async () => [],
  };
});

const getMediaServerConfig = vi.fn();
const fetchWatchedFiles = vi.fn();
vi.mock("../src/services/mediaServer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/mediaServer.js")>()),
  getMediaServerConfig: (...args: unknown[]) => getMediaServerConfig(...args),
  fetchWatchedFiles: (...args: unknown[]) => fetchWatchedFiles(...args),
}));

// A series added with a TVDB id asks TheXEM for scene numbering; none of these tests may reach out.
vi.mock("../src/services/sceneNumbering.js", () => ({ syncSceneNumbering: async () => ({ updated: 0 }) }));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (key: string, value: string) => void;
let syncImportList: (typeof import("../src/services/importLists.js"))["syncImportList"];
let runTraktSync: (typeof import("../src/services/traktSync.js"))["runTraktSync"];
let runPlexWatchlistSync: (typeof import("../src/services/plexWatchlistSync.js"))["runPlexWatchlistSync"];
let runAutoRequestFromWatchHistory: (typeof import("../src/services/recommendations.js"))["runAutoRequestFromWatchHistory"];
let handleOverseerrWebhook: (typeof import("../src/services/overseerrWebhook.js"))["handleOverseerrWebhook"];
let resolveAddQualityProfileId: (typeof import("../src/services/rootFolderDefaults.js"))["resolveAddQualityProfileId"];
type ImportListRow = import("../src/services/importLists.js").ImportListRow;

let firstProfile: number;
let folderProfile: number;
let listProfile: number;
const rootIds: Record<string, number> = {};

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ syncImportList } = await import("../src/services/importLists.js"));
  ({ runTraktSync } = await import("../src/services/traktSync.js"));
  ({ runPlexWatchlistSync } = await import("../src/services/plexWatchlistSync.js"));
  ({ runAutoRequestFromWatchHistory } = await import("../src/services/recommendations.js"));
  ({ handleOverseerrWebhook } = await import("../src/services/overseerrWebhook.js"));
  ({ resolveAddQualityProfileId } = await import("../src/services/rootFolderDefaults.js"));
});

beforeEach(async () => {
  for (const t of ["episodes", "media_item_tags", "requests", "media_items", "import_lists", "root_folders", "quality_profiles"]) await db.prepare(`DELETE FROM ${t}`).run();
  const profile = async (name: string) =>
    Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, '[\"SD\"]', 'SD')").run(name)).lastInsertRowid);
  firstProfile = await profile("First Profile");
  folderProfile = await profile("Folder Profile");
  listProfile = await profile("List Profile");
  for (const type of ["movie", "series", "artist"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-addprofile-${type}-`));
    rootIds[type] = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, type)).lastInsertRowid);
  }
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchMovieByTmdbId.mockReset();
  fetchSeriesByTmdbId.mockReset();
  getMediaServerConfig.mockReset().mockReturnValue(null);
  fetchWatchedFiles.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["traktSyncEnabled", "traktSyncUrl", "plexWatchlistSyncEnabled", "mediaServerType", "mediaServerToken", "tmdbApiKey", "autoRequestFromWatchHistoryEnabled"]) {
    setSetting(key, key === "traktSyncEnabled" || key === "plexWatchlistSyncEnabled" || key === "autoRequestFromWatchHistoryEnabled" ? "0" : "");
  }
});

const setFolderDefault = (type: string, column: string, value: unknown) =>
  db.prepare(`UPDATE root_folders SET ${column} = ? WHERE id = ?`).run(value, rootIds[type]);

const profileOf = async (title: string) => Number(((await db.prepare("SELECT quality_profile_id FROM media_items WHERE title = ?").get(title)) as any).quality_profile_id);

async function makeList(extra: Record<string, unknown> = {}): Promise<ImportListRow> {
  const result = await db.prepare("INSERT INTO import_lists (name, type, url, enabled) VALUES ('Profile list', 'trakt', 'https://trakt.tv/users/t/lists/l', 1)").run();
  const id = Number(result.lastInsertRowid);
  for (const [column, value] of Object.entries(extra)) await db.prepare(`UPDATE import_lists SET ${column} = ? WHERE id = ?`).run(value, id);
  return (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(id)) as ImportListRow;
}

function traktListReturns(entries: unknown[]) {
  setSetting("traktClientId", "test-client");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => entries }));
}

describe("resolveAddQualityProfileId", () => {
  it("takes the chosen profile, else the folder's default, else the first profile", async () => {
    expect(await resolveAddQualityProfileId(listProfile, rootIds.movie)).toBe(listProfile);
    expect(await resolveAddQualityProfileId(null, rootIds.movie)).toBe(firstProfile);
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    expect(await resolveAddQualityProfileId(null, rootIds.movie)).toBe(folderProfile);
    expect(await resolveAddQualityProfileId(listProfile, rootIds.movie)).toBe(listProfile);
    expect(await resolveAddQualityProfileId(null, null)).toBe(firstProfile);
  });
});

describe("import lists start from the root folder's profile and monitor choice", () => {
  it("a list without a profile adds a movie and a show with the root folder's default profile", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    await setFolderDefault("series", "default_quality_profile_id", folderProfile);
    const list = await makeList();
    traktListReturns([
      { movie: { title: "Folder Film", year: 2024, ids: { tmdb: 8101, trakt: 1 } } },
      { show: { title: "Folder Show", year: 2024, ids: { tmdb: 8102, trakt: 2 } } },
    ]);

    expect((await syncImportList(list)).added).toBe(2);

    expect(await profileOf("Folder Film")).toBe(folderProfile);
    expect(await profileOf("Folder Show")).toBe(folderProfile);
  });

  it("a list's own profile wins over the root folder's default", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    const list = await makeList({ quality_profile_id: listProfile });
    traktListReturns([{ movie: { title: "List Film", year: 2024, ids: { tmdb: 8103, trakt: 3 } } }]);

    await syncImportList(list);

    expect(await profileOf("List Film")).toBe(listProfile);
  });

  it("falls back to the first profile when neither the list nor the folder names one", async () => {
    const list = await makeList();
    traktListReturns([{ movie: { title: "Plain Film", year: 2024, ids: { tmdb: 8104, trakt: 4 } } }]);

    await syncImportList(list);

    expect(await profileOf("Plain Film")).toBe(firstProfile);
  });

  it("an artist from a list takes the artist folder's default profile and its monitor choice", async () => {
    await setFolderDefault("artist", "default_quality_profile_id", folderProfile);
    await setFolderDefault("artist", "default_monitor", "none");
    const list = await makeList({ type: "lastfm", url: "someone" });
    // Last.fm lists are read through the Last.fm API; the sync only needs one named artist.
    setSetting("lastfmApiKey", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ topartists: { artist: [{ name: "Folder Artist", mbid: "" }] } }) })
    );

    await syncImportList(list);

    const artist = (await db.prepare("SELECT * FROM media_items WHERE title = 'Folder Artist'").get()) as any;
    expect(artist).toBeDefined();
    expect(Number(artist.quality_profile_id)).toBe(folderProfile);
    expect(Number(artist.monitored)).toBe(0);
  });

  it("the folder's monitor choice applies when the list keeps the default, and a list that names one wins", async () => {
    await setFolderDefault("series", "default_monitor", "none");
    const quiet = await makeList({ name: "Quiet" });
    traktListReturns([{ show: { title: "Quiet Show", year: 2024, ids: { tmdb: 8105, trakt: 5 } } }]);
    await syncImportList(quiet);
    expect(Number(((await db.prepare("SELECT monitored FROM media_items WHERE title = 'Quiet Show'").get()) as any).monitored)).toBe(0);

    const loud = await makeList({ name: "Loud", monitor: "future" });
    traktListReturns([{ show: { title: "Loud Show", year: 2024, ids: { tmdb: 8106, trakt: 6 } } }]);
    await syncImportList(loud);
    expect(Number(((await db.prepare("SELECT monitored FROM media_items WHERE title = 'Loud Show'").get()) as any).monitored)).toBe(1);
  });
});

describe("the other add paths start from the root folder's profile", () => {
  it("a Trakt sync gives a movie the folder's profile and a show the folder's monitor choice", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    await setFolderDefault("series", "default_quality_profile_id", folderProfile);
    await setFolderDefault("series", "default_monitor", "future");
    setSetting("traktSyncEnabled", "1");
    setSetting("traktSyncUrl", "https://trakt.tv/users/aonarr/watchlist");
    traktListReturns([
      { movie: { title: "Trakt Folder Film", year: 2024, ids: { tmdb: 8201, trakt: 1 } } },
      { show: { title: "Trakt Folder Show", year: 2024, ids: { tmdb: 8202, trakt: 2 } } },
    ]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "Aired", airDate: "2020-01-01", overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Coming", airDate: day(30), overview: null },
    ]);

    expect((await runTraktSync()).added).toBe(2);

    expect(await profileOf("Trakt Folder Film")).toBe(folderProfile);
    expect(await profileOf("Trakt Folder Show")).toBe(folderProfile);
    const show = (await db.prepare("SELECT id FROM media_items WHERE title = 'Trakt Folder Show'").get()) as any;
    const episodes = (await db.prepare("SELECT season_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number").all(show.id)) as any[];
    expect(episodes.map((e) => [Number(e.season_number), Number(e.monitored)])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("a Plex watchlist sync gives a movie and a show the folder's profile", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    await setFolderDefault("series", "default_quality_profile_id", folderProfile);
    setSetting("plexWatchlistSyncEnabled", "1");
    setSetting("mediaServerType", "plex");
    setSetting("mediaServerToken", "plex-token-value");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              MediaContainer: {
                Metadata: [
                  { type: "movie", title: "Plex Folder Film", year: 2021, summary: "", thumb: "/t", Guid: [{ id: "tmdb://8301" }] },
                  { type: "show", title: "Plex Folder Show", year: 2021, summary: "", thumb: "/t", Guid: [{ id: "tmdb://8302" }] },
                ],
              },
            }),
          }) as any
      )
    );

    expect((await runPlexWatchlistSync()).added).toBe(2);

    expect(await profileOf("Plex Folder Film")).toBe(folderProfile);
    expect(await profileOf("Plex Folder Show")).toBe(folderProfile);
  });

  it("an automatic request from watch history gives the new title the folder's profile", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    setSetting("autoRequestFromWatchHistoryEnabled", "1");
    setSetting("tmdbApiKey", "tmdb-key");
    getMediaServerConfig.mockReturnValue({ type: "plex", url: "http://plex", token: "t" });
    await db
      .prepare(
        "INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, path) VALUES ('movie', 'Source Movie', 'source movie', 1, 1, 'unknown', ?, ?)"
      )
      .run(JSON.stringify({ tmdb: "8400" }), "/media/movies/Source Movie/movie.mkv");
    fetchWatchedFiles.mockResolvedValue([{ path: "/mnt/aonarr/movies/Source Movie/movie.mkv", lastPlayedAt: new Date() }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (url.includes("/movie/8400/recommendations") ? { results: [{ id: 8401, title: "Suggested Film", release_date: "2023-01-01" }] } : {}),
      }))
    );

    await runAutoRequestFromWatchHistory();

    expect(await profileOf("Suggested Film")).toBe(folderProfile);
  });

  it("an auto-approved request takes the folder's profile", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number(
      (await db.prepare("INSERT INTO users (username, password_hash, role, auto_approve) VALUES ('folder-requester', ?, 'user', 1)").run(hashPassword("x"))).lastInsertRowid
    );
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, 'movie')").run(userId);
    const { token } = await createSession(userId);

    const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Requested Folder Film" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("approved");
    expect(await profileOf("Requested Folder Film")).toBe(folderProfile);
  });

  it("an approved Overseerr request takes the folder's profile", async () => {
    await setFolderDefault("movie", "default_quality_profile_id", folderProfile);
    fetchMovieByTmdbId.mockResolvedValue({
      title: "Overseerr Folder Film",
      year: 2022,
      overview: "",
      posterUrl: null,
      externalIds: { tmdb: "8501" },
      releaseDate: "2022-05-01",
    });

    const result = await handleOverseerrWebhook({ notification_type: "MEDIA_APPROVED", media: { media_type: "movie", tmdbId: 8501 } });

    expect(result.added).toBe(true);
    expect(await profileOf("Overseerr Folder Film")).toBe(folderProfile);
  });
});
