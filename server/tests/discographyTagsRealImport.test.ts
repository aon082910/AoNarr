import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30h: the whole chain with the real ffprobe, nothing about the tags mocked: folders whose names say nothing are filed under
// the album their files' tags name. The node image has no ffmpeg: run this in a container that installs it; without it the case skips.
const hasFfmpeg = ["ffmpeg", "ffprobe"].every((tool) => !spawnSync(tool, ["-version"]).error);

vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyImported: vi.fn(),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: vi.fn().mockResolvedValue({ extracted: [], failed: [] }),
}));
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  removeQueueItemDownload: vi.fn().mockResolvedValue(undefined),
  markDownloadImported: vi.fn().mockResolvedValue(undefined),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let downloadsDir: string;
let libraryDir: string;
let rootFolderId: number;

const RELEASE = "Queen - Discography (1973-1995) [FLAC]";

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  downloadsDir = path.join(config.downloadsDir, "test-discography-tags-real");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "recycle_bin", "queue", "download_clients", "tracks", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-discography-tags-real-"));
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeAudioTagsOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("importStrategy", "move");
  const p = path.join(libraryDir, "artist");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, ".library-in-use"), "");
  rootFolderId = Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'artist')").run(p)).lastInsertRowid);
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

/** A tenth of a second of silence as a tagged FLAC file in a folder of the release. */
function makeFlac(folder: string, name: string, tags: Record<string, string>): void {
  const file = path.join(downloadsDir, RELEASE, folder, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.1"];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  const made = spawnSync("ffmpeg", [...args, "-y", file]);
  if (made.status !== 0) throw new Error(`ffmpeg could not make ${file}: ${made.stderr?.toString()}`);
}

describe.skipIf(!hasFfmpeg)("importing a discography by the tags ffprobe reads", () => {
  it("files an oddly named folder and an album's disc folders under the albums their tags name", async () => {
    const artistId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', ?, 1, 0, 'missing')").run(rootFolderId))
        .lastInsertRowid
    );
    const add = async (title: string, date: string) =>
      Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(artistId, title, date)).lastInsertRowid);
    const queen2 = await add("Queen II", "1974-03-08");
    const opera = await add("A Night at the Opera", "1975-11-21");
    const compilation = await add("Sheer Heart Attack", "1974-11-08");
    makeFlac("CD1 - misc rips", "01 - Procession.flac", { album: "Queen II", album_artist: "Queen", date: "1974" });
    makeFlac("CD1 - misc rips", "02 - Father to Son.flac", { album: "Queen II", album_artist: "Queen", date: "1974" });
    makeFlac("Disc one", "01 - Death on Two Legs.flac", { album: "A Night at the Opera", album_artist: "Queen", discnumber: "1", disctotal: "2" });
    makeFlac("Disc two", "01 - Bohemian Rhapsody.flac", { album: "A Night at the Opera", album_artist: "Queen", discnumber: "2", disctotal: "2" });
    makeFlac("Now That's Queen", "01 - Killer Queen.flac", { album: "Sheer Heart Attack", album_artist: "Various Artists" });
    for (const [n, title] of [[1, "Death on Two Legs"], [2, "Bohemian Rhapsody"]] as const) {
      await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(opera, n, title);
    }
    const queueId = Number(
      (await db.prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source) VALUES (?, ?, ?, NULL, 'completed', 'auto')").run(artistId, RELEASE, path.join(downloadsDir, RELEASE)))
        .lastInsertRowid
    );
    for (const id of [queen2, opera, compilation]) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, id);

    await importer.importQueueItem(queueId);

    // The compilation is no album of Queen: the release lacks that album, so it is blocklisted and the album looked for on its own.
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist WHERE media_item_id = ?").get(artistId)) as any).c)).toBe(1);
    const row = async (id: number): Promise<any> => db.prepare("SELECT * FROM sub_items WHERE id = ?").get(id);
    expect((await row(queen2)).has_file).toBe(1);
    expect(fs.readdirSync((await row(queen2)).file_path)).toHaveLength(2);
    expect((await row(opera)).has_file).toBe(1);
    expect(fs.readdirSync((await row(opera)).file_path)).toHaveLength(2);
    expect((await row(compilation)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Now That's Queen", "01 - Killer Queen.flac"))).toBe(true);
    const trackRows = (await db.prepare("SELECT has_file FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(opera)) as any[];
    expect(trackRows.map((t) => Number(t.has_file))).toEqual([1, 1]);
  });
});
