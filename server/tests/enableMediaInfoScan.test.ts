import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30e: the library scan reads a file's streams only while "Analyse video files" (enableMediaInfo) is on.

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    isEpisodeMonitoredByDefault: actual.isEpisodeMonitoredByDefault,
    upcomingEpisodes: actual.upcomingEpisodes,
    proxyScreenscraperArtwork: actual.proxyScreenscraperArtwork,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchSeriesEpisodesFor: vi.fn().mockResolvedValue([]),
    fetchSeriesEpisodesForProvider: vi.fn().mockResolvedValue([]),
    fetchSeriesSeasonsFor: vi.fn().mockResolvedValue([]),
    fetchArtistAlbumsFor: vi.fn().mockResolvedValue(null),
    fetchCollectionChildrenFor: vi.fn().mockResolvedValue({ provider: null, children: [] }),
    fetchMovieByTmdbId: vi.fn().mockResolvedValue({}),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let scanAndImportLibrary: (typeof import("../src/services/libraryScan.js"))["scanAndImportLibrary"];
let tmpRoot: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ scanAndImportLibrary } = await import("../src/services/libraryScan.js"));
});

beforeEach(async () => {
  for (const t of ["tracks", "episodes", "seasons", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  probeMediaInfo.mockReset().mockResolvedValue({ videoCodec: "h264", width: 1920, height: 1080 });
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  setSetting("enableMediaInfo", "");
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-scan-media-info-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function movieRoot(): Promise<string> {
  const p = path.join(tmpRoot, "movie");
  fs.mkdirSync(p, { recursive: true });
  await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, "movie", "movie");
  return p;
}

describe("a library scan and enableMediaInfo", () => {
  it("probes a new movie and stores the answer while the setting is on", async () => {
    fs.writeFileSync(path.join(await movieRoot(), "Probed Movie (2022).mkv"), "x");

    await scanAndImportLibrary("movie");

    expect(probeMediaInfo).toHaveBeenCalledTimes(1);
    const row = (await db.prepare("SELECT media_info FROM media_items WHERE type='movie'").get()) as { media_info: string | null };
    expect(JSON.parse(row.media_info!)).toEqual({ videoCodec: "h264", width: 1920, height: 1080 });
  });

  it("still finds and adds the movie, with no probe and no media info, while it is off", async () => {
    setSetting("enableMediaInfo", "0");
    const filePath = path.join(await movieRoot(), "Probed Movie (2022).mkv");
    fs.writeFileSync(filePath, "x");

    const result = await scanAndImportLibrary("movie");

    expect(probeMediaInfo).not.toHaveBeenCalled();
    expect(result.created + result.matched).toBe(1);
    const row = (await db.prepare("SELECT has_file, path, media_info FROM media_items WHERE type='movie'").get()) as { has_file: number; path: string; media_info: string | null };
    expect(row).toMatchObject({ has_file: 1, path: filePath, media_info: null });
  });
});
