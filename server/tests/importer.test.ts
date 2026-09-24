import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
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
    renameLibraryFiles,
    renameOneMediaItem,
    ImportSkippedError,
    downloadSubtitleForLanguage,
  } = await import("../src/services/importer.js"));
  ({ config } = await import("../src/config.js"));
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
  unpackDownloadedArchives.mockReset().mockResolvedValue(undefined);
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

  it("matches an indexer title's apostrophes and accents against release names that drop them", () => {
    const wanted = writeDownloadFile(path.join("Greys.Anatomy.S01E05.1080p", "Greys.Anatomy.S01E05.1080p.mkv"));
    writeDownloadFile(path.join("Pokemon.S01E05.1080p", "Pokemon.S01E05.1080p.mkv"));

    expect(findDownloadedFile("Grey's Anatomy S01E05 1080p", "series", { season: 1, episode: 5 })).toBe(wanted);
    expect(findDownloadedFile("Pokémon S01E05 1080p", "series", { season: 1, episode: 5 })).toBe(
      path.join(downloadsDir, "Pokemon.S01E05.1080p", "Pokemon.S01E05.1080p.mkv")
    );
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
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bfree: 1, bsize: 1 } as any);

    await expect(placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null })).rejects.toThrow(ImportSkippedError);
    vi.restoreAllMocks();
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
    const { showId } = await insertShowWithEpisodes(folder.id, [1, 2]);
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

    const nextAnchor = writeDownloadFile(path.join("Show.S01.REPACK", "Show.S01E01.mkv"));
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
});

// ---------------------------------------------------------------------------
// importQueueItem
// ---------------------------------------------------------------------------

describe("importQueueItem", () => {
  async function insertQueueRow(mediaItemId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const row = { episode_id: null, sub_item_id: null, season_number: null, title: "Some.Release.2020", quality: null, download_path: null, ...overrides };
    const result = await db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, season_number, title, quality, download_path, status) VALUES (?,?,?,?,?,?,?, 'downloaded')`
      )
      .run(mediaItemId, row.episode_id, row.sub_item_id, row.season_number, row.title, row.quality, row.download_path);
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

    await expect(importQueueItem(queueId)).rejects.toThrow("No matching file found");
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
});
