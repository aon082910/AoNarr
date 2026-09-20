import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let metadata: typeof import("../src/services/metadata.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];

beforeAll(async () => {
  await setupTestDb();
  metadata = await import("../src/services/metadata.js");
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(results[0]).toEqual({ title: "Game1", year: 2000, overview: null, posterUrl: "http://bg", externalIds: { rawg: "1" }, rating: 8.5, backdropUrl: "http://ss1" });

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
        response: ok({ response: { jeux: [{ id: 1, noms: [{ region: "wor", text: "Game1" }], dates: [{ region: "wor", text: "2000-01-01" }], synopsis: [{ langue: "en", text: "Syn" }], medias: [{ type: "box-2D", url: "http://box" }] }, { id: 2, nom: "Fallback Name" }] } }),
      },
    ]);
    const results = await metadata.searchMetadata("rom", "x", "screenscraper");
    expect(results[0]).toEqual({ title: "Game1", year: 2000, overview: "Syn", posterUrl: "http://box", externalIds: { screenscraper: "1" } });
    expect(results[1].title).toBe("Fallback Name");
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
    expect(await metadata.fetchByExternalId("series", "tvdb", "5")).toEqual({ title: "X", year: 2000, overview: "ov", posterUrl: "http://img", externalIds: { tvdb: "5" } });

    stub([
      { test: (u) => u.includes("/v4/login"), response: ok({ data: { token: "t" } }) },
      { test: (u) => u.includes("/v4/series/6/extended"), response: ok({ data: null }) },
    ]);
    await expect(metadata.fetchByExternalId("series", "tvdb", "6")).rejects.toThrow('No TVDB series found for id "6"');
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
});

describe("fetchOmdbRatings", () => {
  it("parses Rotten Tomatoes/Metacritic/imdbRating and throws on Response:False", async () => {
    setSetting("omdbApiKey", "k");
    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "True", imdbRating: "8.5", Ratings: [{ Source: "Rotten Tomatoes", Value: "85%" }, { Source: "Metacritic", Value: "75/100" }] }) }]);
    expect(await metadata.fetchOmdbRatings("tt1")).toEqual({ imdbRating: 8.5, rottenTomatoesScore: 85, metacriticScore: 75 });

    stub([{ test: (u) => u.includes("omdbapi.com"), response: ok({ Response: "False", Error: "Movie not found!" }) }]);
    await expect(metadata.fetchOmdbRatings("tt999")).rejects.toThrow("Movie not found!");
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

  it("AniList: a null/zero episode count returns [] rather than an empty placeholder list", async () => {
    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: null } } }) }]);
    await expect(metadata.fetchSeriesEpisodesFor({ anilist: "3" })).resolves.toEqual([]);

    stub([{ test: (u) => u.includes("graphql.anilist.co"), response: ok({ data: { Media: { episodes: 0 } } }) }]);
    await expect(metadata.fetchSeriesEpisodesFor({ anilist: "4" })).resolves.toEqual([]);
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

  it("ScreenScraper: maps system/overview/maker, prefers a wheel image over an IGDB fallback, and falls back to the first entry when the preferred region/language is absent", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    stub([{ test: (u) => u.includes("jeuInfos.php"), response: ok({ response: { jeu: { systeme: { text: "NES" }, synopsis: [{ langue: "en", text: "Syn" }], developpeur: { text: "Dev1" }, medias: [{ type: "wheel", url: "http://wheel" }] } } }) }]);
    expect(await metadata.fetchRomDetailsFor({ screenscraper: "1" })).toEqual({ overview: "Syn", system: "NES", maker: "Dev1", systemLogoUrl: "http://wheel" });

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

  it("rom via screenscraper: filters media by type into posters vs backgrounds", async () => {
    setSetting("screenscraperDevId", "d");
    setSetting("screenscraperDevPassword", "p");
    stub([{ test: (u) => u.includes("jeuInfos.php"), response: ok({ response: { jeu: { medias: [{ type: "box-2D", url: "http://box" }, { type: "fanart", url: "http://fa" }, { type: "wheel", url: "http://ignored" }] } } }) }]);
    expect(await metadata.fetchArtworkFor("rom", { screenscraper: "1" })).toEqual({ posters: ["http://box"], backgrounds: ["http://fa"], logos: [] });
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
