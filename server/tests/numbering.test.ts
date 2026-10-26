import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { parseReleaseTitle, releaseMatchesEpisode, type SceneIndex } from "../src/services/releaseParser.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let sched: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  sched = await import("../src/services/scheduler.js");
  const { loadQualityCaches } = await import("../src/services/quality.js");
  await loadQualityCaches();
});

describe("a pack belongs to its scene season (Round 12, I8)", () => {
  const pack = parseReleaseTitle("Show.Name.S01.1080p.BluRay.x264-GRP");
  // XEM splits TVDB S01 (8 episodes) into scene S01 E01-E04 and S02 E01-E04.
  const sceneIndex: SceneIndex = new Map([
    ["2:1", "1:5"],
    ["2:2", "1:6"],
  ]);

  it("does not match an aired S01 episode that the scene calls S02", () => {
    expect(releaseMatchesEpisode(pack, 1, 5, 2, 1, null, sceneIndex)).toBe(false);
  });

  it("matches the episodes that scene season holds", () => {
    expect(releaseMatchesEpisode(pack, 1, 2, 1, 2, null, sceneIndex)).toBe(true);
  });

  it("still matches by the aired season where the show has no scene numbering", () => {
    expect(releaseMatchesEpisode(pack, 1, 5)).toBe(true);
    expect(releaseMatchesEpisode(pack, 2, 5)).toBe(false);
  });

  it("a single-episode release keeps matching either numbering", () => {
    expect(releaseMatchesEpisode(parseReleaseTitle("Show.Name.S02E01.1080p.WEB-DL-GRP"), 1, 5, 2, 1, null, sceneIndex)).toBe(true);
  });
});

describe("absolute numbers and batches (Round 12, P16, P17)", () => {
  it("matches an episode by the absolute number a release names in any of its forms", () => {
    for (const title of ["Series Title EP06 720p x265 AOZ.mp4", "Series Title Episode 6 [VOSTFR][720p]", "[Shark-Raws] Series Title #6 [1080p]"]) {
      expect(releaseMatchesEpisode(parseReleaseTitle(title), 1, 6, null, null, 6), title).toBe(true);
      expect(releaseMatchesEpisode(parseReleaseTitle(title), 1, 7, null, null, 7), title).toBe(false);
    }
  });

  it("a special numbered like an episode is no episode", () => {
    const ova = parseReleaseTitle("[DeadFish] Another Anime Show - 01 - OVA [BD][720p]");
    expect(releaseMatchesEpisode(ova, 1, 1, null, null, 1)).toBe(false);
    expect(ova.isSpecial).toBe(true);
  });

  it("reads an episode list first to last", () => {
    expect(parseReleaseTitle("Series.S02E03-04-05.720p.BluRay-FUTV").episodeNumbers).toEqual([3, 4, 5]);
    expect(parseReleaseTitle("Series.S03E01.S03E02.720p.HDTV.x264-GRP").episodeNumbers).toEqual([1, 2]);
    // Another season's tag is not part of the list.
    expect(parseReleaseTitle("Series.S03E01.S04E02.720p.HDTV.x264-GRP").episodeNumbers).toEqual([1]);
    // A resolution after the dash is no episode.
    expect(parseReleaseTitle("Series.S03E05-1080p.WEB-DL-GRP").episodeNumbers).toEqual([5]);
  });
});

describe("isAlreadyQueued — a multi-episode release covers its siblings (Round 12, I12)", () => {
  it("sees the second episode of a two-episode release queued against the first", async () => {
    const showId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Multi Show', 'multi show', 1, 0, 'unknown')").run()).lastInsertRowid);
    const ep = async (n: number) =>
      Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, ?, 1, 0)").run(showId, n)).lastInsertRowid);
    const [e1, e2, e3] = [await ep(1), await ep(2), await ep(3)];
    await db.prepare("INSERT INTO queue (media_item_id, episode_id, title, status) VALUES (?, ?, 'Multi.Show.S01E01E02.1080p.WEB-DL-GRP', 'queued')").run(showId, e1);
    expect(await sched.isAlreadyQueued(showId, e1, null)).toBe(true);
    expect(await sched.isAlreadyQueued(showId, e2, null)).toBe(true);
    expect(await sched.isAlreadyQueued(showId, e3, null)).toBe(false);
  });
});

describe("a daily show's release may be numbered (Round 12, I17)", () => {
  const choose = (title: string) =>
    sched.chooseBestResult(
      [{ indexerId: null, indexerName: "T", title, size: 1_000_000_000, seeders: 10, leechers: 1, publishDate: new Date(Date.now() - 86_400_000 * 30).toISOString(), downloadUrl: "magnet:?xt=urn:btih:1", protocol: "torrent", category: null }],
      [],
      "",
      null,
      0,
      { airDate: "2024-08-25", season: 2024, episode: 123 },
      new Set(),
      "series"
    );

  it("takes the release by date or by its season and episode, and refuses another day", async () => {
    expect(await choose("Late.Night.2024.08.25.1080p.WEB-DL-GRP")).not.toBeNull();
    expect(await choose("Late.Night.S2024E123.1080p.WEB-DL-GRP")).not.toBeNull();
    expect(await choose("Late.Night.2024.08.26.1080p.WEB-DL-GRP")).toBeNull();
    expect(await choose("Late.Night.S2024E124.1080p.WEB-DL-GRP")).toBeNull();
  });
});

describe("a pack's files are placed by the scene's numbering first (Round 12, I9)", () => {
  it("puts the scene's S02E01 on the aired S01E05, and leaves another season's file unmatched", async () => {
    const { planSeasonPackFiles } = await import("../src/services/importer.js");
    const ep = (n: number, scene: [number, number] | null) => ({
      id: n,
      episode_number: n,
      season_number: 1,
      scene_season_number: scene?.[0] ?? null,
      scene_episode_number: scene?.[1] ?? null,
      air_date: null,
    });
    const episodes = [ep(1, [1, 1]), ep(2, [1, 2]), ep(3, [1, 3]), ep(4, [1, 4]), ep(5, [2, 1]), ep(6, [2, 2])];
    const plan = await planSeasonPackFiles(
      ["/dl/Show.S01.1080p/Show.S01E02.mkv", "/dl/Show.S01.1080p/Show.S02E01.mkv", "/dl/Show.S01.1080p/Show.S02E02.mkv", "/dl/Show.S01.1080p/Show.S03E01.mkv"],
      episodes,
      1,
      1,
      "Show"
    );
    const placed = Object.fromEntries(plan.plans.map((p) => [p.src.split("/").pop(), p.episodes.map((e: any) => e.episode_number)]));
    expect(placed).toEqual({ "Show.S01E02.mkv": [2], "Show.S02E01.mkv": [5], "Show.S02E02.mkv": [6] });
    expect(plan.unmatchedCount).toBe(1);
  });

  it("keeps reading the aired numbers for a show with no scene numbering", async () => {
    const { planSeasonPackFiles } = await import("../src/services/importer.js");
    const episodes = [1, 2].map((n) => ({ id: n, episode_number: n, season_number: 1, scene_season_number: null, scene_episode_number: null, air_date: null }));
    const plan = await planSeasonPackFiles(["/dl/Show.S01/Show.S01E02.mkv"], episodes, 1, 1, "Show");
    expect(plan.plans.map((p) => p.episodes.map((e: any) => e.episode_number))).toEqual([[2]]);
  });
});
