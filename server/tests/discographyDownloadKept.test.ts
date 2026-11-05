import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30h review (M4): a discography whose import leaves album folders in the download used to be removed from the client WITHOUT
// its data, which left those folders in the downloads folder owned by nothing. The client is stubbed here at the adapter, with
// qBittorrent's semantics (removeDownload(client, id, deleteFiles)), and the real removal path of the importer runs on top of it.

vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyImported: vi.fn().mockResolvedValue(undefined),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: vi.fn().mockResolvedValue({ extracted: [], failed: [] }),
}));
vi.mock("../src/services/ffprobe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ffprobe.js")>()),
  probeMediaInfo: vi.fn().mockResolvedValue(null),
  probeAudioTags: vi.fn().mockResolvedValue(null),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let downloadClient: typeof import("../src/services/downloadClient.js");
let downloadsDir: string;
let libraryDir: string;
let rootFolder: { id: number; path: string };
let removeDownload: ReturnType<typeof vi.spyOn>;
let markImported: ReturnType<typeof vi.spyOn>;

const RELEASE = "Queen - Discography (1973-1995) [FLAC]";
const HASH = "0123456789abcdef0123456789abcdef01234567";

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  downloadClient = await import("../src/services/downloadClient.js");
  downloadsDir = path.join(config.downloadsDir, "test-discography-kept");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "recycle_bin", "queue_targets", "queue", "download_clients", "tracks", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  const adapter = downloadClient.getDownloadClientAdapter("qbittorrent");
  removeDownload = vi.spyOn(adapter, "removeDownload" as never).mockResolvedValue(undefined as never);
  markImported = vi.spyOn(adapter, "markImported" as never).mockResolvedValue(undefined as never);
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-discography-kept-"));
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("removeCompletedDownloads", "1");
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
  removeDownload.mockRestore();
  markImported.mockRestore();
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

function writeTracks(folder: string, names: string[]): void {
  for (const name of names) {
    const file = path.join(downloadsDir, RELEASE, folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `audio ${folder} ${name}`);
  }
}

/** Queen with three albums; the download is a qBittorrent torrent that the discography row is linked to. */
async function queenDownload(targets: ("queen" | "queen2" | "opera")[]): Promise<{ queueId: number; clientId: number; albums: Record<string, number> }> {
  fs.writeFileSync(path.join(rootFolder.path, ".library-in-use"), "");
  const artistId = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Queen', 'queen', ?, 1, 0, 'missing')")
        .run(rootFolder.id)
    ).lastInsertRowid
  );
  const add = async (title: string, date: string) =>
    Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(artistId, title, date)).lastInsertRowid);
  const albums = { queen: await add("Queen", "1973-07-13"), queen2: await add("Queen II", "1974-03-08"), opera: await add("A Night at the Opera", "1975-11-21") };
  const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run()).lastInsertRowid);
  const queueId = Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source, download_client_id, download_id) VALUES (?, ?, ?, NULL, 'completed', 'auto', ?, ?)")
        .run(artistId, RELEASE, path.join(downloadsDir, RELEASE), clientId, HASH)
    ).lastInsertRowid
  );
  for (const key of targets) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, albums[key]);
  return { queueId, clientId, albums };
}

describe("what becomes of the torrent of an imported discography", () => {
  it("stays in the client, not removed and not deleted, when the import leaves album folders behind", async () => {
    writeTracks("1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks("1974 - Queen II", ["01 - Procession.flac"]);
    // Not wanted from this download: it stays in the downloads folder, and so must the torrent that owns it.
    writeTracks("1975 - A Night at the Opera", ["01 - Death on Two Legs.flac"]);
    const { queueId, albums } = await queenDownload(["queen", "queen2"]);

    await importer.importQueueItem(queueId);

    expect((await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(albums.queen)) as any).toMatchObject({ has_file: 1 });
    expect((await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(albums.queen2)) as any).toMatchObject({ has_file: 1 });
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "1975 - A Night at the Opera", "01 - Death on Two Legs.flac"))).toBe(true);
    expect(removeDownload).not.toHaveBeenCalled();
    expect(markImported).not.toHaveBeenCalled();
    // The queue row is settled as before: nothing waits on the download any more.
    expect(await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId)).toBeUndefined();
  });

  it("is removed from the client with its data when nothing of it is left", async () => {
    writeTracks("1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    writeTracks("1974 - Queen II", ["01 - Procession.flac"]);
    const { queueId } = await queenDownload(["queen", "queen2"]);

    await importer.importQueueItem(queueId);

    expect(removeDownload).toHaveBeenCalledTimes(1);
    const [, downloadId, deleteFiles] = removeDownload.mock.calls[0] as unknown as [unknown, string, boolean];
    expect(downloadId).toBe(HASH);
    expect(deleteFiles).toBe(true);
  });

  it("is removed with its data when the release lacked an album it was grabbed for but nothing of it is left", async () => {
    writeTracks("1973 - Queen", ["01 - Keep Yourself Alive.flac"]);
    // The opera is wanted but the release has no folder for it: it is searched on its own, and the torrent has nothing more to keep.
    const { queueId } = await queenDownload(["queen", "opera"]);

    await importer.importQueueItem(queueId);

    expect(removeDownload).toHaveBeenCalledTimes(1);
    expect((removeDownload.mock.calls[0] as unknown as [unknown, string, boolean])[2]).toBe(true);
  });
});
