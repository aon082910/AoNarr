import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchAlbumTracksFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();
const searchMetadata = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  fetchAlbumTracksFor: (...args: unknown[]) => fetchAlbumTracksFor(...args),
  fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
  searchMetadata: (...args: unknown[]) => searchMetadata(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let passesListFilters: (typeof import("../src/services/importLists.js"))["passesListFilters"];
let insertTracksForAlbum: (typeof import("../src/services/importLists.js"))["insertTracksForAlbum"];
let syncImportList: (typeof import("../src/services/importLists.js"))["syncImportList"];
let runAllImportLists: (typeof import("../src/services/importLists.js"))["runAllImportLists"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
type ImportListRow = import("../src/services/importLists.js").ImportListRow;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ passesListFilters, insertTracksForAlbum, syncImportList, runAllImportLists } = await import("../src/services/importLists.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchAlbumTracksFor.mockReset();
  fetchArtistAlbumsFor.mockReset();
  fetchSeriesEpisodesFor.mockReset();
  searchMetadata.mockReset();
  fetchSeriesEpisodesFor.mockResolvedValue([]);
  fetchArtistAlbumsFor.mockResolvedValue(null);
});

async function insertImportList(overrides: Partial<ImportListRow> = {}): Promise<ImportListRow> {
  const row = {
    name: "Test List",
    require_review: 0,
    type: "trakt" as const,
    url: "https://trakt.tv/users/tester/lists/my-list",
    enabled: 1,
    quality_profile_id: null,
    min_rating: null,
    min_votes: null,
    exclude_genres: null,
    ...overrides,
  };
  const result = await db
    .prepare(
      `INSERT INTO import_lists (name, type, url, enabled, require_review, quality_profile_id, min_rating, min_votes, exclude_genres)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.name, row.type, row.url, row.enabled, row.require_review, row.quality_profile_id, row.min_rating, row.min_votes, row.exclude_genres);
  return { id: Number(result.lastInsertRowid), last_synced_at: null, last_added_count: null, last_error: null, created_at: "", ...row };
}

async function existingMovieCount(): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'movie'").get()) as { c: number };
  return row.c;
}

describe("passesListFilters", () => {
  it("passes when there is no filter configured at all", () => {
    expect(passesListFilters({ min_rating: null, min_votes: null, exclude_genres: null }, {})).toBe(true);
  });

  it("rejects a rating below the floor, but never rejects when the rating is unknown", () => {
    const list = { min_rating: 7, min_votes: null, exclude_genres: null };
    expect(passesListFilters(list, { rating: 6.9 })).toBe(false);
    expect(passesListFilters(list, { rating: 7 })).toBe(true);
    expect(passesListFilters(list, { rating: null })).toBe(true);
  });

  it("rejects a vote count below the floor, but never rejects when votes are unknown", () => {
    const list = { min_rating: null, min_votes: 1000, exclude_genres: null };
    expect(passesListFilters(list, { votes: 999 })).toBe(false);
    expect(passesListFilters(list, { votes: 1000 })).toBe(true);
    expect(passesListFilters(list, { votes: undefined })).toBe(true);
  });

  it("rejects an entry with an excluded genre, case-insensitively", () => {
    const list = { min_rating: null, min_votes: null, exclude_genres: JSON.stringify(["horror"]) };
    expect(passesListFilters(list, { genres: ["Comedy", "Horror"] })).toBe(false);
    expect(passesListFilters(list, { genres: ["Comedy", "Drama"] })).toBe(true);
  });

  it("does not crash on malformed exclude_genres JSON, and doesn't reject on it", () => {
    const list = { min_rating: null, min_votes: null, exclude_genres: "{not json" };
    expect(passesListFilters(list, { genres: ["Horror"] })).toBe(true);
  });

  it("rejects if any single configured gate fails, even when others pass", () => {
    const list = { min_rating: 5, min_votes: 100, exclude_genres: null };
    expect(passesListFilters(list, { rating: 9, votes: 50 })).toBe(false); // votes too low
  });
});

describe("insertTracksForAlbum", () => {
  it("inserts one row per track for a non-musicbrainz provider (no rate-limit delay)", async () => {
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist','A','a',1,'unknown')`).run())
        .lastInsertRowid
    );
    const subId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored) VALUES (?, 'Album', 1)").run(authorId)).lastInsertRowid
    );
    fetchAlbumTracksFor.mockResolvedValue([
      { trackNumber: 1, title: "Track One", durationSeconds: 180 },
      { trackNumber: 2, title: "Track Two", durationSeconds: 200 },
    ]);

    await insertTracksForAlbum(subId, "deezer", "ext-1");

    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(subId)) as any[];
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.title)).toEqual(["Track One", "Track Two"]);
  });

  it("never throws when the track fetch itself fails", async () => {
    fetchAlbumTracksFor.mockRejectedValue(new Error("provider unreachable"));

    await expect(insertTracksForAlbum(999999, "deezer", "ext-1")).resolves.toBeUndefined();
  });
});

describe("syncImportList — trakt", () => {
  it("fails with a clear message when no Trakt client id is configured", async () => {
    setSetting("traktClientId", "");
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/my-list" });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0, error: expect.stringContaining("Trakt API client ID") });
  });

  it("fails when the URL isn't a recognized Trakt list/watchlist URL", async () => {
    setSetting("traktClientId", "client-1");
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/movies/popular" });

    const result = await syncImportList(list);

    expect(result.error).toContain("not a recognized Trakt list");
  });

  it("fails with the HTTP status when the Trakt request itself fails", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/my-list" });

    const result = await syncImportList(list);

    expect(result.error).toContain("HTTP 403");
  });

  it("requests the watchlist endpoint for a watchlist URL, and the list endpoint for a list URL", async () => {
    setSetting("traktClientId", "client-1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await syncImportList(await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/watchlist" }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/tester/watchlist?extended=full");

    fetchMock.mockClear();
    await syncImportList(await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/faves" }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.trakt.tv/users/tester/lists/faves/items?extended=full");
  });

  it("adds a new movie and a new series (fetching the series' episodes), skips one already in the library", async () => {
    setSetting("traktClientId", "client-1");
    const existingId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('movie','Old','old', ?, 1, 'unknown')`)
          .run(JSON.stringify({ tmdb: "999" }))
      ).lastInsertRowid
    );
    expect(existingId).toBeGreaterThan(0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { movie: { title: "Already Have It", year: 2020, ids: { tmdb: 999, trakt: 1 } } },
          { movie: { title: "New Movie", year: 2024, ids: { tmdb: 1001, trakt: 2 } } },
          { show: { title: "New Show", year: 2023, ids: { tmdb: 2001, trakt: 3 } } },
        ],
      })
    );
    fetchSeriesEpisodesFor.mockResolvedValue([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2023-01-01", overview: null }]);
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/mixed" });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 2 });
    const movie = (await db.prepare("SELECT * FROM media_items WHERE title = 'New Movie'").get()) as any;
    expect(movie).toMatchObject({ type: "movie", sort_title: "new movie", year: 2024 });
    expect(JSON.parse(movie.external_ids)).toEqual({ tmdb: "1001", trakt: "2" });
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'New Show'").get()) as any;
    expect(show).toBeTruthy();
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(show.id)) as any[];
    expect(episodes).toHaveLength(1);
    expect(episodes[0].title).toBe("Pilot");
  });

  it("queues an entry for review instead of adding it when require_review is set", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ movie: { title: "Needs Review", year: 2024, ids: { tmdb: 3001, trakt: 4 } } }],
    }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/review-me", require_review: 1 });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Needs Review'").get()).toBeUndefined();
    const reviewItem = (await db.prepare("SELECT * FROM import_review_items WHERE title = 'Needs Review'").get()) as any;
    expect(reviewItem).toMatchObject({ type: "movie", import_list_id: list.id, year: 2024 });
  });

  it("skips an excluded entry", async () => {
    setSetting("traktClientId", "client-1");
    await db
      .prepare("INSERT INTO import_exclusions (type, title, year, external_id, external_provider) VALUES ('movie', 'Excluded Movie', 2024, '4001', 'tmdb')")
      .run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ movie: { title: "Excluded Movie", year: 2024, ids: { tmdb: 4001, trakt: 5 } } }],
    }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/excl" });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
  });

  it("skips an entry that fails passesListFilters", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ movie: { title: "Low Rated", year: 2024, ids: { tmdb: 5001, trakt: 6 }, rating: 2, votes: 50 } }],
    }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/filtered", min_rating: 7 });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
  });

  it("wires entry.genres through to exclude_genres end-to-end (not just passesListFilters in isolation)", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ movie: { title: "Horror Movie", year: 2024, ids: { tmdb: 9101, trakt: 9 }, genres: ["horror"] } }],
    }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/genre-test", exclude_genres: JSON.stringify(["horror"]) });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
  });

  it("continues past one malformed entry and still adds the rest", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { movie: { title: null, year: 2024, ids: { tmdb: 6001 } } }, // title.toLowerCase() throws on null
        { movie: { title: "Survivor Movie", year: 2024, ids: { tmdb: 6002 } } },
      ],
    }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/partial-fail" });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 1 });
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Survivor Movie'").get()).toBeTruthy();
  });
});

describe("syncImportList — imdb", () => {
  const csvHeader = "Position,Const,Created,Modified,Description,Title,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors";

  function csvField(value: string): string {
    // Mirrors what a real IMDb export does: any field containing a comma (e.g. "1,900,000" votes,
    // or a multi-genre "Action, Sci-Fi") must be quoted, or splitCsvLine would split it apart.
    return value.includes(",") ? `"${value.replace(/"/g, '""')}"` : value;
  }

  function csvRow(fields: Record<string, string>): string {
    const cols = csvHeader.split(",").map((h) => csvField(fields[h] ?? ""));
    return cols.join(",");
  }

  it("fails when the URL isn't a recognized IMDb list URL", async () => {
    const result = await syncImportList(await insertImportList({ type: "imdb", url: "https://imdb.com/title/tt1234567" }));

    expect(result.error).toContain("not a recognized IMDb list URL");
  });

  it("fails with the HTTP status when the CSV export request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await syncImportList(await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000001/" }));

    expect(result.error).toContain("HTTP 404");
  });

  it("parses the CSV (including a quoted field containing a comma) and adds the best metadata match", async () => {
    const csv = [
      csvHeader,
      csvRow({ Title: "The Matrix", "Title Type": "Movie", Year: "1999", "IMDb Rating": "8.7", "Num Votes": "1,900,000", Genres: "Action, Sci-Fi" }),
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => csv }));
    searchMetadata.mockResolvedValue([
      { title: "The Matrix", year: 1999, overview: "A hacker discovers reality is a simulation.", posterUrl: "https://img/matrix.jpg", externalIds: { tmdb: "603" } },
    ]);

    const result = await syncImportList(await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000001/" }));

    expect(result).toEqual({ added: 1 });
    expect(searchMetadata).toHaveBeenCalledWith("movie", "The Matrix 1999");
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'The Matrix'").get()) as any;
    expect(row).toMatchObject({ type: "movie", overview: "A hacker discovers reality is a simulation.", poster_url: "https://img/matrix.jpg" });
  });

  it("treats a 'Series'/'TV Series' Title Type as a series and fetches its episodes", async () => {
    const csv = [csvHeader, csvRow({ Title: "Some Show", "Title Type": "TV Series", Year: "2020" })].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => csv }));
    searchMetadata.mockResolvedValue([{ title: "Some Show", year: 2020, overview: null, posterUrl: null, externalIds: { tmdb: "777" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([{ seasonNumber: 1, episodeNumber: 1, title: "Ep 1", airDate: null, overview: null }]);

    await syncImportList(await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000002/" }));

    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'Some Show'").get()) as any;
    expect(show.type).toBe("series");
    expect(await db.prepare("SELECT COUNT(*) as c FROM episodes WHERE media_item_id = ?").get(show.id)).toMatchObject({ c: 1 });
  });

  it("queues the raw title for review when metadata search finds no match at all", async () => {
    const csv = [csvHeader, csvRow({ Title: "Totally Obscure Title", "Title Type": "Movie", Year: "2024" })].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => csv }));
    searchMetadata.mockResolvedValue([]);

    const result = await syncImportList(await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000003/" }));

    expect(result).toEqual({ added: 0 });
    expect((await db.prepare("SELECT * FROM import_review_items WHERE title = 'Totally Obscure Title'").get())).toBeTruthy();
  });

  it("wires the CSV Genres column through to exclude_genres end-to-end, filtering before ever calling searchMetadata", async () => {
    const csv = [csvHeader, csvRow({ Title: "Scary Movie", "Title Type": "Movie", Year: "2024", Genres: "Horror" })].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => csv }));
    const list = await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000005/", exclude_genres: JSON.stringify(["horror"]) });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
    expect(searchMetadata).not.toHaveBeenCalled();
  });

  it("skips a row whose title already has a possible duplicate in the library", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, status) VALUES ('movie','Dune','dune',2021,1,'unknown')`).run();
    const csv = [csvHeader, csvRow({ Title: "Dune", "Title Type": "Movie", Year: "2021" })].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => csv }));

    const result = await syncImportList(await insertImportList({ type: "imdb", url: "https://www.imdb.com/list/ls000000004/" }));

    expect(result).toEqual({ added: 0 });
    expect(searchMetadata).not.toHaveBeenCalled();
  });
});

describe("syncImportList — lastfm", () => {
  it("fails with a clear message when no Last.fm API key is configured", async () => {
    setSetting("lastfmApiKey", "");

    const result = await syncImportList(await insertImportList({ type: "lastfm", url: "last.fm/user/tester" }));

    expect(result.error).toContain("Last.fm API key");
  });

  it("accepts a bare username as well as a full profile URL", async () => {
    setSetting("lastfmApiKey", "key-1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ topartists: { artist: [] } }) });
    vi.stubGlobal("fetch", fetchMock);

    await syncImportList(await insertImportList({ type: "lastfm", url: "bare-username" }));
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("user")).toBe("bare-username");

    fetchMock.mockClear();
    await syncImportList(await insertImportList({ type: "lastfm", url: "https://www.last.fm/user/RealProfile" }));
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("user")).toBe("RealProfile");
  });

  it("handles Last.fm returning a single artist object instead of an array", async () => {
    setSetting("lastfmApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ topartists: { artist: { name: "Solo Artist", mbid: "mbid-1" } } }) }));

    const result = await syncImportList(await insertImportList({ type: "lastfm", url: "last.fm/user/tester" }));

    expect(result).toEqual({ added: 1 });
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Solo Artist'").get()).toBeTruthy();
  });

  it("adds an artist and fetches their albums", async () => {
    setSetting("lastfmApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ topartists: { artist: [{ name: "Band Name", mbid: "mbid-2" }] } }) }));
    fetchArtistAlbumsFor.mockResolvedValue({ provider: "lastfm", albums: [{ title: "Album One", releaseDate: "2020-01-01" }] });

    const result = await syncImportList(await insertImportList({ type: "lastfm", url: "last.fm/user/tester" }));

    expect(result).toEqual({ added: 1 });
    const artist = (await db.prepare("SELECT * FROM media_items WHERE title = 'Band Name'").get()) as any;
    expect(artist.type).toBe("artist");
    const albums = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(artist.id)) as any[];
    expect(albums).toHaveLength(1);
    expect(albums[0].title).toBe("Album One");
  });

  it("skips an artist with a possible duplicate already in the library, and a separately-excluded one", async () => {
    setSetting("lastfmApiKey", "key-1");
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist','Duplicate Band','duplicate band',1,'unknown')`).run();
    await db
      .prepare("INSERT INTO import_exclusions (type, title, year, external_id, external_provider) VALUES ('artist', 'Excluded Band', NULL, 'mbid-excl', 'lastfm')")
      .run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ topartists: { artist: [{ name: "Duplicate Band", mbid: "mbid-dup" }, { name: "Excluded Band", mbid: "mbid-excl" }] } }),
    }));

    const result = await syncImportList(await insertImportList({ type: "lastfm", url: "last.fm/user/tester" }));

    expect(result).toEqual({ added: 0 });
  });

  it("never fetches tracks for an album the provider returned with no externalId", async () => {
    setSetting("lastfmApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ topartists: { artist: [{ name: "No Id Band", mbid: "mbid-noid" }] } }) }));
    fetchArtistAlbumsFor.mockResolvedValue({ provider: "lastfm", albums: [{ title: "No Id Album", releaseDate: null }] });

    await syncImportList(await insertImportList({ type: "lastfm", url: "last.fm/user/tester" }));

    expect(fetchAlbumTracksFor).not.toHaveBeenCalled();
  });
});

describe("syncImportList — tmdb", () => {
  it("fails with a clear message when no TMDB API key is configured", async () => {
    setSetting("tmdbApiKey", "");

    const result = await syncImportList(await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/12345" }));

    expect(result.error).toContain("TMDB API key");
  });

  it("accepts a bare numeric list id as well as a full URL", async () => {
    setSetting("tmdbApiKey", "key-1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await syncImportList(await insertImportList({ type: "tmdb", url: "98765" }));

    expect(fetchMock.mock.calls[0][0]).toContain("/3/list/98765");
  });

  it("distinguishes movies from TV shows via media_type, maps genre ids to names for filtering", async () => {
    setSetting("tmdbApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { media_type: "movie", id: 7001, title: "A Movie", release_date: "2022-05-01", genre_ids: [27], vote_average: 8, vote_count: 500 }, // 27 = horror
          { media_type: "tv", id: 7002, name: "A Show", first_air_date: "2021-03-01", genre_ids: [16], vote_average: 8, vote_count: 500 }, // 16 = animation
        ],
      }),
    }));
    const list = await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/1", exclude_genres: JSON.stringify(["horror"]) });

    const result = await syncImportList(list);

    // The movie is filtered out by exclude_genres (horror); the show isn't (animation is not excluded).
    expect(result).toEqual({ added: 1 });
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'A Movie'").get()).toBeUndefined();
    const show = (await db.prepare("SELECT * FROM media_items WHERE title = 'A Show'").get()) as any;
    expect(show).toMatchObject({ type: "series", year: 2021 });
  });

  it("falls back to the first_air_date heuristic to detect TV when media_type is absent", async () => {
    setSetting("tmdbApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 7003, name: "Heuristic Show", first_air_date: "2019-01-01" }] }),
    }));

    await syncImportList(await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/2" }));

    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Heuristic Show'").get()) as any;
    expect(row.type).toBe("series");
  });

  it("skips a movie and a series already in the library, matched by tmdb id via existingTmdbIds", async () => {
    setSetting("tmdbApiKey", "key-1");
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('movie','Old TMDB Movie','old', ?, 1, 'unknown')`).run(JSON.stringify({ tmdb: "9001" }));
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('series','Old TMDB Show','old', ?, 1, 'unknown')`).run(JSON.stringify({ tmdb: "9002" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { media_type: "movie", id: 9001, title: "Old TMDB Movie", release_date: "2020-01-01" },
          { media_type: "tv", id: 9002, name: "Old TMDB Show", first_air_date: "2020-01-01" },
        ],
      }),
    }));

    const result = await syncImportList(await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/3" }));

    expect(result).toEqual({ added: 0 });
  });

  it("excludes a TV-only genre via TMDB_TV_GENRES, not just the movie genre map", async () => {
    setSetting("tmdbApiKey", "key-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      // 10762 = "Kids" -- a TV-only genre id with no equivalent entry in TMDB_MOVIE_GENRES.
      json: async () => ({ items: [{ media_type: "tv", id: 9201, name: "Kids Show", first_air_date: "2020-01-01", genre_ids: [10762] }] }),
    }));
    const list = await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/4", exclude_genres: JSON.stringify(["kids"]) });

    const result = await syncImportList(list);

    expect(result).toEqual({ added: 0 });
  });

  it("skips a row with malformed external_ids JSON in the dedup check rather than crashing the sync", async () => {
    setSetting("tmdbApiKey", "key-1");
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status) VALUES ('movie','Malformed','malformed','{not json',1,'unknown')`).run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ media_type: "movie", id: 9301, title: "New After Malformed", release_date: "2024-01-01" }] }),
    }));

    const result = await syncImportList(await insertImportList({ type: "tmdb", url: "https://www.themoviedb.org/list/5" }));

    expect(result).toEqual({ added: 1 });
  });
});

describe("syncImportList — orchestration", () => {
  it("persists last_synced_at/last_added_count and clears last_error on success", async () => {
    setSetting("traktClientId", "client-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/watchlist" });
    await db.prepare("UPDATE import_lists SET last_error = 'stale previous error' WHERE id = ?").run(list.id);

    await syncImportList(list);

    const row = (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(list.id)) as any;
    expect(row.last_added_count).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.last_synced_at).toBeTruthy();
  });

  it("persists last_error and leaves the row otherwise updated on failure", async () => {
    setSetting("traktClientId", "");
    const list = await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/watchlist" });

    const result = await syncImportList(list);

    expect(result.error).toBeTruthy();
    const row = (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(list.id)) as any;
    expect(row.last_error).toBe(result.error);
    expect(row.last_synced_at).toBeTruthy();
  });
});

describe("runAllImportLists", () => {
  // runAllImportLists scans every row in import_lists, not just ones a given test created — wipe
  // it first so the 15+ lists earlier describe blocks left behind can't be reprocessed here too.
  beforeEach(async () => {
    await db.prepare("DELETE FROM import_lists").run();
  });

  it("only runs enabled lists", async () => {
    setSetting("traktClientId", "client-1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ movie: { title: "Should Not Appear", year: 2024, ids: { tmdb: 8001 } } }],
    });
    vi.stubGlobal("fetch", fetchMock);
    await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/disabled-list", enabled: 0 });

    await runAllImportLists();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Should Not Appear'").get()).toBeUndefined();
  });

  it("stops processing further lists once the AbortSignal fires mid-run", async () => {
    setSetting("traktClientId", "client-1");
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort(); // simulate the signal firing while the first list's own sync is in flight
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    // Insertion order determines which list runAllImportLists' unordered SELECT reaches first —
    // inserted first, so it gets the lower rowid and is processed before the second.
    await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/processed-first" });
    await insertImportList({ type: "trakt", url: "https://trakt.tv/users/tester/lists/skipped-after-abort" });

    await runAllImportLists(controller.signal);

    // Only the first list's sync should ever have made a request — the loop's own abort check
    // (run between list iterations, not just once at the start) must stop it before the second.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
