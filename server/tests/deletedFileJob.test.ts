import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return { ...actual, searchMetadata: vi.fn().mockResolvedValue([]) };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let runDeletedFileCheckJob: (typeof import("../src/services/deletedFileJob.js"))["runDeletedFileCheckJob"];
let root: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ runDeletedFileCheckJob } = await import("../src/services/deletedFileJob.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedjob-"));
  await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'movie')").run(root);
});

afterEach(() => {
  setSetting("unmonitorDeletedFiles", "0");
  fs.rmSync(root, { recursive: true, force: true });
});

async function insertMovie(title: string, year: number, filePath: string): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, path, status) VALUES ('movie', ?, ?, ?, 1, 1, ?, 'downloaded')`)
        .run(title, title.toLowerCase(), year, filePath)
    ).lastInsertRowid
  );
}

function writeFile(...parts: string[]): string {
  const p = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "fake bytes");
  return p;
}

describe("runDeletedFileCheckJob — a file that only moved (MM6)", () => {
  it("re-links the file in the same run instead of leaving the title missing until the next scan", async () => {
    const oldPath = path.join(root, "Old Folder", "Dune.2021.1080p.mkv"); // another tool moved it...
    const moved = writeFile("New Folder", "Dune.2021.1080p.mkv"); // ...here
    const id = await insertMovie("Dune", 2021, oldPath);

    await runDeletedFileCheckJob();

    const row = (await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(row.path).toBe(moved);
    expect(Number(row.monitored)).toBe(1);
  });

  it("applies Unmonitor Deleted only to the files that are really gone, not the ones that moved", async () => {
    setSetting("unmonitorDeletedFiles", "1");
    const moved = writeFile("New Folder", "Dune.2021.1080p.mkv");
    const movedId = await insertMovie("Dune", 2021, path.join(root, "Old Folder", "Dune.2021.1080p.mkv"));
    const goneId = await insertMovie("Gone Movie", 2019, path.join(root, "Gone Movie (2019)", "Gone.Movie.2019.mkv"));
    writeFile("Keep", "Keep.This.2018.mkv"); // keeps the root folder populated, so it is not read as an offline mount

    await runDeletedFileCheckJob();

    const movedRow = (await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(movedId)) as any;
    expect(Number(movedRow.has_file)).toBe(1);
    expect(movedRow.path).toBe(moved);
    expect(Number(movedRow.monitored)).toBe(1);
    const goneRow = (await db.prepare("SELECT has_file, monitored FROM media_items WHERE id = ?").get(goneId)) as any;
    expect(Number(goneRow.has_file)).toBe(0);
    expect(Number(goneRow.monitored)).toBe(0);
  });

  it("does not scan the library when nothing is missing", async () => {
    const present = writeFile("Dune (2021)", "Dune.2021.1080p.mkv");
    await insertMovie("Dune", 2021, present);
    writeFile("Unlinked Movie (2020)", "Unlinked.Movie.2020.mkv"); // a scan would create an item for this

    await runDeletedFileCheckJob();

    const rows = (await db.prepare("SELECT title FROM media_items WHERE type='movie'").all()) as any[];
    expect(rows.map((r) => r.title)).toEqual(["Dune"]);
  });
});
