import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let metadata: typeof import("../src/services/metadata.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  metadata = await import("../src/services/metadata.js");
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Credential/preference keys this file reads via getSetting/requireSetting — reset to "" (falsy,
// same as never-configured for every `!value`/`if (key)` check in the source) before every test so
// no test can leak a key into another. The default-provider override keys are handled separately
// below since they're read via `??` rather than a truthiness check (see DEFAULT_PROVIDER_KEYS).
const CREDENTIAL_KEYS = [
  "tmdbApiKey", "omdbApiKey", "traktClientId", "tvdbApiKey", "musicAlbumTypes", "discogsToken",
  "lastfmApiKey", "googleBooksApiKey", "hardcoverApiToken", "comicVineApiKey", "rawgApiKey",
  "igdbClientId", "igdbClientSecret", "screenscraperDevId", "screenscraperDevPassword",
  "screenscraperUserId", "screenscraperUserPassword", "theGamesDbApiKey", "youtubeApiKey",
  "vimeoAccessToken", "thePornDbApiKey", "fanartApiKey",
];

// `defaultProviderFor` does `getSetting(key) ?? mediaTypeConfig.defaultProvider` — `??` only falls
// through on null/undefined, not on "". Resetting these with setSetting(key,"") would make
// defaultProviderFor return "" instead of the real fallback, breaking every test that omits an
// explicit provider. deleteSetting() removes the key entirely so getSetting returns a true null.
const DEFAULT_PROVIDER_KEYS = ["defaultMovieProvider", "defaultPodcastProvider", "defaultMangaProvider"];

beforeEach(() => {
  for (const key of CREDENTIAL_KEYS) setSetting(key, "");
  for (const key of DEFAULT_PROVIDER_KEYS) deleteSetting(key);
});

type Route = { test: (url: string) => boolean; response: any };

function routedFetch(routes: Route[]) {
  return vi.fn(async (url: string, init?: any) => {
    const route = routes.find((r) => r.test(url));
    if (!route) throw new Error(`unmocked fetch call in test: ${url}`);
    return typeof route.response === "function" ? route.response(url, init) : route.response;
  });
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function okText(text: string) {
  return { ok: true, status: 200, text: async () => text };
}

function notOk(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

function stub(routes: Route[]) {
  const fn = routedFetch(routes);
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ---------------------------------------------------------------------------
// parseProviderUrl — pure, no network/settings involved
// ---------------------------------------------------------------------------

describe("parseProviderUrl", () => {
  it("recognizes TMDB movie and tv URLs", () => {
    expect(metadata.parseProviderUrl("https://www.themoviedb.org/movie/603-the-matrix")).toEqual({ provider: "tmdb", id: "603" });
    expect(metadata.parseProviderUrl("https://themoviedb.org/tv/1396")).toEqual({ provider: "tmdb", id: "1396" });
  });

  it("recognizes an IMDb title URL", () => {
    expect(metadata.parseProviderUrl("https://www.imdb.com/title/tt0133093/")).toEqual({ provider: "imdb", id: "tt0133093" });
  });

  it("recognizes a YouTube playlist URL on youtube.com and m.youtube.com", () => {
    expect(metadata.parseProviderUrl("https://www.youtube.com/watch?v=abc&list=PL123")).toEqual({ provider: "youtubePlaylist", id: "PL123" });
    expect(metadata.parseProviderUrl("https://m.youtube.com/playlist?list=PL999")).toEqual({ provider: "youtubePlaylist", id: "PL999" });
  });

  it("resolves a TVDB URL with an id param but rejects a bare series slug", () => {
    expect(metadata.parseProviderUrl("https://thetvdb.com/dashboard?id=12345")).toEqual({ provider: "tvdb", id: "12345" });
    expect(metadata.parseProviderUrl("https://www.thetvdb.com/series/breaking-bad")).toBeNull();
  });

  it("recognizes AniList anime and manga URLs", () => {
    expect(metadata.parseProviderUrl("https://anilist.co/anime/1535/Death-Note")).toEqual({ provider: "anilist", id: "1535" });
    expect(metadata.parseProviderUrl("https://anilist.co/manga/30013")).toEqual({ provider: "anilist", id: "30013" });
  });

  it("extracts a 13-digit or 10-digit-with-check-char ISBN from Open Library / isbnsearch URLs", () => {
    expect(metadata.parseProviderUrl("https://openlibrary.org/isbn/9780143127550")).toEqual({ provider: "isbn", id: "9780143127550" });
    expect(metadata.parseProviderUrl("https://isbnsearch.org/isbn/043927227X")).toEqual({ provider: "isbn", id: "043927227X" });
  });

  it("returns null for a malformed URL string or an unrecognized host", () => {
    expect(metadata.parseProviderUrl("not a url")).toBeNull();
    expect(metadata.parseProviderUrl("https://example.com/whatever")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token/auth caching (TVDB, IGDB) — module-level `let` caches persist for the life of the test
// file, so these MUST run before any other test that happens to touch TVDB/IGDB (a warm cache
// would make requireSetting/login-call assertions below silently pass without exercising anything).
// Every other TVDB/IGDB-touching test later in the file registers the login route defensively (it's
// harmless if the cache is already warm and the route never gets hit) but never asserts a fresh
// login occurred.
// ---------------------------------------------------------------------------

describe("TVDB token caching", () => {
  it("throws when the TVDB API key isn't configured", async () => {
    await expect(metadata.searchMetadata("series", "q", "tvdb")).rejects.toThrow("TVDB API key is not configured");
  });

  it("logs in once, reuses the cached token, and re-logs-in after a 401", async () => {
    setSetting("tvdbApiKey", "tvdb-key");
    let loginCalls = 0;
    const fetchMock = stub([
      {
        test: (u) => u.includes("/v4/login"),
        response: () => {
          loginCalls++;
          return ok({ data: { token: `tok-${loginCalls}` } });
        },
      },
      {
        test: (u) => u.includes("/v4/search"),
        response: (_u: string, init: any) =>
          init.headers.Authorization === "Bearer tok-1" ? notOk(401) : ok({ data: [{ name: "Show", tvdb_id: 1 }] }),
      },
    ]);

    const first = await metadata.searchMetadata("series", "q", "tvdb");
    expect(first).toHaveLength(1);
    expect(loginCalls).toBe(2); // initial login (tok-1) rejected with 401, forced refresh got tok-2

    // A second, unrelated call reuses the now-cached tok-2 without logging in again.
    fetchMock.mockClear();
    await metadata.searchMetadata("series", "q2", "tvdb");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v4/login"))).toHaveLength(0);
  });
});

describe("IGDB token caching", () => {
  it("throws when IGDB credentials aren't configured", async () => {
    await expect(metadata.searchMetadata("rom", "q", "igdb")).rejects.toThrow("IGDB Client ID is not configured");
  });

  // This MUST run before any test below that successfully authenticates: igdbToken is a
  // module-level cache that survives for the rest of the file, and a long-lived real token from a
  // later test would still read as unexpired here (only milliseconds of real wall-clock time pass
  // between tests), silently preventing this test's own auth stub from ever being hit.
  it("re-authenticates once the cached token's expiry has passed", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    let authCalls = 0;
    stub([
      {
        test: (u) => u.includes("id.twitch.tv/oauth2/token"),
        response: () => {
          authCalls++;
          // expiresAt = now + (expires_in - 60) * 1000. The first response's 61s expires_in
          // expires 1s from "now" (forced past below); the second's expires_in:0 leaves the
          // *resulting* cached token already 60s in the past relative to real time as soon as
          // vi.useRealTimers() resumes below — so it can never be mistaken for a warm cache by
          // whichever IGDB test runs next, no matter how little real time elapses between them.
          return ok({ access_token: `tok-${authCalls}`, expires_in: authCalls === 1 ? 61 : 0 });
        },
      },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ id: 1, name: "Game" }]) },
    ]);

    vi.useFakeTimers();
    try {
      await metadata.searchMetadata("rom", "q", "igdb");
      expect(authCalls).toBe(1);
      vi.setSystemTime(Date.now() + 5000); // past the 1s-from-now expiry
      await metadata.searchMetadata("rom", "q2", "igdb");
      expect(authCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates once and reuses the cached token across calls", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    let authCalls = 0;
    stub([
      {
        test: (u) => u.includes("id.twitch.tv/oauth2/token"),
        response: () => {
          authCalls++;
          return ok({ access_token: "igdb-tok", expires_in: 3600 });
        },
      },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ id: 1, name: "Game" }]) },
    ]);

    await metadata.searchMetadata("rom", "q", "igdb");
    await metadata.searchMetadata("rom", "q2", "igdb");
    expect(authCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// searchMetadata — the main dispatcher: provider validation, per-type routing (including the
// TYPE_SPECIFIC_SEARCH_FNS override table), year-based re-ranking, and the MusicBrainz->Deezer
// poster backfill.
// ---------------------------------------------------------------------------

describe("searchMetadata dispatch errors", () => {
  it("throws when a type has no provider configured and no default (Courses)", async () => {
    await expect(metadata.searchMetadata("course", "q")).rejects.toThrow('"Courses" has no metadata search provider — add this item manually.');
  });

  it("throws when the chosen provider isn't valid for the type", async () => {
    await expect(metadata.searchMetadata("movie", "q", "musicbrainz")).rejects.toThrow('"musicbrainz" is not a valid metadata provider for movie');
  });

  it("falls back to the configured default provider, and to the media type's own default when unset", async () => {
    setSetting("omdbApiKey", "omdb-key");
    setSetting("defaultMovieProvider", "omdb");
    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "True", Search: [{ Title: "X", Year: "2000", Poster: "N/A", imdbID: "tt1" }] }) }]);
    const viaOverride = await metadata.searchMetadata("movie", "q");
    expect(viaOverride[0].externalIds.imdb).toBe("tt1");

    deleteSetting("defaultMovieProvider");
    setSetting("tmdbApiKey", "tmdb-key");
    stub([{ test: (u) => u.includes("themoviedb.org"), response: ok({ results: [{ id: 5, title: "Y" }] }) }]);
    const viaDefault = await metadata.searchMetadata("movie", "q");
    expect(viaDefault[0].externalIds.tmdb).toBe("5");
  });
});

describe("searchMetadata: movies", () => {
  it("TMDB: maps every search field, filtering a zero vote_average to null", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      {
        test: (u) => u.includes("search/movie"),
        response: ok({
          results: [
            { id: 1, title: "Batman", release_date: "1989-06-23", overview: "ov", poster_path: "/p.jpg", backdrop_path: "/b.jpg", vote_average: 7.5 },
            { id: 2, title: "NoRating", vote_average: 0 },
          ],
        }),
      },
    ]);
    const [batman, noRating] = await metadata.searchMetadata("movie", "batman", "tmdb");
    expect(batman).toEqual({
      title: "Batman",
      year: 1989,
      overview: "ov",
      posterUrl: "https://image.tmdb.org/t/p/w342/p.jpg",
      externalIds: { tmdb: "1" },
      releaseDate: "1989-06-23",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/b.jpg",
      rating: 7.5,
    });
    expect(noRating.rating).toBeNull();
    expect(noRating.posterUrl).toBeNull();
  });

  it("OMDb: maps search results and returns [] on Response:False", async () => {
    setSetting("omdbApiKey", "k");
    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "True", Search: [{ Title: "Batman", Year: "1989", Poster: "N/A", imdbID: "tt1" }] }) }]);
    const results = await metadata.searchMetadata("movie", "batman", "omdb");
    expect(results).toEqual([{ title: "Batman", year: 1989, overview: null, posterUrl: null, externalIds: { imdb: "tt1" } }]);

    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "False" }) }]);
    await expect(metadata.searchMetadata("movie", "nothing", "omdb")).resolves.toEqual([]);
  });

  it("Trakt: maps search results with null posterUrl, and omits the imdb key entirely when Trakt has none", async () => {
    setSetting("traktClientId", "cid");
    stub([{ test: (u) => u.includes("api.trakt.tv/search/movie"), response: ok([{ movie: { title: "Batman", year: 1989, overview: "ov", ids: { trakt: 1, imdb: "tt1" } } }]) }]);
    const results = await metadata.searchMetadata("movie", "batman", "trakt");
    expect(results).toEqual([{ title: "Batman", year: 1989, overview: "ov", posterUrl: null, externalIds: { trakt: "1", imdb: "tt1" } }]);

    stub([{ test: (u) => u.includes("api.trakt.tv/search/movie"), response: ok([{ movie: { title: "No IMDb", year: 2000, ids: { trakt: 2 } } }]) }]);
    const withoutImdb = await metadata.searchMetadata("movie", "x", "trakt");
    expect(withoutImdb[0].externalIds).toEqual({ trakt: "2" });
    expect("imdb" in withoutImdb[0].externalIds).toBe(false);
  });
});

describe("searchMetadata: series/anime/sports/ppv", () => {
  it("TMDB series search maps fields", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("search/tv"), response: ok({ results: [{ id: 9, name: "Breaking Bad", first_air_date: "2008-01-20", vote_average: 9.1 }] }) }]);
    const results = await metadata.searchMetadata("series", "bb", "tmdb");
    expect(results[0]).toMatchObject({ title: "Breaking Bad", year: 2008, externalIds: { tmdb: "9" }, rating: 9.1 });
  });

  it("TVDB series search maps id fallback and image fallback, and defaults year/overview/posterUrl to null when absent", async () => {
    setSetting("tvdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/search"), response: ok({ data: [{ name: "X", year: "2010", thumbnail: "http://thumb", id: 7 }] }) },
    ]);
    const results = await metadata.searchMetadata("series", "x", "tvdb");
    expect(results[0]).toEqual({ title: "X", year: 2010, overview: null, posterUrl: "http://thumb", externalIds: { tvdb: "7" } });

    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/search"), response: ok({ data: [{ name: "Bare", id: 8 }] }) },
    ]);
    const bare = await metadata.searchMetadata("series", "x", "tvdb");
    expect(bare[0]).toEqual({ title: "Bare", year: null, overview: null, posterUrl: null, externalIds: { tvdb: "8" } });
  });

  it("TVMaze search strips HTML from the summary, and handles a missing image/summary/premiered date", async () => {
    stub([{ test: (u) => u.includes("api.tvmaze.com/search/shows"), response: ok([{ show: { id: 1, name: "X", premiered: "2010-05-01", summary: "<p>ov</p>", image: { medium: "http://img" } } }]) }]);
    const results = await metadata.searchMetadata("series", "x", "tvmaze");
    expect(results[0]).toEqual({ title: "X", year: 2010, overview: "ov", posterUrl: "http://img", externalIds: { tvmaze: "1" } });

    stub([{ test: (u) => u.includes("api.tvmaze.com/search/shows"), response: ok([{ show: { id: 2, name: "Bare" } }]) }]);
    const bare = await metadata.searchMetadata("series", "x", "tvmaze");
    expect(bare[0]).toEqual({ title: "Bare", year: null, overview: null, posterUrl: null, externalIds: { tvmaze: "2" } });
  });

  it("Trakt series search maps fields", async () => {
    setSetting("traktClientId", "cid");
    stub([{ test: (u) => u.includes("api.trakt.tv/search/show"), response: ok([{ show: { title: "X", year: 2010, overview: "ov", ids: { trakt: 3 } } }]) }]);
    const results = await metadata.searchMetadata("series", "x", "trakt");
    expect(results[0]).toEqual({ title: "X", year: 2010, overview: "ov", posterUrl: null, externalIds: { trakt: "3" } });
  });

  it("Trakt movie and show search request extended=full, since the minimal response carries no overview", async () => {
    setSetting("traktClientId", "cid");
    const fetchMock = stub([{ test: (u) => u.includes("api.trakt.tv/search/"), response: ok([]) }]);
    await metadata.searchMetadata("movie", "x", "trakt");
    await metadata.searchMetadata("series", "x", "trakt");
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("extended"))).toEqual(["full", "full"]);
  });

  it("AniList (anime) prefers the English title and normalizes averageScore to a 0-10 scale", async () => {
    stub([
      {
        test: (u) => u.includes("graphql.anilist.co"),
        response: ok({ data: { Page: { media: [{ id: 5, title: { romaji: "R", english: "E" }, startDate: { year: 2010 }, description: "d", coverImage: { medium: "c" }, bannerImage: "b", averageScore: 85, duration: 24 }] } } }),
      },
    ]);
    const results = await metadata.searchMetadata("anime", "x", "anilist");
    expect(results[0]).toEqual({ title: "E", year: 2010, overview: "d", posterUrl: "c", externalIds: { anilist: "5" }, backdropUrl: "b", rating: 8.5, runtimeMinutes: 24 });
  });

  it("sports defaults route Trakt's TYPE_SPECIFIC override to the series search (not movie)", async () => {
    setSetting("traktClientId", "cid");
    stub([{ test: (u) => u.includes("api.trakt.tv/search/show"), response: ok([{ show: { title: "Event", year: 2020, ids: { trakt: 1 } } }]) }]);
    await expect(metadata.searchMetadata("sports", "x", "trakt")).resolves.toHaveLength(1);
  });

  it("ppv routes TMDB/Trakt's TYPE_SPECIFIC override to the movie search (not series)", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("search/movie"), response: ok({ results: [{ id: 1, title: "WrestleMania" }] }) }]);
    const results = await metadata.searchMetadata("ppv", "x", "tmdb");
    expect(results[0].title).toBe("WrestleMania");
  });
});

describe("searchMetadata: artists", () => {
  it("MusicBrainz search maps fields", async () => {
    stub([{ test: (u) => u.includes("musicbrainz.org/ws/2/artist"), response: ok({ artists: [{ name: "Artist", "life-span": { begin: "1990" }, disambiguation: "disamb", id: "mbid-1" }] }) }]);
    const results = await metadata.searchMetadata("artist", "x", "musicbrainz");
    expect(results[0]).toEqual({ title: "Artist", year: 1990, overview: "disamb", posterUrl: null, externalIds: { musicbrainz: "mbid-1" } });
  });

  it("Deezer search maps fields", async () => {
    stub([{ test: (u) => u.includes("api.deezer.com/search/artist"), response: ok({ data: [{ name: "Artist", id: 5, picture_medium: "http://pic" }] }) }]);
    const results = await metadata.searchMetadata("artist", "x", "deezer");
    expect(results[0]).toEqual({ title: "Artist", year: null, overview: null, posterUrl: "http://pic", externalIds: { deezer: "5" } });
  });

  it("Discogs search maps fields, and leaves posterUrl null when thumb is absent", async () => {
    setSetting("discogsToken", "tok");
    const fetchMock = stub([{ test: (u) => u.includes("api.discogs.com/database/search"), response: ok({ results: [{ title: "Artist", id: 7, thumb: "http://t" }, { title: "NoThumb", id: 8 }] }) }]);
    const results = await metadata.searchMetadata("artist", "x", "discogs");
    expect(results[0]).toEqual({ title: "Artist", year: null, overview: null, posterUrl: "http://t", externalIds: { discogs: "7" } });
    expect(results[1].posterUrl).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toContain("token=tok");
  });

  it("Last.fm search: falls back to name when mbid is blank, and unwraps a single non-array match", async () => {
    setSetting("lastfmApiKey", "k");
    stub([{ test: (u) => u.includes("ws.audioscrobbler.com"), response: ok({ results: { artistmatches: { artist: { name: "Solo Artist", mbid: "", image: [{ size: "large", "#text": "http://img" }] } } } }) }]);
    const results = await metadata.searchMetadata("artist", "x", "lastfm");
    expect(results).toEqual([{ title: "Solo Artist", year: null, overview: null, posterUrl: "http://img", externalIds: { lastfm: "Solo Artist" } }]);
  });

  it("MusicBrainz results missing a poster are opportunistically backfilled from Deezer by name", async () => {
    stub([
      { test: (u) => u.includes("musicbrainz.org"), response: ok({ artists: [{ name: "Shared Name", id: "mbid-1" }] }) },
      { test: (u) => u.includes("deezer.com/search/artist"), response: ok({ data: [{ name: "Shared Name", id: 9, picture_medium: "http://deezer-pic" }] }) },
    ]);
    const results = await metadata.searchMetadata("artist", "shared name", "musicbrainz");
    expect(results[0].posterUrl).toBe("http://deezer-pic");
  });

  it("swallows a Deezer backfill failure and leaves posterUrl null", async () => {
    stub([
      { test: (u) => u.includes("musicbrainz.org"), response: ok({ artists: [{ name: "X", id: "mbid-1" }] }) },
      { test: (u) => u.includes("deezer.com/search/artist"), response: notOk(500) },
    ]);
    const results = await metadata.searchMetadata("artist", "x", "musicbrainz");
    expect(results[0].posterUrl).toBeNull();
  });

  it("does not attempt a Deezer backfill when every MusicBrainz result already has a poster", async () => {
    // MusicBrainz never actually sets posterUrl itself, so this exercises the `.some()` guard via
    // a search that legitimately returns zero results (vacuously "none missing a poster").
    const fetchMock = stub([{ test: (u) => u.includes("musicbrainz.org"), response: ok({ artists: [] }) }]);
    await metadata.searchMetadata("artist", "x", "musicbrainz");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("deezer"))).toHaveLength(0);
  });
});

describe("searchMetadata: authors/audiobooks", () => {
  it("Open Library author search maps fields, and handles a missing birth_date/top_work/key", async () => {
    stub([{ test: (u) => u.includes("openlibrary.org/search/authors.json"), response: ok({ docs: [{ name: "Author", birth_date: "1950", top_work: "Book1", key: "OL1A" }] }) }]);
    const results = await metadata.searchMetadata("author", "x", "openlibrary");
    expect(results[0]).toEqual({ title: "Author", year: 1950, overview: "Known for: Book1", posterUrl: "https://covers.openlibrary.org/a/olid/OL1A-M.jpg", externalIds: { openlibrary: "OL1A" } });

    stub([{ test: (u) => u.includes("openlibrary.org/search/authors.json"), response: ok({ docs: [{ name: "Bare Author" }] }) }]);
    const bare = await metadata.searchMetadata("author", "x", "openlibrary");
    expect(bare[0]).toEqual({ title: "Bare Author", year: null, overview: null, posterUrl: null, externalIds: { openlibrary: undefined } });
  });

  it("Google Books author search dedupes authors across multiple items", async () => {
    stub([
      {
        test: (u) => u.includes("googleapis.com/books"),
        response: ok({ items: [{ volumeInfo: { authors: ["Author1", "Author2"], title: "Book1", imageLinks: { thumbnail: "http://t" } } }, { volumeInfo: { authors: ["Author1"], title: "Book2" } }] }),
      },
    ]);
    const results = await metadata.searchMetadata("author", "x", "googlebooks");
    expect(results.map((r) => r.title)).toEqual(["Author1", "Author2"]);
    expect(results[0].overview).toBe("Known for: Book1");
  });

  it("iTunes author search dedupes by author name", async () => {
    stub([{ test: (u) => u.includes("itunes.apple.com/search"), response: ok({ results: [{ artistName: "Author1", trackName: "Book1", artworkUrl100: "http://x/100x100/y.jpg" }, { artistName: "Author1", trackName: "Book2" }] }) }]);
    const results = await metadata.searchMetadata("author", "x", "itunes");
    expect(results).toHaveLength(1);
    expect(results[0].posterUrl).toBe("http://x/600x600/y.jpg");
  });

  it("Hardcover: sends a Bearer-prefixed Authorization header and unwraps hits without a document wrapper", async () => {
    setSetting("hardcoverApiToken", "raw-token");
    const fetchMock = stub([{ test: (u) => u.includes("api.hardcover.app"), response: ok({ data: { search: { results: { hits: [{ name: "Author1", bio: "b", image: { url: "http://i" }, id: 5 }] } } } }) }]);
    const results = await metadata.searchMetadata("author", "x", "hardcover");
    expect(results[0]).toEqual({ title: "Author1", year: null, overview: "b", posterUrl: "http://i", externalIds: { hardcover: "5" } });
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer raw-token");
  });

  it("Hardcover: an already-Bearer-prefixed token is used as-is, and a GraphQL errors[] response throws", async () => {
    setSetting("hardcoverApiToken", "Bearer already-prefixed");
    const fetchMock = stub([{ test: (u) => u.includes("api.hardcover.app"), response: ok({ data: { search: { results: { hits: [] } } } }) }]);
    await metadata.searchMetadata("author", "x", "hardcover");
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer already-prefixed");

    stub([{ test: (u) => u.includes("api.hardcover.app"), response: ok({ errors: [{ message: "bad token" }] }) }]);
    await expect(metadata.searchMetadata("author", "x", "hardcover")).rejects.toThrow("Hardcover search failed: bad token");
  });

  it("Goodreads: scrapes author rows from the search page HTML and dedupes by author id", async () => {
    const html = `<table>
      <tr itemtype="http://schema.org/Book">
        <td><a class="bookTitle"><span itemprop="name">Book One</span></a>
        <a class="authorName" href="/author/show/123.Author_Name"><span itemprop="name">Author Name</span></a></td>
      </tr>
      <tr itemtype="http://schema.org/Book">
        <td><a class="bookTitle"><span itemprop="name">Book Two</span></a>
        <a class="authorName" href="/author/show/123.Author_Name"><span itemprop="name">Author Name</span></a></td>
      </tr>
    </table>`;
    stub([{ test: (u) => u.includes("goodreads.com/search"), response: okText(html) }]);
    const results = await metadata.searchMetadata("author", "x", "goodreads");
    // The whole path segment after /author/show/ (numeric id + slugified name) is used as the
    // externalId, matching real Goodreads URLs like /author/show/153394.Chuck_Palahniuk.
    expect(results).toEqual([{ title: "Author Name", year: null, overview: "Known for: Book One", posterUrl: null, externalIds: { goodreads: "123.Author_Name" } }]);
  });

  it("AudNexus: sorts an exact name match first and drops candidates whose detail lookup fails", async () => {
    stub([
      { test: (u) => u.includes("api.audnex.us/authors?"), response: ok([{ asin: "A2", name: "Someone Else" }, { asin: "A1", name: "Exact Match" }]) },
      { test: (u) => u.includes("api.audnex.us/authors/A1"), response: ok({ name: "Exact Match", description: "bio", image: "http://img" }) },
      { test: (u) => u.includes("api.audnex.us/authors/A2"), response: notOk(500) },
    ]);
    const results = await metadata.searchMetadata("author", "Exact Match", "audnexus");
    expect(results).toEqual([{ title: "Exact Match", year: null, overview: "bio", posterUrl: "http://img", externalIds: { audnexus: "A1" } }]);
  });

  it("Audible author search dedupes by author name, and handles missing product_images", async () => {
    stub([{ test: (u) => u.includes("api.audible.com"), response: ok({ products: [{ authors: [{ name: "Author1" }], title: "Book1", product_images: { "500": "http://500" } }, { authors: [{ name: "Author1" }], title: "Book2" }] }) }]);
    const results = await metadata.searchMetadata("audiobook", "x", "audible");
    expect(results).toEqual([{ title: "Author1", year: null, overview: "Known for: Book1", posterUrl: "http://500", externalIds: { audible: "Author1" } }]);

    stub([{ test: (u) => u.includes("api.audible.com"), response: ok({ products: [{ authors: [{ name: "Author2" }], title: "Book3" }] }) }]);
    const noImage = await metadata.searchMetadata("audiobook", "x", "audible");
    expect(noImage[0].posterUrl).toBeNull();
  });

  it("Audible books fall back to a null releaseDate when release_date is absent", async () => {
    stub([{ test: (u) => u.includes("api.audible.com"), response: ok({ products: [{ authors: [{ name: "Author1" }], title: "Book1" }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ audible: "Author1" })).toEqual({ provider: "audible", children: [{ title: "Book1", releaseDate: null }] });
  });
});

describe("searchMetadata: comics/manga/roms/video/podcast/adult", () => {
  it("ComicVine search strips HTML from the description, and handles a missing start_year/image/description", async () => {
    setSetting("comicVineApiKey", "k");
    stub([{ test: (u) => u.includes("comicvine.gamespot.com/api/search"), response: ok({ results: [{ name: "Comic1", start_year: "2000", description: "<p>ov</p>", image: { medium_url: "http://m" }, id: 1 }] }) }]);
    const results = await metadata.searchMetadata("comic", "x", "comicvine");
    expect(results[0]).toEqual({ title: "Comic1", year: 2000, overview: "ov", posterUrl: "http://m", externalIds: { comicvine: "1" } });

    stub([{ test: (u) => u.includes("comicvine.gamespot.com/api/search"), response: ok({ results: [{ name: "Bare Comic", id: 2 }] }) }]);
    const bare = await metadata.searchMetadata("comic", "x", "comicvine");
    expect(bare[0]).toEqual({ title: "Bare Comic", year: null, overview: null, posterUrl: null, externalIds: { comicvine: "2" } });
  });

  it("manga: AniList's TYPE_SPECIFIC override sends a MANGA-typed GraphQL query, not the anime one, and never sets runtimeMinutes", async () => {
    const fetchMock = stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Page: { media: [{ id: 1, title: { romaji: "R", english: "E" }, coverImage: {}, duration: 24 }] } } }) }]);
    const results = await metadata.searchMetadata("manga", "x", "anilist");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).query).toContain("type: MANGA");
    expect("runtimeMinutes" in results[0]).toBe(false); // unlike searchSeriesAnilist, the manga search never populates this field
  });

  it("MangaDex search falls back through title locales and builds the cover URL", async () => {
    stub([
      {
        test: (u) => u.includes("api.mangadex.org/manga?"),
        response: ok({
          data: [
            { id: "m1", attributes: { title: { en: "Manga1" } }, relationships: [{ type: "cover_art", attributes: { fileName: "c.jpg" } }] },
            { id: "m2", attributes: { title: { ja: "漫画2" } }, relationships: [] },
            { id: "m3", attributes: { title: {} }, relationships: [] },
          ],
        }),
      },
    ]);
    const results = await metadata.searchMetadata("manga", "x", "mangadex");
    // MangaDex's own thumbnail convention appends ".256.jpg" after the cover's already-complete
    // filename (which itself ends in .jpg) — a genuine double extension, not a fixture mistake.
    expect(results[0]).toEqual({ title: "Manga1", year: null, overview: null, posterUrl: "https://uploads.mangadex.org/covers/m1/c.jpg.256.jpg", externalIds: { mangadex: "m1" } });
    expect(results[1].title).toBe("漫画2");
    expect(results[2].title).toBe("Unknown");
  });

  it("RAWG rom search normalizes metacritic to a 0-10 rating and uses screenshot index 1 as backdrop", async () => {
    setSetting("rawgApiKey", "k");
    stub([{ test: (u) => u.includes("api.rawg.io/api/games?"), response: ok({ results: [{ name: "Game1", released: "2000-01-01", background_image: "http://bg", id: 1, metacritic: 85, short_screenshots: [{ image: "http://ss0" }, { image: "http://ss1" }] }] }) }]);
    const results = await metadata.searchMetadata("rom", "x", "rawg");
    expect(results[0]).toEqual({ title: "Game1", year: 2000, overview: null, posterUrl: "http://bg", externalIds: { rawg: "1" }, rating: 8.5, backdropUrl: "http://ss1", genres: [] });

    stub([{ test: (u) => u.includes("api.rawg.io/api/games?"), response: ok({ results: [{ name: "NoMetacritic", id: 2 }] }) }]);
    const noMetacritic = await metadata.searchMetadata("rom", "x", "rawg");
    expect(noMetacritic[0].rating).toBeNull();
    expect(noMetacritic[0].backdropUrl).toBeNull();
  });

  it("IGDB rom search converts a unix-seconds release date and rewrites cover/screenshot image sizes", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ id: 1, name: "Game1", first_release_date: 1000000000, cover: { url: "//img/t_thumb/x.jpg" }, total_rating: 88, screenshots: [{ url: "//img/t_thumb/y.jpg" }] }]) },
    ]);
    const results = await metadata.searchMetadata("rom", "x", "igdb");
    expect(results[0]).toEqual({ title: "Game1", year: 2001, overview: null, posterUrl: "https://img/t_cover_big/x.jpg", externalIds: { igdb: "1" }, rating: 8.8, backdropUrl: "https://img/t_screenshot_big/y.jpg" });
  });

  it("ScreenScraper rom search prefers the 'wor' region and falls back to the top-level name", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    stub([
      {
        test: (u) => u.includes("jeuRecherche.php"),
        response: ok({ response: { jeux: [{ id: 1, noms: [{ region: "wor", text: "Game1" }], dates: [{ region: "wor", text: "2000-01-01" }], synopsis: [{ langue: "en", text: "Syn" }], medias: [{ type: "box-2D", url: "https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1&media=box-2D(wor)" }] }, { id: 2, nom: "Fallback Name" }] } }),
      },
    ]);
    const results = await metadata.searchMetadata("rom", "x", "screenscraper");
    expect(results[0]).toEqual({
      title: "Game1",
      year: 2000,
      overview: "Syn",
      posterUrl: "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1&media=box-2D(wor)",
      externalIds: { screenscraper: "1" },
    });
    expect(results[1].title).toBe("Fallback Name");
    expect(results[1].posterUrl).toBeNull();
  });

  it("ScreenScraper rom search never returns the dev or user credentials ScreenScraper echoes into its media URLs", async () => {
    setSetting("screenscraperDevId", "dev-id-1");
    setSetting("screenscraperDevPassword", "dev-secret-1");
    setSetting("screenscraperUserId", "admin-user");
    setSetting("screenscraperUserPassword", "admin-secret-1");
    const echoed =
      "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev-id-1&devpassword=dev-secret-1&softname=AoNarr&ssid=admin-user&sspassword=admin-secret-1&systemeid=1&jeuid=3&media=box-2D(wor)";
    stub([{ test: (u) => u.includes("jeuRecherche.php"), response: ok({ response: { jeux: [{ id: 3, nom: "Game3", medias: [{ type: "box-2D", url: echoed }] }] } }) }]);

    const [result] = await metadata.searchMetadata("rom", "x", "screenscraper");
    const serialized = JSON.stringify(result);
    for (const secret of ["dev-id-1", "dev-secret-1", "admin-user", "admin-secret-1"]) expect(serialized).not.toContain(secret);
    expect(metadata.isScreenscraperArtworkRef(result.posterUrl)).toBe(true);
    const ref = new URL(result.posterUrl!.slice(metadata.SCREENSCRAPER_ARTWORK_PREFIX.length));
    expect([...ref.searchParams.keys()].sort()).toEqual(["jeuid", "media", "softname", "systemeid"]);
  });

  it("TheGamesDB rom search resolves boxart via the base_url + per-game image list, falling back to base_url.original when .medium is absent", async () => {
    setSetting("theGamesDbApiKey", "k");
    stub([
      {
        test: (u) => u.includes("api.thegamesdb.net/v1/Games/ByGameName"),
        response: ok({ data: { games: [{ id: 1, game_title: "Game1", release_date: "2000-01-01", overview: "ov" }] }, include: { boxart: { base_url: { medium: "http://base/" }, data: { "1": [{ side: "front", filename: "a.jpg" }] } } } }),
      },
    ]);
    const results = await metadata.searchMetadata("rom", "x", "thegamesdb");
    expect(results[0]).toEqual({ title: "Game1", year: 2000, overview: "ov", posterUrl: "http://base/a.jpg", externalIds: { thegamesdb: "1" } });

    stub([
      {
        test: (u) => u.includes("api.thegamesdb.net/v1/Games/ByGameName"),
        response: ok({ data: { games: [{ id: 2, game_title: "Game2" }] }, include: { boxart: { base_url: { original: "http://orig/" }, data: { "2": [{ side: "front", filename: "b.jpg" }] } } } }),
      },
    ]);
    const fallback = await metadata.searchMetadata("rom", "x", "thegamesdb");
    expect(fallback[0].posterUrl).toBe("http://orig/b.jpg");
  });

  it("YouTube video search falls back to id.channelId when snippet.channelId is absent", async () => {
    setSetting("youtubeApiKey", "k");
    stub([{ test: (u) => u.includes("youtube/v3/search"), response: ok({ items: [{ snippet: { title: "Chan1", publishedAt: "2010-01-01T00:00:00Z", description: "d", thumbnails: { medium: { url: "http://t" } } }, id: { channelId: "c1" } }] }) }]);
    const results = await metadata.searchMetadata("video", "x", "youtube");
    expect(results[0]).toEqual({ title: "Chan1", year: 2010, overview: "d", posterUrl: "http://t", externalIds: { youtube: "c1" } });
  });

  it("Vimeo video search picks the largest picture size", async () => {
    setSetting("vimeoAccessToken", "tok");
    stub([{ test: (u) => u.includes("api.vimeo.com/users?"), response: ok({ data: [{ name: "User1", created_time: "2010-01-01T00:00:00Z", bio: "b", pictures: { sizes: [{ link: "http://s1" }, { link: "http://s2" }] }, uri: "/users/123" }] }) }]);
    const results = await metadata.searchMetadata("video", "x", "vimeo");
    expect(results[0]).toEqual({ title: "User1", year: 2010, overview: "b", posterUrl: "http://s2", externalIds: { vimeo: "123" } });
  });

  it("podcast: iTunes's TYPE_SPECIFIC override searches media=podcast and keys results by podcastFeed (not itunes)", async () => {
    const fetchMock = stub([{ test: (u) => u.includes("itunes.apple.com/search"), response: ok({ results: [{ collectionName: "Show1", artistName: "Host1", feedUrl: "http://feed.xml", artworkUrl600: "http://600" }, { trackName: "NoFeed" }] }) }]);
    const results = await metadata.searchMetadata("podcast", "x", "itunes");
    expect(results).toEqual([{ title: "Show1", year: null, overview: "By Host1", posterUrl: "http://600", externalIds: { podcastFeed: "http://feed.xml" } }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("media=podcast");
  });

  it("podcast: falls back to a null overview and posterUrl when artistName/artwork are absent, and to trackName when there's no collectionName", async () => {
    stub([{ test: (u) => u.includes("itunes.apple.com/search"), response: ok({ results: [{ trackName: "Show2", feedUrl: "http://feed2.xml" }] }) }]);
    const results = await metadata.searchMetadata("podcast", "x", "itunes");
    expect(results[0]).toEqual({ title: "Show2", year: null, overview: null, posterUrl: null, externalIds: { podcastFeed: "http://feed2.xml" } });
  });

  it("ThePornDB adult search maps performers, falling back to parent.name and dropping nameless entries", async () => {
    setSetting("thePornDbApiKey", "k");
    stub([{ test: (u) => u.includes("api.metadataapi.net/scenes?"), response: ok({ data: [{ title: "Scene1", date: "2020-01-01", description: "d", image: "http://img", id: 1, site: { name: "Studio1" }, performers: [{ name: "P1" }, { parent: { name: "P2" } }, {}] }] }) }]);
    const results = await metadata.searchMetadata("adult", "x", "theporndb");
    expect(results[0]).toEqual({ title: "Scene1", year: 2020, overview: "d", posterUrl: "http://img", externalIds: { theporndb: "1" }, studio: "Studio1", performers: ["P1", "P2"] });

    stub([{ test: (u) => u.includes("api.metadataapi.net/scenes?"), response: ok({ data: [{ title: "No Studio Or Date", id: 2 }] }) }]);
    const bare = await metadata.searchMetadata("adult", "x", "theporndb");
    expect(bare[0].year).toBeNull();
    expect(bare[0].studio).toBeNull();
    expect(bare[0].performers).toBeUndefined();
  });
});

describe("searchMetadata: year-based re-ranking", () => {
  it("sorts an exact year match first even when the provider returned it second", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("search/movie"), response: ok({ results: [{ id: 1, title: "Remake", release_date: "2010-01-01" }, { id: 2, title: "Original", release_date: "1999-01-01" }] }) }]);
    const results = await metadata.searchMetadata("movie", "x", "tmdb", 1999);
    expect(results.map((r) => r.title)).toEqual(["Original", "Remake"]);
  });

  it("orders by year distance when there's no exact match, and never filters anything out", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("search/movie"), response: ok({ results: [{ id: 1, title: "Far", release_date: "1990-01-01" }, { id: 2, title: "Close", release_date: "1999-01-01" }, { id: 3, title: "NoYear" }] }) }]);
    const results = await metadata.searchMetadata("movie", "x", "tmdb", 2000);
    expect(results.map((r) => r.title)).toEqual(["Close", "Far", "NoYear"]);
  });

  it("leaves ordering untouched when no year is passed", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("search/movie"), response: ok({ results: [{ id: 1, title: "First" }, { id: 2, title: "Second" }] }) }]);
    const results = await metadata.searchMetadata("movie", "x", "tmdb");
    expect(results.map((r) => r.title)).toEqual(["First", "Second"]);
  });
});

// ---------------------------------------------------------------------------
// fetchByExternalId
// ---------------------------------------------------------------------------

describe("fetchByExternalId", () => {
  it("tmdb: routes movie/ppv to the movie endpoint, series/anime to the tv endpoint, and rejects other types", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/movie/1"), response: ok({ id: 1, title: "M" }) },
      { test: (u) => u.includes("/tv/2"), response: ok({ id: 2, name: "S" }) },
    ]);
    expect((await metadata.fetchByExternalId("movie", "tmdb", "1")).title).toBe("M");
    expect((await metadata.fetchByExternalId("series", "tmdb", "2")).title).toBe("S");
    await expect(metadata.fetchByExternalId("artist", "tmdb", "1")).rejects.toThrow('TMDB id lookup isn\'t available for "artist"');
  });

  it("imdb: resolves via TMDB's find endpoint to a movie or tv result, or throws when neither matches", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/find/tt1"), response: ok({ movie_results: [{ id: 10 }], tv_results: [] }) },
      { test: (u) => u.includes("/movie/10"), response: ok({ id: 10, title: "Found Movie" }) },
    ]);
    expect((await metadata.fetchByExternalId("movie", "imdb", "tt1")).title).toBe("Found Movie");

    stub([{ test: (u) => u.includes("/find/tt2"), response: ok({ movie_results: [], tv_results: [] }) }]);
    await expect(metadata.fetchByExternalId("movie", "imdb", "tt2")).rejects.toThrow('No TMDB match found for IMDb id "tt2"');
  });

  it("tvdb: returns the mapped series or throws when not found", async () => {
    setSetting("tvdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/5/extended"), response: ok({ data: { id: 5, name: "X", year: "2000", overview: "ov", image: "http://img" } }) },
    ]);
    expect(await metadata.fetchByExternalId("series", "tvdb", "5")).toEqual({ title: "X", year: 2000, overview: "ov", posterUrl: "http://img", externalIds: { tvdb: "5" }, status: null });

    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/6/extended"), response: ok({ data: null }) },
    ]);
    await expect(metadata.fetchByExternalId("series", "tvdb", "6")).rejects.toThrow('No TVDB series found for id "6"');
  });

  it("tvmaze: strips HTML from the summary, and uses a distinct message for a 404 vs. a generic HTTP error", async () => {
    stub([{ test: (u) => u.includes("api.tvmaze.com/shows/5"), response: ok({ id: 5, name: "X", premiered: "2010-01-01", summary: "<p>ov</p>", image: { medium: "http://img" } }) }]);
    expect(await metadata.fetchByExternalId("series", "tvmaze", "5")).toEqual({ title: "X", year: 2010, overview: "ov", posterUrl: "http://img", externalIds: { tvmaze: "5" }, status: null });

    stub([{ test: (u) => u.includes("api.tvmaze.com/shows/999"), response: notOk(404) }]);
    await expect(metadata.fetchByExternalId("series", "tvmaze", "999")).rejects.toThrow('No TVMaze show found for id "999"');

    stub([{ test: (u) => u.includes("api.tvmaze.com/shows/6"), response: notOk(500) }]);
    await expect(metadata.fetchByExternalId("series", "tvmaze", "6")).rejects.toThrow("TVMaze lookup failed: HTTP 500");
  });

  it("trakt: maps the flat (not .show-nested) detail shape, always with a null posterUrl", async () => {
    setSetting("traktClientId", "cid");
    stub([{ test: (u) => u.includes("api.trakt.tv/shows/7"), response: ok({ title: "X", year: 2010, overview: "ov", ids: { trakt: 7 } }) }]);
    expect(await metadata.fetchByExternalId("series", "trakt", "7")).toEqual({ title: "X", year: 2010, overview: "ov", posterUrl: null, externalIds: { trakt: "7" } });

    stub([{ test: (u) => u.includes("api.trakt.tv/shows/999"), response: notOk(404) }]);
    await expect(metadata.fetchByExternalId("series", "trakt", "999")).rejects.toThrow('No Trakt show found for id "999"');
  });

  it("trakt: looks a movie/ppv id up under /movies/ (a separate id space from shows) and maps the movie fields", async () => {
    setSetting("traktClientId", "cid");
    const fetchMock = stub([
      {
        test: (u) => u.startsWith("https://api.trakt.tv/movies/12?"),
        response: ok({ title: "Film", year: 1999, overview: "ov", released: "1999-03-31", runtime: 136, certification: "R", ids: { trakt: 12, imdb: "tt0133093", tmdb: 603 } }),
      },
      { test: (u) => u.includes("api.trakt.tv/shows/"), response: ok({ title: "Unrelated Show", year: 2020, ids: { trakt: 12 } }) },
    ]);
    const expected = {
      title: "Film",
      year: 1999,
      overview: "ov",
      posterUrl: null,
      externalIds: { trakt: "12", imdb: "tt0133093" },
      releaseDate: "1999-03-31",
      runtimeMinutes: 136,
      contentRating: "R",
    };
    expect(await metadata.fetchByExternalId("movie", "trakt", "12")).toEqual(expected);
    expect(await metadata.fetchByExternalId("ppv", "trakt", "12")).toEqual(expected);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/shows/"))).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("extended")).toBe("full");

    stub([{ test: (u) => u.includes("api.trakt.tv/movies/5"), response: ok({ title: "Bare", ids: { trakt: 5 }, runtime: 0, certification: "Not Rated" }) }]);
    expect(await metadata.fetchByExternalId("movie", "trakt", "5")).toEqual({
      title: "Bare",
      year: null,
      overview: null,
      posterUrl: null,
      externalIds: { trakt: "5" },
      releaseDate: null,
      runtimeMinutes: null,
      contentRating: null,
    });

    stub([{ test: (u) => u.includes("api.trakt.tv/movies/999"), response: notOk(404) }]);
    await expect(metadata.fetchByExternalId("movie", "trakt", "999")).rejects.toThrow('No Trakt movie found for id "999"');
    stub([{ test: (u) => u.includes("api.trakt.tv/movies/6"), response: notOk(502) }]);
    await expect(metadata.fetchByExternalId("movie", "trakt", "6")).rejects.toThrow("Trakt lookup failed: HTTP 502");
  });

  it("anilist: only populates runtimeMinutes for the anime type, and throws when the id has no match", async () => {
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { id: 1, title: { romaji: "R" }, duration: 24, averageScore: 0 } } }) }]);
    const asAnime = await metadata.fetchByExternalId("anime", "anilist", "1");
    expect(asAnime.runtimeMinutes).toBe(24);
    expect(asAnime.rating).toBeNull();
    const asManga = await metadata.fetchByExternalId("manga", "anilist", "1");
    expect(asManga.runtimeMinutes).toBeNull(); // always present (never omitted), just null for non-anime types

    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: null } }) }]);
    await expect(metadata.fetchByExternalId("anime", "anilist", "999")).rejects.toThrow('No AniList entry found for id "999"');
  });

  it("igdb: returns the mapped game or throws when not found", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ id: 1, name: "Game1" }]) },
    ]);
    expect((await metadata.fetchByExternalId("rom", "igdb", "1")).title).toBe("Game1");

    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([]) },
    ]);
    await expect(metadata.fetchByExternalId("rom", "igdb", "999")).rejects.toThrow('No IGDB game found for id "999"');
  });

  it("rawg: uses a distinct message for a 404 vs. a generic HTTP error", async () => {
    setSetting("rawgApiKey", "k");
    stub([{ test: (u) => u.includes("api.rawg.io/api/games/999"), response: notOk(404) }]);
    await expect(metadata.fetchByExternalId("rom", "rawg", "999")).rejects.toThrow('No RAWG game found for id "999"');

    stub([{ test: (u) => u.includes("api.rawg.io/api/games/1"), response: notOk(500) }]);
    await expect(metadata.fetchByExternalId("rom", "rawg", "1")).rejects.toThrow("RAWG lookup failed: HTTP 500");
  });

  it("rawg: maps the by-id detail response's genres array, used by refreshOneItem's re-match path", async () => {
    setSetting("rawgApiKey", "k");
    stub([{ test: (u) => u.includes("api.rawg.io/api/games/2"), response: ok({ id: 2, name: "Genred Game", genres: [{ id: 4, name: "RPG" }, { id: 5, name: "Adventure" }] }) }]);
    expect((await metadata.fetchByExternalId("rom", "rawg", "2")).genres).toEqual(["RPG", "Adventure"]);

    stub([{ test: (u) => u.includes("api.rawg.io/api/games/3"), response: ok({ id: 3, name: "No Genres Game" }) }]);
    expect((await metadata.fetchByExternalId("rom", "rawg", "3")).genres).toEqual([]);
  });

  it("isbn: strips separators, resolves the listed author, and falls back to the book title with a clear note", async () => {
    stub([{ test: (u) => u.includes("ISBN:9780143127550"), response: ok({ "ISBN:9780143127550": { title: "The Book", authors: [{ name: "Real Author" }], publish_date: "2001" } }) }]);
    const withAuthor = await metadata.fetchByExternalId("author", "isbn", "978-0143127550");
    expect(withAuthor.title).toBe("Real Author");
    expect(withAuthor.overview).toContain("Matched via ISBN 9780143127550");

    stub([{ test: (u) => u.includes("ISBN:9780000000002"), response: ok({ "ISBN:9780000000002": { title: "Anonymous Work", publish_date: "1999" } }) }]);
    const withoutAuthor = await metadata.fetchByExternalId("author", "isbn", "9780000000002");
    expect(withoutAuthor.title).toBe("Anonymous Work");
    expect(withoutAuthor.overview).toContain("No author listed");

    stub([{ test: (u) => u.includes("ISBN:0000000000"), response: ok({}) }]);
    await expect(metadata.fetchByExternalId("author", "isbn", "0000000000")).rejects.toThrow('No Open Library record found for ISBN "0000000000"');
  });

  it("youtubePlaylist: delegates to the playlist-by-id lookup, and throws when the playlist doesn't exist", async () => {
    setSetting("youtubeApiKey", "k");
    stub([{ test: (u) => u.includes("youtube/v3/playlists"), response: ok({ items: [{ snippet: { title: "My Playlist", description: "d", thumbnails: { medium: { url: "http://t" } } } }] }) }]);
    const result = await metadata.fetchByExternalId("video", "youtubePlaylist", "PL1");
    expect(result.title).toBe("My Playlist");

    stub([{ test: (u) => u.includes("youtube/v3/playlists"), response: ok({ items: [] }) }]);
    await expect(metadata.fetchByExternalId("video", "youtubePlaylist", "PL999")).rejects.toThrow('No YouTube playlist found for id "PL999"');
  });

  it("throws for an unsupported provider", async () => {
    await expect(metadata.fetchByExternalId("movie", "bogus", "1")).rejects.toThrow('ID lookup isn\'t supported for provider "bogus"');
  });
});

// ---------------------------------------------------------------------------
// Direct by-id exports, ratings, trending, trailer
// ---------------------------------------------------------------------------

describe("fetchMovieByTmdbId / fetchSeriesByTmdbId", () => {
  it("fetchMovieByTmdbId maps runtime/studio and treats a zero runtime as null", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/1"), response: ok({ id: 1, title: "Batman", release_date: "1989-06-23", runtime: 126, production_companies: [{ name: "Warner Bros." }] }) }]);
    const result = await metadata.fetchMovieByTmdbId("1");
    expect(result.runtimeMinutes).toBe(126);
    expect(result.studio).toBe("Warner Bros.");

    stub([{ test: (u) => u.includes("/movie/2"), response: ok({ id: 2, title: "NoRuntime", runtime: 0, production_companies: [] }) }]);
    const noRuntime = await metadata.fetchMovieByTmdbId("2");
    expect(noRuntime.runtimeMinutes).toBeNull();
    expect(noRuntime.studio).toBeNull();
  });

  it("fetchSeriesByTmdbId uses the first episode_run_time entry", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/tv/2"), response: ok({ id: 2, name: "Breaking Bad", episode_run_time: [47, 60] }) }]);
    expect((await metadata.fetchSeriesByTmdbId("2")).runtimeMinutes).toBe(47);

    stub([{ test: (u) => u.includes("/tv/3"), response: ok({ id: 3, name: "NoRuntime", episode_run_time: [] }) }]);
    expect((await metadata.fetchSeriesByTmdbId("3")).runtimeMinutes).toBeNull();
  });

  it("fetchMovieByTmdbId and fetchSeriesByTmdbId map TMDB's own status field", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/4"), response: ok({ id: 4, title: "Status Movie", status: "Post Production" }) }]);
    expect((await metadata.fetchMovieByTmdbId("4")).status).toBe("Post Production");

    stub([{ test: (u) => u.includes("/tv/4"), response: ok({ id: 4, name: "Status Show", status: "Returning Series" }) }]);
    expect((await metadata.fetchSeriesByTmdbId("4")).status).toBe("Returning Series");
  });

  it("fetchMovieByTmdbId fetches the earliest Digital/Physical release dates from TMDB's separate release_dates endpoint, preferring the US region", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/movie/5/release_dates"), response: ok({
        results: [
          { iso_3166_1: "GB", release_dates: [{ type: 4, release_date: "2020-01-01T00:00:00.000Z" }] },
          { iso_3166_1: "US", release_dates: [{ type: 4, release_date: "2020-03-15T00:00:00.000Z" }, { type: 5, release_date: "2020-04-01T00:00:00.000Z" }] },
        ],
      }) },
      { test: (u) => u.includes("/movie/5"), response: ok({ id: 5, title: "Dated Movie" }) },
    ]);

    const result = await metadata.fetchMovieByTmdbId("5");
    expect(result.digitalReleaseDate).toBe("2020-03-15"); // US region preferred over the earlier GB date
    expect(result.physicalReleaseDate).toBe("2020-04-01");
  });

  it("fetchMovieByTmdbId leaves digital/physical release dates null when TMDB has neither, rather than failing the whole lookup", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/movie/6/release_dates"), response: ok({ results: [] }) },
      { test: (u) => u.includes("/movie/6"), response: ok({ id: 6, title: "Undated Movie" }) },
    ]);

    const result = await metadata.fetchMovieByTmdbId("6");
    expect(result.digitalReleaseDate).toBeNull();
    expect(result.physicalReleaseDate).toBeNull();
  });

  it("fetchMovieByTmdbId still returns the rest of the movie's data even when the release_dates call itself fails", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/7"), response: ok({ id: 7, title: "Still Works" }) }]);
    // No route matches "/movie/7/release_dates" — routedFetch throws "unmocked fetch call", which
    // fetchMovieByTmdbId must swallow (see its own .catch()) rather than letting it bubble up.

    const result = await metadata.fetchMovieByTmdbId("7");
    expect(result.title).toBe("Still Works");
    expect(result.digitalReleaseDate).toBeNull();
    expect(result.physicalReleaseDate).toBeNull();
    expect(result.contentRating).toBeNull();
  });

  it("fetchMovieByTmdbId extracts the US certification from release_dates, preferring US over other regions", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/movie/8/release_dates"), response: ok({
        results: [
          { iso_3166_1: "GB", release_dates: [{ type: 3, release_date: "2020-01-01T00:00:00.000Z", certification: "15" }] },
          { iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2020-01-05T00:00:00.000Z", certification: "PG-13" }] },
        ],
      }) },
      { test: (u) => u.includes("/movie/8"), response: ok({ id: 8, title: "Rated Movie" }) },
    ]);
    expect((await metadata.fetchMovieByTmdbId("8")).contentRating).toBe("PG-13");
  });

  it("fetchMovieByTmdbId drops a certification that isn't in this app's rating vocabulary", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/movie/9/release_dates"), response: ok({
        results: [{ iso_3166_1: "DE", release_dates: [{ type: 3, release_date: "2020-01-01T00:00:00.000Z", certification: "FSK 12" }] }],
      }) },
      { test: (u) => u.includes("/movie/9"), response: ok({ id: 9, title: "Foreign Cert Movie" }) },
    ]);
    expect((await metadata.fetchMovieByTmdbId("9")).contentRating).toBeNull();
  });

  it("fetchMovieByTmdbId maps TMDB's genres array to plain names, needing no extra API call", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/20"), response: ok({ id: 20, title: "Genred Movie", genres: [{ id: 1, name: "Action" }, { id: 2, name: "Comedy" }] }) }]);
    expect((await metadata.fetchMovieByTmdbId("20")).genres).toEqual(["Action", "Comedy"]);

    stub([{ test: (u) => u.includes("/movie/21"), response: ok({ id: 21, title: "No Genres" }) }]);
    expect((await metadata.fetchMovieByTmdbId("21")).genres).toEqual([]);
  });

  it("fetchSeriesByTmdbId maps TMDB's genres array to plain names", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/tv/20"), response: ok({ id: 20, name: "Genred Show", genres: [{ id: 1, name: "Drama" }] }) }]);
    expect((await metadata.fetchSeriesByTmdbId("20")).genres).toEqual(["Drama"]);
  });

  it("fetchSeriesByTmdbId fetches the content rating from TMDB's separate content_ratings endpoint, preferring the US region", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/tv/5/content_ratings"), response: ok({
        results: [
          { iso_3166_1: "GB", rating: "15" },
          { iso_3166_1: "US", rating: "TV-MA" },
        ],
      }) },
      { test: (u) => u.includes("/tv/5"), response: ok({ id: 5, name: "Rated Show" }) },
    ]);
    expect((await metadata.fetchSeriesByTmdbId("5")).contentRating).toBe("TV-MA");
  });

  it("fetchSeriesByTmdbId leaves the content rating null when the content_ratings call itself fails", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/tv/6"), response: ok({ id: 6, name: "Unrated Show" }) }]);
    // No route matches "/tv/6/content_ratings" — routedFetch throws, which fetchSeriesByTmdbId must
    // swallow (see its own .catch()) rather than letting it bubble up.
    const result = await metadata.fetchSeriesByTmdbId("6");
    expect(result.title).toBe("Unrated Show");
    expect(result.contentRating).toBeNull();
  });
});

describe("fetchOmdbRatings", () => {
  it("parses Rotten Tomatoes/Metacritic/imdbRating and throws on Response:False", async () => {
    setSetting("omdbApiKey", "k");
    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "True", imdbRating: "8.5", Rated: "PG-13", Ratings: [{ Source: "Rotten Tomatoes", Value: "85%" }, { Source: "Metacritic", Value: "75/100" }] }) }]);
    expect(await metadata.fetchOmdbRatings("tt1")).toEqual({ imdbRating: 8.5, rottenTomatoesScore: 85, metacriticScore: 75, contentRating: "PG-13" });

    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "False", Error: "Movie not found!" }) }]);
    await expect(metadata.fetchOmdbRatings("tt999")).rejects.toThrow("Movie not found!");
  });

  it("drops an OMDb Rated value that isn't in this app's rating vocabulary", async () => {
    setSetting("omdbApiKey", "k");
    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "True", imdbRating: "N/A", Rated: "Not Rated", Ratings: [] }) }]);
    expect((await metadata.fetchOmdbRatings("tt1")).contentRating).toBeNull();
  });
});

describe("fetchTrendingMovies / fetchTrendingSeries", () => {
  it("map TMDB's trending endpoints", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/trending/movie/week"), response: ok({ results: [{ id: 1, title: "M", release_date: "2020-01-01" }] }) },
      { test: (u) => u.includes("/trending/tv/week"), response: ok({ results: [{ id: 2, name: "S", first_air_date: "2020-01-01" }] }) },
    ]);
    expect((await metadata.fetchTrendingMovies())[0].title).toBe("M");
    expect((await metadata.fetchTrendingSeries())[0].title).toBe("S");
  });
});

describe("fetchTrailerFor", () => {
  it("returns null without calling fetch when there's no tmdb id or no api key", async () => {
    const fetchMock = stub([]);
    expect(await metadata.fetchTrailerFor("movie", {})).toBeNull();
    setSetting("tmdbApiKey", "");
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "1" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers an official Trailer, then any Trailer, then any YouTube video, and returns null if none are YouTube", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/1/videos"), response: ok({ results: [{ site: "YouTube", type: "Trailer", official: false, key: "k1" }, { site: "YouTube", type: "Trailer", official: true, key: "k2" }, { site: "Vimeo", type: "Trailer", official: true, key: "k3" }] }) }]);
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "1" })).toBe("https://www.youtube.com/watch?v=k2");

    stub([{ test: (u) => u.includes("/movie/2/videos"), response: ok({ results: [{ site: "Vimeo", type: "Trailer", key: "k1" }] }) }]);
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "2" })).toBeNull();
  });

  it("returns null (not a throw) when the TMDB videos request fails, and uses the tv endpoint for series", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/1/videos"), response: notOk(500) }]);
    expect(await metadata.fetchTrailerFor("movie", { tmdb: "1" })).toBeNull();

    const fetchMock = stub([{ test: (u) => u.includes("/tv/2/videos"), response: ok({ results: [] }) }]);
    await metadata.fetchTrailerFor("series", { tmdb: "2" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/tv/2/videos");
  });
});

// ---------------------------------------------------------------------------
// Episode / season dispatchers
// ---------------------------------------------------------------------------

describe("fetchSeriesEpisodesFor", () => {
  it("prefers tmdb over other ids, fetches every season, and skips a season whose fetch fails", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/tv/1?"), response: ok({ seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }] }) },
      { test: (u) => u.includes("/tv/1/season/1"), response: ok({ episodes: [{ episode_number: 1, name: "Pilot", air_date: "2010-01-01", overview: "ov" }] }) },
      { test: (u) => u.includes("/tv/1/season/2"), response: notOk(500) },
    ]);
    const episodes = await metadata.fetchSeriesEpisodesFor({ tmdb: "1", tvdb: "9" });
    expect(episodes).toEqual([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2010-01-01", overview: "ov" }]);
  });

  it("falls back to tvdb, then tvmaze, then trakt, then anilist in priority order", async () => {
    setSetting("tvdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/9/episodes/default"), response: ok({ data: { episodes: [{ seasonNumber: 1, number: 1, name: "Ep", aired: "2010-01-01", overview: "ov" }] } }) },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ tvdb: "9", tvmaze: "5" })).toEqual([{ seasonNumber: 1, episodeNumber: 1, title: "Ep", airDate: "2010-01-01", overview: "ov" }]);

    stub([{ test: (u) => u.includes("api.tvmaze.com/shows/5/episodes"), response: ok([{ season: 1, number: 1, name: "Ep", airdate: "2010-01-01", summary: "<p>ov</p>" }]) }]);
    expect(await metadata.fetchSeriesEpisodesFor({ tvmaze: "5" })).toEqual([{ seasonNumber: 1, episodeNumber: 1, title: "Ep", airDate: "2010-01-01", overview: "ov" }]);

    setSetting("traktClientId", "cid");
    stub([{ test: (u) => u.includes("api.trakt.tv/shows/7/seasons"), response: ok([{ number: 0, episodes: [{ number: 1, title: "Special" }] }, { number: 1, episodes: [{ number: 1, title: "Pilot", first_aired: "2010-01-01T00:00:00Z", overview: "ov" }] }]) }]);
    expect(await metadata.fetchSeriesEpisodesFor({ trakt: "7" })).toEqual([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2010-01-01", overview: "ov" }]);

    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: 2 } } }) }]);
    expect(await metadata.fetchSeriesEpisodesFor({ anilist: "3" })).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: null, airDate: null, overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: null, airDate: null, overview: null },
    ]);
  });

  it("returns [] when no known id is present", async () => {
    await expect(metadata.fetchSeriesEpisodesFor({})).resolves.toEqual([]);
  });

  it("TVDB: defaults title/airDate/overview to null when absent from an episode", async () => {
    setSetting("tvdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/9/episodes/default"), response: ok({ data: { episodes: [{ seasonNumber: 1, number: 1 }] } }) },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ tvdb: "9" })).toEqual([{ seasonNumber: 1, episodeNumber: 1, title: null, airDate: null, overview: null }]);
  });

  it("TVDB: follows links.next across pages instead of stopping at the first page of episodes", async () => {
    setSetting("tvdbApiKey", "k");
    const fetchMock = stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      {
        test: (u) => u.includes("/v4/series/9/episodes/default"),
        response: (u: string) => {
          const page = new URL(u).searchParams.get("page");
          if (page === "0") {
            return ok({ data: { episodes: [{ seasonNumber: 1, number: 1 }] }, links: { next: "https://api4.thetvdb.com/v4/series/9/episodes/default?page=1" } });
          }
          if (page === "1") return ok({ data: { episodes: [{ seasonNumber: 30, number: 5 }] }, links: { next: null } });
          throw new Error(`unexpected TVDB page ${page}`);
        },
      },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ tvdb: "9" })).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: null, airDate: null, overview: null },
      { seasonNumber: 30, episodeNumber: 5, title: null, airDate: null, overview: null },
    ]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/episodes/default"))).toHaveLength(2);
  });

  it("Trakt: aggregates episodes across multiple real seasons, and defaults title/overview to null when absent", async () => {
    setSetting("traktClientId", "cid");
    stub([
      {
        test: (u) => u.includes("api.trakt.tv/shows/7/seasons"),
        response: ok([
          { number: 0, episodes: [{ number: 1, title: "Special" }] },
          { number: 1, episodes: [{ number: 1, title: "Pilot", first_aired: "2010-01-01T00:00:00Z", overview: "ov" }, { number: 2 }] },
          { number: 2, episodes: [{ number: 1, first_aired: "2011-01-01T00:00:00Z" }] },
        ]),
      },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ trakt: "7" })).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2010-01-01", overview: "ov" },
      { seasonNumber: 1, episodeNumber: 2, title: null, airDate: null, overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: null, airDate: "2011-01-01", overview: null },
    ]);
  });

  it("Trakt: requests full episode objects and turns the UTC first_aired into the show's local air date", async () => {
    setSetting("traktClientId", "cid");
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.trakt.tv/shows/7/seasons"),
        response: ok([
          {
            number: 1,
            episodes: [
              // Sunday 9pm Eastern (EDT) — already Monday in UTC
              { number: 1, title: "Pilot", first_aired: "2014-07-14T01:00:00.000Z", overview: "ov" },
              { number: 2, title: "Two", first_aired: "2014-07-20T16:00:00.000Z", overview: null },
            ],
          },
        ]),
      },
      { test: (u) => u.startsWith("https://api.trakt.tv/shows/7?"), response: ok({ title: "Show", airs: { day: "Sunday", time: "21:00", timezone: "America/New_York" } }) },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ trakt: "7" })).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2014-07-13", overview: "ov" },
      { seasonNumber: 1, episodeNumber: 2, title: "Two", airDate: "2014-07-20", overview: null },
    ]);
    const seasonsCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/seasons"))!;
    expect(new URL(seasonsCall).searchParams.get("extended")).toBe("full,episodes");
  });

  it("Trakt: falls back to the UTC date when the show's time zone is unavailable or unknown", async () => {
    setSetting("traktClientId", "cid");
    const seasons = ok([{ number: 1, episodes: [{ number: 1, first_aired: "2014-07-14T01:00:00.000Z" }] }]);
    stub([
      { test: (u) => u.includes("api.trakt.tv/shows/7/seasons"), response: seasons },
      { test: (u) => u.startsWith("https://api.trakt.tv/shows/7?"), response: notOk(500) },
    ]);
    expect((await metadata.fetchSeriesEpisodesFor({ trakt: "7" }))[0].airDate).toBe("2014-07-14");

    stub([
      { test: (u) => u.includes("api.trakt.tv/shows/8/seasons"), response: ok([{ number: 1, episodes: [{ number: 1, first_aired: "2014-07-14T01:00:00.000Z" }] }]) },
      { test: (u) => u.startsWith("https://api.trakt.tv/shows/8?"), response: ok({ airs: { timezone: "Not/AZone" } }) },
    ]);
    expect((await metadata.fetchSeriesEpisodesFor({ trakt: "8" }))[0].airDate).toBe("2014-07-14");
  });

  it("AniList: a null/zero episode count returns [] rather than an empty placeholder list", async () => {
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: null } } }) }]);
    await expect(metadata.fetchSeriesEpisodesFor({ anilist: "3" })).resolves.toEqual([]);

    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: 0 } } }) }]);
    await expect(metadata.fetchSeriesEpisodesFor({ anilist: "4" })).resolves.toEqual([]);
  });

  it("AniList: a show still airing with no announced total gets every aired episode plus the next one, dated in Japan", async () => {
    // AniList returns episodes: null for ongoing shows like One Piece; nextAiringEpisode is the only count.
    // 2024-01-06T16:00:00Z is 2024-01-07 01:00 JST.
    const fetchMock = stub([
      { test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: null, nextAiringEpisode: { episode: 3, airingAt: Date.UTC(2024, 0, 6, 16) / 1000 } } } }) },
    ]);
    expect(await metadata.fetchSeriesEpisodesFor({ anilist: "21" })).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: null, airDate: null, overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: null, airDate: null, overview: null },
      { seasonNumber: 1, episodeNumber: 3, title: null, airDate: "2024-01-07", overview: null },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toContain("nextAiringEpisode");

    // A known total still wins, and the next episode inside it gets its date.
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: 4, nextAiringEpisode: { episode: 2, airingAt: Date.UTC(2024, 0, 6, 16) / 1000 } } } }) }]);
    const known = await metadata.fetchSeriesEpisodesFor({ anilist: "22" });
    expect(known.map((e) => e.airDate)).toEqual([null, "2024-01-07", null, null]);
  });

  it("AniList: dates episodes from the latest aired and upcoming airing-schedule entries, in the same request", async () => {
    const at = (day: number) => Date.UTC(2026, 8, day, 16) / 1000; // 16:00Z is 01:00 the next day in Japan
    const fetchMock = stub([
      {
        test: (u) => u.includes("graphql.anilist.co"),
        response: ok({
          data: {
            Media: { episodes: null, nextAiringEpisode: { episode: 6, airingAt: at(26) } },
            // AniList's schedule for a long runner starts well after episode 1
            aired: { airingSchedules: [{ episode: 5, airingAt: at(19) }, { episode: 4, airingAt: at(12) }] },
            // scheduled past the count AniList has settled on: not listed yet
            upcoming: { airingSchedules: [{ episode: 6, airingAt: at(26) }, { episode: 7, airingAt: at(33) }] },
          },
        }),
      },
    ]);
    const episodes = await metadata.fetchSeriesEpisodesFor({ anilist: "21" });
    expect(episodes.map((e) => [e.episodeNumber, e.airDate])).toEqual([
      [1, null],
      [2, null],
      [3, null],
      [4, "2026-09-13"],
      [5, "2026-09-20"],
      [6, "2026-09-27"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { query, variables } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(query).toMatch(/airingSchedules\(mediaId: \$id, notYetAired: false, sort: EPISODE_DESC\)/);
    expect(query).toMatch(/airingSchedules\(mediaId: \$id, notYetAired: true, sort: EPISODE\)/);
    expect(variables).toEqual({ id: 21 });

    // "Future episodes" on such a show: the undated back catalogue has aired, only the next one hasn't.
    expect(metadata.upcomingEpisodes(episodes, "2026-09-25").map((e) => e.episodeNumber)).toEqual([6]);
  });

  it("AniList: reads every page of the aired schedule, and counts a show between cours by its latest aired episode", async () => {
    const at = (day: number) => Date.UTC(2026, 6, day, 16) / 1000; // 16:00Z is 01:00 the next day in Japan
    const firstPage = {
      data: {
        // between cours: no total and nothing scheduled next
        Media: { episodes: null, nextAiringEpisode: null },
        aired: { pageInfo: { hasNextPage: true }, airingSchedules: [{ episode: 4, airingAt: at(22) }, { episode: 3, airingAt: at(15) }] },
        upcoming: { airingSchedules: [] },
      },
    };
    const fetchMock = stub([
      {
        test: (u) => u.includes("graphql.anilist.co"),
        response: (_u: string, init: any) =>
          JSON.parse(init.body).variables.page === 2
            ? ok({ data: { aired: { pageInfo: { hasNextPage: false }, airingSchedules: [{ episode: 2, airingAt: at(8) }] } } })
            : ok(firstPage),
      },
    ]);
    const episodes = await metadata.fetchSeriesEpisodesFor({ anilist: "30" });
    expect(episodes.map((e) => [e.episodeNumber, e.airDate])).toEqual([
      [1, null],
      [2, "2026-07-09"],
      [3, "2026-07-16"],
      [4, "2026-07-23"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { query, variables } = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(variables).toEqual({ id: 30, page: 2 });
    expect(query).toMatch(/Page\(page: \$page, perPage: 50\) \{ pageInfo \{ hasNextPage \} airingSchedules\(mediaId: \$id, notYetAired: false, sort: EPISODE_DESC\)/);
    expect(query).not.toContain("Media(");

    // A later page failing keeps what the first one dated; a first-page failure still throws.
    stub([
      {
        test: (u) => u.includes("graphql.anilist.co"),
        response: (_u: string, init: any) => (JSON.parse(init.body).variables.page === 2 ? notOk(429) : ok(firstPage)),
      },
    ]);
    expect((await metadata.fetchSeriesEpisodesFor({ anilist: "30" })).map((e) => e.airDate)).toEqual([null, null, "2026-07-16", "2026-07-23"]);
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: notOk(500) }]);
    await expect(metadata.fetchSeriesEpisodesFor({ anilist: "30" })).rejects.toThrow("AniList episode lookup failed: HTTP 500");
  });

  it("AniList: a finished show whose schedule stops short has every episode aired, its finale dated by the end date", async () => {
    const at = (day: number) => Date.UTC(2018, 0, day, 16) / 1000; // 16:00Z is 01:00 the next day in Japan
    const fetchMock = stub([
      {
        test: (u) => u.includes("graphql.anilist.co"),
        response: ok({
          data: {
            Media: { episodes: 3, status: "FINISHED", endDate: { year: 2018, month: 3, day: 26 }, nextAiringEpisode: null },
            aired: { pageInfo: { hasNextPage: false }, airingSchedules: [{ episode: 1, airingAt: at(8) }] },
            upcoming: { airingSchedules: [] },
          },
        }),
      },
    ]);
    const episodes = await metadata.fetchSeriesEpisodesFor({ anilist: "101925" });
    expect(episodes.map((e) => [e.episodeNumber, e.airDate])).toEqual([
      [1, "2018-01-09"],
      [2, null],
      [3, "2018-03-26"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toMatch(/status endDate \{ year month day \}/);
    expect(metadata.upcomingEpisodes(episodes, "2026-09-25")).toEqual([]);
  });

  it("AniList: a finished or cancelled show's undated finale falls back to a partial end date, then its latest aired entry", async () => {
    const media = (extra: Record<string, unknown>, airingSchedules: unknown[] = []) =>
      stub([
        {
          test: (u) => u.includes("graphql.anilist.co"),
          response: ok({ data: { Media: { episodes: 4, nextAiringEpisode: null, ...extra }, aired: { pageInfo: { hasNextPage: false }, airingSchedules }, upcoming: { airingSchedules: [] } } }),
        },
      ]);
    const finale = async () => (await metadata.fetchSeriesEpisodesFor({ anilist: "40" })).map((e) => e.airDate);

    media({ status: "CANCELLED", endDate: { year: 2004, month: 7, day: null } });
    expect(await finale()).toEqual([null, null, null, "2004-07-01"]);
    media({ status: "FINISHED", endDate: { year: 1999, month: null, day: null } });
    expect(await finale()).toEqual([null, null, null, "1999-01-01"]);
    media({ status: "FINISHED", endDate: { year: null, month: null, day: null } }, [{ episode: 2, airingAt: Date.UTC(2016, 4, 1, 12) / 1000 }]);
    expect(await finale()).toEqual([null, "2016-05-01", null, "2016-05-01"]);
    media({ status: "FINISHED", endDate: null });
    const undated = await metadata.fetchSeriesEpisodesFor({ anilist: "40" });
    expect(metadata.upcomingEpisodes(undated, "2026-09-25")).toEqual([]);

    // a show still airing keeps its undated tail upcoming
    media({ status: "RELEASING", endDate: null });
    expect(await finale()).toEqual([null, null, null, null]);
  });
});

describe("upcomingEpisodes", () => {
  const ep = (seasonNumber: number, episodeNumber: number, airDate: string | null) => ({ seasonNumber, episodeNumber, airDate });

  it("keeps episodes dated today or later, and undated ones no aired episode of their season follows", () => {
    const episodes = [
      ep(1, 1, "2026-01-01"),
      ep(1, 2, null), // a gap before an aired episode: aired
      ep(1, 3, "2026-01-15"),
      ep(1, 4, "2026-09-25"), // airs today
      ep(1, 5, null), // not announced yet
      ep(2, 1, null), // a new season with nothing aired
      ep(2, 2, "2026-10-01"),
      ep(0, 1, null), // specials are judged within season 0 alone
    ];
    expect(metadata.upcomingEpisodes(episodes, "2026-09-25")).toEqual([ep(1, 4, "2026-09-25"), ep(1, 5, null), ep(2, 1, null), ep(2, 2, "2026-10-01"), ep(0, 1, null)]);
  });

  it("treats every undated episode as upcoming when nothing has aired, and compares full timestamps by date", () => {
    expect(metadata.upcomingEpisodes([ep(1, 1, null), ep(1, 2, null)], "2026-09-25")).toHaveLength(2);
    expect(metadata.upcomingEpisodes([ep(1, 1, "2026-09-24T23:00:00Z"), ep(1, 2, "2026-09-25T01:00:00Z")], "2026-09-25")).toEqual([ep(1, 2, "2026-09-25T01:00:00Z")]);
  });
});

describe("fetchSeriesEpisodesForProvider", () => {
  it("fetches from the explicitly named provider, ignoring priority order entirely", async () => {
    setSetting("tvdbApiKey", "k");
    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/9/episodes/default"), response: ok({ data: { episodes: [{ seasonNumber: 0, number: 1, name: "Special", aired: "2010-01-01", overview: "ov" }] } }) },
    ]);
    // Would resolve to tmdb under fetchSeriesEpisodesFor's own priority order — this bypasses that
    // entirely, which is the whole point (pulling a *second* provider's list as a supplement).
    expect(await metadata.fetchSeriesEpisodesForProvider("tvdb", "9")).toEqual([
      { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2010-01-01", overview: "ov" },
    ]);
  });

  it("returns [] for a provider with no episode-fetch implementation, instead of throwing", async () => {
    await expect(metadata.fetchSeriesEpisodesForProvider("musicbrainz", "123")).resolves.toEqual([]);
  });
});

describe("fetchSeriesSeasonsFor", () => {
  it("maps TMDB season posters, swallows a TMDB failure to [], and returns [] without a tmdb id", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/tv/1?"), response: ok({ seasons: [{ season_number: 0, poster_path: "/specials.jpg" }, { season_number: 1, poster_path: "/s1.jpg" }] }) }]);
    expect(await metadata.fetchSeriesSeasonsFor({ tmdb: "1" })).toEqual([{ seasonNumber: 1, posterUrl: "https://image.tmdb.org/t/p/w342/s1.jpg" }]);

    stub([{ test: (u) => u.includes("/tv/2?"), response: notOk(500) }]);
    await expect(metadata.fetchSeriesSeasonsFor({ tmdb: "2" })).resolves.toEqual([]);

    await expect(metadata.fetchSeriesSeasonsFor({})).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Artist album/track dispatchers
// ---------------------------------------------------------------------------

describe("fetchArtistAlbumsFor", () => {
  it("prefers musicbrainz over deezer/discogs/lastfm, and honors a custom musicAlbumTypes setting", async () => {
    setSetting("musicAlbumTypes", "ep, live");
    const fetchMock = stub([{ test: (u) => u.includes("musicbrainz.org/ws/2/release-group"), response: ok({ "release-groups": [{ title: "Album1", "first-release-date": "2000-01-01", id: "rg-1" }] }) }]);
    const result = await metadata.fetchArtistAlbumsFor({ musicbrainz: "mbid-1", deezer: "5" });
    expect(result).toEqual({ provider: "musicbrainz", albums: [{ title: "Album1", releaseDate: "2000-01-01", externalId: "rg-1" }] });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    // MusicBrainz's release-group search expects multiple types as one pipe-separated value, not
    // repeated "type=" params (which its backend rejects with HTTP 400 — see configuredAlbumTypes'
    // own comment in metadata.ts).
    expect(url.searchParams.getAll("type")).toEqual(["ep|live"]);
  });

  it("defaults musicAlbumTypes to ['album'] when unset or only whitespace/commas", async () => {
    setSetting("musicAlbumTypes", " , ,");
    const fetchMock = stub([{ test: (u) => u.includes("musicbrainz.org/ws/2/release-group"), response: ok({ "release-groups": [] }) }]);
    await metadata.fetchArtistAlbumsFor({ musicbrainz: "mbid-1" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.getAll("type")).toEqual(["album"]);
  });

  it("Deezer albums map fields, falling back to the plain cover url when cover_medium is absent", async () => {
    stub([{ test: (u) => u.includes("api.deezer.com/artist/9/albums"), response: ok({ data: [{ title: "Album1", release_date: "2000-01-01", id: 9, cover_medium: "http://c" }] }) }]);
    expect(await metadata.fetchArtistAlbumsFor({ deezer: "9" })).toEqual({ provider: "deezer", albums: [{ title: "Album1", releaseDate: "2000-01-01", externalId: "9", posterUrl: "http://c" }] });

    stub([{ test: (u) => u.includes("api.deezer.com/artist/10/albums"), response: ok({ data: [{ title: "Album2", id: 10, cover: "http://plain-cover" }] }) }]);
    const fallback = await metadata.fetchArtistAlbumsFor({ deezer: "10" });
    expect(fallback?.albums[0].posterUrl).toBe("http://plain-cover");
  });

  it("Discogs albums filter to role:Main and dedupe by title", async () => {
    setSetting("discogsToken", "tok");
    stub([{ test: (u) => u.includes("api.discogs.com/artists/9/releases"), response: ok({ releases: [{ role: "Main", title: "Album1", year: 2000, id: 1, thumb: "http://t" }, { role: "Remix", title: "Skip Me" }, { role: "Main", title: "Album1", id: 2 }] }) }]);
    expect(await metadata.fetchArtistAlbumsFor({ discogs: "9" })).toEqual({ provider: "discogs", albums: [{ title: "Album1", releaseDate: "2000", externalId: "1", posterUrl: "http://t" }] });
  });

  it("Last.fm albums use the mbid param for an mbid-shaped id and the artist param otherwise", async () => {
    setSetting("lastfmApiKey", "k");
    const fetchMock = stub([{ test: (u) => u.includes("artist.gettopalbums"), response: ok({ topalbums: { album: [{ name: "Album1", image: [{ size: "large", "#text": "http://img" }] }] } }) }]);
    await metadata.fetchArtistAlbumsFor({ lastfm: "Plain Artist Name" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("artist")).toBe("Plain Artist Name");

    fetchMock.mockClear();
    await metadata.fetchArtistAlbumsFor({ lastfm: "12345678-1234-1234-1234-123456789012" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("mbid")).toBe("12345678-1234-1234-1234-123456789012");
  });

  it("Last.fm: an artist with exactly one top album unwraps Last.fm's bare-object response instead of crashing", async () => {
    // Same XML->JSON quirk as the search endpoint (already handled above): a single-item list
    // collapses to a bare object rather than a 1-element array.
    setSetting("lastfmApiKey", "k");
    stub([{ test: (u) => u.includes("artist.gettopalbums"), response: ok({ topalbums: { album: { name: "OnlyAlbum", mbid: "" } } }) }]);
    const result = await metadata.fetchArtistAlbumsFor({ lastfm: "Solo Artist" });
    expect(result).toEqual({ provider: "lastfm", albums: [{ title: "OnlyAlbum", releaseDate: null, externalId: "OnlyAlbum", posterUrl: null }] });
  });

  it("returns null when no known artist id is present", async () => {
    await expect(metadata.fetchArtistAlbumsFor({})).resolves.toBeNull();
  });

  it("MusicBrainz: pages by offset up to release-group-count, about one request per second", async () => {
    vi.useFakeTimers();
    const fetchMock = stub([
      {
        test: (u) => u.includes("musicbrainz.org/ws/2/release-group"),
        response: (u: string) => {
          const offset = Number(new URL(u).searchParams.get("offset"));
          const count = offset === 200 ? 25 : 100;
          return ok({ "release-group-count": 225, "release-groups": Array.from({ length: count }, (_, i) => ({ id: `rg-${offset + i}`, title: `Album ${offset + i}` })) });
        },
      },
    ]);
    const pending = metadata.fetchArtistAlbumsFor({ musicbrainz: "mbid-zappa" });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result?.albums).toHaveLength(225);
    expect(result?.albums[224]).toEqual({ title: "Album 224", releaseDate: null, externalId: "rg-224" });
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
  });

  it("MusicBrainz: a later page failing keeps the pages already read, while a first-page failure still throws", async () => {
    vi.useFakeTimers();
    stub([
      {
        test: (u) => u.includes("musicbrainz.org/ws/2/release-group"),
        response: (u: string) =>
          new URL(u).searchParams.get("offset") === "0"
            ? ok({ "release-group-count": 150, "release-groups": Array.from({ length: 100 }, (_, i) => ({ id: `rg-${i}`, title: `Album ${i}` })) })
            : notOk(503),
      },
    ]);
    const pending = metadata.fetchArtistAlbumsFor({ musicbrainz: "mbid-1" });
    await vi.runAllTimersAsync();
    expect((await pending)?.albums).toHaveLength(100);

    stub([{ test: (u) => u.includes("musicbrainz.org/ws/2/release-group"), response: notOk(503) }]);
    await expect(metadata.fetchArtistAlbumsFor({ musicbrainz: "mbid-1" })).rejects.toThrow("MusicBrainz album lookup failed: HTTP 503");
  });

  it("Deezer: follows `next` via the index param instead of stopping at 100 albums", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.deezer.com/artist/12246/albums"),
        response: (u: string) =>
          new URL(u).searchParams.get("index") === "0"
            ? ok({ total: 119, next: "https://api.deezer.com/artist/12246/albums?index=100", data: Array.from({ length: 100 }, (_, i) => ({ id: i, title: `A${i}` })) })
            : ok({ total: 119, data: Array.from({ length: 19 }, (_, i) => ({ id: 100 + i, title: `A${100 + i}` })) }),
      },
    ]);
    const result = await metadata.fetchArtistAlbumsFor({ deezer: "12246" });
    expect(result?.albums).toHaveLength(119);
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("index"))).toEqual(["0", "100"]);
  });

  it("Discogs: reads every page up to pagination.pages before filtering and deduping, spaced to stay under 60 requests a minute", async () => {
    // The spacing is process-wide, so start well clear of the request an earlier test made.
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    setSetting("discogsToken", "tok");
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.discogs.com/artists/45467/releases"),
        response: (u: string) => {
          const page = Number(new URL(u).searchParams.get("page"));
          const releases =
            page === 1
              ? [{ role: "Main", title: "Early", year: 1967, id: 1 }]
              : page === 2
                ? [{ role: "Main", title: "Early", year: 1968, id: 2 }, { role: "Main", title: "Middle", year: 1973, id: 3 }]
                : [{ role: "Main", title: "Late", year: 2014, id: 4 }];
          return ok({ pagination: { page, pages: 3 }, releases });
        },
      },
      { test: (u) => u.includes("api.discogs.com/artists/45468/releases"), response: ok({ pagination: { page: 1, pages: 1 }, releases: [{ role: "Main", title: "Solo", id: 9 }] }) },
    ]);
    const pending = metadata.fetchArtistAlbumsFor({ discogs: "45467" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the first page goes out straight away
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result?.albums.map((a) => a.title)).toEqual(["Early", "Middle", "Late"]);
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("page"))).toEqual(["1", "2", "3"]);

    // Refresh lists the next artist straight after: its first page waits out the gap too.
    const nextArtist = metadata.fetchArtistAlbumsFor({ discogs: "45468" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await nextArtist)?.albums.map((a) => a.title)).toEqual(["Solo"]);

    // Two lists fetched at once (a manual Refresh during the scheduled one) take turns as well.
    await vi.advanceTimersByTimeAsync(1100);
    fetchMock.mockClear();
    const both = Promise.all([metadata.fetchArtistAlbumsFor({ discogs: "45468" }), metadata.fetchArtistAlbumsFor({ discogs: "45468" })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1099);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await both;
  });
});

describe("fetchAlbumTracksFor", () => {
  it("MusicBrainz: numbers tracks continuously across discs and picks the best (Official, preferred-country, earliest) release", async () => {
    stub([
      {
        test: (u) => u.includes("/release-group/rg-1"),
        response: ok({ releases: [{ id: "r-bad", status: "Bootleg", country: "XX", date: "1999-01-01" }, { id: "r-good", status: "Official", country: "US", date: "2000-01-01" }] }),
      },
      {
        test: (u) => u.includes("/release/r-good"),
        response: ok({ media: [{ tracks: [{ number: "1", title: "T1", length: 200000 }, { title: "T2 (no number)", length: 180000 }] }, { tracks: [{ number: "1", title: "T3", length: 220000 }] }] }),
      },
    ]);
    const tracks = await metadata.fetchAlbumTracksFor("musicbrainz", "rg-1");
    expect(tracks).toEqual([
      { trackNumber: 1, title: "T1", durationSeconds: 200 },
      { trackNumber: 2, title: "T2 (no number)", durationSeconds: 180 },
      { trackNumber: 3, title: "T3", durationSeconds: 220 },
    ]);
  });

  it("MusicBrainz: pickBestRelease ranks Official > preferred country > earliest date, in that tier order", async () => {
    // Each sub-case registers a fetch route ONLY for the release it expects to win — if the wrong
    // release were picked, the test fails on "unmocked fetch call" rather than silently passing.
    stub([
      { test: (u) => u.includes("/release-group/rg-tie1"), response: ok({ releases: [{ id: "non-pref", status: "Bootleg", country: "XX", date: "1990-01-01" }, { id: "pref", status: "Bootleg", country: "US", date: "2000-01-01" }] }) },
      { test: (u) => u.includes("/release/pref"), response: ok({ media: [{ tracks: [{ number: "1", title: "WonOnCountry" }] }] }) },
    ]);
    expect((await metadata.fetchAlbumTracksFor("musicbrainz", "rg-tie1"))[0].title).toBe("WonOnCountry");

    stub([
      { test: (u) => u.includes("/release-group/rg-tie2"), response: ok({ releases: [{ id: "later-nonpref", status: "Official", country: "DE", date: "2000-01-01" }, { id: "earlier-pref", status: "Official", country: "GB", date: "1990-01-01" }] }) },
      { test: (u) => u.includes("/release/earlier-pref"), response: ok({ media: [{ tracks: [{ number: "1", title: "CountryBeatsDate" }] }] }) },
    ]);
    expect((await metadata.fetchAlbumTracksFor("musicbrainz", "rg-tie2"))[0].title).toBe("CountryBeatsDate");

    stub([
      { test: (u) => u.includes("/release-group/rg-tie3"), response: ok({ releases: [{ id: "later", status: "Official", country: "US", date: "2005-01-01" }, { id: "earlier", status: "Official", country: "US", date: "2001-01-01" }] }) },
      { test: (u) => u.includes("/release/earlier"), response: ok({ media: [{ tracks: [{ number: "1", title: "EarliestWins" }] }] }) },
    ]);
    expect((await metadata.fetchAlbumTracksFor("musicbrainz", "rg-tie3"))[0].title).toBe("EarliestWins");

    stub([
      { test: (u) => u.includes("/release-group/rg-tie4"), response: ok({ releases: [{ id: "no-date", status: "Official", country: "US" }, { id: "has-date", status: "Official", country: "US", date: "1980-01-01" }] }) },
      { test: (u) => u.includes("/release/has-date"), response: ok({ media: [{ tracks: [{ number: "1", title: "DatedBeatsUndated" }] }] }) },
    ]);
    expect((await metadata.fetchAlbumTracksFor("musicbrainz", "rg-tie4"))[0].title).toBe("DatedBeatsUndated");
  });

  it("MusicBrainz: returns [] without a second fetch when the release-group has no releases", async () => {
    const fetchMock = stub([{ test: (u) => u.includes("/release-group/rg-2"), response: ok({ releases: [] }) }]);
    await expect(metadata.fetchAlbumTracksFor("musicbrainz", "rg-2")).resolves.toEqual([]);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("Deezer: maps track fields with a positional fallback", async () => {
    stub([{ test: (u) => u.includes("api.deezer.com/album/9/tracks"), response: ok({ data: [{ title: "T1", duration: 200 }, { track_position: 5, title: "T2", duration: 180 }] }) }]);
    expect(await metadata.fetchAlbumTracksFor("deezer", "9")).toEqual([{ trackNumber: 1, title: "T1", durationSeconds: 200 }, { trackNumber: 5, title: "T2", durationSeconds: 180 }]);
  });

  it("Deezer: numbers a multi-disc album continuously instead of restarting at 1 on every disc", async () => {
    stub([
      {
        test: (u) => u.includes("api.deezer.com/album/11/tracks"),
        response: ok({
          data: [
            { disk_number: 1, track_position: 1, title: "D1T1", duration: 100 },
            { disk_number: 1, track_position: 2, title: "D1T2", duration: 100 },
            { disk_number: 1, track_position: 3, title: "D1T3", duration: 100 },
            { disk_number: 2, track_position: 1, title: "D2T1", duration: 100 },
            { disk_number: 2, track_position: 2, title: "D2T2", duration: 100 },
          ],
        }),
      },
    ]);
    const tracks = await metadata.fetchAlbumTracksFor("deezer", "11");
    expect(tracks.map((t) => [t.trackNumber, t.title])).toEqual([
      [1, "D1T1"],
      [2, "D1T2"],
      [3, "D1T3"],
      [4, "D2T1"],
      [5, "D2T2"],
    ]);
  });

  it("Deezer: requests a large page and follows `next` so a long album isn't cut off", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.deezer.com/album/12/tracks"),
        response: (u: string) => {
          const index = new URL(u).searchParams.get("index");
          if (index === "0") {
            return ok({ data: [{ track_position: 1, title: "A" }, { track_position: 2, title: "B" }], total: 3, next: "https://api.deezer.com/album/12/tracks?index=2" });
          }
          if (index === "2") return ok({ data: [{ track_position: 3, title: "C" }], total: 3 });
          throw new Error(`unexpected Deezer index ${index}`);
        },
      },
    ]);
    const tracks = await metadata.fetchAlbumTracksFor("deezer", "12");
    expect(tracks.map((t) => [t.trackNumber, t.title])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("limit")).toBe("500");
  });

  it("throws for a provider with no track-listing implementation", async () => {
    await expect(metadata.fetchAlbumTracksFor("lastfm", "x")).rejects.toThrow("Track listings aren't available from lastfm");
  });
});

// ---------------------------------------------------------------------------
// fetchCollectionChildrenFor — every provider branch + priority order
// ---------------------------------------------------------------------------

describe("fetchCollectionChildrenFor", () => {
  it("prefers openlibrary over every other id and filters out title-less entries", async () => {
    stub([{ test: (u) => u.includes("openlibrary.org/authors/OL1A/works.json"), response: ok({ entries: [{ title: "Book1", first_publish_date: "2000" }, { first_publish_date: "2001" }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ openlibrary: "OL1A", googlebooks: "Author1" })).toEqual({ provider: "openlibrary", children: [{ title: "Book1", releaseDate: "2000" }] });
  });

  it("googlebooks: maps works", async () => {
    stub([{ test: (u) => u.includes("googleapis.com/books"), response: ok({ items: [{ volumeInfo: { title: "BookX", publishedDate: "2000-01-01" } }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ googlebooks: "Author1" })).toEqual({ provider: "googlebooks", children: [{ title: "BookX", releaseDate: "2000-01-01" }] });
  });

  it("itunes: maps works filtered to an exact artist name match", async () => {
    stub([{ test: (u) => u.includes("itunes.apple.com/search"), response: ok({ results: [{ artistName: "Author1", trackName: "Book1", releaseDate: "2000-01-01T00:00:00Z" }, { artistName: "Someone Else", trackName: "Skip" }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ itunes: "Author1" })).toEqual({ provider: "itunes", children: [{ title: "Book1", releaseDate: "2000-01-01" }] });
  });

  it("hardcover: maps a contribution list, filtering titleless books", async () => {
    setSetting("hardcoverApiToken", "tok");
    stub([{ test: (u) => u.includes("api.hardcover.app"), response: ok({ data: { authors: [{ contributions: [{ book: { id: 1, title: "Book1", release_date: "2000" } }, { book: { title: null } }] }] } }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ hardcover: "5" })).toEqual({ provider: "hardcover", children: [{ title: "Book1", releaseDate: "2000" }] });
  });

  it("goodreads: scrapes an author's book list page, leaving releaseDate null when no 'published YYYY' text is present", async () => {
    const html = `<table>
      <tr itemtype="http://schema.org/Book"><td>
        <a class="bookTitle"><span itemprop="name">Book1</span></a>
        <span class="greyText smallText uitext">published 2015</span>
      </td></tr>
      <tr itemtype="http://schema.org/Book"><td>
        <a class="bookTitle"><span itemprop="name">Book2</span></a>
      </td></tr>
    </table>`;
    stub([{ test: (u) => u.includes("goodreads.com/author/list/123"), response: okText(html) }]);
    expect(await metadata.fetchCollectionChildrenFor({ goodreads: "123" })).toEqual({
      provider: "goodreads",
      children: [
        { title: "Book1", releaseDate: "2015-01-01" },
        { title: "Book2", releaseDate: null },
      ],
    });
  });

  it("goodreads: search skips a row with no title or no author link", async () => {
    const html = `<table>
      <tr itemtype="http://schema.org/Book"><td>
        <a class="bookTitle"><span itemprop="name"></span></a>
        <a class="authorName" href="/author/show/1.Nobody"><span itemprop="name">Nobody</span></a>
      </td></tr>
      <tr itemtype="http://schema.org/Book"><td>
        <a class="bookTitle"><span itemprop="name">No Author Link</span></a>
      </td></tr>
      <tr itemtype="http://schema.org/Book"><td>
        <a class="bookTitle"><span itemprop="name">Real Book</span></a>
        <a class="authorName" href="/author/show/2.Real_Author"><span itemprop="name">Real Author</span></a>
      </td></tr>
    </table>`;
    stub([{ test: (u) => u.includes("goodreads.com/search"), response: okText(html) }]);
    const results = await metadata.searchMetadata("author", "x", "goodreads");
    expect(results.map((r) => r.title)).toEqual(["Real Author"]);
  });

  it("audible: maps works filtered to an exact author match", async () => {
    stub([{ test: (u) => u.includes("api.audible.com"), response: ok({ products: [{ authors: [{ name: "Author1" }], title: "Book1", release_date: "2020-01-01" }, { authors: [{ name: "Other" }], title: "Skip" }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ audible: "Author1" })).toEqual({ provider: "audible", children: [{ title: "Book1", releaseDate: "2020-01-01" }] });
  });

  it("comicvine: maps issues, numbering by issue number with a name fallback", async () => {
    setSetting("comicVineApiKey", "k");
    stub([{ test: (u) => u.includes("comicvine.gamespot.com/api/issues"), response: ok({ results: [{ id: 1, issue_number: "1", name: "First", cover_date: "2000-01-01" }, { id: 2, issue_number: "2", name: null, cover_date: null }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ comicvine: "9" })).toEqual({ provider: "comicvine", children: [{ title: "#1 - First", releaseDate: "2000-01-01", externalId: "1" }, { title: "#2", releaseDate: null, externalId: "2" }] });
  });

  it("mangadex: maps chapters and dedupes repeat chapter numbers", async () => {
    stub([{ test: (u) => u.includes("api.mangadex.org/manga/m1/feed"), response: ok({ data: [{ id: "ch1", attributes: { chapter: "1", title: "First", publishAt: "2020-01-01" } }, { id: "ch1dup", attributes: { chapter: "1", title: "Dup" } }, { id: "ch2", attributes: { chapter: "2", title: null, publishAt: null } }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ mangadex: "m1" })).toEqual({ provider: "mangadex", children: [{ title: "Chapter 1 — First", releaseDate: "2020-01-01", externalId: "ch1" }, { title: "Chapter 2", releaseDate: null, externalId: "ch2" }] });
  });

  it("youtube channel: resolves the uploads playlist then paginates its items", async () => {
    setSetting("youtubeApiKey", "k");
    stub([
      { test: (u) => u.includes("youtube/v3/channels"), response: ok({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }) },
      {
        test: (u) => u.includes("playlistItems") && !u.includes("pageToken"),
        response: ok({ items: [{ snippet: { title: "V1", publishedAt: "2020-01-01T00:00:00Z", resourceId: { videoId: "v1" } } }], nextPageToken: "p2" }),
      },
      { test: (u) => u.includes("pageToken=p2"), response: ok({ items: [{ snippet: { title: "V2", publishedAt: "2020-02-01T00:00:00Z", resourceId: { videoId: "v2" } } }] }) },
    ]);
    expect(await metadata.fetchCollectionChildrenFor({ youtube: "c1" })).toEqual({ provider: "youtube", children: [{ title: "V1", releaseDate: "2020-01-01", externalId: "v1" }, { title: "V2", releaseDate: "2020-02-01", externalId: "v2" }] });
  });

  it("youtube channel: no uploads playlist resolves to []", async () => {
    setSetting("youtubeApiKey", "k");
    stub([{ test: (u) => u.includes("youtube/v3/channels"), response: ok({ items: [{ contentDetails: { relatedPlaylists: {} } }] }) }]);
    expect(await metadata.fetchCollectionChildrenFor({ youtube: "c2" })).toEqual({ provider: "youtube", children: [] });
  });

  it("youtube: a single over-cap page stops pagination after one request", async () => {
    setSetting("youtubeApiKey", "k");
    const bigPage = { items: Array.from({ length: 501 }, (_, i) => ({ snippet: { title: `V${i}`, resourceId: { videoId: `v${i}` } } })), nextPageToken: "more" };
    const fetchMock = stub([{ test: (u) => u.includes("playlistItems"), response: ok(bigPage) }]);
    const { children } = await metadata.fetchCollectionChildrenFor({ youtubePlaylist: "PL1" });
    expect(children).toHaveLength(501);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("playlistItems"))).toHaveLength(1);
  });

  it("vimeo: paginates via paging.next and strips the /videos/ prefix from the id", async () => {
    setSetting("vimeoAccessToken", "tok");
    stub([
      { test: (u) => u.includes("/videos") && !u.includes("page=2"), response: ok({ data: [{ name: "V1", release_time: "2020-01-01T00:00:00Z", uri: "/videos/v1" }], paging: { next: "p2" } }) },
      { test: (u) => u.includes("page=2"), response: ok({ data: [{ name: "V2", release_time: "2020-02-01T00:00:00Z", uri: "/videos/v2" }], paging: { next: null } }) },
    ]);
    expect(await metadata.fetchCollectionChildrenFor({ vimeo: "u1" })).toEqual({ provider: "vimeo", children: [{ title: "V1", releaseDate: "2020-01-01", externalId: "v1" }, { title: "V2", releaseDate: "2020-02-01", externalId: "v2" }] });
  });

  it("podcastFeed: parses the RSS feed, skipping items without an enclosure and handling an invalid pubDate", async () => {
    const rss = `<rss><channel>
      <item><title>Ep1</title><pubDate>Mon, 01 Jan 2020 00:00:00 GMT</pubDate><enclosure url="http://a.mp3"/></item>
      <item><title>NoEnclosure</title><pubDate>Mon, 01 Jan 2020 00:00:00 GMT</pubDate></item>
      <item><pubDate>not-a-real-date</pubDate><enclosure url="http://b.mp3"/></item>
    </channel></rss>`;
    stub([{ test: (u) => u === "http://feed.example/rss.xml", response: okText(rss) }]);
    expect(await metadata.fetchCollectionChildrenFor({ podcastFeed: "http://feed.example/rss.xml" })).toEqual({
      provider: "rss",
      children: [
        { title: "Ep1", releaseDate: "2020-01-01", externalId: "http://a.mp3" },
        { title: "Untitled episode", releaseDate: null, externalId: "http://b.mp3" },
      ],
    });
  });

  it("podcastFeed: caps parsed episodes at 500 even when the feed has more items", async () => {
    const items = Array.from({ length: 501 }, (_, i) => `<item><title>Ep${i}</title><enclosure url="http://a.example/${i}.mp3"/></item>`).join("");
    const rss = `<rss><channel>${items}</channel></rss>`;
    stub([{ test: (u) => u === "http://feed.example/big.xml", response: okText(rss) }]);
    const { children } = await metadata.fetchCollectionChildrenFor({ podcastFeed: "http://feed.example/big.xml" });
    expect(children).toHaveLength(500);
  });

  it("returns {provider:null, children:[]} when no known id is present (e.g. Courses)", async () => {
    await expect(metadata.fetchCollectionChildrenFor({})).resolves.toEqual({ provider: null, children: [] });
  });

  it("openlibrary: asks for large pages and follows offset up to the author's total work count", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("openlibrary.org/authors/OL19981A/works.json"),
        response: (u: string) => {
          const params = new URL(u).searchParams;
          const offset = Number(params.get("offset"));
          const count = Math.min(Number(params.get("limit")), 1250 - offset);
          return ok({ size: 1250, entries: Array.from({ length: count }, (_, i) => ({ title: `Work ${offset + i}` })) });
        },
      },
    ]);
    const { children } = await metadata.fetchCollectionChildrenFor({ openlibrary: "OL19981A" });
    expect(children).toHaveLength(1250);
    expect(children[1249]).toEqual({ title: "Work 1249", releaseDate: null });
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "1000"]);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("limit")).toBe("1000");
  });

  it("googlebooks: pages with startIndex until a short page, keeping one child per title across editions", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("googleapis.com/books"),
        response: (u: string) => {
          const start = Number(new URL(u).searchParams.get("startIndex"));
          if (start === 0) return ok({ items: Array.from({ length: 40 }, (_, i) => ({ volumeInfo: { title: `Book ${i}` } })) });
          return ok({ items: [{ volumeInfo: { title: "Book 0", publishedDate: "2001" } }, { volumeInfo: { title: "Book 40", publishedDate: "2002" } }] });
        },
      },
    ]);
    const { children } = await metadata.fetchCollectionChildrenFor({ googlebooks: "Author1" });
    expect(children).toHaveLength(41);
    expect(children[40]).toEqual({ title: "Book 40", releaseDate: "2002" });
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("startIndex"))).toEqual(["0", "40"]);
  });

  it("goodreads: follows the list page's next link across pages", async () => {
    const row = (title: string) => `<tr itemtype="http://schema.org/Book"><td><a class="bookTitle"><span itemprop="name">${title}</span></a></td></tr>`;
    const fetchMock = stub([
      {
        test: (u) => u.includes("goodreads.com/author/list/3389"),
        response: (u: string) =>
          new URL(u).searchParams.get("page") === "1"
            ? okText(`<table>${row("First")}</table><a class="next_page" rel="next" href="/author/list/3389?page=2&amp;per_page=100">next</a>`)
            : okText(`<table>${row("Second")}</table><span class="next_page disabled">next</span>`),
      },
    ]);
    const { children } = await metadata.fetchCollectionChildrenFor({ goodreads: "3389" });
    expect(children.map((c) => c.title)).toEqual(["First", "Second"]);
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("comicvine: pages by offset until number_of_total_results, two seconds apart", async () => {
    // The spacing is process-wide, so start well clear of the request an earlier test made.
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    setSetting("comicVineApiKey", "k");
    const fetchMock = stub([
      {
        test: (u) => u.includes("comicvine.gamespot.com/api/issues") && u.includes("volume%3A796"),
        response: (u: string) => {
          const offset = Number(new URL(u).searchParams.get("offset"));
          const count = offset === 200 ? 50 : 100;
          return ok({ number_of_total_results: 250, results: Array.from({ length: count }, (_, i) => ({ id: offset + i, issue_number: String(offset + i + 1) })) });
        },
      },
      { test: (u) => u.includes("comicvine.gamespot.com/api/issues"), response: ok({ number_of_total_results: 1, results: [{ id: 5000, issue_number: "1" }] }) },
    ]);
    const pending = metadata.fetchCollectionChildrenFor({ comicvine: "796" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    const { children } = await pending;
    expect(children).toHaveLength(250);
    expect(children[249]).toEqual({ title: "#250", releaseDate: null, externalId: "249" });
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "100", "200"]);

    // The next volume on Refresh waits out the gap too, even for its first page.
    const nextVolume = metadata.fetchCollectionChildrenFor({ comicvine: "797" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await nextVolume).children).toEqual([{ title: "#1", releaseDate: null, externalId: "5000" }]);
  });

  it("mangadex: pages the feed by offset until total, deduping chapter numbers across page boundaries", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.mangadex.org/manga/m2/feed"),
        response: (u: string) => {
          const offset = Number(new URL(u).searchParams.get("offset"));
          // two scanlations of (almost) every chapter; chapter 251's pair straddles the page boundary
          const data = Array.from({ length: offset === 0 ? 500 : 300 }, (_, i) => {
            const n = offset + i;
            return { id: `c${n}`, attributes: { chapter: String(Math.floor((n + 1) / 2) + 1) } };
          });
          return ok({ total: 800, data });
        },
      },
    ]);
    const { children } = await metadata.fetchCollectionChildrenFor({ mangadex: "m2" });
    expect(children).toHaveLength(401);
    expect(children[250]).toEqual({ title: "Chapter 251", releaseDate: null, externalId: "c499" });
    expect(children[400].title).toBe("Chapter 401");
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "500"]);
  });

  it("mangadex: stops at the API's 10000-entry window instead of requesting an offset it rejects", async () => {
    const fetchMock = stub([
      {
        test: (u) => u.includes("api.mangadex.org/manga/m3/feed"),
        response: (u: string) => {
          const offset = Number(new URL(u).searchParams.get("offset"));
          return ok({ total: 50000, data: Array.from({ length: 500 }, (_, i) => ({ id: `c${offset + i}`, attributes: { chapter: String(offset + i + 1) } })) });
        },
      },
    ]);
    const { children } = await metadata.fetchCollectionChildrenFor({ mangadex: "m3" });
    expect(children).toHaveLength(10000);
    const offsets = fetchMock.mock.calls.map((c) => Number(new URL(String(c[0])).searchParams.get("offset")));
    expect(Math.max(...offsets) + 500).toBeLessThanOrEqual(10000);
  });

  it("podcastFeed: carries each item's <guid>, with or without attributes, and omits it when the item has none", async () => {
    const rss = `<rss><channel>
      <item><title>Ep1</title><guid isPermaLink="false">guid-1</guid><enclosure url="https://chtbl.com/track/X/cdn.example/1.mp3"/></item>
      <item><title>Ep2</title><guid> guid-2 </guid><enclosure url="https://cdn.example/2.mp3"/></item>
      <item><title>Ep3</title><enclosure url="https://cdn.example/3.mp3"/></item>
    </channel></rss>`;
    stub([{ test: (u) => u === "https://feed.example/guid.xml", response: okText(rss) }]);
    const { children } = await metadata.fetchCollectionChildrenFor({ podcastFeed: "https://feed.example/guid.xml" });
    expect(children).toEqual([
      { title: "Ep1", releaseDate: null, externalId: "https://chtbl.com/track/X/cdn.example/1.mp3", guid: "guid-1" },
      { title: "Ep2", releaseDate: null, externalId: "https://cdn.example/2.mp3", guid: "guid-2" },
      { title: "Ep3", releaseDate: null, externalId: "https://cdn.example/3.mp3" },
    ]);
    expect(children[2]).not.toHaveProperty("guid");
  });

  it("podcastFeed: refuses a feed URL that isn't http(s), without fetching it", async () => {
    const fetchMock = stub([{ test: () => true, response: okText("<rss><channel></channel></rss>") }]);
    for (const feed of ["data:application/rss+xml,<rss><channel></channel></rss>", "file:///etc/passwd", "ftp://feed.example/rss.xml", "not a url"]) {
      await expect(metadata.fetchCollectionChildrenFor({ podcastFeed: feed })).rejects.toThrow("Podcast feed URL must be an http:// or https:// URL");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchRomDetailsFor — RAWG (incl. opportunistic IGDB platform-logo enrichment), IGDB, ScreenScraper,
// TheGamesDB
// ---------------------------------------------------------------------------

describe("fetchRomDetailsFor", () => {
  it("RAWG: maps details and opportunistically enriches with an IGDB platform logo only when IGDB creds are configured", async () => {
    setSetting("rawgApiKey", "k");
    let fetchMock = stub([{ test: (u) => u.includes("api.rawg.io/api/games/1?"), response: ok({ description_raw: " desc ", platforms: [{ platform: { name: "PC" } }], developers: [{ name: "Dev1" }] }) }]);
    const withoutIgdb = await metadata.fetchRomDetailsFor({ rawg: "1" });
    expect(withoutIgdb).toEqual({ overview: "desc", system: "PC", maker: "Dev1", systemLogoUrl: null });
    expect(fetchMock.mock.calls).toHaveLength(1); // no platforms lookup attempted

    stub([{ test: (u) => u.includes("api.rawg.io/api/games/2?"), response: ok({ platforms: [{ platform: { name: "PC" } }], publishers: [{ name: "Pub1" }] }) }]);
    const publisherOnly = await metadata.fetchRomDetailsFor({ rawg: "2" });
    expect(publisherOnly.maker).toBe("Pub1"); // falls back to publisher when there's no developer

    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    fetchMock = stub([
      { test: (u) => u.includes("api.rawg.io/api/games/1?"), response: ok({ description_raw: "desc", platforms: [{ platform: { name: "PC" } }], developers: [{ name: "Dev1" }] }) },
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/platforms"), response: ok([{ platform_logo: { url: "//img/t_thumb/logo.jpg" } }]) },
    ]);
    const withIgdb = await metadata.fetchRomDetailsFor({ rawg: "1" });
    expect(withIgdb.systemLogoUrl).toBe("https://img/t_logo_med/logo.jpg");
  });

  it("IGDB: extracts developer/publisher from involved_companies and rewrites the platform logo url", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ summary: "sum", platforms: [{ name: "PC", platform_logo: { url: "//img/t_thumb/logo.jpg" } }], involved_companies: [{ developer: true, company: { name: "Dev1" } }, { publisher: true, company: { name: "Pub1" } }] }]) },
    ]);
    expect(await metadata.fetchRomDetailsFor({ igdb: "1" })).toEqual({ overview: "sum", system: "PC", maker: "Dev1", systemLogoUrl: "https://img/t_logo_med/logo.jpg" });

    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ involved_companies: [{ publisher: true, company: { name: "Pub1" } }] }]) },
    ]);
    expect((await metadata.fetchRomDetailsFor({ igdb: "2" })).maker).toBe("Pub1"); // no developer entry at all

    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([]) },
    ]);
    expect(await metadata.fetchRomDetailsFor({ igdb: "999" })).toEqual({ overview: null, system: null, maker: null, systemLogoUrl: null });
  });

  it("ScreenScraper: maps system/overview/maker, never uses the credential-bearing wheel image as the System logo, and falls back to the first entry when the preferred region/language is absent", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    const wheel = "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=d&devpassword=p&jeuid=1&media=wheel(wor)";
    stub([{ test: (u) => u.includes("jeuInfos.php"), response: ok({ response: { jeu: { systeme: { text: "NES" }, synopsis: [{ langue: "en", text: "Syn" }], developpeur: { text: "Dev1" }, medias: [{ type: "wheel", url: wheel }] } } }) }]);
    expect(await metadata.fetchRomDetailsFor({ screenscraper: "1" })).toEqual({ overview: "Syn", system: "NES", maker: "Dev1", systemLogoUrl: null });

    // the IGDB platform logo is still used when IGDB is configured
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    stub([
      { test: (u) => u.includes("jeuInfos.php"), response: ok({ response: { jeu: { systeme: { text: "NES" }, medias: [{ type: "wheel", url: wheel }] } } }) },
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/platforms"), response: ok([{ platform_logo: { url: "//img/t_thumb/nes.jpg" } }]) },
    ]);
    expect((await metadata.fetchRomDetailsFor({ screenscraper: "1" }))?.systemLogoUrl).toBe("https://img/t_logo_med/nes.jpg");

    stub([{ test: (u) => u.includes("jeuInfos.php"), response: ok({ response: { jeu: { systeme: { text: "SNES" }, synopsis: [{ langue: "fr", text: "Synopsis francaise" }] } } }) }]);
    const noEnglishSynopsis = await metadata.fetchRomDetailsFor({ screenscraper: "2" });
    expect(noEnglishSynopsis.overview).toBe("Synopsis francaise"); // falls back to entries[0] when no "en" entry exists
  });

  it("TheGamesDB: resolves platform/developer/publisher through the include lookup tables", async () => {
    setSetting("theGamesDbApiKey", "k");
    stub([
      {
        test: (u) => u.includes("Games/ByGameID"),
        response: ok({ data: { games: [{ id: 1, overview: "ov", platform: 5, developers: [10], publishers: [20] }] }, include: { platform: { data: { "5": { name: "NES" } } }, developers: { data: { "10": { name: "Dev1" } } }, publishers: { data: { "20": { name: "Pub1" } } } } }),
      },
    ]);
    expect(await metadata.fetchRomDetailsFor({ thegamesdb: "1" })).toEqual({ overview: "ov", system: "NES", maker: "Dev1", systemLogoUrl: null });
  });

  it("returns null when no known rom id is present", async () => {
    await expect(metadata.fetchRomDetailsFor({})).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchArtworkFor — every routed branch
// ---------------------------------------------------------------------------

describe("fetchArtworkFor", () => {
  it("Fanart.tv: movies/tv/music each map their own field set, prefer the hd-prefixed logo, and a 404 yields empty arrays instead of throwing", async () => {
    setSetting("fanartApiKey", "k");
    stub([{ test: (u) => u.includes("webservice.fanart.tv/v3/movies/1"), response: ok({ movieposter: [{ url: "http://p1" }], moviebackground: [{ url: "http://b1" }], hdmovielogo: [{ url: "http://l1" }], movielogo: [{ url: "http://ignored" }] }) }]);
    expect(await metadata.fetchArtworkFor("movie", { tmdb: "1" })).toEqual({ posters: ["http://p1"], backgrounds: ["http://b1"], logos: ["http://l1"] });

    stub([{ test: (u) => u.includes("webservice.fanart.tv/v3/movies/2"), response: ok({ movielogo: [{ url: "http://sd-logo" }] }) }]);
    const sdLogoOnly = await metadata.fetchArtworkFor("movie", { tmdb: "2" });
    expect(sdLogoOnly.logos).toEqual(["http://sd-logo"]); // falls back to movielogo when hdmovielogo is absent

    stub([{ test: (u) => u.includes("webservice.fanart.tv/v3/tv/9"), response: notOk(404) }]);
    expect(await metadata.fetchArtworkFor("series", { tvdb: "9" })).toEqual({ posters: [], backgrounds: [], logos: [] });

    stub([{ test: (u) => u.includes("webservice.fanart.tv/v3/music/mbid-1"), response: ok({ artistthumb: [{ url: "http://p" }], musiclogo: [{ url: "http://l" }] }) }]);
    expect(await metadata.fetchArtworkFor("artist", { musicbrainz: "mbid-1" })).toEqual({ posters: ["http://p"], backgrounds: [], logos: ["http://l"] });

    // "sports" shares the tv branch alongside "series"
    stub([{ test: (u) => u.includes("webservice.fanart.tv/v3/tv/9"), response: ok({ tvposter: [{ url: "http://sp" }] }) }]);
    expect((await metadata.fetchArtworkFor("sports", { tvdb: "9" })).posters).toEqual(["http://sp"]);
  });

  it("rom: dispatches to whichever provider id is present and returns empty arrays for a rom with none", async () => {
    setSetting("rawgApiKey", "k");
    stub([{ test: (u) => u.includes("api.rawg.io/api/games/1/screenshots"), response: ok({ results: [{ image: "http://s1" }] }) }]);
    expect(await metadata.fetchArtworkFor("rom", { rawg: "1" })).toEqual({ posters: ["http://s1"], backgrounds: [], logos: [] });
    await expect(metadata.fetchArtworkFor("rom", {})).resolves.toEqual({ posters: [], backgrounds: [], logos: [] });
  });

  it("rom via igdb: cover + artworks become posters, screenshots become backgrounds", async () => {
    setSetting("igdbClientId", "cid");
    setSetting("igdbClientSecret", "csecret");
    stub([
      { test: (u) => u.includes("id.twitch.tv"), response: ok({ access_token: "tok", expires_in: 3600 }) },
      { test: (u) => u.includes("api.igdb.com/v4/games"), response: ok([{ cover: { url: "//img/t_thumb/c.jpg" }, artworks: [{ url: "//img/t_thumb/a.jpg" }], screenshots: [{ url: "//img/t_thumb/s.jpg" }] }]) },
    ]);
    expect(await metadata.fetchArtworkFor("rom", { igdb: "1" })).toEqual({ posters: ["https://img/t_cover_big/c.jpg", "https://img/t_cover_big/a.jpg"], backgrounds: ["https://img/t_screenshot_huge/s.jpg"], logos: [] });
  });

  it("rom via screenscraper: filters media by type into posters vs backgrounds, as credential-free references", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    setSetting("screenscraperUserPassword", "admin-secret");
    const media = (kind: string) => `https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=d&devpassword=p&ssid=u&sspassword=admin-secret&jeuid=1&media=${kind}`;
    stub([
      {
        test: (u) => u.includes("jeuInfos.php"),
        response: ok({ response: { jeu: { medias: [{ type: "box-2D", url: media("box-2D") }, { type: "fanart", url: media("fanart") }, { type: "wheel", url: media("wheel") }, { type: "box-3D" }] } } }),
      },
    ]);
    expect(await metadata.fetchArtworkFor("rom", { screenscraper: "1" })).toEqual({
      posters: ["screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1&media=box-2D"],
      backgrounds: ["screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1&media=fanart"],
      logos: [],
    });
  });

  it("rom via thegamesdb: resolves the images list against the base_url, falling back through original then medium when large is absent", async () => {
    setSetting("theGamesDbApiKey", "k");
    stub([{ test: (u) => u.includes("Games/Images"), response: ok({ data: { base_url: { large: "http://base/" }, images: { "1": [{ type: "boxart", filename: "a.jpg" }, { type: "screenshot", filename: "b.jpg" }] } } }) }]);
    expect(await metadata.fetchArtworkFor("rom", { thegamesdb: "1" })).toEqual({ posters: ["http://base/a.jpg"], backgrounds: ["http://base/b.jpg"], logos: [] });

    stub([{ test: (u) => u.includes("Games/Images"), response: ok({ data: { base_url: { medium: "http://med/" }, images: { "2": [{ type: "boxart", filename: "c.jpg" }] } } }) }]);
    const viaMedium = await metadata.fetchArtworkFor("rom", { thegamesdb: "2" });
    expect(viaMedium.posters).toEqual(["http://med/c.jpg"]);
  });

  it("manga: combines MangaDex covers with AniList's cover/banner", async () => {
    stub([
      { test: (u) => u.includes("api.mangadex.org/cover"), response: ok({ data: [{ attributes: { fileName: "c1.jpg" } }] }) },
      { test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { coverImage: { extraLarge: "http://al-cover" }, bannerImage: "http://al-banner" } } }) },
    ]);
    expect(await metadata.fetchArtworkFor("manga", { mangadex: "m1", anilist: "9" })).toEqual({ posters: ["https://uploads.mangadex.org/covers/m1/c1.jpg", "http://al-cover"], backgrounds: ["http://al-banner"], logos: [] });
    await expect(metadata.fetchArtworkFor("manga", {})).resolves.toEqual({ posters: [], backgrounds: [], logos: [] });
  });

  it("comic: returns ComicVine's image size variants, dropping falsy ones", async () => {
    setSetting("comicVineApiKey", "k");
    stub([{ test: (u) => u.includes("comicvine.gamespot.com/api/volumes"), response: ok({ results: [{ image: { super_url: "http://s", original_url: "http://o", screen_large_url: null, medium_url: "http://m" } }] }) }]);
    expect(await metadata.fetchArtworkFor("comic", { comicvine: "1" })).toEqual({ posters: ["http://s", "http://o", "http://m"], backgrounds: [], logos: [] });
  });

  it("video via youtube: uses channel thumbnails plus a sized banner url", async () => {
    setSetting("youtubeApiKey", "k");
    stub([{ test: (u) => u.includes("youtube/v3/channels"), response: ok({ items: [{ snippet: { thumbnails: { high: { url: "http://h" }, medium: { url: "http://m" } } }, brandingSettings: { image: { bannerExternalUrl: "http://banner" } } }] }) }]);
    expect(await metadata.fetchArtworkFor("video", { youtube: "c1" })).toEqual({ posters: ["http://h", "http://m"], backgrounds: ["http://banner=w1707"], logos: [] });
  });

  it("video via vimeo: returns every picture size as a poster", async () => {
    setSetting("vimeoAccessToken", "tok");
    stub([{ test: (u) => u.includes("api.vimeo.com/users/u1"), response: ok({ pictures: { sizes: [{ link: "http://s1" }, { link: "http://s2" }] } }) }]);
    expect(await metadata.fetchArtworkFor("video", { vimeo: "u1" })).toEqual({ posters: ["http://s1", "http://s2"], backgrounds: [], logos: [] });
  });

  it("adult: uses the posters array, falling back to the single image, plus a dual-field background", async () => {
    setSetting("thePornDbApiKey", "k");
    stub([{ test: (u) => u.includes("api.metadataapi.net/scenes/1"), response: ok({ data: { posters: [{ url: "http://p1" }], background: { large: "http://bg1", url: "http://bg2" } } }) }]);
    expect(await metadata.fetchArtworkFor("adult", { theporndb: "1" })).toEqual({ posters: ["http://p1"], backgrounds: ["http://bg1", "http://bg2"], logos: [] });

    stub([{ test: (u) => u.includes("api.metadataapi.net/scenes/2"), response: ok({ image: "http://fallback", background: {} }) }]);
    expect((await metadata.fetchArtworkFor("adult", { theporndb: "2" })).posters).toEqual(["http://fallback"]);
  });

  it("throws when the type has no artwork source at all, or is missing the id it needs", async () => {
    await expect(metadata.fetchArtworkFor("movie", {})).rejects.toThrow("Artwork lookup isn't available");
    await expect(metadata.fetchArtworkFor("author", { openlibrary: "OL1A" })).rejects.toThrow("Artwork lookup isn't available");
  });
});

// ---------------------------------------------------------------------------
// Cast, alternate titles, TMDB collection, person details
// ---------------------------------------------------------------------------

describe("fetchCastFor", () => {
  it("caps the cast list at 20 and rejects a type/id combination it doesn't support", async () => {
    setSetting("tmdbApiKey", "k");
    const cast = Array.from({ length: 25 }, (_, i) => ({ id: i, name: `Actor${i}`, character: `Char${i}`, profile_path: `/p${i}.jpg` }));
    stub([{ test: (u) => u.includes("/movie/1/credits"), response: ok({ cast }) }]);
    expect(await metadata.fetchCastFor("movie", { tmdb: "1" })).toHaveLength(20);

    stub([{ test: (u) => u.includes("/tv/2/credits"), response: ok({ cast: [{ id: 1, name: "Actor", character: null, profile_path: null }] }) }]);
    expect(await metadata.fetchCastFor("series", { tmdb: "2" })).toEqual([{ personId: 1, name: "Actor", character: null, photoUrl: null }]);

    await expect(metadata.fetchCastFor("movie", {})).rejects.toThrow("Cast lookup needs a TMDB id");
    await expect(metadata.fetchCastFor("artist", { tmdb: "1" })).rejects.toThrow('Cast lookup isn\'t available for "artist"');
  });
});

describe("fetchAlternateTitlesFor", () => {
  it("anime/manga: dedupes and sorts AniList's romaji/english/native titles plus synonyms", async () => {
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { title: { romaji: "Zeta", english: "Alpha", native: "Alpha" }, synonyms: ["Beta"] } } }) }]);
    expect(await metadata.fetchAlternateTitlesFor("anime", { anilist: "1" })).toEqual(["Alpha", "Beta", "Zeta"]);

    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: null } }) }]);
    await expect(metadata.fetchAlternateTitlesFor("manga", { anilist: "999" })).rejects.toThrow("AniList has no record for this id");
  });

  it("movie/series: reads TMDB's titles[] vs results[] shape respectively and rejects unsupported types", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/1/alternative_titles"), response: ok({ titles: [{ title: "B" }, { title: "A" }] }) }]);
    expect(await metadata.fetchAlternateTitlesFor("movie", { tmdb: "1" })).toEqual(["A", "B"]);

    stub([{ test: (u) => u.includes("/tv/2/alternative_titles"), response: ok({ results: [{ title: "Z" }, { title: "A" }] }) }]);
    expect(await metadata.fetchAlternateTitlesFor("series", { tmdb: "2" })).toEqual(["A", "Z"]);

    await expect(metadata.fetchAlternateTitlesFor("movie", {})).rejects.toThrow("Alternate titles lookup needs a TMDB id");
    await expect(metadata.fetchAlternateTitlesFor("artist", { tmdb: "1" })).rejects.toThrow('Alternate titles aren\'t available for "artist"');
  });
});

describe("fetchTmdbCollectionFor", () => {
  it("returns null when the movie isn't part of a collection, and sorts parts by release date (nulls last) otherwise", async () => {
    setSetting("tmdbApiKey", "k");
    stub([{ test: (u) => u.includes("/movie/1?"), response: ok({ belongs_to_collection: null }) }]);
    await expect(metadata.fetchTmdbCollectionFor({ tmdb: "1" })).resolves.toBeNull();

    stub([
      { test: (u) => u.includes("/movie/2?"), response: ok({ belongs_to_collection: { id: 99 } }) },
      { test: (u) => u.includes("/collection/99"), response: ok({ id: 99, name: "Coll", overview: "ov", poster_path: "/p.jpg", parts: [{ id: 1, title: "P2", release_date: "2002-01-01" }, { id: 2, title: "P1", release_date: "2000-01-01" }, { id: 3, title: "P3", release_date: null }] }) },
    ]);
    const collection = await metadata.fetchTmdbCollectionFor({ tmdb: "2" });
    expect(collection?.parts.map((p) => p.title)).toEqual(["P1", "P2", "P3"]);
  });

  it("throws without a tmdb id", async () => {
    await expect(metadata.fetchTmdbCollectionFor({})).rejects.toThrow("Collection lookup needs a TMDB id");
  });
});

describe("fetchPersonDetails", () => {
  it("dedupes by media type + id, filters non-movie/tv credits, and sorts newest first", async () => {
    setSetting("tmdbApiKey", "k");
    stub([
      {
        test: (u) => u.includes("/person/1"),
        response: ok({
          name: "Actor1",
          biography: "bio",
          profile_path: "/p.jpg",
          combined_credits: {
            cast: [
              { media_type: "movie", id: 1, title: "M1", release_date: "2020-01-01", character: "C1", poster_path: "/p1.jpg" },
              { media_type: "tv", id: 2, name: "S1", first_air_date: "2018-01-01", character: "C2" },
              { media_type: "movie", id: 1, title: "M1-dup", character: "dup" },
              { media_type: "crew", id: 3, title: "Should be filtered" },
            ],
          },
        }),
      },
    ]);
    const details = await metadata.fetchPersonDetails("1");
    expect(details.name).toBe("Actor1");
    expect(details.credits).toEqual([
      { tmdbId: 1, title: "M1", year: 2020, character: "C1", posterUrl: "https://image.tmdb.org/t/p/w342/p1.jpg", mediaType: "movie" },
      { tmdbId: 2, title: "S1", year: 2018, character: "C2", posterUrl: null, mediaType: "series" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ScreenScraper artwork references — the image proxy half and the startup migration
// ---------------------------------------------------------------------------

describe("ScreenScraper artwork references", () => {
  const credentialed =
    "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev-id-9&devpassword=dev-secret-9&softname=AoNarr&ssid=admin-9&sspassword=admin-secret-9&systemeid=1&jeuid=3&media=box-2D(wor)";

  function image(contentType = "image/png", bytes = [1, 2, 3]) {
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
  }

  // A refused download, with its unread body's cancel() observable.
  function refused(contentType: string, status = 200) {
    const cancel = vi.fn(async () => undefined);
    return { response: { ok: status < 400, status, headers: new Headers({ "content-type": contentType }), body: { cancel } }, cancel };
  }

  function configure() {
    setSetting("screenscraperDevId", "dev-id-9");
    setSetting("screenscraperDevPassword", "dev-secret-9");
    setSetting("screenscraperUserId", "admin-9");
    setSetting("screenscraperUserPassword", "admin-secret-9");
  }

  const mediaRef = (jeuid: number, media = "box-2D(wor)") => `screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=${jeuid}&media=${media}`;

  it("proxyScreenscraperArtwork turns a ScreenScraper URL or reference into local-artwork proxy columns, and leaves anything else alone", () => {
    const proxied = metadata.proxyScreenscraperArtwork(credentialed)!;
    expect(proxied.url).toBe(`/api/media/local-artwork/${proxied.token}`);
    expect(proxied.token).toMatch(/^[0-9a-f]{40}$/);
    expect(proxied.localPath.startsWith(metadata.SCREENSCRAPER_ARTWORK_PREFIX)).toBe(true);
    expect(proxied.localPath).not.toMatch(/dev-id-9|dev-secret-9|admin-9|admin-secret-9/);

    expect(metadata.proxyScreenscraperArtwork(proxied.localPath)?.localPath).toBe(proxied.localPath);
    expect(metadata.proxyScreenscraperArtwork("https://image.tmdb.org/t/p/w342/x.jpg")).toBeNull();
    expect(metadata.proxyScreenscraperArtwork("/api/media/local-artwork/abc")).toBeNull();
    expect(metadata.proxyScreenscraperArtwork(null)).toBeNull();
  });

  it("fetchScreenscraperArtwork adds the configured credentials server-side and returns only images", async () => {
    configure();
    const ref = metadata.proxyScreenscraperArtwork(credentialed)!.localPath;
    const fetchMock = stub([{ test: (u) => u.startsWith("https://neoclone.screenscraper.fr/api2/mediaJeu.php"), response: () => image("image/png", [7, 8, 9]) }]);

    const res = await metadata.fetchScreenscraperArtwork(ref);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await res!.arrayBuffer())]).toEqual([7, 8, 9]);
    const sent = new URL(String(fetchMock.mock.calls[0][0]));
    expect(sent.searchParams.get("devid")).toBe("dev-id-9");
    expect(sent.searchParams.get("devpassword")).toBe("dev-secret-9");
    expect(sent.searchParams.get("ssid")).toBe("admin-9");
    expect(sent.searchParams.get("sspassword")).toBe("admin-secret-9");
    expect(sent.searchParams.get("jeuid")).toBe("3");
    expect(sent.searchParams.get("media")).toBe("box-2D(wor)");

    // ScreenScraper answers a refused request with a 200 text/html error page, not an image; the
    // unread body is cancelled rather than left holding the connection
    const html = refused("text/html; charset=utf-8");
    stub([{ test: (u) => u.includes("screenscraper.fr"), response: html.response }]);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(40))).resolves.toBeNull();
    expect(html.cancel).toHaveBeenCalledTimes(1);

    // same for an HTTP error (ScreenScraper's 429/430 thread and quota refusals), and for SVG,
    // which could run script once served from AoNarr's own origin
    for (const [i, r] of [refused("image/png", 430), refused("image/svg+xml")].entries()) {
      stub([{ test: (u) => u.includes("screenscraper.fr"), response: r.response }]);
      await expect(metadata.fetchScreenscraperArtwork(mediaRef(41 + i))).resolves.toBeNull();
      expect(r.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("fetchScreenscraperArtwork downloads each image once, then serves it from the disk cache", async () => {
    configure();
    const fetchMock = stub([{ test: (u) => u.includes("screenscraper.fr"), response: () => image("image/jpeg; charset=binary", [4, 5]) }]);
    const first = await metadata.fetchScreenscraperArtwork(mediaRef(50));
    expect([...new Uint8Array(await first!.arrayBuffer())]).toEqual([4, 5]);

    // the same image, whichever credentials its stored URL once carried, costs no further download
    // — even with ScreenScraper no longer configured
    setSetting("screenscraperDevPassword", "");
    const again = await metadata.fetchScreenscraperArtwork(
      "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=old&devpassword=old&jeuid=50&media=box-2D(wor)"
    );
    expect(again?.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await again!.arrayBuffer())]).toEqual([4, 5]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // a refused download isn't cached on disk: once the retry window has passed, it's tried again
    configure();
    vi.useFakeTimers({ toFake: ["Date"] });
    stub([{ test: (u) => u.includes("screenscraper.fr"), response: refused("text/html").response }]);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(51))).resolves.toBeNull();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const retry = stub([{ test: (u) => u.includes("screenscraper.fr"), response: () => image() }]);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(51))).resolves.not.toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("fetchScreenscraperArtwork doesn't queue a failed image again for a few minutes, however many views ask for it", async () => {
    configure();
    vi.useFakeTimers({ toFake: ["Date"] });
    // ScreenScraper down: the download itself fails
    const down = stub([
      {
        test: (u) => u.includes("screenscraper.fr"),
        response: () => {
          throw new TypeError("fetch failed");
        },
      },
    ]);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(500))).resolves.toBeNull();
    expect(down).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 4 * 60_000);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(500))).resolves.toBeNull();
    // the same image under a differently-credentialed stored URL is the same failed image
    await expect(
      metadata.fetchScreenscraperArtwork("screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=old&devpassword=old&jeuid=500&media=box-2D(wor)")
    ).resolves.toBeNull();
    expect(down).toHaveBeenCalledTimes(1);

    // another image is unaffected
    const up = stub([{ test: (u) => u.includes("screenscraper.fr"), response: () => image() }]);
    await expect(metadata.fetchScreenscraperArtwork(mediaRef(501))).resolves.not.toBeNull();
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("fetchScreenscraperArtwork refuses, without remembering it as failed, an image past the download backlog", async () => {
    configure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = stub([
      {
        test: (u) => u.includes("screenscraper.fr"),
        response: async () => {
          await gate;
          return image();
        },
      },
    ]);

    // the first view of a big uncached ROM library: one download in flight, the rest waiting
    const refs = Array.from({ length: 40 }, (_, i) => mediaRef(600 + i));
    const refusedRefs: string[] = [];
    const loads = refs.map((ref) =>
      metadata.fetchScreenscraperArtwork(ref).then((res) => {
        if (!res) refusedRefs.push(ref);
        return res;
      })
    );
    // one in flight plus a backlog of 32; the other 7 are refused straight away
    try {
      await vi.waitFor(() => expect(refusedRefs).toHaveLength(7));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // a hung download would hold up every later test's ScreenScraper request
      release();
    }
    const results = await Promise.all(loads);
    expect(results.filter((r) => r !== null)).toHaveLength(33);
    expect(fetchMock).toHaveBeenCalledTimes(33);

    // a refused one downloads on the next view
    await expect(metadata.fetchScreenscraperArtwork(refusedRefs[0])).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it("a ScreenScraper lookup waiting behind image downloads runs as soon as the one in flight finishes", async () => {
    configure();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    stub([
      {
        test: (u) => u.includes("/api2/mediaJeu.php"),
        response: async (u: string) => {
          const jeuid = new URL(u).searchParams.get("jeuid");
          order.push(`image ${jeuid}`);
          if (jeuid === "700") await firstGate;
          return image();
        },
      },
      {
        test: (u) => u.includes("/api2/jeuRecherche.php"),
        response: () => {
          order.push("search");
          return ok({ response: { jeux: [] } });
        },
      },
    ]);

    const first = metadata.fetchScreenscraperArtwork(mediaRef(700));
    let images: Promise<Response | null>[] = [];
    let search: Promise<unknown> = Promise.resolve();
    try {
      await vi.waitFor(() => expect(order).toEqual(["image 700"]));
      images = Array.from({ length: 5 }, (_, i) => metadata.fetchScreenscraperArtwork(mediaRef(701 + i)));
      // let the other five finish their disk-cache checks and join the queue behind it, then the search
      await new Promise((resolve) => setTimeout(resolve, 100));
      search = metadata.searchMetadata("rom", "x", "screenscraper");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(order).toEqual(["image 700"]);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, ...images, search]);

    expect(order[0]).toBe("image 700");
    expect(order[1]).toBe("search");
    expect(order.slice(2).sort()).toEqual(["image 701", "image 702", "image 703", "image 704", "image 705"]);
  });

  it("fetchScreenscraperArtwork sends ScreenScraper one request at a time, and one download per image however many ask for it", async () => {
    configure();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = stub([
      {
        test: (u) => u.includes("screenscraper.fr"),
        response: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return image();
        },
      },
    ]);
    // a ROM grid asking for a dozen posters at once, one of them twice
    const refs = [...Array.from({ length: 12 }, (_, i) => mediaRef(60 + i)), mediaRef(60)];
    const results = await Promise.all(refs.map((r) => metadata.fetchScreenscraperArtwork(r)));
    expect(results.every((r) => r !== null)).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("ScreenScraper lookups share the one-at-a-time queue with the image downloads", async () => {
    configure();
    let inFlight = 0;
    let maxInFlight = 0;
    const track = (body: () => any) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return body();
    };
    stub([
      { test: (u) => u.includes("/api2/mediaJeu.php"), response: track(() => image()) },
      { test: (u) => u.includes("/api2/jeuInfos.php"), response: track(() => ok({ response: { jeu: { id: 1, medias: [] } } })) },
      { test: (u) => u.includes("/api2/jeuRecherche.php"), response: track(() => ok({ response: { jeux: [] } })) },
    ]);
    await Promise.all([
      metadata.fetchScreenscraperArtwork(mediaRef(80)),
      metadata.fetchArtworkFor("rom", { screenscraper: "1" }),
      metadata.searchMetadata("rom", "x", "screenscraper"),
      metadata.fetchScreenscraperArtwork(mediaRef(81)),
    ]);
    expect(maxInFlight).toBe(1);

    // a failed lookup doesn't jam the queue for the requests behind it
    stub([
      { test: (u) => u.includes("/api2/jeuRecherche.php"), response: notOk(503) },
      { test: (u) => u.includes("/api2/mediaJeu.php"), response: () => image() },
    ]);
    const [search, art] = await Promise.allSettled([metadata.searchMetadata("rom", "x", "screenscraper"), metadata.fetchScreenscraperArtwork(mediaRef(82))]);
    expect(search).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "ScreenScraper search failed: HTTP 503" }) });
    expect(art).toMatchObject({ status: "fulfilled" });
    expect((art as PromiseFulfilledResult<Response | null>).value).not.toBeNull();
  });

  it("fetchScreenscraperArtwork never sends the credentials anywhere but ScreenScraper's media endpoints", async () => {
    setSetting("screenscraperDevId", "dev-id-9");
    setSetting("screenscraperDevPassword", "dev-secret-9");
    const fetchMock = stub([{ test: () => true, response: image() }]);
    for (const ref of [
      "screenscraper:https://evil.example/api2/mediaJeu.php?jeuid=1",
      "screenscraper:https://screenscraper.fr.evil.example/api2/mediaJeu.php?jeuid=1",
      "screenscraper:https://api.screenscraper.fr/api2/jeuInfos.php?gameid=1",
      "screenscraper:not a url",
      "https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1",
    ]) {
      await expect(metadata.fetchScreenscraperArtwork(ref)).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    setSetting("screenscraperDevPassword", "");
    await expect(metadata.fetchScreenscraperArtwork("screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("migrateScreenscraperArtwork moves stored credentialed URLs and bare references behind the proxy, scrubs extra_metadata, and clears ScreenScraper group logos", async () => {
    const bareRef = "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=3&media=fanart";
    const extra = JSON.stringify({ screenscraper: { title: "Game", posterUrl: credentialed, externalIds: { screenscraper: "3" } } });
    const romId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, poster_url, backdrop_url, extra_metadata) VALUES ('rom', 'Game', 'game', ?, ?, ?)")
          .run(credentialed, bareRef, extra)
      ).lastInsertRowid
    );
    const otherExtra = JSON.stringify({ other: { posterUrl: "https://cdn.example/p.jpg?password=not-ours" } });
    const otherId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, poster_url, extra_metadata) VALUES ('movie', 'Film', 'film', ?, ?)")
          .run("https://image.tmdb.org/t/p/w342/x.jpg", otherExtra)
      ).lastInsertRowid
    );
    const ssGroupId = Number(
      (await db.prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, logo_url) VALUES ('rom', 'system', 'NES', 'nes', ?)").run(credentialed)).lastInsertRowid
    );
    const igdbGroupId = Number(
      (await db.prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, logo_url) VALUES ('rom', 'system', 'SNES', 'snes', ?)").run("https://images.igdb.com/logo.png")).lastInsertRowid
    );
    // requests made from a ScreenScraper search result stored its credentialed poster URL
    const requesterId = Number((await db.prepare("INSERT INTO users (username, password_hash) VALUES ('ss-requester', 'x')").run()).lastInsertRowid);
    const insertRequest = async (title: string, posterUrl: string) =>
      Number((await db.prepare("INSERT INTO requests (user_id, type, title, poster_url) VALUES (?, 'rom', ?, ?)").run(requesterId, title, posterUrl)).lastInsertRowid);
    const credentialedRequestId = await insertRequest("Requested Game", credentialed);
    const refRequestId = await insertRequest("Requested Game 2", bareRef);
    const tmdbRequestId = await insertRequest("Requested Film", "https://image.tmdb.org/t/p/w342/r.jpg");

    expect(await metadata.migrateScreenscraperArtwork()).toBe(4);

    const rom = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(romId)) as any;
    expect(rom.poster_url).toBe(`/api/media/local-artwork/${rom.local_poster_token}`);
    expect(rom.local_poster_path).toBe("screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?softname=AoNarr&systemeid=1&jeuid=3&media=box-2D%28wor%29");
    expect(rom.backdrop_url).toBe(`/api/media/local-artwork/${rom.local_backdrop_token}`);
    expect(rom.local_backdrop_path).toBe(bareRef);
    expect(rom.local_poster_token).not.toBe(rom.local_backdrop_token);
    expect(JSON.stringify(rom)).not.toMatch(/dev-id-9|dev-secret-9|admin-9|admin-secret-9/);
    expect(JSON.parse(rom.extra_metadata).screenscraper.posterUrl).toBe(rom.local_poster_path);
    expect(JSON.parse(rom.extra_metadata).screenscraper.externalIds).toEqual({ screenscraper: "3" });

    const other = (await db.prepare("SELECT poster_url, extra_metadata, local_poster_path FROM media_items WHERE id = ?").get(otherId)) as any;
    expect(other).toEqual({ poster_url: "https://image.tmdb.org/t/p/w342/x.jpg", extra_metadata: otherExtra, local_poster_path: null });

    expect(((await db.prepare("SELECT logo_url FROM library_groups WHERE id = ?").get(ssGroupId)) as any).logo_url).toBeNull();
    expect(((await db.prepare("SELECT logo_url FROM library_groups WHERE id = ?").get(igdbGroupId)) as any).logo_url).toBe("https://images.igdb.com/logo.png");

    const requestPoster = async (id: number) => ((await db.prepare("SELECT poster_url FROM requests WHERE id = ?").get(id)) as any).poster_url;
    expect(await requestPoster(credentialedRequestId)).toBeNull();
    expect(await requestPoster(refRequestId)).toBeNull();
    expect(await requestPoster(tmdbRequestId)).toBe("https://image.tmdb.org/t/p/w342/r.jpg");

    // idempotent: nothing left to convert
    expect(await metadata.migrateScreenscraperArtwork()).toBe(0);
  });
});

describe("isEpisodeMonitoredByDefault", () => {
  it("adds Season 0 specials unmonitored and every regular season monitored", () => {
    expect(metadata.isEpisodeMonitoredByDefault({ seasonNumber: 0 })).toBe(false);
    expect(metadata.isEpisodeMonitoredByDefault({ seasonNumber: 1 })).toBe(true);
    expect(metadata.isEpisodeMonitoredByDefault({ seasonNumber: 30 })).toBe(true);
  });
});
