import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let fetchRadarrMovies: (typeof import("../src/services/starrImport.js"))["fetchRadarrMovies"];
let importMoviesFromRadarr: (typeof import("../src/services/starrImport.js"))["importMoviesFromRadarr"];
let fetchSonarrSeries: (typeof import("../src/services/starrImport.js"))["fetchSonarrSeries"];
let importSeriesFromSonarr: (typeof import("../src/services/starrImport.js"))["importSeriesFromSonarr"];
let importArtistsFromLidarr: (typeof import("../src/services/starrImport.js"))["importArtistsFromLidarr"];
let importAuthorsFromReadarr: (typeof import("../src/services/starrImport.js"))["importAuthorsFromReadarr"];
let rootFolderId: number;
let bookRootFolderId: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ fetchRadarrMovies, importMoviesFromRadarr, fetchSonarrSeries, importSeriesFromSonarr, importArtistsFromLidarr, importAuthorsFromReadarr } =
    await import("../src/services/starrImport.js"));
  // root_folder_id is a real FK (ON DELETE SET NULL) — a literal like 1 only works if a root
  // folder with that id actually exists.
  rootFolderId = Number(
    (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/music', 'artist')").run()).lastInsertRowid
  );
  bookRootFolderId = Number(
    (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/books', 'author')").run()).lastInsertRowid
  );
});

function mockStarrApi(handlers: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      for (const [needle, body] of Object.entries(handlers)) {
        if (url.includes(needle)) return { ok: true, json: async () => body } as any;
      }
      return { ok: true, json: async () => [] } as any;
    })
  );
}

describe("fetchRadarrMovies", () => {
  it("uses movieFile.path directly when present", async () => {
    mockStarrApi({
      "/api/v3/movie": [{ title: "Direct Path Movie", tmdbId: 100, hasFile: true, movieFile: { path: "/data/movies/Direct/movie.mkv" } }],
    });

    const [item] = await fetchRadarrMovies("http://radarr:7878", "key");

    expect(item.path).toBe("/data/movies/Direct/movie.mkv");
    expect(item.mediaServerId).toBe("/data/movies/Direct/movie.mkv");
  });

  it("combines path + movieFile.relativePath when movieFile.path is absent", async () => {
    mockStarrApi({
      "/api/v3/movie": [
        { title: "Relative Path Movie", tmdbId: 101, hasFile: true, path: "/data/movies/Relative", movieFile: { relativePath: "movie.mkv" } },
      ],
    });

    const [item] = await fetchRadarrMovies("http://radarr:7878", "key");

    expect(item.path).toBe("/data/movies/Relative/movie.mkv");
  });

  it("leaves path null and falls back to a tmdb-based id for a not-yet-downloaded movie", async () => {
    mockStarrApi({ "/api/v3/movie": [{ title: "Not Downloaded Movie", tmdbId: 102, hasFile: false }] });

    const [item] = await fetchRadarrMovies("http://radarr:7878", "key");

    expect(item.path).toBeNull();
    expect(item.mediaServerId).toBe("radarr:102");
  });

  it("skips an entry with no title", async () => {
    mockStarrApi({ "/api/v3/movie": [{ tmdbId: 103, hasFile: false }, { title: "Has A Title", tmdbId: 104, hasFile: false }] });

    const items = await fetchRadarrMovies("http://radarr:7878", "key");

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Has A Title");
  });
});

describe("importArtistsFromLidarr", () => {
  function mockLidarr(opts: {
    artists: { id: number; artistName: string; foreignArtistId?: string; overview?: string }[];
    albumsByArtist: Record<number, { id: number; artistId: number; title: string; foreignAlbumId?: string }[]>;
    trackFilesByArtist: Record<number, { id: number; albumId: number; path: string }[]>;
  }): void {
    mockStarrApi({
      "/api/v1/artist": opts.artists,
      ...Object.fromEntries(Object.entries(opts.albumsByArtist).map(([id, albums]) => [`/api/v1/album?artistId=${id}`, albums])),
      ...Object.fromEntries(Object.entries(opts.trackFilesByArtist).map(([id, files]) => [`/api/v1/trackfile?artistId=${id}`, files])),
    });
  }

  it("creates a new artist and album when nothing matches", async () => {
    mockLidarr({
      artists: [{ id: 1, artistName: "New Artist", foreignArtistId: "mbid-new-1" }],
      albumsByArtist: { 1: [{ id: 10, artistId: 1, title: "New Album", foreignAlbumId: "mbid-album-1" }] },
      trackFilesByArtist: { 1: [{ id: 100, albumId: 10, path: "/music/New Artist/New Album/01.flac" }] },
    });

    const result = await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    expect(result).toEqual({ parentsMatched: 0, parentsCreated: 1, childrenMatched: 0, childrenCreated: 1, childrenSkipped: 0 });
    const artist = (await db.prepare("SELECT * FROM media_items WHERE title = 'New Artist'").get()) as any;
    expect(artist.type).toBe("artist");
    expect(artist.has_file).toBe(1); // rolled up from its one has_file child
    expect(JSON.parse(artist.external_ids)).toEqual({ musicbrainz: "mbid-new-1" });
    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(artist.id)) as any;
    expect(album.title).toBe("New Album");
    expect(album.file_path).toBe("/music/New Artist/New Album");
  });

  it("matches an existing artist by external id even when the title differs", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('artist', 'Old Name For Artist', 'x', 1, 0, 'unknown', ?)`
          )
          .run(JSON.stringify({ musicbrainz: "mbid-existing-1" }))
      ).lastInsertRowid
    );
    // importCollectionData only ever resolves a parent as a side effect of processing one of its
    // children — a parent with zero children in the Starr response is never looked at at all, so
    // this needs at least one album for the match logic to actually run.
    mockLidarr({
      artists: [{ id: 2, artistName: "Renamed Artist", foreignArtistId: "mbid-existing-1" }],
      albumsByArtist: { 2: [{ id: 20, artistId: 2, title: "Some Album" }] },
      trackFilesByArtist: { 2: [] },
    });

    const result = await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    expect(result.parentsMatched).toBe(1);
    expect(result.parentsCreated).toBe(0);
    const row = (await db.prepare("SELECT title FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.title).toBe("Old Name For Artist"); // matching never renames the existing row
  });

  it("fills in a matched artist's missing overview/poster without overwriting existing values", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, overview, external_ids) VALUES ('artist', 'Coalesce Artist', 'x', 1, 0, 'unknown', 'Existing overview', '{}')`
          )
          .run()
      ).lastInsertRowid
    );
    mockLidarr({
      artists: [{ id: 3, artistName: "Coalesce Artist", overview: "New overview from Lidarr" }],
      albumsByArtist: { 3: [{ id: 30, artistId: 3, title: "Some Other Album" }] }, // needed so resolveParent actually runs
      trackFilesByArtist: { 3: [] },
    });

    await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    const row = (await db.prepare("SELECT overview FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.overview).toBe("Existing overview"); // COALESCE kept the existing value, didn't overwrite
  });

  it("skips a child whose file path tail is already tracked under this type", async () => {
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Tail Skip Artist', 'x', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    // Lidarr-derived children are always stored as a FOLDER path (see fetchLidarrLibrary — the
    // track file's own directory, not the file itself), so the pre-existing fixture needs to be a
    // folder path too. pathTail keeps only the LAST 3 segments — for two folder paths to share a
    // tail, the segment 3 levels up ("music" here) must match on both sides; only the mount-point
    // prefix before that is free to differ, which is the actual thing this test means to prove
    // tolerance for.
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Already Tracked Album', 1, 1, ?)")
      .run(artistId, "/existing/music/Tail Skip Artist/Already Tracked Album");
    mockLidarr({
      artists: [{ id: 4, artistName: "Tail Skip Artist" }],
      albumsByArtist: { 4: [{ id: 40, artistId: 4, title: "Duplicate Album Entry" }] },
      trackFilesByArtist: { 4: [{ id: 400, albumId: 40, path: "/different/mount/music/Tail Skip Artist/Already Tracked Album/01.flac" }] },
    });

    const result = await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    expect(result.childrenSkipped).toBe(1);
    expect(result.childrenCreated).toBe(0);
  });

  it("updates an existing fileless child once Lidarr reports a real path for it", async () => {
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Update Child Artist', 'x', 1, 0, 'unknown')`).run())
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Was Missing Album', 1, 0)").run(artistId);
    mockLidarr({
      artists: [{ id: 5, artistName: "Update Child Artist" }],
      albumsByArtist: { 5: [{ id: 50, artistId: 5, title: "Was Missing Album" }] },
      trackFilesByArtist: { 5: [{ id: 500, albumId: 50, path: "/music/Update Child Artist/Was Missing Album/01.flac" }] },
    });

    const result = await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    expect(result.childrenMatched).toBe(1);
    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND title = 'Was Missing Album'").get(artistId)) as any;
    expect(album.has_file).toBe(1);
    expect(album.file_path).toBe("/music/Update Child Artist/Was Missing Album");
  });

  it("never resets an already-downloaded child back to missing when Lidarr no longer reports a file", async () => {
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Never Reset Artist', 'x', 1, 1, 'unknown')`).run())
        .lastInsertRowid
    );
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Downloaded Album', 1, 1, ?)")
      .run(artistId, "/music/Never Reset Artist/Downloaded Album/01.flac");
    mockLidarr({
      artists: [{ id: 6, artistName: "Never Reset Artist" }],
      albumsByArtist: { 6: [{ id: 60, artistId: 6, title: "Downloaded Album" }] }, // no track file this time
      trackFilesByArtist: { 6: [] },
    });

    await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND title = 'Downloaded Album'").get(artistId)) as any;
    expect(album.has_file).toBe(1);
    expect(album.file_path).toBe("/music/Never Reset Artist/Downloaded Album/01.flac");
  });

  it("uses the FIRST track file's directory as an album's folder path when Lidarr reports more than one", async () => {
    mockLidarr({
      artists: [{ id: 7, artistName: "Multi File Artist" }],
      albumsByArtist: { 7: [{ id: 70, artistId: 7, title: "Multi File Album" }] },
      trackFilesByArtist: {
        7: [
          { id: 700, albumId: 70, path: "/music/Multi File Artist/Multi File Album/01.flac" },
          { id: 701, albumId: 70, path: "/music/Multi File Artist/Multi File Album/02.flac" },
        ],
      },
    });

    await importArtistsFromLidarr("http://lidarr:8686", "key", rootFolderId);

    const album = (await db.prepare("SELECT * FROM sub_items WHERE title = 'Multi File Album'").get()) as any;
    expect(album.file_path).toBe("/music/Multi File Artist/Multi File Album"); // derived from the first file only
  });
});

describe("importMoviesFromRadarr", () => {
  it("fetches from Radarr then delegates to the same match-or-create logic proven for media-server imports", async () => {
    mockStarrApi({ "/api/v3/movie": [{ title: "Radarr Movie", tmdbId: 500, hasFile: true, movieFile: { path: "/data/movies/Radarr Movie/movie.mkv" } }] });

    const result = await importMoviesFromRadarr("http://radarr:7878", "key", rootFolderId);

    expect(result).toEqual({ matched: 0, created: 1, skipped: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE title = 'Radarr Movie'").get()) as any;
    expect(row).toMatchObject({ path: "/data/movies/Radarr Movie/movie.mkv", has_file: 1 });
  });
});

describe("fetchSonarrSeries", () => {
  it("maps a series and its per-series episodes/files, resolving a real path only for a downloaded episode", async () => {
    mockStarrApi({
      "/api/v3/series": [{ id: 1, title: "Sonarr Show", year: 2020, overview: "A show", tvdbId: 900 }],
      "episode?seriesId=1": [
        { seriesId: 1, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: true, episodeFileId: 10 },
        { seriesId: 1, seasonNumber: 1, episodeNumber: 2, title: "Ep 2", hasFile: false },
      ],
      "episodefile?seriesId=1": [{ id: 10, path: "/tv/Sonarr Show/S01E01.mkv" }],
    });

    const { shows, episodes } = await fetchSonarrSeries("http://sonarr:8989", "key");

    expect(shows.get("1")).toEqual({ title: "Sonarr Show", year: 2020, overview: "A show", posterUrl: null, externalIds: { tvdb: "900" } });
    expect(episodes).toEqual([
      { showId: "1", path: "/tv/Sonarr Show/S01E01.mkv", seasonNumber: 1, episodeNumber: 1, title: "Pilot", overview: null },
      { showId: "1", path: null, seasonNumber: 1, episodeNumber: 2, title: "Ep 2", overview: null },
    ]);
  });

  it("fetches every series independently (the N+1 per-series pattern) and skips a title-less one", async () => {
    mockStarrApi({
      "/api/v3/series": [{ id: 1, title: "Show One" }, { id: 2, title: "" }, { id: 3, title: "Show Three" }],
      "episode?seriesId=1": [{ seriesId: 1, seasonNumber: 1, episodeNumber: 1 }],
      "episodefile?seriesId=1": [],
      "episode?seriesId=3": [{ seriesId: 3, seasonNumber: 1, episodeNumber: 1 }],
      "episodefile?seriesId=3": [],
    });

    const { shows, episodes } = await fetchSonarrSeries("http://sonarr:8989", "key");

    expect(Array.from(shows.keys()).sort()).toEqual(["1", "3"]); // series 2 (no title) skipped entirely
    expect(episodes.map((e) => e.showId)).toEqual(["1", "3"]);
  });
});

describe("importSeriesFromSonarr", () => {
  it("fetches from Sonarr then delegates to the same match-or-create logic proven for media-server imports", async () => {
    mockStarrApi({
      "/api/v3/series": [{ id: 11, title: "Sonarr Import Show" }],
      "episode?seriesId=11": [{ seriesId: 11, seasonNumber: 1, episodeNumber: 1, hasFile: true, episodeFileId: 110 }],
      "episodefile?seriesId=11": [{ id: 110, path: "/tv/Sonarr Import Show/S01E01.mkv" }],
    });

    const result = await importSeriesFromSonarr("http://sonarr:8989", "key", "series", rootFolderId);

    expect(result).toEqual({ showsMatched: 0, showsCreated: 1, episodesMatched: 0, episodesCreated: 1, episodesSkipped: 0 });
  });
});

describe("importAuthorsFromReadarr", () => {
  it("creates a new author and book when nothing matches, using goodreads as the external provider", async () => {
    mockStarrApi({
      "/api/v1/author": [{ id: 1, authorName: "New Author", foreignAuthorId: "gr-1" }],
      "book?authorId=1": [{ id: 10, authorId: 1, title: "New Book", foreignBookId: "gr-book-1" }],
      "bookfile?authorId=1": [{ id: 100, bookId: 10, path: "/books/New Author/New Book.epub" }],
    });

    const result = await importAuthorsFromReadarr("http://readarr:8787", "key", bookRootFolderId);

    expect(result).toEqual({ parentsMatched: 0, parentsCreated: 1, childrenMatched: 0, childrenCreated: 1, childrenSkipped: 0 });
    const author = (await db.prepare("SELECT * FROM media_items WHERE title = 'New Author'").get()) as any;
    expect(author.type).toBe("author");
    expect(JSON.parse(author.external_ids)).toEqual({ goodreads: "gr-1" });
    const book = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(author.id)) as any;
    expect(book).toMatchObject({ title: "New Book", external_provider: "goodreads", external_id: "gr-book-1", file_path: "/books/New Author/New Book.epub", has_file: 1 });
  });

  it("matches an existing author by external id even when the name differs (the same resolveParent logic Lidarr already proves)", async () => {
    const existingId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('author', 'Old Author Name', 'x', 1, 0, 'unknown', ?)`
          )
          .run(JSON.stringify({ goodreads: "gr-existing" }))
      ).lastInsertRowid
    );
    mockStarrApi({
      "/api/v1/author": [{ id: 2, authorName: "Renamed Author", foreignAuthorId: "gr-existing" }],
      "book?authorId=2": [{ id: 20, authorId: 2, title: "Some Book" }], // needed for resolveParent to run at all
      "bookfile?authorId=2": [],
    });

    const result = await importAuthorsFromReadarr("http://readarr:8787", "key", bookRootFolderId);

    expect(result.parentsMatched).toBe(1);
    expect(result.parentsCreated).toBe(0);
    const row = (await db.prepare("SELECT title FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row.title).toBe("Old Author Name"); // matching never renames the existing row
  });
});
