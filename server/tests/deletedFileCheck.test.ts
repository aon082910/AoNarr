import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let tmpDir: string;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-deletedcheck-"));
});

afterEach(async () => {
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("unmonitorDeletedFiles", "0");
});

function realFile(name: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, "x");
  return p;
}

function goneFile(name: string): string {
  return path.join(tmpDir, name); // never created
}

async function insertMovie(filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('movie', 'Movie', 'movie', 1, 1, 'unknown', ?)`
        )
        .run(filePath)
    ).lastInsertRowid
  );
}

async function insertSeries(hasFile: number): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES ('series', 'Show', 'show', 1, ?, 'unknown', NULL)`
        )
        .run(hasFile)
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, file_path) VALUES (?, ?, ?, 1, 1, ?)"
        )
        .run(showId, season, episode, filePath)
    ).lastInsertRowid
  );
}

async function insertArtist(): Promise<number> {
  return Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 0, 'unknown')`)
        .run()
    ).lastInsertRowid
  );
}

async function insertSubItem(artistId: number, filePath: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)")
        .run(artistId, filePath)
    ).lastInsertRowid
  );
}

describe("checkForDeletedFiles — movies", () => {
  it("leaves a movie alone when its file still exists", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const filePath = realFile("still-here.mkv");
    const id = await insertMovie(filePath);

    const result = await checkForDeletedFiles();

    expect(result.missing).toBe(0);
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(1);
    expect(row.path).toBe(filePath);
  });

  it("clears has_file and path for a movie whose file vanished, keeping it monitored by default", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const id = await insertMovie(goneFile("vanished.mkv"));

    const result = await checkForDeletedFiles();

    expect(result.missing).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT has_file, path, monitored FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.has_file).toBe(0);
    expect(row.path).toBeNull();
    expect(row.monitored).toBe(1);
  });

  it("also unmonitors a movie with a vanished file when unmonitorDeletedFiles is enabled", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    setSetting("unmonitorDeletedFiles", "1");
    const id = await insertMovie(goneFile("vanished-unmonitor.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(id)) as any;
    expect(row.monitored).toBe(0);
  });
});

describe("checkForDeletedFiles — episodes and sub-items", () => {
  it("clears an episode's file fields when its file vanished", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    const epId = await insertEpisode(showId, 1, 1, goneFile("ep-vanished.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(epId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
  });

  it("clears a sub-item's file fields when its file vanished", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const artistId = await insertArtist();
    const subId = await insertSubItem(artistId, goneFile("album-vanished.mp3"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file, file_path FROM sub_items WHERE id = ?").get(subId)) as any;
    expect(row.has_file).toBe(0);
    expect(row.file_path).toBeNull();
  });

  it("rolls the parent's has_file back to 0 once its only file-bearing episode vanishes", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    await insertEpisode(showId, 1, 1, goneFile("only-ep-vanished.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.has_file).toBe(0);
  });

  it("leaves the parent's has_file alone when another episode still has its file", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    const showId = await insertSeries(1);
    await insertEpisode(showId, 1, 1, goneFile("one-vanishes.mkv"));
    await insertEpisode(showId, 1, 2, realFile("one-survives.mkv"));

    await checkForDeletedFiles();

    const row = (await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as any;
    expect(row.has_file).toBe(1);
  });

  it("counts every table's checked/missing files in the returned totals", async () => {
    const { checkForDeletedFiles } = await import("../src/services/deletedFileCheck.js");
    await insertMovie(realFile("count-movie-ok.mkv"));
    await insertMovie(goneFile("count-movie-gone.mkv"));
    const showId = await insertSeries(1);
    await insertEpisode(showId, 5, 1, goneFile("count-ep-gone.mkv"));
    const artistId = await insertArtist();
    await insertSubItem(artistId, realFile("count-sub-ok.mp3"));

    const result = await checkForDeletedFiles();

    expect(result.checked).toBeGreaterThanOrEqual(4);
    expect(result.missing).toBeGreaterThanOrEqual(2);
  });
});
