import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let baseDir: string;

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-root-move-"));
});

async function createRootFolder(name: string, mediaType: string): Promise<{ id: number; dir: string }> {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
  return { id, dir };
}

async function insertItem(type: string, title: string, rootFolderId: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          "INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, monitored, has_file, status) VALUES (?, ?, ?, 2020, ?, ?, 1, ?, 'unknown')"
        )
        .run(type, title, title.toLowerCase(), filePath, rootFolderId, filePath ? 1 : 0)
    ).lastInsertRowid
  );
}

async function itemRow(id: number): Promise<{ root_folder_id: number; path: string | null }> {
  return (await db.prepare("SELECT root_folder_id, path FROM media_items WHERE id = ?").get(id)) as { root_folder_id: number; path: string | null };
}

/** The move runs in the background after the response; its audit entry is written last. */
async function waitForMoveAudit(sourceDir: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const rows = (await db.prepare("SELECT detail FROM audit_log WHERE event_type = 'root_folder_moved'").all()) as { detail: string }[];
    const hit = rows.find((r) => r.detail.startsWith(`${sourceDir} → `));
    if (hit) return hit.detail;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("move-to background task never finished");
}

describe("POST /api/root-folders/:id/move-to/:destinationId", () => {
  it("moves a movie's file and repoints the item", async () => {
    const source = await createRootFolder("movies-a", "movie");
    const destination = await createRootFolder("movies-b", "movie");
    const oldFile = path.join(source.dir, "Moved Movie (2020)", "Moved Movie (2020).mkv");
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, "video");
    const id = await insertItem("movie", "Moved Movie", source.id, oldFile);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ started: true, itemCount: 1, jobId: "move:root-" + source.id });

    const detail = await waitForMoveAudit(source.dir);
    expect(detail).toContain("(1 item(s))");
    const row = await itemRow(id);
    const newFile = path.join(destination.dir, "Moved Movie (2020)", "Moved Movie (2020).mkv");
    expect(Number(row.root_folder_id)).toBe(destination.id);
    expect(row.path).toBe(newFile);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  // renameOneMediaItem reports a failed file move in its result instead of throwing; the item
  // used to be repointed at the destination (and counted as moved) while its file stayed behind.
  it("keeps an item whose file couldn't be moved pointed at the source folder", async () => {
    const source = await createRootFolder("movies-c", "movie");
    const destination = await createRootFolder("movies-d", "movie");
    const missingFile = path.join(source.dir, "Ghost Movie (2020)", "Ghost Movie (2020).mkv");
    const brokenId = await insertItem("movie", "Ghost Movie", source.id, missingFile);
    const noFileId = await insertItem("movie", "Wanted Movie", source.id, null);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.itemCount).toBe(2);

    const detail = await waitForMoveAudit(source.dir);
    expect(detail).toContain("(1 item(s), 1 failed)");
    const broken = await itemRow(brokenId);
    expect(Number(broken.root_folder_id)).toBe(source.id);
    expect(broken.path).toBe(missingFile);
    // Nothing on disk to move, so repointing it is the whole move.
    expect(Number((await itemRow(noFileId)).root_folder_id)).toBe(destination.id);
  });

  it("moves a Music root folder by moving each artist's folder with its albums and tracks", async () => {
    const source = await createRootFolder("music-a", "artist");
    const destination = await createRootFolder("music-b", "artist");
    const albumDir = path.join(source.dir, "Some Artist", "First Album (2001)");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "01 - Song.flac"), "audio");
    fs.writeFileSync(path.join(source.dir, "Some Artist", "folder.jpg"), "art");
    const id = await insertItem("artist", "Some Artist", source.id, null);
    const albumId = Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'First Album', 1, ?, 1)").run(id, albumDir)).lastInsertRowid
    );
    const trackId = Number(
      (await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'Song', 1, ?)").run(albumId, path.join(albumDir, "01 - Song.flac"))).lastInsertRowid
    );

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    await waitForMoveAudit(source.dir);

    const newAlbum = path.join(destination.dir, "Some Artist", "First Album (2001)");
    expect(Number((await itemRow(id)).root_folder_id)).toBe(destination.id);
    expect(fs.existsSync(path.join(destination.dir, "Some Artist", "folder.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(source.dir, "Some Artist"))).toBe(false);
    expect(((await db.prepare("SELECT file_path FROM sub_items WHERE id = ?").get(albumId)) as any).file_path).toBe(newAlbum);
    expect(((await db.prepare("SELECT file_path FROM tracks WHERE id = ?").get(trackId)) as any).file_path).toBe(path.join(newAlbum, "01 - Song.flac"));
  });
});

describe("GET /api/root-folders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the space the server can actually use, not blocks reserved for root", async () => {
    const { id, dir } = await createRootFolder("space-report", "movie");
    const realStatfs = fs.promises.statfs;
    vi.spyOn(fs.promises, "statfs").mockImplementation((async (p: string, ...rest: unknown[]) =>
      p === dir ? ({ bfree: 30, bavail: 10, blocks: 100, bsize: 1000 } as any) : (realStatfs as any)(p, ...rest)) as any);

    const res = await request(app).get("/api/root-folders").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const folder = res.body.find((f: { id: number }) => f.id === id);
    expect(folder).toMatchObject({ freeBytes: 10_000, totalBytes: 100_000 });
    expect(folder.percentUsed).toBeCloseTo(90);
  });
});

describe("PATCH /api/root-folders/:id", () => {
  async function folderRow(id: number): Promise<{ quota_percent: number | null; min_free_space_gb: number | null }> {
    return (await db.prepare("SELECT quota_percent, min_free_space_gb FROM root_folders WHERE id = ?").get(id)) as {
      quota_percent: number | null;
      min_free_space_gb: number | null;
    };
  }

  it("stores a fractional quota or minimum free space rounded, since both columns are whole numbers", async () => {
    const { id } = await createRootFolder("patch-fraction", "movie");

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ quotaPercent: 12.5, minFreeSpaceGb: "7.4" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ quotaPercent: 13, minFreeSpaceGb: 7 });
    expect(await folderRow(id)).toEqual({ quota_percent: 13, min_free_space_gb: 7 });
  });

  it("rejects a non-numeric, negative, over-100% or too-large value with a 400, leaving the folder unchanged", async () => {
    const { id } = await createRootFolder("patch-invalid", "movie");
    await db.prepare("UPDATE root_folders SET quota_percent = 80, min_free_space_gb = 50 WHERE id = ?").run(id);

    for (const body of [
      { minFreeSpaceGb: "abc" },
      { quotaPercent: "abc" },
      { quotaPercent: -1 },
      { quotaPercent: 150 },
      { minFreeSpaceGb: "" },
      { quotaPercent: true },
      // Past what the integer column holds (Postgres would reject it with "integer out of range").
      { minFreeSpaceGb: 1e12 },
      { minFreeSpaceGb: 2_147_483_647.6 },
    ]) {
      const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ name: "Renamed", ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatch(Object.keys(body)[0]);
    }
    expect(await folderRow(id)).toEqual({ quota_percent: 80, min_free_space_gb: 50 });
    expect(((await db.prepare("SELECT name FROM root_folders WHERE id = ?").get(id)) as { name: string | null }).name).toBeNull();
  });

  it("accepts a minimum free space up to the largest the column holds", async () => {
    const { id } = await createRootFolder("patch-max", "movie");

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ minFreeSpaceGb: 2_147_483_647 });

    expect(res.status).toBe(200);
    expect(await folderRow(id)).toEqual({ quota_percent: null, min_free_space_gb: 2_147_483_647 });
  });

  it("clears a quota or minimum free space set to null", async () => {
    const { id } = await createRootFolder("patch-clear", "movie");
    await db.prepare("UPDATE root_folders SET quota_percent = 80, min_free_space_gb = 50 WHERE id = ?").run(id);

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ quotaPercent: null, minFreeSpaceGb: null });

    expect(res.status).toBe(200);
    expect(await folderRow(id)).toEqual({ quota_percent: null, min_free_space_gb: null });
  });
});

/**
 * Makes `dir` behave like a read-only mount for the write probe a root folder is checked with (it fails with EROFS).
 * Everything else on the file system is untouched. The tests run as root, where a chmod would not stop a write.
 */
function mountReadOnly(dir: string) {
  const realWriteFile = fs.promises.writeFile;
  return vi.spyOn(fs.promises, "writeFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    if (path.dirname(String(p)) === dir && path.basename(String(p)).startsWith(".aonarr-write-test-")) {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    }
    return (realWriteFile as any)(p, ...rest);
  }) as any);
}

describe("read-only root folders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function readOnlyColumn(id: number): Promise<number> {
    return Number(((await db.prepare("SELECT read_only FROM root_folders WHERE id = ?").get(id)) as { read_only: number }).read_only);
  }

  function newDir(name: string): string {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("a root folder added without saying is writable, in the column and in the answer", async () => {
    const dir = newDir("ro-default");

    const res = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie" });

    expect(res.status).toBe(201);
    expect(res.body.readOnly).toBe(false);
    expect(await readOnlyColumn(res.body.id)).toBe(0);
  });

  it("a root folder added as read-only is stored as such and listed as such", async () => {
    const dir = newDir("ro-added");

    const res = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie", readOnly: true });

    expect(res.status).toBe(201);
    expect(res.body.readOnly).toBe(true);
    expect(await readOnlyColumn(res.body.id)).toBe(1);
    const list = await request(app).get("/api/root-folders").set("X-Api-Key", apiKey);
    expect(list.body.find((f: { id: number }) => f.id === res.body.id)).toMatchObject({ path: dir, readOnly: true });
  });

  it("only a folder AoNarr cannot write into needs to be added as read-only", async () => {
    const dir = newDir("ro-unwritable");
    mountReadOnly(dir);

    const refused = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/not writable/);

    const accepted = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie", readOnly: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.readOnly).toBe(true);
  });

  it("PATCH switches a library to read-only without testing the folder, and back once the folder is writable", async () => {
    const { id, dir } = await createRootFolder("ro-patch-roundtrip", "movie");

    const toReadOnly = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: true });
    expect(toReadOnly.status).toBe(200);
    expect(toReadOnly.body.readOnly).toBe(true);
    expect(await readOnlyColumn(id)).toBe(1);

    const back = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: false });
    expect(back.status).toBe(200);
    expect(back.body.readOnly).toBe(false);
    expect(await readOnlyColumn(id)).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]); // the writable test left nothing behind
  });

  it("PATCH switches a folder that cannot be written into to read-only, but refuses to switch it back", async () => {
    const { id, dir } = await createRootFolder("ro-patch-unwritable", "movie");
    mountReadOnly(dir);

    const toReadOnly = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: true });
    expect(toReadOnly.status).toBe(200);

    const back = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: false, name: "Renamed" });
    expect(back.status).toBe(400);
    expect(back.body.error).toMatch(/is not writable by AoNarr \(EROFS\)/);
    expect(await readOnlyColumn(id)).toBe(1); // unchanged, and so is everything else in that request
    expect(((await db.prepare("SELECT name FROM root_folders WHERE id = ?").get(id)) as { name: string | null }).name).toBeNull();
  });

  it("PATCH refuses to make a library writable when its folder is gone", async () => {
    const { id, dir } = await createRootFolder("ro-patch-gone", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(id);
    fs.rmSync(dir, { recursive: true, force: true });

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: false });

    expect(res.status).toBe(400);
    expect(await readOnlyColumn(id)).toBe(1);
  });

  it.each([["yes"], [1], [0], ["true"], [null]])("PATCH rejects readOnly given as %j", async (value) => {
    const { id } = await createRootFolder(`ro-patch-invalid-${String(value)}`, "movie");

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ readOnly: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/readOnly must be true or false/);
    expect(await readOnlyColumn(id)).toBe(0);
  });

  it("PATCH of another field leaves a read-only library read-only", async () => {
    const { id } = await createRootFolder("ro-patch-other", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(id);

    const res = await request(app).patch(`/api/root-folders/${id}`).set("X-Api-Key", apiKey).send({ name: "Archive", quotaPercent: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Archive", readOnly: true });
    expect(await readOnlyColumn(id)).toBe(1);
  });

  it("PATCH answers 404 for a root folder that does not exist, whichever way readOnly is set", async () => {
    for (const readOnly of [true, false]) {
      const res = await request(app).patch("/api/root-folders/987654").set("X-Api-Key", apiKey).send({ readOnly });
      expect(res.status, String(readOnly)).toBe(404);
    }
  });

  it.each([["true"], ["false"], ["yes"], [1], [0], [null]])("POST rejects readOnly given as %j, and adds nothing", async (value) => {
    const dir = newDir(`ro-post-invalid-${String(value)}`);

    const res = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie", readOnly: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/readOnly must be true or false/);
    expect(await db.prepare("SELECT id FROM root_folders WHERE path = ?").get(dir)).toBeUndefined();
  });

  it("POST judges the type of readOnly before the folder, and still accepts an explicit false", async () => {
    const missing = await request(app)
      .post("/api/root-folders")
      .set("X-Api-Key", apiKey)
      .send({ path: path.join(baseDir, "ro-post-never-created"), mediaType: "movie", readOnly: "true" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/readOnly must be true or false/);

    const dir = newDir("ro-post-explicit-false");
    const explicit = await request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send({ path: dir, mediaType: "movie", readOnly: false });
    expect(explicit.status).toBe(201);
    expect(explicit.body.readOnly).toBe(false);
    expect(await readOnlyColumn(explicit.body.id)).toBe(0);
  });
});

describe("POST /api/root-folders/:id/move-to/:destinationId and read-only libraries", () => {
  /** A movie with a file in `source`, to see whether a move touches it. */
  async function movieWithFileIn(source: { id: number; dir: string }, title: string): Promise<{ itemId: number; file: string }> {
    const file = path.join(source.dir, `${title} (2020)`, `${title} (2020).mkv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "video");
    return { itemId: await insertItem("movie", title, source.id, file), file };
  }

  async function auditedMoves(): Promise<number> {
    return Number(((await db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE event_type = 'root_folder_moved'").get()) as { c: number }).c);
  }

  async function expectNothingMoved(itemId: number, source: { id: number }, file: string, destination: { dir: string }, movesBefore: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100)); // a move would have started in the background by now
    expect(Number((await itemRow(itemId)).root_folder_id)).toBe(source.id);
    expect((await itemRow(itemId)).path).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(destination.dir)).toEqual([]);
    expect(await auditedMoves()).toBe(movesBefore);
  }

  it("refuses to move into a read-only library, and moves nothing", async () => {
    const source = await createRootFolder("ro-move-src-a", "movie");
    const destination = await createRootFolder("ro-move-dst-a", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(destination.id);
    const { itemId, file } = await movieWithFileIn(source, "Stays Put");
    const movesBefore = await auditedMoves();

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destination is a read-only library/);
    await expectNothingMoved(itemId, source, file, destination, movesBefore);
  });

  it("refuses to move out of a read-only library, and moves nothing", async () => {
    const source = await createRootFolder("ro-move-src-b", "movie");
    const destination = await createRootFolder("ro-move-dst-b", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(source.id);
    const { itemId, file } = await movieWithFileIn(source, "Cannot Leave");
    const movesBefore = await auditedMoves();

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source is a read-only library/);
    await expectNothingMoved(itemId, source, file, destination, movesBefore);
  });

  it("refuses even when the source has no items to move", async () => {
    const source = await createRootFolder("ro-move-src-c", "movie");
    const destination = await createRootFolder("ro-move-dst-c", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(destination.id);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
  });

  it("says the destination is read-only when both are", async () => {
    const source = await createRootFolder("ro-move-src-d", "movie");
    const destination = await createRootFolder("ro-move-dst-d", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id IN (?, ?)").run(source.id, destination.id);

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destination is a read-only library/);
  });

  it("still moves between two writable libraries after a library has been switched back to writable", async () => {
    const source = await createRootFolder("ro-move-src-e", "movie");
    const destination = await createRootFolder("ro-move-dst-e", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(destination.id);
    await request(app).patch(`/api/root-folders/${destination.id}`).set("X-Api-Key", apiKey).send({ readOnly: false });
    const { itemId } = await movieWithFileIn(source, "Moves Now");

    const res = await request(app).post(`/api/root-folders/${source.id}/move-to/${destination.id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ started: true, itemCount: 1 });
    await waitForMoveAudit(source.dir);
    expect(Number((await itemRow(itemId)).root_folder_id)).toBe(destination.id);
  });
});

describe("rootFolderFromRow readOnly", () => {
  it.each([
    [1, true],
    ["1", true],
    [0, false],
    ["0", false],
    [null, false],
    [undefined, false],
  ])("maps read_only %j to %s", async (value, expected) => {
    const { rootFolderFromRow } = await import("../src/db/mappers.js");

    expect(rootFolderFromRow({ id: 1, path: "/media", media_type: "movie", read_only: value }).readOnly).toBe(expected);
  });
});

describe("autoSelectRootFolderId and read-only libraries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function addRoot(name: string, mediaType: string, readOnly: boolean): Promise<{ id: number; dir: string }> {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type, read_only) VALUES (?, ?, ?)").run(dir, mediaType, readOnly ? 1 : 0)).lastInsertRowid);
    return { id, dir };
  }

  it("never picks a read-only library for an add, however much room it has", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    const roomy = await addRoot("auto-ro-roomy", "auto-ro-type", true);
    const small = await addRoot("auto-ro-small", "auto-ro-type", false);
    const big = await addRoot("auto-ro-big", "auto-ro-type", false);
    const statfs = vi.spyOn(fs.promises, "statfs").mockImplementation((async (p: string) =>
      ({ [roomy.dir]: { bavail: 99, blocks: 100, bsize: 1000 }, [small.dir]: { bavail: 10, blocks: 100, bsize: 1000 }, [big.dir]: { bavail: 50, blocks: 100, bsize: 1000 } })[p]) as any);

    expect(await autoSelectRootFolderId("auto-ro-type")).toBe(big.id);
    expect(statfs.mock.calls.map((c) => c[0])).not.toContain(roomy.dir);
  });

  it("returns the only writable library without comparing space, and null when every library of the type is read-only", async () => {
    const { autoSelectRootFolderId } = await import("../src/services/rootFolderSelect.js");
    await addRoot("auto-ro-first", "auto-ro-mixed", true);
    const writable = await addRoot("auto-ro-second", "auto-ro-mixed", false);
    const statfs = vi.spyOn(fs.promises, "statfs");
    expect(await autoSelectRootFolderId("auto-ro-mixed")).toBe(writable.id);
    expect(statfs).not.toHaveBeenCalled();

    await addRoot("auto-ro-only", "auto-ro-all-read-only", true);
    expect(await autoSelectRootFolderId("auto-ro-all-read-only")).toBeNull();
  });
});
