import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("../src/services/notifications.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, notifyImported: vi.fn(async () => {}), notifyUpgraded: vi.fn(async () => {}) };
});
vi.mock("../src/services/ffprobe.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, probeMediaInfo: vi.fn(async () => null) };
});

/**
 * The Downloaded*Scan commands with a path: the media found there is matched to the library and imported with the title's
 * profile and naming rules; a path outside the places a download can be in is refused and nothing is touched.
 */
let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let downloadsDir: string;
let dl: string;
let libraryDir: string;
let outside: string;

const MOUNTS = { radarr: "v3", sonarr: "v3", lidarr: "v1", readarr: "v1" } as const;
type Mount = keyof typeof MOUNTS;
const COMMANDS: Record<Mount, string> = { radarr: "DownloadedMoviesScan", sonarr: "DownloadedEpisodesScan", lidarr: "DownloadedAlbumsScan", readarr: "DownloadedBooksScan" };

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  const { config } = await import("../src/config.js");
  downloadsDir = config.downloadsDir;
  setSetting("skipFreeSpaceCheck", "1");
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "remote_path_mappings", "download_clients", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  dl = path.join(downloadsDir, "scan-dl");
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-scan-lib-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-scan-outside-"));
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
  setSetting("importStrategy", "move");
  setSetting("scanPathAllowList", "");
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(dl, { recursive: true, force: true });
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const post = (url: string, body: unknown) => request(app).post(url).set("X-Api-Key", apiKey).send(body as object);

/** Sends the scan command and waits for its record to finish. */
async function scan(mount: Mount, body: Record<string, unknown>) {
  const res = await post(`/${mount}/api/${MOUNTS[mount]}/command`, { name: COMMANDS[mount], ...body });
  if (res.status !== 201) return { res, record: null as any };
  const record = await vi.waitFor(async () => {
    const r = (await get(`/${mount}/api/${MOUNTS[mount]}/command/${res.body.id}`)).body;
    expect(["completed", "failed"]).toContain(r.status);
    return r;
  });
  return { res, record };
}
const commandCount = async (mount: Mount) => ((await get(`/${mount}/api/${MOUNTS[mount]}/command`)).body as any[]).length;

function write(base: string, relative: string, content = "media bytes"): string {
  const full = path.join(base, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

async function rootFolder(type: string, name: string): Promise<{ id: number; dir: string }> {
  const dir = path.join(libraryDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(dir, type, name)).lastInsertRowid);
  return { id, dir };
}

async function movie(title = "The Matrix", year = 1999, over: { hasFile?: number; quality?: string | null; path?: string | null } = {}): Promise<{ id: number; dir: string }> {
  const root = await rootFolder("movie", "movies");
  const id = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, quality, path, status) VALUES ('movie', ?, ?, ?, ?, 1, ?, ?, ?, 'missing')")
        .run(title, title.toLowerCase(), year, root.id, over.hasFile ?? 0, over.quality ?? null, over.path ?? null)
    ).lastInsertRowid
  );
  return { id, dir: root.dir };
}

const MATRIX = "The.Matrix.1999.1080p.BluRay.x264-GRP";

describe("a path the scan refuses", () => {
  const refused = async (mount: Mount, body: Record<string, unknown>, property = "Path") => {
    const before = await commandCount(mount);
    const { res, record } = await scan(mount, body);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ propertyName: property });
    expect(record).toBeNull();
    // Refused before it was accepted: no command was recorded.
    expect(await commandCount(mount)).toBe(before);
    return res.body[0].errorMessage as string;
  };

  it("is not text, not absolute, holds .., or does not exist", async () => {
    await movie();
    await refused("radarr", { path: 42 });
    await refused("radarr", { path: { a: 1 } });
    expect(await refused("radarr", { path: "scan-dl/anything" })).toMatch(/absolute/);
    expect(await refused("radarr", { path: `${dl}/../scan-dl` })).toMatch(/\.\./);
    expect(await refused("radarr", { path: `${dl}${path.sep}..${path.sep}..${path.sep}etc` })).toMatch(/\.\./);
    expect(await refused("radarr", { path: path.join(dl, "does-not-exist") })).toMatch(/does not exist/);
  });

  it("is outside the downloads folder, a remote path mapping and the allow-list, and leaves the files and the library alone", async () => {
    const m = await movie();
    const file = write(outside, `${MATRIX}/${MATRIX}.mkv`);
    expect(await refused("radarr", { path: path.dirname(file), importMode: "Move" })).toMatch(/not inside the downloads folder/);
    expect(await refused("radarr", { path: file })).toMatch(/not inside the downloads folder/);
    expect(fs.existsSync(file)).toBe(true);
    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any;
    expect(Number(row.has_file)).toBe(0);
    expect(fs.readdirSync(m.dir)).toEqual([]);
  });

  it("is inside a library root folder, or is one", async () => {
    const m = await movie();
    write(m.dir, "The Matrix (1999)/The Matrix (1999).mkv");
    expect(await refused("radarr", { path: m.dir })).toMatch(/library root folder/);
    expect(await refused("radarr", { path: path.join(m.dir, "The Matrix (1999)") })).toMatch(/library root folder/);
    expect(await refused("radarr", { path: path.join(m.dir, "The Matrix (1999)", "The Matrix (1999).mkv") })).toMatch(/library root folder/);
  });

  it("goes outside through a symbolic link, whose real path is what counts", async () => {
    await movie();
    const file = write(outside, `${MATRIX}/${MATRIX}.mkv`);
    fs.symlinkSync(outside, path.join(dl, "escape"), "dir");
    fs.symlinkSync(file, path.join(dl, "escaped-file.mkv"));
    expect(await refused("radarr", { path: path.join(dl, "escape") })).toMatch(/not inside the downloads folder/);
    expect(await refused("radarr", { path: path.join(dl, "escape", MATRIX) })).toMatch(/not inside the downloads folder/);
    expect(await refused("radarr", { path: path.join(dl, "escaped-file.mkv") })).toMatch(/not inside the downloads folder/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("names an import mode that does not exist", async () => {
    await movie();
    write(dl, `${MATRIX}/${MATRIX}.mkv`);
    await refused("radarr", { path: path.join(dl, MATRIX), importMode: "Teleport" }, "ImportMode");
    expect(fs.existsSync(path.join(dl, MATRIX, `${MATRIX}.mkv`))).toBe(true);
  });
});

describe("the scanPathAllowList setting", () => {
  it("is empty by default, and opens only the absolute folders it lists", async () => {
    const m = await movie();
    const file = write(outside, `${MATRIX}/${MATRIX}.mkv`);
    expect((await scan("radarr", { path: path.dirname(file), importMode: "Copy" })).res.status).toBe(400);

    // A relative entry, an empty one and a folder that does not exist open nothing; the real one does.
    setSetting("scanPathAllowList", `relative/folder, ,${path.join(outside, "missing")} ; ${outside}`);
    const { res, record } = await scan("radarr", { path: path.dirname(file), importMode: "Copy" });
    expect(res.status).toBe(201);
    expect(record).toMatchObject({ status: "completed", result: "successful" });
    expect(record.message).toMatch(/^Imported 1 of 1 media file/);
    expect(fs.existsSync(file)).toBe(true);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);

    setSetting("scanPathAllowList", "");
    expect((await scan("radarr", { path: path.dirname(file) })).res.status).toBe(400);
  });
});

describe("importing a film from a folder", () => {
  it("copies it with importMode Copy: the title has its file by the naming rules, the download stays, the command says what it did", async () => {
    const m = await movie();
    const file = write(dl, `${MATRIX}/${MATRIX}.mkv`, "THE FILM");
    write(dl, `${MATRIX}/${MATRIX}.nfo`, "info");
    const { res, record } = await scan("radarr", { path: path.join(dl, MATRIX), importMode: "Copy" });
    expect(res.status).toBe(201);
    expect(record).toMatchObject({ name: "DownloadedMoviesScan", status: "completed", result: "successful" });
    expect(record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}"`);

    const row = (await db.prepare("SELECT has_file, path, quality FROM media_items WHERE id = ?").get(m.id)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(row.path).toContain(m.dir);
    expect(path.basename(row.path)).toContain("The Matrix (1999)");
    expect(row.quality).toBe("Bluray-1080p");
    expect(fs.readFileSync(row.path, "utf8")).toBe("THE FILM");
    expect(fs.existsSync(file)).toBe(true);
    const events = ((await db.prepare("SELECT event_type FROM history WHERE media_item_id = ?").all(m.id)) as any[]).map((h) => h.event_type);
    expect(events).toContain("imported");
    // The movie resource shows it.
    const movieResource = (await get(`/radarr/api/v3/movie/${m.id}`)).body;
    expect(movieResource).toMatchObject({ hasFile: true });
  });

  it("moves the file when the command says Move, and follows a setting that already leaves the source alone", async () => {
    const m = await movie();
    const moved = write(dl, `${MATRIX}/${MATRIX}.mkv`, "MOVED");
    const first = await scan("radarr", { path: path.dirname(moved), importMode: "Move" });
    expect(first.record.status).toBe("completed");
    expect(first.record.message).not.toMatch(/hardlinked/);
    expect(fs.existsSync(moved)).toBe(false);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);

    // Back to a film with no file: the first copy leaves the library.
    fs.rmSync(((await db.prepare("SELECT path FROM media_items WHERE id = ?").get(m.id)) as any).path);
    await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(m.id);
    setSetting("importStrategy", "copy");
    const kept = write(dl, `${MATRIX}/${MATRIX}.mkv`, "KEPT");
    const { record } = await scan("radarr", { path: path.dirname(kept), importMode: "Auto" });
    expect(record.message).toMatch(/^Imported 1 of 1/);
    expect(record.message).not.toMatch(/hardlinked/);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("imports a single file when the path is the file", async () => {
    const m = await movie();
    const file = write(dl, `${MATRIX}.mkv`, "ONE FILE");
    const { record } = await scan("radarr", { path: file, importMode: "Copy" });
    expect(record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}.mkv"`);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);
  });

  it("names the folder's title when the file's own name is a hash", async () => {
    const m = await movie();
    write(dl, `${MATRIX}/a8f7d6c1e2b3.mkv`, "HASHED");
    const { record } = await scan("radarr", { path: path.join(dl, MATRIX), importMode: "Copy" });
    expect(record.message).toMatch(/^Imported 1 of 1/);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);
  });
});

describe("a path with nothing importable", () => {
  it("has no media files, or only files that match nothing, and nothing moves", async () => {
    const m = await movie();
    write(dl, "Empty.Folder/readme.nfo", "text");
    write(dl, "Empty.Folder/cover.jpg", "image");
    const none = await scan("radarr", { path: path.join(dl, "Empty.Folder"), importMode: "Move" });
    expect(none.record).toMatchObject({ status: "completed", result: "successful", message: 'Nothing to import: no media files in "Empty.Folder"' });

    const stranger = write(dl, "Some.Other.Film.2012.1080p.WEB-DL-GRP/Some.Other.Film.2012.1080p.WEB-DL-GRP.mkv", "STRANGER");
    const episode = write(dl, "Some.Other.Film.2012.1080p.WEB-DL-GRP/Show.S01E01.1080p.WEB-DL-GRP.mkv", "EPISODE");
    const { record } = await scan("radarr", { path: path.join(dl, "Some.Other.Film.2012.1080p.WEB-DL-GRP"), importMode: "Move" });
    expect(record).toMatchObject({ status: "completed", result: "successful" });
    expect(record.message).toBe('Imported 0 of 2 media files in "Some.Other.Film.2012.1080p.WEB-DL-GRP"; 2 matched nothing in the library');
    expect(fs.readFileSync(stranger, "utf8")).toBe("STRANGER");
    expect(fs.readFileSync(episode, "utf8")).toBe("EPISODE");
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(0);
    expect(fs.readdirSync(m.dir)).toEqual([]);
  });

  it("leaves a film whose year is not the library's, and a file the profile does not allow", async () => {
    const m = await movie();
    const remake = write(dl, "The.Matrix.2003.1080p.BluRay.x264-GRP/The.Matrix.2003.1080p.BluRay.x264-GRP.mkv", "REMAKE");
    expect((await scan("radarr", { path: path.dirname(remake), importMode: "Move" })).record.message).toMatch(/^Imported 0 of 1/);
    expect(fs.existsSync(remake)).toBe(true);

    const profile = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Only 720', ?, 'WEBDL-720p')").run(JSON.stringify(["WEBDL-720p"]))).lastInsertRowid);
    await db.prepare("UPDATE media_items SET quality_profile_id = ? WHERE id = ?").run(profile, m.id);
    const wrongQuality = write(dl, `${MATRIX}-2/${MATRIX}.mkv`, "BLURAY");
    const { record } = await scan("radarr", { path: path.dirname(wrongQuality), importMode: "Move" });
    expect(record.message).toMatch(/^Imported 0 of 1 .*1 skipped/);
    expect(fs.existsSync(wrongQuality)).toBe(true);
  });

  it("never replaces the library's file with one that is not a better quality", async () => {
    const m = await movie();
    const libFile = write(m.dir, "The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv", "LIBRARY COPY");
    await db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = 'Bluray-1080p' WHERE id = ?").run(libFile, m.id);
    const same = write(dl, `${MATRIX}/${MATRIX}.mkv`, "SAME QUALITY");
    const worse = write(dl, "The.Matrix.1999.720p.WEB-DL-GRP/The.Matrix.1999.720p.WEB-DL-GRP.mkv", "WORSE");
    for (const folder of [path.dirname(same), path.dirname(worse)]) {
      const { record } = await scan("radarr", { path: folder, importMode: "Move" });
      expect(record.message).toMatch(/^Imported 0 of 1 .*1 skipped/);
    }
    expect(fs.readFileSync(libFile, "utf8")).toBe("LIBRARY COPY");
    expect(fs.readFileSync(same, "utf8")).toBe("SAME QUALITY");
    expect(fs.readFileSync(worse, "utf8")).toBe("WORSE");
  });

  it("replaces it with a better quality, as an upgrade", async () => {
    const m = await movie();
    const libFile = write(m.dir, "The Matrix (1999)/The Matrix (1999) WEBDL-720p.mkv", "OLD");
    await db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = 'WEBDL-720p' WHERE id = ?").run(libFile, m.id);
    write(dl, `${MATRIX}/${MATRIX}.mkv`, "BETTER");
    const { record } = await scan("radarr", { path: path.join(dl, MATRIX), importMode: "Move" });
    expect(record.message).toMatch(/^Imported 1 of 1/);
    const row = (await db.prepare("SELECT path, quality FROM media_items WHERE id = ?").get(m.id)) as any;
    expect(row.quality).toBe("Bluray-1080p");
    expect(fs.readFileSync(row.path, "utf8")).toBe("BETTER");
  });

  it("does not follow a link inside the folder out of it", async () => {
    const m = await movie();
    const target = write(outside, `${MATRIX}.mkv`, "OUTSIDE FILE");
    fs.mkdirSync(path.join(dl, "linked"), { recursive: true });
    fs.symlinkSync(target, path.join(dl, "linked", `${MATRIX}.mkv`));
    fs.symlinkSync(outside, path.join(dl, "linked", "dir"), "dir");
    const { record } = await scan("radarr", { path: path.join(dl, "linked"), importMode: "Move" });
    expect(record.message).toBe('Nothing to import: no media files in "linked"');
    expect(fs.readFileSync(target, "utf8")).toBe("OUTSIDE FILE");
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(0);
  });

  it("does not walk into a library root folder that sits inside the folder scanned", async () => {
    // A downloads folder that also holds the library: the scan of the whole folder leaves the library's files alone.
    const root = path.join(dl, "library-inside");
    fs.mkdirSync(root, { recursive: true });
    await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'inside')").run(root);
    const inLibrary = write(root, `${MATRIX}/${MATRIX}.mkv`, "IN LIBRARY");
    const download = write(dl, `fresh/${MATRIX}.mkv`, "FRESH");
    await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, root_folder_id) VALUES ('movie', 'The Matrix', 'the matrix', 1999, 1, 0, 'missing', (SELECT id FROM root_folders WHERE name = 'inside'))").run();
    const { record } = await scan("radarr", { path: dl, importMode: "Copy" });
    expect(record.message).toMatch(/^Imported 1 of 1/);
    expect(fs.readFileSync(inLibrary, "utf8")).toBe("IN LIBRARY");
    expect(fs.existsSync(download)).toBe(true);
  });
});

describe("a path seen through a download client's remote path mapping", () => {
  it("is taken as the local folder it maps to", async () => {
    const m = await movie();
    write(dl, `${MATRIX}/${MATRIX}.mkv`, "REMOTE");
    const client = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Remote', 'qbittorrent', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/downloads', ?)").run(client, dl);
    const { res, record } = await scan("radarr", { path: `/remote/downloads/${MATRIX}`, importMode: "Copy" });
    expect(res.status).toBe(201);
    expect(record.message).toMatch(/^Imported 1 of 1/);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);
    // The local side of a mapping is a place a scan may look in, and a remote path no mapping covers is not a path at all.
    expect((await scan("radarr", { path: "/not/mapped/anywhere" })).res.status).toBe(400);
  });
});

describe("a download the queue is tracking", () => {
  it("is left to the queue: nothing moves, and the queue check runs", async () => {
    const { registerJob } = await import("../src/services/jobRegistry.js");
    const poll = vi.fn(async () => undefined);
    registerJob({ key: "queuePoll", name: "Queue Poll", scheduleType: "interval", defaultSchedule: "60", run: poll });
    const m = await movie();
    const file = write(dl, `${MATRIX}/${MATRIX}.mkv`, "TRACKED");
    await db.prepare("INSERT INTO queue (media_item_id, title, status, download_path, download_id) VALUES (?, ?, 'completed', ?, 'abc123')").run(m.id, MATRIX, path.join(dl, MATRIX));
    const { record } = await scan("radarr", { path: path.join(dl, MATRIX), importMode: "Move" });
    expect(record).toMatchObject({ status: "completed" });
    expect(record.message).toMatch(/^Imported 0 of 1 .*1 left to the queue/);
    expect(fs.readFileSync(file, "utf8")).toBe("TRACKED");
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(0);
  });

  it("is also what a download id the queue knows means: the files are not touched", async () => {
    const m = await movie();
    const file = write(dl, `${MATRIX}/${MATRIX}.mkv`, "BY ID");
    await db.prepare("INSERT INTO queue (media_item_id, title, status, download_id) VALUES (?, ?, 'downloading', 'hash-1')").run(m.id, MATRIX);
    const { record } = await scan("radarr", { path: path.join(dl, MATRIX), importMode: "Move", downloadClientId: "hash-1" });
    expect(record.message).toMatch(/1 left to the queue/);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("a command without a path", () => {
  it("still runs the queue check, and an empty path means none", async () => {
    const { registerJob } = await import("../src/services/jobRegistry.js");
    const poll = vi.fn(async () => undefined);
    registerJob({ key: "queuePoll", name: "Queue Poll", scheduleType: "interval", defaultSchedule: "60", run: poll });
    for (const body of [{}, { path: "" }, { downloadId: "x", inputBase64: "AAAA" }]) {
      poll.mockClear();
      const { record } = await scan("radarr", body);
      expect(record.status).toBe("completed");
      await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    }
  });
});

describe("episodes (Sonarr)", () => {
  async function show() {
    const root = await rootFolder("series", "series");
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('series', 'Scan Show', 'scan show', 2020, ?, 1, 0, 'missing')").run(root.id)).lastInsertRowid
    );
    const episodes: Record<number, number> = {};
    for (const n of [1, 2, 3]) {
      episodes[n] = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, 1, ?, ?, 1, 0, '2020-01-01')").run(id, n, `Episode ${n}`)).lastInsertRowid);
    }
    return { id, episodes, dir: root.dir };
  }

  it("imports each episode file of a season folder and leaves the file that names no episode of the show", async () => {
    const s = await show();
    write(dl, "Scan.Show.S01.1080p.WEB-DL-GRP/Scan.Show.S01E01.1080p.WEB-DL-GRP.mkv", "E1");
    write(dl, "Scan.Show.S01.1080p.WEB-DL-GRP/Scan.Show.S01E02.1080p.WEB-DL-GRP.mkv", "E2");
    const stray = write(dl, "Scan.Show.S01.1080p.WEB-DL-GRP/Scan.Show.S01E09.1080p.WEB-DL-GRP.mkv", "E9");
    const { res, record } = await scan("sonarr", { path: path.join(dl, "Scan.Show.S01.1080p.WEB-DL-GRP"), importMode: "Copy" });
    expect(res.status).toBe(201);
    expect(record.message).toBe('Imported 2 of 3 media files in "Scan.Show.S01.1080p.WEB-DL-GRP"; 1 matched nothing in the library');
    const have = (await db.prepare("SELECT episode_number, has_file FROM episodes WHERE media_item_id = ? ORDER BY episode_number").all(s.id)) as any[];
    expect(have.map((e) => Number(e.has_file))).toEqual([1, 1, 0]);
    expect(fs.existsSync(stray)).toBe(true);
    const files = (await get(`/sonarr/api/v3/episodefile?seriesId=${s.id}`)).body as any[];
    expect(files).toHaveLength(2);
  });

  it("takes the show from the folder when the episode file only carries its number", async () => {
    const s = await show();
    write(dl, "Scan.Show.S01E03.1080p.WEB-DL-GRP/S01E03.mkv", "E3");
    const { record } = await scan("sonarr", { path: path.join(dl, "Scan.Show.S01E03.1080p.WEB-DL-GRP"), importMode: "Copy" });
    expect(record.message).toMatch(/^Imported 1 of 1/);
    expect(Number(((await db.prepare("SELECT has_file FROM episodes WHERE id = ?").get(s.episodes[3])) as any).has_file)).toBe(1);
  });

  it("does not take a film for an episode, and a Radarr scan does not take an episode", async () => {
    await show();
    await movie();
    const film = write(dl, `${MATRIX}/${MATRIX}.mkv`, "FILM");
    expect((await scan("sonarr", { path: path.dirname(film), importMode: "Move" })).record.message).toMatch(/^Imported 0 of 1/);
    const ep = write(dl, "Scan.Show.S01E01.1080p.WEB-DL-GRP.mkv", "EP");
    expect((await scan("radarr", { path: ep, importMode: "Move" })).record.message).toMatch(/^Imported 0 of 1/);
    expect(fs.existsSync(film)).toBe(true);
    expect(fs.existsSync(ep)).toBe(true);
  });
});

describe("albums (Lidarr) and books (Readarr)", () => {
  it("imports the tracks of an album folder into the album, and not into one that already has its files", async () => {
    const root = await rootFolder("artist", "music");
    const artist = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Scan Band', 'scan band', ?, 1, 0, 'missing')").run(root.id)).lastInsertRowid);
    const album = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'First Record', '2001-01-01', 1, 0)").run(artist)).lastInsertRowid);
    const name = "Scan Band - First Record (2001) [FLAC]";
    write(dl, `${name}/01 - One.flac`, "T1");
    write(dl, `${name}/02 - Two.flac`, "T2");
    const stranger = write(dl, "Nobody - Other Record (2005) [FLAC]/01 - X.flac", "X");
    const { res, record } = await scan("lidarr", { path: dl, importMode: "Copy" });
    expect(res.status).toBe(201);
    expect(record.status).toBe("completed");
    expect(record.message).toMatch(/^Imported 2 of 3 media files/);
    expect(record.message).toMatch(/1 matched nothing/);
    const row = (await db.prepare("SELECT has_file, file_path FROM sub_items WHERE id = ?").get(album)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(fs.readdirSync(row.file_path).sort()).toHaveLength(2);
    expect(fs.existsSync(stranger)).toBe(true);

    // The album is there now: the same folder scanned again changes nothing.
    const again = await scan("lidarr", { path: path.join(dl, name), importMode: "Copy" });
    expect(again.record.message).toMatch(/^Imported 0 of 2 .*2 skipped/);
  });

  it("imports a book file named by its author and title", async () => {
    const root = await rootFolder("author", "books");
    const author = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author', 'Scan Writer', 'scan writer', ?, 1, 0, 'missing')").run(root.id)).lastInsertRowid);
    const book = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'Long Novel', '2010-01-01', 1, 0)").run(author)).lastInsertRowid);
    write(dl, "Scan Writer - Long Novel (2010).epub", "BOOK");
    const other = write(dl, "Scan Writer - Unknown Story.epub", "OTHER");
    const { record } = await scan("readarr", { path: dl, importMode: "Copy" });
    expect(record.message).toMatch(/^Imported 1 of 2 media files/);
    expect(Number(((await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(book)) as any).has_file)).toBe(1);
    expect(fs.existsSync(other)).toBe(true);
  });
});

describe("a file no queue row tracks, where a torrent may still be seeding (M1)", () => {
  const library = async (id: number) => (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as { has_file: number; path: string | null };

  it.each([
    ["move", {}],
    ["move", { importMode: "Auto" }],
    ["auto", {}],
    ["auto", { importMode: "auto" }],
  ])("is hardlinked, not moved, in the downloads folder (import strategy %s, command %j): the download stays, the message says so", async (setting, body) => {
    setSetting("importStrategy", setting);
    const m = await movie();
    const file = write(dl, `${MATRIX}/${MATRIX}.mkv`, "STILL SEEDING");
    const { record } = await scan("radarr", { path: path.dirname(file), ...body });
    expect(record).toMatchObject({ status: "completed", result: "successful" });
    expect(record.message).toMatch(/^Imported 1 of 1 media file/);
    expect(record.message).toMatch(/hardlinked 1 file/);
    // The torrent client still has its data...
    expect(fs.readFileSync(file, "utf8")).toBe("STILL SEEDING");
    // ...and the library has the film.
    const row = await library(m.id);
    expect(Number(row.has_file)).toBe(1);
    expect(fs.readFileSync(row.path!, "utf8")).toBe("STILL SEEDING");
  });

  it("is moved when the command says Move: that is the caller's call", async () => {
    const m = await movie();
    const file = write(dl, `${MATRIX}/${MATRIX}.mkv`, "MOVE ME");
    const { record } = await scan("radarr", { path: path.dirname(file), importMode: "Move" });
    expect(record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}"`);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync((await library(m.id)).path!, "utf8")).toBe("MOVE ME");
  });

  it("keeps the setting in a folder that is no download folder: the allow-list, and a usenet client's mapped folder", async () => {
    const m = await movie();
    setSetting("scanPathAllowList", outside);
    const listed = write(outside, `${MATRIX}/${MATRIX}.mkv`, "LISTED");
    const first = await scan("radarr", { path: path.dirname(listed) });
    expect(first.record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}"`);
    expect(fs.existsSync(listed)).toBe(false);

    // A usenet client's own folder, seen through its remote path mapping, is moved from like the setting says.
    fs.rmSync((await library(m.id)).path!);
    await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(m.id);
    setSetting("scanPathAllowList", "");
    const usenet = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Usenet', 'sabnzbd', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/usenet', ?)").run(usenet, outside);
    const nzb = write(outside, `${MATRIX}/${MATRIX}.mkv`, "NZB");
    const second = await scan("radarr", { path: `/remote/usenet/${MATRIX}` });
    expect(second.record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}"`);
    expect(fs.existsSync(nzb)).toBe(false);
  });

  it("is hardlinked in a torrent client's mapped folder, wherever that is, and a usenet client's folder inside the downloads folder is still moved from", async () => {
    const m = await movie();
    const torrent = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Seeder', 'transmission', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/seeding', ?)").run(torrent, outside);
    const seeding = write(outside, `${MATRIX}/${MATRIX}.mkv`, "SEEDING ELSEWHERE");
    const first = await scan("radarr", { path: `/remote/seeding/${MATRIX}` });
    expect(first.record.message).toMatch(/hardlinked 1 file/);
    expect(fs.readFileSync(seeding, "utf8")).toBe("SEEDING ELSEWHERE");
    expect(Number((await library(m.id)).has_file)).toBe(1);

    // The deepest folder decides: a usenet client's folder inside the downloads folder keeps the setting.
    fs.rmSync((await library(m.id)).path!);
    await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(m.id);
    const usenet = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Usenet', 'nzbget', 1)").run()).lastInsertRowid);
    const nzbDir = path.join(dl, "usenet-complete");
    fs.mkdirSync(nzbDir, { recursive: true });
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/nzb', ?)").run(usenet, nzbDir);
    const nzb = write(nzbDir, `${MATRIX}/${MATRIX}.mkv`, "NZB IN DOWNLOADS");
    const second = await scan("radarr", { path: `/remote/nzb/${MATRIX}` });
    expect(second.record.message).toBe(`Imported 1 of 1 media file in "${MATRIX}"`);
    expect(fs.existsSync(nzb)).toBe(false);
  });
});

describe("the local folder of a remote path mapping (M3)", () => {
  it("is a place to look only for a path that goes through that mapping", async () => {
    const m = await movie();
    const client = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Remote', 'qbittorrent', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/dl', ?)").run(client, outside);
    const file = write(outside, `${MATRIX}/${MATRIX}.mkv`, "BEHIND THE MAPPING");

    // The same folder named by its local path is not a download: no mapping was used for it.
    const before = await commandCount("radarr");
    const direct = await scan("radarr", { path: path.dirname(file), importMode: "Copy" });
    expect(direct.res.status).toBe(400);
    expect(direct.res.body[0].errorMessage).toMatch(/not inside the downloads folder/);
    expect(await commandCount("radarr")).toBe(before);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(0);

    // Named by the client's path, the mapping is what brings it here, and it is a place to look.
    const mapped = await scan("radarr", { path: `/remote/dl/${MATRIX}`, importMode: "Copy" });
    expect(mapped.record.message).toMatch(/^Imported 1 of 1/);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(m.id)) as any).has_file)).toBe(1);
  });

  it("is not a place for a path outside the mapping that happens to be next to it", async () => {
    await movie();
    const client = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Remote', 'qbittorrent', 1)").run()).lastInsertRowid);
    const mappedFolder = path.join(outside, "mapped");
    const sibling = path.join(outside, "sibling");
    fs.mkdirSync(mappedFolder, { recursive: true });
    write(sibling, `${MATRIX}/${MATRIX}.mkv`, "NEXT DOOR");
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/dl', ?)").run(client, mappedFolder);
    const { res } = await scan("radarr", { path: path.join(sibling, MATRIX), importMode: "Copy" });
    expect(res.status).toBe(400);
  });
});

describe("a folder named like a parent (L3)", () => {
  it("is still inside the library root folder that holds it", async () => {
    const m = await movie();
    // The library's folder sits in a place the allow-list opens; a folder of it whose name begins with two dots is part of it.
    setSetting("scanPathAllowList", libraryDir);
    const odd = write(m.dir, `..odd/${MATRIX}.mkv`, "IN THE LIBRARY");
    const { res } = await scan("radarr", { path: path.dirname(odd), importMode: "Copy" });
    expect(res.status).toBe(400);
    expect(res.body[0].errorMessage).toMatch(/library root folder/);
    expect((await scan("radarr", { path: odd, importMode: "Copy" })).res.status).toBe(400);
  });
});

describe("what limits a scan (L4)", () => {
  it("says so when folders deeper than 6 levels were not looked at, and does not when they hold no media", async () => {
    await movie();
    write(dl, `${MATRIX}/${MATRIX}.mkv`, "TOP");
    write(dl, "a/b/c/d/e/f/g/Deep.Film.2001.1080p.WEB-DL-GRP.mkv", "DEEP");
    const { record } = await scan("radarr", { path: dl, importMode: "Copy" });
    expect(record.message).toBe('Imported 1 of 1 media file in "scan-dl" (folders deeper than 6 levels were not looked at)');
    expect(fs.existsSync(path.join(dl, "a/b/c/d/e/f/g/Deep.Film.2001.1080p.WEB-DL-GRP.mkv"))).toBe(true);

    fs.rmSync(path.join(dl, "a"), { recursive: true, force: true });
    fs.rmSync(path.join(dl, MATRIX), { recursive: true, force: true });
    write(dl, "a/b/c/d/e/f/g/readme.nfo", "text");
    const quiet = await scan("radarr", { path: dl, importMode: "Copy" });
    expect(quiet.record.message).toBe('Nothing to import: no media files in "scan-dl"');
  });

  it("does not count a file the library already has toward the limit: a rerun goes on from where the last one stopped", async () => {
    const { scanLimits } = await import("../src/services/pathScan.js");
    const kept = { ...scanLimits };
    const names = ["Aaa", "Bbb", "Ccc", "Ddd", "Eee", "Fff", "Ggg", "Hhh"].map((n) => ({ title: `${n} Film`, release: `${n}.Film.2001.1080p.BluRay.x264-GRP` }));
    const ids: number[] = [];
    const root = await rootFolder("movie", "movies");
    for (const [i, n] of names.entries()) {
      // The first four are in the library already (a hardlink or copy scan left them in the downloads folder too).
      const have = i < 4;
      const libFile = have ? write(root.dir, `have/${n.title}.mkv`, "HAVE") : null;
      ids.push(
        Number(
          (
            await db
              .prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, quality, path, status) VALUES ('movie', ?, ?, 2001, ?, 1, ?, ?, ?, 'missing')")
              .run(n.title, n.title.toLowerCase(), root.id, have ? 1 : 0, have ? "Bluray-1080p" : null, libFile)
          ).lastInsertRowid
        )
      );
      write(dl, `${n.release}/${n.release}.mkv`, n.title);
    }
    try {
      scanLimits.maxFiles = 2;
      scanLimits.chunkSize = 2;
      const first = await scan("radarr", { path: dl, importMode: "Copy" });
      // The four the library has were passed over without counting; two more were imported, which is the limit.
      expect(first.record.message).toBe('Imported 2 of 6 media files in "scan-dl"; 4 skipped (only the first 6 files were looked at)');
      const have = async () => ((await db.prepare("SELECT has_file FROM media_items WHERE id IN (" + ids.map(() => "?").join(",") + ") ORDER BY id").all(...ids)) as any[]).map((r) => Number(r.has_file));
      expect(await have()).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);

      const second = await scan("radarr", { path: dl, importMode: "Copy" });
      expect(second.record.message).toBe('Imported 2 of 8 media files in "scan-dl"; 6 skipped');
      expect(await have()).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    } finally {
      Object.assign(scanLimits, kept);
    }
  });
});

describe("the documents", () => {
  it("still lists the command route, and the scan command is known to each app", async () => {
    for (const mount of Object.keys(MOUNTS) as Mount[]) {
      const doc = (await get(`/${mount}/api/${MOUNTS[mount]}/openapi.json`)).body;
      expect(doc.paths[`/api/${MOUNTS[mount]}/command`].post).toBeDefined();
      const res = await post(`/${mount}/api/${MOUNTS[mount]}/command`, { name: COMMANDS[mount], path: path.join(dl, "missing") });
      expect(res.status).toBe(400);
    }
  });
});
