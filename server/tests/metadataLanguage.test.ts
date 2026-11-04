import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let metadata: typeof import("../src/services/metadata.js");
let language: typeof import("../src/services/metadataLanguage.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  metadata = await import("../src/services/metadata.js");
  language = await import("../src/services/metadataLanguage.js");
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(() => {
  deleteSetting("metadataLanguage");
  setSetting("tmdbApiKey", "k");
  setSetting("tvdbApiKey", "");
  setSetting("traktClientId", "");
  setSetting("fanartApiKey", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Body = unknown;

function respond(body: Body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Headers() };
}

/** Stubs fetch with `answer(url, init)`; returning undefined fails the call like an unreachable host. Returns every URL asked for, in order. */
function stubFetch(answer: (url: URL, init?: any) => Body | undefined | { __status: number }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      calls.push(url);
      const body = answer(new URL(url), init);
      if (body === undefined) throw new Error(`unreachable in test: ${url}`);
      if (body && typeof body === "object" && "__status" in body) return respond({}, (body as { __status: number }).__status);
      return respond(body);
    })
  );
  return calls;
}

const asked = (calls: string[], needle: string) => calls.filter((c) => c.includes(needle));
const languageOf = (url: URL) => url.searchParams.get("language");

// ---------------------------------------------------------------------------
// The setting itself
// ---------------------------------------------------------------------------

describe("metadataLanguage setting", () => {
  it("reads as English until set, and normalizes the spelling of a code", () => {
    expect(language.metadataLanguage()).toBe("en");
    for (const [raw, expected] of [
      ["de", "de"],
      ["DE", "de"],
      ["pt-br", "pt-BR"],
      ["zh_cn", "zh-CN"],
      [" fr ", "fr"],
      ["", "en"],
    ] as const) {
      setSetting("metadataLanguage", raw);
      expect(language.metadataLanguage(), raw).toBe(expected);
    }
    setSetting("metadataLanguage", "klingon");
    expect(language.metadataLanguage()).toBe("en");
  });

  it("treats English, in any region, as the providers' own default: no language is requested", () => {
    for (const code of ["", "en", "en-GB", "en-US"]) {
      setSetting("metadataLanguage", code);
      expect(language.tmdbLanguage(), code).toBeNull();
      expect(language.tvdbLanguage(), code).toBeNull();
      expect(language.traktLanguage(), code).toBeNull();
    }
    setSetting("metadataLanguage", "pt-BR");
    expect(language.tmdbLanguage()).toBe("pt-BR");
    expect(language.traktLanguage()).toBe("pt");
  });

  it("maps the language to TheTVDB's three-letter codes, with its Brazilian Portuguese and Traditional Chinese", () => {
    for (const [code, tvdb] of [
      ["de", "deu"],
      ["fr", "fra"],
      ["ja", "jpn"],
      ["pt", "por"],
      ["pt-BR", "pt"],
      ["zh-CN", "zho"],
      ["zh-TW", "zhtw"],
      ["xx", null],
    ] as const) {
      setSetting("metadataLanguage", code);
      expect(language.tvdbLanguage(), code).toBe(tvdb);
    }
  });

  it("validates only the shape of the code, through the settings route", async () => {
    const put = (value: string) => request(app).put("/api/settings/metadataLanguage").set("X-Api-Key", apiKey).send({ value });
    for (const good of ["en", "de", "pt-BR", "zh-CN", "fr", ""]) expect((await put(good)).status, good).toBe(200);
    for (const bad of ["english", "e", "deu", "de-DEU", "de_DE_x", "d3", "12"]) {
      const res = await put(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toContain("metadataLanguage");
    }
    expect(language.metadataLanguageProblem("pt-BR")).toBeNull();
    expect(language.metadataLanguageProblem("portuguese")).not.toBeNull();
  });

  it("keeps a missing translation from blanking text already in hand", () => {
    expect(language.preferLocalized("English", "Deutsch")).toBe("Deutsch");
    expect(language.preferLocalized("English", "")).toBe("English");
    expect(language.preferLocalized("English", "   ")).toBe("English");
    expect(language.preferLocalized("English", null)).toBe("English");
    expect(language.preferLocalized("", "Deutsch")).toBe("Deutsch");
    expect(language.preferLocalized(null, undefined)).toBeNull();
    expect(language.preferLocalized("", "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

function tmdbMovieSearch(url: URL) {
  const de = languageOf(url) === "de";
  return {
    results: [
      { id: 603, title: de ? "Matrix (deutscher Titel)" : "The Matrix", overview: de ? "Deutsche Handlung" : "English plot", release_date: "1999-03-31", poster_path: de ? "/de.jpg" : "/en.jpg", backdrop_path: "/b.jpg", vote_average: 8.2 },
      { id: 604, title: de ? "Matrix 2 (deutsch)" : "The Matrix Reloaded", overview: de ? "" : "English second plot", release_date: "2003-05-15", poster_path: "/en2.jpg", backdrop_path: null, vote_average: 7 },
      { id: 605, title: "No German row", overview: "English third plot", release_date: "2003-11-05", poster_path: "/en3.jpg", backdrop_path: null, vote_average: 0 },
    ].filter((row) => !(de && row.id === 605)),
  };
}

describe("TMDB search in the metadata language", () => {
  it("makes exactly the request it always made when no language (or English) is set", async () => {
    for (const code of [null, "en", "en-GB", ""]) {
      if (code === null) deleteSetting("metadataLanguage");
      else setSetting("metadataLanguage", code);
      const calls = stubFetch((url) => tmdbMovieSearch(url));
      const results = await metadata.searchMetadata("movie", "matrix", "tmdb");
      expect(calls, String(code)).toEqual(["https://api.themoviedb.org/3/search/movie?api_key=k&query=matrix"]);
      expect(results[0]).toMatchObject({ title: "The Matrix", overview: "English plot", posterUrl: "https://image.tmdb.org/t/p/w342/en.jpg" });
    }
  });

  it("takes overview and poster from the language, and leaves every title in English", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => tmdbMovieSearch(url));
    const results = await metadata.searchMetadata("movie", "matrix", "tmdb");

    expect(calls).toEqual([
      "https://api.themoviedb.org/3/search/movie?api_key=k&query=matrix",
      "https://api.themoviedb.org/3/search/movie?api_key=k&query=matrix&language=de",
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      title: "The Matrix",
      year: 1999,
      overview: "Deutsche Handlung",
      posterUrl: "https://image.tmdb.org/t/p/w342/de.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/b.jpg",
      externalIds: { tmdb: "603" },
    });
    // No German overview: the English text stays rather than going blank. No localized poster: the default one.
    expect(results[1]).toMatchObject({ title: "The Matrix Reloaded", overview: "English second plot", posterUrl: "https://image.tmdb.org/t/p/w342/en2.jpg" });
    // A row the language's answer lacks is kept as it was.
    expect(results[2]).toMatchObject({ title: "No German row", overview: "English third plot" });
    expect(results.map((r) => r.title)).not.toContain("Matrix (deutscher Titel)");
  });

  it("answers with the English results when the language request fails", async () => {
    setSetting("metadataLanguage", "de");
    for (const failing of [{ __status: 500 }, undefined]) {
      stubFetch((url) => (languageOf(url) ? failing : tmdbMovieSearch(url)));
      const results = await metadata.searchMetadata("movie", "matrix", "tmdb");
      expect(results.map((r) => r.title)).toEqual(["The Matrix", "The Matrix Reloaded", "No German row"]);
      expect(results[0].overview).toBe("English plot");
    }
  });

  it("still fails when the English request fails: the language is only ever an addition", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch((url) => (languageOf(url) ? tmdbMovieSearch(url) : { __status: 401 }));
    await expect(metadata.searchMetadata("movie", "matrix", "tmdb")).rejects.toThrow("TMDB movie search failed: HTTP 401");
  });

  it("does the same for a series search", async () => {
    setSetting("metadataLanguage", "fr");
    const calls = stubFetch((url) => {
      const fr = languageOf(url) === "fr";
      return { results: [{ id: 1396, name: "Breaking Bad", overview: fr ? "Un professeur de chimie" : "A chemistry teacher", first_air_date: "2008-01-20", poster_path: fr ? "/fr.jpg" : "/en.jpg", backdrop_path: "/b.jpg", vote_average: 8.9 }] };
    });
    const [show] = await metadata.searchMetadata("series", "bb", "tmdb");
    expect(calls).toHaveLength(2);
    expect(show).toMatchObject({ title: "Breaking Bad", overview: "Un professeur de chimie", posterUrl: "https://image.tmdb.org/t/p/w342/fr.jpg" });
  });
});

describe("TMDB detail lookups in the metadata language", () => {
  function movieDetail(url: URL) {
    if (url.pathname.endsWith("/release_dates")) return { results: [] };
    const de = languageOf(url) === "de";
    return {
      id: 603,
      title: de ? "Matrix (deutscher Titel)" : "The Matrix",
      overview: de ? "Deutsche Handlung" : "English plot",
      tagline: de ? "Willkommen" : "Welcome",
      release_date: "1999-03-31",
      poster_path: de ? "/de.jpg" : "/en.jpg",
      backdrop_path: de ? null : "/b.jpg",
      genres: [{ name: de ? "Aktion" : "Action" }],
      runtime: 136,
      status: "Released",
      production_companies: [{ name: "Warner Bros." }],
    };
  }

  it("asks for nothing extra in English, and sends the request an English install always sent", async () => {
    const calls = stubFetch((url) => movieDetail(url));
    await metadata.fetchMovieByTmdbId("603");
    expect(calls).toEqual(["https://api.themoviedb.org/3/movie/603?api_key=k", "https://api.themoviedb.org/3/movie/603/release_dates?api_key=k"]);
  });

  it("localizes the overview, poster and backdrop of a movie but not its title or genres", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => movieDetail(url));
    const movie = await metadata.fetchMovieByTmdbId("603");

    expect(asked(calls, "/movie/603?")).toEqual(["https://api.themoviedb.org/3/movie/603?api_key=k", "https://api.themoviedb.org/3/movie/603?api_key=k&language=de"]);
    expect(movie.title).toBe("The Matrix");
    expect(movie.overview).toBe("Deutsche Handlung");
    expect(movie.posterUrl).toBe("https://image.tmdb.org/t/p/w342/de.jpg");
    // The German answer has no backdrop: the default one stays.
    expect(movie.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/b.jpg");
    expect(movie.genres).toEqual(["Action"]);
    expect(movie).toMatchObject({ year: 1999, runtimeMinutes: 136, studio: "Warner Bros.", status: "Released", externalIds: { tmdb: "603" } });
  });

  it("keeps the English overview when TMDB has no translation, or the language request fails", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch((url) => (languageOf(url) ? { ...movieDetail(url), overview: "", poster_path: null } : movieDetail(url)));
    const noTranslation = await metadata.fetchMovieByTmdbId("603");
    expect(noTranslation.overview).toBe("English plot");
    expect(noTranslation.posterUrl).toBe("https://image.tmdb.org/t/p/w342/en.jpg");

    stubFetch((url) => (languageOf(url) ? { __status: 404 } : movieDetail(url)));
    expect((await metadata.fetchMovieByTmdbId("603")).overview).toBe("English plot");
    stubFetch((url) => (languageOf(url) ? undefined : movieDetail(url)));
    expect((await metadata.fetchMovieByTmdbId("603")).overview).toBe("English plot");
  });

  it("follows the setting at the time of the call: nothing is remembered between languages", async () => {
    stubFetch((url) => movieDetail(url));
    expect((await metadata.fetchMovieByTmdbId("603")).overview).toBe("English plot");
    setSetting("metadataLanguage", "de");
    expect((await metadata.fetchMovieByTmdbId("603")).overview).toBe("Deutsche Handlung");
    setSetting("metadataLanguage", "en");
    expect((await metadata.fetchMovieByTmdbId("603")).overview).toBe("English plot");
  });

  it("localizes a series the same way and finds a movie by its IMDb id through the same path", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => {
      if (url.pathname.startsWith("/3/find/")) return { movie_results: [], tv_results: [{ id: 1396 }] };
      if (url.pathname.endsWith("/content_ratings")) return { results: [{ iso_3166_1: "US", rating: "TV-MA" }] };
      const de = languageOf(url) === "de";
      return { id: 1396, name: de ? "Breaking Bad (deutsch)" : "Breaking Bad", overview: de ? "Ein Chemielehrer" : "A chemistry teacher", first_air_date: "2008-01-20", poster_path: de ? "/de.jpg" : "/en.jpg", backdrop_path: "/b.jpg", genres: [{ name: de ? "Drama-DE" : "Drama" }], status: "Ended" };
    });
    const show = await metadata.fetchByExternalId("series", "imdb", "tt0903747");
    expect(show).toMatchObject({ title: "Breaking Bad", overview: "Ein Chemielehrer", posterUrl: "https://image.tmdb.org/t/p/w342/de.jpg", genres: ["Drama"], contentRating: "TV-MA" });
    // The find request itself says nothing about a language: it only resolves the id.
    expect(asked(calls, "/find/").every((c) => !c.includes("language="))).toBe(true);
  });
});

describe("TMDB episodes, season posters, trending and cast in the metadata language", () => {
  function showAndSeasons(url: URL) {
    const de = languageOf(url) === "de";
    if (url.pathname === "/3/tv/1396") {
      return { seasons: [{ season_number: 0, poster_path: "/s0.jpg" }, { season_number: 1, poster_path: de ? "/s1-de.jpg" : "/s1.jpg" }, { season_number: 2, poster_path: "/s2.jpg" }] };
    }
    if (url.pathname === "/3/tv/1396/season/1") {
      return {
        episodes: [
          { episode_number: 1, name: de ? "Pilot (deutsch)" : "Pilot", air_date: "2008-01-20", overview: de ? "Deutsch eins" : "English one" },
          { episode_number: 2, name: de ? "Zweite" : "Second", air_date: "2008-01-27", overview: de ? "" : "English two" },
        ],
      };
    }
    if (url.pathname === "/3/tv/1396/season/2") {
      return { episodes: [{ episode_number: 1, name: "Seven Thirty-Seven", air_date: "2009-03-08", overview: "English s2e1" }] };
    }
    return undefined;
  }

  it("requests each season once, as it always did, in English", async () => {
    const calls = stubFetch((url) => showAndSeasons(url));
    const episodes = await metadata.fetchSeriesEpisodesFor({ tmdb: "1396" });
    expect(calls).toEqual([
      "https://api.themoviedb.org/3/tv/1396?api_key=k",
      "https://api.themoviedb.org/3/tv/1396/season/1?api_key=k",
      "https://api.themoviedb.org/3/tv/1396/season/2?api_key=k",
    ]);
    expect(episodes).toHaveLength(3);
  });

  it("localizes episode overviews only: episode titles stay as the default listing has them", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => showAndSeasons(url));
    const episodes = await metadata.fetchSeriesEpisodesFor({ tmdb: "1396" });

    // The show's season list is asked for once, in the default language; each season in both.
    expect(asked(calls, "/tv/1396?")).toHaveLength(1);
    expect(asked(calls, "season/1")).toHaveLength(2);
    expect(asked(calls, "season/2")).toHaveLength(2);
    expect(episodes).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2008-01-20", overview: "Deutsch eins" },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2008-01-27", overview: "English two" },
      { seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven", airDate: "2009-03-08", overview: "English s2e1" },
    ]);
  });

  it("falls back to the English episodes when a season's language request fails", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch((url) => (languageOf(url) && url.pathname.endsWith("/season/1") ? { __status: 500 } : showAndSeasons(url)));
    const episodes = await metadata.fetchSeriesEpisodesFor({ tmdb: "1396" });
    expect(episodes.map((e) => e.overview)).toEqual(["English one", "English two", "English s2e1"]);
  });

  it("picks a season poster in the language when there is one", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch((url) => showAndSeasons(url));
    expect(await metadata.fetchSeriesSeasonsFor({ tmdb: "1396" })).toEqual([
      { seasonNumber: 1, posterUrl: "https://image.tmdb.org/t/p/w342/s1-de.jpg" },
      { seasonNumber: 2, posterUrl: "https://image.tmdb.org/t/p/w342/s2.jpg" },
    ]);
    deleteSetting("metadataLanguage");
    stubFetch((url) => showAndSeasons(url));
    expect((await metadata.fetchSeriesSeasonsFor({ tmdb: "1396" }))[0].posterUrl).toBe("https://image.tmdb.org/t/p/w342/s1.jpg");
  });

  it("localizes the trending lists' overviews and keeps their titles", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => {
      const de = languageOf(url) === "de";
      return { results: [{ id: 7, title: de ? "Titel" : "Title", name: de ? "Name" : "Name", overview: de ? "Übersicht" : "Overview", release_date: "2026-01-01", first_air_date: "2026-01-01", poster_path: "/p.jpg", backdrop_path: "/b.jpg" }] };
    });
    const [movie] = await metadata.fetchTrendingMovies();
    expect(movie).toMatchObject({ title: "Title", overview: "Übersicht" });
    const [show] = await metadata.fetchTrendingSeries();
    expect(show).toMatchObject({ title: "Name", overview: "Übersicht" });
    expect(asked(calls, "language=de")).toHaveLength(2);
  });

  it("asks for the cast's character names in the language and keeps the people's names", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch((url) => {
      const de = languageOf(url) === "de";
      return { cast: [{ id: 1, credit_id: "c1", name: "Keanu Reeves", character: de ? "Neo (deutsch)" : "Neo", profile_path: "/k.jpg" }, { id: 2, credit_id: "c2", name: "Carrie-Anne Moss", character: de ? "" : "Trinity", profile_path: null }] };
    });
    const cast = await metadata.fetchCastFor("movie", { tmdb: "603" });
    expect(cast.map((c) => [c.name, c.character])).toEqual([["Keanu Reeves", "Neo (deutsch)"], ["Carrie-Anne Moss", "Trinity"]]);
  });
});

describe("TMDB trailers in the metadata language", () => {
  const videos = [
    { site: "YouTube", type: "Trailer", official: true, key: "ENG", iso_639_1: "en" },
    { site: "YouTube", type: "Teaser", official: true, key: "DEUTEASER", iso_639_1: "de" },
    { site: "YouTube", type: "Trailer", official: true, key: "DEU", iso_639_1: "de" },
  ];

  it("makes the same single request as before in English", async () => {
    const calls = stubFetch(() => ({ results: videos.filter((v) => v.iso_639_1 === "en") }));
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "603" })).toBe("https://www.youtube.com/watch?v=ENG");
    expect(calls).toEqual(["https://api.themoviedb.org/3/movie/603/videos?api_key=k"]);
  });

  it("prefers a trailer in the language, asking for English videos too", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => ({ results: url.searchParams.get("include_video_language") ? videos : [] }));
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "603" })).toBe("https://www.youtube.com/watch?v=DEU");
    expect(calls).toHaveLength(1);
    const asking = new URL(calls[0]);
    expect(asking.searchParams.get("language")).toBe("de");
    expect(asking.searchParams.get("include_video_language")).toBe("de,en");
  });

  it("uses an English trailer rather than another kind of video in the language", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch(() => ({ results: [videos[0], videos[1]] }));
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "603" })).toBe("https://www.youtube.com/watch?v=ENG");
  });

  it("falls back to the plain request when the language request finds nothing or fails", async () => {
    setSetting("metadataLanguage", "de");
    let calls = stubFetch((url) => ({ results: url.searchParams.get("language") ? [] : [videos[0]] }));
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "603" })).toBe("https://www.youtube.com/watch?v=ENG");
    expect(calls).toHaveLength(2);
    calls = stubFetch((url) => (url.searchParams.get("language") ? undefined : { results: [videos[0]] }));
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "603" })).toBe("https://www.youtube.com/watch?v=ENG");
  });
});

describe("TMDB recommendations in the metadata language", () => {
  it("shows the language's overview and poster and keeps the suggested titles English, so an Add creates the item under its usual title", async () => {
    setSetting("metadataLanguage", "de");
    await db
      .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('movie', 'Source Movie', 'source movie', 1, 1, 'unknown', ?)")
      .run(JSON.stringify({ tmdb: "100" }));
    const calls = stubFetch((url) => {
      if (!url.pathname.endsWith("/movie/100/recommendations")) return { results: [] };
      const de = languageOf(url) === "de";
      return { results: [{ id: 201, title: de ? "Neuer Vorschlag" : "New Suggestion", overview: de ? "Deutsche Handlung" : "English plot", release_date: "2021-06-15", poster_path: de ? "/de.jpg" : "/en.jpg" }] };
    });
    const { getRecommendations } = await import("../src/services/recommendations.js");
    const result = await getRecommendations();
    const suggestion = result.movies.find((m) => m.externalIds.tmdb === "201");
    expect(suggestion).toMatchObject({ title: "New Suggestion", overview: "Deutsche Handlung", posterUrl: "https://image.tmdb.org/t/p/w342/de.jpg" });
    expect(asked(calls, "/movie/100/recommendations")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// TheTVDB
// ---------------------------------------------------------------------------

function tvdbApi(extra: (url: URL) => Body | undefined) {
  return (url: URL, init?: any) => {
    if (url.pathname === "/v4/login") return { data: { token: "tok" } };
    return extra(url);
  };
}

describe("TheTVDB in the metadata language", () => {
  beforeEach(() => setSetting("tvdbApiKey", "tvdb-key"));

  const searchHit = { name: "Breaking Bad", tvdb_id: "81189", year: "2008", overview: "A chemistry teacher", overviews: { eng: "A chemistry teacher", deu: "Ein Chemielehrer" }, image_url: "https://img" };

  it("reads a search hit's overview in the language from the hit itself, with no extra request", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch(tvdbApi(() => ({ data: [searchHit] })));
    const [hit] = await metadata.searchMetadata("series", "bb", "tvdb");
    expect(hit).toMatchObject({ title: "Breaking Bad", overview: "Ein Chemielehrer", externalIds: { tvdb: "81189" } });
    expect(asked(calls, "/v4/search")).toHaveLength(1);

    setSetting("metadataLanguage", "fr");
    stubFetch(tvdbApi(() => ({ data: [searchHit] })));
    expect((await metadata.searchMetadata("series", "bb", "tvdb"))[0].overview).toBe("A chemistry teacher");

    deleteSetting("metadataLanguage");
    stubFetch(tvdbApi(() => ({ data: [searchHit] })));
    expect((await metadata.searchMetadata("series", "bb", "tvdb"))[0].overview).toBe("A chemistry teacher");
  });

  const extended = { data: { id: 81189, name: "Breaking Bad", year: "2008", overview: "A chemistry teacher", image: "https://img", status: { name: "Ended" } } };

  it("fetches the series' translation for the overview and leaves its name alone", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch(
      tvdbApi((url) => {
        if (url.pathname === "/v4/series/81189/extended") return extended;
        if (url.pathname === "/v4/series/81189/translations/deu") return { data: { name: "Breaking Bad (deutsch)", overview: "Ein Chemielehrer" } };
        return undefined;
      })
    );
    const show = await metadata.fetchByExternalId("series", "tvdb", "81189");
    expect(show).toMatchObject({ title: "Breaking Bad", overview: "Ein Chemielehrer", status: "Ended" });
    expect(asked(calls, "/translations/deu")).toHaveLength(1);
  });

  it("makes no translation request in English, and keeps the default overview when there is no translation", async () => {
    let calls = stubFetch(tvdbApi((url) => (url.pathname === "/v4/series/81189/extended" ? extended : undefined)));
    expect((await metadata.fetchByExternalId("series", "tvdb", "81189")).overview).toBe("A chemistry teacher");
    expect(asked(calls, "/translations/")).toHaveLength(0);

    setSetting("metadataLanguage", "de");
    calls = stubFetch(tvdbApi((url) => (url.pathname === "/v4/series/81189/extended" ? extended : { __status: 404 })));
    expect((await metadata.fetchByExternalId("series", "tvdb", "81189")).overview).toBe("A chemistry teacher");

    // A language TheTVDB has no code for here is not asked about at all.
    setSetting("metadataLanguage", "xx");
    calls = stubFetch(tvdbApi((url) => (url.pathname === "/v4/series/81189/extended" ? extended : undefined)));
    expect((await metadata.fetchByExternalId("series", "tvdb", "81189")).overview).toBe("A chemistry teacher");
    expect(asked(calls, "/translations/")).toHaveLength(0);
  });

  const episodePage = (name: string, overview: string | null) => ({
    data: { episodes: [{ seasonNumber: 1, number: 1, name, aired: "2008-01-20", overview }, { seasonNumber: 1, number: 2, name: `${name} 2`, aired: "2008-01-27", overview: "Second default" }] },
    links: { next: null },
  });

  it("takes episode overviews from the language's listing and keeps the default titles", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch(
      tvdbApi((url) => {
        if (url.pathname === "/v4/series/81189/episodes/default") return episodePage("Pilot", "First default");
        if (url.pathname === "/v4/series/81189/episodes/default/deu") return episodePage("Pilot (deutsch)", "Erste");
        return undefined;
      })
    );
    const episodes = await metadata.fetchSeriesEpisodesFor({ tvdb: "81189" });
    expect(episodes.map((e) => [e.title, e.overview])).toEqual([
      ["Pilot", "Erste"],
      ["Pilot 2", "Second default"],
    ]);
    expect(asked(calls, "/episodes/default/deu")).toHaveLength(1);
  });

  it("keeps the default episodes when the language's listing fails, and asks nothing extra in English", async () => {
    setSetting("metadataLanguage", "de");
    stubFetch(tvdbApi((url) => (url.pathname === "/v4/series/81189/episodes/default" ? episodePage("Pilot", "First default") : { __status: 404 })));
    expect((await metadata.fetchSeriesEpisodesFor({ tvdb: "81189" })).map((e) => e.overview)).toEqual(["First default", "Second default"]);

    deleteSetting("metadataLanguage");
    const calls = stubFetch(tvdbApi((url) => (url.pathname === "/v4/series/81189/episodes/default" ? episodePage("Pilot", "First default") : undefined)));
    await metadata.fetchSeriesEpisodesFor({ tvdb: "81189" });
    expect(asked(calls, "/episodes/default")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Trakt, MangaDex, fanart.tv
// ---------------------------------------------------------------------------

describe("Trakt in the metadata language", () => {
  beforeEach(() => setSetting("traktClientId", "trakt-id"));

  const movie = { title: "Film", year: 1999, overview: "English plot", released: "1999-03-31", runtime: 136, certification: "R", ids: { trakt: 12, imdb: "tt0133093" } };

  it("takes a movie's or show's overview from Trakt's translation and keeps its title", async () => {
    setSetting("metadataLanguage", "de");
    const calls = stubFetch((url) => {
      if (url.pathname === "/movies/12/translations/de") return [{ title: "Film (deutsch)", overview: "", language: "de" }, { title: "Film (deutsch)", overview: "Deutsche Handlung", language: "de", country: "de" }];
      if (url.pathname === "/shows/34/translations/de") return [{ title: "Serie", overview: "Deutsche Serie", language: "de" }];
      if (url.pathname === "/movies/12") return movie;
      if (url.pathname === "/shows/34") return { title: "Show", year: 2008, overview: "English show", ids: { trakt: 34 } };
      return undefined;
    });
    expect(await metadata.fetchByExternalId("movie", "trakt", "12")).toMatchObject({ title: "Film", overview: "Deutsche Handlung" });
    expect(await metadata.fetchByExternalId("series", "trakt", "34")).toMatchObject({ title: "Show", overview: "Deutsche Serie" });
    expect(asked(calls, "/translations/de")).toHaveLength(2);
  });

  it("asks for no translation in English, and keeps the English overview when Trakt has none", async () => {
    let calls = stubFetch((url) => (url.pathname === "/movies/12" ? movie : undefined));
    expect((await metadata.fetchByExternalId("movie", "trakt", "12")).overview).toBe("English plot");
    expect(asked(calls, "/translations/")).toHaveLength(0);

    setSetting("metadataLanguage", "de");
    calls = stubFetch((url) => (url.pathname === "/movies/12" ? movie : url.pathname.endsWith("/translations/de") ? [] : undefined));
    expect((await metadata.fetchByExternalId("movie", "trakt", "12")).overview).toBe("English plot");
    calls = stubFetch((url) => (url.pathname === "/movies/12" ? movie : undefined));
    expect((await metadata.fetchByExternalId("movie", "trakt", "12")).overview).toBe("English plot");
  });
});

describe("MangaDex in the metadata language", () => {
  const manga = { data: [{ id: "m1", attributes: { title: { en: "Berserk" }, year: 1989, description: { en: "English text", de: "Deutscher Text", "pt-br": "Texto" } }, relationships: [] }] };

  it("picks the description in the language, falling back to English", async () => {
    for (const [code, expected] of [
      [null, "English text"],
      ["de", "Deutscher Text"],
      ["pt-BR", "Texto"],
      ["fr", "English text"],
    ] as const) {
      if (code === null) deleteSetting("metadataLanguage");
      else setSetting("metadataLanguage", code);
      stubFetch(() => manga);
      const [result] = await metadata.searchMetadata("manga", "berserk", "mangadex");
      expect(result, String(code)).toMatchObject({ title: "Berserk", overview: expected });
    }
  });
});

describe("fanart.tv in the metadata language", () => {
  it("lists images in the language first and keeps the order otherwise", async () => {
    setSetting("fanartApiKey", "fa");
    const body = { movieposter: [{ url: "http://en1", lang: "en" }, { url: "http://de1", lang: "de" }, { url: "http://en2", lang: "en" }, { url: "http://de2", lang: "de" }], moviebackground: [{ url: "http://bg", lang: "" }] };
    stubFetch(() => body);
    expect((await metadata.fetchArtworkFor("movie", { tmdb: "1" })).posters).toEqual(["http://en1", "http://de1", "http://en2", "http://de2"]);
    setSetting("metadataLanguage", "de");
    stubFetch(() => body);
    const options = await metadata.fetchArtworkFor("movie", { tmdb: "1" });
    expect(options.posters).toEqual(["http://de1", "http://de2", "http://en1", "http://en2"]);
    expect(options.backgrounds).toEqual(["http://bg"]);
  });
});

describe("ScreenScraper in the metadata language", () => {
  it("reads a game's synopsis in the language, then English, then whatever comes first", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    const game = { id: 1, noms: [{ region: "wor", text: "Game" }], synopsis: [{ langue: "fr", text: "Résumé" }, { langue: "en", text: "Summary" }, { langue: "de", text: "Zusammenfassung" }] };
    for (const [code, expected] of [
      [null, "Summary"],
      ["de", "Zusammenfassung"],
      ["es", "Summary"],
    ] as const) {
      if (code === null) deleteSetting("metadataLanguage");
      else setSetting("metadataLanguage", code);
      stubFetch(() => ({ response: { jeux: [game] } }));
      const [result] = await metadata.searchMetadata("rom", "game", "screenscraper");
      expect(result.overview, String(code)).toBe(expected);
    }
    setSetting("metadataLanguage", "es");
    stubFetch(() => ({ response: { jeux: [{ ...game, synopsis: [{ langue: "fr", text: "Résumé" }] }] } }));
    expect((await metadata.searchMetadata("rom", "game", "screenscraper"))[0].overview).toBe("Résumé");
  });
});

// ---------------------------------------------------------------------------
// The language request is bounded, and a failed one never replaces stored text (review finding L15)
// ---------------------------------------------------------------------------

describe("the TMDB language request: timeout, one retry on 429, a flag when it fails", () => {
  let log: (typeof import("../src/services/logger.js"))["log"];
  beforeAll(async () => {
    ({ log } = await import("../src/services/logger.js"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const movieUrl = () => new URL("https://api.themoviedb.org/3/movie/603?api_key=secret-key");
  const answer = (body: Body, status = 200, headers: Record<string, string> = {}) => ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) });

  it("gives the request a 10 second timeout, and a request that hangs is cut off and flagged as failed", async () => {
    setSetting("metadataLanguage", "de");
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(30); // the same signal, only quicker, so the test does not sit for ten seconds
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))))
    );
    const answered = await language.fetchTmdbLocalized(movieUrl());
    expect(timeouts).toEqual([language.LOCALIZED_REQUEST_TIMEOUT_MS]);
    expect(language.LOCALIZED_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(language.localizationFailed(answered)).toBe(true);
    expect(answered?.overview).toBeUndefined();
  });

  it("a hung language request does not hold the lookup: the default-language movie comes back flagged", async () => {
    setSetting("metadataLanguage", "de");
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(30));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        const asked = new URL(url);
        if (languageOf(asked)) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        return Promise.resolve(answer(asked.pathname.endsWith("/release_dates") ? { results: [] } : { id: 603, title: "The Matrix", overview: "English plot", poster_path: "/en.jpg", release_date: "1999-03-31" }));
      })
    );
    const movie = await metadata.fetchMovieByTmdbId("603");
    expect(movie).toMatchObject({ title: "The Matrix", overview: "English plot", localizationFailed: true });
  });

  it.each([
    ["2", 2000],
    ["60", 5000],
    ["0", 0],
    [null, 1000],
    ["soon", 1000],
  ] as const)("after a 429 with Retry-After %j it asks once more, %j ms later at most", async (header, waitMs) => {
    setSetting("metadataLanguage", "de");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? answer({}, 429, header === null ? {} : { "Retry-After": header }) : answer({ overview: "Deutsche Handlung" });
      })
    );
    const pending = language.fetchTmdbLocalized(movieUrl());
    if (waitMs > 0) {
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(calls, "still waiting").toBe(1);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ overview: "Deutsche Handlung" });
    expect(calls).toBe(2);
  });

  it("a Retry-After given as an HTTP date is read too, and is capped at 5 seconds", async () => {
    setSetting("metadataLanguage", "de");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? answer({}, 429, { "Retry-After": new Date("2026-11-04T10:05:00Z").toUTCString() }) : answer({ overview: "ok" });
      })
    );
    const pending = language.fetchTmdbLocalized(movieUrl());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ overview: "ok" });
  });

  it("gives up after a second 429: two requests only, and the answer is the failed flag", async () => {
    setSetting("metadataLanguage", "de");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(async () => answer({}, 429, { "Retry-After": "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = language.fetchTmdbLocalized(movieUrl());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(language.localizationFailed(await pending)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an error status or a network error is a failure, and the debug line names the path but never the API key", async () => {
    setSetting("metadataLanguage", "de");
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    stubFetch((url) => (languageOf(url) ? { __status: 500 } : {}));
    expect(language.localizationFailed(await language.fetchTmdbLocalized(movieUrl()))).toBe(true);
    stubFetch((url) => (languageOf(url) ? undefined : {}));
    expect(language.localizationFailed(await language.fetchTmdbLocalized(movieUrl()))).toBe(true);
    expect(debug).toHaveBeenCalledTimes(2);
    const lines = debug.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toContain("/3/movie/603");
    expect(lines[0]).toContain("HTTP 500");
    expect(lines.join("\n")).not.toContain("secret-key");
    expect(lines.join("\n")).not.toContain("api_key");
  });

  it("English asks for nothing and has nothing to fail; a translation TMDB lacks is an ordinary answer, not a failure", async () => {
    deleteSetting("metadataLanguage");
    const none = stubFetch(() => ({}));
    expect(await language.fetchTmdbLocalized(movieUrl())).toBeNull();
    expect(none).toEqual([]);
    setSetting("metadataLanguage", "de");
    stubFetch(() => ({ overview: "", poster_path: null }));
    const lacking = await language.fetchTmdbLocalized(movieUrl());
    expect(language.localizationFailed(lacking)).toBe(false);
    expect(language.localizationFailed(null)).toBe(false);
    expect(language.localizationFailed("localizationFailed")).toBe(false);
  });

  it("the lookups flag a failure on the result, and only a failure", async () => {
    setSetting("metadataLanguage", "de");
    const detail = (url: URL, failing: boolean) => {
      if (url.pathname.endsWith("/release_dates") || url.pathname.endsWith("/content_ratings")) return { results: [] };
      if (languageOf(url)) return failing ? { __status: 500 } : { id: 603, overview: "" };
      return { id: 603, title: "The Matrix", name: "The Matrix", overview: "English plot", release_date: "1999-03-31", first_air_date: "1999-03-31" };
    };
    stubFetch((url) => detail(url, true));
    expect(await metadata.fetchMovieByTmdbId("603")).toMatchObject({ overview: "English plot", localizationFailed: true });
    expect(await metadata.fetchSeriesByTmdbId("603")).toMatchObject({ overview: "English plot", localizationFailed: true });
    stubFetch((url) => (url.pathname === "/3/search/movie" ? (languageOf(url) ? { __status: 500 } : tmdbMovieSearch(url)) : detail(url, true)));
    const rows = await metadata.searchMetadata("movie", "matrix", "tmdb");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.localizationFailed === true && r.title !== "Matrix (deutscher Titel)")).toBe(true);

    // TMDB answering without a translation is not a failure.
    stubFetch((url) => detail(url, false));
    const movie = await metadata.fetchMovieByTmdbId("603");
    expect(movie.overview).toBe("English plot");
    expect("localizationFailed" in movie).toBe(false);
    stubFetch((url) => tmdbMovieSearch(url));
    expect((await metadata.searchMetadata("movie", "matrix", "tmdb")).some((r) => "localizationFailed" in r)).toBe(false);
  });

  describe("refresh", () => {
    let refreshOneMediaItem: (typeof import("../src/services/libraryScan.js"))["refreshOneMediaItem"];
    beforeAll(async () => {
      ({ refreshOneMediaItem } = await import("../src/services/libraryScan.js"));
    });

    async function insertMovie(overview: string | null): Promise<number> {
      const result = await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, overview, external_ids, monitored, has_file, status) VALUES ('movie', 'The Matrix', 'the matrix', 1999, ?, '{\"tmdb\":\"603\"}', 1, 0, 'unknown')")
        .run(overview);
      return Number(result.lastInsertRowid);
    }
    const overviewOf = async (id: number) => ((await db.prepare("SELECT overview FROM media_items WHERE id = ?").get(id)) as { overview: string | null }).overview;
    const tmdb = (failing: boolean, localizedOverview = "Neue deutsche Handlung") => (url: URL) => {
      if (url.pathname.endsWith("/release_dates")) return { results: [] };
      if (languageOf(url)) return failing ? { __status: 500 } : { id: 603, title: "Matrix (deutsch)", overview: localizedOverview, poster_path: "/de.jpg" };
      return { id: 603, title: "The Matrix", overview: "English plot", release_date: "1999-03-31", poster_path: "/en.jpg", vote_average: 8.2, production_companies: [] };
    };

    it("a failed language request leaves the stored translation alone; the rest of the refresh still happens", async () => {
      setSetting("metadataLanguage", "de");
      const id = await insertMovie("Gespeicherte deutsche Handlung");
      stubFetch(tmdb(true));
      expect((await refreshOneMediaItem(id)).ok).toBe(true);
      expect(await overviewOf(id)).toBe("Gespeicherte deutsche Handlung");
      const row = (await db.prepare("SELECT rating, poster_url FROM media_items WHERE id = ?").get(id)) as { rating: number | null; poster_url: string | null };
      expect(row.rating).toBe(8.2);
      expect(row.poster_url).toContain("/en.jpg");
    });

    it("a language request that works replaces it, and TMDB having no translation still keeps the English text coming in", async () => {
      setSetting("metadataLanguage", "de");
      const id = await insertMovie("Gespeicherte deutsche Handlung");
      stubFetch(tmdb(false));
      await refreshOneMediaItem(id);
      expect(await overviewOf(id)).toBe("Neue deutsche Handlung");
      stubFetch(tmdb(false, ""));
      await refreshOneMediaItem(id);
      expect(await overviewOf(id)).toBe("English plot");
    });

    it("with nothing stored yet, the default-language text is better than none, even when the language request failed", async () => {
      setSetting("metadataLanguage", "de");
      for (const stored of [null, ""]) {
        const id = await insertMovie(stored);
        stubFetch(tmdb(true));
        await refreshOneMediaItem(id);
        expect(await overviewOf(id), String(stored)).toBe("English plot");
      }
    });

    it("in English nothing changes: the provider's text is written as before", async () => {
      deleteSetting("metadataLanguage");
      const id = await insertMovie("Old text");
      stubFetch(tmdb(true));
      await refreshOneMediaItem(id);
      expect(await overviewOf(id)).toBe("English plot");
    });
  });
});
