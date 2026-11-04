import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let tmp: string;
let titleMove: typeof import("../src/services/titleMove.js");
let lock: typeof import("../src/services/titleMoveLock.js");
let importer: typeof import("../src/services/importer.js");
let rootFolderCheck: typeof import("../src/services/rootFolderCheck.js");
let fsAsync: typeof import("../src/services/fsAsync.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  titleMove = await import("../src/services/titleMove.js");
  lock = await import("../src/services/titleMoveLock.js");
  importer = await import("../src/services/importer.js");
  rootFolderCheck = await import("../src/services/rootFolderCheck.js");
  fsAsync = await import("../src/services/fsAsync.js");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-titlemove-safety-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  lock.resetTitleMoveLocksForTests();
  fsAsync.resetFsAsyncStateForTests();
  for (const t of ["history", "queue", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  lock.resetTitleMoveLocksForTests();
  fsAsync.resetFsAsyncStateForTests();
});

async function root(name: string, mediaType: string): Promise<{ id: number; dir: string }> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
  return { id, dir };
}

function write(file: string, content = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function movie(title: string, rootId: number, file: string | null): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, path, root_folder_id, monitored, has_file, status) VALUES ('movie', ?, ?, 2020, ?, ?, 1, ?, 'downloaded')").run(title, title.toLowerCase(), file, rootId, file ? 1 : 0)).lastInsertRowid
  );
}

async function field(table: string, column: string, id: number): Promise<any> {
  return ((await db.prepare(`SELECT ${column} AS p FROM ${table} WHERE id = ?`).get(id)) as { p: unknown }).p;
}

/** Stats with a chosen device number, for the paths the picker returns one for; every other path is the real answer. */
function fakeDevices(pick: (p: string) => number | undefined) {
  const real = fs.promises.stat.bind(fs.promises);
  return vi.spyOn(fs.promises, "stat").mockImplementation((async (p: any, ...rest: any[]) => {
    const stats = await (real as any)(p, ...rest);
    const dev = pick(String(p));
    return dev === undefined ? stats : Object.create(stats, { dev: { value: dev } });
  }) as any);
}

describe("a destination that is not really mounted (H1)", () => {
  it("refuses a destination that is empty although titles have files recorded in it, and moves nothing", async () => {
    const from = await root("h1-src", "movie");
    const to = await root("h1-dest", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    // Another title has a file recorded in the destination, but the folder is empty: the share did not come up.
    await movie("Elsewhere", to.id, path.join(to.dir, "Elsewhere (2020)", "Elsewhere (2020).mkv"));
    await db.prepare("UPDATE media_items SET has_file = 1 WHERE title = 'Elsewhere'").run();

    const result = await titleMove.moveTitleToRootFolder(id, to.id);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/is empty although 1 item\(s\) have files recorded in it/);
    expect(result.rootFolderChanged).toBe(false);
    expect(fs.existsSync(video)).toBe(true);
    expect(fs.readdirSync(to.dir)).toEqual([]);
  });

  it("refuses a destination on the container's own disk when the source is a real mount", async () => {
    const from = await root("h1-src2", "movie");
    const to = await root("h1-dest2", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    // "/" and the destination share a device; the source is another one.
    fakeDevices((p) => (p === "/" ? 1 : p.startsWith(to.dir) ? 1 : p.startsWith(from.dir) ? 2 : undefined));

    const result = await titleMove.moveTitleToRootFolder(id, to.id);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/container's own file system/);
    expect(result.rootFolderChanged).toBe(false);
    expect(fs.existsSync(video)).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Heat (2020)"))).toBe(false);
  });

  it("moves when the destination is a mount of its own", async () => {
    const from = await root("h1-src3", "movie");
    const to = await root("h1-dest3", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    fakeDevices((p) => (p === "/" ? 1 : p.startsWith(to.dir) ? 3 : p.startsWith(from.dir) ? 2 : undefined));

    const result = await titleMove.moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(result.rootFolderChanged).toBe(true);
  });

  it("the device check answers per platform and tolerates paths it cannot read", async () => {
    const stat = (devices: Record<string, number>) => async (p: string) => {
      if (!(p in devices)) throw new Error("ENOENT");
      return { dev: devices[p] };
    };
    const check = rootFolderCheck.destinationOnContainerDiskReason;
    expect(await check("/d", "/s", stat({ "/": 1, "/d": 1, "/s": 2 }), "linux")).toMatch(/container's own file system/);
    expect(await check("/d", "/s", stat({ "/": 1, "/d": 3, "/s": 2 }), "linux")).toBeNull();
    // Both on the container's disk (a plain single-volume install): nothing to compare against.
    expect(await check("/d", "/s", stat({ "/": 1, "/d": 1, "/s": 1 }), "linux")).toBeNull();
    expect(await check("/d", "/s", stat({ "/": 1, "/d": 1, "/s": 2 }), "win32")).toBeNull();
    expect(await check("/d", "/s", stat({ "/": 1, "/s": 2 }), "linux")).toBeNull();
  });
});

describe("a mount that does not answer (M1)", () => {
  it("fails the move cleanly instead of hanging when a folder listing never returns", async () => {
    const from = await root("m1-src", "movie");
    const to = await root("m1-dest", "movie");
    // A movie file straight in the root: its sidecars are looked up by reading the folder.
    const video = write(path.join(from.dir, "Flat.mkv"));
    write(path.join(from.dir, "Flat.nfo"));
    const id = await movie("Flat", from.id, video);
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: any, ...rest: any[]) =>
      path.resolve(String(p)) === path.resolve(from.dir) ? new Promise(() => undefined) : (realReaddir as any)(p, ...rest)) as any);

    const started = Date.now();
    const result = await titleMove.moveTitleToRootFolder(id, to.id, { fsTimeoutMs: 80 });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/did not answer/);
    expect(result.rootFolderChanged).toBe(false);
    expect(fs.existsSync(video)).toBe(true);
    expect(Number(await field("media_items", "root_folder_id", id))).toBe(from.id);
  });

  it("reads a folder once for all the files of a title in it", async () => {
    const from = await root("m1-src2", "series");
    const to = await root("m1-dest2", "series");
    const dir = path.join(from.dir, "Shared");
    const mk = async (title: string) =>
      Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series', ?, ?, ?, 1, 1, 'downloaded')").run(title, title.toLowerCase(), from.id)).lastInsertRowid);
    const showId = await mk("Flat Show");
    const otherId = await mk("Other Show");
    let n = 1;
    for (const name of ["Flat.S01E01.mkv", "Flat.S01E02.mkv", "Flat.S01E03.mkv"]) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, ?, 1, 1, ?)").run(showId, n++, write(path.join(dir, name)));
    }
    // Another title has a file in the same folder, so the folder is not moved whole: each file goes on its own.
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, 1, 1, 1, 1, ?)").run(otherId, write(path.join(dir, "Other.S01E01.mkv")));
    const readdir = vi.spyOn(fs.promises, "readdir");

    const plan = await titleMove.moveTitleToRootFolder(showId, to.id, { dryRun: true });

    expect(plan.errors).toEqual([]);
    expect(plan.moved).toHaveLength(3);
    expect(readdir.mock.calls.filter((c) => path.resolve(String(c[0])) === path.resolve(dir))).toHaveLength(1);
  });
});

describe("one move per title at a time (M2)", () => {
  it("answers 409 for a title that is already being moved, and frees it when the job ends", async () => {
    const from = await root("m2-src", "movie");
    const to = await root("m2-dest", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);

    expect(lock.tryLockTitleMove(id)).toBe(true);
    expect(titleMove.isTitleMoving(id)).toBe(true);
    await expect(titleMove.startTitleMoveJob(id, to.id)).rejects.toMatchObject({ status: 409 });
    lock.unlockTitleMove(id);

    const started = await titleMove.startTitleMoveJob(id, to.id);
    expect(titleMove.isTitleMoving(id)).toBe(true);
    const { listBackgroundJobs } = await import("../src/services/backgroundJobs.js");
    for (let i = 0; i < 500 && listBackgroundJobs().find((j) => j.id === started.jobId)?.running !== false; i++) await new Promise((r) => setTimeout(r, 10));
    expect(titleMove.isTitleMoving(id)).toBe(false);
    expect(fs.existsSync(path.join(to.dir, "Heat (2020)", "Heat (2020).mkv"))).toBe(true);
  });

  it("a root folder move skips a title that is being moved and says so", async () => {
    const from = await root("m2-src2", "movie");
    const to = await root("m2-dest2", "movie");
    const a = write(path.join(from.dir, "Alpha (2020)", "Alpha (2020).mkv"));
    const b = write(path.join(from.dir, "Beta (2020)", "Beta (2020).mkv"));
    const idA = await movie("Alpha", from.id, a);
    const idB = await movie("Beta", from.id, b);
    expect(lock.tryLockTitleMove(idB)).toBe(true);

    const summary = await new Promise<{ moved: number; failed: number; skipped: number; total: number }>((resolve) => {
      titleMove.startRootFolderMoveJob({ id: from.id, path: from.dir, name: null }, { id: to.id, path: to.dir, name: null }, [
        { id: idA, title: "Alpha" },
        { id: idB, title: "Beta" },
      ], resolve);
    });

    expect(summary).toEqual({ moved: 1, failed: 0, skipped: 1, total: 2 });
    expect(fs.existsSync(b)).toBe(true);
    expect(Number(await field("media_items", "root_folder_id", idB))).toBe(from.id);
    expect(Number(await field("media_items", "root_folder_id", idA))).toBe(to.id);
    const { listBackgroundJobs } = await import("../src/services/backgroundJobs.js");
    expect(listBackgroundJobs().find((j) => j.id === `move:root-${from.id}`)?.error).toMatch(/1 title\(s\) were being moved or renamed/);
    // The title it held is still held by its own owner; the one it moved was freed.
    expect(titleMove.isTitleMoving(idB)).toBe(true);
    expect(titleMove.isTitleMoving(idA)).toBe(false);
  });

  it("refuses to rename or re-folder a title while it is being moved", async () => {
    const from = await root("m2-src3", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    lock.tryLockTitleMove(id);

    const renamed = await importer.renameOneMediaItem(id);
    expect(renamed.errors).toHaveLength(1);
    expect(renamed.errors[0].error).toMatch(/being moved/);
    expect(renamed.renamed).toEqual([]);

    await expect(importer.moveItemFolder(id)).rejects.toBeInstanceOf(importer.ImportSkippedError);
    await expect(importer.moveItemFolder(id)).rejects.toThrow(/being moved/);
  });
});

describe("a refused move does not leave the edit half applied (L8)", () => {
  it("PATCH with moveFiles answers 409 before saving any other field", async () => {
    const from = await root("l8-src", "movie");
    const to = await root("l8-dest", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    lock.tryLockTitleMove(id);

    const res = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ title: "Heat Renamed", rootFolderId: to.id, moveFiles: true });

    expect(res.status).toBe(409);
    expect(await field("media_items", "title", id)).toBe("Heat");
    expect(Number(await field("media_items", "root_folder_id", id))).toBe(from.id);
  });
});

describe("sidecars belong to their own video (M3)", () => {
  it("does not take the files of 'Alien.Resurrection' along with 'Alien'", async () => {
    const dir = path.join(tmp, "m3");
    const alien = write(path.join(dir, "Alien.mkv"));
    const resurrection = write(path.join(dir, "Alien.Resurrection.mkv"));
    for (const name of ["Alien.nfo", "Alien.en.srt", "Alien-poster.jpg", "Alien.Resurrection.nfo", "Alien.Resurrection.jpg", "Alien.Resurrection.srt", "Alien.Resurrection.en.srt", "Alien.Resurrection-poster.jpg"]) {
      write(path.join(dir, name));
    }

    const names = async (file: string) => (await titleMove.sidecarsOf(file)).map((f) => path.basename(f)).sort();
    expect(await names(alien)).toEqual(["Alien-poster.jpg", "Alien.en.srt", "Alien.nfo"]);
    expect(await names(resurrection)).toEqual(["Alien.Resurrection-poster.jpg", "Alien.Resurrection.en.srt", "Alien.Resurrection.jpg", "Alien.Resurrection.nfo", "Alien.Resurrection.srt"]);
  });

  it("only tags the importer knows may stand between the name and the extension", async () => {
    const dir = path.join(tmp, "m3b");
    const video = write(path.join(dir, "Movie.mkv"));
    for (const name of ["Movie.en.srt", "Movie.forced.srt", "Movie.pt-BR.sdh.srt", "Movie.Directors.Cut.srt", "Movie.sample.nfo", "Movie.cover.jpg"]) write(path.join(dir, name));

    expect((await titleMove.sidecarsOf(video)).map((f) => path.basename(f)).sort()).toEqual(["Movie.en.srt", "Movie.forced.srt", "Movie.pt-BR.sdh.srt"]);
  });

  it("moving 'Alien' in a shared folder leaves the other title's files where they are", async () => {
    const from = await root("m3-src", "movie");
    const to = await root("m3-dest", "movie");
    const alien = write(path.join(from.dir, "Alien.mkv"));
    write(path.join(from.dir, "Alien.nfo"));
    const other = write(path.join(from.dir, "Alien.Resurrection.mkv"));
    write(path.join(from.dir, "Alien.Resurrection.nfo"));
    const id = await movie("Alien", from.id, alien);
    await movie("Alien Resurrection", from.id, other);

    const result = await titleMove.moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(to.dir, "Alien.mkv"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Alien.nfo"))).toBe(true);
    expect(fs.existsSync(path.join(from.dir, "Alien.Resurrection.mkv"))).toBe(true);
    expect(fs.existsSync(path.join(from.dir, "Alien.Resurrection.nfo"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Alien.Resurrection.nfo"))).toBe(false);
  });
});

describe("a folder copied across file systems (M4)", () => {
  function exdevOnce(src: string, dest: string) {
    const real = fsp.rename.bind(fsp);
    return vi.spyOn(fsp, "rename").mockImplementation((async (a: any, b: any) => {
      if (path.resolve(String(a)) === path.resolve(src) && path.resolve(String(b)) === path.resolve(dest)) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      return real(a, b);
    }) as any);
  }

  it("copies to a staging name, renames it into place and removes the original", async () => {
    const src = path.join(tmp, "m4-src", "Show");
    const dest = path.join(tmp, "m4-dest", "Show");
    write(path.join(src, "S01", "e1.mkv"), "episode");
    write(path.join(src, "poster.jpg"), "poster");
    const rename = exdevOnce(src, dest);
    const staged: string[] = [];
    const realCp = fsp.cp.bind(fsp);
    vi.spyOn(fsp, "cp").mockImplementation((async (from: any, to: any, opts: any) => {
      staged.push(String(to));
      return realCp(from, to, opts);
    }) as any);

    await importer.moveAlbumFolder(src, dest);

    expect(staged).toHaveLength(1);
    expect(staged[0]).not.toBe(dest);
    expect(path.basename(staged[0])).toMatch(/^Show\.partial-[0-9a-f]{8}$/);
    expect(fs.readFileSync(path.join(dest, "S01", "e1.mkv"), "utf-8")).toBe("episode");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["Show"]);
    expect(rename).toHaveBeenCalled();
  });

  it("a copy that fails leaves no folder under the real name and no staging folder, and keeps the original", async () => {
    const src = path.join(tmp, "m4b-src", "Show");
    const dest = path.join(tmp, "m4b-dest", "Show");
    write(path.join(src, "e1.mkv"), "episode");
    exdevOnce(src, dest);
    vi.spyOn(fsp, "cp").mockImplementation((async (_from: any, to: any) => {
      write(path.join(String(to), "e1.mkv"), "ep"); // half of it arrived
      throw new Error("disk full");
    }) as any);

    await expect(importer.moveAlbumFolder(src, dest)).rejects.toThrow(/disk full/);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
    expect(fs.readFileSync(path.join(src, "e1.mkv"), "utf-8")).toBe("episode");
  });

  it("removes a staging folder left by an earlier, interrupted copy of the same destination before starting", async () => {
    const src = path.join(tmp, "m4c-src", "Show");
    const dest = path.join(tmp, "m4c-dest", "Show");
    write(path.join(src, "e1.mkv"), "episode");
    const stale = write(path.join(path.dirname(dest), "Show.partial-deadbeef", "half.mkv"), "half");
    const other = write(path.join(path.dirname(dest), "Other.partial-deadbeef", "keep.mkv"), "keep");
    exdevOnce(src, dest);

    await importer.moveAlbumFolder(src, dest);

    expect(fs.existsSync(path.dirname(stale))).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readFileSync(path.join(dest, "e1.mkv"), "utf-8")).toBe("episode");
  });
});

describe("the end of a root folder move (L3)", () => {
  it("a callback that throws is not an unhandled rejection", async () => {
    const from = await root("l3-src", "movie");
    const to = await root("l3-dest", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      let called = false;
      titleMove.startRootFolderMoveJob({ id: from.id, path: from.dir, name: null }, { id: to.id, path: to.dir, name: null }, [{ id, title: "Heat" }], () => {
        called = true;
        throw new Error("audit log is down");
      });
      for (let i = 0; i < 500 && !called; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 100));
      expect(called).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
