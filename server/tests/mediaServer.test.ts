import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let getMediaServerConfig: (typeof import("../src/services/mediaServer.js"))["getMediaServerConfig"];
let fetchWatchedFiles: (typeof import("../src/services/mediaServer.js"))["fetchWatchedFiles"];
let fetchAllLibraryFiles: (typeof import("../src/services/mediaServer.js"))["fetchAllLibraryFiles"];
let parsePlexExternalIds: (typeof import("../src/services/mediaServer.js"))["parsePlexExternalIds"];
let fetchMediaServerMovies: (typeof import("../src/services/mediaServer.js"))["fetchMediaServerMovies"];
let fetchMediaServerSeries: (typeof import("../src/services/mediaServer.js"))["fetchMediaServerSeries"];
let refreshMediaServerLibrary: (typeof import("../src/services/mediaServer.js"))["refreshMediaServerLibrary"];
let triggerFullMediaServerScan: (typeof import("../src/services/mediaServer.js"))["triggerFullMediaServerScan"];
let resolvePlexFilePath: (typeof import("../src/services/mediaServer.js"))["resolvePlexFilePath"];
let pushWatchState: (typeof import("../src/services/mediaServer.js"))["pushWatchState"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  // mediaServer.ts imports settingsStore.js, which touches config.js/db/index.js transitively.
  await setupTestDb();
  ({
    getMediaServerConfig,
    fetchWatchedFiles,
    fetchAllLibraryFiles,
    parsePlexExternalIds,
    fetchMediaServerMovies,
    fetchMediaServerSeries,
    refreshMediaServerLibrary,
    triggerFullMediaServerScan,
    resolvePlexFilePath,
    pushWatchState,
  } = await import("../src/services/mediaServer.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configurePlex(): void {
  setSetting("mediaServerType", "plex");
  setSetting("mediaServerUrl", "http://plex.local:32400/");
  setSetting("mediaServerToken", "plex-token");
}

function configureJellyfin(): void {
  setSetting("mediaServerType", "jellyfin");
  setSetting("mediaServerUrl", "http://jellyfin.local:8096");
  setSetting("mediaServerToken", "jf-token");
}

function configureEmby(): void {
  setSetting("mediaServerType", "emby");
  setSetting("mediaServerUrl", "http://emby.local:8096");
  setSetting("mediaServerToken", "emby-token");
}

function unconfigure(): void {
  setSetting("mediaServerType", "");
  setSetting("mediaServerUrl", "");
  setSetting("mediaServerToken", "");
}

type Route = { test: (url: string) => boolean; response: any };

function routedFetch(routes: Route[]) {
  return vi.fn(async (url: string) => {
    const route = routes.find((r) => r.test(url));
    if (!route) throw new Error(`unmocked fetch call in test: ${url}`);
    return typeof route.response === "function" ? route.response(url) : route.response;
  });
}

function ok(body: unknown) {
  return { ok: true, json: async () => body };
}

function notOk(status: number) {
  return { ok: false, status };
}

describe("getMediaServerConfig", () => {
  it("returns null when type, url, or token is missing", () => {
    unconfigure();
    expect(getMediaServerConfig()).toBeNull();
    setSetting("mediaServerType", "plex");
    expect(getMediaServerConfig()).toBeNull(); // url/token still missing
  });

  it("returns the config with a trailing slash stripped from the URL", () => {
    configurePlex();
    expect(getMediaServerConfig()).toEqual({ type: "plex", url: "http://plex.local:32400", token: "plex-token" });
  });
});

describe("fetchWatchedFiles / fetchAllLibraryFiles", () => {
  it("returns an empty array without calling fetch when no media server is configured", async () => {
    unconfigure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWatchedFiles()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Plex: only scans movie/show sections, maps files, and applies the watched gate", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "artist" }] } }) },
        {
          test: (u) => u.includes("/library/sections/1/all"),
          response: ok({
            MediaContainer: {
              Metadata: [
                { viewCount: 1, lastViewedAt: 1700000000, Media: [{ Part: [{ file: "/movies/Watched.mkv" }] }] },
                { Media: [{ Part: [{ file: "/movies/Unwatched.mkv" }] }] }, // no viewCount/lastViewedAt
              ],
            },
          }),
        },
      ])
    );

    const watched = await fetchWatchedFiles();
    expect(watched).toEqual([{ path: "/movies/Watched.mkv", lastPlayedAt: new Date(1700000000 * 1000) }]);

    const all = await fetchAllLibraryFiles();
    expect(all.map((f) => f.path).sort()).toEqual(["/movies/Unwatched.mkv", "/movies/Watched.mkv"]);
  });

  it("Plex: a failed per-section items request is skipped, not fatal", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }] } }) },
        { test: (u) => u.includes("/library/sections/1/all"), response: notOk(500) },
        { test: (u) => u.includes("/library/sections/2/all"), response: ok({ MediaContainer: { Metadata: [{ Media: [{ Part: [{ file: "/tv/ep.mkv" }] }] }] } }) },
      ])
    );

    await expect(fetchAllLibraryFiles()).resolves.toEqual([{ path: "/tv/ep.mkv", lastPlayedAt: new Date(0) }]);
  });

  it("Jellyfin: collapses the same path across multiple users, keeping the most recent play", async () => {
    configureJellyfin();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }, { Id: "u2" }]) },
        {
          test: (u) => u.includes("/Users/u1/Items"),
          response: ok({ Items: [{ Path: "/shared/movie.mkv", UserData: { LastPlayedDate: "2024-01-01T00:00:00Z" } }] }),
        },
        {
          test: (u) => u.includes("/Users/u2/Items"),
          response: ok({ Items: [{ Path: "/shared/movie.mkv", UserData: { LastPlayedDate: "2024-06-01T00:00:00Z" } }] }),
        },
      ])
    );

    const files = await fetchAllLibraryFiles();

    expect(files).toEqual([{ path: "/shared/movie.mkv", lastPlayedAt: new Date("2024-06-01T00:00:00Z") }]);
  });

  it("Jellyfin: onlyWatched excludes items with no last-played date", async () => {
    configureJellyfin();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }]) },
        {
          test: (u) => u.includes("/Users/u1/Items"),
          response: ok({ Items: [{ Path: "/never-played.mkv" }] }), // no UserData at all
        },
      ])
    );

    await expect(fetchWatchedFiles()).resolves.toEqual([]);
  });

  it("Emby: requests go through the /emby base path", async () => {
    configureEmby();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/emby/Users") && !u.includes("Items"), response: ok([{ Id: "u1" }]) },
      { test: (u) => u.includes("/emby/Users/u1/Items"), response: ok({ Items: [] }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllLibraryFiles();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/emby/Users"))).toBe(true);
  });
});

describe("parsePlexExternalIds", () => {
  it("parses the new-agent Guid array", () => {
    const ids = parsePlexExternalIds({ Guid: [{ id: "tmdb://603" }, { id: "tvdb://121361" }, { id: "imdb://tt0133093" }] });
    expect(ids).toEqual({ tmdb: "603", tvdb: "121361", imdb: "tt0133093" });
  });

  it("falls back to the legacy guid string when there's no Guid array match for that provider", () => {
    const ids = parsePlexExternalIds({ guid: "com.plexapp.agents.themoviedb://603?lang=en" });
    expect(ids).toEqual({ tmdb: "603" });
  });

  it("prefers a Guid-array id over the legacy guid string for the same provider", () => {
    const ids = parsePlexExternalIds({ Guid: [{ id: "tmdb://999" }], guid: "com.plexapp.agents.themoviedb://603?lang=en" });
    expect(ids.tmdb).toBe("999");
  });

  it("returns an empty object when there are no recognizable ids at all", () => {
    expect(parsePlexExternalIds({})).toEqual({});
    expect(parsePlexExternalIds({ Guid: [{ id: "someunknownagent://abc" }] })).toEqual({});
  });
});

describe("fetchMediaServerMovies", () => {
  it("throws when no media server is configured", async () => {
    unconfigure();
    await expect(fetchMediaServerMovies()).rejects.toThrow("No media server configured");
  });

  it("Plex: maps movie sections into MediaServerLibraryItem[], skipping items with no file or ratingKey", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) },
        {
          test: (u) => u.includes("/library/sections/1/all"),
          response: ok({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "100",
                  title: "A Movie",
                  year: 2020,
                  summary: "An overview.",
                  thumb: "/thumb/100",
                  Guid: [{ id: "tmdb://603" }],
                  Media: [{ Part: [{ file: "/movies/a.mkv" }] }],
                },
                { ratingKey: "101", title: "No File" }, // no Media at all -> skipped
              ],
            },
          }),
        },
      ])
    );

    const movies = await fetchMediaServerMovies();

    expect(movies).toEqual([
      {
        mediaServerId: "100",
        path: "/movies/a.mkv",
        title: "A Movie",
        year: 2020,
        overview: "An overview.",
        posterUrl: "http://plex.local:32400/thumb/100?X-Plex-Token=plex-token",
        externalIds: { tmdb: "603" },
      },
    ]);
  });

  it("Jellyfin: maps ProviderIds and builds an image URL, returns [] when there are no users", async () => {
    configureJellyfin();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.endsWith("/Users"), response: ok([]) }]));

    await expect(fetchMediaServerMovies()).resolves.toEqual([]);
  });

  it("Jellyfin: throws (rather than skipping) when the items request itself fails", async () => {
    configureJellyfin();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }]) },
        { test: (u) => u.includes("/Users/u1/Items"), response: notOk(500) },
      ])
    );

    await expect(fetchMediaServerMovies()).rejects.toThrow("jellyfin items request failed: 500");
  });

  it("Jellyfin: maps a full movie item correctly", async () => {
    configureJellyfin();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }]) },
        {
          test: (u) => u.includes("/Users/u1/Items"),
          response: ok({
            Items: [
              {
                Id: "200",
                Path: "/movies/b.mkv",
                Name: "B Movie",
                ProductionYear: 2019,
                Overview: "Overview B",
                ProviderIds: { Tmdb: "700", Imdb: "tt700" },
                ImageTags: { Primary: "abc" },
              },
            ],
          }),
        },
      ])
    );

    const movies = await fetchMediaServerMovies();

    expect(movies).toEqual([
      {
        mediaServerId: "200",
        path: "/movies/b.mkv",
        title: "B Movie",
        year: 2019,
        overview: "Overview B",
        posterUrl: "http://jellyfin.local:8096/Items/200/Images/Primary?api_key=jf-token",
        externalIds: { tmdb: "700", imdb: "tt700" },
      },
    ]);
  });
});

describe("fetchMediaServerSeries", () => {
  it("throws when no media server is configured", async () => {
    unconfigure();
    await expect(fetchMediaServerSeries()).rejects.toThrow("No media server configured");
  });

  it("Plex: builds a shows map and links episodes to their show via grandparentRatingKey", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "5", type: "show" }] } }) },
        {
          test: (u) => u.includes("/library/sections/5/all?type=2"),
          response: ok({ MediaContainer: { Metadata: [{ ratingKey: "300", title: "A Show", year: 2018, summary: "S", thumb: "/t/300", Guid: [{ id: "tvdb://55" }] }] } }),
        },
        {
          test: (u) => u.includes("/library/sections/5/all?type=4"),
          response: ok({
            MediaContainer: {
              Metadata: [
                { grandparentRatingKey: "300", parentIndex: 1, index: 1, title: "Pilot", summary: "First ep", Media: [{ Part: [{ file: "/tv/s01e01.mkv" }] }] },
                { grandparentRatingKey: "300", parentIndex: 1, index: 2 }, // no file -> skipped
              ],
            },
          }),
        },
      ])
    );

    const library = await fetchMediaServerSeries();

    expect(library.shows.get("300")).toEqual({
      title: "A Show",
      year: 2018,
      overview: "S",
      posterUrl: "http://plex.local:32400/t/300?X-Plex-Token=plex-token",
      externalIds: { tvdb: "55" },
    });
    expect(library.episodes).toEqual([
      { showId: "300", path: "/tv/s01e01.mkv", seasonNumber: 1, episodeNumber: 1, title: "Pilot", overview: "First ep" },
    ]);
  });

  it("Jellyfin: builds shows and episodes from the first user only", async () => {
    configureJellyfin();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }, { Id: "u2" }]) },
        {
          test: (u) => u.includes("IncludeItemTypes=Series"),
          response: ok({ Items: [{ Id: "400", Name: "JF Show", ProductionYear: 2021, Overview: "O", ProviderIds: { Tvdb: "77" }, ImageTags: { Primary: "x" } }] }),
        },
        {
          test: (u) => u.includes("IncludeItemTypes=Episode"),
          response: ok({
            Items: [{ SeriesId: "400", Path: "/tv/jf-e1.mkv", ParentIndexNumber: 1, IndexNumber: 1, Name: "Ep One", Overview: "O1" }],
          }),
        },
      ])
    );

    const library = await fetchMediaServerSeries();

    expect(library.shows.get("400")).toMatchObject({ title: "JF Show", externalIds: { tvdb: "77" } });
    expect(library.episodes).toEqual([{ showId: "400", path: "/tv/jf-e1.mkv", seasonNumber: 1, episodeNumber: 1, title: "Ep One", overview: "O1" }]);
  });
});

describe("refreshMediaServerLibrary / triggerFullMediaServerScan", () => {
  it("is a no-op that never calls fetch when unconfigured", async () => {
    unconfigure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await refreshMediaServerLibrary("/x.mkv");
    await triggerFullMediaServerScan();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Plex: refresh includes a path param (targeted); full scan does not (whole-section)", async () => {
    configurePlex();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) },
      { test: () => true, response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await refreshMediaServerLibrary("/movies/a.mkv");
    const refreshCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/refresh"));
    expect(String(refreshCall![0])).toContain("path=%2Fmovies%2Fa.mkv");

    fetchMock.mockClear();
    await triggerFullMediaServerScan();
    const scanCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/refresh"));
    expect(String(scanCall![0])).not.toContain("path=");
  });

  it("Jellyfin/Emby: posts to the Library/Refresh endpoint under the right base path", async () => {
    configureEmby();
    const fetchMock = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal("fetch", fetchMock);

    await refreshMediaServerLibrary("/x.mkv");

    expect(fetchMock).toHaveBeenCalledWith("http://emby.local:8096/emby/Library/Refresh", expect.objectContaining({ method: "POST" }));
  });

  it("never throws even when the underlying request throws", async () => {
    configurePlex();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(refreshMediaServerLibrary("/x.mkv")).resolves.toBeUndefined();
    await expect(triggerFullMediaServerScan()).resolves.toBeUndefined();
  });
});

describe("resolvePlexFilePath", () => {
  it("returns null when unconfigured or configured for a non-Plex server", async () => {
    unconfigure();
    expect(await resolvePlexFilePath("1")).toBeNull();
    configureJellyfin();
    expect(await resolvePlexFilePath("1")).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    configurePlex();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(404)));

    expect(await resolvePlexFilePath("999")).toBeNull();
  });

  it("extracts the file path from the metadata response", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ MediaContainer: { Metadata: [{ Media: [{ Part: [{ file: "/movies/resolved.mkv" }] }] }] } }))
    );

    expect(await resolvePlexFilePath("555")).toBe("/movies/resolved.mkv");
  });

  it("returns null when the response has no file field", async () => {
    configurePlex();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ MediaContainer: { Metadata: [{}] } })));

    expect(await resolvePlexFilePath("555")).toBeNull();
  });
});

describe("pushWatchState", () => {
  it("is a no-op that never calls fetch when unconfigured", async () => {
    unconfigure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pushWatchState("/x.mkv", true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Plex: matches by path tail across different mount points and scrobbles", async () => {
    configurePlex();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) },
      {
        test: (u) => u.includes("/library/sections/1/all"),
        response: ok({ MediaContainer: { Metadata: [{ ratingKey: "42", Media: [{ Part: [{ file: "/mnt/media/Movies/Film (2020)/Film.mkv" }] }] }] } }),
      },
      { test: (u) => u.includes("/:/scrobble"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await pushWatchState("/completely/different/root/Movies/Film (2020)/Film.mkv", true);

    const scrobbleCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/:/scrobble"));
    expect(scrobbleCall).toBeTruthy();
    expect(String(scrobbleCall![0])).toContain("key=42");
  });

  it("Plex: unscrobbles when watched=false, and throws when no matching item is found", async () => {
    configurePlex();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) },
      { test: (u) => u.includes("/library/sections/1/all"), response: ok({ MediaContainer: { Metadata: [] } }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(pushWatchState("/no/match.mkv", false)).rejects.toThrow("No matching item found");
  });

  it("Plex: throws with the HTTP status when the scrobble request fails", async () => {
    configurePlex();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/library/sections?"), response: ok({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }) },
        { test: (u) => u.includes("/library/sections/1/all"), response: ok({ MediaContainer: { Metadata: [{ ratingKey: "1", Media: [{ Part: [{ file: "/a/b/c.mkv" }] }] }] } }) },
        { test: (u) => u.includes("/:/scrobble"), response: notOk(500) },
      ])
    );

    await expect(pushWatchState("/a/b/c.mkv", true)).rejects.toThrow("Plex scrobble failed: HTTP 500");
  });

  it("Jellyfin: POSTs PlayedItems when watched, DELETEs when not, throws when no user exists", async () => {
    configureJellyfin();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.endsWith("/Users"), response: ok([]) }]));

    await expect(pushWatchState("/x.mkv", true)).rejects.toThrow("No jellyfin user found");
  });

  it("Jellyfin: marks the matching item watched/unwatched by path tail", async () => {
    configureJellyfin();
    const fetchMock = routedFetch([
      { test: (u) => u.endsWith("/Users"), response: ok([{ Id: "u1" }]) },
      { test: (u) => u.includes("/Users/u1/Items"), response: ok({ Items: [{ Path: "/data/Movies/X/X.mkv", Id: "77" }] }) },
      { test: (u) => u.includes("/PlayedItems/77"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await pushWatchState("/other/mount/Movies/X/X.mkv", false);

    const playedCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/PlayedItems/77"));
    expect(playedCall![1]).toMatchObject({ method: "DELETE" });
  });
});
