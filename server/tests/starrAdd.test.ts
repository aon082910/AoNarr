import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const SHOW = {
  title: "Test Show",
  year: 2008,
  overview: "A show.",
  posterUrl: "https://img.example/poster.jpg",
  backdropUrl: "https://img.example/fanart.jpg",
  externalIds: { tvdb: "81189", tmdb: "1396", imdb: "tt0903747" },
  status: "Ended",
};
const MOVIE = {
  title: "Test Movie",
  year: 1999,
  overview: "A movie.",
  posterUrl: "https://img.example/movie.jpg",
  externalIds: { tmdb: "603", imdb: "tt0133093" },
  releaseDate: "1999-03-31",
  runtimeMinutes: 136,
};

// Providers answer from a fixed catalog; everything else of the add (episodes, other providers) fails fast offline.
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchByExternalId: vi.fn(async (type: string, provider: string, id: string) => {
      if (type === "series" && ((provider === "tvdb" && id === "81189") || (provider === "tmdb" && id === "1396") || (provider === "imdb" && id === "tt0903747"))) return SHOW;
      if (type === "movie" && ((provider === "tmdb" && id === "603") || (provider === "imdb" && id === "tt0133093"))) return MOVIE;
      throw new Error(`No ${type} with ${provider} id ${id}`);
    }),
    searchMetadata: vi.fn(async (type: string, term: string) => (/test/i.test(term) ? [type === "movie" ? MOVIE : SHOW] : [])),
    fetchSeriesSeasonsFor: vi.fn(async () => [
      { seasonNumber: 0, posterUrl: null },
      { seasonNumber: 1, posterUrl: null },
      { seasonNumber: 2, posterUrl: null },
    ]),
    fetchSeriesEpisodesFor: vi.fn(async () => [
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2008-01-20", overview: "" },
      { seasonNumber: 1, episodeNumber: 2, title: "Two", airDate: "2008-01-27", overview: "" },
      { seasonNumber: 2, episodeNumber: 1, title: "Back", airDate: "2009-03-08", overview: "" },
    ]),
  };
});

vi.mock("../src/services/searchOnAdd.js", () => ({ queueSearchAfterAdd: vi.fn(), searchOnAddEnabled: () => false }));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let searchAfterAdd: ReturnType<typeof vi.fn>;
let metadata: typeof import("../src/services/metadata.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  searchAfterAdd = vi.mocked((await import("../src/services/searchOnAdd.js")).queueSearchAfterAdd);
  metadata = await import("../src/services/metadata.js");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const post = (url: string, body: unknown) => request(app).post(url).set("X-Api-Key", apiKey).send(body as object);

async function folder(pathName: string, type: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(pathName, type)).lastInsertRowid);
}

let profileId: number;

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "sub_items", "media_item_tags", "media_item_titles", "media_items", "root_folders", "import_exclusions"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  profileId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
  searchAfterAdd.mockClear();
  await folder("/tv", "series");
  await folder("/anime", "anime");
  await folder("/movies", "movie");
});

const seriesBody = (over: Record<string, unknown> = {}) => ({
  tvdbId: 81189,
  title: "Test Show",
  qualityProfileId: profileId,
  languageProfileId: 1,
  seasons: [
    { seasonNumber: 0, monitored: false },
    { seasonNumber: 1, monitored: true },
    { seasonNumber: 2, monitored: false },
  ],
  tags: [],
  seasonFolder: true,
  monitored: true,
  rootFolderPath: "/tv",
  seriesType: "standard",
  addOptions: { ignoreEpisodesWithFiles: true, ignoreEpisodesWithoutFiles: false, searchForMissingEpisodes: false },
  ...over,
});

describe("looking a title up", () => {
  it("finds a series by tvdb id, with its seasons and no library id yet", async () => {
    const res = await get("/sonarr/api/v3/series/lookup?term=tvdb:81189");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 0, title: "Test Show", tvdbId: 81189, tmdbId: 1396, imdbId: "tt0903747", year: 2008, status: "ended", seriesType: "standard" });
    expect(res.body[0].seasons.map((s: any) => s.seasonNumber)).toEqual([0, 1, 2]);
    expect(res.body[0].images[0]).toMatchObject({ coverType: "poster", remoteUrl: "https://img.example/poster.jpg" });
  });

  it("finds by title, and answers an empty list when nothing is found", async () => {
    expect((await get("/sonarr/api/v3/series/lookup?term=test%20show")).body[0].title).toBe("Test Show");
    expect((await get("/sonarr/api/v3/series/lookup?term=zzz")).body).toEqual([]);
    expect((await get("/sonarr/api/v3/series/lookup?term=tvdb:1")).body).toEqual([]);
    expect((await get("/sonarr/api/v3/series/lookup")).status).toBe(400);
  });

  it("finds a movie by tmdb or imdb id", async () => {
    expect((await get("/radarr/api/v3/movie/lookup?term=tmdb:603")).body[0]).toMatchObject({ id: 0, title: "Test Movie", tmdbId: 603, titleSlug: "603", hasFile: false });
    expect((await get("/radarr/api/v3/movie/lookup/tmdb?tmdbId=603")).body.title).toBe("Test Movie");
    expect((await get("/radarr/api/v3/movie/lookup/imdb?imdbId=tt0133093")).body.title).toBe("Test Movie");
    expect((await get("/radarr/api/v3/movie/lookup/tmdb?tmdbId=1")).status).toBe(404);
  });
});

describe("adding a series as Overseerr does", () => {
  it("adds it with the seasons asked for and answers the series", async () => {
    const res = await post("/sonarr/api/v3/series", seriesBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Test Show", tvdbId: 81189, tmdbId: 1396, monitored: true, qualityProfileId: profileId, rootFolderPath: "/tv" });
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body.seasons.map((s: any) => [s.seasonNumber, s.monitored])).toEqual([[1, true], [2, false]]);
    expect(res.body.statistics).toMatchObject({ totalEpisodeCount: 3 });

    const row = (await db.prepare("SELECT type, root_folder_id, quality_profile_id FROM media_items WHERE id = ?").get(res.body.id)) as any;
    expect(row.type).toBe("series");
    expect(Number(row.quality_profile_id)).toBe(profileId);
    const episodes = (await db.prepare("SELECT season_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(res.body.id)) as any[];
    expect(episodes.map((e) => [Number(e.season_number), Number(e.monitored)])).toEqual([[1, 1], [1, 1], [2, 0]]);

    // Now the lookup knows it, as Overseerr relies on.
    const looked = (await get("/sonarr/api/v3/series/lookup?term=tvdb:81189")).body[0];
    expect(looked.id).toBe(res.body.id);
  });

  it("refuses a second add of the same series", async () => {
    await post("/sonarr/api/v3/series", seriesBody());
    const again = await post("/sonarr/api/v3/series", seriesBody());
    expect(again.status).toBe(400);
    expect(again.body[0]).toMatchObject({ propertyName: "TvdbId", errorMessage: "This series has already been added" });
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(1);
    // The same series named by its tmdb id is the same series.
    const byTmdb = await post("/sonarr/api/v3/series", { ...seriesBody(), tvdbId: 0, tmdbId: 1396 });
    expect(byTmdb.status).toBe(400);
  });

  it("refuses an id no provider knows, an add without an id, and a root folder that is not Sonarr's", async () => {
    const unknown = await post("/sonarr/api/v3/series", seriesBody({ tvdbId: 5 }));
    expect(unknown.status).toBe(400);
    expect(unknown.body[0].errorMessage).toMatch(/No series was found/);
    expect((await post("/sonarr/api/v3/series", { title: "No id" })).body[0].propertyName).toBe("TvdbId");
    const wrongFolder = await post("/sonarr/api/v3/series", seriesBody({ rootFolderPath: "/movies" }));
    expect(wrongFolder.status).toBe(400);
    expect(wrongFolder.body[0].propertyName).toBe("RootFolderPath");
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(0);
  });

  it("adds an anime when the root folder is an anime folder", async () => {
    const res = await post("/sonarr/api/v3/series", seriesBody({ rootFolderPath: "/anime", seriesType: "anime" }));
    expect(res.status).toBe(201);
    expect(((await db.prepare("SELECT type, series_type FROM media_items WHERE id = ?").get(res.body.id)) as any)).toMatchObject({ type: "anime", series_type: "anime" });
    expect(res.body.seriesType).toBe("anime");
  });

  it("takes a Monitor option over the seasons", async () => {
    const res = await post("/sonarr/api/v3/series", seriesBody({ addOptions: { monitor: "none" } }));
    expect(res.status).toBe(201);
    const monitored = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND monitored = 1").get(res.body.id)) as any;
    expect(Number(monitored.c)).toBe(0);
  });

  it.each(["all", "future", "missing", "existing", "firstSeason", "lastSeason", "pilot", "recent", "monitorSpecials", "unmonitorSpecials", "none", "skip", "unknown"])(
    "adds a series with Sonarr's own Monitor option %s",
    async (option) => {
      await db.prepare("DELETE FROM media_items").run();
      const res = await post("/sonarr/api/v3/series", seriesBody({ addOptions: { monitor: option } }));
      expect(res.status, option).toBe(201);
    }
  );

  it("ignores a Monitor option it does not know, and then follows the seasons asked for", async () => {
    const res = await post("/sonarr/api/v3/series", seriesBody({ addOptions: { monitor: "everything" } }));
    expect(res.status).toBe(201);
    expect(res.body.seasons.map((s: any) => [s.seasonNumber, s.monitored])).toEqual([[1, true], [2, false]]);
  });

  it("adds it unmonitored and tags it when asked", async () => {
    const tag = (await post("/sonarr/api/v3/tag", { label: "requested" })).body.id;
    const res = await post("/sonarr/api/v3/series", seriesBody({ monitored: false, tags: [tag] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ monitored: false, tags: [tag] });
  });
});

describe("adding a movie", () => {
  const movieBody = (over: Record<string, unknown> = {}) => ({
    tmdbId: 603,
    title: "Test Movie",
    year: 1999,
    qualityProfileId: profileId,
    minimumAvailability: "released",
    rootFolderPath: "/movies",
    monitored: true,
    tags: [],
    addOptions: { searchForMovie: false },
    ...over,
  });

  it("adds it with the availability asked for", async () => {
    const res = await post("/radarr/api/v3/movie", movieBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Test Movie", tmdbId: 603, imdbId: "tt0133093", minimumAvailability: "released", monitored: true, rootFolderPath: "/movies", runtime: 136 });
    expect((await get("/radarr/api/v3/movie/lookup?term=tmdb:603")).body[0].id).toBe(res.body.id);
  });

  it.each(["movieOnly", "movieAndCollection"])("adds a movie with Radarr's Monitor option %s, monitored", async (option) => {
    const res = await post("/radarr/api/v3/movie", movieBody({ addOptions: { monitor: option } }));
    expect(res.status).toBe(201);
    expect(res.body.monitored).toBe(true);
  });

  it("adds a movie unmonitored with the Monitor option none", async () => {
    const res = await post("/radarr/api/v3/movie", movieBody({ addOptions: { monitor: "none" } }));
    expect(res.status).toBe(201);
    expect(res.body.monitored).toBe(false);
  });

  it("refuses it twice, and an add that names no tmdb id", async () => {
    await post("/radarr/api/v3/movie", movieBody());
    const again = await post("/radarr/api/v3/movie", movieBody());
    expect(again.status).toBe(400);
    expect(again.body[0]).toMatchObject({ propertyName: "TmdbId", errorMessage: "This movie has already been added" });
    expect((await post("/radarr/api/v3/movie", { title: "x" })).body[0].propertyName).toBe("TmdbId");
  });

  it("is not a Sonarr and a Radarr at once", async () => {
    expect((await post("/sonarr/api/v3/movie", movieBody())).status).toBe(404);
    expect((await post("/radarr/api/v3/series", seriesBody())).status).toBe(404);
  });
});

describe("what an add or an edit names has to exist", () => {
  it("refuses a quality profile, a tag and an enum value that are not there, as a validation list and not a server error", async () => {
    const profile = await post("/sonarr/api/v3/series", seriesBody({ qualityProfileId: 999999 }));
    expect(profile.status).toBe(400);
    expect(profile.body[0].propertyName).toBe("QualityProfileId");
    expect((await post("/sonarr/api/v3/series", seriesBody({ seriesType: "bogus" }))).body[0].propertyName).toBe("SeriesType");
    expect((await post("/radarr/api/v3/movie", { tmdbId: 603, title: "x", rootFolderPath: "/movies", minimumAvailability: "nonsense" })).body[0].propertyName).toBe("MinimumAvailability");

    const added = await post("/sonarr/api/v3/series", seriesBody());
    const tag = await request(app).put(`/sonarr/api/v3/series/${added.body.id}`).set("X-Api-Key", apiKey).send({ id: added.body.id, tags: [99999] });
    expect(tag.status).toBe(400);
    expect(tag.body[0]).toMatchObject({ propertyName: "Tags", errorMessage: "Tag 99999 does not exist" });
    expect((await request(app).put(`/sonarr/api/v3/series/${added.body.id}`).set("X-Api-Key", apiKey).send({ id: added.body.id, seriesType: "bogus" })).status).toBe(400);
    expect(await get(`/sonarr/api/v3/series/99999999999`).then((r) => r.status)).toBe(404);
  });
});

describe("adding the same title twice at once", () => {
  it("makes one series and refuses the other request", async () => {
    const [first, second] = await Promise.all([post("/sonarr/api/v3/series", seriesBody()), post("/sonarr/api/v3/series", seriesBody())]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(1);
  });
});

describe("searching after an add", () => {
  it("waits for the disk scan: the search is the one that skips a title already on disk", async () => {
    const quiet = await post("/sonarr/api/v3/series", seriesBody({ addOptions: { searchForMissingEpisodes: false } }));
    expect(searchAfterAdd).not.toHaveBeenCalled();
    await db.prepare("DELETE FROM media_items WHERE id = ?").run(quiet.body.id);
    const res = await post("/sonarr/api/v3/series", seriesBody({ addOptions: { searchForMissingEpisodes: true } }));
    expect(searchAfterAdd).toHaveBeenCalledWith(res.body.id);

    searchAfterAdd.mockClear();
    const unmonitored = await post("/radarr/api/v3/movie", { tmdbId: 603, title: "x", qualityProfileId: profileId, rootFolderPath: "/movies", monitored: false, addOptions: { searchForMovie: true } });
    expect(unmonitored.status).toBe(201);
    expect(searchAfterAdd).not.toHaveBeenCalled();
  });
});

describe("a lookup of a title the library has", () => {
  it("answers it with its id even when the metadata provider is down", async () => {
    const added = await post("/sonarr/api/v3/series", seriesBody());
    vi.mocked(metadata.fetchByExternalId).mockRejectedValue(new Error("provider down"));
    try {
      const found = await get("/sonarr/api/v3/series/lookup?term=tvdb:81189");
      expect(found.body).toHaveLength(1);
      expect(found.body[0].id).toBe(added.body.id);
      expect((await get("/sonarr/api/v3/series/lookup?term=tvdb:5")).body).toEqual([]);
    } finally {
      vi.mocked(metadata.fetchByExternalId).mockReset();
      vi.mocked(metadata.fetchByExternalId).mockImplementation(async (type: string, provider: string, id: string) => {
        if (type === "series" && ((provider === "tvdb" && id === "81189") || (provider === "tmdb" && id === "1396") || (provider === "imdb" && id === "tt0903747"))) return SHOW as any;
        if (type === "movie" && ((provider === "tmdb" && id === "603") || (provider === "imdb" && id === "tt0133093"))) return MOVIE as any;
        throw new Error(`No ${type} with ${provider} id ${id}`);
      });
    }
  });
});

describe("removing a title", () => {
  it("removes it, and keeps it from coming back when asked", async () => {
    const added = await post("/radarr/api/v3/movie", {
      tmdbId: 603,
      title: "Test Movie",
      qualityProfileId: profileId,
      rootFolderPath: "/movies",
      monitored: true,
      addOptions: {},
    });
    const res = await request(app).delete(`/radarr/api/v3/movie/${added.body.id}?deleteFiles=false&addImportExclusion=true`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM media_items WHERE id = ?").get(added.body.id)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM import_exclusions").get()) as any).c)).toBe(1);
  });
});
