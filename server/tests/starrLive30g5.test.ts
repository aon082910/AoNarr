import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * Defects the Round 30g live run found with the real tools (Jellyseerr 2.7.3's own Radarr/Sonarr client code run against a
 * running AoNarr). The bodies below are the ones the tool sent, captured from that run.
 */

// What AoNarr's TheTVDB provider returns for a show: the TVDB id and nothing else (no TMDB id, so no TMDB season list).
const SHOW = { title: "Breaking Bad", year: 2008, overview: "A show.", posterUrl: "https://img.example/tvdb.jpg", externalIds: { tvdb: "81189" }, status: "Ended" };
// Season 0 (specials) and three seasons, as the TheTVDB episode list gave them.
const EPISODES = [
  { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2008-01-15", overview: "" },
  { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2009-01-15", overview: "" },
  { seasonNumber: 1, episodeNumber: 2, title: "Two", airDate: "2009-02-15", overview: "" },
  { seasonNumber: 2, episodeNumber: 1, title: "Back", airDate: "2010-01-15", overview: "" },
  { seasonNumber: 3, episodeNumber: 1, title: "Again", airDate: "2011-01-15", overview: "" },
];

vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchByExternalId: vi.fn(async (type: string, provider: string, id: string) => {
      if (type === "series" && provider === "tvdb" && id === "81189") return SHOW;
      throw new Error(`No ${type} with ${provider} id ${id}`);
    }),
    searchMetadata: vi.fn(async (_type: string, term: string) => (/breaking/i.test(term) ? [SHOW] : [])),
    // fetchSeriesSeasonsFor stays the real one: with no TMDB id it lists nothing, as it does for the live TVDB result.
    fetchSeriesEpisodesFor: vi.fn(async () => EPISODES),
  };
});
// The targets a command hands to the bulk search (the route behind POST /api/search/bulk), so a test can see what would be searched.
const bulkSearch = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("../src/services/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/scheduler.js")>()),
  searchAndGrabTargets: (...args: unknown[]) => bulkSearch(...args),
}));
vi.mock("../src/services/searchOnAdd.js", () => ({ queueSearchAfterAdd: vi.fn(), searchOnAddEnabled: () => false }));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let metadata: typeof import("../src/services/metadata.js");
let jobs: typeof import("../src/services/jobRegistry.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  metadata = await import("../src/services/metadata.js");
  jobs = await import("../src/services/jobRegistry.js");
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const send = (method: "post" | "put", url: string, body: unknown) => request(app)[method](url).set("X-Api-Key", apiKey).send(body as object);

describe("Jellyseerr's download tracker: RefreshMonitoredDownloads", () => {
  let releasePoll: () => void;
  let polls = 0;

  beforeAll(() => {
    // The job registry the scheduler fills at startup is empty in a test: a poll that counts its runs and can be held open.
    jobs.registerJob({
      key: "queuePoll",
      name: "Queue poll",
      scheduleType: "interval",
      defaultSchedule: "3600",
      run: async () => {
        polls++;
        await new Promise<void>((resolve) => (releasePoll = resolve));
      },
    });
  });

  it("is accepted on all four apps and runs the queue check once, however many ask while it runs", async () => {
    // Jellyseerr sends this before every read of the queue (each minute) and does not read the queue when it is refused.
    for (const [app4, version] of [["sonarr", "v3"], ["radarr", "v3"], ["lidarr", "v1"], ["readarr", "v1"]] as const) {
      const before = polls;
      const res = await send("post", `/${app4}/api/${version}/command`, { name: "RefreshMonitoredDownloads" });
      expect(res.status, app4).toBe(201);
      expect(res.body).toMatchObject({ name: "RefreshMonitoredDownloads", commandName: "Refresh Monitored Downloads" });
      await vi.waitFor(() => expect(polls).toBe(before + 1));
      // A second command while the poll is still running is not an error either.
      const second = await send("post", `/${app4}/api/${version}/command`, { name: "RefreshMonitoredDownloads" });
      expect(second.status, app4).toBe(201);
      expect(polls).toBe(before + 1);
      releasePoll();
      await vi.waitFor(async () => expect((await get(`/${app4}/api/${version}/command/${res.body.id}`)).body.status).toBe("completed"));
      // The job is idle again before the next app asks.
      await vi.waitFor(() => expect(jobs.listJobs().find((j) => j.key === "queuePoll")?.running).toBe(false));
    }
  });
});

describe("Jellyseerr's request for a show known only by its TVDB id", () => {
  beforeEach(async () => {
    for (const t of ["history", "queue", "episodes", "sub_items", "media_item_tags", "media_item_titles", "media_items", "root_folders", "import_exclusions"]) {
      await db.prepare(`DELETE FROM ${t}`).run();
    }
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/tv', 'series')").run();
    vi.mocked(metadata.fetchSeriesEpisodesFor).mockClear();
  });

  // Jellyseerr's SonarrAPI.addSeries(): the seasons come from the lookup (all marked unmonitored first), then the ones requested are marked.
  const requestSeasons = async (requested: number[]) => {
    const lookup = (await get("/sonarr/api/v3/series/lookup?term=tvdb:81189")).body[0];
    const profileId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
    const seasons = (lookup.seasons as { seasonNumber: number }[]).map((s) => ({ seasonNumber: s.seasonNumber, monitored: requested.includes(s.seasonNumber) }));
    return {
      lookup,
      res: await send("post", "/sonarr/api/v3/series", {
        tvdbId: 81189,
        title: "Breaking Bad",
        qualityProfileId: profileId,
        languageProfileId: 1,
        seasons,
        tags: [],
        seasonFolder: true,
        monitored: true,
        rootFolderPath: "/tv",
        seriesType: "standard",
        addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
      }),
    };
  };

  it("lists the show's seasons off its episode list when only a TVDB id is known", async () => {
    const { body } = await get("/sonarr/api/v3/series/lookup?term=tvdb:81189");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 0, tvdbId: 81189, title: "Breaking Bad" });
    // Season 0 is listed and unmonitored, as Sonarr lists it.
    expect(body[0].seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
      { seasonNumber: 3, monitored: true },
    ]);
    expect(body[0].statistics.seasonCount).toBe(3);
  });

  it("adds only the seasons requested (the empty list Jellyseerr used to get made every season monitored)", async () => {
    const { res } = await requestSeasons([1, 2]);
    expect(res.status).toBe(201);
    expect(res.body.seasons.map((s: any) => [s.seasonNumber, s.monitored])).toEqual([[0, false], [1, true], [2, true], [3, false]]);
    const monitored = (await db.prepare("SELECT season_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(res.body.id)) as any[];
    expect(monitored.map((e) => [Number(e.season_number), Number(e.monitored)])).toEqual([[0, 0], [1, 1], [1, 1], [2, 1], [3, 0]]);
  });

  it("does not read an episode list for each hit of a title search", async () => {
    const { body } = await get("/sonarr/api/v3/series/lookup?term=breaking%20bad");
    expect(body).toHaveLength(1);
    expect(body[0].seasons).toEqual([]);
    expect(metadata.fetchSeriesEpisodesFor).not.toHaveBeenCalled();
  });
});

describe("Overseerr's and Jellyseerr's search after an add: the missing-search commands for one title", () => {
  const insertId = async (sql: string, ...params: unknown[]) => Number((await db.prepare(sql).run(...params)).lastInsertRowid);
  const title = (type: string, name: string) =>
    insertId("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'unknown')", type, name, name.toLowerCase());
  const episode = (show: number, season: number, number: number, airDate: string, over: { monitored?: number; hasFile?: number } = {}) =>
    insertId("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, ?, ?, ?, ?, ?, ?)", show, season, number, `E${number}`, airDate, over.monitored ?? 1, over.hasFile ?? 0);
  const part = (parent: number, name: string, over: { monitored?: number; hasFile?: number } = {}) =>
    insertId("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, '2001-05-05', ?, ?)", parent, name, over.monitored ?? 1, over.hasFile ?? 0);
  const searched = () => bulkSearch.mock.calls.flatMap((call) => call[0] as { mediaItemId: number; episodeId?: number; subItemId?: number }[]);

  let showA: number;
  let showB: number;
  let episodesA: number[];
  let episodesB: number[];

  beforeEach(async () => {
    for (const t of ["history", "queue", "episodes", "sub_items", "media_item_tags", "media_item_titles", "media_items"]) await db.prepare(`DELETE FROM ${t}`).run();
    bulkSearch.mockClear();
    showA = await title("series", "Breaking Bad");
    showB = await title("series", "The Wire");
    episodesA = [await episode(showA, 1, 1, "2009-01-15"), await episode(showA, 1, 2, "2009-02-15")];
    // One has its file, one is not monitored, one has not aired: none of them is missing.
    await episode(showA, 1, 3, "2009-03-15", { hasFile: 1 });
    await episode(showA, 2, 1, "2010-01-15", { monitored: 0 });
    await episode(showA, 2, 2, "2999-01-15");
    episodesB = [await episode(showB, 1, 1, "2002-06-02"), await episode(showB, 1, 2, "2002-06-09"), await episode(showB, 1, 3, "2002-06-16")];
  });

  it("searches only the series named by seriesId (Jellyseerr sends MissingEpisodeSearch {seriesId} after adding one show)", async () => {
    const res = await send("post", "/sonarr/api/v3/command", { name: "MissingEpisodeSearch", seriesId: showA });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(searched().length).toBeGreaterThan(0));
    expect(searched().map((t) => t.episodeId).sort()).toEqual([...episodesA].sort());
    expect(searched().every((t) => t.mediaItemId === showA)).toBe(true);
  });

  it("still searches every missing episode when no series is named, as Sonarr does", async () => {
    await send("post", "/sonarr/api/v3/command", { name: "MissingEpisodeSearch" });
    await vi.waitFor(() => expect(searched().length).toBe(episodesA.length + episodesB.length));
    expect(new Set(searched().map((t) => t.mediaItemId))).toEqual(new Set([showA, showB]));
  });

  it("answers 404 for a title that is not this app's, and searches nothing", async () => {
    const movie = await title("movie", "A Movie");
    const res = await send("post", "/sonarr/api/v3/command", { name: "MissingEpisodeSearch", seriesId: movie });
    expect(res.status).toBe(404);
    expect((await send("post", "/sonarr/api/v3/command", { name: "MissingEpisodeSearch", seriesId: 999999 })).status).toBe(404);
    expect(bulkSearch).not.toHaveBeenCalled();
  });

  it("does the same for one artist's albums and one author's books", async () => {
    const artist = await title("artist", "Queen");
    const otherArtist = await title("artist", "Abba");
    const album = await part(artist, "Innuendo");
    await part(artist, "Have it", { hasFile: 1 });
    await part(otherArtist, "Waterloo");
    const author = await title("author", "Tolkien");
    const otherAuthor = await title("author", "Herbert");
    const book = await part(author, "The Hobbit");
    await part(otherAuthor, "Dune");

    expect((await send("post", "/lidarr/api/v1/command", { name: "MissingAlbumSearch", artistId: artist })).status).toBe(201);
    await vi.waitFor(() => expect(searched().length).toBe(1));
    expect(searched()).toEqual([{ mediaItemId: artist, subItemId: album }]);

    bulkSearch.mockClear();
    expect((await send("post", "/readarr/api/v1/command", { name: "MissingBookSearch", authorId: author })).status).toBe(201);
    await vi.waitFor(() => expect(searched().length).toBe(1));
    expect(searched()).toEqual([{ mediaItemId: author, subItemId: book }]);
  });
});
