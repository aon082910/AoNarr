import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

const notifyImported = vi.fn();
const notifyUpgraded = vi.fn();
const notifyManualInteractionRequired = vi.fn();
vi.mock("../src/services/notifications.js", () => ({
  notifyImported: (...args: unknown[]) => notifyImported(...args),
  notifyUpgraded: (...args: unknown[]) => notifyUpgraded(...args),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
}));

const writeNfoSidecar = vi.fn();
vi.mock("../src/services/metadataExport.js", () => ({
  writeNfoSidecar: (...args: unknown[]) => writeNfoSidecar(...args),
}));

const writeAudioTags = vi.fn();
vi.mock("../src/services/audioTagWriter.js", () => ({
  writeAudioTags: (...args: unknown[]) => writeAudioTags(...args),
}));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", () => ({
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

const removeQueueItemDownload = vi.fn();
vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
}));

const syncSubtitleToVideo = vi.fn();
vi.mock("../src/services/subtitleSync.js", () => ({
  syncSubtitleToVideo: (...args: unknown[]) => syncSubtitleToVideo(...args),
}));

const convertComicImagesBestEffort = vi.fn();
vi.mock("../src/services/comicImageConvert.js", () => ({
  convertComicImagesBestEffort: (...args: unknown[]) => convertComicImagesBestEffort(...args),
}));

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

const searchSubtitles = vi.fn();
const searchCustomSubtitles = vi.fn();
const downloadSubtitleContent = vi.fn();
const downloadSubtitleFromUrl = vi.fn();
vi.mock("../src/services/subtitleClient.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    searchSubtitles: (...args: unknown[]) => searchSubtitles(...args),
    searchCustomSubtitles: (...args: unknown[]) => searchCustomSubtitles(...args),
    downloadSubtitleContent: (...args: unknown[]) => downloadSubtitleContent(...args),
    downloadSubtitleFromUrl: (...args: unknown[]) => downloadSubtitleFromUrl(...args),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let findDownloadedFile: (typeof import("../src/services/importer.js"))["findDownloadedFile"];
let listDownloadedFileCandidates: (typeof import("../src/services/importer.js"))["listDownloadedFileCandidates"];
let createLibraryFolderSkeleton: (typeof import("../src/services/importer.js"))["createLibraryFolderSkeleton"];
let placeFile: (typeof import("../src/services/importer.js"))["placeFile"];
let placeAlbumFiles: (typeof import("../src/services/importer.js"))["placeAlbumFiles"];
let placeSeasonPackFiles: (typeof import("../src/services/importer.js"))["placeSeasonPackFiles"];
let importQueueItem: (typeof import("../src/services/importer.js"))["importQueueItem"];
let removeEmptyParents: (typeof import("../src/services/importer.js"))["removeEmptyParents"];
let removeStaleImportTemps: (typeof import("../src/services/importer.js"))["removeStaleImportTemps"];
let renameLibraryFiles: (typeof import("../src/services/importer.js"))["renameLibraryFiles"];
let renameOneMediaItem: (typeof import("../src/services/importer.js"))["renameOneMediaItem"];
let ImportSkippedError: (typeof import("../src/services/importer.js"))["ImportSkippedError"];
let downloadSubtitleForLanguage: (typeof import("../src/services/importer.js"))["downloadSubtitleForLanguage"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({
    findDownloadedFile,
    listDownloadedFileCandidates,
    createLibraryFolderSkeleton,
    placeFile,
    placeAlbumFiles,
    placeSeasonPackFiles,
    importQueueItem,
    removeEmptyParents,
    removeStaleImportTemps,
    renameLibraryFiles,
    renameOneMediaItem,
    ImportSkippedError,
    downloadSubtitleForLanguage,
  } = await import("../src/services/importer.js"));
  ({ config } = await import("../src/config.js"));
  // Quality ranks decide whether a pack's file may replace an episode's existing one.
  await (await import("../src/services/quality.js")).loadQualityCaches();
  // setupTestDb() points AONARR_CONFIG_DIR and AONARR_DOWNLOADS_DIR at the SAME temp directory, so
  // config.downloadsDir also holds the app's own logs/DB — clearing it directly (as an earlier
  // version of this file did) deleted those and crashed the logger mid-run. A dedicated, fully
  // test-owned subfolder is safe to wipe completely; walk() still finds files inside it fine since
  // it recurses from config.downloadsDir.
  downloadsDir = path.join(config.downloadsDir, "test-fixtures");
  fs.mkdirSync(downloadsDir, { recursive: true });
});

// config.downloadsDir is a `const` computed once at config.js's module-load time from
// AONARR_DOWNLOADS_DIR (see config.ts) — setupTestDb() already set that env var and importer.ts's
// own `import { config }` already captured it by the time beforeAll's dynamic import resolves.
// Reassigning process.env afterward has no effect on the already-evaluated value, so every test
// must reuse this SAME fixed directory (clearing its contents) rather than pointing config at a
// fresh one per test.
let downloadsDir: string;
let libraryDir: string;

// Recreates rather than just clearing: cleanupDownloadSourceFolder's own removeEmptyParents walks
// upward from a just-removed release folder toward the real config.downloadsDir, and since
// test-fixtures is only an intermediate directory on that path, a prior test can legitimately
// remove it entirely as a "now-empty parent" — readdirSync on a missing directory would throw.
function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

beforeEach(async () => {
  await db.prepare("DELETE FROM history").run();
  await db.prepare("DELETE FROM recycle_bin").run();
  await db.prepare("DELETE FROM queue").run();
  await db.prepare("DELETE FROM download_clients").run();
  await db.prepare("DELETE FROM tracks").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();
  await db.prepare("DELETE FROM subtitle_providers").run();

  notifyImported.mockReset();
  notifyUpgraded.mockReset();
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  writeNfoSidecar.mockReset();
  writeAudioTags.mockReset();
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  removeQueueItemDownload.mockReset().mockResolvedValue(undefined);
  syncSubtitleToVideo.mockReset().mockResolvedValue(false);
  convertComicImagesBestEffort.mockReset().mockResolvedValue(undefined);
  probeMediaInfo.mockReset().mockResolvedValue(null);
  searchSubtitles.mockReset().mockResolvedValue([]);
  searchCustomSubtitles.mockReset().mockResolvedValue([]);
  downloadSubtitleContent.mockReset();
  downloadSubtitleFromUrl.mockReset();

  resetDir(downloadsDir);
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-importer-library-"));

  // Defaults matching this project's documented "on unless explicitly disabled" settings.
  setSetting("skipFreeSpaceCheck", "1"); // real free-space checks against the OS aren't worth testing here
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeNfoOnImport", "0");
  setSetting("writeAudioTagsOnImport", "0");
  setSetting("comicImageConvertEnabled", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("subtitleSyncEnabled", "0");
  setSetting("importStrategy", "move");
  // The default recycle bin lives under the config dir, which setupTestDb() makes the downloads dir
  // too — a recycled .mkv there would be a candidate for every later downloads-wide search.
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function insertRootFolder(mediaType: string): Promise<{ id: number; path: string }> {
  const p = path.join(libraryDir, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function writeDownloadFile(name: string, content = "fake bytes"): string {
  const p = path.join(downloadsDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(overrides: Record<string, unknown> = {}): Promise<any> {
  const defaults = { title: "The Matrix", sort_title: "the matrix", year: 1999, root_folder_id: null, has_file: 0, path: null, status: "missing" };
  const row = { ...defaults, ...overrides };
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, monitored, status)
       VALUES ('movie', ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(row.title, row.sort_title, row.year, row.root_folder_id, row.has_file, row.path, row.status);
  return { id: Number(result.lastInsertRowid), ...row };
}

// ---------------------------------------------------------------------------
// removeEmptyParents
// ---------------------------------------------------------------------------

describe("removeEmptyParents", () => {
  it("removes now-empty directories walking upward, stopping at the root folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-emptyparents-"));
    const nested = path.join(root, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    removeEmptyParents(nested, root);

    expect(fs.existsSync(path.join(root, "a"))).toBe(false);
    expect(fs.existsSync(root)).toBe(true); // the root folder itself is never removed
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stops as soon as it reaches a directory that still has something in it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-emptyparents-"));
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "a", "keepme.txt"), "x");

    removeEmptyParents(nested, root);

    expect(fs.existsSync(path.join(root, "a"))).toBe(true);
    expect(fs.existsSync(path.join(root, "a", "b"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// createLibraryFolderSkeleton
// ---------------------------------------------------------------------------

describe("createLibraryFolderSkeleton", () => {
  it("creates the item's top-level library folder", () => {
    createLibraryFolderSkeleton({ type: "movie", title: "New Movie", year: 2024 }, libraryDir);

    expect(fs.existsSync(path.join(libraryDir, "New Movie (2024)"))).toBe(true);
  });

  it("never throws, even for a root path that can't be created", () => {
    expect(() => createLibraryFolderSkeleton({ type: "movie", title: "X", year: null }, "\0invalid")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// findDownloadedFile / listDownloadedFileCandidates
// ---------------------------------------------------------------------------

describe("findDownloadedFile", () => {
  it("returns null when nothing in the downloads directory matches the extension at all", () => {
    writeDownloadFile("notes.txt");
    expect(findDownloadedFile("Some Movie", "movie")).toBeNull();
  });

  it("picks the file whose path has the highest token overlap with the release title", () => {
    writeDownloadFile("Completely.Unrelated.File.mkv");
    const wanted = writeDownloadFile("The.Matrix.1999.1080p.WEB-DL.mkv");

    expect(findDownloadedFile("The Matrix 1999 1080p WEB-DL", "movie")).toBe(wanted);
  });

  it("returns null when the best match's score is below the 0.4 confidence threshold", () => {
    writeDownloadFile("zzz.mkv"); // shares zero tokens with the release title
    expect(findDownloadedFile("The Matrix 1999 1080p WEB-DL REMUX", "movie")).toBeNull();
  });

  it("narrows to files that parse to the specific target episode in an episodic season pack", () => {
    const wanted = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E05.mkv"));
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E06.mkv"));

    expect(findDownloadedFile("Show S01 PACK", "series", { season: 1, episode: 5 })).toBe(wanted);
  });

  it("falls back to plain token overlap when no file parses to the exact target episode", () => {
    const wanted = writeDownloadFile("Show.S01E99.mkv"); // doesn't match season 1 episode 5, but is the only file
    expect(findDownloadedFile("Show S01E99", "series", { season: 1, episode: 5 })).toBe(wanted);
  });

  it("narrows by air date for a daily/talk-show target", () => {
    const wanted = writeDownloadFile("Show.2024.01.15.mkv");
    writeDownloadFile("Show.2024.01.16.mkv");

    expect(findDownloadedFile("Show 2024 01 15", "series", { airDate: "2024-01-15" })).toBe(wanted);
  });

  it("uses searchRoot directly when it's a single matching file", () => {
    const exact = writeDownloadFile("exact-file.mkv");
    writeDownloadFile("would-otherwise-win.mkv"); // higher token overlap, but searchRoot bypasses scoring

    expect(findDownloadedFile("would otherwise win", "movie", undefined, exact)).toBe(exact);
  });

  it("scopes scoring to searchRoot when it's a directory, ignoring files elsewhere in downloads", () => {
    const scopedDir = path.join(downloadsDir, "this-release-only");
    const wanted = writeDownloadFile(path.join("this-release-only", "movie.mkv"));
    writeDownloadFile(path.join("elsewhere", "movie.mkv")); // same name, would also score, but out of scope

    expect(findDownloadedFile("movie", "movie", undefined, scopedDir)).toBe(wanted);
  });

  it("falls through to the full downloads directory when searchRoot no longer exists", () => {
    const wanted = writeDownloadFile("The.Matrix.1999.mkv");

    expect(findDownloadedFile("The Matrix 1999", "movie", undefined, path.join(downloadsDir, "does-not-exist"))).toBe(wanted);
  });

  it("never returns another show's download just because it carries the same episode number", () => {
    writeDownloadFile(path.join("Better.Call.Saul.S01E05.1080p.WEB-DL", "Better.Call.Saul.S01E05.1080p.WEB-DL.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 })).toBeNull();
  });

  it("never returns another daily show's download just because it aired the same day", () => {
    writeDownloadFile("The.Late.Show.2024.01.15.1080p.mkv");

    expect(findDownloadedFile("The.Daily.Show.2024.01.15.1080p", "series", { airDate: "2024-01-15" })).toBeNull();
  });

  it("finds an obfuscated episode file inside the download's own folder by that folder's name", () => {
    const ownFolder = path.join(downloadsDir, "Breaking.Bad.S01E05.1080p.WEB-DL");
    const wanted = writeDownloadFile(path.join("Breaking.Bad.S01E05.1080p.WEB-DL", "a8f7d6c1.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, ownFolder)).toBe(wanted);
  });

  it("picks the target's own file from a multi-episode release folder, not the folder's first episode for every file", () => {
    const ownFolder = path.join(downloadsDir, "Show.S02E01-E04.1080p");
    const wanted = writeDownloadFile(path.join("Show.S02E01-E04.1080p", "Show.S02E01.mkv"), "e1");
    writeDownloadFile(path.join("Show.S02E01-E04.1080p", "Show.S02E02.mkv"), "e2");
    writeDownloadFile(path.join("Show.S02E01-E04.1080p", "Show.S02E03.mkv"), "the largest file of the pack");

    expect(findDownloadedFile("Show.S02E01-E04.1080p", "series", { season: 2, episode: 1 }, ownFolder)).toBe(wanted);
  });

  it("picks an anime batch's file by its own absolute number, not the batch folder's season", () => {
    const ownFolder = path.join(downloadsDir, "[Grp] Show S01 [1080p]");
    writeDownloadFile(path.join("[Grp] Show S01 [1080p]", "[Grp] Show - 04.mkv"), "e4");
    const wanted = writeDownloadFile(path.join("[Grp] Show S01 [1080p]", "[Grp] Show - 05.mkv"), "e5");
    writeDownloadFile(path.join("[Grp] Show S01 [1080p]", "[Grp] Show - 06.mkv"), "the largest file of the batch");

    expect(findDownloadedFile("[Grp] Show S01 [1080p]", "anime", { season: 1, episode: 5, absoluteEpisode: 5 }, ownFolder)).toBe(wanted);
  });

  it("never takes a file named for another episode when only the folder's range matches the target", () => {
    const pack = "Other.Show.S03E01-E04.1080p";
    const ownFolder = path.join(downloadsDir, pack);
    writeDownloadFile(path.join(pack, "Other.Show.S03E01.mkv"), "the largest file of the pack, by far");
    writeDownloadFile(path.join(pack, "Other.Show.S03E02.mkv"), "e2");
    writeDownloadFile(path.join(pack, "Other.Show.S03E04.mkv"), "e4");
    const obfuscated = writeDownloadFile(path.join(pack, "a1b2.mkv"), "e3");

    expect(findDownloadedFile(pack, "series", { season: 3, episode: 3 }, ownFolder)).toBe(obfuscated);

    fs.rmSync(obfuscated);
    expect(findDownloadedFile(pack, "series", { season: 3, episode: 3 }, ownFolder)).toBeNull();
  });

  it("never takes a decimal special for a numbered episode when no file is named for that episode", () => {
    writeDownloadFile(path.join("anime", "[Group] Show S2 - 12.5 [1080p].mkv"));

    expect(findDownloadedFile("[Group] Show S2 - 12 [1080p]", "anime", { season: 2, episode: 12 })).toBeNull();
    expect(
      findDownloadedFile("[Group] Show S2 - 13 [1080p]", "anime", { season: 2, episode: 13 }, path.join(downloadsDir, "anime"), { category: "anime" })
    ).toBeNull();
  });

  it("passes over a release's sample for its own file, unless the release is itself titled with the word", () => {
    const release = "The.Matrix.1999.1080p.BluRay.x264-GRP";
    const wanted = writeDownloadFile(path.join(release, "the.matrix.1999.1080p.mkv"), "the movie");
    writeDownloadFile(path.join(release, "Sample", "the.matrix.1999.1080p.sample.mkv"), "a sample, larger than the movie here");

    expect(findDownloadedFile(release, "movie", undefined, path.join(downloadsDir, release))).toBe(wanted);
    expect(findDownloadedFile(release, "movie")).toBe(wanted);

    const titled = "Free.Sample.2019.1080p.BluRay-GRP";
    const titledFile = writeDownloadFile(path.join(titled, "free.sample.2019.1080p.mkv"), "the movie");
    expect(findDownloadedFile(titled, "movie", undefined, path.join(downloadsDir, titled))).toBe(titledFile);
  });

  it("finds a pack's episode titled with the word 'sample', still passing over the pack's real samples", () => {
    const pack = "Show.S01.1080p.WEB-DL";
    const packDir = path.join(downloadsDir, pack);
    writeDownloadFile(path.join(pack, "Show.S01E04.The.Letter.1080p.WEB-DL.mkv"), "episode four of the pack");
    const wanted = writeDownloadFile(path.join(pack, "Show.S01E05.The.Sample.1080p.WEB-DL.mkv"), "episode five of the pack");
    writeDownloadFile(path.join(pack, "Show.S01E06.The.Party.1080p.WEB-DL.mkv"), "episode six of the pack");
    writeDownloadFile(path.join(pack, "Show.S01E05.1080p.WEB-DL-sample.mkv"), "cut");
    writeDownloadFile(path.join(pack, "Sample", "show.s01e05.sample.mkv"), "a sample, larger than the episodes here");

    expect(findDownloadedFile(pack, "series", { season: 1, episode: 5 }, packDir)).toBe(wanted);
    expect(findDownloadedFile(pack, "series", { season: 1, episode: 5 })).toBe(wanted);
  });

  it("never picks a sample of a short episode, however close its size is to the episodes'", () => {
    const pack = "Cartoon.S01.720p.WEB-DL";
    const packDir = path.join(downloadsDir, pack);
    const wanted = writeDownloadFile(path.join(pack, "Cartoon.S01E02.720p.WEB-DL.mkv"), "short episode");
    writeDownloadFile(path.join(pack, "Cartoon.S01E03.720p.WEB-DL.mkv"), "short episode");
    // Samples as large as the episodes, and bigger than them once sorted by size.
    writeDownloadFile(path.join(pack, "Cartoon.S01E02.720p.WEB-DL-sample.mkv"), "a sample cut of episode two, longer");
    writeDownloadFile(path.join(pack, "sample-cartoon.s01e02.720p.mkv"), "another sample cut of episode two");

    expect(findDownloadedFile(pack, "series", { season: 1, episode: 2 }, packDir)).toBe(wanted);
  });

  it("does not fall back to the whole downloads directory for an episode once the download's own folder exists", () => {
    const ownFolder = path.join(downloadsDir, "Breaking.Bad.S01E05.1080p.WEB-DL");
    writeDownloadFile(path.join("Breaking.Bad.S01E05.1080p.WEB-DL", "readme.txt"));
    // An older grab of the same episode, still seeding.
    writeDownloadFile(path.join("Breaking.Bad.S01E05.720p.HDTV", "Breaking.Bad.S01E05.720p.HDTV.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, ownFolder)).toBeNull();
  });

  it("requires the series title when the client reports a category folder shared with other downloads", () => {
    const categoryFolder = path.join(downloadsDir, "tv");
    writeDownloadFile(path.join("tv", "Better.Call.Saul.S01E05.1080p.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, categoryFolder)).toBeNull();

    const wanted = writeDownloadFile(path.join("tv", "Breaking.Bad.S01E05.1080p.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, categoryFolder)).toBe(wanted);
  });

  it("requires the series title in a save folder the client reports for a download with no folder of its own", () => {
    // qBittorrent reports a multi-file torrent saved without a subfolder by its save path, which
    // needn't be named for the client's category.
    const saveFolder = path.join(downloadsDir, "complete");
    writeDownloadFile(path.join("complete", "Heroes.S01E03.1080p.mkv"));

    expect(findDownloadedFile("Lost.S01.1080p.BluRay", "series", { season: 1, episode: 3 }, saveFolder, { category: "sonarr" })).toBeNull();
  });

  it("requires the series title in a save folder named only with quality words the release shares", () => {
    const saveFolder = path.join(downloadsDir, "UHD HDR");
    writeDownloadFile(path.join("UHD HDR", "Heroes.S01E03.2160p.UHD.HDR.mkv"));

    expect(findDownloadedFile("Lost.S01.2160p.UHD.HDR.WEB-DL", "series", { season: 1, episode: 3 }, saveFolder, { category: "tv-uhd" })).toBeNull();
  });

  it("requires the series title in a save folder named only with a pack word and a quality word the release shares", () => {
    const saveFolder = path.join(downloadsDir, "Complete 1080p");
    writeDownloadFile(path.join("Complete 1080p", "Heroes.S01E03.1080p.mkv"));

    expect(findDownloadedFile("Lost.S01.COMPLETE.1080p.BluRay", "series", { season: 1, episode: 3 }, saveFolder, { category: "tv" })).toBeNull();
  });

  it("requires every word of a multi-word title in a save folder name, not just one of them", () => {
    // A folder named for only one of "Breaking Bad"'s two words used to short-circuit as this
    // download's own folder (isSharedDownloadFolder's old `.some()` check), skipping the
    // series-title-in-path filter entirely and letting a different show's same-numbered episode
    // through on season/episode alone.
    const saveFolder = path.join(downloadsDir, "Bad Shows");
    writeDownloadFile(path.join("Bad Shows", "Other.Show.S01E05.1080p.mkv"));

    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, saveFolder)).toBeNull();

    const wanted = writeDownloadFile(path.join("Bad Shows", "Breaking.Bad.S01E05.1080p.mkv"));
    expect(findDownloadedFile("Breaking.Bad.S01E05.1080p.WEB-DL", "series", { season: 1, episode: 5 }, saveFolder)).toBe(wanted);
  });

  it("matches an indexer title's apostrophes and accents against release names that drop them", () => {
    const wanted = writeDownloadFile(path.join("Greys.Anatomy.S01E05.1080p", "Greys.Anatomy.S01E05.1080p.mkv"));
    writeDownloadFile(path.join("Pokemon.S01E05.1080p", "Pokemon.S01E05.1080p.mkv"));

    expect(findDownloadedFile("Grey's Anatomy S01E05 1080p", "series", { season: 1, episode: 5 })).toBe(wanted);
    expect(findDownloadedFile("Pokémon S01E05 1080p", "series", { season: 1, episode: 5 })).toBe(
      path.join(downloadsDir, "Pokemon.S01E05.1080p", "Pokemon.S01E05.1080p.mkv")
    );
  });

  it("tells numbered downloads apart even though their titles share every word", () => {
    const wanted = writeDownloadFile("Episode 13.mp3", "thirteen");
    writeDownloadFile("Episode 12.mp3", "twelve, still being written and already larger");

    expect(findDownloadedFile("Episode 13", "podcast")).toBe(wanted);

    fs.rmSync(wanted);
    expect(findDownloadedFile("Episode 13", "podcast")).toBeNull();
  });

  it("matches a title made only of short words by its number", () => {
    writeDownloadFile("Ep 4.mp3", "four, the larger file");
    const wanted = writeDownloadFile("Ep 5.mp3", "five");

    expect(findDownloadedFile("Ep 5", "podcast")).toBe(wanted);
  });

  it("prefers the wanted book's own file over the largest when a download holds several", () => {
    const pack = "Brandon Sanderson - Mistborn Trilogy (The Final Empire, The Well of Ascension, The Hero of Ages) epub";
    writeDownloadFile(path.join(pack, "The Final Empire.epub"), "one");
    const wanted = writeDownloadFile(path.join(pack, "The Well of Ascension.epub"), "two");
    writeDownloadFile(path.join(pack, "The Hero of Ages.epub"), "three, the largest file by far");

    expect(findDownloadedFile(pack, "author", undefined, path.join(downloadsDir, pack), { childTitle: "The Well of Ascension" })).toBe(wanted);
  });
});

describe("listDownloadedFileCandidates", () => {
  it("lists every matching-extension file, newest first", async () => {
    const older = writeDownloadFile("older.mkv");
    await new Promise((r) => setTimeout(r, 5));
    const newer = writeDownloadFile("newer.mkv");

    const candidates = listDownloadedFileCandidates("movie");

    expect(candidates.map((c) => c.path)).toEqual([newer, older]);
  });
});

describe("dangling symlinks in the downloads directory", () => {
  it("are skipped by the matcher and the manual-import picker instead of failing them", () => {
    // A debrid link whose torrent expired, left behind in a shared downloads folder.
    fs.symlinkSync(path.join(downloadsDir, "expired-debrid-target.mkv"), path.join(downloadsDir, "The.Matrix.1999.2160p.mkv"));
    const wanted = writeDownloadFile("The.Matrix.1999.1080p.mkv");

    expect(findDownloadedFile("The Matrix 1999 1080p", "movie")).toBe(wanted);
    expect(listDownloadedFileCandidates("movie").map((c) => c.path)).toEqual([wanted]);
  });

  it("returns no match rather than throwing when the only candidate dangles", () => {
    fs.symlinkSync(path.join(downloadsDir, "expired-debrid-target.mkv"), path.join(downloadsDir, "The.Matrix.1999.2160p.mkv"));
    fs.symlinkSync(path.join(downloadsDir, "expired-debrid-episode.mkv"), path.join(downloadsDir, "Show.S01E01.1080p.mkv"));

    expect(findDownloadedFile("The Matrix 1999 2160p", "movie")).toBeNull();
    expect(findDownloadedFile("Show.S01E01.1080p", "series", { season: 1, episode: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// placeFile
// ---------------------------------------------------------------------------

describe("placeFile — single shape (movie)", () => {
  it("moves the file, updates the media item, and fires notifyImported (not upgraded) for a first import", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 0 });
    const src = writeDownloadFile("source.mkv");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: "WEBDL-1080p" });

    const expectedDest = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    expect(result.destPath).toBe(expectedDest);
    expect(fs.existsSync(expectedDest)).toBe(true);
    expect(fs.existsSync(src)).toBe(false); // moved, not copied
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row).toMatchObject({ has_file: 1, path: expectedDest, quality: "WEBDL-1080p" });
    expect(notifyImported).toHaveBeenCalledTimes(1);
    expect(notifyUpgraded).not.toHaveBeenCalled();
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ?").get(movie.id)) as any;
    expect(history.event_type).toBe("imported");
  });

  it("fires notifyUpgraded instead when the item already had a file", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = writeDownloadFile("old-location.mkv");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });
    const src = writeDownloadFile("new-source.mkv");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(notifyUpgraded).toHaveBeenCalledTimes(1);
    expect(notifyImported).not.toHaveBeenCalled();
  });

  it("recycles the previous file when an upgrade changes the extension", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mp4");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(fs.readFileSync(result.destPath, "utf-8")).toBe("new");
    expect(fs.existsSync(oldPath)).toBe(false);
    const recycled = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(oldPath)) as any;
    expect(fs.readFileSync(recycled.recycle_path, "utf-8")).toBe("old");
  });

  it("replaces the file in place, recycling nothing, when the upgrade lands on the same path", async () => {
    const folder = await insertRootFolder("movie");
    const samePath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(samePath), { recursive: true });
    fs.writeFileSync(samePath, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: samePath });
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(samePath);
    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
  });

  it("hardlinks an upgrade over the library file already at the same path", async () => {
    const folder = await insertRootFolder("movie");
    const samePath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(samePath), { recursive: true });
    fs.writeFileSync(samePath, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: samePath });
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    setSetting("importStrategy", "hardlink");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(fs.existsSync(src)).toBe(true); // the download keeps seeding from its own copy
    expect(fs.readdirSync(path.dirname(samePath))).toEqual(["The Matrix (1999).mkv"]);
  });

  it("throws ImportSkippedError when the item has no root folder configured", async () => {
    const movie = await insertMovie({ root_folder_id: null });
    const src = writeDownloadFile("x.mkv");

    await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow(ImportSkippedError);
  });

  it("throws ImportSkippedError when the free-space check fails", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("x.mkv");
    setSetting("skipFreeSpaceCheck", "0");
    // Plenty free for root, almost nothing for the unprivileged server (ext4's reserved blocks).
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1, bfree: 1e15, bsize: 1 } as any);

    await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow(ImportSkippedError);
    vi.restoreAllMocks();
    expect(fs.existsSync(src)).toBe(true);
  });

  it("writes an NFO sidecar when enabled", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("x.mkv");
    setSetting("writeNfoOnImport", "1");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(writeNfoSidecar).toHaveBeenCalledTimes(1);
  });

  it("stores probed media info and size", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("x.mkv", "some content bytes");
    probeMediaInfo.mockResolvedValue({ videoCodec: "hevc" });

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(JSON.parse(row.media_info)).toEqual({ videoCodec: "hevc" });
    expect(row.size_bytes).toBe("some content bytes".length);
  });

  it("attempts a subtitle download for a video file when a provider is configured", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    await db
      .prepare("INSERT INTO subtitle_providers (name, type, api_key, languages, enabled) VALUES ('OS', 'opensubtitles', 'key', 'eng', 1)")
      .run();
    const src = writeDownloadFile("x.mkv");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(searchSubtitles).toHaveBeenCalledTimes(1);
  });

  it("never attempts a subtitle download for a non-video extension, even with a provider configured", async () => {
    const folder = await insertRootFolder("rom");
    const rom = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('rom','Game','game',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db
      .prepare("INSERT INTO subtitle_providers (name, type, api_key, languages, enabled) VALUES ('OS', 'opensubtitles', 'key', 'eng', 1)")
      .run();
    const src = writeDownloadFile("game.zip");

    await placeFile({ itemId: rom, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(searchSubtitles).not.toHaveBeenCalled();
    expect(searchCustomSubtitles).not.toHaveBeenCalled();
  });
});

describe("placeFile — episodic shape (series)", () => {
  async function insertShowWithEpisode(folderId: number, opts: { season?: number; episode?: number; hasFile?: boolean } = {}) {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Breaking Bad','breaking bad',?,1,0,'missing')`).run(folderId))
        .lastInsertRowid
    );
    const epId = Number(
      (
        await db
          .prepare(
            `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,?,?,?,1,?)`
          )
          .run(showId, opts.season ?? 1, opts.episode ?? 1, "Pilot", opts.hasFile ? 1 : 0)
      ).lastInsertRowid
    );
    return { showId, epId };
  }

  it("moves the file into a Season NN folder and updates the episode row", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    const src = writeDownloadFile("ep.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: "HDTV-720p" });

    const expectedDest = path.join(folder.path, "Breaking Bad", "Season 01", "Breaking Bad - S01E01 - Pilot.mkv");
    expect(result.destPath).toBe(expectedDest);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epId)) as any;
    expect(ep).toMatchObject({ has_file: 1, file_path: expectedDest, quality: "HDTV-720p" });
  });

  it("marks the show as having a file as soon as one of its episodes does", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    const src = writeDownloadFile("ep.mkv");

    await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    const show = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
    expect(Number(show.has_file)).toBe(1);
  });

  it("computes absoluteEpisode across seasons, excluding season 0 specials", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,0,1,'Special',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    const targetEpId = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId))
        .lastInsertRowid
    );
    setSetting("namingSeriesTemplate", "{parentTitle}/{absoluteEpisode}");
    const src = writeDownloadFile("ep2.mkv");

    const result = await placeFile({ itemId: showId, episodeId: targetEpId, subItemId: null, sourceFile: src, quality: null });

    // Absolute count = 2 (season 1 episodes 1-2), the season-0 special is excluded.
    expect(result.destPath).toBe(path.join(folder.path, "Show", "2.mkv"));
    setSetting("namingSeriesTemplate", "");
  });

  it("does not overwrite an episode that already has a file when re-run for a different source", async () => {
    // placeFile itself has no has-file guard (that's scanAndImportLibrary's job) — this documents
    // that placeFile always places whatever it's given; verifying hadFileBefore drives Upgraded.
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { hasFile: true });
    const src = writeDownloadFile("replacement.mkv");

    await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(notifyUpgraded).toHaveBeenCalledTimes(1);
  });

  it("throws ImportSkippedError for an episodic type with no episodeId given", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const src = writeDownloadFile("x.mkv");

    await expect(placeFile({ itemId: showId, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow(ImportSkippedError);
  });

  it("recognizes a multi-episode filename covers more than the one episode it was searched for, and writes both rows", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    const ep2Id = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId))
        .lastInsertRowid
    );
    // Queued/searched against episode 1 only (as every grab always is — see releaseParser.ts), but
    // the file that actually landed is a real multi-episode release covering episodes 1 AND 2.
    const src = writeDownloadFile("Breaking.Bad.S01E01-E02.HDTV-720p.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: "HDTV-720p" });

    const ep1 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epId)) as any;
    const ep2 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2Id)) as any;
    expect(ep1).toMatchObject({ has_file: 1, file_path: result.destPath, quality: "HDTV-720p" });
    expect(ep2).toMatchObject({ has_file: 1, file_path: result.destPath, quality: "HDTV-720p" });
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ? ORDER BY id").all(showId)) as any[];
    expect(history).toHaveLength(2);
    expect(history.map((h) => JSON.parse(h.data).episodeId).sort()).toEqual([epId, ep2Id].sort());
  });

  it("does not treat a same-season sibling as covered when the filename only names the one episode it was searched for", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    const ep2Id = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId))
        .lastInsertRowid
    );
    const src = writeDownloadFile("Breaking.Bad.S01E01.HDTV-720p.mkv");

    await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: "HDTV-720p" });

    const ep2 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2Id)) as any;
    expect(ep2.has_file).toBe(0);
  });

  it("does not mark the next TVDB episode downloaded when a scene-numbered file is imported for its mapped episode", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 13 });
    await db.prepare("UPDATE episodes SET scene_season_number = 1, scene_episode_number = 14 WHERE id = ?").run(epId);
    const ep14Id = Number(
      (
        await db
          .prepare(
            `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, scene_season_number, scene_episode_number)
             VALUES (?,1,14,'Ep14',1,0,1,15)`
          )
          .run(showId)
      ).lastInsertRowid
    );
    // Grabbed under the scene numbering: scene S01E14 is TVDB S01E13.
    const src = writeDownloadFile("Breaking.Bad.S01E14.HDTV-720p.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(path.basename(result.destPath)).toBe("Breaking Bad - S01E13 - Pilot.mkv");
    const ep14 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep14Id)) as any;
    expect(ep14.has_file).toBe(0);
  });

  it("maps a scene-numbered multi-episode file's extra episode through the scene numbering", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 13 });
    await db.prepare("UPDATE episodes SET scene_season_number = 1, scene_episode_number = 14 WHERE id = ?").run(epId);
    const insertScene = async (episode: number, sceneEpisode: number) =>
      Number(
        (
          await db
            .prepare(
              `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, scene_season_number, scene_episode_number)
               VALUES (?,1,?,?,1,0,1,?)`
            )
            .run(showId, episode, `Ep${episode}`, sceneEpisode)
        ).lastInsertRowid
      );
    const ep14Id = await insertScene(14, 15);
    const ep15Id = await insertScene(15, 16);
    // Scene S01E14-E15 covers TVDB E13 and E14 — not TVDB E14 and E15.
    const src = writeDownloadFile("Breaking.Bad.S01E14-E15.HDTV-720p.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(path.basename(result.destPath)).toBe("Breaking Bad - S01E13-14 - Pilot.mkv");
    const [ep14, ep15] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep14Id),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep15Id),
    ])) as any[];
    expect(ep14).toMatchObject({ has_file: 1, file_path: result.destPath });
    expect(ep15.has_file).toBe(0);
  });

  it("recycles the episode's previous file when the upgrade lands at a different path", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    // Imported back when the episode's title was still "TBA".
    const oldPath = path.join(folder.path, "Breaking Bad", "Season 01", "Breaking Bad - S01E01 - TBA.mkv");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "old");
    await db.prepare("UPDATE episodes SET has_file = 1, file_path = ? WHERE id = ?").run(oldPath, epId);
    const src = writeDownloadFile("Breaking.Bad.S01E01.1080p.mkv", "new");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(path.basename(result.destPath)).toBe("Breaking Bad - S01E01 - Pilot.mkv");
    expect(fs.readFileSync(result.destPath, "utf-8")).toBe("new");
    expect(fs.existsSync(oldPath)).toBe(false);
    const recycled = (await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(oldPath)) as any;
    expect(recycled.media_item_id).toBe(showId);
    expect(fs.readFileSync(recycled.recycle_path, "utf-8")).toBe("old");
    expect(notifyUpgraded).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous file while another episode row still points at it", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertShowWithEpisode(folder.id, { season: 1, episode: 1 });
    const sharedPath = path.join(folder.path, "Breaking Bad", "Season 01", "Breaking Bad - S01E01-02 - Pilot.mkv");
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.writeFileSync(sharedPath, "old");
    await db.prepare("UPDATE episodes SET has_file = 1, file_path = ? WHERE id = ?").run(sharedPath, epId);
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,2,'Ep2',1,1,?)`)
      .run(showId, sharedPath);
    const src = writeDownloadFile("Breaking.Bad.S01E01.1080p.mkv", "new");

    await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
  });
});

describe("placeFile — collection shape, single-file-per-child (author/book)", () => {
  it("moves the file and updates the sub-item", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Some Author','some author',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const subId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Book', 1, 0)").run(authorId)).lastInsertRowid
    );
    const src = writeDownloadFile("book.epub");

    const result = await placeFile({ itemId: authorId, episodeId: null, subItemId: subId, sourceFile: src, quality: null });

    expect(result.destPath).toBe(path.join(folder.path, "Some Author", "Some Book.epub"));
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(sub).toMatchObject({ has_file: 1, file_path: result.destPath });
  });

  it("converts a comic CBZ when comic image conversion is enabled", async () => {
    const folder = await insertRootFolder("comic");
    const seriesId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('comic','Some Comic','some comic',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const subId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Issue 1', 1, 0)").run(seriesId)).lastInsertRowid
    );
    setSetting("comicImageConvertEnabled", "1");
    setSetting("comicImageFormat", "webp");
    const src = writeDownloadFile("issue1.cbz");

    await placeFile({ itemId: seriesId, episodeId: null, subItemId: subId, sourceFile: src, quality: null });

    expect(convertComicImagesBestEffort).toHaveBeenCalledWith(expect.stringContaining("Issue 1.cbz"), "webp", expect.any(Number));
  });
});

describe("placeFile — an item not yet converted to its type's current shape", () => {
  it("places an unconverted Adult item's file as the single-file item it still is", async () => {
    const folder = await insertRootFolder("adult");
    const itemId = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status, legacy_shape)
             VALUES ('adult', 'Some Scene', 'some scene', 2020, ?, 1, 0, 'missing', 'single')`
          )
          .run(folder.id)
      ).lastInsertRowid
    );
    const src = writeDownloadFile("Some.Scene.2020.1080p.mkv");

    const result = await placeFile({ itemId, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(path.join(folder.path, "Some Scene (2020)", "Some Scene (2020).mkv"));
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(itemId)) as any;
    expect(row).toMatchObject({ has_file: 1, path: result.destPath });
  });
});

describe("downloadSubtitleForLanguage", () => {
  it("asks OpenSubtitles for a three-letter language by its two-letter code, and names the file by the configured one", async () => {
    const movie = await insertMovie();
    const video = path.join(libraryDir, "Movie.mkv");
    fs.writeFileSync(video, "video");
    searchSubtitles.mockResolvedValue([
      { language: "fr", releaseName: "Movie", fileId: 1, downloadUrl: "", provider: "opensubtitles", downloadCount: 99 },
      { language: "en", releaseName: "Movie", fileId: 2, downloadUrl: "", provider: "opensubtitles", downloadCount: 5 },
    ]);
    downloadSubtitleContent.mockResolvedValue("1\n00:00:01,000 --> 00:00:02,000\nHello\n");

    const downloaded = await downloadSubtitleForLanguage(video, movie.id, "eng", { type: "opensubtitles", api_key: "key", languages: "eng", config: null }, false);

    expect(downloaded).toBe(true);
    expect(searchSubtitles.mock.calls[0][2]).toBe("en");
    expect(downloadSubtitleContent).toHaveBeenCalledWith("key", 2);
    expect(fs.readFileSync(path.join(libraryDir, "Movie.eng.srt"), "utf-8")).toContain("Hello");
  });
});

describe("library paths built from titles", () => {
  async function insertSeries(folderId: number, title: string, episodeTitle: string): Promise<{ showId: number; epId: number }> {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series',?,?,?,1,0,'missing')`)
          .run(title, title.toLowerCase(), folderId)
      ).lastInsertRowid
    );
    const epId = Number(
      (
        await db
          .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,?,1,0)`)
          .run(showId, episodeTitle)
      ).lastInsertRowid
    );
    return { showId, epId };
  }

  it("keeps a '/' inside a title as part of the name instead of an extra folder", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id, title: "Face/Off", sort_title: "face/off", year: 1997 });
    const src = writeDownloadFile("Face.Off.1997.mkv");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(path.join(folder.path, "Face-Off (1997)", "Face-Off (1997).mkv"));
    expect(fs.readdirSync(folder.path)).toEqual(["Face-Off (1997)"]);
  });

  it("never lets an episode title climb out of the root folder", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertSeries(folder.id, "Breaking Bad", "x/../../../../../config/x");
    const src = writeDownloadFile("Breaking.Bad.S01E01.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(path.join(folder.path, "Breaking Bad", "Season 01", "Breaking Bad - S01E01 - x-..-..-..-..-..-config-x.mkv"));
    expect(fs.existsSync(result.destPath)).toBe(true);
  });

  it("turns a series title of '..' into a placeholder folder rather than the root's parent", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epId } = await insertSeries(folder.id, "..", "Pilot");
    const src = writeDownloadFile("show.s01e01.mkv");

    const result = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(path.join(folder.path, "_", "Season 01", ".. - S01E01 - Pilot.mkv"));
  });

  it("neutralizes '..' levels written into a naming template itself", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("x.mkv");
    setSetting("namingMovieTemplate", "../../{title} ({year})/{title} ({year})");
    try {
      const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

      expect(result.destPath).toBe(path.join(folder.path, "_", "_", "The Matrix (1999)", "The Matrix (1999).mkv"));
    } finally {
      setSetting("namingMovieTemplate", "");
    }
  });

  it("creates the skeleton folder for a title holding '../' inside the root folder", () => {
    createLibraryFolderSkeleton({ type: "movie", title: "../../escape", year: 2024 }, libraryDir);

    expect(fs.readdirSync(libraryDir)).toContain("..-..-escape (2024)");
  });
});

describe("placeFile — another entry's file at the destination", () => {
  it("gives a same-titled sibling with no date a file named with its id, leaving the first file intact", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Some Author','some author',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const insertBook = async () =>
      Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Bonus Episode', 1, 0)").run(authorId)).lastInsertRowid);
    const firstId = await insertBook();
    const secondId = await insertBook();
    const first = writeDownloadFile("first.epub", "first");
    const second = writeDownloadFile("second.epub", "second");

    const placed = await placeFile({ itemId: authorId, episodeId: null, subItemId: firstId, sourceFile: first, quality: null });
    const placedSecond = await placeFile({ itemId: authorId, episodeId: null, subItemId: secondId, sourceFile: second, quality: null });

    expect(placed.destPath).toBe(path.join(folder.path, "Some Author", "Bonus Episode.epub"));
    expect(placedSecond.destPath).toBe(path.join(folder.path, "Some Author", `Bonus Episode [${secondId}].epub`));
    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("first");
    expect(fs.readFileSync(placedSecond.destPath, "utf-8")).toBe("second");
    const secondRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(secondId)) as any;
    expect(secondRow).toMatchObject({ has_file: 1, file_path: placedSecond.destPath });
  });

  describe("same-titled podcast episodes", () => {
    async function insertPodcastEpisodes(folderId: number): Promise<{ showId: number; firstId: number; secondId: number }> {
      const showId = Number(
        (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('podcast','Some Show','some show',?,1,0,'missing')`).run(folderId))
          .lastInsertRowid
      );
      const insertEpisode = async (releaseDate: string) =>
        Number(
          (await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'Bonus Episode', ?, 1, 0)").run(showId, releaseDate))
            .lastInsertRowid
        );
      return { showId, firstId: await insertEpisode("2024-01-05"), secondId: await insertEpisode("2024-02-09") };
    }

    it("imports both, the later one under a name carrying its release date, and keeps it there on a re-import", async () => {
      const folder = await insertRootFolder("podcast");
      const { showId, firstId, secondId } = await insertPodcastEpisodes(folder.id);
      const first = writeDownloadFile("bonus-a.mp3", "january bonus");
      const second = writeDownloadFile("bonus-b.mp3", "february bonus");

      const one = await placeFile({ itemId: showId, episodeId: null, subItemId: firstId, sourceFile: first, quality: null });
      const two = await placeFile({ itemId: showId, episodeId: null, subItemId: secondId, sourceFile: second, quality: null });

      expect(one.destPath).toBe(path.join(folder.path, "Some Show", "Bonus Episode.mp3"));
      expect(two.destPath).toBe(path.join(folder.path, "Some Show", "Bonus Episode (2024-02-09).mp3"));
      expect(fs.readFileSync(one.destPath, "utf-8")).toBe("january bonus");
      expect(fs.readFileSync(two.destPath, "utf-8")).toBe("february bonus");
      const rows = (await db.prepare("SELECT id, has_file, file_path FROM sub_items WHERE media_item_id = ? ORDER BY id").all(showId)) as any[];
      expect(rows.map((r) => [Number(r.has_file), r.file_path])).toEqual([
        [1, one.destPath],
        [1, two.destPath],
      ]);

      const again = writeDownloadFile("bonus-b-v2.mp3", "february bonus, re-downloaded");
      const three = await placeFile({ itemId: showId, episodeId: null, subItemId: secondId, sourceFile: again, quality: null });

      expect(three.destPath).toBe(two.destPath);
      expect(fs.readFileSync(three.destPath, "utf-8")).toBe("february bonus, re-downloaded");
      expect(fs.readFileSync(one.destPath, "utf-8")).toBe("january bonus");
    });

    it("leaves both where they are on Organize & Rename, and its preview reports no conflict", async () => {
      const folder = await insertRootFolder("podcast");
      const { showId, firstId, secondId } = await insertPodcastEpisodes(folder.id);
      const one = await placeFile({ itemId: showId, episodeId: null, subItemId: firstId, sourceFile: writeDownloadFile("bonus-a.mp3", "january"), quality: null });
      const two = await placeFile({ itemId: showId, episodeId: null, subItemId: secondId, sourceFile: writeDownloadFile("bonus-b.mp3", "february"), quality: null });

      const preview = await renameOneMediaItem(showId, undefined, true);
      expect(preview).toMatchObject({ renamed: [], errors: [] });
      const result = await renameOneMediaItem(showId);
      expect(result).toMatchObject({ renamed: [], errors: [] });

      expect(fs.readFileSync(one.destPath, "utf-8")).toBe("january");
      expect(fs.readFileSync(two.destPath, "utf-8")).toBe("february");
    });

    it("gives each its own name when a template change renames them both", async () => {
      const folder = await insertRootFolder("podcast");
      const { showId, firstId, secondId } = await insertPodcastEpisodes(folder.id);
      await placeFile({ itemId: showId, episodeId: null, subItemId: firstId, sourceFile: writeDownloadFile("bonus-a.mp3", "january"), quality: null });
      await placeFile({ itemId: showId, episodeId: null, subItemId: secondId, sourceFile: writeDownloadFile("bonus-b.mp3", "february"), quality: null });
      setSetting("namingPodcastTemplate", "{parentTitle}/Episodes/{childTitle}");
      try {
        const result = await renameOneMediaItem(showId);

        expect(result.errors).toEqual([]);
        const rows = (await db.prepare("SELECT file_path FROM sub_items WHERE media_item_id = ? ORDER BY id").all(showId)) as any[];
        const episodesDir = path.join(folder.path, "Some Show", "Episodes");
        expect(rows.map((r) => r.file_path)).toEqual([path.join(episodesDir, "Bonus Episode.mp3"), path.join(episodesDir, "Bonus Episode (2024-02-09).mp3")]);
        expect(rows.map((r) => fs.readFileSync(r.file_path, "utf-8"))).toEqual(["january", "february"]);
      } finally {
        setSetting("namingPodcastTemplate", "");
      }
    });

    it("puts the date on the file's own name when naming is disabled", async () => {
      const folder = await insertRootFolder("podcast");
      const { showId, firstId, secondId } = await insertPodcastEpisodes(folder.id);
      const first = writeDownloadFile(path.join("feed-a", "episode.mp3"), "january bonus");
      const second = writeDownloadFile(path.join("feed-b", "episode.mp3"), "february bonus");
      setSetting("namingEnabledPodcast", "0");
      try {
        const one = await placeFile({ itemId: showId, episodeId: null, subItemId: firstId, sourceFile: first, quality: null });
        const two = await placeFile({ itemId: showId, episodeId: null, subItemId: secondId, sourceFile: second, quality: null });

        expect(one.destPath).toBe(path.join(folder.path, "Some Show", "episode.mp3"));
        expect(two.destPath).toBe(path.join(folder.path, "Some Show", "episode (2024-02-09).mp3"));
        expect(fs.readFileSync(one.destPath, "utf-8")).toBe("january bonus");
      } finally {
        setSetting("namingEnabledPodcast", "1");
      }
    });
  });

  it("refuses to overwrite another item's file that renders the same path", async () => {
    const folder = await insertRootFolder("rom");
    const insertRom = async () =>
      Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('rom','Sonic the Hedgehog','sonic the hedgehog',1991,?,1,0,'missing')`)
            .run(folder.id)
        ).lastInsertRowid
      );
    const genesis = await insertRom();
    const masterSystem = await insertRom();
    const genesisZip = writeDownloadFile("sonic-genesis.zip", "genesis");
    const smsZip = writeDownloadFile("sonic-sms.zip", "master system");

    const placed = await placeFile({ itemId: genesis, episodeId: null, subItemId: null, sourceFile: genesisZip, quality: null });
    await expect(placeFile({ itemId: masterSystem, episodeId: null, subItemId: null, sourceFile: smsZip, quality: null })).rejects.toThrow(ImportSkippedError);

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("genesis");
    expect(fs.existsSync(smsZip)).toBe(true);
  });

  it("still replaces the item's own previous file on an upgrade", async () => {
    const folder = await insertRootFolder("movie");
    const samePath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(samePath), { recursive: true });
    fs.writeFileSync(samePath, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: samePath });
    const src = writeDownloadFile("upgrade.mkv", "new");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
  });

  it("refuses a second file of one batch for an episode the batch already filled", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const epId = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Pilot',1,0)`).run(showId))
        .lastInsertRowid
    );
    const real = writeDownloadFile(path.join("Show.S01E01.720p", "Show.S01E01.720p.mkv"), "REAL EPISODE");
    const sample = writeDownloadFile(path.join("Show.S01E01.720p", "Show.S01E01.720p.sample.mkv"), "sample");
    const batchClaims = new Set<string>();

    const placed = await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: real, quality: null, batchClaims });
    await expect(placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: sample, quality: null, batchClaims })).rejects.toThrow(
      ImportSkippedError
    );

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("REAL EPISODE");
    expect(fs.readFileSync(sample, "utf-8")).toBe("sample");
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epId)) as any;
    expect(ep.file_path).toBe(placed.destPath);
  });

  describe("a multi-episode file in a batch that already filled one of its episodes", () => {
    async function insertTwoEpisodes(): Promise<{ folderPath: string; showId: number; ep1: number; ep2: number }> {
      const folder = await insertRootFolder("series");
      const showId = Number(
        (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
          .lastInsertRowid
      );
      const insertEpisode = async (n: number, title: string) =>
        Number(
          (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, title))
            .lastInsertRowid
        );
      return { folderPath: folder.path, showId, ep1: await insertEpisode(1, "One"), ep2: await insertEpisode(2, "Two") };
    }

    it("places it for the episode it was mapped to, leaving the earlier file on the other one", async () => {
      const { folderPath, showId, ep1, ep2 } = await insertTwoEpisodes();
      const e02 = writeDownloadFile("Show.S01E02.mkv", "episode two");
      const e01e02 = writeDownloadFile("Show.S01E01E02.mkv", "episodes one and two");
      const batchClaims = new Set<string>();

      const first = await placeFile({ itemId: showId, episodeId: ep2, subItemId: null, sourceFile: e02, quality: null, batchClaims });
      const second = await placeFile({ itemId: showId, episodeId: ep1, subItemId: null, sourceFile: e01e02, quality: null, batchClaims });

      expect(second.destPath).toBe(path.join(folderPath, "Show", "Season 01", "Show - S01E01 - One.mkv"));
      const rows = (await db.prepare("SELECT id, has_file, file_path FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
      expect(rows.map((r) => [Number(r.has_file), r.file_path])).toEqual([
        [1, second.destPath],
        [1, first.destPath],
      ]);
      expect(fs.readFileSync(first.destPath, "utf-8")).toBe("episode two");
      expect(fs.readFileSync(second.destPath, "utf-8")).toBe("episodes one and two");
      expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
    });

    it("records it only for the episodes next to its own that the batch left free", async () => {
      const { folderPath, showId, ep1, ep2 } = await insertTwoEpisodes();
      await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,3,'Three',1,0)`).run(showId);
      const e02 = writeDownloadFile("Show.S01E02.mkv", "episode two");
      const e01to03 = writeDownloadFile("Show.S01E01E02E03.mkv", "episodes one to three");
      const batchClaims = new Set<string>();

      const first = await placeFile({ itemId: showId, episodeId: ep2, subItemId: null, sourceFile: e02, quality: null, batchClaims });
      const second = await placeFile({ itemId: showId, episodeId: ep1, subItemId: null, sourceFile: e01to03, quality: null, batchClaims });

      expect(second.destPath).toBe(path.join(folderPath, "Show", "Season 01", "Show - S01E01 - One.mkv"));
      const rows = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
      expect(rows.map((r) => [Number(r.has_file), r.file_path])).toEqual([
        [1, second.destPath],
        [1, first.destPath],
        [0, null],
      ]);
      expect(fs.readFileSync(first.destPath, "utf-8")).toBe("episode two");
      const history = (await db.prepare("SELECT data FROM history WHERE event_type = 'imported' ORDER BY id").all()) as any[];
      expect(history.map((h) => JSON.parse(h.data).episodeId)).toEqual([ep2, ep1]);
    });

    it("names the episode the batch already filled when refusing a file mapped to it", async () => {
      const { showId, ep1, ep2 } = await insertTwoEpisodes();
      const e01e02 = writeDownloadFile("Show.S01E01E02.mkv", "episodes one and two");
      const e02 = writeDownloadFile("Show.S01E02.mkv", "episode two");
      const batchClaims = new Set<string>();

      await placeFile({ itemId: showId, episodeId: ep1, subItemId: null, sourceFile: e01e02, quality: null, batchClaims });
      await expect(placeFile({ itemId: showId, episodeId: ep2, subItemId: null, sourceFile: e02, quality: null, batchClaims })).rejects.toThrow(
        "S01E02 already got a file from this import"
      );
      expect(fs.readFileSync(e02, "utf-8")).toBe("episode two");
    });
  });

  it("refuses a second file of one batch for the same movie, even with another extension", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const first = writeDownloadFile("The.Matrix.1999.mkv", "the movie");
    const second = writeDownloadFile("The.Matrix.1999.trailer.mp4", "a trailer");
    const batchClaims = new Set<string>();

    const placed = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: first, quality: null, batchClaims });
    await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: second, quality: null, batchClaims })).rejects.toThrow(
      ImportSkippedError
    );

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("the movie");
    expect(fs.existsSync(second)).toBe(true);
    const row = (await db.prepare("SELECT path FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row.path).toBe(placed.destPath);
    expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
  });

  it("lets a batch retry a row whose earlier file failed to move", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const missing = path.join(downloadsDir, "gone.mkv");
    const good = writeDownloadFile("The.Matrix.1999.mkv", "the movie");
    const batchClaims = new Set<string>();

    await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: missing, quality: null, batchClaims })).rejects.toThrow();
    const placed = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: good, quality: null, batchClaims });

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("the movie");
  });
});

describe("placeFile — how the file is put in place", () => {
  function exdevOnceFor(src: string) {
    const realRename = fs.renameSync;
    return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === src) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return realRename(from, to);
    });
  }

  async function insertMovieWithFile(folder: { id: number; path: string }): Promise<{ movie: any; samePath: string }> {
    const samePath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(samePath), { recursive: true });
    fs.writeFileSync(samePath, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: samePath });
    return { movie, samePath };
  }

  it("copies a cross-device upgrade beside the library file and swaps it in", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    const rename = exdevOnceFor(src);
    try {
      await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readdirSync(path.dirname(samePath))).toEqual(["The Matrix (1999).mkv"]);
  });

  it("leaves the existing library file intact when a cross-device copy fails partway", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    const rename = exdevOnceFor(src);
    const copy = vi.spyOn(fsp, "copyFile").mockImplementation(async (_from, to) => {
      fs.writeFileSync(String(to), "ne");
      throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" });
    });
    try {
      await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow("EIO");
    } finally {
      copy.mockRestore();
      rename.mockRestore();
    }

    expect(fs.readFileSync(samePath, "utf-8")).toBe("old");
    expect(fs.readdirSync(path.dirname(samePath))).toEqual(["The Matrix (1999).mkv"]);
    expect(fs.readFileSync(src, "utf-8")).toBe("new");
  });

  it("clears a partial copy an earlier interrupted import left beside the destination, but not a fresh one", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    const dir = path.dirname(samePath);
    const stale = path.join(dir, ".aonarr-tmp-0123456789ab");
    const fresh = path.join(dir, ".aonarr-tmp-ba9876543210");
    fs.writeFileSync(stale, "half of an old copy");
    fs.writeFileSync(fresh, "another copy still running");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    const rename = exdevOnceFor(src);
    try {
      await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(fs.readdirSync(dir).sort()).toEqual([".aonarr-tmp-ba9876543210", "The Matrix (1999).mkv"]);
  });

  it("never clears the temp of a copy still in progress, however old its mtime", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    const rename = exdevOnceFor(src);
    const realCopy = fsp.copyFile;
    // The copy's mtime carried over from an old source (as macOS copyfile does), and another
    // import sweeping the same folder while it is still in flight.
    const copy = vi.spyOn(fsp, "copyFile").mockImplementation(async (from, to) => {
      await realCopy(from, to);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(String(to), old, old);
      removeStaleImportTemps(path.dirname(String(to)));
    });
    try {
      await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });
    } finally {
      copy.mockRestore();
      rename.mockRestore();
    }

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(fs.readdirSync(path.dirname(samePath))).toEqual(["The Matrix (1999).mkv"]);
  });

  it("clears the partial copy a killed import left as soon as that same import is retried", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    const dir = path.dirname(samePath);
    const src = writeDownloadFile("The.Matrix.1999.2160p.mkv", "new");
    const rename = exdevOnceFor(src);
    // A killed process runs no cleanup, so the first attempt's half-written temp stays behind.
    let leftover = "";
    const copy = vi.spyOn(fsp, "copyFile").mockImplementationOnce(async (_from, to) => {
      leftover = String(to);
      fs.writeFileSync(leftover, "ne");
      throw new Error("killed mid-copy");
    });
    const rm = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => undefined);
    try {
      await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow("killed mid-copy");
      copy.mockRestore();
      rm.mockRestore();
      expect(fs.readdirSync(dir).sort()).toEqual([path.basename(leftover), "The Matrix (1999).mkv"].sort());

      await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });
    } finally {
      copy.mockRestore();
      rm.mockRestore();
      rename.mockRestore();
    }

    expect(fs.readFileSync(samePath, "utf-8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["The Matrix (1999).mkv"]);
  });

  it("hardlinks a destination whose name alone is close to the filesystem's length limit", async () => {
    const folder = await insertRootFolder("movie");
    const title = "A".repeat(235); // "<title> (1999).mkv" is 246 bytes, under NAME_MAX (255)
    const movie = await insertMovie({ root_folder_id: folder.id, title, sort_title: title.toLowerCase() });
    const src = writeDownloadFile("long.mkv", "bytes");
    setSetting("importStrategy", "hardlink");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(path.basename(result.destPath)).toBe(`${title} (1999).mkv`);
    expect(fs.readFileSync(result.destPath, "utf-8")).toBe("bytes");
    expect(fs.readdirSync(path.dirname(result.destPath))).toEqual([`${title} (1999).mkv`]);
  });

  it("symlinks over a dangling link left at the destination", async () => {
    const folder = await insertRootFolder("movie");
    const dest = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(path.join(libraryDir, "expired-debrid-file.mkv"), dest);
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 0 });
    const src = writeDownloadFile("The.Matrix.1999.mkv", "from the mount");
    setSetting("importStrategy", "symlink");

    const result = await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(result.destPath).toBe(dest);
    expect(fs.readlinkSync(dest)).toBe(path.resolve(src));
    expect(fs.readFileSync(dest, "utf-8")).toBe("from the mount");
  });

  it("never replaces a library file with a link to itself when it's imported onto its own path", async () => {
    const folder = await insertRootFolder("movie");
    const { movie, samePath } = await insertMovieWithFile(folder);
    setSetting("importStrategy", "symlink");

    await placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: samePath, quality: null });

    expect(fs.lstatSync(samePath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(samePath, "utf-8")).toBe("old");
  });

  it("applies the configured folder permissions to every folder it creates, not just the deepest", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const epId = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Pilot',1,0)`).run(showId))
        .lastInsertRowid
    );
    const src = writeDownloadFile("Show.S01E01.mkv");
    setSetting("setPermissionsEnabled", "1");
    setSetting("folderChmod", "770");

    await placeFile({ itemId: showId, episodeId: epId, subItemId: null, sourceFile: src, quality: null });

    expect(fs.statSync(path.join(folder.path, "Show")).mode & 0o777).toBe(0o770);
    expect(fs.statSync(path.join(folder.path, "Show", "Season 01")).mode & 0o777).toBe(0o770);
  });
});

// ---------------------------------------------------------------------------
// placeAlbumFiles
// ---------------------------------------------------------------------------

describe("placeAlbumFiles", () => {
  async function insertArtistAlbum(folderId: number) {
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Some Artist','some artist',?,1,0,'missing')`).run(folderId))
        .lastInsertRowid
    );
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artistId)).lastInsertRowid
    );
    return { artistId, albumId };
  }

  it("moves every sibling audio file next to the anchor and matches tracks by leading number", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Track One')").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Track Two')").run(albumId);
    const anchor = writeDownloadFile(path.join("Some.Album.2020", "01 - Track One.mp3"));
    writeDownloadFile(path.join("Some.Album.2020", "02 - Track Two.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(result.fileCount).toBe(2);
    expect(result.destFolder).toBe(path.join(folder.path, "Some Artist", "Some Album"));
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albumId)) as any[];
    expect(tracks.every((t) => t.has_file === 1)).toBe(true);
    const album = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(albumId)) as any;
    expect(album).toMatchObject({ has_file: 1, file_path: result.destFolder });
  });

  it("keeps an unmatched file's original filename (no track list fetched yet)", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const anchor = writeDownloadFile(path.join("Album", "weird-name.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(fs.existsSync(path.join(result.destFolder, "weird-name.mp3"))).toBe(true);
  });

  it("gives an album whose title sanitizes to nothing a placeholder folder instead of the artist folder", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    await db.prepare("UPDATE sub_items SET title = ? WHERE id = ?").run("?", albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Look at Me/Intro')").run(albumId);
    const anchor = writeDownloadFile(path.join("Album", "01 - look at me.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(result.destFolder).toBe(path.join(folder.path, "Some Artist", "_"));
    expect(fs.readdirSync(result.destFolder)).toEqual(["01 - Look at Me-Intro.mp3"]);
  });

  it("collapses a multi-disc CD1/CD2 download into one album folder with a continuous track offset", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Disc1 Track1')").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Disc1 Track2')").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 3, 'Disc2 Track1')").run(albumId);
    const anchor = writeDownloadFile(path.join("Big Album [2CD]", "CD1", "01 - a.mp3"));
    writeDownloadFile(path.join("Big Album [2CD]", "CD1", "02 - b.mp3"));
    writeDownloadFile(path.join("Big Album [2CD]", "CD2", "01 - c.mp3"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(result.fileCount).toBe(3);
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? AND has_file = 1").all(albumId)) as any[];
    expect(tracks).toHaveLength(3); // CD2's "01" correctly matched track_number 3 (offset by CD1's 2 files), not track 1 again
  });

  it("writes audio tags per track when enabled", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Track One')").run(albumId);
    setSetting("writeAudioTagsOnImport", "1");
    const anchor = writeDownloadFile(path.join("Album", "01 - Track One.mp3"));

    await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    expect(writeAudioTags).toHaveBeenCalledTimes(1);
    expect(writeAudioTags.mock.calls[0][1]).toMatchObject({ title: "Track One", artist: "Some Artist", album: "Some Album" });
  });

  it("takes only the matched file when it sits loose in the downloads root among other downloads", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    // In-process downloaders (HTTP, debrid) save straight into the downloads root itself.
    const anchor = path.join(config.downloadsDir, "01 - Track One.mp3");
    const otherDownload = path.join(config.downloadsDir, "01 - Another Albums Opener.mp3");
    fs.writeFileSync(anchor, "a");
    fs.writeFileSync(otherDownload, "b");
    try {
      const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(result.fileCount).toBe(1);
      expect(result.leftInPlace).toBe(1);
      expect(result.destFolder).toBe(path.join(folder.path, "Some Artist", "Some Album"));
      expect(fs.existsSync(otherDownload)).toBe(true);
      expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
      expect(notifyManualInteractionRequired.mock.calls[0][0]).toBe("Some Artist");
    } finally {
      fs.rmSync(anchor, { force: true });
      fs.rmSync(otherDownload, { force: true });
    }
  });

  it("takes only the matched file from a client category folder, but the whole album from the release's own folder", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const releaseTitle = "Some Artist - Some Album (2020) [MP3]";
    const loose = writeDownloadFile(path.join("music", "01 - Track One.mp3"));
    const otherDownload = writeDownloadFile(path.join("music", "02 - Another Albums Song.mp3"));

    const fromCategory = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: loose, quality: null, releaseTitle });

    expect(fromCategory.fileCount).toBe(1);
    expect(fs.existsSync(otherDownload)).toBe(true);

    const anchor = writeDownloadFile(path.join("music", "Some.Artist-Some.Album-2020-MP3", "01 - Track One.mp3"));
    writeDownloadFile(path.join("music", "Some.Artist-Some.Album-2020-MP3", "02 - Track Two.mp3"));

    const fromReleaseFolder = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null, releaseTitle });

    expect(fromReleaseFolder.fileCount).toBe(2);
  });

  it("takes every track named for the release from a shared folder, and asks for a manual import of the rest", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const releaseTitle = "Some Artist - Some Album (2020) [FLAC]";
    // An in-process downloader's flat layout inside a client category folder.
    const anchor = writeDownloadFile(path.join("music", "Some Artist - Some Album - 01 - Track One.flac"));
    const second = writeDownloadFile(path.join("music", "Some Artist - Some Album - 02 - Track Two.flac"));
    const otherAlbum = writeDownloadFile(path.join("music", "Other Artist - Other Album - 01 - Opener.flac"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null, releaseTitle });

    expect(result).toMatchObject({ fileCount: 2, leftInPlace: 1 });
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(path.join(result.destFolder, "Some Artist - Some Album - 02 - Track Two.flac"))).toBe(true);
    expect(fs.existsSync(otherAlbum)).toBe(true);
    expect(notifyManualInteractionRequired).toHaveBeenCalledTimes(1);
    expect(notifyManualInteractionRequired.mock.calls[0][1]).toContain("1 other audio file(s)");
  });

  it("raises no manual-import notice once every loose track in a shared folder was the release's own", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const releaseTitle = "Some Artist - Some Album (2020) [FLAC]";
    const anchor = writeDownloadFile(path.join("music", "Some Artist - Some Album - 01 - Track One.flac"));
    writeDownloadFile(path.join("music", "Some Artist - Some Album - 02 - Track Two.flac"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null, releaseTitle });

    expect(result).toMatchObject({ fileCount: 2, leftInPlace: 0 });
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
  });

  it("never sweeps the same artist's other album, or a deluxe edition, out of a shared folder", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const releaseTitle = "Some Artist - Some Album (2020) [FLAC]";
    const anchor = writeDownloadFile(path.join("music", "Some Artist - Some Album - 01 - Track One.flac"));
    const otherAlbum = writeDownloadFile(path.join("music", "Some Artist - Later Album - 01 - Opener.flac"));
    const deluxe = writeDownloadFile(path.join("music", "Some Artist - Some Album (Deluxe) - 14 - Bonus.flac"));

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null, releaseTitle });

    expect(result).toMatchObject({ fileCount: 1, leftInPlace: 2 });
    expect(fs.existsSync(otherAlbum)).toBe(true);
    expect(fs.existsSync(deluxe)).toBe(true);
  });

  it("takes the whole album from its own folder named by nothing but a year-like title and a format tag", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Taylor Swift','taylor swift',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, '1989', 1, 0)").run(artistId)).lastInsertRowid);
    const anchor = writeDownloadFile(path.join("1989 [FLAC]", "01.flac"), "one");
    writeDownloadFile(path.join("1989 [FLAC]", "02.flac"), "two");
    writeDownloadFile(path.join("1989 [FLAC]", "03.flac"), "three");

    const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null, releaseTitle: "Taylor Swift - 1989 [FLAC]" });

    expect(result).toMatchObject({ fileCount: 3, leftInPlace: 0 });
    expect(fs.readdirSync(result.destFolder).sort()).toEqual(["01.flac", "02.flac", "03.flac"]);
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
  });

  describe("an artist's same-titled albums", () => {
    async function insertQueenAlbums(folderId: number, secondReleaseDate: string | null) {
      const artistId = Number(
        (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Queen','queen',?,1,0,'missing')`).run(folderId))
          .lastInsertRowid
      );
      const insertAlbum = async (releaseDate: string | null) => {
        const id = Number(
          (await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'Greatest Hits', ?, 1, 0)").run(artistId, releaseDate))
            .lastInsertRowid
        );
        await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Bohemian Rhapsody')").run(id);
        return id;
      };
      return { artistId, first: await insertAlbum("1981-10-26"), second: await insertAlbum(secondReleaseDate) };
    }

    it("puts the later one in a folder named with its year, leaving the earlier one's tracks intact", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, first, second } = await insertQueenAlbums(folder.id, "1991-10-28");
      const firstAnchor = writeDownloadFile(path.join("Queen - Greatest Hits (1981)", "01 - Bohemian Rhapsody.flac"), "album one");
      const secondAnchor = writeDownloadFile(path.join("Queen - Greatest Hits II (1991)", "01 - Bohemian Rhapsody.flac"), "album two");

      const one = await placeAlbumFiles({ itemId: artistId, subItemId: first, anchorFile: firstAnchor, quality: null });
      const two = await placeAlbumFiles({ itemId: artistId, subItemId: second, anchorFile: secondAnchor, quality: null });

      expect(one.destFolder).toBe(path.join(folder.path, "Queen", "Greatest Hits"));
      expect(two.destFolder).toBe(path.join(folder.path, "Queen", "Greatest Hits (1991)"));
      const firstTrack = (await db.prepare("SELECT file_path FROM tracks WHERE sub_item_id = ?").get(first)) as any;
      const secondTrack = (await db.prepare("SELECT file_path FROM tracks WHERE sub_item_id = ?").get(second)) as any;
      expect(fs.readFileSync(firstTrack.file_path, "utf-8")).toBe("album one");
      expect(fs.readFileSync(secondTrack.file_path, "utf-8")).toBe("album two");

      // Re-importing the later album finds its own year folder again, not the earlier album's.
      const again = writeDownloadFile(path.join("Queen - Greatest Hits II (1991) [24bit]", "01 - Bohemian Rhapsody.flac"), "album two, again");
      const three = await placeAlbumFiles({ itemId: artistId, subItemId: second, anchorFile: again, quality: null });
      expect(three.destFolder).toBe(two.destFolder);
      expect(fs.readFileSync(firstTrack.file_path, "utf-8")).toBe("album one");
    });

    it("refuses the later one when it has no year to tell the folders apart", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, first, second } = await insertQueenAlbums(folder.id, null);
      const firstAnchor = writeDownloadFile(path.join("Queen - Greatest Hits (1981)", "01 - Bohemian Rhapsody.flac"), "album one");
      const secondAnchor = writeDownloadFile(path.join("Queen - Greatest Hits II", "01 - Bohemian Rhapsody.flac"), "album two");

      const one = await placeAlbumFiles({ itemId: artistId, subItemId: first, anchorFile: firstAnchor, quality: null });
      await expect(placeAlbumFiles({ itemId: artistId, subItemId: second, anchorFile: secondAnchor, quality: null })).rejects.toThrow(ImportSkippedError);

      expect(fs.readFileSync(path.join(one.destFolder, "01 - Bohemian Rhapsody.flac"), "utf-8")).toBe("album one");
      expect(fs.readFileSync(secondAnchor, "utf-8")).toBe("album two");
      const secondRow = (await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(second)) as any;
      expect(secondRow.has_file).toBe(0);
    });

    it("moves nothing when one track would land on another album's track file", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, first, second } = await insertQueenAlbums(folder.id, "1991-10-28");
      // The earlier album's folder isn't recorded on its row, but its track file is there.
      const takenTrack = path.join(folder.path, "Queen", "Greatest Hits", "02 - We Will Rock You.flac");
      fs.mkdirSync(path.dirname(takenTrack), { recursive: true });
      fs.writeFileSync(takenTrack, "album one");
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 2, 'We Will Rock You', 1, ?)").run(first, takenTrack);
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'We Will Rock You')").run(second);
      const firstSrc = writeDownloadFile(path.join("GH2", "01 - Bohemian Rhapsody.flac"), "track one");
      writeDownloadFile(path.join("GH2", "02 - We Will Rock You.flac"), "album two");

      await expect(placeAlbumFiles({ itemId: artistId, subItemId: second, anchorFile: firstSrc, quality: null })).rejects.toThrow(ImportSkippedError);

      expect(fs.readFileSync(takenTrack, "utf-8")).toBe("album one");
      expect(fs.existsSync(firstSrc)).toBe(true);
      expect(fs.existsSync(path.join(folder.path, "Queen", "Greatest Hits", "01 - Bohemian Rhapsody.flac"))).toBe(false);
    });
  });

  it("recycles a track's previous file when the re-import brings it in another format", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const oldTrack = path.join(folder.path, "Some Artist", "Some Album", "01 - Track One.mp3");
    fs.mkdirSync(path.dirname(oldTrack), { recursive: true });
    fs.writeFileSync(oldTrack, "old");
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Track One', 1, ?)").run(albumId, oldTrack);
    const anchor = writeDownloadFile(path.join("Some.Album.2020.FLAC", "01 - Track One.flac"), "new");

    await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

    const track = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").get(albumId)) as any;
    expect(track.file_path).toBe(path.join(folder.path, "Some Artist", "Some Album", "01 - Track One.flac"));
    expect(fs.existsSync(oldTrack)).toBe(false);
    expect(await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(oldTrack)).toBeDefined();
  });

  describe("multi-disc albums in one folder", () => {
    async function insertTracks(albumId: number, titles: string[]) {
      for (const [i, title] of titles.entries()) {
        await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albumId, i + 1, title);
      }
    }
    async function trackContents(albumId: number): Promise<string[]> {
      const rows = (await db.prepare("SELECT file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albumId)) as any[];
      return rows.map((r) => fs.readFileSync(r.file_path, "utf-8"));
    }

    it("maps '1-01'/'2-01' files onto consecutive tracks without moving any over another", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      await insertTracks(albumId, ["Intro", "Song", "Reprise", "Outro"]);
      const anchor = writeDownloadFile(path.join("Some Album (2CD)", "1-01 Intro.flac"), "disc 1 track 1");
      writeDownloadFile(path.join("Some Album (2CD)", "1-02 Song.flac"), "disc 1 track 2");
      writeDownloadFile(path.join("Some Album (2CD)", "2-01 Reprise.flac"), "disc 2 track 1");
      writeDownloadFile(path.join("Some Album (2CD)", "2-02 Outro.flac"), "disc 2 track 2");

      const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(result.fileCount).toBe(4);
      expect(fs.readdirSync(result.destFolder).sort()).toEqual(["01 - Intro.flac", "02 - Song.flac", "03 - Reprise.flac", "04 - Outro.flac"]);
      expect(await trackContents(albumId)).toEqual(["disc 1 track 1", "disc 1 track 2", "disc 2 track 1", "disc 2 track 2"]);
    });

    it("reads '101'-style disc and track numbers the same way", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      await insertTracks(albumId, ["Intro", "Song", "Reprise"]);
      const anchor = writeDownloadFile(path.join("Some Album", "101 Intro.flac"), "d1t1");
      writeDownloadFile(path.join("Some Album", "102 Song.flac"), "d1t2");
      writeDownloadFile(path.join("Some Album", "201 Reprise.flac"), "d2t1");

      await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(await trackContents(albumId)).toEqual(["d1t1", "d1t2", "d2t1"]);
    });

    it("reads scene-named tracks by their leading number even when the artist's name starts with digits", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      await insertTracks(albumId, ["Intro", "What Up Gangsta", "Patiently Waiting"]);
      const album = "50_Cent-Get_Rich_or_Die_Tryin-2003-GRP";
      const anchor = writeDownloadFile(path.join(album, "01-50_cent-intro.mp3"), "t1");
      writeDownloadFile(path.join(album, "02-50_cent-what_up_gangsta.mp3"), "t2");
      writeDownloadFile(path.join(album, "03-50_cent-patiently_waiting.mp3"), "t3");

      await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(await trackContents(albumId)).toEqual(["t1", "t2", "t3"]);
    });

    it("reads a track whose title starts with a number as that track, when the album isn't named disc-track", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      const titles = [...Array.from({ length: 9 }, (_, i) => `Song ${i + 1}`), "21 Guns"];
      await insertTracks(albumId, titles);
      // "10-21 Guns" alone reads like disc 10's track 21.
      const files = titles.map((title, i) => writeDownloadFile(path.join("Some Album", `${String(i + 1).padStart(2, "0")}-${title}.mp3`), `t${i + 1}`));

      await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: files[0], quality: null });

      expect(await trackContents(albumId)).toEqual(titles.map((_, i) => `t${i + 1}`));
    });

    it("gives neither of two files the one track both claim, so neither is renamed over the other", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      await insertTracks(albumId, ["Intro"]);
      const anchor = writeDownloadFile(path.join("Some Album", "01 - Intro.flac"), "studio");
      writeDownloadFile(path.join("Some Album", "01 - Intro (Live).flac"), "live");

      const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(result.fileCount).toBe(2);
      expect(fs.readFileSync(path.join(result.destFolder, "01 - Intro.flac"), "utf-8")).toBe("studio");
      expect(fs.readFileSync(path.join(result.destFolder, "01 - Intro (Live).flac"), "utf-8")).toBe("live");
    });

    it("keeps same-named files of different disc folders in their own disc folder", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      const anchor = writeDownloadFile(path.join("Big Album", "CD1", "Intro.flac"), "disc one");
      writeDownloadFile(path.join("Big Album", "CD2", "Intro.flac"), "disc two");

      const result = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(result.fileCount).toBe(2);
      expect(fs.readFileSync(path.join(result.destFolder, "CD1", "Intro.flac"), "utf-8")).toBe("disc one");
      expect(fs.readFileSync(path.join(result.destFolder, "CD2", "Intro.flac"), "utf-8")).toBe("disc two");
    });
  });

  it("places a manually picked track into its album's folder on its own, matched to its track", async () => {
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Track One')").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Track Two')").run(albumId);
    const picked = writeDownloadFile(path.join("Some.Album.2020", "01 - Track One.mp3"), "one");
    const notPicked = writeDownloadFile(path.join("Some.Album.2020", "02 - Track Two.mp3"), "two");

    const result = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: picked, quality: null });

    const albumFolder = path.join(folder.path, "Some Artist", "Some Album");
    expect(result.destPath).toBe(path.join(albumFolder, "01 - Track One.mp3"));
    expect(fs.existsSync(notPicked)).toBe(true);
    const tracks = (await db.prepare("SELECT track_number, has_file FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albumId)) as any[];
    expect(tracks.map((t) => Number(t.has_file))).toEqual([1, 0]);
    const album = (await db.prepare("SELECT has_file, file_path FROM sub_items WHERE id = ?").get(albumId)) as any;
    expect(album).toMatchObject({ has_file: 1, file_path: albumFolder });
    const artist = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(artistId)) as any;
    expect(Number(artist.has_file)).toBe(1);
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
  });

  it("matches a track picked by hand out of a category folder holding other albums' tracks", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Adele','adele',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, '25', '2015-11-20', 1, 0)").run(artistId)).lastInsertRowid
    );
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Hello')").run(albumId);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Send My Love')").run(albumId);
    const picked = writeDownloadFile(path.join("music", "01 - Hello.flac"), "hello");
    const otherAlbum = writeDownloadFile(path.join("music", "01 - Other Band Intro.flac"), "other band");

    const result = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: picked, quality: "FLAC" });

    expect(result.destPath).toBe(path.join(folder.path, "Adele", "25", "01 - Hello.flac"));
    const tracks = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albumId)) as any[];
    expect(tracks.map((t) => [Number(t.has_file), t.file_path])).toEqual([
      [1, result.destPath],
      [0, null],
    ]);
    expect(fs.readFileSync(otherAlbum, "utf-8")).toBe("other band");
  });

  describe("a two-disc album picked by hand, one disc folder at a time", () => {
    const albumDir = "AM (2013) [2CD]";
    async function insertTwoDiscAlbum(folderId: number): Promise<{ artistId: number; albumId: number; albumFolder: string }> {
      const artistId = Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Arctic Monkeys','arctic monkeys',?,1,0,'missing')`)
            .run(folderId)
        ).lastInsertRowid
      );
      const albumId = Number(
        (await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'AM', '2013-09-09', 1, 0)").run(artistId)).lastInsertRowid
      );
      for (const [i, title] of ["Do I Wanna Know", "R U Mine", "Bonus One", "Bonus Two"].entries()) {
        await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albumId, i + 1, title);
      }
      const root = (await db.prepare("SELECT path FROM root_folders WHERE id = ?").get(folderId)) as { path: string };
      return { artistId, albumId, albumFolder: path.join(root.path, "Arctic Monkeys", "AM") };
    }
    function writeDiscs(): { cd1: string[]; cd2: string[] } {
      return {
        cd1: [
          writeDownloadFile(path.join(albumDir, "CD1", "01 - Do I Wanna Know.flac"), "disc 1 track 1"),
          writeDownloadFile(path.join(albumDir, "CD1", "02 - R U Mine.flac"), "disc 1 track 2"),
        ],
        cd2: [
          writeDownloadFile(path.join(albumDir, "CD2", "01 - Bonus One.flac"), "disc 2 track 1"),
          writeDownloadFile(path.join(albumDir, "CD2", "02 - Bonus Two.flac"), "disc 2 track 2"),
        ],
      };
    }
    async function importBatches(artistId: number, albumId: number, batches: string[][]): Promise<void> {
      for (const batch of batches) {
        const batchClaims = new Set<string>();
        for (const sourceFile of batch) await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile, quality: "FLAC", batchClaims });
      }
    }
    async function trackFiles(albumId: number): Promise<[number, string | null][]> {
      const rows = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(albumId)) as any[];
      return rows.map((r) => [Number(r.has_file), r.file_path]);
    }

    it("matches a pick from the second disc folder after the first disc's files, even with the album folder not named for the artist", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, albumFolder } = await insertTwoDiscAlbum(folder.id);
      const { cd2 } = writeDiscs();

      const result = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: cd2[0], quality: "FLAC" });

      expect(result.destPath).toBe(path.join(albumFolder, "03 - Bonus One.flac"));
      expect(await trackFiles(albumId)).toEqual([
        [0, null],
        [0, null],
        [1, result.destPath],
        [0, null],
      ]);
    });

    it("matches every track when the second disc is picked while the first is still in the download", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, albumFolder } = await insertTwoDiscAlbum(folder.id);
      const { cd1, cd2 } = writeDiscs();

      await importBatches(artistId, albumId, [cd2, cd1]);

      const names = ["01 - Do I Wanna Know.flac", "02 - R U Mine.flac", "03 - Bonus One.flac", "04 - Bonus Two.flac"];
      expect(await trackFiles(albumId)).toEqual(names.map((name) => [1, path.join(albumFolder, name)]));
      expect(names.map((name) => fs.readFileSync(path.join(albumFolder, name), "utf-8"))).toEqual([
        "disc 1 track 1",
        "disc 1 track 2",
        "disc 2 track 1",
        "disc 2 track 2",
      ]);
    });

    it("never puts the second disc on the first disc's tracks once the first disc's folder was emptied by an earlier pick", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, albumFolder } = await insertTwoDiscAlbum(folder.id);
      const { cd1, cd2 } = writeDiscs();

      await importBatches(artistId, albumId, [cd1, cd2]);

      expect(fs.readFileSync(path.join(albumFolder, "01 - Do I Wanna Know.flac"), "utf-8")).toBe("disc 1 track 1");
      expect(fs.readFileSync(path.join(albumFolder, "02 - R U Mine.flac"), "utf-8")).toBe("disc 1 track 2");
      // Nothing left to count disc 1's tracks from: disc 2's files keep their names and disc folder.
      expect(fs.readFileSync(path.join(albumFolder, "CD2", "01 - Bonus One.flac"), "utf-8")).toBe("disc 2 track 1");
      expect(fs.readFileSync(path.join(albumFolder, "CD2", "02 - Bonus Two.flac"), "utf-8")).toBe("disc 2 track 2");
      expect(await trackFiles(albumId)).toEqual([
        [1, path.join(albumFolder, "01 - Do I Wanna Know.flac")],
        [1, path.join(albumFolder, "02 - R U Mine.flac")],
        [0, null],
        [0, null],
      ]);
    });

    it("never puts the second disc on the first disc's tracks when disc 1's folder is deleted outright, not merely emptied", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, albumFolder } = await insertTwoDiscAlbum(folder.id);
      const { cd1, cd2 } = writeDiscs();

      await importBatches(artistId, albumId, [cd1]);
      // Disc 1's folder is gone from disk entirely (e.g. cleaned up by the download client) —
      // unlike the "emptied" case above, fs.readdirSync(albumSourceDir) won't list it at all.
      fs.rmSync(path.dirname(cd1[0]), { recursive: true, force: true });

      const result = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: cd2[0], quality: "FLAC" });

      expect(fs.readFileSync(path.join(albumFolder, "01 - Do I Wanna Know.flac"), "utf-8")).toBe("disc 1 track 1");
      expect(fs.readFileSync(path.join(albumFolder, "02 - R U Mine.flac"), "utf-8")).toBe("disc 1 track 2");
      // Nothing left on disk to count disc 1's tracks from, so disc 2's pick is refused as track 3
      // ("Bonus One") and instead kept unmatched in its own disc folder, rather than silently
      // landing on — and colliding with — disc 1's already-imported track 1.
      expect(result.destPath).toBe(path.join(albumFolder, "CD2", "01 - Bonus One.flac"));
      expect(fs.readFileSync(result.destPath, "utf-8")).toBe("disc 2 track 1");
      expect(await trackFiles(albumId)).toEqual([
        [1, path.join(albumFolder, "01 - Do I Wanna Know.flac")],
        [1, path.join(albumFolder, "02 - R U Mine.flac")],
        [0, null],
        [0, null],
      ]);
    });

    it("refuses a pick whose destination already holds a file rather than overwriting it", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, albumFolder } = await insertTwoDiscAlbum(folder.id);
      const { cd2 } = writeDiscs();
      // Track 3 already has its file; disc 2's "01" is counted onto it from disc 1's two files.
      const existing = path.join(albumFolder, "03 - Bonus One.flac");
      fs.mkdirSync(albumFolder, { recursive: true });
      fs.writeFileSync(existing, "library copy");
      await db.prepare("UPDATE tracks SET has_file = 1, file_path = ? WHERE sub_item_id = ? AND track_number = 3").run(existing, albumId);
      await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run(albumFolder, albumId);

      await expect(placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: cd2[0], quality: "FLAC" })).rejects.toThrow(/already exists/);

      expect(fs.readFileSync(existing, "utf-8")).toBe("library copy");
      expect(fs.readFileSync(cd2[0], "utf-8")).toBe("disc 2 track 1");
    });
  });

  it("replaces a single-file audiobook found loose in the root folder with an imported download of it", async () => {
    const folder = await insertRootFolder("audiobook");
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('audiobook','Frank Herbert','frank herbert',?,1,1,'downloaded')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    const loose = path.join(folder.path, "Dune.m4b");
    fs.writeFileSync(loose, "old loose copy");
    const bookId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dune', 1, 1, ?)").run(authorId, loose)).lastInsertRowid
    );
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Dune', 1, ?)").run(bookId, loose);
    const release = "Frank Herbert - Dune (Unabridged) [M4B]";
    const anchor = writeDownloadFile(path.join(release, "Dune.m4b"), "new download");

    const result = await placeAlbumFiles({ itemId: authorId, subItemId: bookId, anchorFile: anchor, quality: null, releaseTitle: release });

    const bookFolder = path.join(folder.path, "Frank Herbert", "Dune");
    expect(result.anchorDest).toBe(path.join(bookFolder, "Dune.m4b"));
    const tracks = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ?").all(bookId)) as any[];
    expect(tracks.map((t) => [Number(t.has_file), t.file_path])).toEqual([[1, result.anchorDest]]);
    const book = (await db.prepare("SELECT has_file, file_path FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(book).toMatchObject({ has_file: 1, file_path: bookFolder });
    expect(fs.existsSync(loose)).toBe(false);
    expect(await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(loose)).toBeDefined();
    expect(fs.readFileSync(result.anchorDest!, "utf-8")).toBe("new download");
  });

  describe("a hand-picked file named like one already in the library", () => {
    it("replaces a single-file audiobook's own file, recycling the old copy", async () => {
      const folder = await insertRootFolder("audiobook");
      const authorId = Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('audiobook','Frank Herbert','frank herbert',?,1,1,'downloaded')`)
            .run(folder.id)
        ).lastInsertRowid
      );
      const bookFolder = path.join(folder.path, "Frank Herbert", "Dune");
      const existing = path.join(bookFolder, "Dune.m4b");
      fs.mkdirSync(bookFolder, { recursive: true });
      fs.writeFileSync(existing, "old copy");
      const bookId = Number(
        (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dune', 1, 1, ?)").run(authorId, bookFolder)).lastInsertRowid
      );
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Dune', 1, ?)").run(bookId, existing);
      const picked = writeDownloadFile(path.join("Frank Herbert - Dune (Unabridged) [M4B]", "Dune.m4b"), "new copy");

      const result = await placeFile({ itemId: authorId, episodeId: null, subItemId: bookId, sourceFile: picked, quality: null });

      expect(result.destPath).toBe(existing);
      expect(fs.readFileSync(existing, "utf-8")).toBe("new copy");
      const recycled = (await db.prepare("SELECT recycle_path FROM recycle_bin WHERE original_path = ?").get(existing)) as any;
      expect(fs.readFileSync(recycled.recycle_path, "utf-8")).toBe("old copy");
      const tracks = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ?").all(bookId)) as any[];
      expect(tracks.map((t) => [Number(t.has_file), t.file_path])).toEqual([[1, existing]]);
    });

    it("replaces the file of the track it matches by its own number, recycling the old copy", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      const existing = path.join(folder.path, "Some Artist", "Some Album", "01 - Rolling in the Deep.mp3");
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, "old copy");
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Rolling in the Deep', 1, ?)").run(albumId, existing);
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 2, 'Rumour Has It')").run(albumId);
      const picked = writeDownloadFile(path.join("Some.Artist-Some.Album-2011-MP3", "01 - Rolling in the Deep.mp3"), "new copy");

      const result = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: picked, quality: null });

      expect(result.destPath).toBe(existing);
      expect(fs.readFileSync(existing, "utf-8")).toBe("new copy");
      const recycled = (await db.prepare("SELECT recycle_path FROM recycle_bin WHERE original_path = ?").get(existing)) as any;
      expect(fs.readFileSync(recycled.recycle_path, "utf-8")).toBe("old copy");
      const track = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ? AND track_number = 1").get(albumId)) as any;
      expect([Number(track.has_file), track.file_path]).toEqual([1, existing]);
    });

    it("refuses a file whose title merely starts with a number, rather than replace that track's file", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      const existing = path.join(folder.path, "Some Artist", "Some Album", "07 - Song Seven.flac");
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, "library copy");
      for (let n = 1; n <= 9; n++) {
        await db
          .prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, ?, ?, ?, ?)")
          .run(albumId, n, n === 7 ? "Song Seven" : `Other Song ${n}`, n === 7 ? 1 : 0, n === 7 ? existing : null);
      }
      const picked = writeDownloadFile(path.join("Ariana Grande - 7 rings (Single)", "7 rings.flac"), "a single");

      await expect(placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: picked, quality: null })).rejects.toThrow(/already exists/);

      expect(fs.readFileSync(existing, "utf-8")).toBe("library copy");
      expect(fs.readFileSync(picked, "utf-8")).toBe("a single");
      expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
    });

    it("leaves both the library file and the download as they were when the new copy can't be completed", async () => {
      const folder = await insertRootFolder("audiobook");
      const authorId = Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('audiobook','Frank Herbert','frank herbert',?,1,1,'downloaded')`)
            .run(folder.id)
        ).lastInsertRowid
      );
      const bookFolder = path.join(folder.path, "Frank Herbert", "Dune");
      const existing = path.join(bookFolder, "Dune.m4b");
      fs.mkdirSync(bookFolder, { recursive: true });
      fs.writeFileSync(existing, "old copy");
      const bookId = Number(
        (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dune', 1, 1, ?)").run(authorId, bookFolder)).lastInsertRowid
      );
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Dune', 1, ?)").run(bookId, existing);
      const picked = writeDownloadFile(path.join("Frank Herbert - Dune (Unabridged) [M4B]", "Dune.m4b"), "new copy");
      // Another filesystem, and the disk fills up part-way through the copy.
      const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      });
      const copy = vi.spyOn(fsp, "copyFile").mockRejectedValue(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      try {
        await expect(placeFile({ itemId: authorId, episodeId: null, subItemId: bookId, sourceFile: picked, quality: null })).rejects.toThrow(/ENOSPC/);
      } finally {
        link.mockRestore();
        copy.mockRestore();
      }

      expect(fs.readFileSync(existing, "utf-8")).toBe("old copy");
      expect(fs.readdirSync(bookFolder)).toEqual(["Dune.m4b"]);
      expect(fs.readFileSync(picked, "utf-8")).toBe("new copy");
      expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
      const tracks = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ?").all(bookId)) as any[];
      expect(tracks.map((t) => [Number(t.has_file), t.file_path])).toEqual([[1, existing]]);
    });

    it("refuses an unmatched file whose name is another track's file", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId } = await insertArtistAlbum(folder.id);
      const existing = path.join(folder.path, "Some Artist", "Some Album", "Hidden Track.flac");
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, "library copy");
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, 1, 'Intro')").run(albumId);
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 2, 'Hidden Track', 1, ?)").run(albumId, existing);
      const picked = writeDownloadFile(path.join("Some Album", "Hidden Track.flac"), "another file");

      await expect(placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: picked, quality: null })).rejects.toThrow(/already exists/);

      expect(fs.readFileSync(existing, "utf-8")).toBe("library copy");
      expect(fs.readFileSync(picked, "utf-8")).toBe("another file");
      expect(await db.prepare("SELECT * FROM recycle_bin").all()).toEqual([]);
    });
  });

  it("records a manual import of an album's tracks, one call per track, as one import of the album", async () => {
    const { findRepeatedImports } = await import("../src/services/duplicates.js");
    const folder = await insertRootFolder("artist");
    const { artistId, albumId } = await insertArtistAlbum(folder.id);
    const names = ["01 - Track One.mp3", "02 - Track Two.mp3", "03 - Track Three.mp3"];
    for (const [i, name] of names.entries()) {
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albumId, i + 1, name.slice(5, -4));
    }
    const files = names.map((name) => writeDownloadFile(path.join("Some.Album.2020", name)));

    // Unbatched, as the manual-import endpoints call it today, then as one batch.
    for (const sourceFile of files) await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile, quality: "MP3-320" });

    let history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'imported'").all(artistId)) as any[];
    expect(history).toHaveLength(1);
    expect(notifyImported).toHaveBeenCalledTimes(1);
    expect(await findRepeatedImports()).toEqual([]);

    const flacs = names.map((name) => writeDownloadFile(path.join("Some.Album.2020.FLAC", name.replace(".mp3", ".flac"))));
    const batchClaims = new Set<string>();
    for (const sourceFile of flacs) await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile, quality: "FLAC", batchClaims });

    history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'imported' ORDER BY id").all(artistId)) as any[];
    expect(history.map((h) => JSON.parse(h.data).quality)).toEqual(["MP3-320", "FLAC"]);
    expect(notifyImported).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// placeSeasonPackFiles
// ---------------------------------------------------------------------------

describe("placeSeasonPackFiles", () => {
  it("imports every file it can match to a known episode of the season, leaving unmatched ones in place", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const ep1 = Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId)).lastInsertRowid);
    const ep2 = Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId)).lastInsertRowid);
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"));
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E02.mkv"));
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E99.mkv")); // no matching episode

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null });

    expect(result.episodeCount).toBe(2);
    const [row1, row2] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep1),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2),
    ])) as any[];
    expect(row1.has_file).toBe(1);
    expect(row2.has_file).toBe(1);
    // The unmatched E99 file was never moved.
    expect(fs.existsSync(path.join(downloadsDir, "Show.S01.PACK", "Show.S01E99.mkv"))).toBe(true);
  });

  it("writes a single multi-episode file in the pack to every episode row it covers", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const ep1 = Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId)).lastInsertRowid);
    const ep2 = Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId)).lastInsertRowid);
    const ep3 = Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,3,'Ep3',1,0)`).run(showId)).lastInsertRowid);
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01-E02.mkv"));
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E03.mkv"));

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null });

    expect(result.episodeCount).toBe(3);
    const [row1, row2, row3] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep1),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep3),
    ])) as any[];
    expect(row1.has_file).toBe(1);
    expect(row2.has_file).toBe(1);
    expect(row3.has_file).toBe(1);
    // Episodes 1 and 2 came from the same physical multi-episode file, so they share a path.
    expect(row1.file_path).toBe(row2.file_path);
    expect(row1.file_path).not.toBe(row3.file_path);
    const history = (await db.prepare("SELECT * FROM history WHERE media_item_id = ? ORDER BY id").all(showId)) as any[];
    expect(history).toHaveLength(3);
  });

  it("throws ImportSkippedError when not a single file in the pack matches a known episode", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E99.mkv"));

    await expect(placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null })).rejects.toThrow(ImportSkippedError);
  });

  async function insertShowWithEpisodes(folderId: number, episodeNumbers: number[]): Promise<{ showId: number; epIds: number[] }> {
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folderId))
        .lastInsertRowid
    );
    const epIds: number[] = [];
    for (const n of episodeNumbers) {
      epIds.push(
        Number(
          (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, `Ep${n}`))
            .lastInsertRowid
        )
      );
    }
    return { showId, epIds };
  }

  it("imports only this series' files from a pack left loose among other downloads", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epIds } = await insertShowWithEpisodes(folder.id, [1, 2, 3]);
    // Loose in a folder shared with other downloads (a client category folder, or the downloads root).
    const anchor = writeDownloadFile("Show.S01E01.1080p.mkv");
    writeDownloadFile("Show.S01E02.1080p.mkv");
    const otherShow = writeDownloadFile("Other.Program.S01E03.1080p.mkv");

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: "Show.S01.1080p.WEB-DL" });

    expect(result.episodeCount).toBe(2);
    expect(fs.existsSync(otherShow)).toBe(true);
    const ep3 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[2])) as any;
    expect(ep3.has_file).toBe(0);
  });

  it("does not take a parent show's loose episode for a spin-off's pack", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epIds } = await insertShowWithEpisodes(folder.id, [1, 2, 3]);
    const anchor = writeDownloadFile("Star.Trek.Discovery.S01E01.1080p.mkv");
    writeDownloadFile("Star.Trek.Discovery.S01E02.1080p.mkv");
    const parentShow = writeDownloadFile("Star.Trek.S01E03.1080p.mkv");

    const result = await placeSeasonPackFiles({
      itemId: showId,
      seasonNumber: 1,
      anchorFile: anchor,
      quality: null,
      releaseTitle: "Star.Trek.Discovery.S01.1080p.WEB-DL",
    });

    expect(result).toMatchObject({ episodeCount: 2, leftInPlace: 1 });
    expect(fs.existsSync(parentShow)).toBe(true);
    const ep3 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[2])) as any;
    expect(ep3.has_file).toBe(0);
  });

  it("takes a loose pack's episodes when its release title names the season in words", async () => {
    const folder = await insertRootFolder("series");
    const { showId } = await insertShowWithEpisodes(folder.id, [1, 2]);
    const anchor = writeDownloadFile(path.join("tv", "Show.S01E01.1080p.mkv"));
    const second = writeDownloadFile(path.join("tv", "Show.S01E02.1080p.mkv"));

    const result = await placeSeasonPackFiles({
      itemId: showId,
      seasonNumber: 1,
      anchorFile: anchor,
      quality: null,
      releaseTitle: "Show Season 1 Complete 1080p WEB-DL",
    });

    expect(result).toMatchObject({ episodeCount: 2, leftInPlace: 0 });
    expect(fs.existsSync(second)).toBe(false);
  });

  it("counts only this season's unknown episodes as unmatched, not extras, specials or other seasons", async () => {
    const folder = await insertRootFolder("series");
    const { showId } = await insertShowWithEpisodes(folder.id, [1, 2, 3]);
    const pack = "Show.S01.1080p.BluRay-GRP";
    const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"));
    writeDownloadFile(path.join(pack, "Show.S01E02.mkv"));
    const extra = writeDownloadFile(path.join(pack, "Featurettes", "Making.Of.mkv"));
    writeDownloadFile(path.join(pack, "Extras", "Show.NCOP.mkv"));
    writeDownloadFile(path.join(pack, "Show.S00E01.Special.mkv"));
    writeDownloadFile(path.join(pack, "Show.S02E01.mkv"));

    const clean = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack });

    expect(clean).toMatchObject({ episodeCount: 2, unmatchedCount: 0, leftInPlace: 0 });
    expect(fs.existsSync(extra)).toBe(true);

    const nextAnchor = writeDownloadFile(path.join("Show.S01.REPACK", "Show.S01E03.mkv"));
    writeDownloadFile(path.join("Show.S01.REPACK", "Show.S01E07.mkv"));

    const withUnknown = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: nextAnchor, quality: null, releaseTitle: "Show.S01.REPACK" });

    expect(withUnknown.unmatchedCount).toBe(1);
  });

  it("imports every episode of a pack laid out as per-episode folders, skipping samples", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epIds } = await insertShowWithEpisodes(folder.id, [1, 2]);
    const pack = "Show.S01.1080p.BluRay-GRP";
    // Each episode in its own folder, and archive extraction adds one more level.
    const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.1080p.BluRay-GRP", "show.s01e01", "show.s01e01.mkv"), "episode one");
    writeDownloadFile(path.join(pack, "Show.S01E02.1080p.BluRay-GRP", "show.s01e02", "show.s01e02.mkv"), "episode two");
    const sample = writeDownloadFile(path.join(pack, "Show.S01E01.1080p.BluRay-GRP", "Sample", "show.s01e01.sample.mkv"), "sample");

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack });

    expect(result).toMatchObject({ episodeCount: 2, unmatchedCount: 0 });
    const [row1, row2] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[0]),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[1]),
    ])) as any[];
    expect(fs.readFileSync(row1.file_path, "utf-8")).toBe("episode one");
    expect(fs.readFileSync(row2.file_path, "utf-8")).toBe("episode two");
    expect(fs.existsSync(sample)).toBe(true);
  });

  it("imports a pack's episode titled with the word 'sample' along with the rest, but not the pack's samples", async () => {
    const folder = await insertRootFolder("series");
    const { showId, epIds } = await insertShowWithEpisodes(folder.id, [1, 2]);
    const pack = "Show.S01.1080p.WEB-DL";
    const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.Pilot.1080p.WEB-DL.mkv"), "episode one of the pack");
    writeDownloadFile(path.join(pack, "Show.S01E02.The.Sample.1080p.WEB-DL.mkv"), "episode two of the pack");
    const cut = writeDownloadFile(path.join(pack, "Show.S01E01.1080p.WEB-DL-sample.mkv"), "cut");
    const sample = writeDownloadFile(path.join(pack, "Sample", "show.s01e02.sample.mkv"), "a sample, larger than the episodes here");

    const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack, downloadPath: path.join(downloadsDir, pack) });

    expect(result).toMatchObject({ episodeCount: 2, unmatchedCount: 0 });
    const [row1, row2] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[0]),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[1]),
    ])) as any[];
    expect(fs.readFileSync(row1.file_path, "utf-8")).toBe("episode one of the pack");
    expect(fs.readFileSync(row2.file_path, "utf-8")).toBe("episode two of the pack");
    expect(fs.existsSync(cut) && fs.existsSync(sample)).toBe(true);
  });

  it("collects the pack from the client-reported download folder even when its name doesn't carry the season", async () => {
    const folder = await insertRootFolder("series");
    const { showId } = await insertShowWithEpisodes(folder.id, [1, 2]);
    const pack = path.join("tv", "Show.Complete.First.Season.1080p");
    const anchor = writeDownloadFile(path.join(pack, "Episode.One", "Show.S01E01.mkv"));
    writeDownloadFile(path.join(pack, "Episode.Two", "Show.S01E02.mkv"));

    const result = await placeSeasonPackFiles({
      itemId: showId,
      seasonNumber: 1,
      anchorFile: anchor,
      quality: null,
      releaseTitle: "Show.Complete.First.Season.1080p",
      downloadPath: path.join(downloadsDir, pack),
    });

    expect(result.episodeCount).toBe(2);
  });

  describe("files not named SxxEyy", () => {
    /** `seasons` maps a season number to its episode count; `airDates` sets episodes' air dates by "SxE". */
    async function insertShow(type: string, folderId: number, seasons: Record<number, number>, airDates: Record<string, string> = {}) {
      const showId = Number(
        (
          await db
            .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES (?,'Show','show',?,1,0,'missing')`)
            .run(type, folderId)
        ).lastInsertRowid
      );
      const ids: Record<string, number> = {};
      for (const [season, count] of Object.entries(seasons)) {
        for (let n = 1; n <= count; n++) {
          ids[`${season}x${n}`] = Number(
            (
              await db
                .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?,?,?,?,?,1,0)`)
                .run(showId, Number(season), n, `Ep${n}`, airDates[`${season}x${n}`] ?? null)
            ).lastInsertRowid
          );
        }
      }
      return { showId, ids };
    }
    async function fileOf(episodeId: number): Promise<string | null> {
      const row = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(episodeId)) as any;
      return Number(row.has_file) ? fs.readFileSync(row.file_path, "utf-8") : null;
    }

    it("maps an anime batch's absolute numbers onto the season's episodes", async () => {
      const folder = await insertRootFolder("anime");
      const { showId, ids } = await insertShow("anime", folder.id, { 1: 12, 2: 3 });
      const pack = "[Grp] Show S2 [1080p]";
      const anchor = writeDownloadFile(path.join(pack, "[Grp] Show - 13.mkv"), "abs 13");
      writeDownloadFile(path.join(pack, "[Grp] Show - 14.mkv"), "abs 14");
      writeDownloadFile(path.join(pack, "[Grp] Show - 15.mkv"), "abs 15");

      const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 2, anchorFile: anchor, quality: null, releaseTitle: pack });

      expect(result).toMatchObject({ episodeCount: 3, unmatchedCount: 0 });
      expect([await fileOf(ids["2x1"]), await fileOf(ids["2x2"]), await fileOf(ids["2x3"])]).toEqual(["abs 13", "abs 14", "abs 15"]);
      expect(await fileOf(ids["1x1"])).toBeNull();
    });

    it("reads a batch numbered from 1 again as that season's own numbering", async () => {
      const folder = await insertRootFolder("anime");
      const { showId, ids } = await insertShow("anime", folder.id, { 1: 12, 2: 3 });
      const pack = "[Grp] Show S2 [1080p]";
      const anchor = writeDownloadFile(path.join(pack, "[Grp] Show - 01.mkv"), "s2 e1");
      writeDownloadFile(path.join(pack, "[Grp] Show - 02.mkv"), "s2 e2");

      await placeSeasonPackFiles({ itemId: showId, seasonNumber: 2, anchorFile: anchor, quality: null, releaseTitle: pack });

      expect([await fileOf(ids["2x1"]), await fileOf(ids["2x2"])]).toEqual(["s2 e1", "s2 e2"]);
      expect(await fileOf(ids["1x1"])).toBeNull();
    });

    it("maps a daily show's dated files by air date, and names them with it", async () => {
      const folder = await insertRootFolder("series");
      const { showId, ids } = await insertShow("series", folder.id, { 2024: 2 }, { "2024x1": "2024-01-15", "2024x2": "2024-01-16" });
      setSetting("namingSeriesTemplate", "{parentTitle}/{airDate}");
      try {
        const pack = "Show.2024.Pack.1080p";
        const anchor = writeDownloadFile(path.join(pack, "Show.2024.01.15.1080p.mkv"), "jan 15");
        writeDownloadFile(path.join(pack, "Show.2024.01.16.1080p.mkv"), "jan 16");

        const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 2024, anchorFile: anchor, quality: null, releaseTitle: pack });

        expect(result.episodeCount).toBe(2);
        expect([await fileOf(ids["2024x1"]), await fileOf(ids["2024x2"])]).toEqual(["jan 15", "jan 16"]);
        const row = (await db.prepare("SELECT file_path FROM episodes WHERE id = ?").get(ids["2024x1"])) as any;
        expect(path.basename(row.file_path)).toBe("2024-01-15.mkv");
      } finally {
        setSetting("namingSeriesTemplate", "");
      }
    });

    it("maps files named only by their episode number inside a folder named for the season", async () => {
      const folder = await insertRootFolder("series");
      const { showId, ids } = await insertShow("series", folder.id, { 1: 2 });
      const pack = "Show.S01.1080p.WEB-DL";
      const anchor = writeDownloadFile(path.join(pack, "01.mkv"), "one");
      writeDownloadFile(path.join(pack, "E02.mkv"), "two");

      await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack });

      expect([await fileOf(ids["1x1"]), await fileOf(ids["1x2"])]).toEqual(["one", "two"]);
    });

    it("marks the show as having a file", async () => {
      const folder = await insertRootFolder("series");
      const { showId } = await insertShow("series", folder.id, { 1: 1 });
      const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"));

      await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null });

      const show = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
      expect(Number(show.has_file)).toBe(1);
    });
  });

  describe("episodes that already have a file", () => {
    /** Episode 1 has a library file of `existingQuality`; episode 2 has none. */
    async function insertShowWithOneFile(folderPath: string, folderId: number, existingQuality: string) {
      const { showId, epIds } = await insertShowWithEpisodes(folderId, [1, 2]);
      const existing = path.join(folderPath, "Show", "Season 01", "Show.S01E01.Older.Release.mkv");
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, "existing file");
      await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ? WHERE id = ?").run(existing, existingQuality, epIds[0]);
      return { showId, epIds, existing };
    }

    it("leaves an episode's better file alone, keeping the pack's copy in the download", async () => {
      const folder = await insertRootFolder("series");
      const { showId, epIds, existing } = await insertShowWithOneFile(folder.path, folder.id, "Bluray-1080p");
      const pack = "Show.S01.1080p.WEB-DL";
      const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"), "web e1");
      writeDownloadFile(path.join(pack, "Show.S01E02.mkv"), "web e2");

      const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: "WEBDL-1080p", releaseTitle: pack });

      expect(result).toMatchObject({ episodeCount: 1, notUpgradedCount: 1 });
      const ep1 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[0])) as any;
      expect(ep1).toMatchObject({ file_path: existing, quality: "Bluray-1080p" });
      expect(fs.readFileSync(existing, "utf-8")).toBe("existing file");
      expect(fs.readFileSync(anchor, "utf-8")).toBe("web e1");
      const ep2 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[1])) as any;
      expect(fs.readFileSync(ep2.file_path, "utf-8")).toBe("web e2");
      expect(await db.prepare("SELECT * FROM recycle_bin").get()).toBeUndefined();
      expect(notifyImported).toHaveBeenCalledTimes(1);
      expect(notifyUpgraded).not.toHaveBeenCalled();
    });

    it("replaces a worse file, recycling it, and reports that episode as upgraded", async () => {
      const folder = await insertRootFolder("series");
      const { showId, epIds, existing } = await insertShowWithOneFile(folder.path, folder.id, "HDTV-720p");
      const pack = "Show.S01.1080p.WEB-DL";
      const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"), "web e1");
      writeDownloadFile(path.join(pack, "Show.S01E02.mkv"), "web e2");

      const result = await placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: "WEBDL-1080p", releaseTitle: pack });

      expect(result).toMatchObject({ episodeCount: 2, notUpgradedCount: 0 });
      const ep1 = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(epIds[0])) as any;
      expect(ep1.quality).toBe("WEBDL-1080p");
      expect(fs.readFileSync(ep1.file_path, "utf-8")).toBe("web e1");
      expect(await db.prepare("SELECT * FROM recycle_bin WHERE original_path = ?").get(existing)).toBeDefined();
      expect(notifyUpgraded).toHaveBeenCalledTimes(1);
      expect(notifyUpgraded.mock.calls[0][1]).toContain("1 episode(s)");
      expect(notifyImported).toHaveBeenCalledTimes(1);
      const history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'imported'").all(showId)) as any[];
      const byEpisode = new Map(history.map((h) => [JSON.parse(h.data).episodeId, JSON.parse(h.data)]));
      expect(byEpisode.get(epIds[0])).toMatchObject({ upgraded: true, previousQuality: "HDTV-720p" });
      expect(byEpisode.get(epIds[1]).upgraded).toBeUndefined();
    });

    it("refuses a pack that upgrades none of the episodes it matched, moving nothing", async () => {
      const folder = await insertRootFolder("series");
      const { showId, existing } = await insertShowWithOneFile(folder.path, folder.id, "Bluray-1080p");
      const anchor = writeDownloadFile(path.join("Show.S01.1080p.WEB-DL", "Show.S01E01.mkv"), "web e1");

      await expect(
        placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: "WEBDL-1080p", releaseTitle: "Show.S01.1080p.WEB-DL" })
      ).rejects.toThrow(/Not an upgrade/);

      expect(fs.readFileSync(existing, "utf-8")).toBe("existing file");
      expect(fs.existsSync(anchor)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// importQueueItem
// ---------------------------------------------------------------------------

describe("importQueueItem", () => {
  async function insertQueueRow(mediaItemId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const row = {
      episode_id: null,
      sub_item_id: null,
      season_number: null,
      title: "Some.Release.2020",
      quality: null,
      download_path: null,
      download_client_id: null,
      ...overrides,
    };
    const result = await db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, season_number, title, quality, download_path, download_client_id, status) VALUES (?,?,?,?,?,?,?,?, 'downloaded')`
      )
      .run(mediaItemId, row.episode_id, row.sub_item_id, row.season_number, row.title, row.quality, row.download_path, row.download_client_id);
    return Number(result.lastInsertRowid);
  }

  it("finds and places a movie file, then removes the queue row and notifies", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    writeDownloadFile("The.Matrix.1999.1080p.mkv");
    const queueId = await insertQueueRow(movie.id, { title: "The Matrix 1999 1080p" });

    await importQueueItem(queueId);

    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueId)).toBeUndefined();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row.has_file).toBe(1);
  });

  it("throws when no matching file can be found", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const queueId = await insertQueueRow(movie.id, { title: "Nothing Matches This At All" });

    const err = await importQueueItem(queueId).catch((e) => e);
    expect(err.message).toContain("No matching file found");
    expect(err).not.toBeInstanceOf(ImportSkippedError);
  });

  it("dispatches season-pack imports when the queue row has a season but no specific episode", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"));
    const queueId = await insertQueueRow(showId, { title: "Show S01 PACK", season_number: 1 });

    await importQueueItem(queueId);

    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueId)).toBeUndefined();
  });

  it("validates a manual source file is inside the downloads directory", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const queueId = await insertQueueRow(movie.id);

    await expect(importQueueItem(queueId, "/etc/passwd")).rejects.toThrow("must be inside the downloads directory");
  });

  it("uses the manual source file directly, skipping the fuzzy matcher and archive unpacking", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const manualFile = writeDownloadFile("manually-picked.mkv");
    const queueId = await insertQueueRow(movie.id);

    await importQueueItem(queueId, manualFile);

    expect(unpackDownloadedArchives).not.toHaveBeenCalled();
    expect((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id) as any).has_file).toBe(1);
  });

  it("removes the download from the client and cleans up the source folder when configured", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    writeDownloadFile(path.join("The Matrix Release", "The.Matrix.1999.mkv"));
    const queueId = await insertQueueRow(movie.id, { title: "The Matrix 1999" });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(downloadsDir, "The Matrix Release"))).toBe(false);
  });

  it("never deletes the source folder for a hardlink/symlink import strategy", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    writeDownloadFile(path.join("Release Folder", "The.Matrix.1999.mkv"));
    const queueId = await insertQueueRow(movie.id, { title: "The Matrix 1999" });
    setSetting("removeCompletedDownloads", "1");
    setSetting("importStrategy", "symlink");

    await importQueueItem(queueId);

    expect(fs.existsSync(path.join(downloadsDir, "Release Folder"))).toBe(true);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
  });

  it("leaves a hardlinked import's download in its client to keep seeding", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile(path.join("Release Folder", "The.Matrix.1999.mkv"));
    const queueId = await insertQueueRow(movie.id, { title: "The Matrix 1999" });
    setSetting("removeCompletedDownloads", "1");
    setSetting("importStrategy", "hardlink");

    await importQueueItem(queueId);

    expect(removeQueueItemDownload).not.toHaveBeenCalled();
    expect(fs.existsSync(src)).toBe(true);
  });

  it("keeps a season pack's download data when some of its files couldn't be matched to an episode", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"));
    const leftover = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E99.mkv"));
    const queueId = await insertQueueRow(showId, { title: "Show S01 PACK", season_number: 1 });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
    expect(fs.existsSync(leftover)).toBe(true);
    expect(await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueId)).toBeUndefined();
  });

  it("keeps a loose season pack's download data while its shared category folder still holds other videos", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    // A torrent saved without a subfolder straight into the client's category folder.
    writeDownloadFile(path.join("tv", "Show.S01E01.mkv"), "episode one, the largest");
    writeDownloadFile(path.join("tv", "Show.S01E02.mkv"), "episode two");
    const unrecognized = writeDownloadFile(path.join("tv", "05 - Title.mkv"));
    const queueId = await insertQueueRow(showId, { title: "Show S01", season_number: 1, download_path: path.join(downloadsDir, "tv") });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const imported = (await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND has_file = 1").get(showId)) as { c: number };
    expect(Number(imported.c)).toBe(2);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
    expect(fs.existsSync(unrecognized)).toBe(true);
  });

  it("deletes a season pack's download data when only extras were left unimported", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"), "episode one, the largest");
    writeDownloadFile(path.join("Show.S01.PACK", "Extras", "Show.NCED.mkv"));
    const queueId = await insertQueueRow(showId, { title: "Show S01 PACK", season_number: 1 });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(true);
  });

  it("keeps the download's data when an album's track sat loose in a shared category folder", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Some Artist','some artist',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artistId)).lastInsertRowid
    );
    const anchor = writeDownloadFile(path.join("music", "01 - Track One.mp3"));
    const unplaced = writeDownloadFile(path.join("music", "02 - Track Two.mp3"));
    const queueId = await insertQueueRow(artistId, { sub_item_id: albumId, title: "Some Artist - Some Album (2020) [MP3]", download_path: anchor });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(fs.existsSync(anchor)).toBe(false);
    expect(fs.existsSync(unplaced)).toBe(true);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("imports the whole album from the client-reported folder even when its name shares no word with the release", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Adele','adele',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, '25', 1, 0)").run(artistId)).lastInsertRowid);
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, category) VALUES ('qBittorrent', 'qbittorrent', 'music')").run()).lastInsertRowid);
    const albumDir = path.join("music", "25 (2015) [FLAC]");
    for (const name of ["01 - Hello.flac", "02 - Send My Love.flac", "03 - I Miss You.flac"]) writeDownloadFile(path.join(albumDir, name));
    const queueId = await insertQueueRow(artistId, {
      sub_item_id: albumId,
      title: "Adele - 25 (2015) [FLAC]",
      download_path: path.join(downloadsDir, albumDir),
      download_client_id: clientId,
    });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(fs.readdirSync(path.join(folder.path, "Adele", "25")).sort()).toEqual(["01 - Hello.flac", "02 - Send My Love.flac", "03 - I Miss You.flac"]);
    expect(notifyManualInteractionRequired).not.toHaveBeenCalled();
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(true);
  });

  it("never deletes the category folder a single-file download was saved into", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const file = writeDownloadFile(path.join("movies", "The.Matrix.1999.1080p.mkv"));
    const otherRom = writeDownloadFile(path.join("movies", "Game (USA).zip"));
    const stillDownloading = writeDownloadFile(path.join("movies", "Other.Movie.2020.mkv.!qB"));
    const queueId = await insertQueueRow(movie.id, { title: "The Matrix 1999 1080p", download_path: file });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(fs.existsSync(otherRom)).toBe(true);
    expect(fs.existsSync(stillDownloading)).toBe(true);
  });

  it("keeps a release's own folder while it holds anything besides its leftovers, and removes it once it doesn't", async () => {
    const folder = await insertRootFolder("movie");
    const kept = await insertMovie({ root_folder_id: folder.id });
    writeDownloadFile(path.join("The Matrix Release", "The.Matrix.1999.mkv"));
    const archive = writeDownloadFile(path.join("The Matrix Release", "extras.rar"));
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(await insertQueueRow(kept.id, { title: "The Matrix 1999" }));

    expect(fs.existsSync(archive)).toBe(true);

    const removed = await insertMovie({ root_folder_id: folder.id, title: "Heat", sort_title: "heat", year: 1995 });
    writeDownloadFile(path.join("Heat Release", "Heat.1995.mkv"));
    writeDownloadFile(path.join("Heat Release", "Heat.1995.nfo"));
    writeDownloadFile(path.join("Heat Release", "Sample", "heat.sample.mkv"));
    writeDownloadFile(path.join("Heat Release", "Subs", "English.srt"));

    await importQueueItem(await insertQueueRow(removed.id, { title: "Heat 1995" }));

    expect(fs.existsSync(path.join(downloadsDir, "Heat Release"))).toBe(false);
  });

  it("keeps the rest of a pack's data when one episode of it is imported by hand", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId);
    const ep2 = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId)).lastInsertRowid
    );
    const pack = "Show.S01.1080p.WEB-DL";
    const other = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"), "one");
    const picked = writeDownloadFile(path.join(pack, "Show.S01E02.mkv"), "two");
    const queueId = await insertQueueRow(showId, { episode_id: ep2, season_number: 1, title: pack, download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId, picked);

    expect(fs.existsSync(other)).toBe(true);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("imports the grabbed episode's own file when none of its pack's files can be mapped to an episode", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    // Scene-numbered: the pack's season 1 is the scene's season 2, which the pack's own mapping skips.
    const ep5 = Number(
      (
        await db
          .prepare(
            `INSERT INTO episodes (media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, title, monitored, has_file) VALUES (?,1,5,2,1,'Ep5',1,0)`
          )
          .run(showId)
      ).lastInsertRowid
    );
    const pack = "Show.S01.1080p";
    writeDownloadFile(path.join(pack, "Show.S02E01.mkv"), "episode five");
    const queueId = await insertQueueRow(showId, { episode_id: ep5, season_number: 1, title: pack, download_path: path.join(downloadsDir, pack) });

    await importQueueItem(queueId);

    const row = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(ep5)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(fs.readFileSync(row.file_path, "utf-8")).toBe("episode five");
  });

  it("never guesses the grabbed episode's file out of a pack none of whose files names an episode", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const ep1 = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId)).lastInsertRowid
    );
    const pack = "Show.S01.1080p";
    const small = writeDownloadFile(path.join(pack, "a1b2c3.mkv"), "one");
    const largest = writeDownloadFile(path.join(pack, "d4e5f6.mkv"), "some other episode, the largest file");
    const queueId = await insertQueueRow(showId, { episode_id: ep1, season_number: 1, title: pack, download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await expect(importQueueItem(queueId)).rejects.toThrow(ImportSkippedError);

    const row = (await db.prepare("SELECT has_file FROM episodes WHERE id = ?").get(ep1)) as any;
    expect(Number(row.has_file)).toBe(0);
    expect(fs.existsSync(small) && fs.existsSync(largest)).toBe(true);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
  });

  it("maps a batch's re-released 'v2' files onto their own episodes, not the largest onto the grabbed one", async () => {
    const folder = await insertRootFolder("anime");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('anime','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const epIds: number[] = [];
    for (const n of [1, 2]) {
      epIds.push(
        Number(
          (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, `Ep${n}`))
            .lastInsertRowid
        )
      );
    }
    const pack = "[Grp] Show S01 [1080p]";
    writeDownloadFile(path.join(pack, "[Grp] Show - 01v2 [1080p].mkv"), "episode one");
    writeDownloadFile(path.join(pack, "[Grp] Show - 02v2 [1080p].mkv"), "episode two, the largest file");
    const queueId = await insertQueueRow(showId, { episode_id: epIds[0], season_number: 1, title: pack, download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const contents = [];
    for (const id of epIds) {
      const row = (await db.prepare("SELECT file_path FROM episodes WHERE id = ?").get(id)) as any;
      contents.push(fs.readFileSync(row.file_path, "utf-8"));
    }
    expect(contents).toEqual(["episode one", "episode two, the largest file"]);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(true);
  });

  it("keeps a pack's data when the client reports a save folder shared with other downloads for it", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Lost','lost',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const epIds: number[] = [];
    for (const n of [1, 2, 3]) {
      epIds.push(
        Number(
          (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, `Ep${n}`))
            .lastInsertRowid
        )
      );
    }
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, category) VALUES ('qBittorrent', 'qbittorrent', 'sonarr')").run()).lastInsertRowid);
    // A multi-file torrent saved without a subfolder: qBittorrent reports its save path, "complete".
    writeDownloadFile(path.join("complete", "Lost.S01E01.1080p.BluRay.mkv"), "lost one");
    writeDownloadFile(path.join("complete", "Lost.S01E02.1080p.BluRay.mkv"), "lost two");
    const otherShow = writeDownloadFile(path.join("complete", "Heroes.S01E03.1080p.mkv"), "heroes three");
    const queueId = await insertQueueRow(showId, {
      season_number: 1,
      title: "Lost.S01.1080p.BluRay",
      download_path: path.join(downloadsDir, "complete"),
      download_client_id: clientId,
    });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const rows = (await db.prepare("SELECT has_file FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(rows.map((r) => Number(r.has_file))).toEqual([1, 1, 0]);
    expect(fs.readFileSync(otherShow, "utf-8")).toBe("heroes three");
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("never takes a save folder named only with the release's quality words for the pack's own", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Lost','lost',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    for (const n of [1, 2, 3]) {
      await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, `Ep${n}`);
    }
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, category) VALUES ('qBittorrent', 'qbittorrent', 'tv-uhd')").run()).lastInsertRowid);
    writeDownloadFile(path.join("UHD HDR", "Lost.S01E01.2160p.UHD.HDR.WEB-DL.mkv"), "lost one");
    writeDownloadFile(path.join("UHD HDR", "Lost.S01E02.2160p.UHD.HDR.WEB-DL.mkv"), "lost two");
    const otherShow = writeDownloadFile(path.join("UHD HDR", "Heroes.S01E03.2160p.UHD.HDR.mkv"), "heroes three");
    const queueId = await insertQueueRow(showId, {
      season_number: 1,
      title: "Lost.S01.2160p.UHD.HDR.WEB-DL",
      download_path: path.join(downloadsDir, "UHD HDR"),
      download_client_id: clientId,
    });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const rows = (await db.prepare("SELECT has_file FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
    expect(rows.map((r) => Number(r.has_file))).toEqual([1, 1, 0]);
    expect(fs.readFileSync(otherShow, "utf-8")).toBe("heroes three");
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("keeps the other books' data when a pack gives each book a folder of its own under one shared file name", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Brandon Sanderson','brandon sanderson',?,1,0,'missing')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    const bookId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'The Well of Ascension', 1, 0)").run(authorId)).lastInsertRowid
    );
    const pack = "Brandon Sanderson - Mistborn Trilogy (The Final Empire, The Well of Ascension, The Hero of Ages) epub";
    const firstBook = writeDownloadFile(path.join(pack, "The Final Empire", "book.epub"), "one");
    const picked = writeDownloadFile(path.join(pack, "The Well of Ascension", "book.epub"), "two");
    const thirdBook = writeDownloadFile(path.join(pack, "The Hero of Ages", "book.epub"), "three");
    const queueId = await insertQueueRow(authorId, { sub_item_id: bookId, title: pack, download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId, picked);

    const book = (await db.prepare("SELECT file_path FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(fs.readFileSync(book.file_path, "utf-8")).toBe("two");
    expect(fs.existsSync(firstBook) && fs.existsSync(thirdBook)).toBe(true);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("unpacks only this download's archives, and leaves it for a manual import when one of them couldn't be", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const releaseDir = path.join(downloadsDir, "The.Matrix.1999.1080p");
    const archive = writeDownloadFile(path.join("The.Matrix.1999.1080p", "the.matrix.1999.1080p.rar"), "rar");
    const queueId = await insertQueueRow(movie.id, { title: "The.Matrix.1999.1080p", download_path: releaseDir });
    unpackDownloadedArchives.mockResolvedValue({ extracted: [], failed: [{ archive, reason: "unrar is not installed" }] });

    const err = await importQueueItem(queueId).catch((e) => e);

    expect(unpackDownloadedArchives).toHaveBeenCalledWith({ downloadPath: releaseDir, releaseTitle: "The.Matrix.1999.1080p", mediaType: "movie" });
    expect(err).toBeInstanceOf(ImportSkippedError);
    expect(err.message).toContain("couldn't unpack: the.matrix.1999.1080p.rar: unrar is not installed");
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId)).toBeDefined();
    expect(await db.prepare("SELECT * FROM blocklist").all()).toEqual([]);
  });

  describe("a download whose archive couldn't be unpacked", () => {
    async function expectLeftForManualImport(queueId: number, movieId: number): Promise<void> {
      const err = await importQueueItem(queueId).catch((e) => e);
      expect(err).toBeInstanceOf(ImportSkippedError);
      expect(err.message).toContain("couldn't unpack: ");
      expect(err.message).toContain(": unrar is not installed");
      const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(movieId)) as any;
      expect(Number(row.has_file)).toBe(0);
      expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId)).toBeDefined();
      expect(removeQueueItemDownload).not.toHaveBeenCalled();
    }

    it("is left for a manual import rather than having its sample imported as the movie", async () => {
      const folder = await insertRootFolder("movie");
      const movie = await insertMovie({ root_folder_id: folder.id });
      const release = "The.Matrix.1999.1080p.BluRay.x264-GRP";
      const archive = writeDownloadFile(path.join(release, "the.matrix.1999.1080p.rar"), "rar");
      const sample = writeDownloadFile(path.join(release, "Sample", "the.matrix.1999.1080p.sample.mkv"), "sample");
      const queueId = await insertQueueRow(movie.id, { title: release, download_path: path.join(downloadsDir, release) });
      unpackDownloadedArchives.mockResolvedValue({ extracted: [], failed: [{ archive, reason: "unrar is not installed" }] });
      setSetting("removeCompletedDownloads", "1");

      await expectLeftForManualImport(queueId, movie.id);
      expect(fs.readFileSync(sample, "utf-8")).toBe("sample");
    });

    it("is left for a manual import when a release titled with the word 'sample' has only its sample beside the archive", async () => {
      const folder = await insertRootFolder("movie");
      const movie = await insertMovie({ root_folder_id: folder.id, title: "Free Sample", sort_title: "free sample", year: 2019 });
      const release = "Free.Sample.2019.1080p.BluRay-GRP";
      const archive = writeDownloadFile(path.join(release, "free.sample.2019.1080p.rar"), "rar");
      writeDownloadFile(path.join(release, "Sample", "free.sample.2019.1080p-sample.mkv"), "sample");
      const queueId = await insertQueueRow(movie.id, { title: release, download_path: path.join(downloadsDir, release) });
      unpackDownloadedArchives.mockResolvedValue({ extracted: [], failed: [{ archive, reason: "unrar is not installed" }] });
      setSetting("removeCompletedDownloads", "1");

      await expectLeftForManualImport(queueId, movie.id);
    });

    it("never takes another download's copy of the movie instead", async () => {
      const folder = await insertRootFolder("movie");
      const movie = await insertMovie({ root_folder_id: folder.id });
      const release = "The.Matrix.1999.1080p.BluRay.x264-GRP";
      const archive = writeDownloadFile(path.join(release, "the.matrix.1999.1080p.rar"), "rar");
      const otherGrab = writeDownloadFile(path.join("The.Matrix.1999.1080p.BluRay.x264-OTHER", "The.Matrix.1999.1080p.BluRay.x264-OTHER.mkv"), "still seeding");
      const queueId = await insertQueueRow(movie.id, { title: release, download_path: path.join(downloadsDir, release) });
      unpackDownloadedArchives.mockResolvedValue({ extracted: [], failed: [{ archive, reason: "unrar is not installed" }] });
      setSetting("removeCompletedDownloads", "1");

      await expectLeftForManualImport(queueId, movie.id);
      expect(fs.readFileSync(otherGrab, "utf-8")).toBe("still seeding");
    });

    it("still imports the movie file sitting beside a Sample folder", async () => {
      const folder = await insertRootFolder("movie");
      const movie = await insertMovie({ root_folder_id: folder.id });
      const release = "The.Matrix.1999.1080p.BluRay.x264-GRP";
      const archive = writeDownloadFile(path.join(release, "subs", "the.matrix.1999.1080p.subs.rar"), "rar");
      writeDownloadFile(path.join(release, "the.matrix.1999.1080p.mkv"), "the movie");
      writeDownloadFile(path.join(release, "Sample", "the.matrix.1999.1080p.sample.mkv"), "a sample, larger than the movie here");
      const queueId = await insertQueueRow(movie.id, { title: release, download_path: path.join(downloadsDir, release) });
      unpackDownloadedArchives.mockResolvedValue({ extracted: [], failed: [{ archive, reason: "unrar is not installed" }] });

      await importQueueItem(queueId);

      const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movie.id)) as any;
      expect(Number(row.has_file)).toBe(1);
      expect(fs.readFileSync(row.path, "utf-8")).toBe("the movie");
    });
  });

  it("never takes another download's copy of the movie when the download's own folder holds only its sample", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const release = "The.Matrix.1999.1080p.BluRay.x264-GRP";
    const sample = writeDownloadFile(path.join(release, "Sample", "the.matrix.1999.1080p.sample.mkv"), "sample");
    const otherRelease = "The.Matrix.1999.720p.BluRay.x264-OTHER";
    const otherGrab = writeDownloadFile(path.join(otherRelease, "The.Matrix.1999.720p.BluRay.x264-OTHER.mkv"), "still seeding");
    const queueId = await insertQueueRow(movie.id, { title: release, download_path: path.join(downloadsDir, release) });
    setSetting("removeCompletedDownloads", "1");

    await expect(importQueueItem(queueId)).rejects.toThrow(/No matching file found/);

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(Number(row.has_file)).toBe(0);
    expect(fs.readFileSync(otherGrab, "utf-8")).toBe("still seeding");
    expect(fs.readFileSync(sample, "utf-8")).toBe("sample");
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
  });

  it("keeps a pack's data when one episode is imported by hand from a download with no folder of its own", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Lost','lost',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const ep1 = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Ep1',1,0)`).run(showId)).lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, category) VALUES ('qBittorrent', 'qbittorrent', 'tv')").run()).lastInsertRowid);
    const picked = writeDownloadFile(path.join("tv", "Lost.S01E01.mkv"), "one");
    const rest = writeDownloadFile(path.join("tv", "Lost.S01E02.mkv"), "two");
    const queueId = await insertQueueRow(showId, {
      episode_id: ep1,
      season_number: 1,
      title: "Lost.S01.1080p",
      download_path: path.join(downloadsDir, "tv"),
      download_client_id: clientId,
    });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId, picked);

    expect(fs.existsSync(rest)).toBe(true);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("lets the client delete a book's download once only other formats of that same book are left", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Brandon Sanderson','brandon sanderson',?,1,0,'missing')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    const bookId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Elantris', 1, 0)").run(authorId)).lastInsertRowid
    );
    const release = "Brandon Sanderson - Elantris (2005) [epub, mobi, azw3]";
    writeDownloadFile(path.join(release, "Brandon Sanderson - Elantris.epub"), "the epub, the largest file");
    writeDownloadFile(path.join(release, "Brandon Sanderson - Elantris.mobi"), "mobi");
    writeDownloadFile(path.join(release, "brandon sanderson - elantris.azw3"), "azw3");
    const queueId = await insertQueueRow(authorId, { sub_item_id: bookId, title: release, download_path: path.join(downloadsDir, release) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const book = (await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(Number(book.has_file)).toBe(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(true);
  });

  it("keeps a pack's data when some of its episodes weren't upgrades over the files already there", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const existing = path.join(folder.path, "Show", "Season 01", "Show.S01E01.Remux.mkv");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "remux");
    await db
      .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality) VALUES (?,1,1,'Ep1',1,1,?,'Remux-1080p')`)
      .run(showId, existing);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,2,'Ep2',1,0)`).run(showId);
    const pack = "Show.S01.1080p.WEB-DL";
    const packE01 = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"), "web e1");
    writeDownloadFile(path.join(pack, "Show.S01E02.mkv"), "web e2");
    const queueId = await insertQueueRow(showId, { season_number: 1, title: pack, quality: "WEBDL-1080p", download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    expect(fs.readFileSync(existing, "utf-8")).toBe("remux");
    expect(fs.existsSync(packE01)).toBe(true);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });

  it("imports the wanted book out of a trilogy download and keeps the other books' data", async () => {
    const folder = await insertRootFolder("author");
    const authorId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Brandon Sanderson','brandon sanderson',?,1,0,'missing')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    const bookId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'The Well of Ascension', 1, 0)").run(authorId)).lastInsertRowid
    );
    const pack = "Brandon Sanderson - Mistborn Trilogy (The Final Empire, The Well of Ascension, The Hero of Ages) epub";
    writeDownloadFile(path.join(pack, "The Final Empire.epub"), "one");
    writeDownloadFile(path.join(pack, "The Well of Ascension.epub"), "two");
    const largest = writeDownloadFile(path.join(pack, "The Hero of Ages.epub"), "three, the largest file by far");
    const queueId = await insertQueueRow(authorId, { sub_item_id: bookId, title: pack, download_path: path.join(downloadsDir, pack) });
    setSetting("removeCompletedDownloads", "1");

    await importQueueItem(queueId);

    const book = (await db.prepare("SELECT file_path FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(fs.readFileSync(book.file_path, "utf-8")).toBe("two");
    expect(fs.existsSync(largest)).toBe(true);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renameLibraryFiles / renameOneMediaItem
// ---------------------------------------------------------------------------

describe("renameLibraryFiles / renameOneMediaItem", () => {
  it("renames a movie file to match a changed naming template", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = path.join(folder.path, "old-name.mkv");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "x");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });

    const result = await renameOneMediaItem(movie.id);

    const expectedDest = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    expect(result.renamed).toEqual([{ title: "The Matrix", from: oldPath, to: expectedDest }]);
    expect(fs.existsSync(expectedDest)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row.path).toBe(expectedDest);
  });

  it("does nothing (not even a no-op rename entry) when the file is already at the correct destination", async () => {
    const folder = await insertRootFolder("movie");
    const correctPath = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(correctPath), { recursive: true });
    fs.writeFileSync(correctPath, "x");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: correctPath });

    const result = await renameOneMediaItem(movie.id);

    expect(result.renamed).toEqual([]);
  });

  it("dryRun reports what would change without touching the filesystem or database", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = path.join(folder.path, "old-name.mkv");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "x");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });

    const result = await renameOneMediaItem(movie.id, undefined, true);

    expect(result.renamed).toHaveLength(1);
    expect(fs.existsSync(oldPath)).toBe(true); // untouched
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row.path).toBe(oldPath); // DB untouched too
  });

  it("skips an item with no file at all", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 0, path: null });

    const result = await renameOneMediaItem(movie.id);

    expect(result.renamed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("counts (but does not rename) Music sub-items, since their filenames are always kept as-downloaded", async () => {
    const folder = await insertRootFolder("artist");
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Artist','artist',?,1,1,'downloaded')`).run(folder.id))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, '/x/album')").run(artistId);

    const result = await renameOneMediaItem(artistId);

    expect(result.renamed).toEqual([]);
    expect(result.skippedMusic).toBe(1);
  });

  it("renames a multi-episode file's shared path exactly once, updating both episode rows", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,1,'downloaded')`).run(folder.id))
        .lastInsertRowid
    );
    const oldPath = path.join(folder.path, "old-e1e2.mkv");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "x");
    const ep1 = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,1,'Ep1',1,1,?)`).run(showId, oldPath))
        .lastInsertRowid
    );
    const ep2 = Number(
      (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,2,'Ep2',1,1,?)`).run(showId, oldPath))
        .lastInsertRowid
    );

    const result = await renameOneMediaItem(showId);

    // One rename entry for the shared file, not two — a second attempt to move the same
    // already-relocated physical file would otherwise throw ENOENT on the second episode row.
    expect(result.renamed).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(oldPath)).toBe(false);
    const [row1, row2] = (await Promise.all([
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep1),
      db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2),
    ])) as any[];
    expect(row1.file_path).toBe(row2.file_path);
    expect(fs.existsSync(row1.file_path)).toBe(true);
  });

  it("renameLibraryFiles processes every item of a type and continues past one item's failure", async () => {
    const folder = await insertRootFolder("movie");
    const goodPath = path.join(folder.path, "good-old-name.mkv");
    fs.mkdirSync(path.dirname(goodPath), { recursive: true });
    fs.writeFileSync(goodPath, "x");
    await insertMovie({ root_folder_id: folder.id, has_file: 1, path: goodPath, title: "Good Movie", sort_title: "good movie" });
    // A path that doesn't actually exist on disk — moveFile's rename will throw ENOENT.
    await insertMovie({ root_folder_id: folder.id, has_file: 1, path: "/does/not/exist.mkv", title: "Broken Movie", sort_title: "broken movie", year: 2021 });

    const result = await renameLibraryFiles("movie");

    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0].title).toBe("Good Movie");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].title).toBe("Broken Movie");
  });

  it("moves the file's own subtitles and .nfo along with it, then removes the emptied folder", async () => {
    const folder = await insertRootFolder("movie");
    const oldDir = path.join(folder.path, "Old Folder");
    fs.mkdirSync(oldDir, { recursive: true });
    const oldPath = path.join(oldDir, "old-name.mkv");
    fs.writeFileSync(oldPath, "video");
    fs.writeFileSync(path.join(oldDir, "old-name.en.srt"), "en");
    fs.writeFileSync(path.join(oldDir, "old-name.pt-BR.forced.srt"), "pt forced");
    fs.writeFileSync(path.join(oldDir, "old-name.nfo"), "<movie/>");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });

    const result = await renameOneMediaItem(movie.id);

    expect(result.errors).toEqual([]);
    const newDir = path.join(folder.path, "The Matrix (1999)");
    expect(fs.readdirSync(newDir).sort()).toEqual(
      ["The Matrix (1999).en.srt", "The Matrix (1999).mkv", "The Matrix (1999).nfo", "The Matrix (1999).pt-BR.forced.srt"].sort()
    );
    expect(fs.readFileSync(path.join(newDir, "The Matrix (1999).pt-BR.forced.srt"), "utf-8")).toBe("pt forced");
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it("leaves files that only share the name's beginning where they are", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = path.join(folder.path, "old-name.mkv");
    fs.writeFileSync(oldPath, "video");
    const extendedCut = path.join(folder.path, "old-name.Extended.srt");
    const otherSubtitle = path.join(folder.path, "old-name-commentary.srt");
    fs.writeFileSync(extendedCut, "x");
    fs.writeFileSync(otherSubtitle, "x");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });

    await renameOneMediaItem(movie.id);

    expect(fs.existsSync(extendedCut)).toBe(true);
    expect(fs.existsSync(otherSubtitle)).toBe(true);
  });

  it("never overwrites a different file already at the destination", async () => {
    const folder = await insertRootFolder("movie");
    const oldPath = path.join(folder.path, "old-name.mkv");
    fs.writeFileSync(oldPath, "mine");
    const occupied = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(occupied), { recursive: true });
    fs.writeFileSync(occupied, "someone else's");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: oldPath });

    const result = await renameOneMediaItem(movie.id);

    expect(result.renamed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("already exists");
    expect(fs.readFileSync(oldPath, "utf-8")).toBe("mine");
    expect(fs.readFileSync(occupied, "utf-8")).toBe("someone else's");
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(movie.id)) as any;
    expect(row.path).toBe(oldPath);
  });

  it("renames only one of two files bound for the same name, reporting the other (and says so in the preview)", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Course X','course x',?,1,1,'downloaded')`).run(folder.id))
        .lastInsertRowid
    );
    const lesson = (module: string, content: string) => {
      const p = path.join(folder.path, "Course X", module, "Introduction.mp4");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    };
    const firstPath = lesson("Module 1", "module one");
    const secondPath = lesson("Module 2", "module two");
    for (const [episode, filePath] of [[1, firstPath], [5, secondPath]] as const) {
      await db
        .prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?,1,?,'Introduction',1,1,?)`)
        .run(showId, episode, filePath);
    }
    // With naming disabled both keep their own filename under the template's "Season 01" folder.
    setSetting("namingEnabledSeries", "0");
    try {
      const preview = await renameOneMediaItem(showId, undefined, true);
      expect(preview.renamed).toHaveLength(1);
      expect(preview.errors).toHaveLength(1);

      const result = await renameOneMediaItem(showId);

      const dest = path.join(folder.path, "Course X", "Season 01", "Introduction.mp4");
      expect(result.renamed).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      const rows = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(showId)) as any[];
      const moved = rows.find((r) => r.file_path === dest);
      const stayed = rows.find((r) => r.file_path !== dest);
      expect(moved).toBeDefined();
      expect(stayed).toBeDefined();
      expect(fs.readFileSync(dest, "utf-8")).toBe(moved.episode_number === 1 ? "module one" : "module two");
      expect(fs.readFileSync(stayed.file_path, "utf-8")).toBe(stayed.episode_number === 1 ? "module one" : "module two");
    } finally {
      setSetting("namingEnabledSeries", "1");
    }
  });
});
