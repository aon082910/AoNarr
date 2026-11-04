import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let tmp: string;
let moveTitleToRootFolder: (typeof import("../src/services/titleMove.js"))["moveTitleToRootFolder"];
let sidecarsOf: (typeof import("../src/services/titleMove.js"))["sidecarsOf"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ moveTitleToRootFolder, sidecarsOf } = await import("../src/services/titleMove.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-titlemove-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["history", "queue", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
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

async function pathOf(table: string, column: string, id: number): Promise<string | null> {
  return ((await db.prepare(`SELECT ${column} AS p FROM ${table} WHERE id = ?`).get(id)) as { p: string | null }).p;
}

describe("moving a movie that has a folder of its own", () => {
  it("takes the whole folder: video, artwork, NFO, subtitles and the extras folder", async () => {
    const from = await root("movies-a", "movie");
    const to = await root("movies-b", "movie");
    const folder = path.join(from.dir, "Heat (2020)");
    const video = write(path.join(folder, "Heat (2020).mkv"));
    write(path.join(folder, "poster.jpg"));
    write(path.join(folder, "fanart.jpg"));
    write(path.join(folder, "Heat (2020).nfo"));
    write(path.join(folder, "Heat (2020).en.srt"));
    write(path.join(folder, "extras", "Making of.mkv"));
    const id = await movie("Heat", from.id, video);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(result.rootFolderChanged).toBe(true);
    const newFolder = path.join(to.dir, "Heat (2020)");
    for (const name of ["Heat (2020).mkv", "poster.jpg", "fanart.jpg", "Heat (2020).nfo", "Heat (2020).en.srt", path.join("extras", "Making of.mkv")]) {
      expect(fs.existsSync(path.join(newFolder, name))).toBe(true);
    }
    expect(fs.existsSync(folder)).toBe(false);
    expect(await pathOf("media_items", "path", id)).toBe(path.join(newFolder, "Heat (2020).mkv"));
    expect(Number(await pathOf("media_items", "root_folder_id", id))).toBe(to.id);
  });

  it("keeps the category level above the movie's folder", async () => {
    const from = await root("movies-cat-a", "movie");
    const to = await root("movies-cat-b", "movie");
    const video = write(path.join(from.dir, "Action", "Heat (2020)", "Heat (2020).mkv"));
    write(path.join(from.dir, "Action", "Heat (2020)", "poster.jpg"));
    const other = write(path.join(from.dir, "Action", "Ronin (2020)", "Ronin (2020).mkv"));
    const id = await movie("Heat", from.id, video);
    await movie("Ronin", from.id, other);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(to.dir, "Action", "Heat (2020)", "poster.jpg"))).toBe(true);
    // The category folder and the other movie in it stay.
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(from.dir, "Action", "Heat (2020)"))).toBe(false);
  });

  it("a dry run lists what would move and changes nothing", async () => {
    const from = await root("movies-dry-a", "movie");
    const to = await root("movies-dry-b", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);

    const result = await moveTitleToRootFolder(id, to.id, { dryRun: true });

    expect(result.moved).toEqual([{ kind: "folder", from: path.join(from.dir, "Heat (2020)"), to: path.join(to.dir, "Heat (2020)") }]);
    expect(result.rootFolderChanged).toBe(false);
    expect(fs.existsSync(video)).toBe(true);
    expect(Number(await pathOf("media_items", "root_folder_id", id))).toBe(from.id);
  });
});

describe("moving a movie that sits in a folder shared with other files", () => {
  it("moves the video and the files named for it, and leaves the rest of the folder", async () => {
    const from = await root("movies-shared-a", "movie");
    const to = await root("movies-shared-b", "movie");
    const video = write(path.join(from.dir, "Heat (2020).mkv"));
    write(path.join(from.dir, "Heat (2020).nfo"));
    write(path.join(from.dir, "Heat (2020).en.forced.srt"));
    write(path.join(from.dir, "Heat (2020)-poster.jpg"));
    const neighbour = write(path.join(from.dir, "Ronin (2020).mkv"));
    write(path.join(from.dir, "Ronin (2020).nfo"));
    write(path.join(from.dir, "poster.jpg"));
    const id = await movie("Heat", from.id, video);
    await movie("Ronin", from.id, neighbour);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(fs.readdirSync(to.dir).sort()).toEqual(["Heat (2020)-poster.jpg", "Heat (2020).en.forced.srt", "Heat (2020).mkv", "Heat (2020).nfo"]);
    expect(fs.readdirSync(from.dir).sort()).toEqual(["Ronin (2020).mkv", "Ronin (2020).nfo", "poster.jpg"]);
    expect(await pathOf("media_items", "path", id)).toBe(path.join(to.dir, "Heat (2020).mkv"));
  });

  it("falls back to the tracked files when another title has a file in the movie's own folder", async () => {
    const from = await root("movies-two-a", "movie");
    const to = await root("movies-two-b", "movie");
    const folder = path.join(from.dir, "Heat (2020)");
    const video = write(path.join(folder, "Heat (2020).mkv"));
    write(path.join(folder, "Heat (2020).nfo"));
    write(path.join(folder, "poster.jpg"));
    const remake = write(path.join(folder, "Heat (2020) remake.mkv"));
    const id = await movie("Heat", from.id, video);
    const remakeId = await movie("Heat Remake", from.id, remake);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => /belongs to another title/.test(s.reason))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Heat (2020)", "Heat (2020).mkv"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Heat (2020)", "Heat (2020).nfo"))).toBe(true);
    // The other title's file and the folder's own artwork stay.
    expect(fs.existsSync(remake)).toBe(true);
    expect(fs.existsSync(path.join(folder, "poster.jpg"))).toBe(true);
    expect(await pathOf("media_items", "path", remakeId)).toBe(remake);
  });
});

describe("moving a show", () => {
  it("moves the show's folder with the season folders and artwork, and repoints every episode", async () => {
    const from = await root("shows-a", "series");
    const to = await root("shows-b", "series");
    const e1 = write(path.join(from.dir, "Arrow", "Season 01", "Arrow - S01E01 - Pilot.mkv"));
    const e2 = write(path.join(from.dir, "Arrow", "Season 02", "Arrow - S02E01 - Sara.mkv"));
    write(path.join(from.dir, "Arrow", "poster.jpg"));
    write(path.join(from.dir, "Arrow", "tvshow.nfo"));
    write(path.join(from.dir, "Arrow", "Season 01", "season01-poster.jpg"));
    const showId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Arrow', 'arrow', ?, 'Arrow', 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const ep1 = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'Pilot', 1, 1, ?)").run(showId, e1)).lastInsertRowid);
    const ep2 = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 2, 1, 'Sara', 1, 1, ?)").run(showId, e2)).lastInsertRowid);

    const result = await moveTitleToRootFolder(showId, to.id);

    expect(result.errors).toEqual([]);
    expect(result.moved).toHaveLength(1);
    expect(fs.existsSync(path.join(to.dir, "Arrow", "poster.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Arrow", "tvshow.nfo"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Arrow", "Season 01", "season01-poster.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(from.dir, "Arrow"))).toBe(false);
    expect(await pathOf("episodes", "file_path", ep1)).toBe(path.join(to.dir, "Arrow", "Season 01", "Arrow - S01E01 - Pilot.mkv"));
    expect(await pathOf("episodes", "file_path", ep2)).toBe(path.join(to.dir, "Arrow", "Season 02", "Arrow - S02E01 - Sara.mkv"));
    expect(await pathOf("media_items", "library_folder", showId)).toBe("Arrow");
    expect(Number(await pathOf("media_items", "root_folder_id", showId))).toBe(to.id);
  });

  it("does not touch anything when the destination already has a folder of that name", async () => {
    const from = await root("shows-clash-a", "series");
    const to = await root("shows-clash-b", "series");
    const e1 = write(path.join(from.dir, "Arrow", "Season 01", "Arrow - S01E01 - Pilot.mkv"));
    write(path.join(to.dir, "Arrow", "something.txt"));
    const showId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Arrow', 'arrow', ?, 'Arrow', 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const ep1 = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'Pilot', 1, 1, ?)").run(showId, e1)).lastInsertRowid);

    const result = await moveTitleToRootFolder(showId, to.id);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/already exists/);
    expect(result.rootFolderChanged).toBe(false);
    expect(fs.existsSync(e1)).toBe(true);
    expect(await pathOf("episodes", "file_path", ep1)).toBe(e1);
    expect(Number(await pathOf("media_items", "root_folder_id", showId))).toBe(from.id);
  });

  it("finishes the rest when it is run again after a partial move", async () => {
    const from = await root("shows-redo-a", "series");
    const to = await root("shows-redo-b", "series");
    // A show whose episodes sit in two folders of the source: "Arrow" and a second one it also tracks.
    const e1 = write(path.join(from.dir, "Arrow", "Season 01", "Arrow - S01E01 - Pilot.mkv"));
    const e2 = write(path.join(from.dir, "Arrow Specials", "Season 00", "Arrow - S00E01 - Special.mkv"));
    const showId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Arrow', 'arrow', ?, 'Arrow', 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'Pilot', 1, 1, ?)").run(showId, e1);
    const ep2 = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 0, 1, 'Special', 1, 1, ?)").run(showId, e2)).lastInsertRowid);
    // The second piece cannot land the first time: its destination is taken.
    write(path.join(to.dir, "Arrow Specials", "x.txt"));

    const first = await moveTitleToRootFolder(showId, to.id);
    expect(first.errors).toHaveLength(1);
    expect(first.rootFolderChanged).toBe(false);
    expect(fs.existsSync(path.join(to.dir, "Arrow", "Season 01", "Arrow - S01E01 - Pilot.mkv"))).toBe(true);
    expect(await pathOf("episodes", "file_path", ep2)).toBe(e2);
    expect(Number(await pathOf("media_items", "root_folder_id", showId))).toBe(from.id);

    fs.rmSync(path.join(to.dir, "Arrow Specials"), { recursive: true });
    const second = await moveTitleToRootFolder(showId, to.id);

    expect(second.errors).toEqual([]);
    expect(second.rootFolderChanged).toBe(true);
    expect(await pathOf("episodes", "file_path", ep2)).toBe(path.join(to.dir, "Arrow Specials", "Season 00", "Arrow - S00E01 - Special.mkv"));
  });
});

describe("moving music", () => {
  it("moves the artist's folder with every album, repointing albums and tracks", async () => {
    const from = await root("music-a", "artist");
    const to = await root("music-b", "artist");
    const album1 = path.join(from.dir, "Band", "First (2001)");
    const album2 = path.join(from.dir, "Band", "Second (2003)");
    const t1 = write(path.join(album1, "01 - One.flac"));
    write(path.join(album1, "cover.jpg"));
    write(path.join(album2, "01 - Two.flac"));
    write(path.join(from.dir, "Band", "artist.nfo"));
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Band', 'band', ?, 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const a1 = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'First', 1, ?, 1)").run(id, album1)).lastInsertRowid);
    const a2 = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'Second', 1, ?, 1)").run(id, album2)).lastInsertRowid);
    const track = Number((await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'One', 1, ?)").run(a1, t1)).lastInsertRowid);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(result.moved).toEqual([{ kind: "folder", from: path.join(from.dir, "Band"), to: path.join(to.dir, "Band") }]);
    expect(fs.existsSync(path.join(to.dir, "Band", "artist.nfo"))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, "Band", "First (2001)", "cover.jpg"))).toBe(true);
    expect(await pathOf("sub_items", "file_path", a1)).toBe(path.join(to.dir, "Band", "First (2001)"));
    expect(await pathOf("sub_items", "file_path", a2)).toBe(path.join(to.dir, "Band", "Second (2003)"));
    expect(await pathOf("tracks", "file_path", track)).toBe(path.join(to.dir, "Band", "First (2001)", "01 - One.flac"));
    expect(fs.existsSync(path.join(from.dir, "Band"))).toBe(false);
  });

  it("moves only the album folders when another artist has files in the same folder", async () => {
    const from = await root("music-shared-a", "artist");
    const to = await root("music-shared-b", "artist");
    const album = path.join(from.dir, "Band", "First (2001)");
    write(path.join(album, "01 - One.flac"));
    const otherAlbum = path.join(from.dir, "Band", "Other Act - Album");
    write(path.join(otherAlbum, "01 - Two.flac"));
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Band', 'band', ?, 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const otherId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Other Act', 'other act', ?, 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const a1 = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'First', 1, ?, 1)").run(id, album)).lastInsertRowid);
    const a2 = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path, monitored) VALUES (?, 'Album', 1, ?, 1)").run(otherId, otherAlbum)).lastInsertRowid);

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors).toEqual([]);
    expect(await pathOf("sub_items", "file_path", a1)).toBe(path.join(to.dir, "Band", "First (2001)"));
    expect(await pathOf("sub_items", "file_path", a2)).toBe(otherAlbum);
    expect(fs.existsSync(otherAlbum)).toBe(true);
  });
});

describe("the checks before a move", () => {
  it("refuses a destination of another media type, a read-only one, and a read-only source", async () => {
    const from = await root("chk-a", "movie");
    const books = await root("chk-b", "book");
    const ro = await root("chk-c", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(ro.id);
    const id = await movie("Heat", from.id, null);

    await expect(moveTitleToRootFolder(id, books.id)).rejects.toMatchObject({ status: 400 });
    await expect(moveTitleToRootFolder(id, ro.id)).rejects.toMatchObject({ status: 400 });
    await expect(moveTitleToRootFolder(id, 99999)).rejects.toMatchObject({ status: 404 });
    await expect(moveTitleToRootFolder(99999, from.id)).rejects.toMatchObject({ status: 404 });

    const open = await root("chk-d", "movie");
    await db.prepare("UPDATE root_folders SET read_only = 1 WHERE id = ?").run(from.id);
    await expect(moveTitleToRootFolder(id, open.id)).rejects.toMatchObject({ status: 400 });
  });

  it("repoints a title that has no files, and reports a file missing from disk as an error", async () => {
    const from = await root("chk-e", "movie");
    const to = await root("chk-f", "movie");
    write(path.join(from.dir, "other.txt"));
    const noFile = await movie("Wanted", from.id, null);
    const ghost = await movie("Ghost", from.id, path.join(from.dir, "Ghost (2020)", "Ghost (2020).mkv"));

    expect((await moveTitleToRootFolder(noFile, to.id)).rootFolderChanged).toBe(true);
    const failed = await moveTitleToRootFolder(ghost, to.id);
    expect(failed.rootFolderChanged).toBe(false);
    expect(failed.errors[0].error).toMatch(/not on disk/);
    expect(Number(await pathOf("media_items", "root_folder_id", ghost))).toBe(from.id);
  });

  it("refuses to move out of a source folder that is empty although files are recorded in it (a share that did not mount)", async () => {
    const from = await root("chk-g", "movie");
    const to = await root("chk-h", "movie");
    const id = await movie("Ghost", from.id, path.join(from.dir, "Ghost (2020)", "Ghost (2020).mkv"));

    const result = await moveTitleToRootFolder(id, to.id);

    expect(result.errors[0].error).toMatch(/is empty although/);
    expect(Number(await pathOf("media_items", "root_folder_id", id))).toBe(from.id);
  });
});

describe("sidecarsOf", () => {
  it("lists the files named for a video and not its neighbours' or a longer name's", async () => {
    const dir = path.join(tmp, "side");
    const video = write(path.join(dir, "Movie.mkv"));
    for (const name of ["Movie.nfo", "Movie.srt", "Movie.pt-BR.srt", "Movie.jpg", "Movie-poster.jpg", "Movie-fanart.png", "Movie 2.nfo", "Movie-extra.jpg", "Movie.mkv.bak", "Movie.mp4", "poster.jpg"]) write(path.join(dir, name));

    expect(sidecarsOf(video).map((f) => path.basename(f)).sort()).toEqual(["Movie-fanart.png", "Movie-poster.jpg", "Movie.jpg", "Movie.nfo", "Movie.pt-BR.srt", "Movie.srt"]);
  });
});

describe("the move routes", () => {
  async function waitForJobToEnd(jobId: string): Promise<{ error: string | null }> {
    const { listBackgroundJobs } = await import("../src/services/backgroundJobs.js");
    for (let i = 0; i < 500; i++) {
      const job = listBackgroundJobs().find((j) => j.id === jobId);
      if (job && !job.running) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`job ${jobId} never finished`);
  }

  it("POST /api/media/:id/move-files answers at once with the job and moves the folder in the background", async () => {
    const from = await root("route-a", "movie");
    const to = await root("route-b", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    write(path.join(from.dir, "Heat (2020)", "poster.jpg"));
    const id = await movie("Heat", from.id, video);

    const res = await request(app).post(`/api/media/${id}/move-files`).set("X-Api-Key", apiKey).send({ rootFolderId: to.id });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true, jobId: `move:title-${id}` });
    const job = await waitForJobToEnd(res.body.jobId);
    expect(job.error).toBeNull();
    expect(fs.existsSync(path.join(to.dir, "Heat (2020)", "poster.jpg"))).toBe(true);
    expect(await pathOf("media_items", "path", id)).toBe(path.join(to.dir, "Heat (2020)", "Heat (2020).mkv"));
  });

  it("?preview=1 answers with the plan and moves nothing; a bad destination is a 400 and no job starts", async () => {
    const from = await root("route-c", "movie");
    const to = await root("route-d", "movie");
    const books = await root("route-e", "book");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    const id = await movie("Heat", from.id, video);

    const preview = await request(app).post(`/api/media/${id}/move-files?preview=1`).set("X-Api-Key", apiKey).send({ rootFolderId: to.id });
    expect(preview.status).toBe(200);
    expect(preview.body.moved).toHaveLength(1);
    expect(fs.existsSync(video)).toBe(true);

    const bad = await request(app).post(`/api/media/${id}/move-files`).set("X-Api-Key", apiKey).send({ rootFolderId: books.id });
    expect(bad.status).toBe(400);
    const missing = await request(app).post(`/api/media/${id}/move-files`).set("X-Api-Key", apiKey).send({});
    expect(missing.status).toBe(400);
  });

  it("reports a failed move as the job's error and leaves the title where it was", async () => {
    const from = await root("route-f", "movie");
    const to = await root("route-g", "movie");
    const video = write(path.join(from.dir, "Heat (2020)", "Heat (2020).mkv"));
    write(path.join(to.dir, "Heat (2020)", "taken.txt"));
    const id = await movie("Heat", from.id, video);

    const res = await request(app).post(`/api/media/${id}/move-files`).set("X-Api-Key", apiKey).send({ rootFolderId: to.id });
    const job = await waitForJobToEnd(res.body.jobId);

    expect(job.error).toMatch(/already exists/);
    expect(fs.existsSync(video)).toBe(true);
    expect(Number(await pathOf("media_items", "root_folder_id", id))).toBe(from.id);
  });
});

describe("removing a root folder that still has titles (MM22)", () => {
  it("is refused with a 409 and a code, unless forced or told to remove the titles", async () => {
    const r = await root("del-a", "movie");
    const other = await root("del-b", "movie");
    const id = await movie("Heat", r.id, null);

    const refused = await request(app).delete(`/api/root-folders/${r.id}`).set("X-Api-Key", apiKey);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("root_folder_in_use");
    expect(refused.body.error).toMatch(/1 title/);
    expect(await db.prepare("SELECT 1 AS ok FROM root_folders WHERE id = ?").get(r.id)).toBeTruthy();

    const impact = await request(app).get(`/api/root-folders/${r.id}/impact`).set("X-Api-Key", apiKey);
    expect(impact.body.otherFolders).toEqual([{ id: other.id, path: other.dir, name: null }]);

    const forced = await request(app).delete(`/api/root-folders/${r.id}?force=1`).set("X-Api-Key", apiKey);
    expect(forced.status).toBe(204);
    expect(Number((await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE id = ?").get(id)) as any ? 1 : 0)).toBe(1);
    expect(await pathOf("media_items", "root_folder_id", id)).toBeNull();
  });

  it("removes an empty folder without force, and the titles with deleteMedia", async () => {
    const empty = await root("del-c", "movie");
    expect((await request(app).delete(`/api/root-folders/${empty.id}`).set("X-Api-Key", apiKey)).status).toBe(204);

    const full = await root("del-d", "movie");
    const id = await movie("Heat", full.id, null);
    expect((await request(app).delete(`/api/root-folders/${full.id}?deleteMedia=1`).set("X-Api-Key", apiKey)).status).toBe(204);
    expect(await db.prepare("SELECT 1 AS ok FROM media_items WHERE id = ?").get(id)).toBeFalsy();
  });
});
