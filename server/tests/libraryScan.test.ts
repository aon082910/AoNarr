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
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    isEpisodeMonitoredByDefault: actual.isEpisodeMonitoredByDefault,
    upcomingEpisodes: actual.upcomingEpisodes,
    proxyScreenscraperArtwork: actual.proxyScreenscraperArtwork,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
    fetchSeriesSeasonsFor: (...args: unknown[]) => fetchSeriesSeasonsFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let normalizeForMatch: (typeof import("../src/services/libraryScan.js"))["normalizeForMatch"];
let titlesMatch: (typeof import("../src/services/libraryScan.js"))["titlesMatch"];
let guessTitleFromText: (typeof import("../src/services/libraryScan.js"))["guessTitleFromText"];
let cleanRomTitle: (typeof import("../src/services/libraryScan.js"))["cleanRomTitle"];
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
let childListProviderIds: (typeof import("../src/services/libraryScan.js"))["childListProviderIds"];
let pickVerifiedProviderHit: (typeof import("../src/services/libraryScan.js"))["pickVerifiedProviderHit"];
let convertLibraryToEpisodic: (typeof import("../src/services/libraryScan.js"))["convertLibraryToEpisodic"];

beforeAll(async () => {
  // libraryScan.ts imports db/index.js directly.
  ({ db } = await setupTestDb());
  ({
    normalizeForMatch,
    titlesMatch,
    guessTitleFromText,
    cleanRomTitle,
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
    childListProviderIds,
    pickVerifiedProviderHit,
    convertLibraryToEpisodic,
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
  fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);
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

  it("keeps letters of every script and folds accents", () => {
    expect(titlesMatch("Лев Толстой", "лев  толстой")).toBe(true);
    expect(titlesMatch("Лев Толстой", "Фёдор Достоевский")).toBe(false);
    expect(titlesMatch("進撃の巨人", "進撃の巨人")).toBe(true);
    expect(titlesMatch("進撃の巨人", "鬼滅の刃")).toBe(false);
    expect(titlesMatch("Émile Zola", "Emile Zola")).toBe(true);
    expect(titlesMatch("Pokémon", "Pokemon")).toBe(true);
    expect(normalizeForMatch("Amélie (2001)")).toBe("amelie 2001");
    expect(titlesMatch("Ἀθῆναι", "Αθηναι")).toBe(true); // Greek accents fold like Latin ones
  });

  it("keeps the match keys titles had before other scripts were kept: symbols, fractions and superscripts drop out", () => {
    // Every pair matched under the old ASCII-only key; a compatibility decomposition ("™" -> "tm",
    // "½" -> "1 2") split each into two items.
    for (const [a, b] of [
      ["Tetris™", "Tetris"],
      ["Ranma ½", "Ranma"],
      ["E=mc²", "E=mc"],
      ["Love♥Live!", "Love Live"],
      ["Fate/stay night", "Fate stay night"],
      ["Marvel®'s Agents of S.H.I.E.L.D.", "Marvel s Agents of S H I E L D"],
      // An ASCII name with a native-script alias still matches its ASCII-only form.
      ["BTS (방탄소년단)", "BTS"],
      ["Shingeki no Kyojin 進撃の巨人", "Shingeki no Kyojin"],
      ["2046 (花樣年華)", "2046"],
    ]) {
      expect(titlesMatch(a, b), `${a} / ${b}`).toBe(true);
    }
    expect(normalizeForMatch("Tetris™")).toBe("tetris");
    expect(normalizeForMatch("Ranma ½")).toBe("ranma");
  });

  it("keeps the marks that make a different letter/word outside Latin and Greek", () => {
    expect(titlesMatch("がき", "かき")).toBe(false); // Japanese dakuten
    expect(titlesMatch("कल", "काल")).toBe(false); // Devanagari vowel sign
    expect(titlesMatch("ไก่", "ไก")).toBe(false); // Thai tone mark
    expect(titlesMatch("мой", "мои")).toBe(false); // Cyrillic й is its own letter
    // Different titles that only share a sequel/volume number.
    expect(titlesMatch("신과함께 2", "범죄도시 2")).toBe(false);
    expect(titlesMatch("Война и мир. Том 1", "Анна Каренина. Том 1")).toBe(false);
    expect(titlesMatch("がき", "がき")).toBe(true);
    expect(titlesMatch("काल", "काल")).toBe(true);
    expect(normalizeForMatch("काल")).toBe("काल");
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

describe("cleanRomTitle", () => {
  it("strips a region tag", () => {
    expect(cleanRomTitle("Super Mario World (USA)")).toBe("Super Mario World");
  });

  it("strips a multi-region list", () => {
    expect(cleanRomTitle("Sonic the Hedgehog (USA, Europe)")).toBe("Sonic the Hedgehog");
  });

  it("strips the older GoodTools single-letter region convention, but not a real parenthetical word mid-title", () => {
    expect(cleanRomTitle("Chrono Trigger (U)")).toBe("Chrono Trigger");
  });

  it("strips a revision tag", () => {
    expect(cleanRomTitle("Super Mario World (USA) (Rev 1)")).toBe("Super Mario World");
  });

  it("strips a language-code list", () => {
    expect(cleanRomTitle("Some Game (En,Fr,De)")).toBe("Some Game");
  });

  it("strips a verified-good-dump bracket tag", () => {
    expect(cleanRomTitle("Some Game [!]")).toBe("Some Game");
  });

  it("strips a translation-patch bracket tag", () => {
    expect(cleanRomTitle("Some Game [T+Eng100%]")).toBe("Some Game");
  });

  it("returns the whole string, cleaned up, when nothing matches any ROM-specific marker", () => {
    expect(cleanRomTitle("Just_A.Plain-Title")).toBe("Just A Plain-Title");
  });
});

describe("detectSeasonEpisode", () => {
  it("reads season/episode straight from an S01E01-style filename", () => {
    expect(detectSeasonEpisode("Show", "Show.S02E05.1080p")).toEqual({ season: 2, episodes: [5] });
  });

  it("reads the 1x05 format", () => {
    expect(detectSeasonEpisode("Show", "Show.1x05")).toEqual({ season: 1, episodes: [5] });
  });

  it("falls back to a 'Season NN' parent folder plus a bare E-marker filename", () => {
    expect(detectSeasonEpisode("Season 02", "E03")).toEqual({ season: 2, episodes: [3] });
  });

  it("accepts a compact 'SNN' folder name too", () => {
    expect(detectSeasonEpisode("S03", "E07")).toEqual({ season: 3, episodes: [7] });
  });

  it("reads a 'Specials' folder as Season 0", () => {
    expect(detectSeasonEpisode("Specials", "E03")).toEqual({ season: 0, episodes: [3] });
    expect(detectSeasonEpisode("specials", "E01")).toEqual({ season: 0, episodes: [1] });
  });

  it("returns nulls/empty when no season/episode can be determined at all", () => {
    expect(detectSeasonEpisode("Random Folder", "randomfile")).toEqual({ season: null, episodes: [] });
  });

  it("expands a Sonarr-style multi-episode range from the filename (S01E01-E02)", () => {
    expect(detectSeasonEpisode("Show", "Show.S01E01-E02.1080p")).toEqual({ season: 1, episodes: [1, 2] });
  });

  it("expands a chained multi-episode filename (S01E01E02E03)", () => {
    expect(detectSeasonEpisode("Show", "Show.S01E01E02E03.1080p")).toEqual({ season: 1, episodes: [1, 2, 3] });
  });

  it("expands a multi-episode range in a bare season-folder filename (E01-E02)", () => {
    expect(detectSeasonEpisode("Season 01", "E01-E02")).toEqual({ season: 1, episodes: [1, 2] });
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

  it("attaches a file to the same-titled movie whose year matches when several share the title (a remake)", async () => {
    const folder = await insertRootFolder("movie");
    const it1990 = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie','It','it',1990,1,0,'missing')`).run())
        .lastInsertRowid
    );
    const it2017 = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie','It','it',2017,1,0,'missing')`).run())
        .lastInsertRowid
    );
    const filePath = writeFile(folder.path, "It.2017.1080p.mkv");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ matched: 1, created: 0 });
    expect((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(it2017)) as any).toMatchObject({ has_file: 1, path: filePath });
    expect((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(it1990)) as any).toMatchObject({ has_file: 0, path: null });
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

  it("never searches with a daily show's air-date year, and enriches from the hit whose title agrees rather than the first", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "The Daily Show", "Season 28"), "The.Daily.Show.S28E50.2023.05.01.1080p.mkv");
    searchMetadata.mockResolvedValue([
      { title: "The Daily Show Spinoff", year: 2023, overview: "Wrong show", posterUrl: null, externalIds: { tmdb: "999" } },
      { title: "The Daily Show", year: 1996, overview: "Right show", posterUrl: null, externalIds: { tmdb: "2224" } },
    ]);

    await scanAndImportLibrary("series");

    expect(searchMetadata).toHaveBeenCalledWith("series", "The Daily Show", undefined, null);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show).toMatchObject({ title: "The Daily Show", overview: "Right show", year: 1996 });
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tmdb: "2224" });
  });

  it("creates a new show without enrichment when no search hit's title and year agree with the file", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "Doctor Who", "Season 01"), "Doctor.Who.2005.S01E01.mkv");
    searchMetadata.mockResolvedValue([
      { title: "Doctor Who", year: 1963, overview: "The classic series", posterUrl: null, externalIds: { tmdb: "121" } },
      { title: "Doctor Who Confidential", year: 2005, overview: "A spin-off", posterUrl: null, externalIds: { tmdb: "5" } },
    ]);

    const result = await scanAndImportLibrary("series");

    expect(result.matched).toBe(1);
    expect(searchMetadata).toHaveBeenCalledWith("series", "Doctor Who", undefined, 2005);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show).toMatchObject({ title: "Doctor Who", overview: null, year: null });
    expect(fetchSeriesEpisodesFor).not.toHaveBeenCalled();
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ season_number: 1, episode_number: 1, has_file: 1 });
  });

  it("enriches from a hit whose title only differs by the punctuation a scene filename drops", async () => {
    const folder = await insertRootFolder("series");
    writeFile(path.join(folder.path, "Greys Anatomy", "Season 01"), "Greys.Anatomy.S01E01.1080p.mkv");
    searchMetadata.mockResolvedValue([{ title: "Grey's Anatomy", year: 2005, overview: "Surgeons.", posterUrl: null, externalIds: { tmdb: "1416" } }]);

    await scanAndImportLibrary("series");

    const show = (await db.prepare("SELECT * FROM media_items WHERE type='series'").get()) as any;
    expect(show).toMatchObject({ title: "Greys Anatomy", overview: "Surgeons.", year: 2005 });
    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tmdb: "1416" });
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

  it("writes a single multi-episode file (S01E01-E02) to both matching episode rows", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Show','show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    const filePath = writeFile(path.join(folder.path, "Show", "Season 01"), "Show.S01E01-E02.mkv");

    const result = await scanAndImportLibrary("series");

    expect(result.matched).toBe(2);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ episode_number: 1, has_file: 1, file_path: filePath });
    expect(episodes[1]).toMatchObject({ episode_number: 2, has_file: 1, file_path: filePath });
  });
});

// ---------------------------------------------------------------------------
// scanAndImportLibrary — course/adult (episodic shape, no episode-marker fallback)
// ---------------------------------------------------------------------------

describe("scanAndImportLibrary — course/adult (folder-as-show, sequentialEpisodeFallback)", () => {
  it("course: creates a folder-as-show with the folder name as its title (no metadata provider involved) and numbers marker-less lesson files from a leading number in the filename", async () => {
    const folder = await insertRootFolder("course");
    writeFile(path.join(folder.path, "Intro to Python"), "01 - Getting Started.mp4");
    writeFile(path.join(folder.path, "Intro to Python"), "02 - Variables.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(2);
    // Both files belong to the same folder-derived show, so only the FIRST one attempts the
    // best-effort enrichment lookup (course has zero configured providers, so this real call would
    // throw and be swallowed — mocked here as an empty result, same net effect) — the second file
    // finds the already-created show and never repeats it.
    expect(searchMetadata).toHaveBeenCalledTimes(1);
    expect(searchMetadata).toHaveBeenCalledWith("course", "Intro to Python", undefined, null);
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='course'").get()) as any;
    expect(show.title).toBe("Intro to Python");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(show.id)) as any[];
    expect(episodes.map((e) => ({ season: e.season_number, episode: e.episode_number, title: e.title }))).toEqual([
      { season: 1, episode: 1, title: "Getting Started" },
      { season: 1, episode: 2, title: "Variables" },
    ]);
  });

  it("course: lesson files nested under arbitrary subfolders (Module 1, Week 2 — not a 'Season NN' folder) all belong to the top-level course folder, not their own separate course", async () => {
    // Regression test: guessShowTitleFromFolder used to only walk up past a literal "Season NN"
    // parent folder, so any other subfolder name (a course's Module/Week/Section groupings) got
    // mistaken for its own separate course — see topLevelFolderName in libraryScan.ts.
    const folder = await insertRootFolder("course");
    writeFile(path.join(folder.path, "Intro to Python", "Module 1"), "01 - Getting Started.mp4");
    writeFile(path.join(folder.path, "Intro to Python", "Module 2", "Week 1"), "02 - Advanced Topics.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(2);
    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='course'").all()) as any[];
    expect(shows).toHaveLength(1);
    expect(shows[0].title).toBe("Intro to Python");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(shows[0].id)) as any[];
    expect(episodes.map((e) => e.title)).toEqual(["Getting Started", "Advanced Topics"]);
  });

  it("course: a root saved with a trailing separator still groups Module subfolders under the one course", async () => {
    const rootPath = path.join(tmpRoot, "course") + path.sep;
    fs.mkdirSync(rootPath, { recursive: true });
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'course', 'course')").run(rootPath);
    writeFile(path.join(rootPath, "Intro to Python", "Module 1"), "01 - Getting Started.mp4");
    writeFile(path.join(rootPath, "Intro to Python", "Module 2"), "02 - Advanced Topics.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(2);
    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='course'").all()) as any[];
    expect(shows.map((s) => s.title)).toEqual(["Intro to Python"]);
  });

  it("course: the course folder's tvshow.nfo titles lessons in its Module subfolders too, so one course stays one show", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "rust-course");
    writeFile(courseDir, "tvshow.nfo", `<tvshow><title>Intro to Rust</title></tvshow>`);
    writeFile(courseDir, "01 intro.mp4");
    writeFile(path.join(courseDir, "Module 2"), "05 traits.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(2);
    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='course'").all()) as any[];
    expect(shows.map((s) => s.title)).toEqual(["Intro to Rust"]);
    const episodes = (await db.prepare("SELECT episode_number FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(shows[0].id)) as any[];
    expect(episodes.map((e) => e.episode_number)).toEqual([1, 5]);
  });

  it("course: a lesson file with no leading number at all still becomes an episode instead of being skipped, appended after the current highest episode", async () => {
    const folder = await insertRootFolder("course");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('course','My Course','my course',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Getting Started',1,1)`).run(showId);
    writeFile(path.join(folder.path, "My Course"), "Bonus Content.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(1);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ season_number: 1, episode_number: 2, title: "Bonus Content" });
  });

  it("adult: ThePornDB enrichment can update overview/poster but never the folder-derived show title", async () => {
    const folder = await insertRootFolder("adult");
    writeFile(path.join(folder.path, "Some Studio Scene"), "clip.mp4");
    // Deliberately a DIFFERENT title than the folder name — proves the enrichment call's own result
    // title is never used to (re)name the show, exactly like series/tmdb.
    searchMetadata.mockResolvedValue([{ title: "A Completely Different Title", overview: "scene overview", posterUrl: "https://p/x.jpg", externalIds: { theporndb: "abc" } }]);

    await scanAndImportLibrary("adult");

    const show = (await db.prepare("SELECT * FROM media_items WHERE type='adult'").get()) as any;
    expect(show.title).toBe("Some Studio Scene");
    expect(show.overview).toBe("scene overview");
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(show.id)) as any;
    expect(ep).toMatchObject({ season_number: 1, episode_number: 1, has_file: 1, title: "clip" });
  });

  it("does not attach a new episode to an existing show that hasn't been converted from its old shape yet (legacy_shape set) — skips it with a clear reason instead", async () => {
    const folder = await insertRootFolder("course");
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, legacy_shape) VALUES ('course','Legacy Course','legacy course',1,0,'missing','collection')`
          )
          .run()
      ).lastInsertRowid
    );
    writeFile(path.join(folder.path, "Legacy Course"), "New Lesson.mp4");

    const result = await scanAndImportLibrary("course");

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0].reason).toContain("hasn't been converted to the new episode structure yet");
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(episodes).toHaveLength(0);
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

  it("imports a file that sits directly in the root with no author folder, under an unmonitored Unknown Author", async () => {
    const folder = await insertRootFolder("author");
    const filePath = writeFile(folder.path, "Orphan Book.epub");

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, created: 0, skipped: 0 });
    const author = (await db.prepare("SELECT * FROM media_items WHERE type='author'").get()) as any;
    expect(author).toMatchObject({ title: "Unknown Author", monitored: 0, has_file: 1 });
    const book = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(author.id)) as any;
    expect(book).toMatchObject({ title: "Orphan Book", has_file: 1, file_path: filePath });
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

  it("keeps each file under its own root when one root's path is a string prefix of another's (/x/music vs /x/music-lossless)", async () => {
    const insertNamedRoot = async (name: string) => {
      const p = path.join(tmpRoot, name);
      fs.mkdirSync(p, { recursive: true });
      return { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', ?)").run(p, name)).lastInsertRowid), path: p };
    };
    const music = await insertNamedRoot("music");
    const lossless = await insertNamedRoot("music-lossless");
    writeFile(path.join(music.path, "Artist A", "Album A"), "01 - One.mp3");
    const losslessAlbumDir = path.join(lossless.path, "Artist B", "Album B");
    writeFile(losslessAlbumDir, "01 - One.flac");

    const result = await scanAndImportLibrary("artist");

    expect(result.skipped).toBe(0);
    const artists = (await db.prepare("SELECT * FROM media_items WHERE type='artist' ORDER BY title").all()) as any[];
    expect(artists.map((a) => ({ title: a.title, root: a.root_folder_id }))).toEqual([
      { title: "Artist A", root: music.id },
      { title: "Artist B", root: lossless.id },
    ]);
    const album = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").get(artists[1].id)) as any;
    expect(album).toMatchObject({ title: "Album B", file_path: losslessAlbumDir });
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

  it("a per-item scan on a short title ('Go') never claims files from a folder that merely contains it as a substring ('Django for Beginners')", async () => {
    const folder = await insertRootFolder("course");
    const goId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('course','Go','go',1,0,'missing')`).run())
        .lastInsertRowid
    );
    writeFile(path.join(folder.path, "Django for Beginners"), "01 - Intro.mp4");

    const result = await scanAndImportOneMediaItem(goId);

    expect(result).toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [] });
    expect(await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(goId)).toEqual([]);
    expect((await db.prepare("SELECT * FROM media_items WHERE type = 'course'").all()) as any[]).toHaveLength(1);
  });

  it("a per-item movie scan never falls back to its target for a loosely-matching file whose year contradicts it", async () => {
    const folder = await insertRootFolder("movie");
    const thingId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie','The Thing (1982)','the thing (1982)',1982,1,0,'missing')`)
          .run()
      ).lastInsertRowid
    );
    writeFile(folder.path, "The.Thing.2011.1080p.mkv");

    const result = await scanAndImportOneMediaItem(thingId);

    expect(result.matched).toBe(0);
    expect((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(thingId)) as any).toMatchObject({ has_file: 0, path: null });
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

  it("leaves a per-item scan that overlaps a whole-library scan of the same type to that scan", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(folder.path, "Movie One (2020).mkv");
    writeFile(folder.path, "Movie Two (2021).mkv");

    const wholeLibraryScan = scanAndImportLibrary("movie");
    const scoped = await scanAndImportLibrary("movie", undefined, "Movie Two");
    const whole = await wholeLibraryScan;

    expect(scoped).toEqual({ matched: 0, created: 0, skipped: 0, skippedFiles: [], alreadyRunning: true });
    expect(whole.created).toBe(2);
    expect(await db.prepare("SELECT title FROM media_items WHERE type = 'movie' ORDER BY title").all()).toEqual([
      { title: "Movie One" },
      { title: "Movie Two" },
    ]);
  });

  it("course: Refresh during a whole-library scan never imports the same lesson a second time", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "My Course");
    writeFile(courseDir, "Introduction.mp4");
    writeFile(courseDir, "Wrap Up.mp4");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('course','My Course','my course',1,0,'unknown')`).run())
        .lastInsertRowid
    );
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    let probeStarted!: () => void;
    const firstProbe = new Promise<void>((resolve) => (probeStarted = resolve));
    probeMediaInfo.mockImplementation(async () => {
      probeStarted();
      await probeGate;
      return null;
    });

    const wholeLibraryScan = scanAndImportLibrary("course");
    await firstProbe; // the whole-library scan is mid-file
    const refresh = await refreshOneMediaItem(showId);
    releaseProbe();
    await wholeLibraryScan;

    expect(refresh.ok).toBe(true);
    const episodes = (await db.prepare("SELECT episode_number, file_path FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes).toHaveLength(2);
    expect(new Set(episodes.map((e) => e.file_path)).size).toBe(2);
    expect(episodes.map((e) => e.episode_number)).toEqual([1, 2]);
  });

  it("a whole-library scan waits for a running per-item scan instead of being skipped", async () => {
    const folder = await insertRootFolder("movie");
    const targetId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Movie Two','movie two',1,0,'missing')`).run())
        .lastInsertRowid
    );
    writeFile(folder.path, "Movie One (2020).mkv");
    writeFile(folder.path, "Movie Two (2021).mkv");
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    let probeStarted!: () => void;
    const firstProbe = new Promise<void>((resolve) => (probeStarted = resolve));
    probeMediaInfo.mockImplementation(async () => {
      probeStarted();
      await probeGate;
      return null;
    });

    const scoped = scanAndImportOneMediaItem(targetId);
    await firstProbe;
    const whole = scanAndImportLibrary("movie");
    releaseProbe();
    const [scopedResult, wholeResult] = await Promise.all([scoped, whole]);

    expect(scopedResult.matched).toBe(1);
    expect(wholeResult.alreadyRunning).toBeUndefined();
    expect(wholeResult).toMatchObject({ matched: 0, created: 1 });
    expect((await db.prepare("SELECT title, has_file FROM media_items WHERE type = 'movie' ORDER BY title").all()) as any[]).toEqual([
      { title: "Movie One", has_file: 1 },
      { title: "Movie Two", has_file: 1 },
    ]);
  });

  it("skips a second overlapping whole-library Refresh of the same type", async () => {
    await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','Slow Movie','slow movie',1,0,'missing')`).run();
    let releaseSearch!: () => void;
    const searchGate = new Promise<void>((resolve) => (releaseSearch = resolve));
    searchMetadata.mockImplementation(async () => {
      await searchGate;
      return [];
    });

    const first = refreshLibraryMetadata("movie");
    const second = await refreshLibraryMetadata("movie");
    releaseSearch();

    expect(second).toEqual({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });
    expect(await first).toEqual({ updated: 0, failed: 1, childrenAdded: 0 });
    expect(searchMetadata).toHaveBeenCalledTimes(1);
    // Finished, so the next one runs.
    expect((await refreshLibraryMetadata("movie")).alreadyRunning).toBeUndefined();
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

  it("populates the real provider status in place of the 'unknown'/'missing' placeholder, when the provider returns one", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','A Movie','a movie',1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Movie", year: 2020, overview: null, posterUrl: null, externalIds: { tmdb: "1" }, status: "Released" }]);

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT status FROM media_items WHERE id = ?").get(id)) as { status: string };
    expect(row.status).toBe("Released");
  });

  it("leaves the existing status untouched when the provider result has none (never clobbers a real value with a missing one)", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','A Movie','a movie',1,0,'Released')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Movie", year: 2020, overview: "updated", posterUrl: null, externalIds: { tmdb: "1" } }]); // no status field

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT status FROM media_items WHERE id = ?").get(id)) as { status: string };
    expect(row.status).toBe("Released");
  });

  it("populates content_rating from the provider result when the item has none yet", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie','A Movie','a movie',1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Movie", year: 2020, overview: null, posterUrl: null, externalIds: { tmdb: "1" }, contentRating: "PG-13" }]);

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT content_rating FROM media_items WHERE id = ?").get(id)) as { content_rating: string };
    expect(row.content_rating).toBe("PG-13");
  });

  it("never clobbers an existing (e.g. manually-set) content_rating with a missing one from the provider", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, content_rating) VALUES ('movie','A Movie','a movie',1,0,'missing','R')`)
          .run()
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Movie", year: 2020, overview: "updated", posterUrl: null, externalIds: { tmdb: "1" } }]); // no contentRating field

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT content_rating FROM media_items WHERE id = ?").get(id)) as { content_rating: string };
    expect(row.content_rating).toBe("R");
  });

  it("never overwrites the title of an item that's already matched (has external ids)", async () => {
    const id = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('movie','Already Matched','already matched',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "99" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "A Fuzzy Different Title", year: 2020, overview: "New overview", posterUrl: null, externalIds: { tmdb: "99" } }]);

    await refreshOneMediaItem(id);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.title).toBe("Already Matched"); // untouched
    expect(row.overview).toBe("New overview"); // overview/poster/year still refresh from its own entry
  });

  it("an already-matched item's title search only takes a hit carrying its own id, and still syncs its children", async () => {
    // An author added through Goodreads (no by-id lookup) is title-searched on Open Library, whose
    // first "John Williams" is someone else.
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status, overview, poster_url) VALUES ('author','John Williams','john williams',1,0,?,'unknown','Own bio','own.jpg')`
          )
          .run(JSON.stringify({ goodreads: "123" }))
      ).lastInsertRowid
    );
    searchMetadata.mockResolvedValue([
      { title: "John Williams", year: 1932, overview: "Someone else's bio", posterUrl: "placeholder.jpg", externalIds: { openlibrary: "OL1A" } },
    ]);
    fetchCollectionChildrenFor.mockResolvedValue({ provider: "goodreads", children: [{ title: "Stoner", releaseDate: null, externalId: "g1" }] });

    const result = await refreshOneMediaItem(id);

    expect(result).toEqual({ ok: true, childrenAdded: 1 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ title: "John Williams", overview: "Own bio", poster_url: "own.jpg", year: null });
    expect(fetchCollectionChildrenFor).toHaveBeenCalledWith({ goodreads: "123" });
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
    searchMetadata.mockResolvedValue([{ title: "Guessed Title", year: 2020, overview: "new overview", posterUrl: null, externalIds: { tmdb: "5" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, title: "S1E1", airDate: null, overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "S2E1", airDate: null, overview: null },
    ]);

    const result = await refreshOneMediaItem(showId, 2);

    expect(result).toEqual({ ok: true, childrenAdded: 1 });
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

  it("course: Refresh picks up a new lesson file from disk even though there's no metadata provider to ever backfill one", async () => {
    const folder = await insertRootFolder("course");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('course','My Course','my course',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Getting Started',1,1)`).run(showId);
    // Loosely matches the show's own title (so the onlyTitle gate passes) without exactly matching
    // it (so the strict per-show match falls through to the onlyMediaItemId fallback) — same
    // convention the "onlyMediaItemId attaches..." per-item-scoping test above already relies on.
    writeFile(path.join(folder.path, "My Course"), "My Course - Bonus.mp4");

    const result = await refreshOneMediaItem(showId);

    expect(result.ok).toBe(true);
    expect(result.childrenAdded).toBeGreaterThan(0);
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(episodes).toHaveLength(2);
    expect(episodes.some((e) => e.episode_number === 2 && e.has_file === 1)).toBe(true);
  });

  it("searches an unmatched item's title with its known year and skips a same-titled hit from another year", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie','Halloween','halloween',1978,1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([
      { title: "Halloween", year: 2018, overview: "The 2018 film", posterUrl: "2018.jpg", externalIds: { tmdb: "424139" } },
      { title: "Halloween", year: 1978, overview: "The 1978 film", posterUrl: "1978.jpg", externalIds: { tmdb: "948" } },
    ]);

    const result = await refreshOneMediaItem(id);

    expect(result.ok).toBe(true);
    expect(searchMetadata).toHaveBeenCalledWith("movie", "Halloween", undefined, 1978);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ year: 1978, overview: "The 1978 film", poster_url: "1978.jpg" });
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "948" });
  });

  it("fails rather than matching an unmatched item to a hit whose year contradicts its known year", async () => {
    const id = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie','Halloween','halloween',1978,1,0,'missing')`).run())
        .lastInsertRowid
    );
    searchMetadata.mockResolvedValue([{ title: "Halloween", year: 2018, overview: "The 2018 film", posterUrl: null, externalIds: { tmdb: "424139" } }]);

    const result = await refreshOneMediaItem(id);

    expect(result).toEqual({ ok: false, childrenAdded: 0 });
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.year).toBe(1978);
    expect(row.external_ids).toBeNull();
  });

  it("adult: Refresh of an unmatched show never renames it to a ThePornDB scene title, and still picks up new clips", async () => {
    const folder = await insertRootFolder("adult");
    const showDir = path.join(folder.path, "StudioX");
    const firstClip = writeFile(showDir, "clip1.mp4");
    writeFile(showDir, "clip2.mp4");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('adult','StudioX','studiox',?,1,1,'unknown')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1,'clip1',1,1,?)`)
      .run(showId, firstClip);
    searchMetadata.mockResolvedValue([{ title: "Some Scene Title", year: null, overview: "scene overview", posterUrl: null, externalIds: { theporndb: "abc" } }]);

    const result = await refreshOneMediaItem(showId);

    expect(result.ok).toBe(true);
    const show = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(show).toMatchObject({ title: "StudioX", sort_title: "studiox", overview: "scene overview" });
    expect(JSON.parse(show.external_ids)).toEqual({ theporndb: "abc" });
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(showId)) as any[];
    expect(episodes).toHaveLength(2);
    expect((await db.prepare("SELECT * FROM media_items WHERE type = 'adult'").all()) as any[]).toHaveLength(1);
  });

  it("course: Refresh of a course titled by its tvshow.nfo picks up a new lesson in a Module subfolder and keeps the NFO title", async () => {
    const folder = await insertRootFolder("course");
    const courseDir = path.join(folder.path, "rust-course");
    writeFile(courseDir, "tvshow.nfo", `<tvshow><title>Intro to Rust</title></tvshow>`);
    writeFile(courseDir, "01 intro.mp4");
    await scanAndImportLibrary("course");
    const show = (await db.prepare("SELECT * FROM media_items WHERE type='course'").get()) as any;
    expect(show.title).toBe("Intro to Rust");
    writeFile(path.join(courseDir, "Module 2"), "05 traits.mp4");

    const result = await refreshOneMediaItem(show.id);

    expect(result.ok).toBe(true);
    const shows = (await db.prepare("SELECT * FROM media_items WHERE type='course'").all()) as any[];
    expect(shows).toHaveLength(1);
    expect(shows[0].title).toBe("Intro to Rust");
    const episodes = (await db.prepare("SELECT episode_number FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(show.id)) as any[];
    expect(episodes.map((e) => e.episode_number)).toEqual([1, 5]);
  });

  it("scan → Refresh → scan: a show the scan couldn't verify is never renamed, so a new episode joins it", async () => {
    const folder = await insertRootFolder("series");
    const showDir = path.join(folder.path, "The Office US", "Season 01");
    writeFile(showDir, "The.Office.US.S01E01.mkv");
    // TMDB's title for it; the scan's title check rejects it, and so must Refresh.
    searchMetadata.mockResolvedValue([{ title: "The Office", year: 2005, overview: "Dunder Mifflin.", posterUrl: "office.jpg", externalIds: { tmdb: "2316" } }]);

    await scanAndImportLibrary("series");
    const created = (await db.prepare("SELECT * FROM media_items WHERE type = 'series'").all()) as any[];
    expect(created).toMatchObject([{ title: "The Office US", overview: null }]);

    await refreshLibraryMetadata("series");
    const refreshed = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(created[0].id)) as any;
    expect(refreshed).toMatchObject({ title: "The Office US", sort_title: "the office us", overview: null });
    expect(refreshed.external_ids ?? null).toBeNull();

    writeFile(showDir, "The.Office.US.S01E02.mkv");
    await scanAndImportLibrary("series");

    const shows = (await db.prepare("SELECT * FROM media_items WHERE type = 'series'").all()) as any[];
    expect(shows).toHaveLength(1);
    const episodes = (await db.prepare("SELECT episode_number FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(shows[0].id)) as any[];
    expect(episodes.map((e) => e.episode_number)).toEqual([1, 2]);
  });

  it("scan → Refresh → scan: a show Refresh does match keeps its folder title, so a new episode joins it", async () => {
    const folder = await insertRootFolder("series");
    const showDir = path.join(folder.path, "Greys Anatomy", "Season 01");
    writeFile(showDir, "Greys.Anatomy.S01E01.mkv");
    searchMetadata.mockRejectedValueOnce(new Error("provider down")); // no enrichment at scan time

    await scanAndImportLibrary("series");
    searchMetadata.mockResolvedValue([{ title: "Grey's Anatomy", year: 2005, overview: "Surgeons.", posterUrl: null, externalIds: { tmdb: "1416" } }]);
    await refreshLibraryMetadata("series");

    const show = (await db.prepare("SELECT * FROM media_items WHERE type = 'series'").get()) as any;
    expect(show).toMatchObject({ title: "Greys Anatomy", sort_title: "greys anatomy", overview: "Surgeons.", year: 2005 });
    expect(JSON.parse(show.external_ids)).toEqual({ tmdb: "1416" });

    writeFile(showDir, "Greys.Anatomy.S01E02.mkv");
    await scanAndImportLibrary("series");

    expect((await db.prepare("SELECT * FROM media_items WHERE type = 'series'").all()) as any[]).toHaveLength(1);
    const count = Number(((await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND has_file = 1").get(show.id)) as any).c);
    expect(count).toBe(2);
  });

  it("fetches children only by the ids the item was added with, not ones matched from other providers", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','TVDB Numbered','tvdb numbered',1,0,?,'missing')`)
          .run(JSON.stringify({ tvdb: "81189" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider?: string) =>
      provider === "tmdb" ? [{ title: "TVDB Numbered", year: null, overview: null, posterUrl: null, externalIds: { tmdb: "1396" } }] : []
    );
    await matchAdditionalProviders(showId);
    const matched = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(matched.external_ids)).toEqual({ tvdb: "81189", tmdb: "1396" }); // still there for duplicate detection
    fetchByExternalId.mockImplementation(async (_type: string, provider: string, id: string) => {
      if (provider === "tvdb" && id === "81189") return { title: "TVDB Numbered", year: 2008, overview: "From TVDB", posterUrl: null, externalIds: { tvdb: "81189" } };
      throw new Error(`unexpected lookup ${provider}:${id}`);
    });

    await refreshOneMediaItem(showId);

    expect(fetchSeriesEpisodesFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(fetchSeriesSeasonsFor).toHaveBeenCalledWith({ tvdb: "81189" });
    expect(fetchByExternalId).not.toHaveBeenCalledWith("series", "tmdb", expect.anything());
    expect(((await db.prepare("SELECT overview FROM media_items WHERE id = ?").get(showId)) as any).overview).toBe("From TVDB");
  });

  it("keeps fetching an artist's albums from the provider it was added with after another provider's id is merged in", async () => {
    const artistId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('artist','The Beatles','the beatles',1,0,?,'unknown')`)
          .run(JSON.stringify({ deezer: "1" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider?: string) =>
      provider === "musicbrainz" ? [{ title: "The Beatles", year: 1960, overview: null, posterUrl: null, externalIds: { musicbrainz: "b10bbbfc" } }] : []
    );
    await matchAdditionalProviders(artistId);
    searchMetadata.mockResolvedValue([]);

    await refreshOneMediaItem(artistId);

    expect(fetchArtistAlbumsFor).toHaveBeenCalledWith({ deezer: "1" });
    expect(fetchArtistAlbumsFor).not.toHaveBeenCalledWith(expect.objectContaining({ musicbrainz: "b10bbbfc" }));
  });

  it("still lists a manga's chapters by the MangaDex id matched in when it was added through AniList", async () => {
    const mangaId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('manga','Chainsaw Man','chainsaw man',1,0,?,'unknown')`)
          .run(JSON.stringify({ anilist: "105778" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider?: string) =>
      provider === "mangadex" ? [{ title: "Chainsaw Man", year: null, overview: null, posterUrl: null, externalIds: { mangadex: "a77742b1" } }] : []
    );
    await matchAdditionalProviders(mangaId);
    searchMetadata.mockResolvedValue([]);
    fetchCollectionChildrenFor.mockImplementation(async (ids: Record<string, string>) =>
      ids.mangadex
        ? {
            provider: "mangadex",
            children: [
              { title: "Chapter 1", releaseDate: null, externalId: "c1" },
              { title: "Chapter 2", releaseDate: null, externalId: "c2" },
            ],
          }
        : { provider: null, children: [] }
    );

    const result = await refreshOneMediaItem(mangaId);

    expect(fetchCollectionChildrenFor).toHaveBeenCalledWith({ anilist: "105778", mangadex: "a77742b1" });
    expect(result.childrenAdded).toBe(2);
    const chapters = (await db.prepare("SELECT title, external_provider FROM sub_items WHERE media_item_id = ? ORDER BY title").all(mangaId)) as any[];
    expect(chapters).toEqual([
      { title: "Chapter 1", external_provider: "mangadex" },
      { title: "Chapter 2", external_provider: "mangadex" },
    ]);
  });

  it("lists an Audnexus-added author's books by the Open Library id matched in", async () => {
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, extra_metadata, status) VALUES ('author','Andy Weir','andy weir',1,0,?,?,'unknown')`)
          .run(JSON.stringify({ audnexus: "B00G0WYW92", openlibrary: "OL7115219A" }), JSON.stringify({ additionalProviderIds: { openlibrary: "OL7115219A" } }))
      ).lastInsertRowid
    );

    await refreshOneMediaItem(authorId);

    expect(fetchCollectionChildrenFor).toHaveBeenCalledWith({ audnexus: "B00G0WYW92", openlibrary: "OL7115219A" });
  });

  it("childListProviderIds keeps a channel or playlist on its own id once a YouTube channel id is matched in", () => {
    const merged = (own: Record<string, string>) => ({
      type: "video",
      external_ids: JSON.stringify({ ...own, youtube: "UCmerged" }),
      extra_metadata: JSON.stringify({ additionalProviderIds: { youtube: "UCmerged" } }),
    });
    expect(childListProviderIds(merged({ vimeo: "staffpicks" }))).toEqual({ vimeo: "staffpicks" });
    expect(childListProviderIds(merged({ youtubePlaylist: "PL123" }))).toEqual({ youtubePlaylist: "PL123" });
    // Recorded before merged ids were tracked: every id is the item's own.
    expect(childListProviderIds({ type: "video", external_ids: JSON.stringify({ vimeo: "v", youtube: "y" }), extra_metadata: null })).toEqual({
      vimeo: "v",
      youtube: "y",
    });
    expect(childListProviderIds({ type: "video", external_ids: "not json", extra_metadata: null })).toEqual({});
  });

  it("updates an existing episode's air date and 'TBA' title from the show's own provider", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Delayed Show','delayed show',1,0,?,'continuing')`)
          .run(JSON.stringify({ tvmaze: "7" }))
      ).lastInsertRowid
    );
    const insertEp = (episode: number, title: string, airDate: string | null) =>
      db
        .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,2,?,?,?,1)`)
        .run(showId, episode, title, airDate);
    await insertEp(1, "TBA", "2026-10-01");
    await insertEp(2, "A Real Title", "2026-10-08");
    await insertEp(3, "TBA", "2026-10-15");
    searchMetadata.mockResolvedValue([{ title: "Delayed Show", year: 2024, overview: null, posterUrl: null, externalIds: { tvmaze: "7" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 2, episodeNumber: 1, title: "The Return", airDate: "2026-10-15", overview: "Back." },
      { seasonNumber: 2, episodeNumber: 2, title: "Provider Retitle", airDate: "2026-10-22", overview: null },
      { seasonNumber: 2, episodeNumber: 3, title: "TBA", airDate: null, overview: null },
    ]);

    await refreshOneMediaItem(showId);

    const episodes = (await db.prepare("SELECT episode_number, title, air_date, overview FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes).toEqual([
      { episode_number: 1, title: "The Return", air_date: "2026-10-15", overview: "Back." },
      { episode_number: 2, title: "A Real Title", air_date: "2026-10-22", overview: null },
      { episode_number: 3, title: "TBA", air_date: "2026-10-15", overview: null }, // no new date to take
    ]);
  });

  it("a Refresh of a show that already has episodes monitors only the new ones that are upcoming or just aired", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Long Runner','long runner',1,0,?,'continuing')`)
          .run(JSON.stringify({ anilist: "21" }))
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,1,1001,'Known',?,1)`)
      .run(showId, day(-60));
    // AniList now lists an ongoing show's whole back catalogue, undated, before its dated recent episodes.
    const backCatalogue = Array.from({ length: 1000 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, title: `Episode ${i + 1}`, airDate: null, overview: null }));
    fetchSeriesEpisodesFor.mockResolvedValue([
      ...backCatalogue,
      { seasonNumber: 1, episodeNumber: 1001, title: "Known", airDate: day(-60), overview: null },
      { seasonNumber: 1, episodeNumber: 1002, title: "Aired Last Week", airDate: day(-7), overview: null },
      { seasonNumber: 1, episodeNumber: 1003, title: "Next Week", airDate: day(7), overview: null },
      { seasonNumber: 0, episodeNumber: 1, title: "Upcoming Special", airDate: day(14), overview: null },
    ]);

    const result = await refreshOneMediaItem(showId);

    expect(result).toEqual({ ok: true, childrenAdded: 1003 });
    const monitored = (await db
      .prepare("SELECT season_number, episode_number FROM episodes WHERE media_item_id = ? AND monitored = 1 ORDER BY season_number, episode_number")
      .all(showId)) as any[];
    expect(monitored.map((e) => `${e.season_number}x${e.episode_number}`)).toEqual(["1x1001", "1x1002", "1x1003"]);
  });

  it("a Refresh doesn't monitor an undated back catalogue before an episode the show already tracks, even with no aired episode dated", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Long Runner','long runner',1,1,?,'continuing')`)
          .run(JSON.stringify({ anilist: "21" }))
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1000,'Episode 1000',1,1,'/x/e1000.mkv')`)
      .run(showId);
    // AniList with an empty aired schedule: every aired episode undated, only the next one dated.
    fetchSeriesEpisodesFor.mockResolvedValue([
      ...Array.from({ length: 1000 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, title: null, airDate: null, overview: null })),
      { seasonNumber: 1, episodeNumber: 1001, title: null, airDate: day(5), overview: null },
    ]);

    expect(await refreshOneMediaItem(showId)).toEqual({ ok: true, childrenAdded: 1000 });

    const monitoredNew = (await db
      .prepare("SELECT episode_number FROM episodes WHERE media_item_id = ? AND monitored = 1 AND has_file = 0 ORDER BY episode_number")
      .all(showId)) as any[];
    expect(monitoredNew.map((e) => Number(e.episode_number))).toEqual([1001]);
  });

  it("a Refresh still monitors a new season the show doesn't track yet, dated or not", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Renewed','renewed',1,0,?,'continuing')`)
          .run(JSON.stringify({ tvdb: "90" }))
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,1,8,'Finale','2020-03-01',1)`)
      .run(showId);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 8, title: "Finale", airDate: "2020-03-01", overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Premiere", airDate: day(10), overview: null },
      { seasonNumber: 2, episodeNumber: 2, title: "TBA", airDate: null, overview: null },
    ]);

    expect(await refreshOneMediaItem(showId)).toEqual({ ok: true, childrenAdded: 2 });

    const season2 = (await db
      .prepare("SELECT episode_number, monitored FROM episodes WHERE media_item_id = ? AND season_number = 2 ORDER BY episode_number")
      .all(showId)) as any[];
    expect(season2.map((e) => [Number(e.episode_number), Number(e.monitored)])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("a show's first episode sync still monitors every listed episode but its specials, even after another provider's specials were merged in", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','First Sync','first sync',1,0,?,'continuing')`)
          .run(JSON.stringify({ tvdb: "77" }))
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,0,5,'Merged Special','2009-12-01',0)`)
      .run(showId);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 0, episodeNumber: 1, title: "Behind the Scenes", airDate: "2010-02-01", overview: null },
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2010-01-01", overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: null, overview: null },
      { seasonNumber: 1, episodeNumber: 3, title: "Third", airDate: "2010-01-15", overview: null },
    ]);

    expect(await refreshOneMediaItem(showId)).toEqual({ ok: true, childrenAdded: 4 });

    const episodes = (await db
      .prepare("SELECT season_number, episode_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
      .all(showId)) as any[];
    expect(episodes.map((e) => [Number(e.season_number), Number(e.episode_number), Number(e.monitored)])).toEqual([
      [0, 1, 0],
      [0, 5, 0],
      [1, 1, 1],
      [1, 2, 1],
      [1, 3, 1],
    ]);
  });

  it("the Refresh that first matches a show Scan & Import created monitors its whole episode list but the specials", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Scanned Show','scanned show',1,1,'{}','unknown')`)
          .run()
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,3,'Episode 3',1,1,'/x/s01e03.mkv')`)
      .run(showId);
    searchMetadata.mockResolvedValue([{ title: "Scanned Show", year: 2010, overview: null, posterUrl: null, externalIds: { tvdb: "88" } }]);
    fetchSeriesEpisodesFor.mockResolvedValue([
      { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2010-02-01", overview: null },
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDate: "2010-01-01", overview: null },
      { seasonNumber: 1, episodeNumber: 2, title: "Second", airDate: "2010-01-08", overview: null },
      { seasonNumber: 1, episodeNumber: 3, title: "Third", airDate: "2010-01-15", overview: null },
    ]);

    expect(await refreshOneMediaItem(showId)).toEqual({ ok: true, childrenAdded: 3 });

    const episodes = (await db
      .prepare("SELECT season_number, episode_number, title, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
      .all(showId)) as any[];
    expect(episodes.map((e) => [Number(e.season_number), Number(e.episode_number), e.title, Number(e.monitored)])).toEqual([
      [0, 1, "Special", 0],
      [1, 1, "Pilot", 1],
      [1, 2, "Second", 1],
      [1, 3, "Third", 1],
    ]);
  });

  describe("the Refresh right after a Different Match", () => {
    // A Scan & Import show with one downloaded file, given its ids the way /rematch writes them.
    async function insertRematchedScannedShow(): Promise<number> {
      const showId = Number(
        (
          await db
            .prepare(
              `INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, extra_metadata, status)
               VALUES ('series','Rematched Show','rematched show',1,1,?,?,'unknown')`
            )
            .run(JSON.stringify({ tvdb: "88" }), JSON.stringify({ additionalProviderIds: {} }))
        ).lastInsertRowid
      );
      await db
        .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,3,'Episode 3',1,1,'/x/s01e03.mkv')`)
        .run(showId);
      fetchByExternalId.mockResolvedValue({ title: "Rematched Show", year: 2010, overview: null, posterUrl: null, externalIds: { tvdb: "88" } });
      fetchSeriesEpisodesFor.mockResolvedValue([
        { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2010-02-01", overview: null },
        ...Array.from({ length: 28 }, (_, i) => ({
          seasonNumber: 1,
          episodeNumber: i + 1,
          title: `Chapter ${i + 1}`,
          airDate: new Date(Date.UTC(2010, 0, 1 + i * 7)).toISOString().slice(0, 10),
          overview: null,
        })),
      ]);
      return showId;
    }

    const monitoredState = async (showId: number) =>
      (
        (await db
          .prepare("SELECT season_number, episode_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
          .all(showId)) as any[]
      ).map((e) => [Number(e.season_number), Number(e.episode_number), Number(e.monitored)]);

    it("monitors every listed episode but the specials when the caller marks it the first match", async () => {
      const showId = await insertRematchedScannedShow();

      expect(await refreshOneMediaItem(showId, undefined, { firstMatch: true })).toEqual({ ok: true, childrenAdded: 28 });

      const episodes = await monitoredState(showId);
      expect(episodes).toHaveLength(29);
      expect(episodes[0]).toEqual([0, 1, 0]);
      expect(episodes.slice(1)).toEqual(Array.from({ length: 28 }, (_, i) => [1, i + 1, 1]));
    });

    it("keeps an ordinary Refresh of an already-matched show to the recently aired rule", async () => {
      const showId = await insertRematchedScannedShow();

      expect(await refreshOneMediaItem(showId)).toEqual({ ok: true, childrenAdded: 28 });

      const monitored = (await monitoredState(showId)).filter(([, , m]) => m === 1);
      expect(monitored).toEqual([[1, 3, 1]]);
    });
  });

  it("stores a ROM's ScreenScraper artwork behind the local-artwork proxy and keeps its URL on the next Refresh", async () => {
    const folder = await insertRootFolder("rom");
    writeFile(folder.path, "Tetris (World).gb");
    await scanAndImportLibrary("rom");
    const [rom] = (await db.prepare("SELECT * FROM media_items WHERE type = 'rom'").all()) as any[];
    const boxArt = "screenscraper:https://www.screenscraper.fr/api2/mediaJeu.php?gameid=1&media=box-2D";
    searchMetadata.mockResolvedValue([
      {
        title: "Tetris",
        year: 1989,
        overview: "Falling blocks.",
        posterUrl: boxArt,
        // A raw media URL still carrying the credentials ScreenScraper echoes into it.
        backdropUrl: "https://www.screenscraper.fr/api2/mediaJeu.php?devid=dev&devpassword=devsecret&ssid=me&sspassword=mysecret&gameid=1&media=fanart",
        externalIds: { screenscraper: "1" },
      },
    ]);

    expect((await refreshOneMediaItem(rom.id)).ok).toBe(true);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(rom.id)) as any;
    expect(row.title).toBe("Tetris");
    expect(row.local_poster_token).toMatch(/^[0-9a-f]{40}$/);
    expect(row.poster_url).toBe(`/api/media/local-artwork/${row.local_poster_token}`);
    expect(row.local_poster_path).toBe(boxArt);
    expect(row.local_backdrop_token).toMatch(/^[0-9a-f]{40}$/);
    expect(row.backdrop_url).toBe(`/api/media/local-artwork/${row.local_backdrop_token}`);
    expect(row.local_backdrop_path).toBe("screenscraper:https://www.screenscraper.fr/api2/mediaJeu.php?gameid=1&media=fanart");
    expect(JSON.stringify(row)).not.toContain("secret");

    expect((await refreshOneMediaItem(rom.id)).ok).toBe(true);

    const again = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(rom.id)) as any;
    expect(again).toMatchObject({
      poster_url: row.poster_url,
      local_poster_token: row.local_poster_token,
      backdrop_url: row.backdrop_url,
      local_backdrop_token: row.local_backdrop_token,
    });
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
    // A new special is added unmonitored, Sonarr's default.
    expect(episodes.find((e) => e.season_number === 0)).toMatchObject({ title: "Special", monitored: 0 });
    expect(episodes.find((e) => e.season_number === 1 && e.episode_number === 1).title).toBe("Real Pilot");
    expect(episodes.find((e) => e.season_number === 1 && e.episode_number === 2).title).toBe("Real Title");
  });

  it("returns 0 without querying anything for an empty episode list", async () => {
    expect(await mergeEpisodesIntoItem(999999, [])).toBe(0);
  });

  it("another provider's list fills a missing air date and a 'TBA' title but never moves a stored date", async () => {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series','Other List Show','other list show',1,0,'missing')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,0,1,'TBA','2020-01-01',1)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?,0,2,'Known',NULL,1)`).run(showId);

    await mergeEpisodesIntoItem(showId, [
      { seasonNumber: 0, episodeNumber: 1, title: "Named Special", airDate: "2021-06-01", overview: null },
      { seasonNumber: 0, episodeNumber: 2, title: "Other Name", airDate: "2021-07-01", overview: null },
    ]);

    const episodes = (await db.prepare("SELECT episode_number, title, air_date FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes).toEqual([
      { episode_number: 1, title: "Named Special", air_date: "2020-01-01" },
      { episode_number: 2, title: "Known", air_date: "2021-07-01" },
    ]);
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
    searchMetadata.mockResolvedValue([
      { title: "Already Matched Show", year: 2020, overview: null, posterUrl: null, externalIds: { tvdb: "999", trakt: "5" } },
    ]);
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

  it("skips a search hit whose title or year disagrees with the item, taking a later hit that agrees", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, external_ids, status) VALUES ('series','Halloween','halloween',1978,1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) => {
      if (provider === "tvdb") return [{ title: "Halloween", year: 2018, overview: null, posterUrl: null, externalIds: { tvdb: "2" } }];
      if (provider === "tvmaze")
        return [
          { title: "Halloween Kills", year: 1978, overview: null, posterUrl: null, externalIds: { tvmaze: "9" } },
          { title: "Halloween", year: 1978, overview: null, posterUrl: null, externalIds: { tvmaze: "3" } },
        ];
      return [];
    });
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const results = await matchAdditionalProviders(showId);

    expect(results.map((r) => r.provider)).toEqual(["tvmaze"]);
    expect(fetchSeriesEpisodesForProvider).not.toHaveBeenCalledWith("tvdb", expect.anything());
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "1", tvmaze: "3" });
  });

  it("takes the hit from the item's own year over a same-titled one a year off, even when that one ranks first", async () => {
    // TMDB matched the US "Queer as Folk" (2000); TVDB lists the UK original (1999) first.
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, external_ids, status) VALUES ('series','Queer as Folk','queer as folk',2000,1,0,?,'ended')`)
          .run(JSON.stringify({ tmdb: "US-TMDB" }))
      ).lastInsertRowid
    );
    const tvdbHits = [
      { title: "Queer as Folk", year: 1999, overview: null, posterUrl: null, externalIds: { tvdb: "UK" } },
      { title: "Queer as Folk (US)", year: 2000, overview: null, posterUrl: null, externalIds: { tvdb: "US" } },
    ];
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) => (provider === "tvdb" ? tvdbHits : []));
    fetchSeriesEpisodesForProvider.mockImplementation(async (_provider: string, id: string) => [
      { seasonNumber: 0, episodeNumber: 1, title: `${id} Special`, airDate: null, overview: null },
    ]);

    await matchAdditionalProviders(showId);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "US-TMDB", tvdb: "US" });
    expect(fetchSeriesEpisodesForProvider).not.toHaveBeenCalledWith("tvdb", "UK");
    const specials = (await db.prepare("SELECT title FROM episodes WHERE media_item_id = ? AND season_number = 0").all(showId)) as any[];
    expect(specials.map((e) => e.title)).toEqual(["US Special"]);
    // Without an exact-year hit, the first one within a year; without a year, the first title hit.
    expect(pickVerifiedProviderHit(tvdbHits, "Queer as Folk", 2001)?.externalIds.tvdb).toBe("US");
    expect(pickVerifiedProviderHit(tvdbHits, "Queer as Folk", null)?.externalIds.tvdb).toBe("UK");
    expect(pickVerifiedProviderHit(tvdbHits, "Queer as Folk", 2005)).toBeUndefined();
  });

  it("merges only another provider's Season 0 specials, never its other seasons", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Specials Show','specials show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Pilot',1)`).run(showId);
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) =>
      provider === "tvdb" ? [{ title: "Specials Show", year: null, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }] : []
    );
    fetchSeriesEpisodesForProvider.mockImplementation(async (provider: string) =>
      provider === "tvdb"
        ? [
            { seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: null, overview: null },
            { seasonNumber: 2, episodeNumber: 1, title: "Other Numbering S2", airDate: null, overview: null },
            { seasonNumber: 3, episodeNumber: 1, title: "Other Numbering S3", airDate: null, overview: null },
          ]
        : []
    );

    const results = await matchAdditionalProviders(showId);

    expect(results).toEqual([{ provider: "tvdb", episodesAdded: 1 }]);
    const episodes = (await db.prepare("SELECT season_number, episode_number FROM episodes WHERE media_item_id = ? ORDER BY season_number").all(showId)) as any[];
    expect(episodes).toEqual([
      { season_number: 0, episode_number: 1 },
      { season_number: 1, episode_number: 1 },
    ]);
  });

  it("adds another provider's specials unmonitored, so a 'Future'/'None' add doesn't queue them as wanted", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Future Only Show','future only show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );
    // The Add's own strategy left this regular episode unmonitored; the merge must not change it either.
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?,1,1,'Pilot',0)`).run(showId);
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) =>
      provider === "tvdb" ? [{ title: "Future Only Show", year: null, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }] : []
    );
    fetchSeriesEpisodesForProvider.mockImplementation(async (provider: string) =>
      provider === "tvdb"
        ? [
            { seasonNumber: 0, episodeNumber: 1, title: "Special One", airDate: null, overview: null },
            { seasonNumber: 0, episodeNumber: 2, title: "Special Two", airDate: null, overview: null },
          ]
        : []
    );

    await matchAdditionalProviders(showId);

    const episodes = (await db.prepare("SELECT season_number, episode_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number").all(showId)) as any[];
    expect(episodes).toEqual([
      { season_number: 0, episode_number: 1, monitored: 0 },
      { season_number: 0, episode_number: 2, monitored: 0 },
      { season_number: 1, episode_number: 1, monitored: 0 },
    ]);
  });

  it("gives an AniList-numbered anime no other provider's ids or episodes (AniList numbers every cour as season 1)", async () => {
    const animeId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, external_ids, status) VALUES ('anime','Attack on Titan','attack on titan',2013,1,0,?,'missing')`)
          .run(JSON.stringify({ anilist: "16498" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) =>
      provider === "tvdb"
        ? [{ title: "Attack on Titan", year: 2013, overview: null, posterUrl: null, externalIds: { tvdb: "267440", tmdb: "1429" } }]
        : []
    );
    fetchSeriesEpisodesForProvider.mockResolvedValue([
      { seasonNumber: 0, episodeNumber: 1, title: "OVA", airDate: null, overview: null },
      { seasonNumber: 2, episodeNumber: 1, title: "Season 2 Premiere", airDate: null, overview: null },
    ]);

    const results = await matchAdditionalProviders(animeId);

    expect(fetchSeriesEpisodesForProvider).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(animeId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ anilist: "16498" });
    expect(await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(animeId)).toEqual([]);
    // Still staged for review, but with no id merged it isn't reported as a matched provider.
    expect(JSON.parse(row.extra_metadata).tvdb).toMatchObject({ title: "Attack on Titan" });
    expect(results).toEqual([]);
  });

  it("stops without writing anything once a Different Match changes the item mid-run", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','The Office','the office',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "UK" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) => {
      if (provider !== "tvdb") return [];
      // The admin picks the US show while this provider's search is in flight.
      await db
        .prepare("UPDATE media_items SET external_ids = ?, extra_metadata = ? WHERE id = ?")
        .run(JSON.stringify({ tmdb: "US" }), JSON.stringify({ performers: ["kept"] }), showId);
      return [{ title: "The Office", year: 2001, overview: null, posterUrl: null, externalIds: { tvdb: "78107" } }];
    });
    fetchSeriesEpisodesForProvider.mockResolvedValue([{ seasonNumber: 0, episodeNumber: 1, title: "UK Christmas Special", airDate: null, overview: null }]);

    const results = await matchAdditionalProviders(showId);

    expect(results).toEqual([]);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "US" });
    expect(JSON.parse(row.extra_metadata)).toEqual({ performers: ["kept"] });
    expect(await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(showId)).toEqual([]);
  });

  it("merges each provider's find into the row as it is when written, keeping what others wrote meanwhile", async () => {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('series','Busy Show','busy show',1,0,?,'missing')`)
          .run(JSON.stringify({ tmdb: "1" }))
      ).lastInsertRowid
    );
    searchMetadata.mockImplementation(async (_type: string, _query: string, provider: string) => {
      if (provider !== "tvdb") return [];
      // A manual "Fetch from TVMaze" staged its result while this search ran.
      await db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify({ tvmaze: { title: "Busy Show" } }), showId);
      return [{ title: "Busy Show", year: null, overview: null, posterUrl: null, externalIds: { tvdb: "42" } }];
    });

    const results = await matchAdditionalProviders(showId);

    expect(results).toEqual([{ provider: "tvdb", episodesAdded: 0 }]);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    expect(JSON.parse(row.external_ids)).toEqual({ tmdb: "1", tvdb: "42" });
    const extra = JSON.parse(row.extra_metadata);
    expect(extra.tvmaze).toEqual({ title: "Busy Show" });
    expect(extra.tvdb).toMatchObject({ title: "Busy Show" });
    expect(extra.additionalProviderIds).toEqual({ tvdb: "42" });
  });
});

describe("matchProvidersForLibrary", () => {
  it("runs matchAdditionalProviders across every item of a type and totals the results", async () => {
    await db.prepare(`DELETE FROM media_items WHERE type = 'anime'`).run();
    // TMDB-numbered, not AniList-only (whose hits are only staged, never counted as matches).
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Anime One','anime one',1,0,?,'missing')`)
      .run(JSON.stringify({ anilist: "1", tmdb: "11" }));
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, external_ids, status) VALUES ('anime','Anime Two','anime two',1,0,?,'missing')`)
      .run(JSON.stringify({ anilist: "2", tmdb: "22" }));
    // A hit is only accepted when its title agrees with the item's, so each item's search echoes it.
    searchMetadata.mockImplementation(async (_type: string, query: string, provider: string) =>
      provider === "tvdb" ? [{ title: query, year: null, overview: null, posterUrl: null, externalIds: { tvdb: "1" } }] : []
    );
    fetchSeriesEpisodesForProvider.mockResolvedValue([]);

    const result = await matchProvidersForLibrary("anime");

    expect(result).toEqual({ itemsMatched: 2, providersMatched: 2 });
  });
});

describe("convertLibraryToEpisodic", () => {
  it("course: turns every legacy sub_item (Lesson) into an episode, in release_date order, and clears legacy_shape", async () => {
    const showId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, legacy_shape) VALUES ('course','My Course','my course',1,1,'downloaded','collection')`
          )
          .run()
      ).lastInsertRowid
    );
    await db
      .prepare(`INSERT INTO sub_items (media_item_id, title, release_date, has_file, file_path, monitored) VALUES (?, 'Second Lesson', '2020-02-01', 1, '/l2.mp4', 1)`)
      .run(showId);
    await db
      .prepare(`INSERT INTO sub_items (media_item_id, title, release_date, has_file, file_path, monitored) VALUES (?, 'First Lesson', '2020-01-01', 1, '/l1.mp4', 1)`)
      .run(showId);

    const result = await convertLibraryToEpisodic("course");

    expect(result).toEqual({ convertedShows: 1, convertedEpisodes: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS c FROM sub_items WHERE media_item_id = ?").get(showId)).toMatchObject({ c: 0 });
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(episodes.map((e) => ({ season: e.season_number, episode: e.episode_number, title: e.title, file_path: e.file_path }))).toEqual([
      { season: 1, episode: 1, title: "First Lesson", file_path: "/l1.mp4" },
      { season: 1, episode: 2, title: "Second Lesson", file_path: "/l2.mp4" },
    ]);
    const show = (await db.prepare("SELECT legacy_shape FROM media_items WHERE id = ?").get(showId)) as { legacy_shape: string | null };
    expect(show.legacy_shape).toBeNull();
  });

  it("adult: turns a legacy single-file item into a show with exactly one episode, and clears the item's own file fields", async () => {
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, quality, status, legacy_shape) VALUES ('adult','Some Studio Scene','some studio scene',1,1,'/clip.mp4','WEBDL-1080p','downloaded','single')`
          )
          .run()
      ).lastInsertRowid
    );

    const result = await convertLibraryToEpisodic("adult");

    expect(result).toEqual({ convertedShows: 1, convertedEpisodes: 1 });
    const ep = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").get(id)) as any;
    expect(ep).toMatchObject({ season_number: 1, episode_number: 1, title: "Some Studio Scene", has_file: 1, file_path: "/clip.mp4", quality: "WEBDL-1080p" });
    const show = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
    expect(show.legacy_shape).toBeNull();
    expect(show.path).toBeNull();
    expect(show.quality).toBeNull();
  });

  it("only touches rows actually stamped legacy_shape — an already-converted item of the same type is left alone", async () => {
    const convertedId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('course','Already Converted','already converted',1,1,'downloaded')`).run())
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Existing Episode',1,1)`).run(convertedId);

    const result = await convertLibraryToEpisodic("course");

    expect(result).toEqual({ convertedShows: 0, convertedEpisodes: 0 });
    const episodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(convertedId)) as any[];
    expect(episodes).toHaveLength(1); // unchanged, not duplicated
  });

  it("rejects a type Convert to Episodic doesn't support", async () => {
    await expect(convertLibraryToEpisodic("movie")).rejects.toThrow();
  });
});
