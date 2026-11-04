import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

// Only the parts of an import that reach outside the database are replaced (notifications, the download client,
// archive extraction, ffprobe); the placement itself, the root folder lookup and the refusal under test are real.
const notifyImported = vi.fn();
const notifyUpgraded = vi.fn();
vi.mock("../src/services/notifications.js", () => ({
  notifyImported: (...args: unknown[]) => notifyImported(...args),
  notifyUpgraded: (...args: unknown[]) => notifyUpgraded(...args),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: vi.fn().mockResolvedValue({ extracted: [], failed: [] }),
}));
vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: vi.fn().mockResolvedValue(undefined),
  markDownloadImported: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: vi.fn().mockResolvedValue(null),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (key: string, value: string) => void;
let config: (typeof import("../src/config.js"))["config"];
let placeFile: (typeof import("../src/services/importer.js"))["placeFile"];
let placeAlbumFiles: (typeof import("../src/services/importer.js"))["placeAlbumFiles"];
let placeSeasonPackFiles: (typeof import("../src/services/importer.js"))["placeSeasonPackFiles"];
let importQueueItem: (typeof import("../src/services/importer.js"))["importQueueItem"];
let ImportSkippedError: (typeof import("../src/services/importer.js"))["ImportSkippedError"];
let renameOneMediaItem: (typeof import("../src/services/importer.js"))["renameOneMediaItem"];
let renameLibraryFiles: (typeof import("../src/services/importer.js"))["renameLibraryFiles"];
let moveItemFolder: (typeof import("../src/services/importer.js"))["moveItemFolder"];

let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  ({ placeFile, placeAlbumFiles, placeSeasonPackFiles, importQueueItem, ImportSkippedError, renameOneMediaItem, renameLibraryFiles, moveItemFolder } = await import(
    "../src/services/importer.js"
  ));
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "read-only-root-fixtures");
});

beforeEach(async () => {
  for (const table of ["history", "recycle_bin", "queue", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  notifyImported.mockReset();
  notifyUpgraded.mockReset();
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-readonly-library-"));
  setSetting("skipFreeSpaceCheck", "1");
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

async function insertRootFolder(mediaType: string, readOnly: boolean): Promise<{ id: number; path: string }> {
  const dir = path.join(libraryDir, `${mediaType}-${readOnly ? "read-only" : "writable"}`);
  fs.mkdirSync(dir, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, read_only) VALUES (?, ?, ?)").run(dir, mediaType, readOnly ? 1 : 0);
  return { id: Number(result.lastInsertRowid), path: dir };
}

async function insertMovie(rootFolderId: number): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, monitored, status) VALUES ('movie', 'The Matrix', 'the matrix', 1999, ?, 0, 1, 'missing')`
    )
    .run(rootFolderId);
  return Number(result.lastInsertRowid);
}

function writeDownloadFile(name: string, content = "fake bytes"): string {
  const file = path.join(downloadsDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function expectedMessage(folderPath: string): string {
  return `Root folder "${folderPath}" is a read-only library: nothing is imported into it`;
}

describe("a read-only library is never rewritten", () => {
  /** A movie whose file sits under a name the naming template would change. */
  async function movieWithMisnamedFile(folder: { id: number; path: string }, title: string) {
    const oldPath = path.join(folder.path, `${title.toLowerCase()}-old-name.mkv`);
    fs.writeFileSync(oldPath, "x");
    const result = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, monitored, status) VALUES ('movie', ?, ?, 1999, ?, 1, ?, 1, 'downloaded')`
      )
      .run(title, title.toLowerCase(), folder.id, oldPath);
    return { id: Number(result.lastInsertRowid), oldPath, newPath: path.join(folder.path, `${title} (1999)`, `${title} (1999).mkv`) };
  }

  it("renameOneMediaItem renames nothing in a read-only library, and a writable one is renamed as before", async () => {
    const readOnly = await insertRootFolder("movie", true);
    const writable = await insertRootFolder("movie", false);
    const locked = await movieWithMisnamedFile(readOnly, "Locked");
    const open = await movieWithMisnamedFile(writable, "Open");

    const lockedResult = await renameOneMediaItem(locked.id);
    const openResult = await renameOneMediaItem(open.id);

    expect(lockedResult).toEqual({ renamed: [], errors: [], skippedMusic: 0 });
    expect(fs.existsSync(locked.oldPath)).toBe(true);
    expect(fs.existsSync(path.dirname(locked.newPath))).toBe(false);
    expect(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(locked.id)) as { path: string }).path).toBe(locked.oldPath);
    // Not that nothing ever renames: the same file in a writable library moves.
    expect(openResult.renamed).toEqual([{ title: "Open", from: open.oldPath, to: open.newPath }]);
    expect(fs.existsSync(open.newPath)).toBe(true);
  });

  it("a preview of the rename lists nothing for a read-only library either", async () => {
    const readOnly = await insertRootFolder("movie", true);
    const locked = await movieWithMisnamedFile(readOnly, "Locked");

    expect((await renameOneMediaItem(locked.id, undefined, true)).renamed).toEqual([]);
  });

  it("renameLibraryFiles passes over the items of a read-only library and renames the rest", async () => {
    const readOnly = await insertRootFolder("movie", true);
    const writable = await insertRootFolder("movie", false);
    const locked = await movieWithMisnamedFile(readOnly, "Locked");
    const open = await movieWithMisnamedFile(writable, "Open");

    const result = await renameLibraryFiles("movie");

    expect(result.renamed.map((r) => r.title)).toEqual(["Open"]);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(locked.oldPath)).toBe(true);
    expect(fs.existsSync(open.newPath)).toBe(true);
  });

  it("renameLibraryFiles for chosen items leaves a read-only library's item alone as well", async () => {
    const readOnly = await insertRootFolder("movie", true);
    const locked = await movieWithMisnamedFile(readOnly, "Locked");

    const result = await renameLibraryFiles("movie", false, [locked.id]);

    expect(result.renamed).toEqual([]);
    expect(fs.existsSync(locked.oldPath)).toBe(true);
  });

  it("moveItemFolder refuses to move a show's folder in a read-only library, and moves it in a writable one", async () => {
    async function show(folder: { id: number; path: string }) {
      const showId = Number(
        (
          await db
            .prepare(
              "INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'New Title', 'new title', ?, 'Old Title', 1, 1, 'downloaded')"
            )
            .run(folder.id)
        ).lastInsertRowid
      );
      const file = path.join(folder.path, "Old Title", "Season 01", "x.mkv");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
      const episodeId = Number(
        (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'E', 1, 1, ?)").run(showId, file))
          .lastInsertRowid
      );
      return { showId, episodeId, file };
    }
    const readOnly = await insertRootFolder("series", true);
    const locked = await show(readOnly);

    const failure = await moveItemFolder(locked.showId).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(`Root folder "${readOnly.path}" is a read-only library: its folders are not moved`);
    expect(fs.readFileSync(locked.file, "utf-8")).toBe("x");
    expect(fs.existsSync(path.join(readOnly.path, "New Title"))).toBe(false);
    expect(((await db.prepare("SELECT file_path FROM episodes WHERE id = ?").get(locked.episodeId)) as { file_path: string }).file_path).toBe(locked.file);
    expect(((await db.prepare("SELECT library_folder FROM media_items WHERE id = ?").get(locked.showId)) as { library_folder: string }).library_folder).toBe("Old Title");

    // The same show in a writable library is moved, so the refusal is down to the read-only flag.
    const writable = await insertRootFolder("series", false);
    const open = await show(writable);
    const moved = await moveItemFolder(open.showId);
    expect(moved.to).toBe(path.join(writable.path, "New Title"));
    expect(fs.existsSync(path.join(writable.path, "New Title", "Season 01", "x.mkv"))).toBe(true);
  });
});

describe("an import into a read-only library is refused", () => {
  it("placeFile throws ImportSkippedError and leaves the download, the library and the item untouched", async () => {
    const folder = await insertRootFolder("movie", true);
    const movieId = await insertMovie(folder.id);
    const source = writeDownloadFile("The.Matrix.1999.1080p.WEB-GRP.mkv");

    const failure = await placeFile({ itemId: movieId, episodeId: null, subItemId: null, sourceFile: source, quality: "WEBDL-1080p" }).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual([]);
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)) as { has_file: number; path: string | null };
    expect(Number(row.has_file)).toBe(0);
    expect(row.path).toBeNull();
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM history WHERE media_item_id = ?").get(movieId)) as { c: number }).c).toBe(0);
    expect(notifyImported).not.toHaveBeenCalled();
  });

  it("the same movie in a writable library imports, so the refusal is down to the read-only flag", async () => {
    const folder = await insertRootFolder("movie", false);
    const movieId = await insertMovie(folder.id);
    const source = writeDownloadFile("The.Matrix.1999.1080p.WEB-GRP.mkv");

    const placed = await placeFile({ itemId: movieId, episodeId: null, subItemId: null, sourceFile: source, quality: "WEBDL-1080p" });

    expect(placed.destPath).toBe(path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv"));
    expect(fs.existsSync(placed.destPath)).toBe(true);
    expect(fs.existsSync(source)).toBe(false);
  });

  it("the library is read-only a moment after it was writable: switching the flag is enough", async () => {
    const folder = await insertRootFolder("movie", false);
    const movieId = await insertMovie(folder.id);
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(folder.id);
    const source = writeDownloadFile("The.Matrix.1999.1080p.WEB-GRP.mkv");

    await expect(placeFile({ itemId: movieId, episodeId: null, subItemId: null, sourceFile: source, quality: null })).rejects.toBeInstanceOf(ImportSkippedError);
  });

  it("is a final skip even when the library's folder also looks like an unmounted share", async () => {
    const folder = await insertRootFolder("movie", true); // empty on disk ...
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, has_file, monitored, status, path) VALUES ('movie', 'Recorded', 'recorded', ?, 1, 1, 'unknown', ?)`)
      .run(folder.id, path.join(folder.path, "Recorded (2020)", "Recorded.mkv")); // ... with files recorded in it
    const movieId = await insertMovie(folder.id);
    const source = writeDownloadFile("The.Matrix.1999.1080p.WEB-GRP.mkv");

    const failure = await placeFile({ itemId: movieId, episodeId: null, subItemId: null, sourceFile: source, quality: null }).catch((e) => e);

    // Not the plain error that parks an import to be retried when the share comes back: nothing will ever be imported here.
    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
  });

  it("placeAlbumFiles refuses an album of a read-only music library and moves none of its files", async () => {
    const folder = await insertRootFolder("artist", true);
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Some Artist', 'some artist', ?, 1, 0, 'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artistId)).lastInsertRowid);
    const anchor = writeDownloadFile(path.join("Some.Album.2020", "01 - Track One.mp3"));
    const sibling = writeDownloadFile(path.join("Some.Album.2020", "02 - Track Two.mp3"));

    const failure = await placeAlbumFiles({ itemId: artistId, subItemId: albumId, anchorFile: anchor, quality: null }).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
    expect(fs.existsSync(anchor)).toBe(true);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual([]);
  });

  it("placeFile for a track of an album takes the same refusal", async () => {
    const folder = await insertRootFolder("artist", true);
    const artistId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Some Artist', 'some artist', ?, 1, 0, 'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const albumId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artistId)).lastInsertRowid);
    const track = writeDownloadFile(path.join("Some.Album.2020", "01 - Track One.mp3"));

    const failure = await placeFile({ itemId: artistId, episodeId: null, subItemId: albumId, sourceFile: track, quality: null }).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
    expect(fs.existsSync(track)).toBe(true);
  });

  it("placeSeasonPackFiles refuses a season pack for a series in a read-only library", async () => {
    const folder = await insertRootFolder("series", true);
    const seriesId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('series', 'Some Show', 'some show', 2020, ?, 1, 0, 'missing')`).run(folder.id))
        .lastInsertRowid
    );
    const anchor = writeDownloadFile(path.join("Some.Show.S01.1080p", "Some.Show.S01E01.1080p.mkv"));

    const failure = await placeSeasonPackFiles({ itemId: seriesId, seasonNumber: 1, anchorFile: anchor, quality: null }).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
    expect(fs.existsSync(anchor)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual([]);
  });

  it("a completed download for a read-only library stays in the queue and in the downloads folder", async () => {
    const folder = await insertRootFolder("movie", true);
    const movieId = await insertMovie(folder.id);
    const download = writeDownloadFile("The.Matrix.1999.1080p.WEB-GRP.mkv");
    const queueId = Number(
      (
        await db
          .prepare(`INSERT INTO queue (media_item_id, title, quality, download_path, status) VALUES (?, 'The.Matrix.1999.1080p.WEB-GRP', 'WEBDL-1080p', ?, 'downloaded')`)
          .run(movieId, download)
      ).lastInsertRowid
    );

    const failure = await importQueueItem(queueId).catch((e) => e);

    expect(failure).toBeInstanceOf(ImportSkippedError);
    expect(failure.message).toBe(expectedMessage(folder.path));
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId)).toBeDefined();
    expect(fs.existsSync(download)).toBe(true);
    expect(fs.readdirSync(folder.path)).toEqual([]);
  });
});
