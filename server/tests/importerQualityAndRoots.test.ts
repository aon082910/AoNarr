import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30a: an automatic import of a download whose release name carries no quality may still replace a lower-
// resolution file when the file itself shows the higher resolution; an import never goes into a root folder that is an
// empty mount point (or a read-only library); the free-space checks ask the file system without blocking.

vi.mock("../src/services/notifications.js", () => ({
  notifyImported: vi.fn(),
  notifyUpgraded: vi.fn(),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/metadataExport.js", () => ({
  writeNfoSidecar: vi.fn(),
  writeEpisodeNfoSidecar: vi.fn(),
  writeTvShowNfoIfMissing: vi.fn(),
}));

vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: vi.fn().mockResolvedValue(undefined),
  markDownloadImported: vi.fn().mockResolvedValue(undefined),
}));

const syncSubtitleToVideo = vi.fn();
vi.mock("../src/services/subtitleSync.js", () => ({
  syncSubtitleToVideo: (...args: unknown[]) => syncSubtitleToVideo(...args),
}));

vi.mock("../src/services/comicImageConvert.js", () => ({ convertComicImagesBestEffort: vi.fn().mockResolvedValue(undefined) }));

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

vi.mock("../src/services/subtitleClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchSubtitles: vi.fn().mockResolvedValue([]),
  searchCustomSubtitles: vi.fn().mockResolvedValue([]),
}));

// Taken before any test fakes it, so a second fake never delegates to the first.
const realStatfs = fs.promises.statfs;

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let rootFolderUnmountedReason: (typeof import("../src/services/rootFolderCheck.js"))["rootFolderUnmountedReason"];
let DEFAULT_QUALITY_ORDER: (typeof import("../src/services/quality.js"))["DEFAULT_QUALITY_ORDER"];

let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  ({ rootFolderUnmountedReason } = await import("../src/services/rootFolderCheck.js"));
  const quality = await import("../src/services/quality.js");
  DEFAULT_QUALITY_ORDER = quality.DEFAULT_QUALITY_ORDER;
  await quality.loadQualityCaches();
  // config.downloadsDir is also the config dir (setupTestDb), so the test files go into a folder of their own.
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-quality-roots");
  fs.mkdirSync(downloadsDir, { recursive: true });
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "download_clients", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  syncSubtitleToVideo.mockReset().mockResolvedValue(false);
  probeMediaInfo.mockReset().mockResolvedValue(null);

  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-quality-roots-"));

  setSetting("skipFreeSpaceCheck", "1");
  setSetting("minimumFreeSpaceMb", "0");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeNfoOnImport", "0");
  setSetting("writeAudioTagsOnImport", "0");
  setSetting("comicImageConvertEnabled", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("subtitleSyncEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(libraryDir, { recursive: true, force: true });
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

async function insertMovie(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  const row = { title: "The Matrix", sort_title: "the matrix", year: 1999, root_folder_id: null, has_file: 0, path: null, ...overrides };
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, monitored, status)
       VALUES ('movie', ?, ?, ?, ?, ?, ?, 1, 'missing')`
    )
    .run(row.title, row.sort_title, row.year, row.root_folder_id, row.has_file, row.path);
  return { id: Number(result.lastInsertRowid) };
}

/** What ffprobe reports for a healthy video of this frame size. */
const frame = (width: number, height: number) => ({ width, height, videoCodec: "h264", audioStreams: [{}], durationSeconds: 7000 });

// ---------------------------------------------------------------------------
// resolutionOfQualityName / resolutionOfFrame
// ---------------------------------------------------------------------------

describe("resolutionOfQualityName", () => {
  it("reads the resolution tier a quality name stands for", () => {
    const cases: [string | null, number | null][] = [
      [null, null],
      ["", null],
      ["SD", null], // the ladder's SD tier names no resolution
      ["Unknown", null],
      ["DVD", 480],
      ["SDTV", 480],
      ["sdtv", 480],
      ["HDTV-720p", 720],
      ["WEBRip-720p", 720],
      ["WEBDL-720p", 720],
      ["Bluray-720p", 720],
      ["HDTV-1080p", 1080],
      ["WEBDL-1080p", 1080],
      ["Bluray-1080p", 1080],
      ["Remux-1080p", 1080],
      ["HDTV-2160p", 2160],
      ["WEBDL-2160p", 2160],
      ["Remux-2160p", 2160],
      ["Bluray-480p", 480],
      ["1080P", 1080], // case does not matter
    ];
    for (const [name, tier] of cases) expect(importer.resolutionOfQualityName(name), String(name)).toBe(tier);
  });

  it("puts an odd line count in the nearest tier at or below it", () => {
    const cases: [string, number][] = [
      ["576p", 480],
      ["699p", 480],
      ["700p", 720],
      ["999p", 720],
      ["1000p", 1080],
      ["1999p", 1080],
      ["2000p", 2160],
      ["4320p", 2160],
    ];
    for (const [name, tier] of cases) expect(importer.resolutionOfQualityName(name), name).toBe(tier);
  });

  // (The names with no number: the DVD tiers and SDTV are standard definition; SD, the pre-release tiers, BR-DISK and Raw-HD say no size.)
  it("agrees with the number in every default quality name", () => {
    for (const name of DEFAULT_QUALITY_ORDER) {
      const lines = /(\d+)p$/.exec(name);
      expect(importer.resolutionOfQualityName(name), name).toBe(lines ? (Number(lines[1]) === 576 ? 480 : Number(lines[1])) : ["DVD", "DVD-R", "SDTV"].includes(name) ? 480 : null);
    }
  });
});

describe("resolutionOfFrame", () => {
  it("reads the tier of a video's frame size, by width as well as height", () => {
    const cases: [number | null, number | null, number | null][] = [
      [null, null, null],
      [0, 0, null],
      [3840, 2160, 2160],
      [3840, 1600, 2160], // a widescreen 2160p film
      [3000, 1000, 2160],
      [1000, 2000, 2160],
      [2999, 1999, 1080],
      [1920, 1080, 1080],
      [1920, 800, 1080], // a widescreen 1080p film
      [1800, 700, 1080],
      [1799, 999, 720],
      [1280, 720, 720],
      [1280, 536, 720], // a widescreen 720p film
      [1200, 400, 720],
      [1199, 699, 480],
      [720, 480, 480],
      [640, 360, 480],
      [null, 1080, 1080],
      [1920, null, 1080],
      [null, 720, 720],
      [null, 480, 480],
    ];
    for (const [width, height, tier] of cases) expect(importer.resolutionOfFrame(width, height), `${width}x${height}`).toBe(tier);
  });
});

// ---------------------------------------------------------------------------
// assertNotADowngrade, through an automatic import
// ---------------------------------------------------------------------------

describe("an automatic import of a download whose release name has no quality", () => {
  async function libraryMovie(existingQuality: string) {
    const folder = await insertRootFolder("movie");
    const libraryFile = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.writeFileSync(libraryFile, "old");
    const movie = await insertMovie({ root_folder_id: folder.id, has_file: 1, path: libraryFile });
    await db.prepare("UPDATE media_items SET quality = ? WHERE id = ?").run(existingQuality, movie.id);
    return { movie, libraryFile };
  }

  async function queueRow(mediaItemId: number, downloadPath: string, quality: string | null): Promise<number> {
    const result = await db
      .prepare(`INSERT INTO queue (media_item_id, title, quality, download_path, grab_source, status) VALUES (?,?,?,?,NULL, 'downloaded')`)
      .run(mediaItemId, "The.Matrix.1999.x264-GRP", quality, downloadPath);
    return Number(result.lastInsertRowid);
  }

  /** Imports a no-quality download over a library file of `existingQuality` whose frame size is `size`. */
  async function importOver(existingQuality: string, size: [number, number] | "unreadable", quality: string | null = null) {
    const { movie, libraryFile } = await libraryMovie(existingQuality);
    const download = writeDownloadFile("The.Matrix.1999.x264-GRP.mkv", "new");
    if (size === "unreadable") probeMediaInfo.mockResolvedValue(null);
    else probeMediaInfo.mockResolvedValue(frame(size[0], size[1]));
    const queueId = await queueRow(movie.id, download, quality);
    const outcome = await importer.importQueueItem(queueId).then(
      () => null,
      (err: Error) => err
    );
    return { outcome, movie, libraryFile, download };
  }

  function expectRefused(result: Awaited<ReturnType<typeof importOver>>): void {
    expect(result.outcome).toBeInstanceOf(importer.ImportSkippedError);
    expect(result.outcome?.message).toMatch(/Not an upgrade/);
    expect(fs.readFileSync(result.libraryFile, "utf-8")).toBe("old");
    expect(fs.existsSync(result.download)).toBe(true);
  }

  async function expectReplaced(result: Awaited<ReturnType<typeof importOver>>): Promise<void> {
    expect(result.outcome).toBeNull();
    expect(fs.readFileSync(result.libraryFile, "utf-8")).toBe("new");
    expect(fs.existsSync(result.download)).toBe(false);
  }

  it.each([null, "Unknown"])("replaces an HDTV-720p file when the file itself is 1080p (queue quality %s)", async (quality) => {
    await expectReplaced(await importOver("HDTV-720p", [1920, 1080], quality));
  });

  it("counts a widescreen 1080p frame as 1080p", async () => {
    await expectReplaced(await importOver("WEBDL-720p", [1920, 800]));
  });

  it("replaces a 1080p file when the file is 2160p", async () => {
    await expectReplaced(await importOver("HDTV-1080p", [3840, 1600]));
  });

  it("refuses a file that is only the same resolution as the library's", async () => {
    expectRefused(await importOver("HDTV-720p", [1280, 720]));
  });

  it("refuses a file of a lower resolution", async () => {
    expectRefused(await importOver("Bluray-1080p", [1280, 720]));
  });

  it("refuses a 1080p file over a Remux-2160p one", async () => {
    expectRefused(await importOver("Remux-2160p", [1920, 1080]));
  });

  it("refuses when ffprobe cannot read the file", async () => {
    expectRefused(await importOver("HDTV-720p", "unreadable"));
  });

  it("refuses when ffprobe fails while the downgrade check asks it", async () => {
    // placeFile with refuseDowngrade is what an automatic import calls; without the identity check of a
    // download it makes no other ffprobe call before the downgrade check, so the failure reaches that one.
    const { movie, libraryFile } = await libraryMovie("HDTV-720p");
    const download = writeDownloadFile("The.Matrix.1999.x264-GRP.mkv", "new");
    probeMediaInfo.mockRejectedValue(new Error("ffprobe is not installed"));

    const err = await importer.placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: download, quality: null, refuseDowngrade: true }).catch((e) => e);

    expect(probeMediaInfo).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toMatch(/Not an upgrade/);
    expect(fs.readFileSync(libraryFile, "utf-8")).toBe("old");
    expect(fs.existsSync(download)).toBe(true);
  });

  it("refuses over a library quality whose name gives no resolution, however large the frame", async () => {
    expectRefused(await importOver("SD", [3840, 2160]));
  });

  it("never second-guesses a download whose release name does carry a (lower) quality", async () => {
    expectRefused(await importOver("Bluray-1080p", [3840, 2160], "HDTV-720p"));
  });

  it("tells the admin, in a manual import's warnings, only when the file is no higher a resolution", async () => {
    const folder = await insertRootFolder("movie");
    const existing = path.join(folder.path, "Film (2020)", "Film (2020).mkv");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "x");
    const movie = await insertMovie({ title: "Film", sort_title: "film", year: 2020, root_folder_id: folder.id, has_file: 1, path: existing });
    await db.prepare("UPDATE media_items SET quality = 'HDTV-720p', runtime_minutes = 120 WHERE id = ?").run(movie.id);
    const src = writeDownloadFile("Film.2020.x264/Film.2020.x264.mkv");

    probeMediaInfo.mockResolvedValue(frame(1920, 1080));
    expect(await importer.manualImportWarnings({ itemId: movie.id, sourceFile: src, quality: null })).toEqual([]);

    probeMediaInfo.mockResolvedValue(frame(1280, 720));
    const warnings = await importer.manualImportWarnings({ itemId: movie.id, sourceFile: src, quality: null });
    expect(warnings.some((w) => /Not an upgrade/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The mounted-root guard
// ---------------------------------------------------------------------------

describe("an import into a root folder that did not come up", () => {
  /** A library whose files are recorded in the database but whose folder is an empty mount point. */
  async function unmountedLibrary() {
    const folder = await insertRootFolder("movie");
    await insertMovie({ title: "Recorded", sort_title: "recorded", year: 2000, root_folder_id: folder.id, has_file: 1, path: path.join(folder.path, "Recorded (2000)", "Recorded (2000).mkv") });
    const movie = await insertMovie({ root_folder_id: folder.id });
    return { folder, movie };
  }
  const place = (movieId: number, src: string) => importer.placeFile({ itemId: movieId, episodeId: null, subItemId: null, sourceFile: src, quality: null });

  it("is refused with a plain error, so that it is parked and retried when the share returns", async () => {
    const { folder, movie } = await unmountedLibrary();
    const src = writeDownloadFile("The.Matrix.1999.mkv");

    const err = await place(movie.id, src).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toBe(
      `Root folder "${folder.path}" is empty although 1 item(s) have files recorded in it (is the share mounted?) — kept for a manual import from Activity`
    );
    expect(fs.readdirSync(folder.path)).toEqual([]); // no folder tree was made on the container's own file system
    expect(fs.existsSync(src)).toBe(true);
  });

  it("is refused for an album and for a season pack as well", async () => {
    const folder = await insertRootFolder("series");
    await insertMovie({ title: "Recorded", sort_title: "recorded", year: 2000, root_folder_id: folder.id, has_file: 1, path: "/gone/Recorded.mkv" });
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Artist','artist',?,1,0,'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album', 1, 0)").run(artistId)).lastInsertRowid);
    const episode = writeDownloadFile(path.join("Show.S01.1080p", "Show.S01E01.mkv"));
    const track = writeDownloadFile(path.join("Album", "01 - Track.mp3"));

    await expect(importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: episode, quality: null })).rejects.toThrow(/is empty although 1 item\(s\) have files recorded/);
    await expect(importer.placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: track, quality: null })).rejects.toThrow(/is empty although 1 item\(s\) have files recorded/);

    expect(fs.readdirSync(folder.path)).toEqual([]);
    expect(fs.existsSync(episode)).toBe(true);
    expect(fs.existsSync(track)).toBe(true);
  });

  it("goes ahead once the folder holds anything", async () => {
    const { folder, movie } = await unmountedLibrary();
    fs.mkdirSync(path.join(folder.path, "Recorded (2000)"));
    const src = writeDownloadFile("The.Matrix.1999.mkv", "new");

    const placed = await place(movie.id, src);

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("new");
  });

  it("goes ahead into an empty root folder that has nothing recorded in it: a new library", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("The.Matrix.1999.mkv", "new");

    const placed = await place(movie.id, src);

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("new");
  });

  it("does not count files recorded in another root folder", async () => {
    const empty = await insertRootFolder("movie");
    const other = path.join(libraryDir, "movie-other");
    fs.mkdirSync(other);
    const otherId = Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'other')").run(other)).lastInsertRowid);
    await insertMovie({ title: "Elsewhere", sort_title: "elsewhere", year: 2001, root_folder_id: otherId, has_file: 1, path: path.join(other, "gone.mkv") });
    const movie = await insertMovie({ root_folder_id: empty.id });

    const placed = await place(movie.id, writeDownloadFile("The.Matrix.1999.mkv", "new"));

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("new");
  });

  it("is refused outright when the root folder is a read-only library, whatever it holds", async () => {
    const folder = await insertRootFolder("movie");
    fs.mkdirSync(path.join(folder.path, "Something"));
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(folder.id);
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("The.Matrix.1999.mkv");

    const err = await place(movie.id, src).catch((e) => e);

    // A decision of the admin's, not a glitch: skipped for good rather than retried.
    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toBe(`Root folder "${folder.path}" is a read-only library: nothing is imported into it`);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual(["Something"]);
  });
});

describe("rootFolderUnmountedReason", () => {
  async function emptyRoot(): Promise<{ id: number; path: string }> {
    return insertRootFolder("movie");
  }

  it("counts an episode with a file as a file recorded in the library", async () => {
    const root = await emptyRoot();
    const showId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(root.id))
        .lastInsertRowid
    );
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,1,'Pilot',1,1)`).run(showId);

    expect(await rootFolderUnmountedReason(root)).toBe(
      `Root folder "${root.path}" is empty although 1 item(s) have files recorded in it (is the share mounted?)`
    );
  });

  it("counts an album with files as a file recorded in the library", async () => {
    const root = await emptyRoot();
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Artist','artist',?,1,0,'missing')`).run(root.id))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Album', 1, 1)").run(artistId);

    expect(await rootFolderUnmountedReason(root)).toMatch(/is empty although 1 item\(s\) have files recorded in it/);
  });

  it("is null for an item that is only wanted, and for a folder that holds something", async () => {
    const root = await emptyRoot();
    await insertMovie({ root_folder_id: root.id, has_file: 0 });
    expect(await rootFolderUnmountedReason(root)).toBeNull();

    await insertMovie({ title: "Recorded", sort_title: "recorded", year: 2000, root_folder_id: root.id, has_file: 1, path: "/gone.mkv" });
    expect(await rootFolderUnmountedReason(root)).not.toBeNull();
    fs.writeFileSync(path.join(root.path, "anything.txt"), "x");
    expect(await rootFolderUnmountedReason(root)).toBeNull();
  });

  it("says nothing about a folder that is missing: the import itself reports that", async () => {
    const missing = { id: 9999, path: path.join(libraryDir, "not-there") };

    expect(await rootFolderUnmountedReason(missing)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The free-space checks (statfs off the main thread)
// ---------------------------------------------------------------------------

describe("the free space an import needs", () => {
  /** Answers statfs for one folder with `free` bytes available (the unprivileged share), everything else for real. */
  function freeSpaceAt(folderPath: string, free: number) {
    return vi.spyOn(fs.promises, "statfs").mockImplementation((async (p: string, ...rest: unknown[]) =>
      p === folderPath ? ({ bavail: free, bfree: free, blocks: 1_000_000, bsize: 1 } as any) : (realStatfs as any)(p, ...rest)) as any);
  }

  beforeEach(() => {
    setSetting("skipFreeSpaceCheck", "0");
  });

  it("refuses a file that does not fit at the destination, and takes it when it just does", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("The.Matrix.1999.mkv", "0123456789"); // 10 bytes
    const statfs = freeSpaceAt(folder.path, 9);

    const err = await importer.placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null }).catch((e) => e);

    expect(statfs).toHaveBeenCalledWith(folder.path);
    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toMatch(/^Not enough free space at ".*" .* — kept for a manual import from Activity$/);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual([]);

    freeSpaceAt(folder.path, 10);
    const placed = await importer.placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });
    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("0123456789");
  });

  it("does not hold an import back because the destination would not report its free space", async () => {
    const folder = await insertRootFolder("movie");
    const movie = await insertMovie({ root_folder_id: folder.id });
    const src = writeDownloadFile("The.Matrix.1999.mkv", "payload");
    vi.spyOn(fs.promises, "statfs").mockImplementation((async (p: string, ...rest: unknown[]) => {
      if (p === folder.path) throw Object.assign(new Error("ENOSYS: function not implemented"), { code: "ENOSYS" });
      return (realStatfs as any)(p, ...rest);
    }) as any);

    const placed = await importer.placeFile({ itemId: movie.id, episodeId: null, subItemId: null, sourceFile: src, quality: null });

    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("payload");
  });

  describe("for a whole season pack", () => {
    async function showWithEpisodes(folderId: number) {
      const showId = Number(
        (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',?,1,0,'missing')`).run(folderId))
          .lastInsertRowid
      );
      for (const n of [1, 2, 3]) {
        await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?,1,?,?,1,0)`).run(showId, n, `Ep${n}`);
      }
      const pack = "Show.S01.1080p.WEB-DL";
      const anchor = writeDownloadFile(path.join(pack, "Show.S01E01.mkv"), "0123456789");
      writeDownloadFile(path.join(pack, "Show.S01E02.mkv"), "0123456789");
      writeDownloadFile(path.join(pack, "Show.S01E03.mkv"), "0123456789");
      return { showId, anchor, pack };
    }

    it("adds up every file of the pack: each fits alone, all three do not", async () => {
      const folder = await insertRootFolder("series");
      const { showId, anchor, pack } = await showWithEpisodes(folder.id);
      const statfs = freeSpaceAt(folder.path, 25); // 30 bytes needed

      const err = await importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack }).catch((e) => e);

      expect(statfs).toHaveBeenCalledWith(folder.path);
      expect(err).toBeInstanceOf(importer.ImportSkippedError);
      expect(err.message).toMatch(/^Not enough free space at ".*" .* — kept for a manual import from Activity$/);
      expect(fs.existsSync(anchor)).toBe(true);
      expect(fs.readdirSync(folder.path)).toEqual([]);

      freeSpaceAt(folder.path, 30);
      const placed = await importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack });
      expect(placed.episodeCount).toBe(3);
    });

    it("imports the pack when the destination will not say how much room it has", async () => {
      const folder = await insertRootFolder("series");
      const { showId, anchor, pack } = await showWithEpisodes(folder.id);
      vi.spyOn(fs.promises, "statfs").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));

      const placed = await importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null, releaseTitle: pack });

      expect(placed.episodeCount).toBe(3);
    });
  });

  describe("for a whole album", () => {
    async function artistWithAlbum(folderId: number) {
      const artistId = Number(
        (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist','Some Artist','some artist',?,1,0,'missing')`).run(folderId))
          .lastInsertRowid
      );
      const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artistId)).lastInsertRowid);
      for (const n of [1, 2, 3]) await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albumId, n, `Track ${n}`);
      const anchor = writeDownloadFile(path.join("Some.Album.2020", "01 - Track 1.mp3"), "0123456789");
      writeDownloadFile(path.join("Some.Album.2020", "02 - Track 2.mp3"), "0123456789");
      writeDownloadFile(path.join("Some.Album.2020", "03 - Track 3.mp3"), "0123456789");
      return { artistId, albumId, anchor };
    }

    it("adds up every track of the album: each fits alone, all three do not", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, anchor } = await artistWithAlbum(folder.id);
      freeSpaceAt(folder.path, 25); // 30 bytes needed

      const err = await importer.placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null }).catch((e) => e);

      expect(err).toBeInstanceOf(importer.ImportSkippedError);
      expect(err.message).toMatch(/^Not enough free space at ".*" .* — kept for a manual import from Activity$/);
      expect(fs.existsSync(anchor)).toBe(true);
      expect(fs.readdirSync(folder.path)).toEqual([]);

      freeSpaceAt(folder.path, 30);
      const placed = await importer.placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });
      expect(placed.fileCount).toBe(3);
    });

    it("imports the album when the destination will not say how much room it has", async () => {
      const folder = await insertRootFolder("artist");
      const { artistId, albumId, anchor } = await artistWithAlbum(folder.id);
      vi.spyOn(fs.promises, "statfs").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));

      const placed = await importer.placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null });

      expect(placed.fileCount).toBe(3);
    });
  });
});
