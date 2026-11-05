import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

const notifyImported = vi.fn();
const notifyManualInteractionRequired = vi.fn();
vi.mock("../src/services/notifications.js", () => ({
  notifyImported: (...args: unknown[]) => notifyImported(...args),
  notifyUpgraded: vi.fn(),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

const removeQueueItemDownload = vi.fn();
const markDownloadImported = vi.fn();
vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
  markDownloadImported: (...args: unknown[]) => markDownloadImported(...args),
}));

vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let downloadsDir: string;
let libraryDir: string;
let rootFolder: { id: number; path: string };

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  downloadsDir = path.join(config.downloadsDir, "test-discography");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "recycle_bin", "queue", "download_clients", "tracks", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  notifyImported.mockReset();
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  removeQueueItemDownload.mockReset().mockResolvedValue(undefined);
  markDownloadImported.mockReset().mockResolvedValue(undefined);
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-discography-library-"));
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeAudioTagsOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
  const p = path.join(libraryDir, "artist");
  fs.mkdirSync(p, { recursive: true });
  rootFolder = { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'artist', 'artist')").run(p)).lastInsertRowid), path: p };
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

const RELEASE = "Queen - Discography (1973-1995) [FLAC]";

function writeTracks(release: string, folder: string, names: string[]): string[] {
  return names.map((name) => {
    const file = path.join(downloadsDir, release, folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `audio ${folder} ${name}`);
    return file;
  });
}

async function queen(): Promise<{ artistId: number; albums: Record<string, number> }> {
  // A library that has files recorded in it holds something: an empty root would read as a share that is not mounted.
  fs.writeFileSync(path.join(rootFolder.path, ".library-in-use"), "");
  const artistId = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', ?, 1, 0, 'missing')")
        .run(rootFolder.id)
    ).lastInsertRowid
  );
  const add = async (title: string, date: string, hasFile = 0) =>
    Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, ?)").run(artistId, title, date, hasFile)).lastInsertRowid);
  return {
    artistId,
    albums: {
      queen: await add("Queen", "1973-07-13"),
      queen2: await add("Queen II", "1974-03-08"),
      sheer: await add("Sheer Heart Attack", "1974-11-08"),
      opera: await add("A Night at the Opera", "1975-11-21"),
      innuendo: await add("Innuendo", "1991-02-04"),
    },
  };
}

async function queueDiscography(artistId: number, targets: number[], overrides: { downloadPath?: string | null; title?: string } = {}): Promise<number> {
  const downloadPath = overrides.downloadPath === undefined ? path.join(downloadsDir, RELEASE) : overrides.downloadPath;
  const queueId = Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source) VALUES (?, ?, ?, NULL, 'completed', 'auto')")
        .run(artistId, overrides.title ?? RELEASE, downloadPath)
    ).lastInsertRowid
  );
  for (const id of targets) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, id);
  return queueId;
}

async function albumRow(id: number): Promise<any> {
  return db.prepare("SELECT * FROM sub_items WHERE id = ?").get(id);
}

const queueRow = async (id: number) => db.prepare("SELECT * FROM queue WHERE id = ?").get(id);

describe("importing a discography", () => {
  it("files each wanted album's folder under that album", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen [FLAC]", ["01 - Keep Yourself Alive.flac", "02 - Doing All Right.flac", "03 - Great King Rat.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac", "02 - Father to Son.flac"]);
    writeTracks(RELEASE, "1991 - Innuendo (Remastered)", ["01 - Innuendo.flac", "02 - I'm Going Slightly Mad.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2, albums.innuendo]);

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
    for (const [key, files] of [["queen", 3], ["queen2", 2], ["innuendo", 2]] as const) {
      const row = await albumRow(albums[key]);
      expect(row.has_file, key).toBe(1);
      expect(row.file_path.startsWith(rootFolder.path), key).toBe(true);
      expect(fs.readdirSync(row.file_path), key).toHaveLength(files);
      expect(row.file_release_title).toBe(RELEASE);
    }
    expect((await albumRow(albums.sheer)).has_file).toBe(0);
    const imported = (await db.prepare("SELECT data FROM history WHERE event_type = 'imported'").all()) as any[];
    expect(imported.map((h) => JSON.parse(h.data).subItemId).sort()).toEqual([albums.queen, albums.queen2, albums.innuendo].sort());
  });

  it("keeps seeding when the strategy is hardlink: the download stays whole and is marked imported", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    setSetting("importStrategy", "hardlink");
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1973 - Queen", "01 - Keep Yourself Alive.flac"))).toBe(true);
    expect(markDownloadImported).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
  });

  it("leaves the folders of albums that were not wanted in the download, and keeps the download", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    writeTracks(RELEASE, "1975 - A Night at the Opera", ["01 - Death on Two Legs.flac"]);
    await db.prepare("UPDATE sub_items SET has_file = 1 WHERE id = ?").run(albums.opera);
    setSetting("removeCompletedDownloads", "1");
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera", "01 - Death on Two Legs.flac"))).toBe(true);
    // The download stays in its client, with its data: the folders left in it are its own, and a torrent removed without its data
    // would leave them in the downloads folder owned by nothing (M4). Only a download that is whole in the library is removed.
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
    expect(markDownloadImported).not.toHaveBeenCalled();
  });

  it("finds the folder of the discography itself when the client reported none", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2], { downloadPath: null });

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
  });

  it("imports a multi-disc album from its disc folders", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, path.join("1975 - A Night at the Opera", "CD1"), ["01 - Death on Two Legs.flac", "02 - Lazing on a Sunday Afternoon.flac"]);
    writeTracks(RELEASE, path.join("1975 - A Night at the Opera", "CD2"), ["01 - Bohemian Rhapsody.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    const queueId = await queueDiscography(artistId, [albums.opera, albums.queen2]);

    await importer.importQueueItem(queueId);

    const opera = await albumRow(albums.opera);
    expect(opera.has_file).toBe(1);
    expect(fs.readdirSync(opera.file_path)).toHaveLength(3);
  });

  it("blocklists a release that lacks an album it was grabbed for, and wakes that album", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 6 WHERE id = ?").run(albums.sheer);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2, albums.sheer]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.sheer)).has_file).toBe(0);
    expect(Number((await albumRow(albums.sheer)).auto_search_misses)).toBe(0);
    const blocked = (await db.prepare("SELECT release_title, reason FROM blocklist WHERE media_item_id = ?").all(artistId)) as any[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0].release_title).toBe(RELEASE);
    expect(blocked[0].reason).toContain("1 album");
  });

  it("takes the plainer of two folders of one album and leaves the other", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1974 - Queen II (Deluxe Edition)", ["01 - Procession.flac", "02 - Father to Son.flac", "03 - Bonus.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac", "02 - Father to Son.flac"]);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect(fs.readdirSync((await albumRow(albums.queen2)).file_path)).toHaveLength(2);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1974 - Queen II (Deluxe Edition)", "03 - Bonus.flac"))).toBe(true);
  });

  it("leaves a download whose folders are no album of the artist for a manual import", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "Some Other Band - Record", ["01 - Song.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("No album of");
    expect(await queueRow(queueId)).toBeDefined();
    expect((await albumRow(albums.queen)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Some Other Band - Record", "01 - Song.flac"))).toBe(true);
  });

  it("does not guess among tracks lying loose in the discography's folder", async () => {
    const { artistId, albums } = await queen();
    const file = path.join(downloadsDir, RELEASE, "01 - Keep Yourself Alive.flac");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "audio");
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("will not take albums out of a folder that other downloads share", async () => {
    const { artistId, albums } = await queen();
    writeTracks("", "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2], { downloadPath: downloadsDir });

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("shared with other downloads");
    expect((await albumRow(albums.queen)).has_file).toBe(0);
  });

  it("imports one album of a discography from a file picked by hand, and keeps the rest on the queue", async () => {
    const { artistId, albums } = await queen();
    const [picked] = writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac", "02 - Father to Son.flac"]);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId, picked);

    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect((await albumRow(albums.queen)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1973 - Queen", "01 - Keep Yourself Alive.flac"))).toBe(true);
    expect(await queueRow(queueId)).toBeDefined();
    const left = ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ?").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));
    expect(left).toEqual([albums.queen]);

    const [second] = [path.join(downloadsDir, RELEASE, "1973 - Queen", "01 - Keep Yourself Alive.flac")];
    await importer.importQueueItem(queueId, second);
    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
  });

  it("parks the row, and holds the album, when one album's folder is found and cannot be placed", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    // Twenty files for an album of three tracks: the importer's "looks like several albums" guard.
    for (let n = 1; n <= 3; n++) await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title) VALUES (?, ?, ?)").run(albums.queen2, n, `Track ${n}`);
    writeTracks(RELEASE, "1974 - Queen II", Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, "0")} - Song.flac`));
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("1 could not be placed");
    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).has_file).toBe(0);
    // The row stays, for the album that failed only, and the release is not taken again.
    expect(await queueRow(queueId)).toBeDefined();
    const left = ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ?").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));
    expect(left).toEqual([albums.queen2]);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist WHERE media_item_id = ?").get(artistId)) as any).c)).toBe(1);
  });

  it("leaves an album's disc folders laid side by side, and has the album looked for on its own", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1975 - A Night at the Opera (Disc 1)", ["01 - Death on Two Legs.flac", "02 - Lazing.flac"]);
    writeTracks(RELEASE, "1975 - A Night at the Opera (Disc 2)", ["01 - Bohemian Rhapsody.flac"]);
    await db.prepare("UPDATE sub_items SET auto_search_misses = 6 WHERE id = ?").run(albums.opera);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.opera]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    // Neither disc is filed as the album.
    expect((await albumRow(albums.opera)).has_file).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera (Disc 1)", "01 - Death on Two Legs.flac"))).toBe(true);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera (Disc 2)", "01 - Bohemian Rhapsody.flac"))).toBe(true);
    expect(Number((await albumRow(albums.opera)).auto_search_misses)).toBe(0);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
  });

  it("parks the row, with a reason, after a hand-picked import of one album of several", async () => {
    const { artistId, albums } = await queen();
    const [picked] = writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);
    // What Activity's manual import does before it calls the importer.
    await db.prepare("UPDATE queue SET import_started_at = ?, import_resume_state = 3 WHERE id = ?").run("2026-11-01 10:00:00", queueId);

    await importer.importQueueItem(queueId, picked);

    const row = (await queueRow(queueId)) as any;
    expect(row.import_started_at).toBeNull();
    expect(Number(row.import_resume_state)).toBe(0);
    expect(row.import_skipped_reason).toContain("still to be imported");
  });

  it("imports from a folder that is not named like the release when the admin picked a file in it", async () => {
    const { artistId, albums } = await queen();
    const folderName = "Queen - Complete Studio Albums";
    const [picked] = writeTracks(folderName, "1974 - Queen II", ["01 - Procession.flac"]);
    writeTracks(folderName, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const downloadPath = path.join(downloadsDir, folderName);

    // By itself (no one picked a file), a folder not named like the release is not told apart from a shared one.
    const automatic = await queueDiscography(artistId, [albums.queen, albums.queen2], { downloadPath });
    const err = await importer.importQueueItem(automatic).catch((e) => e);
    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("shared with other downloads");

    await importer.importQueueItem(automatic, picked);
    expect((await albumRow(albums.queen2)).has_file).toBe(1);
    expect((await albumRow(albums.queen)).has_file).toBe(0);
    // Still no import from the downloads folder or a category folder itself.
    const shared = await queueDiscography(artistId, [albums.queen], { downloadPath: config.downloadsDir });
    const [loose] = writeTracks("", "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const refused = await importer.importQueueItem(shared, loose).catch((e) => e);
    expect(refused).toBeInstanceOf(importer.ImportSkippedError);
  });

  it("says so when every album the discography was grabbed for is gone", async () => {
    const { artistId } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, []);

    const err = await importer.importQueueItem(queueId).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(err.message).toContain("none of the albums it was for is left");
  });

  it("finishes a discography whose albums all came from it already, as after a restart that cut off the clean-up", async () => {
    const { artistId, albums } = await queen();
    for (const id of [albums.queen, albums.queen2]) {
      await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, file_release_title = ? WHERE id = ?").run(libraryDir, RELEASE, id);
    }
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2], { downloadPath: null });

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });

  it("does not blame the release for albums a cut-off import had already filed", async () => {
    const { artistId, albums } = await queen();
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, file_release_title = ? WHERE id = ?").run(libraryDir, RELEASE, albums.queen2);
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });

  it("does not replace an album that got files from another download while the discography downloaded", async () => {
    const { artistId, albums } = await queen();
    writeTracks(RELEASE, "1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks(RELEASE, "1974 - Queen II", ["01 - Procession.flac"]);
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, file_release_title = 'Queen - Queen II (1974) [FLAC]' WHERE id = ?").run(libraryDir, albums.queen2);
    const queueId = await queueDiscography(artistId, [albums.queen, albums.queen2]);

    await importer.importQueueItem(queueId);

    expect((await albumRow(albums.queen)).has_file).toBe(1);
    expect((await albumRow(albums.queen2)).file_release_title).toBe("Queen - Queen II (1974) [FLAC]");
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1974 - Queen II", "01 - Procession.flac"))).toBe(true);
    expect(await queueRow(queueId)).toBeUndefined();
  });

  it("refuses a hand-picked file whose folder is none of the albums", async () => {
    const { artistId, albums } = await queen();
    const [picked] = writeTracks(RELEASE, "Bonus Material", ["01 - Demo.flac"]);
    const queueId = await queueDiscography(artistId, [albums.queen]);

    const err = await importer.importQueueItem(queueId, picked).catch((e) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(await queueRow(queueId)).toBeDefined();
  });
});
