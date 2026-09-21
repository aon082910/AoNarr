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
  it("prefers a sidecar's own provider id over an item's existing (different) external_ids", async () => {
    const folder = await insertRootFolder("movie");
    const dir = path.join(folder.path, "Some Movie");
    const filePath = writeFile(dir, "movie.mkv");
    writeFile(dir, "movie.nfo", `<movie><title>Corrected Title</title><uniqueid type="tmdb">999</uniqueid></movie>`);
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
      if (id === "999") return { title: "Corrected Title", overview: "From the sidecar's own id.", externalIds: { tmdb: "999" } };
      throw new Error("wrong id used");
    });

    const result = await refreshOneMediaItem(movieId);

    expect(result.ok).toBe(true);
    expect(fetchByExternalId).toHaveBeenCalledWith("movie", "tmdb", "999");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movieId)) as any;
    expect(row.overview).toBe("From the sidecar's own id.");
    // The already-matched guard still applies regardless of where `best` came from — the item's
    // own title/external_ids stay exactly as they were, only overview/poster/etc. get updated.
    expect(row.title).toBe("Some Movie");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "111" });
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
