import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { setupTestDb } from "./helpers/testDb.js";

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();
const fetchSeriesEpisodesForProvider = vi.fn();
const fetchSeriesSeasonsFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const fetchCollectionChildrenFor = vi.fn();
const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", () => ({
  searchMetadata: (...args: unknown[]) => searchMetadata(...args),
  fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
  fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
  fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
  fetchSeriesSeasonsFor: (...args: unknown[]) => fetchSeriesSeasonsFor(...args),
  fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
  fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
  fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scanAndImportLibrary: (typeof import("../src/services/libraryScan.js"))["scanAndImportLibrary"];
let refreshOneMediaItem: (typeof import("../src/services/libraryScan.js"))["refreshOneMediaItem"];

beforeAll(async () => {
  // Called exactly once — db/index.js's initDb() caches its dbInstance for the lifetime of this
  // test file's worker, so a second setupTestDb() call here would silently reuse the same
  // already-seeded database instead of a fresh one. Per-test isolation comes from the table-clear
  // in beforeEach below, matching libraryScan.test.ts's own established convention.
  ({ db } = await setupTestDb());
  ({ scanAndImportLibrary, refreshOneMediaItem } = await import("../src/services/libraryScan.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM tracks").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM seasons").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();

  probeMediaInfo.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchSeriesSeasonsFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});
});

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-sidecarscan-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function insertRootFolder(mediaType: string): Promise<{ id: number; path: string }> {
  const p = path.join(tmpRoot, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function writeFile(dir: string, name: string, content = "fake bytes"): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("scanAndImportLibrary — sidecar matching (single shape: movie)", () => {
  it("uses movie.nfo's title/year over filename guessing, and enriches via its tmdb id", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Some Random Filename 2019");
    writeFile(dir, "movie.file.mkv");
    writeFile(
      dir,
      "movie.nfo",
      `<movie><title>Dune</title><year>2021</year><uniqueid type="tmdb">438631</uniqueid></movie>`
    );
    fetchByExternalId.mockResolvedValueOnce({
      title: "Dune",
      year: 2021,
      overview: "A noble family becomes embroiled in a war.",
      posterUrl: "https://p/dune.jpg",
      externalIds: { tmdb: "438631" },
    });

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ created: 1 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    // The sidecar's own title/year win over the filename-guessed "Movie File"/no-year.
    expect(row).toMatchObject({ title: "Dune", year: 2021, overview: "A noble family becomes embroiled in a war." });
    expect(fetchByExternalId).toHaveBeenCalledWith("movie", "tmdb", "438631");
  });

  it("falls back to the sidecar's own fields (no network) when it carries no provider id", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Offline Movie");
    writeFile(dir, "movie.file.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Offline Only</title><year>2015</year><plot>No id here.</plot></movie>`);

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ created: 1 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(row).toMatchObject({ title: "Offline Only", year: 2015, overview: "No id here." });
    expect(fetchByExternalId).not.toHaveBeenCalled();
  });
});

describe("scanAndImportLibrary — sidecar matching (episodic: series and course)", () => {
  it("uses tvshow.nfo/episodedetails.nfo over filename/folder guessing for a provider-backed type", async () => {
    const folder = await insertRootFolder("series");
    const seasonDir = path.join(folder.path, "Wrong Folder Name", "Season 01");
    const epFile = writeFile(seasonDir, "ep01.mkv");
    writeFile(path.dirname(seasonDir), "tvshow.nfo", `<tvshow><title>Breaking Bad</title><uniqueid type="tmdb">1396</uniqueid></tvshow>`);
    writeFile(
      seasonDir,
      "ep01.nfo",
      `<episodedetails><title>Pilot</title><plot>A chemistry teacher's diagnosis changes everything.</plot><season>1</season><episode>1</episode></episodedetails>`
    );
    fetchByExternalId.mockResolvedValueOnce({
      title: "Breaking Bad",
      year: 2008,
      overview: "A teacher turns to crime.",
      posterUrl: "https://p/bb.jpg",
      externalIds: { tmdb: "1396" },
    });

    const result = await scanAndImportLibrary("series");

    expect(result).toMatchObject({ matched: 1, created: 0 });
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show).toMatchObject({ title: "Breaking Bad", overview: "A teacher turns to crime." });
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    // The episode's own sidecar overview is used too, not just its title — a per-episode NFO's
    // <plot> was previously parsed and then silently discarded on insert.
    expect(ep).toMatchObject({
      season_number: 1,
      episode_number: 1,
      title: "Pilot",
      overview: "A chemistry teacher's diagnosis changes everything.",
      file_path: epFile,
    });
    expect(fetchByExternalId).toHaveBeenCalledWith("series", "tmdb", "1396");
  });

  it("a per-episode .nfo never collapses a multi-episode filename (S01E01-E02) to its single <episode>", async () => {
    // Jellyfin writes ONE root for a multi-episode file, with <episodenumberend> AoNarr doesn't read.
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    const seasonDir = path.join(folder.path, "Show", "Season 01");
    const filePath = writeFile(seasonDir, "Show.S01E01-E02.mkv");
    writeFile(
      seasonDir,
      "Show.S01E01-E02.nfo",
      `<episodedetails><title>Part One</title><season>1</season><episode>1</episode><episodenumberend>2</episodenumberend></episodedetails>`
    );

    const result = await scanAndImportLibrary("series");

    expect(result.matched).toBe(2);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes.map((e) => ({ episode: e.episode_number, title: e.title, hasFile: e.has_file, filePath: e.file_path }))).toEqual([
      { episode: 1, title: "Ep1", hasFile: 1, filePath },
      { episode: 2, title: "Ep2", hasFile: 1, filePath },
    ]);
  });

  it("attaches a marker-less file in a 'Specials' folder, numbered only by its .nfo, to the show folder's existing show", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    const specialsDir = path.join(folder.path, "Show", "Specials");
    const filePath = writeFile(specialsDir, "Behind the Scenes.mkv");
    writeFile(specialsDir, "Behind the Scenes.nfo", `<episodedetails><title>Behind the Scenes</title><season>0</season><episode>3</episode></episodedetails>`);

    const result = await scanAndImportLibrary("series");

    expect(result).toMatchObject({ matched: 1, skipped: 0 });
    const shows = (await db.prepare("SELECT id FROM media_items WHERE type='series'").all()) as any[];
    expect(shows.map((s) => s.id)).toEqual([showId]);
    expect(searchMetadata).not.toHaveBeenCalled();
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toMatchObject({ season_number: 0, episode_number: 3, title: "Behind the Scenes", has_file: 1, file_path: filePath });
  });

  it("titles a new show from its folder (not the episode filename) when only the .nfo numbers the file", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "Some Show", "Season 00"), "Behind the Scenes.mkv");
    writeFile(
      path.join(folder.path, "Some Show", "Season 00"),
      "Behind the Scenes.nfo",
      `<episodedetails><title>Behind the Scenes</title><season>0</season><episode>3</episode></episodedetails>`
    );

    await scanAndImportLibrary("series");

    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='series'").all()) as any[];
    expect(shows.map((s) => s.title)).toEqual(["Some Show"]);
    expect(searchMetadata).toHaveBeenCalledWith("series", "Some Show", undefined, null);
    expect(searchMetadata).not.toHaveBeenCalledWith("series", "Behind the Scenes", expect.anything(), expect.anything());
  });

  it("titles a show from its folder when a Specials file's only marker is a bare folder-relative episode number", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    writeFile(path.join(folder.path, "Show", "Specials"), "Behind the Scenes E03.mkv");

    await scanAndImportLibrary("series");

    const shows = (await db.prepare("SELECT id FROM media_items WHERE type='series'").all()) as any[];
    expect(shows.map((s) => s.id)).toEqual([showId]);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toMatchObject({ season_number: 0, episode_number: 3, has_file: 1 });
  });

  it("finds the show folder's tvshow.nfo for a file in its 'Specials' folder", async () => {
    const folder = await insertRootFolder("series");
    const showDir = path.join(folder.path, "Wrong Folder Name");
    writeFile(showDir, "tvshow.nfo", `<tvshow><title>Real Show</title></tvshow>`);
    writeFile(path.join(showDir, "Specials"), "Extra.mkv");
    writeFile(path.join(showDir, "Specials"), "Extra.nfo", `<episodedetails><title>Extra</title><season>0</season><episode>1</episode></episodedetails>`);

    await scanAndImportLibrary("series");

    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='series'").all()) as any[];
    expect(shows.map((s) => s.title)).toEqual(["Real Show"]);
  });

  it("skips a marker-less file loose in the library root rather than naming a show after the root folder or the file", async () => {
    const folder = await insertRootFolder("series");
    writeFile(folder.path, "Behind the Scenes.mkv");
    writeFile(folder.path, "Behind the Scenes.nfo", `<episodedetails><title>Behind the Scenes</title><season>0</season><episode>3</episode></episodedetails>`);

    const result = await scanAndImportLibrary("series");

    expect(result).toMatchObject({ matched: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("couldn't guess a series title");
    expect(await db.prepare("SELECT * FROM media_items WHERE type='series'").all()).toEqual([]);
  });

  it("enriches a sequentialEpisodeFallback type (course) from its sidecar despite having no metadata provider at all", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "Wrong Course Folder Name");
    writeFile(courseDir, "01 - Welcome.mp4");
    writeFile(
      courseDir,
      "tvshow.nfo",
      `<tvshow><title>Real Course Title</title><plot>Learn something.</plot><mpaa>All Ages</mpaa><genre>Engineering</genre><genre>Science</genre></tvshow>`
    );
    writeFile(courseDir, "01 - Welcome.nfo", `<episodedetails><title>Welcome Lesson</title><plot>The first lesson overview.</plot></episodedetails>`);

    const result = await scanAndImportLibrary("course");

    // The episodic branch counts a new show's own first file as a matched episode, not a
    // "created" media_item — result.created is single-shape (movie/rom) only, same convention
    // the existing "creates a new series..." test above already relies on.
    expect(result.matched).toBe(1);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='course'").get()) as any;
    // content_rating/genres from the show-level sidecar were previously dropped on creation —
    // only overview/poster/year/external_ids/release_date/status were written.
    expect(show).toMatchObject({ title: "Real Course Title", overview: "Learn something.", content_rating: "All Ages" });
    expect(JSON.parse(show.genres)).toEqual(["Engineering", "Science"]);
    expect(searchMetadata).not.toHaveBeenCalled();
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ title: "Welcome Lesson", overview: "The first lesson overview." });
  });
});

describe("scanAndImportLibrary — sidecar matching (collection: artist)", () => {
  it("enriches a new artist from artist.nfo with year/rating/genres, not just overview/poster", async () => {
    const folder = await insertRootFolder("artist");
    const albumDir = path.join(folder.path, "Wrong Artist Folder", "OK Computer");
    writeFile(albumDir, "track01.mp3");
    writeFile(
      path.dirname(albumDir),
      "artist.nfo",
      `<artist><name>Radiohead</name><plot>An English rock band.</plot><year>1985</year><mpaa>Explicit</mpaa><genre>Rock</genre><genre>Alternative</genre></artist>`
    );

    const result = await scanAndImportLibrary("artist");

    expect(result.matched).toBe(1);
    const artist = (await db.prepare("SELECT * FROM media_items WHERE type='artist'").get()) as any;
    expect(artist).toMatchObject({ title: "Radiohead", overview: "An English rock band.", year: 1985, content_rating: "Explicit" });
    expect(JSON.parse(artist.genres)).toEqual(["Rock", "Alternative"]);
  });
});

describe("scanAndImportLibrary — sidecar matching (collection: comic)", () => {
  it("uses ComicInfo.xml embedded in a .cbz for both the series (parent) and issue (child) titles", async () => {
    const folder = await insertRootFolder("comic");
    const dir = path.join(folder.path, "Wrong Series Folder");
    const zip = new AdmZip();
    zip.addFile(
      "ComicInfo.xml",
      Buffer.from(`<ComicInfo><Series>The Amazing Spider-Man</Series><Title>Issue One</Title><Number>1</Number></ComicInfo>`, "utf-8")
    );
    fs.mkdirSync(dir, { recursive: true });
    const issuePath = path.join(dir, "issue1.cbz");
    zip.writeZip(issuePath);

    const result = await scanAndImportLibrary("comic");

    expect(result.matched).toBe(1);
    const series = (await db.prepare("SELECT * FROM media_items WHERE type='comic'").get()) as any;
    expect(series.title).toBe("The Amazing Spider-Man");
    const issue = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(series.id)) as any;
    expect(issue.title).toBe("Issue One");
  });
});

describe("refreshOneMediaItem — sidecar matching", () => {
  it("an already-matched item keeps using its own id when its sidecar carries a different one", async () => {
    // A stale/mis-scraped NFO id must not put another title's overview/poster back over the
    // item's own match (e.g. one just corrected via Different Match).
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Some Movie");
    const filePath = writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Wrong Title</title><uniqueid type="tmdb">999</uniqueid></movie>`);
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, path, root_folder_id, monitored, has_file, status, external_ids)
             VALUES ('movie','Some Movie','some movie',?,?,1,1,'downloaded',?)`
          )
          .run(filePath, folder.id, JSON.stringify({ tmdb: "111" }))
      ).lastInsertRowid
    );
    fetchByExternalId.mockImplementation(async (_type: string, _provider: string, id: string) => {
      if (id === "111") return { title: "Some Movie", overview: "From the item's own id.", externalIds: { tmdb: "111" } };
      throw new Error("wrong id used");
    });

    const result = await refreshOneMediaItem(movieId);

    expect(result.ok).toBe(true);
    expect(fetchByExternalId).toHaveBeenCalledWith("movie", "tmdb", "111");
    expect(fetchByExternalId).not.toHaveBeenCalledWith("movie", "tmdb", "999");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movieId)) as any;
    expect(row.overview).toBe("From the item's own id.");
    expect(row.title).toBe("Some Movie");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "111" });
  });

  it("an already-matched show ignores a stale tvshow.nfo id and refreshes from its own id", async () => {
    const folder = await insertRootFolder("series");
    const seasonDir = path.join(folder.path, "Right Show", "Season 01");
    const epFile = writeFile(seasonDir, "Right.Show.S01E01.mkv");
    writeFile(path.dirname(seasonDir), "tvshow.nfo", `<tvshow><title>Wrong Show</title><uniqueid type="tmdb">999</uniqueid></tvshow>`);
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status, external_ids, overview, poster_url)
             VALUES ('series','Right Show','right show',?,1,1,'continuing',?,'old overview','old.jpg')`
          )
          .run(folder.id, JSON.stringify({ tmdb: "111" }))
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1,'Pilot',1,1,?)`)
      .run(showId, epFile);
    fetchByExternalId.mockImplementation(async (_type: string, _provider: string, id: string) => {
      if (id === "111") return { title: "Right Show", overview: "Right overview", posterUrl: "right.jpg", externalIds: { tmdb: "111" } };
      if (id === "999") return { title: "Wrong Show", overview: "Wrong overview", posterUrl: "wrong.jpg", externalIds: { tmdb: "999" } };
      throw new Error("unexpected id");
    });

    const result = await refreshOneMediaItem(showId);

    expect(result.ok).toBe(true);
    expect(fetchByExternalId).not.toHaveBeenCalledWith("series", "tmdb", "999");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row).toMatchObject({ title: "Right Show", overview: "Right overview", poster_url: "right.jpg" });
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "111" });
  });

  it("still uses a sidecar whose id agrees with the item's own when the id lookup itself fails", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Offline Match");
    const filePath = writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Offline Match</title><plot>From the NFO.</plot><uniqueid type="imdb">tt0000001</uniqueid></movie>`);
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, path, root_folder_id, monitored, has_file, status, external_ids)
             VALUES ('movie','Offline Match','offline match',?,?,1,1,'downloaded',?)`
          )
          .run(filePath, folder.id, JSON.stringify({ imdb: "tt0000001" }))
      ).lastInsertRowid
    );
    // fetchByExternalId rejects by default (no network), same as an offline install.

    const result = await refreshOneMediaItem(movieId);

    expect(result.ok).toBe(true);
    expect(searchMetadata).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movieId)) as any;
    expect(row.overview).toBe("From the NFO.");
  });

  it("Refresh of an author whose book has a metadata.opf keeps the author's own title and uses the provider lookup", async () => {
    // metadata.opf describes one book, never its author — it must not become the parent's metadata.
    const folder = await insertRootFolder("author");
    const authorDir = path.join(folder.path, "Some Author");
    const bookPath = writeFile(authorDir, "book.epub");
    writeFile(
      authorDir,
      "metadata.opf",
      `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Hobbit</dc:title><dc:creator>Some Author</dc:creator></metadata></package>`
    );
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Some Author','some author',?,1,1,'unknown')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'The Hobbit', 1, 1, ?)`).run(authorId, bookPath);
    searchMetadata.mockResolvedValue([{ title: "Some Author", year: null, overview: "Author bio", posterUrl: null, externalIds: { openlibrary: "OL1A" } }]);

    const result = await refreshOneMediaItem(authorId);

    expect(result.ok).toBe(true);
    expect(searchMetadata).toHaveBeenCalledWith("author", "Some Author", undefined, null);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(authorId)) as any;
    expect(row).toMatchObject({ title: "Some Author", overview: "Author bio" });
    expect(JSON.parse(row.external_ids)).toEqual({ openlibrary: "OL1A" });
  });

  it("Refresh of a comic series whose issue carries ComicInfo.xml keeps the series' own title", async () => {
    const folder = await insertRootFolder("comic");
    const dir = path.join(folder.path, "The Amazing Spider-Man");
    const zip = new AdmZip();
    zip.addFile("ComicInfo.xml", Buffer.from(`<ComicInfo><Series>The Amazing Spider-Man</Series><Title>Issue One</Title><Number>1</Number></ComicInfo>`, "utf-8"));
    fs.mkdirSync(dir, { recursive: true });
    const issuePath = path.join(dir, "issue1.cbz");
    zip.writeZip(issuePath);
    const seriesId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('comic','The Amazing Spider-Man','the amazing spider-man',?,1,1,'unknown')`
          )
          .run(folder.id)
      ).lastInsertRowid
    );
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Issue One', 1, 1, ?)`).run(seriesId, issuePath);
    searchMetadata.mockResolvedValue([
      { title: "The Amazing Spider-Man", year: null, overview: "Series overview", posterUrl: null, externalIds: { comicvine: "2127" } },
    ]);

    const result = await refreshOneMediaItem(seriesId);

    expect(result.ok).toBe(true);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(seriesId)) as any;
    expect(row).toMatchObject({ title: "The Amazing Spider-Man", overview: "Series overview" });
    expect(JSON.parse(row.external_ids)).toEqual({ comicvine: "2127" });
  });

  it("falls back to the existing id-lookup/title-search path when there's no sidecar at all", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "No Sidecar Movie");
    const filePath = writeFile(dir, "movie.mkv");
    const movieId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, path, root_folder_id, monitored, has_file, status, external_ids)
             VALUES ('movie','No Sidecar Movie','no sidecar movie',?,?,1,1,'downloaded',?)`
          )
          .run(filePath, folder.id, JSON.stringify({ tmdb: "111" }))
      ).lastInsertRowid
    );
    fetchByExternalId.mockResolvedValueOnce({ title: "No Sidecar Movie", overview: "From the existing id.", externalIds: { tmdb: "111" } });

    const result = await refreshOneMediaItem(movieId);

    expect(result.ok).toBe(true);
    expect(fetchByExternalId).toHaveBeenCalledWith("movie", "tmdb", "111");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movieId)) as any;
    expect(row.overview).toBe("From the existing id.");
  });
});

describe("refreshOneMediaItem — per-episode sidecar re-sync", () => {
  // Scan & Import only ever walks paths it doesn't already know about (see knownPaths in
  // scanAndImportLibraryInner) — it never revisits an already-tracked episode file just because
  // its own .nfo changed after the fact. Refresh needs its own dedicated pass over already-
  // downloaded episodes to pick that up, independent of the file-walk.

  it("re-applies an edited per-episode .nfo for a provider-backed type (series) without a folder rescan", async () => {
    const folder = await insertRootFolder("series");
    const seasonDir = path.join(folder.path, "Test Show", "Season 01");
    writeFile(seasonDir, "ep01.mkv");
    writeFile(path.dirname(seasonDir), "tvshow.nfo", `<tvshow><title>Test Show</title></tvshow>`);
    const nfoPath = writeFile(
      seasonDir,
      "ep01.nfo",
      `<episodedetails><title>Original Title</title><plot>Original overview.</plot><season>1</season><episode>1</episode></episodedetails>`
    );
    await scanAndImportLibrary("series");
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect((await db.prepare("SELECT title, overview FROM episodes WHERE media_item_id = ?").get(show.id)) as any).toMatchObject({
      title: "Original Title",
      overview: "Original overview.",
    });

    fs.writeFileSync(nfoPath, `<episodedetails><title>Refreshed Title</title><plot>Refreshed overview.</plot></episodedetails>`);
    const result = await refreshOneMediaItem(show.id);

    expect(result.ok).toBe(true);
    const ep = (await db.prepare("SELECT title, overview FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ title: "Refreshed Title", overview: "Refreshed overview." });
  });

  it("never copies one multi-episode file's .nfo title onto every episode that shares the file", async () => {
    const folder = await insertRootFolder("series");
    const seasonDir = path.join(folder.path, "Show", "Season 01");
    const sharedFile = writeFile(seasonDir, "Show.S01E01-E02.mkv");
    writeFile(seasonDir, "Show.S01E01-E02.nfo", `<episodedetails><title>Part One</title><season>1</season><episode>1</episode></episodedetails>`);
    const singleFile = writeFile(seasonDir, "Show.S01E03.mkv");
    writeFile(seasonDir, "Show.S01E03.nfo", `<episodedetails><title>Third</title><season>1</season><episode>3</episode></episodedetails>`);
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status, external_ids) VALUES ('series','Show','show',?,1,1,'continuing',?)`)
          .run(folder.id, JSON.stringify({ tmdb: "5" }))
      ).lastInsertRowid
    );
    const insertEp = (episode: number, title: string, filePath: string) =>
      db
        .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,?,?,1,1,?)`)
        .run(showId, episode, title, filePath);
    await insertEp(1, "Ep1", sharedFile);
    await insertEp(2, "Ep2", sharedFile);
    await insertEp(3, "Ep3", singleFile);
    fetchByExternalId.mockResolvedValue({ title: "Show", overview: "O", posterUrl: null, externalIds: { tmdb: "5" } });

    const result = await refreshOneMediaItem(showId);

    expect(result.ok).toBe(true);
    const titles = (await db.prepare("SELECT title FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(titles.map((t) => t.title)).toEqual(["Ep1", "Ep2", "Third"]);
  });

  it("re-applies an edited per-episode .nfo for a sequentialEpisodeFallback type (course) too", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "Test Course");
    writeFile(courseDir, "01 - Lesson.mp4");
    writeFile(courseDir, "tvshow.nfo", `<tvshow><title>Test Course</title></tvshow>`);
    const nfoPath = writeFile(courseDir, "01 - Lesson.nfo", `<episodedetails><title>Original Lesson</title><plot>Original lesson overview.</plot></episodedetails>`);
    await scanAndImportLibrary("course");
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='course'").get()) as any;
    expect((await db.prepare("SELECT title, overview FROM episodes WHERE media_item_id = ?").get(show.id)) as any).toMatchObject({
      title: "Original Lesson",
      overview: "Original lesson overview.",
    });

    fs.writeFileSync(nfoPath, `<episodedetails><title>Refreshed Lesson</title><plot>Refreshed lesson overview.</plot></episodedetails>`);
    const result = await refreshOneMediaItem(show.id);

    expect(result.ok).toBe(true);
    const ep = (await db.prepare("SELECT title, overview FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ title: "Refreshed Lesson", overview: "Refreshed lesson overview." });
  });
});

describe("scanAndImportLibrary — local poster/backdrop artwork", () => {
  it("uses a local poster.jpg when the movie's own NFO has no <thumb> at all", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Local Poster Movie");
    writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Local Poster Movie</title></movie>`);
    writeFile(dir, "poster.jpg", "fake local poster bytes");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ created: 1 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(row.poster_url).toMatch(/^\/api\/media\/local-artwork\/[0-9a-f]+$/);
    expect(row.local_poster_path).toBe(path.join(dir, "poster.jpg"));
    expect(row.local_poster_token).toBeTruthy();
    expect(row.poster_url).toContain(row.local_poster_token);
  });

  it("does NOT let a coincidental local poster.jpg override a working remote <thumb> URL", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Remote Thumb Movie");
    writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Remote Thumb Movie</title><thumb aspect="poster">https://example.com/remote.jpg</thumb></movie>`);
    writeFile(dir, "poster.jpg", "an unrelated leftover file that happens to share the Kodi convention name");

    await scanAndImportLibrary("movie");

    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(row.poster_url).toBe("https://example.com/remote.jpg");
    expect(row.local_poster_path).toBeNull();
    expect(row.local_poster_token).toBeNull();
  });

  it("resolves a relative <thumb> value against the sidecar's own folder", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Relative Thumb Movie");
    writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Relative Thumb Movie</title><thumb aspect="poster">my-custom-art.jpg</thumb></movie>`);
    writeFile(dir, "my-custom-art.jpg", "fake bytes");

    await scanAndImportLibrary("movie");

    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(row.local_poster_path).toBe(path.join(dir, "my-custom-art.jpg"));
  });

  it("picks up both a local poster and backdrop for a new show (course), via tvshow.nfo's own folder", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "Local Art Course");
    writeFile(courseDir, "01 - Lesson.mp4");
    writeFile(courseDir, "tvshow.nfo", `<tvshow><title>Local Art Course</title></tvshow>`);
    writeFile(courseDir, "poster.jpg", "fake poster bytes");
    writeFile(courseDir, "fanart.jpg", "fake fanart bytes");

    await scanAndImportLibrary("course");

    const show = (await db.prepare("SELECT * FROM media_items WHERE type='course'").get()) as any;
    expect(show.poster_url).toMatch(/^\/api\/media\/local-artwork\/[0-9a-f]+$/);
    expect(show.backdrop_url).toMatch(/^\/api\/media\/local-artwork\/[0-9a-f]+$/);
    expect(show.local_poster_path).toBe(path.join(courseDir, "poster.jpg"));
    expect(show.local_backdrop_path).toBe(path.join(courseDir, "fanart.jpg"));
    // Two different pieces of art need two different tokens/URLs, not the same one reused.
    expect(show.poster_url).not.toBe(show.backdrop_url);
  });

  it("keeps the same local-artwork token across repeated refreshes instead of rotating it", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Stable Token Movie");
    writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Stable Token Movie</title></movie>`);
    writeFile(dir, "poster.jpg", "fake bytes");
    await scanAndImportLibrary("movie");
    const created = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    const firstToken = created.local_poster_token;
    expect(firstToken).toBeTruthy();

    await refreshOneMediaItem(created.id);
    const afterRefresh = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(created.id)) as any;
    expect(afterRefresh.local_poster_token).toBe(firstToken);
    expect(afterRefresh.poster_url).toBe(created.poster_url);
  });
});
