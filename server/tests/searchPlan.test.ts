import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { mediaItemFromRow } from "../src/db/mappers.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let plans: typeof import("../src/services/searchPlan.js");
let aliases: typeof import("../src/services/releaseAliases.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  plans = await import("../src/services/searchPlan.js");
  aliases = await import("../src/services/releaseAliases.js");
});

async function insertItem(type: string, title: string, opts: { year?: number | null; ids?: Record<string, string>; seriesType?: string } = {}) {
  const id = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, external_ids, series_type) VALUES (?, ?, ?, ?, 1, 0, 'missing', ?, ?)")
        .run(type, title, title.toLowerCase(), opts.year ?? null, opts.ids ? JSON.stringify(opts.ids) : null, opts.seriesType ?? "standard")
    ).lastInsertRowid
  );
  return mediaItemFromRow(await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id));
}

async function insertEpisode(itemId: number, season: number, episode: number, extra: { sceneSeason?: number; sceneEpisode?: number; airDate?: string; title?: string } = {}) {
  const id = Number(
    (
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, air_date, title, monitored, has_file) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)"
        )
        .run(itemId, season, episode, extra.sceneSeason ?? null, extra.sceneEpisode ?? null, extra.airDate ?? null, extra.title ?? "Ep")
    ).lastInsertRowid
  );
  return (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(id)) as any;
}

describe("episodePlanFor", () => {
  it("asks for an episode by the clean title and the scene's numbers, by the show's tvdb id alone", async () => {
    const show = await insertItem("series", "The Office (US)", { year: 2005, ids: { tvdb: "73244", imdb: "tt0386676", tmdb: "2316" } });
    await aliases.storeAliases(show.id, ["Das Büro"], "tmdb_alt");
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 3, 1, { sceneSeason: 4, sceneEpisode: 2 }));

    expect(plan.query).toBe("Office US S04E02");
    expect(plan.alternateQueries).toEqual(["Office S04E02", "Das Buro S04E02"]);
    expect(plan.ids).toEqual({ tvdb: "73244" });
    expect(plan.hints).toEqual({ season: 4, episode: 2, queryTitle: "Office US" });
    // A release is matched to the scene numbers and, failing those, the aired ones.
    expect(plan.target).toMatchObject({ season: 3, episode: 1, sceneSeason: 4, sceneEpisode: 2 });
  });

  it("asks by the show's imdb and tmdb ids only when it has no tvdb id", async () => {
    const show = await insertItem("series", "No Tvdb", { ids: { imdb: "tt0123456", tmdb: "99", tvmaze: "5" } });
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 1, 1));
    expect(plan.ids).toEqual({ imdb: "tt0123456", tmdb: "99" });
    expect(plans.tvSearchIdsOf(await insertItem("series", "No Ids"))).toEqual({});
  });

  it("asks for a daily show's episode by its date, with the dashed date and the other titles as alternates", async () => {
    const show = await insertItem("series", "The Daily Show", { ids: { tvdb: "71256" }, seriesType: "daily" });
    await aliases.storeAliases(show.id, ["Daily Show With Trevor"], "tmdb_alt");
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 2024, 101, { airDate: "2024-08-25" }));

    expect(plan.query).toBe("Daily Show 2024 08 25");
    expect(plan.alternateQueries).toEqual(["Daily Show 2024-08-25", "Daily Show With Trevor 2024 08 25"]);
    expect(plan.hints).toEqual({ airDate: "2024-08-25", queryTitle: "Daily Show" });
    // The season and episode ride along: a daily show's release is sometimes numbered (Round 12, I17).
    expect(plan.target).toEqual({ airDate: "2024-08-25", season: 2024, episode: 101 });
  });

  it("asks for an anime episode by its absolute number, with the season form beside it", async () => {
    const show = await insertItem("anime", "Jujutsu Kaisen", { ids: { anilist: "113415", tvdb: "377543" } });
    await aliases.storeAliases(show.id, ["Sorcery Fight"], "anilist_synonym");
    for (let n = 1; n <= 24; n++) await insertEpisode(show.id, 1, n);
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 1, 25));

    expect(plan.query).toBe("Jujutsu Kaisen 25");
    expect(plan.alternateQueries).toEqual(["Sorcery Fight 25"]);
    expect(plan.alsoQueries).toEqual(["Jujutsu Kaisen S01E25"]);
    expect(plan.hints).toEqual({ season: 1, episode: 25, absolute: 25, queryTitle: "Jujutsu Kaisen" });
    expect(plan.target).toMatchObject({ season: 1, episode: 25, absoluteEpisode: 25 });
  });

  it("asks for a special by its episode title too", async () => {
    const show = await insertItem("series", "The Office (US)", { ids: { tvdb: "73244" } });
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 0, 3, { title: "The Accountants" }));
    expect(plan.query).toBe("Office US S00E03");
    expect(plan.alternateQueries[0]).toBe("Office US Accountants");
    expect(plan.hints).toMatchObject({ season: 0, episode: 3 });
  });
});

describe("seasonPlanFor", () => {
  it("asks for a season, or for one episode of it", async () => {
    const show = await insertItem("series", "Season Show", { ids: { tvdb: "555" } });
    expect(await plans.seasonPlanFor(show, 2)).toMatchObject({ query: "Season Show S02", ids: { tvdb: "555" }, hints: { season: 2, episode: null }, target: null });
    expect((await plans.seasonPlanFor(show, 2, 7)).query).toBe("Season Show S02E07");
  });
});

describe("singlePlanFor", () => {
  it("asks for a film by its clean title and year, with the other titles and all its ids", async () => {
    const film = await insertItem("movie", "The Matrix", { year: 1999, ids: { imdb: "tt0133093", tmdb: "603" } });
    await aliases.storeAliases(film.id, ["Matrix Reloaded Original"], "tmdb_alt");
    const plan = await plans.singlePlanFor(film);
    expect(plan.query).toBe("Matrix 1999");
    expect(plan.alternateQueries).toEqual(["Matrix Reloaded Original 1999"]);
    expect(plan.ids).toEqual({ imdb: "tt0133093", tmdb: "603" });
    expect(plan.hints).toEqual({});
  });

  it("asks for a ROM by its title alone", async () => {
    const rom = await insertItem("rom", "Super Mario Bros.", { year: 1985, ids: { rawg: "1" } });
    expect((await plans.singlePlanFor(rom)).query).toBe("Super Mario Bros");
  });
});

describe("subItemPlanFor", () => {
  it("asks for a book by its author and main title", async () => {
    const author = await insertItem("author", "Brandon Sanderson");
    const plan = plans.subItemPlanFor(author, { title: "Mistborn: The Final Empire (Mistborn, #1)" });
    expect(plan).toMatchObject({ query: "Brandon Sanderson Mistborn", alternateQueries: ["Mistborn"], ids: {}, target: null });
  });

  it("carries the fields of a typed music or book search", async () => {
    const author = await insertItem("author", "Brandon Sanderson");
    expect(plans.subItemPlanFor(author, { title: "Mistborn: The Final Empire (Mistborn, #1)" }).hints).toEqual({ author: "Brandon Sanderson", bookTitle: "Mistborn" });
    const artist = await insertItem("artist", "Queen");
    expect(plans.subItemPlanFor(artist, { title: "Greatest Hits (Remastered)" }).hints).toEqual({ artist: "Queen", album: "Greatest Hits" });
    const comic = await insertItem("comic", "Saga");
    expect(plans.subItemPlanFor(comic, { title: "#1 - Chapter One" }).hints).toEqual({});
  });

  it("gives a self-titled album its release year", async () => {
    const artist = await insertItem("artist", "Weezer");
    expect(plans.subItemPlanFor(artist, { title: "Weezer", release_date: "2001-05-15" }).query).toBe("Weezer Weezer 2001");
  });
});

describe("episodeNotAired", () => {
  const today = "2026-10-25";
  it("holds back a future episode, and a show's or anime's episode with no air date", () => {
    expect(plans.episodeNotAired({ type: "series", seriesType: "standard" }, { air_date: "2026-10-26" }, today)).toBe(true);
    expect(plans.episodeNotAired({ type: "series", seriesType: "standard" }, { air_date: "2026-10-25" }, today)).toBe(false);
    expect(plans.episodeNotAired({ type: "series", seriesType: "standard" }, { air_date: "2020-01-01T00:00:00Z" }, today)).toBe(false);
    expect(plans.episodeNotAired({ type: "series", seriesType: "standard" }, { air_date: null }, today)).toBe(true);
    expect(plans.episodeNotAired({ type: "anime", seriesType: "anime" }, {}, today)).toBe(true);
    expect(plans.episodeNotAired({ type: "series", seriesType: "daily" }, { air_date: null }, today)).toBe(true);
  });

  it("does not hold back a course's or an adult site's undated episode, which have no dates by nature", () => {
    expect(plans.episodeNotAired({ type: "course", seriesType: "standard" }, { air_date: null }, today)).toBe(false);
    expect(plans.episodeNotAired({ type: "adult", seriesType: "standard" }, { air_date: null }, today)).toBe(false);
  });
});

describe("searchHintsOf", () => {
  it("is the plan's typed-search hints with its other queries", async () => {
    const show = await insertItem("series", "Hints Show", { ids: { tvdb: "9" } });
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 1, 2));
    expect(plans.searchHintsOf(plan)).toEqual({ season: 1, episode: 2, queryTitle: "Hints Show", alternateQueries: [] });
    const anime = await insertItem("anime", "Hints Anime");
    expect(plans.searchHintsOf(await plans.episodePlanFor(anime, await insertEpisode(anime.id, 1, 1)))).toMatchObject({ absolute: 1, alsoQueries: ["Hints Anime S01E01"] });
  });
});

describe("the punctuation of a title", () => {
  it("asks for S.W.A.T. as SWAT and, where that finds nothing, as S W A T", async () => {
    const show = await insertItem("series", "S.W.A.T.", { ids: { tvdb: "313086" } });
    const plan = await plans.episodePlanFor(show, await insertEpisode(show.id, 1, 5));
    expect(plan.query).toBe("SWAT S01E05");
    expect(plan.alternateQueries[0]).toBe("S W A T S01E05");

    const film = await insertItem("movie", "Evangelion: 3.0 You Can (Not) Redo", { year: 2012 });
    const filmPlan = await plans.singlePlanFor(film);
    expect(filmPlan.query).toBe("Evangelion 30 You Can Not Redo 2012");
    expect(filmPlan.alternateQueries[0]).toBe("Evangelion 3 0 You Can Not Redo 2012");
  });
});

describe("episodes with no air date", () => {
  const today = "2026-10-25";
  const series = { type: "series", seriesType: "standard" } as const;
  const episodes = [
    { season_number: 1, episode_number: 1, air_date: null },
    { season_number: 1, episode_number: 2, air_date: "2020-01-02" },
    { season_number: 1, episode_number: 3, air_date: null },
    { season_number: 2, episode_number: 1, air_date: null },
    { season_number: 3, episode_number: 1, air_date: "2030-01-01" },
  ];

  it("finds the last episode of each season that has aired", () => {
    expect([...plans.airedFrontierOf(episodes, today)]).toEqual([[1, 2]]);
  });

  it("takes an undated episode before the last one that aired as aired, and the ones after it as not", () => {
    const frontier = plans.airedFrontierOf(episodes, today);
    expect(plans.episodeNotAired(series, episodes[0], today, frontier)).toBe(false);
    expect(plans.episodeNotAired(series, episodes[2], today, frontier)).toBe(true);
    expect(plans.episodeNotAired(series, episodes[3], today, frontier)).toBe(true);
    // Without any aired episode to go by an undated one is not aired.
    expect(plans.episodeNotAired(series, episodes[0], today)).toBe(true);
  });

  it("takes an undated episode of an earlier season as aired once a later season has", () => {
    const frontier = plans.airedFrontierOf([...episodes, { season_number: 2, episode_number: 5, air_date: "2021-01-01" }], today);
    expect(plans.episodeNotAired(series, { season_number: 1, episode_number: 9, air_date: null }, today, frontier)).toBe(false);
  });

  it("never takes a daily show's undated episode as aired: there is no date to search by", () => {
    const frontier = plans.airedFrontierOf(episodes, today);
    expect(plans.episodeNotAired({ type: "series", seriesType: "daily" }, episodes[0], today, frontier)).toBe(true);
  });

  it("reads the frontier of an item from its episodes", async () => {
    const show = await insertItem("anime", "Frontier Anime");
    await insertEpisode(show.id, 1, 1);
    await insertEpisode(show.id, 1, 2, { airDate: "2020-01-02" });
    await insertEpisode(show.id, 1, 3, { airDate: "2099-01-01" });
    expect([...(await plans.airedFrontierFor(show.id, today))]).toEqual([[1, 2]]);
  });
});
