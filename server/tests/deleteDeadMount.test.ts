import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let tmp: string;
let movieRoot: string;
let setSetting: (key: string, value: string) => void;
let removeLeftoverFolders: (typeof import("../src/services/fileDeletion.js"))["removeLeftoverFolders"];
let setFolderWalkTimeoutForTests: (typeof import("../src/services/fileDeletion.js"))["setFolderWalkTimeoutForTests"];
let resetFsAsyncStateForTests: (typeof import("../src/services/fsAsync.js"))["resetFsAsyncStateForTests"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ removeLeftoverFolders, setFolderWalkTimeoutForTests } = await import("../src/services/fileDeletion.js"));
  ({ resetFsAsyncStateForTests } = await import("../src/services/fsAsync.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-dead-mount-"));
  movieRoot = path.join(tmp, "movies");
  fs.mkdirSync(movieRoot);
  setSetting("recycleBinDir", path.join(tmp, "bin"));
  setSetting("recycleBinEnabled", "1");
});

afterAll(() => {
  setSetting("recycleBinDir", "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["recycle_bin", "history", "queue", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(movieRoot);
  for (const name of fs.readdirSync(movieRoot)) fs.rmSync(path.join(movieRoot, name), { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setFolderWalkTimeoutForTests(null);
  resetFsAsyncStateForTests();
});

const never = () => new Promise<never>(() => {});

function write(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  return file;
}

describe("a delete does not hang on a directory that never answers (round 30c)", () => {
  it("gives up on the title's folder after the call timeout and leaves it in place", async () => {
    const folder = path.join(movieRoot, "Movie (2020)");
    write(path.join(folder, "poster.jpg"));
    // Everything the walk asks of the disk except the directory read answers; the read never does.
    vi.spyOn(fs.promises, "access").mockResolvedValue(undefined);
    vi.spyOn(fs.promises, "readdir").mockImplementation(never as never);
    vi.useFakeTimers();

    let settled: Awaited<ReturnType<typeof removeLeftoverFolders>> | undefined;
    const run = removeLeftoverFolders({ type: "movie", title: "Movie", library_folder: "Movie (2020)", root_folder_id: Number(((await db.prepare("SELECT id FROM root_folders").get()) as any).id) }, []).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBeUndefined(); // still waiting: the call has not timed out yet
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(settled?.unresponsive).toEqual([folder]);
    expect(settled?.removed).toEqual([]);
    expect(settled?.kept[0].reason).toMatch(/did not answer/);
    vi.useRealTimers();
    expect(fs.existsSync(folder)).toBe(true);
  });

  it("answers a delete with files that it removed the title, with a warning about the folder", async () => {
    const file = write(path.join(movieRoot, "Movie (2020)", "Movie (2020).mkv"));
    write(path.join(movieRoot, "Movie (2020)", "poster.jpg"));
    const id = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, quality, status) VALUES ('movie', 'Movie', 'movie', 1, 1, ?, 'WEBDL-1080p', 'downloaded')")
          .run(file)
      ).lastInsertRowid
    );
    setFolderWalkTimeoutForTests(60);
    // Only the title's own folder hangs; the recycle bin's and the files' reads are untouched.
    const real = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, "readdir").mockImplementation(((target: unknown, ...rest: unknown[]) =>
      String(target) === path.join(movieRoot, "Movie (2020)") ? never() : (real as any)(target, ...rest)) as never);

    const started = Date.now();
    const res = await request(app).delete(`/api/media/${id}?deleteFiles=1`).set("X-Api-Key", apiKey);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.warnings[0]).toMatch(/did not answer, so that folder was left in place/);
    expect(await db.prepare("SELECT 1 FROM media_items WHERE id = ?").get(id)).toBeFalsy();
    expect(fs.existsSync(file)).toBe(false); // the file went to the recycle bin
    expect(fs.existsSync(path.join(movieRoot, "Movie (2020)", "poster.jpg"))).toBe(true);
  });

  it("still answers 204 with nothing to report when the storage is fine", async () => {
    const file = write(path.join(movieRoot, "Fine (2020)", "Fine (2020).mkv"));
    const id = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, quality, status) VALUES ('movie', 'Fine', 'fine', 1, 1, ?, 'WEBDL-1080p', 'downloaded')")
          .run(file)
      ).lastInsertRowid
    );

    await request(app).delete(`/api/media/${id}?deleteFiles=1`).set("X-Api-Key", apiKey).expect(204);

    expect(fs.existsSync(path.join(movieRoot, "Fine (2020)"))).toBe(false);
  });
});
