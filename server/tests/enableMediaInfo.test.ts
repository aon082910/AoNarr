import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30e: "Analyse video files" (Sonarr's EnableMediaInfo). Off, an import or a scan never runs ffprobe on a file, and
// everything that wanted the probe's answer goes without it instead of failing: no media info is stored, the sample and
// no-audio checks do not fire, and a download with no quality in its name is judged by its name alone.

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

vi.mock("../src/services/subtitleSync.js", () => ({ syncSubtitleToVideo: vi.fn().mockResolvedValue(false) }));
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

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let mediaInfoSwitch: typeof import("../src/services/mediaInfoSwitch.js");

let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  mediaInfoSwitch = await import("../src/services/mediaInfoSwitch.js");
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-media-info");
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "download_clients", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  probeMediaInfo.mockReset().mockResolvedValue(null);
  mediaInfoSwitch.__resetMediaInfoNoteForTests();

  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-media-info-"));

  setSetting("enableMediaInfo", "");
  setSetting("importProbeChecks", "");
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("minimumFreeSpaceMb", "0");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeNfoOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("subtitleSyncEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("useScriptImport", "0");
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

/** A movie that runs two hours, so a probe that reports seconds calls its file a sample. */
async function insertMovie(rootFolderId: number): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, monitored, status, runtime_minutes)
       VALUES ('movie', 'The Matrix', 'the matrix', 1999, ?, 0, 1, 'missing', 120)`
    )
    .run(rootFolderId);
  return Number(result.lastInsertRowid);
}

async function queueRow(mediaItemId: number, downloadPath: string, quality: string | null = "WEBDL-1080p"): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO queue (media_item_id, title, quality, download_path, grab_source, status) VALUES (?,?,?,?,NULL, 'downloaded')`)
    .run(mediaItemId, "The.Matrix.1999.1080p.WEB-DL.x264-GRP", quality, downloadPath);
  return Number(result.lastInsertRowid);
}

const healthy = { width: 1920, height: 1080, videoCodec: "h264", audioStreams: [{}], durationSeconds: 7000 };

/** Imports a download of the movie the way the poller does, and reports what happened to it. */
async function importMovie(probe: unknown) {
  const folder = await insertRootFolder("movie");
  const movieId = await insertMovie(folder.id);
  const download = writeDownloadFile("The.Matrix.1999.1080p.WEB-DL.x264-GRP.mkv", "the file");
  probeMediaInfo.mockResolvedValue(probe);
  const queueId = await queueRow(movieId, download);
  const outcome = await importer.importQueueItem(queueId).then(
    () => null,
    (err: Error) => err
  );
  const row = (await db.prepare("SELECT has_file, path, media_info FROM media_items WHERE id = ?").get(movieId)) as { has_file: number; path: string | null; media_info: string | null };
  return { outcome, row, download, libraryFile: path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv") };
}

describe("enableMediaInfo on (the default)", () => {
  it("probes an imported file, stores what it found, and refuses a sample by its length", async () => {
    const ok = await importMovie(healthy);
    expect(ok.outcome).toBeNull();
    expect(probeMediaInfo).toHaveBeenCalled();
    expect(JSON.parse(ok.row.media_info!)).toMatchObject({ width: 1920, videoCodec: "h264" });
  });

  it("leaves a 5 second file for a manual import", async () => {
    const short = await importMovie({ ...healthy, durationSeconds: 5 });
    expect(short.outcome).toBeInstanceOf(importer.ImportSkippedError);
    expect(short.outcome?.message).toMatch(/runs only 5s/);
    expect(fs.existsSync(short.download)).toBe(true);
    expect(short.row.has_file).toBe(0);
  });

  it("leaves a file with no audio track for a manual import", async () => {
    const silent = await importMovie({ ...healthy, audioStreams: [] });
    expect(silent.outcome).toBeInstanceOf(importer.ImportSkippedError);
    expect(silent.outcome?.message).toMatch(/no audio track/);
    expect(fs.existsSync(silent.download)).toBe(true);
  });

  it("treats a stored 1 like the default", async () => {
    setSetting("enableMediaInfo", "1");
    const ok = await importMovie(healthy);
    expect(ok.outcome).toBeNull();
    expect(probeMediaInfo).toHaveBeenCalled();
  });
});

describe("enableMediaInfo off", () => {
  beforeEach(() => setSetting("enableMediaInfo", "0"));

  it("never runs ffprobe on an imported file, imports it, and stores no media info", async () => {
    const result = await importMovie(healthy);

    expect(result.outcome).toBeNull();
    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(fs.existsSync(result.libraryFile)).toBe(true);
    expect(fs.existsSync(result.download)).toBe(false);
    expect(result.row).toMatchObject({ has_file: 1, path: result.libraryFile, media_info: null });
  });

  it("imports a file the probe would have called a sample: only the name can say so now", async () => {
    const result = await importMovie({ ...healthy, durationSeconds: 5 });

    expect(result.outcome).toBeNull();
    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(result.row.has_file).toBe(1);
  });

  it("imports a file the probe would have found silent", async () => {
    const result = await importMovie({ ...healthy, audioStreams: [] });

    expect(result.outcome).toBeNull();
    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(result.row.has_file).toBe(1);
  });

  it("does not let a download with no quality in its name replace a lower one on the strength of its frame size", async () => {
    // With the probe on, a 1080p frame beats the library's HDTV-720p (importerQualityAndRoots.test.ts); off, the name decides alone.
    const folder = await insertRootFolder("movie");
    const libraryFile = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.writeFileSync(libraryFile, "old");
    const movieId = await insertMovie(folder.id);
    await db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = 'HDTV-720p' WHERE id = ?").run(libraryFile, movieId);
    const download = writeDownloadFile("The.Matrix.1999.x264-GRP.mkv", "new");
    probeMediaInfo.mockResolvedValue(healthy);
    const queueId = await queueRow(movieId, download, null);

    const err = await importer.importQueueItem(queueId).catch((e: Error) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect((err as Error).message).toMatch(/Not an upgrade/);
    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(fs.readFileSync(libraryFile, "utf-8")).toBe("old");
    expect(fs.existsSync(download)).toBe(true);
  });

  it("says so once in the log, not on every file", async () => {
    const { log } = await import("../src/services/logger.js");
    const info = vi.spyOn(log, "info");
    await mediaInfoSwitch.probeLibraryFile("/a.mkv");
    await mediaInfoSwitch.probeLibraryFile("/b.mkv");
    const notes = info.mock.calls.filter((call) => String(call[0]).includes("Analyse video files"));
    expect(notes).toHaveLength(1);
  });

  it("gives a manual import no sample or silence warning, and does not probe to look for one", async () => {
    const folder = await insertRootFolder("movie");
    const movieId = await insertMovie(folder.id);
    const download = writeDownloadFile("Film.2020.x264/Film.2020.x264.mkv");
    probeMediaInfo.mockResolvedValue({ ...healthy, durationSeconds: 5 });

    const warnings = await importer.manualImportWarnings({ itemId: movieId, sourceFile: download, quality: "WEBDL-1080p" });

    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(warnings.filter((w) => w.startsWith("This file:"))).toEqual([]);
  });

  it("the same preview warns about the sample when the setting is back on", async () => {
    setSetting("enableMediaInfo", "1");
    const folder = await insertRootFolder("movie");
    const movieId = await insertMovie(folder.id);
    const download = writeDownloadFile("Film.2020.x264/Film.2020.x264.mkv");
    probeMediaInfo.mockResolvedValue({ ...healthy, durationSeconds: 5 });

    const warnings = await importer.manualImportWarnings({ itemId: movieId, sourceFile: download, quality: "WEBDL-1080p" });

    expect(probeMediaInfo).toHaveBeenCalled();
    expect(warnings.some((w) => w.startsWith("This file:") && /runs only 5s/.test(w))).toBe(true);
  });
});

describe("what the setting does not cover", () => {
  it("leaves the corrupt-media check, which the admin asks for by name, on the real probe", async () => {
    // corruptMediaCheck.ts and mediaAnalysis.ts call ffprobe.ts directly, not through the switch.
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["corruptMediaCheck.ts", "mediaAnalysis.ts", "audiobookConvert.ts"]) {
      const text = fs.readFileSync(path.join(here, "..", "src", "services", file), "utf-8");
      expect(text, file).not.toContain("mediaInfoSwitch");
    }
  });
});
