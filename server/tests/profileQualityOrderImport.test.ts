import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30f review H1, through the importer: the editor saves an order of only the allowed qualities, and a file on disk
// whose quality the profile does not allow (a Remux-2160p in a profile of two 1080p tiers) ranked below every listed
// tier, so an automatic import replaced it with a WEB-DL. The same guard as importerQualityAndRoots.test.ts, with a profile.

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

vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: vi.fn().mockResolvedValue({ extracted: [], failed: [] }),
}));

vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: vi.fn().mockResolvedValue(undefined),
  markDownloadImported: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/subtitleSync.js", () => ({ syncSubtitleToVideo: vi.fn().mockResolvedValue(false) }));

vi.mock("../src/services/comicImageConvert.js", () => ({ convertComicImagesBestEffort: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));

vi.mock("../src/services/subtitleClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchSubtitles: vi.fn().mockResolvedValue([]),
  searchCustomSubtitles: vi.fn().mockResolvedValue([]),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");

let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-quality-order-import");
  fs.mkdirSync(downloadsDir, { recursive: true });
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "download_clients", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-quality-order-import-"));
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
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

let serial = 0;
async function insertProfile(order: string[] | null): Promise<number> {
  const result = await db
    .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups, quality_order) VALUES (?, ?, 'Bluray-1080p', '[]', ?)")
    .run(`import-order-${++serial}`, JSON.stringify(["WEBDL-1080p", "Bluray-1080p"]), order ? JSON.stringify(order) : null);
  return Number(result.lastInsertRowid);
}

/** A movie in a profile whose file on disk is of `existingQuality`, and a download to import over it. */
async function libraryMovie(profileId: number, existingQuality: string) {
  const root = path.join(libraryDir, `movie-${++serial}`);
  fs.mkdirSync(root, { recursive: true });
  const folder = Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root)).lastInsertRowid);
  const libraryFile = path.join(root, "The Matrix (1999)", "The Matrix (1999).mkv");
  fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
  fs.writeFileSync(libraryFile, "old");
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, quality, quality_profile_id, monitored, status)
       VALUES ('movie', 'The Matrix', 'the matrix', 1999, ?, 1, ?, ?, ?, 1, 'missing')`
    )
    .run(folder, libraryFile, existingQuality, profileId);
  const download = path.join(downloadsDir, `The.Matrix.1999.1080p.WEB-DL.x264-GRP.${serial}.mkv`);
  fs.writeFileSync(download, "new");
  return { itemId: Number(result.lastInsertRowid), libraryFile, download };
}

async function importOver(profileId: number, existingQuality: string, quality: string) {
  const { itemId, libraryFile, download } = await libraryMovie(profileId, existingQuality);
  const outcome = await importer
    .placeFile({ itemId, episodeId: null, subItemId: null, sourceFile: download, quality, refuseDowngrade: true })
    .then(() => null, (err: Error) => err);
  return { outcome, libraryFile, download };
}

const TWO = ["WEBDL-1080p", "Bluray-1080p"];

describe("an automatic import over a file whose quality the profile's order leaves out", () => {
  it("refuses a WEB-DL over a Remux-2160p, with the profile's short order as with none", async () => {
    for (const order of [TWO, null]) {
      const result = await importOver(await insertProfile(order), "Remux-2160p", "WEBDL-1080p");
      expect(result.outcome, `order ${JSON.stringify(order)}`).toBeInstanceOf(importer.ImportSkippedError);
      expect(result.outcome?.message).toMatch(/Not an upgrade/);
      expect(fs.readFileSync(result.libraryFile, "utf-8")).toBe("old");
      expect(fs.existsSync(result.download)).toBe(true);
    }
  });

  it("still replaces a file of a lower quality the profile does not allow, and one of a listed tier it ranks lower", async () => {
    const lower = await importOver(await insertProfile(TWO), "HDTV-720p", "WEBDL-1080p");
    expect(lower.outcome).toBeNull();
    expect(fs.readFileSync(lower.libraryFile, "utf-8")).toBe("new");
    // A profile that ranks the disc over the WEB-DL replaces a WEB-DL with a disc and not the reverse.
    const up = await importOver(await insertProfile(TWO), "WEBDL-1080p", "Bluray-1080p");
    expect(up.outcome).toBeNull();
    const down = await importOver(await insertProfile(TWO), "Bluray-1080p", "WEBDL-1080p");
    expect(down.outcome).toBeInstanceOf(importer.ImportSkippedError);
  });
});
