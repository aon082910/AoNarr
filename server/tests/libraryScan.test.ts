import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
let normalizeForMatch: (typeof import("../src/services/libraryScan.js"))["normalizeForMatch"];
let titlesMatch: (typeof import("../src/services/libraryScan.js"))["titlesMatch"];
let guessTitleFromText: (typeof import("../src/services/libraryScan.js"))["guessTitleFromText"];
let detectSeasonEpisode: (typeof import("../src/services/libraryScan.js"))["detectSeasonEpisode"];
let scanAndImportLibrary: (typeof import("../src/services/libraryScan.js"))["scanAndImportLibrary"];
let scanAndImportOneMediaItem: (typeof import("../src/services/libraryScan.js"))["scanAndImportOneMediaItem"];
let refreshLibraryMetadata: (typeof import("../src/services/libraryScan.js"))["refreshLibraryMetadata"];
let refreshOneMediaItem: (typeof import("../src/services/libraryScan.js"))["refreshOneMediaItem"];
let backfillEpisodicAndCollectionHasFile: (typeof import("../src/services/libraryScan.js"))["backfillEpisodicAndCollectionHasFile"];
let backfillMissingAlbumTracks: (typeof import("../src/services/libraryScan.js"))["backfillMissingAlbumTracks"];
let scanAndImportAllLibraries: (typeof import("../src/services/libraryScan.js"))["scanAndImportAllLibraries"];
let refreshAllLibraries: (typeof import("../src/services/libraryScan.js"))["refreshAllLibraries"];
let mergeEpisodesIntoItem: (typeof import("../src/services/libraryScan.js"))["mergeEpisodesIntoItem"];
let matchAdditionalProviders: (typeof import("../src/services/libraryScan.js"))["matchAdditionalProviders"];
let matchProvidersForLibrary: (typeof import("../src/services/libraryScan.js"))["matchProvidersForLibrary"];

beforeAll(async () => {
  // libraryScan.ts imports db/index.js directly.
  ({ db } = await setupTestDb());
  ({
    normalizeForMatch,
    titlesMatch,
    guessTitleFromText,
    detectSeasonEpisode,
    scanAndImportLibrary,
    scanAndImportOneMediaItem,
    refreshLibraryMetadata,
    refreshOneMediaItem,
    backfillEpisodicAndCollectionHasFile,
    backfillMissingAlbumTracks,
    scanAndImportAllLibraries,
    refreshAllLibraries,
    mergeEpisodesIntoItem,
    matchAdditionalProviders,
    matchProvidersForLibrary,
  } = await import("../src/services/libraryScan.js"));
});

let tmpRoot: string;

beforeEach(async () => {
  // Every scanAndImportLibrary/refreshLibraryMetadata call re-scans the ENTIRE table for its type,
  // so leftover rows from earlier tests would corrupt matching/dedup decisions — wipe per test.
  await db.prepare("DELETE FROM tracks").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM seasons").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();

  probeMediaInfo.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
  // Defaults to "this id lookup isn't supported/failed" so every existing already-matched-item test
  // that doesn't care about the ID-lookup path falls straight through to the searchMetadata mock,
  // same as before refreshOneItem started trying an id-based lookup first.
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchSeriesSeasonsFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-libscan-"));
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeForMatch / titlesMatch", () => {
  it("matches only on exact normalized equality, not substring containment", () => {
    // The documented regression this function exists to prevent: two different real shows/movies
    // getting collapsed into one media_items row because one title was a substring of the other.
    expect(titlesMatch("Extraction", "Extraction 2")).toBe(false);
    expect(titlesMatch("The Office", "The Office UK")).toBe(false);
  });

  it("still normalizes case/punctuation/whitespace before comparing", () => {
    expect(titlesMatch("The Matrix", "the   MATRIX!!")).toBe(true);
  });

  it("never matches when either side normalizes to an empty string", () => {
    expect(titlesMatch("...", "...")).toBe(false);
    expect(titlesMatch("", "Anything")).toBe(false);
  });
});

describe("guessTitleFromText", () => {
  it("cuts at a season/episode marker", () => {
    expect(guessTitleFromText("Breaking.Bad.S01E01.1080p")).toBe("Breaking Bad");
  });

  it("cuts at a year", () => {
    expect(guessTitleFromText("45 Years (2015) 1080p BluRay")).toBe("45 Years");
  });

  it("cuts at a codec/audio/proper marker even with no year or season present", () => {
    expect(guessTitleFromText("Some Great Movie x264 AAC")).toBe("Some Great Movie");
  });

  it("strips a trailing external-id marker", () => {
    expect(guessTitleFromText("Some Movie imdb-tt1234567")).toBe("Some Movie");
  });

  it("returns the whole string, cleaned up, when nothing matches any cut pattern", () => {
    expect(guessTitleFromText("Just_A.Plain-Title")).toBe("Just A Plain-Title");
  });
});

describe("detectSeasonEpisode", () => {
  it("reads season/episode straight from an S01E01-style filename", () => {
    expect(detectSeasonEpisode("Show", "Show.S02E05.1080p")).toEqual({ season: 2, episode: 5 });
  });

  it("reads the 1x05 format", () => {
    expect(detectSeasonEpisode("Show", "Show.1x05")).toEqual({ season: 1, episode: 5 });
  });

  it("falls back to a 'Season NN' parent folder plus a bare E-marker filename", () => {
    expect(detectSeasonEpisode("Season 02", "E03")).toEqual({ season: 2, episode: 3 });
  });

  it("accepts a compact 'SNN' folder name too", () => {
    expect(detectSeasonEpisode("S03", "E07")).toEqual({ season: 3, episode: 7 });
  });

  it("returns nulls when no season/episode can be determined at all", () => {
    expect(detectSeasonEpisode("Random Folder", "randomfile")).toEqual({ season: null, episode: null });
  });
});

// ---------------------------------------------------------------------------
// scanAndImportLibrary — movie (single shape)
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — movie (single shape)", () => {
  it("creates a new movie for an unmatched file", async () => {
    const folder = await insertRootFolder("movie");
    const filePath = writeFile(folder.path, "Some Movie (2020) 1080p.mkv");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ matched: 0, created: 1, skipped: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(row).toMatchObject({ title: "Some Movie", year: 2020, has_file: 1, path: filePath });
  });

  it("matches an existing has_file=0 movie by exact title, filling in its path", async () => {
    const folder = await insertRootFolder("movie");
    const existingId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Dune','dune',1,0,'missing')`)
          .run()
      ).lastInsertRowid
    );
    const filePath = writeFile(folder.path, "Dune.2021.1080p.mkv");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ matched: 1, created: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(existingId)) as any;
    expect(row).toMatchObject({ has_file: 1, path: filePath });
  });

  it("does not duplicate or overwrite an already-downloaded movie when a second file guesses the same title", async () => {
    const folder = await insertRootFolder("movie");
    const originalPath = writeFile(folder.path, "Dune.2021.1080p.mkv");
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, status) VALUES ('movie','Dune','dune',1,1,?,'downloaded')`)
      .run(originalPath);
    writeFile(folder.path, "Dune.2021.EXTRA.SAMPLE.mkv");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ matched: 0, created: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    const rows = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").all()) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(originalPath);
  });

  it("stores probed media info alongside a new movie", async () => {
    const folder = await insertRootFolder("movie");
    probeMediaInfo.mockResolvedValue({ videoCodec: "h264", width: 1920, height: 1080 });
    writeFile(folder.path, "Probed Movie (2022).mkv");

    await scanAndImportLibrary("movie");

    const row = (await db.prepare("SELECT * FROM media_items WHERE type='movie'").get()) as any;
    expect(JSON.parse(row.media_info)).toEqual({ videoCodec: "h264", width: 1920, height: 1080 });
  });
});

// ---------------------------------------------------------------------------
// scanAndImportLibrary — series (episodic shape)
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — series (episodic shape)", () => {
  it("creates a new series with best-effort metadata enrichment, its first episode, and rolls up has_file", async () => {
    const folder = await insertRootFolder("series");
    const filePath = writeFile(path.join(folder.path, "Breaking Bad", "Season 01"), "Breaking.Bad.S01E01.1080p.mkv");
    searchMetadata.mockResolvedValue([
      { title: "Breaking Bad", year: 2008, overview: "A teacher turns to crime.", posterUrl: "https://p/bb.jpg", externalIds: { tmdb: "1396" } },
    ]);

    const result = await scanAndImportLibrary("series");

    expect(result).toMatchObject({ matched: 1, created: 0 });
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show).toMatchObject({ title: "Breaking Bad", overview: "A teacher turns to crime.", year: 2008, has_file: 1 });
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ season_number: 1, episode_number: 1, has_file: 1, file_path: filePath });
  });

  it("matches an existing series by exact title instead of creating a duplicate", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Fringe','fringe',1,0,'missing')`).run())
        .lastInsertRowid
    );
    writeFile(path.join(folder.path, "Fringe", "Season 01"), "Fringe.S01E01.mkv");

    await scanAndImportLibrary("series");

    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='series'").all()) as any[];
    expect(shows).toHaveLength(1);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toBeTruthy();
  });

  it("falls back to a Season-folder + bare-E-marker filename when the file itself has no season/episode", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "Some Show", "Season 02"), "E03.mkv");

    const result = await scanAndImportLibrary("series");

    expect(result.matched).toBe(1);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show.title).toBe("Some Show");
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ season_number: 2, episode_number: 3 });
  });

  it("skips a file with no detectable season/episode at all", async () => {
    const folder = await insertRootFolder("series");
    writeFile(folder.path, "randomfile.mkv");

    const result = await scanAndImportLibrary("series");

    expect(result).toMatchObject({ matched: 0, created: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("couldn't detect a season/episode number");
  });

  it("does not overwrite an existing episode that already has a different file", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    const originalPath = writeFile(path.join(folder.path, "Show", "Season 01"), "original.mkv");
    // Rename would leave the DB row's own file_path unaffected — insert the episode with a made-up
    // original path, then scan a genuinely different second file that parses to the same S/E.
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,?,?,?,1,1,?)`)
      .run(showId, 1, 1, "Pilot", originalPath);
    writeFile(path.join(folder.path, "Show", "Season 01"), "Show.S01E01.EXTRA.mkv");

    const result = await scanAndImportLibrary("series");

    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep.file_path).toBe(originalPath);
  });

  it("updates a monitored-but-missing episode when its file is found", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Pilot',1,0)`)
      .run(showId);
    const filePath = writeFile(path.join(folder.path, "Show", "Season 01"), "Show.S01E01.mkv");

    await scanAndImportLibrary("series");

    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toMatchObject({ has_file: 1, file_path: filePath });
    const show = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(show.has_file).toBe(1); // rolled up even though the show pre-existed
  });

  it("rolls up a pre-existing series' has_file even on a run that finds no new files at all", async () => {
    await insertRootFolder("series"); // present, but left empty
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Old Scan Bug','old scan bug',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1,'Pilot',1,1,'/already/on/disk.mkv')`)
      .run(showId);

    await scanAndImportLibrary("series");

    const show = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(show.has_file).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanAndImportLibrary — collection, single-file-per-child (book)
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — collection, single-file-per-child (author/book)", () => {
  it("creates a new author and book", async () => {
    const folder = await insertRootFolder("author");
    const filePath = writeFile(path.join(folder.path, "Some Author"), "Some Book.epub");

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, created: 0 });
    const author = (await db.prepare("SELECT * FROM media_items WHERE type='author'").get()) as any;
    expect(author.title).toBe("Some Author");
    expect(author.has_file).toBe(1); // rolled up from the child
    const book = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(author.id)) as any;
    expect(book).toMatchObject({ title: "Some Book", has_file: 1, file_path: filePath });
  });

  it("skips a file that sits directly in the root with no parent (author) folder", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "Orphan Book.epub");

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 0, created: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("no parent");
  });

  it("does not overwrite an existing book that already has a different file", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author','Author','author',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    const originalPath = "/already/tracked/Book.epub";
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Book', 1, 1, ?)`).run(authorId, originalPath);
    writeFile(path.join(folder.path, "Author"), "Book.epub"); // different physical file, same guessed title

    const result = await scanAndImportLibrary("author");

    expect(result.skipped).toBe(1);
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(authorId)) as any;
    expect(sub.file_path).toBe(originalPath);
  });
});

// ---------------------------------------------------------------------------
// scanAndImportLibrary — collection, multi-file-per-child (audiobook)
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — collection, multi-file-per-child (audiobook)", () => {
  it("creates a new author/album and inserts one track row per file", async () => {
    const folder = await insertRootFolder("audiobook");
    const albumDir = path.join(folder.path, "Some Author", "Some Book");
    writeFile(albumDir, "01 - Chapter One.mp3");
    writeFile(albumDir, "02 - Chapter Two.mp3");

    const result = await scanAndImportLibrary("audiobook");

    expect(result.matched).toBeGreaterThanOrEqual(1);
    const author = (await db.prepare("SELECT * FROM media_items WHERE type='audiobook'").get()) as any;
    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(author.id)) as any;
    expect(album).toMatchObject({ title: "Some Book", has_file: 1, file_path: albumDir });
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(album.id)) as any[];
    expect(tracks.map((t) => t.track_number)).toEqual([1, 2]);
    expect(tracks.map((t) => t.title)).toEqual(["Chapter One", "Chapter Two"]);
  });

  it("treats a flat Artist/track.mp3 layout (no album subfolder) as a single self-titled album", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(path.join(folder.path, "Solo Author"), "01 - Only Chapter.mp3");

    await scanAndImportLibrary("audiobook");

    const author = (await db.prepare("SELECT * FROM media_items WHERE type='audiobook'").get()) as any;
    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(author.id)) as any;
    expect(album.title).toBe("Solo Author");
  });

  it("keeps a multi-disc album's two 'CD1/CD2' subfolders as one album, pointed at the shared album directory", async () => {
    const folder = await insertRootFolder("audiobook");
    const authorDir = path.join(folder.path, "Author");
    const albumDir = path.join(authorDir, "Big Book [2CD]");
    writeFile(path.join(albumDir, "CD1"), "01 - Part One.mp3");
    writeFile(path.join(albumDir, "CD2"), "01 - Part Two.mp3"); // same leading number as CD1's track

    await scanAndImportLibrary("audiobook");

    const author = (await db.prepare("SELECT * FROM media_items WHERE type='audiobook'").get()) as any;
    const albums = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(author.id)) as any[];
    expect(albums).toHaveLength(1); // both discs belong to the same album, not two
    expect(albums[0].file_path).toBe(albumDir); // points at the album dir, not either disc subfolder
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albums[0].id)) as any[];
    expect(tracks.map((t) => t.track_number)).toEqual([1, 2]); // CD2's "01" continues the sequence, doesn't collide
  });
});

// ---------------------------------------------------------------------------
// onlyTitle / onlySeasonNumber / onlyMediaItemId scoping
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — per-item scoping", () => {
  it("onlyTitle silently ignores non-matching files without touching the database", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Unrelated Movie (2020).mkv");

    const result = await scanAndImportLibrary("movie", undefined, "Some Other Title");

    expect(result).toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [] });
    expect(await db.prepare("SELECT * FROM media_items").get()).toBeUndefined();
  });

  it("onlyMediaItemId attaches a file to the known target even when the strict title match would miss it", async () => {
    // The documented "The Office" vs "The Office (US)" scenario: a real metadata title doesn't
    // exactly match a filename-guessed one, but a per-item scan already knows its target by id.
    const folder = await insertRootFolder("series");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','The Office (US)','the office (us)',1,0,'missing')`)
          .run()
      ).lastInsertRowid
    );
    writeFile(path.join(folder.path, "The Office", "Season 01"), "The.Office.S01E01.mkv");

    const result = await scanAndImportLibrary("series", undefined, "The Office", undefined, showId);

    expect(result.matched).toBe(1);
    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='series'").all()) as any[];
    expect(shows).toHaveLength(1); // attached to the existing show, no "The Office" twin created
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toBeTruthy();
  });

  it("onlySeasonNumber skips files from other seasons", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "Show", "Season 01"), "Show.S01E01.mkv");
    writeFile(path.join(folder.path, "Show", "Season 02"), "Show.S02E01.mkv");

    const result = await scanAndImportLibrary("series", undefined, "Show", 2);

    expect(result.matched).toBe(1);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(show.id)) as any[];
    expect(episodes).toHaveLength(1);
    expect(episodes[0].season_number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Overlap guard, abort, per-file error resilience
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — concurrency and resilience", () => {
  it("skips a second overlapping whole-library scan of the same type instead of racing it", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Movie One (2020).mkv");

    const p1 = scanAndImportLibrary("movie");
    const p2 = scanAndImportLibrary("movie");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r2).toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [], alreadyRunning: true });
    expect(r1.alreadyRunning).toBeUndefined();
  });

  it("allows a scoped per-item scan (onlyTitle) to run even while a whole-library scan of the same type is in progress", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Movie One (2020).mkv");
    writeFile(folder.path, "Movie Two (2021).mkv");

    const wholeLibraryScan = scanAndImportLibrary("movie");
    const scoped = await scanAndImportLibrary("movie", undefined, "Movie Two");
    await wholeLibraryScan;

    expect(scoped.alreadyRunning).toBeUndefined();
  });

  it("stops processing further files once the AbortSignal fires mid-scan", async () => {
    // fs.readdirSync's ordering isn't a portable guarantee, so this deliberately doesn't assume
    // which of the two files gets processed first — only that exactly one does, then the loop's
    // own abort check (at the top of the next iteration) stops it before the second.
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "First Movie (2020).mkv");
    writeFile(folder.path, "Second Movie (2021).mkv");
    const controller = new AbortController();
    probeMediaInfo.mockImplementation(async () => {
      controller.abort();
      return null;
    });

    const result = await scanAndImportLibrary("movie", controller.signal);

    expect(result.created).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) as c FROM media_items").get()).toEqual({ c: 1 });
  });

  it("logs and skips one file that throws mid-import, without aborting the rest of the scan", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Bad Movie (2020).mkv");
    writeFile(folder.path, "Good Movie (2021).mkv");
    probeMediaInfo.mockImplementation(async (filePath: string) => {
      if (filePath.includes("Bad Movie")) throw new Error("probe exploded");
      return null;
    });

    const result = await scanAndImportLibrary("movie");

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0]).toMatchObject({ reason: "probe exploded" });
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Good Movie'").get()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// refreshLibraryMetadata / refreshOneItem / refreshOneMediaItem
// ---------------------------------------------------------------------------

describe("refreshLibraryMetadata / refreshOneMediaItem", () => {
  it("overwrites title/external_ids only for an item that was never actually matched (no external ids yet)", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','guessed title','guessed title',1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Real Title", year: 2020, overview: "O", posterUrl: "P", externalIds: { tmdb: "1" } }]);

    const result = await refreshOneMediaItem(id);

    expect(result.ok).toBe(true);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.title).toBe("Real Title");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "1" });
  });

  it("never overwrites the title of an item that's already matched (has external ids)", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('movie','Already Matched','already matched',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "99" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Fuzzy Different Match", year: 2020, overview: "New overview", posterUrl: null, externalIds: { tmdb: "999" } }]);

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.title).toBe("Already Matched"); // untouched
    expect(row.overview).toBe("New overview"); // overview/poster/year still refresh regardless
  });

  it("regression: an already-matched item is looked up by its own id, not by a fresh title search that could drift to a different result", async () => {
    // This is the exact bug: fix a wrong match via Different Match (sets a real external id), then
    // hit Refresh — a plain title search for the (now correct) title could still rank a different,
    // unrelated show first (a shared title, a regional version, a reboot), silently putting the
    // WRONG show's overview/poster/backdrop/rating right back even though the title text itself
    // never changes. Looking the item up by its own id instead removes that ambiguity entirely.
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('movie','Correct Show','correct show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "555" }))
      ).lastInsertRowid
    );
    fetchByExternalId.mockResolvedValue({ title: "Correct Show", year: 2020, overview: "The correct overview", posterUrl: "correct.jpg", externalIds: { tmdb: "555" } });
    // A title search would return an entirely different, wrong show — proving it's never consulted.
    searchMetadata.mockResolvedValue([{ title: "Correct Show", year: 1999, overview: "The WRONG show's overview", posterUrl: "wrong.jpg", externalIds: { tmdb: "1" } }]);

    const result = await refreshOneMediaItem(id);

    expect(result.ok).toBe(true);
    expect(fetchByExternalId).toHaveBeenCalledWith("movie", "tmdb", "555");
    expect(searchMetadata).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.overview).toBe("The correct overview");
    expect(row.poster_url).toBe("correct.jpg");
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "555" }); // still untouched, as always
  });

  it("falls back to a title search when the item's id isn't one fetchByExternalId can look up", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Tvmaze Only Show','tvmaze only show',1,0,?,'missing')`)
          .run(JSON.stringify({ tvmaze: "42" }))
      ).lastInsertRowid
    );
    // fetchByExternalId has no tvmaze branch — the default mock rejection simulates that.
    searchMetadata.mockResolvedValue([{ title: "Tvmaze Only Show", year: 2021, overview: "From title search", posterUrl: null, externalIds: { tvmaze: "42" } }]);

    const result = await refreshOneMediaItem(id);

    expect(result.ok).toBe(true);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.overview).toBe("From title search");
  });

  it("returns ok:false without changing anything when the metadata search finds no match", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Obscure','obscure',1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([]);

    const result = await refreshOneMediaItem(id);

    expect(result).toEqual({ ok: false, childrenAdded: 0 });
  });

  it("backfills missing episodes for a series via syncMissingChildren", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`)
          .run()
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Show", year: 2020, overview: "O", posterUrl: null, externalIds: { tmdb: "5" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([{ seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2020-01-01", overview: "First" }]);

    const result = await refreshOneMediaItem(showId);

    expect(result.childrenAdded).toBe(1);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(showId)) as any;
    expect(ep).toMatchObject({ title: "Pilot", air_date: "2020-01-01" });
  });

  it("replaces a placeholder episode title once real metadata is available, but leaves a real title alone", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    const placeholderEpId = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Episode 1',1)`).run(showId)).lastInsertRowid
    );
    const realTitledEpId = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,2,'A Real Title Already',1)`).run(showId))
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Show", year: 2020, overview: "O", posterUrl: null, externalIds: { tmdb: "5" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "The Real Pilot Title", airDate: "2020-01-01", overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: "Provider Thinks This", airDate: "2020-01-08", overview: null },
    ]);

    await refreshOneMediaItem(showId);

    const placeholder = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(placeholderEpId)) as any;
    expect(placeholder.title).toBe("The Real Pilot Title");
    const realTitled = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(realTitledEpId)) as any;
    expect(realTitled.title).toBe("A Real Title Already"); // not overwritten — it wasn't a placeholder
  });

  it("fetches and stores a movie's studio via the by-id detail lookup", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','A Movie','a movie',1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Movie", year: 2020, overview: "O", posterUrl: null, externalIds: { tmdb: "42" } }]);
    fetchMovieByTmdbId.mockResolvedValue({ studio: "A Great Studio" });

    await refreshOneMediaItem(id);

    expect(fetchMovieByTmdbId).toHaveBeenCalledWith("42");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.studio).toBe("A Great Studio");
  });

  it("respects onlySeasonNumber by leaving the show's own overview/title untouched", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, overview, status) VALUES ('series','Guessed Title','guessed title',1,0,'old overview','missing')`)
          .run()
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Real Title", year: 2020, overview: "new overview", posterUrl: null, externalIds: { tmdb: "5" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([{ seasonNumber: 2, episodeNumber: 1, title: "S2E1", airDate: null, overview: null }]);

    await refreshOneMediaItem(showId, 2);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.title).toBe("Guessed Title");
    expect(row.overview).toBe("old overview");
  });

  it("refreshLibraryMetadata processes every item of a type and tallies updated/failed", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Will Match','will match',1,0,'missing')`).run();
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Will Fail','will fail',1,0,'missing')`).run();
    searchMetadata.mockImplementation(async (_type: string, title: string) =>
      title === "Will Match" ? [{ title, year: 2020, overview: "O", posterUrl: null, externalIds: { tmdb: "1" } }] : []
    );

    const result = await refreshLibraryMetadata("movie");

    expect(result).toEqual({ updated: 1, failed: 1, childrenAdded: 0 });
  });

  it("stops early once the AbortSignal fires between items", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','First','first',1,0,'missing')`).run();
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Second','second',1,0,'missing')`).run();
    const controller = new AbortController();
    searchMetadata.mockImplementation(async () => {
      controller.abort();
      return [];
    });

    const result = await refreshLibraryMetadata("movie", controller.signal);

    expect(result.failed + result.updated).toBe(1); // only the first item was ever attempted
  });
});

// ---------------------------------------------------------------------------
// scanAndImportOneMediaItem
// ---------------------------------------------------------------------------

describe("scanAndImportOneMediaItem", () => {
  it("scopes the scan to just the named item's own title", async () => {
    const folder = await insertRootFolder("movie");
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Target Movie','target movie',1,0,'missing')`).run())
        .lastInsertRowid
    );
    writeFile(folder.path, "Target Movie (2020).mkv");
    writeFile(folder.path, "Unrelated Movie (2021).mkv");

    const result = await scanAndImportOneMediaItem(id);

    expect(result.matched).toBe(1);
    expect(await db.prepare("SELECT * FROM media_items WHERE title = 'Unrelated Movie'").get()).toBeUndefined();
  });

  it("returns an empty result for an id that doesn't exist", async () => {
    await expect(scanAndImportOneMediaItem(999999)).resolves.toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [] });
  });
});

// ---------------------------------------------------------------------------
// Startup data-fix backfills
// ---------------------------------------------------------------------------

describe("backfillEpisodicAndCollectionHasFile", () => {
  it("flips has_file on a series whose episodes all have files but whose own flag was never set", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Old Bug','old bug',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1,'Pilot',1,1,'/x.mkv')`)
      .run(showId);

    await backfillEpisodicAndCollectionHasFile();

    const show = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(show.has_file).toBe(1);
  });

  it("is a no-op (doesn't throw) when nothing needs fixing", async () => {
    await expect(backfillEpisodicAndCollectionHasFile()).resolves.toBeUndefined();
  });
});

describe("backfillMissingAlbumTracks", () => {
  it("backfills track rows for an album that has a file_path but zero tracked tracks", async () => {
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('audiobook','Author','author',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    const albumDir = path.join(tmpRoot, "album-backfill");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "01 - Chapter One.mp3"), "x");
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)").run(authorId, albumDir))
        .lastInsertRowid
    );

    await backfillMissingAlbumTracks();

    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(albumId)) as any[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Chapter One");
  });

  it("skips an album whose folder no longer exists on disk, without throwing", async () => {
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('audiobook','Author2','author2',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    await db
      .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Gone Album', 1, 1, ?)")
      .run(authorId, path.join(tmpRoot, "does-not-exist"));

    await expect(backfillMissingAlbumTracks()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Whole-catalog wrappers
// ---------------------------------------------------------------------------

describe("scanAndImportAllLibraries / refreshAllLibraries", () => {
  it("scanAndImportAllLibraries stops once the AbortSignal is already set", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Should Not Be Scanned (2020).mkv");
    const controller = new AbortController();
    controller.abort();

    await scanAndImportAllLibraries(controller.signal);

    expect(await db.prepare("SELECT * FROM media_items").get()).toBeUndefined();
  });

  it("refreshAllLibraries stops once the AbortSignal is already set", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','X','x',1,0,'missing')`).run();
    const controller = new AbortController();
    controller.abort();

    await refreshAllLibraries(controller.signal);

    expect(searchMetadata).not.toHaveBeenCalled();
  });
});

describe("mergeEpisodesIntoItem", () => {
  it("inserts a missing episode and backfills a placeholder title, without touching a real one", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Merge Ep Show','merge ep show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Episode 1',1)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,2,'Real Title',1)`).run(showId);

    const added = await mergeEpisodesIntoItem(showId, [
      { seasonNumber: 1, episodeNumber: 1, title: "Real Pilot", airDate: "2020-01-01", overview: null }, // placeholder title -> patched
      { seasonNumber: 1, episodeNumber: 2, title: "Provider Guess", airDate: "2020-01-08", overview: null }, // real title -> untouched
      { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2020-01-15", overview: null }, // not tracked yet -> inserted
    ]);

    expect(added).toBe(1);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(showId)) as any[];
    expect(episodes).toHaveLength(3);
    expect(episodes.find((e) => e.season_number === 0)).toMatchObject({ title: "Special" });
    expect(episodes.find((e) => e.season_number === 1 && e.episode_number === 1).title).toBe("Real Pilot");
    expect(episodes.find((e) => e.season_number === 1 && e.episode_number === 2).title).toBe("Real Title");
  });

  it("returns 0 without querying anything for an empty episode list", async () => {
    expect(await mergeEpisodesIntoItem(999999, [])).toBe(0);
  });
});

describe("matchAdditionalProviders", () => {
  it("searches every other configured provider, merges ids/extra_metadata, and merges in that provider's missing episodes", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Multi Provider Show','multi provider show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );

    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) =>
      provider === "tvdb" ? [{ title: "Multi Provider Show", year: 2020, overview: "O", posterUrl: null, externalIds: { tvdb: "42" } }] : []
    );
    fetchSeriesEpisodesForProvider.mockImplementation(async (provider: string) =>
      provider === "tvdb" ? [{ seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: null }] : []
    );

    const results = await matchAdditionalProviders(showId);

    expect(results).toEqual([{ provider: "tvdb", episodesAdded: 1 }]);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "1", tvdb: "42" });
    expect(JSON.parse(row.extra_metadata).tvdb).toMatchObject({ title: "Multi Provider Show" });
    const specialEp = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = 0").get(showId)) as any;
    expect(specialEp).toMatchObject({ title: "Special" });
  });

  it("never overwrites an id the item already has, and never even searches a provider whose id is already present", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Already Matched Show','already matched show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1", tvdb: "9" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "X", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "999", trakt: "5" } }]);
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    await matchAdditionalProviders(showId);

    expect(searchMetadata).not.toHaveBeenCalledWith("series", expect.anything(), "tmdb");
    expect(searchMetadata).not.toHaveBeenCalledWith("series", expect.anything(), "tvdb");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids).tvdb).toBe("9"); // not clobbered by trakt's own search result also reporting a tvdb id
  });

  it("continues past a provider whose search throws, still recording the ones that succeeded", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Resilient Show','resilient show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) => {
      if (provider === "tvdb") throw new Error("network down");
      if (provider === "tvmaze") return [{ title: "Resilient Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvmaze: "7" } }];
      return [];
    });
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const results = await matchAdditionalProviders(showId);

    expect(results.map((r) => r.provider)).toContain("tvmaze");
    expect(results.map((r) => r.provider)).not.toContain("tvdb");
  });

  it("returns [] immediately once every configured provider is already represented in external_ids", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('comic','Fully Matched Comic','fully matched comic',1,0,?,'missing')`)
          .run(JSON.stringify({ comicvine: "1" }))
      ).lastInsertRowid
    );
    expect(await matchAdditionalProviders(id)).toEqual([]);
    expect(searchMetadata).not.toHaveBeenCalled();
  });
});

describe("matchProvidersForLibrary", () => {
  it("runs matchAdditionalProviders across every item of a type and totals the results", async () => {
    await db.prepare(`DELETE FROM media_items WHERE type = 'anime'`).run();
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Anime One','anime one',1,0,?,'missing')`)
      .run(JSON.stringify({ anilist: "1" }));
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Anime Two','anime two',1,0,?,'missing')`)
      .run(JSON.stringify({ anilist: "2" }));
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) =>
      provider === "tvdb" ? [{ title: "X", year: null, overview: null, posterUrl: null, externalIds: { tvdb: "1" } }] : []
    );
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const result = await matchProvidersForLibrary("anime");

    expect(result).toEqual({ itemsMatched: 2, providersMatched: 2 });
  });
});
