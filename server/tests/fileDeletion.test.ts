import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;
let tmp: string;
let tvRoot: string;
let movieRoot: string;
let binDir: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-delete-"));
  tvRoot = path.join(tmp, "tv");
  movieRoot = path.join(tmp, "movies");
  binDir = path.join(tmp, "bin");
  fs.mkdirSync(tvRoot);
  fs.mkdirSync(movieRoot);
  setSetting("recycleBinDir", binDir);
  setSetting("recycleBinEnabled", "1");
});

afterAll(() => {
  setSetting("recycleBinDir", "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["recycle_bin", "history", "queue", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  for (const root of [tvRoot, movieRoot]) for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')").run(tvRoot);
  await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(movieRoot);
  for (const key of ["removeFolderOnDelete", "deleteEmptyFolders", "unmonitorDeletedFiles"]) setSetting(key, "");
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

function write(file: string, content = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function insertShow(title: string, files: string[]): Promise<{ id: number; episodeIds: number[] }> {
  const id = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 1, 'downloaded')").run(title, title.toLowerCase())).lastInsertRowid
  );
  const episodeIds: number[] = [];
  let n = 0;
  for (const file of files) {
    n++;
    episodeIds.push(
      Number(
        (
          await db
            .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality) VALUES (?, 1, ?, ?, 1, 1, ?, 'WEBDL-1080p')")
            .run(id, n, `E${n}`, file)
        ).lastInsertRowid
      )
    );
  }
  return { id, episodeIds };
}

async function insertMovie(title: string, file: string): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, quality, status) VALUES ('movie', ?, ?, 1, 1, ?, 'WEBDL-1080p', 'downloaded')")
        .run(title, title.toLowerCase(), file)
    ).lastInsertRowid
  );
}

describe("delete with files takes the title's folder too (MM12)", () => {
  it("recycles a series folder's artwork, NFO, subtitles, extras and empty season folders", async () => {
    const e1 = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.mkv"));
    const e2 = write(path.join(tvRoot, "Show", "Season 02", "Show - S02E01.mkv"));
    write(path.join(tvRoot, "Show", "poster.jpg"));
    write(path.join(tvRoot, "Show", "tvshow.nfo"));
    write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.en.srt"));
    write(path.join(tvRoot, "Show", "Season 03", "extras", "featurette.mkv"));
    const { id } = await insertShow("Show", [e1, e2]);

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(path.join(tvRoot, "Show"))).toBe(false);
    const binned = (await db.prepare("SELECT title FROM recycle_bin").all()) as { title: string }[];
    expect(binned.map((b) => b.title)).toContain("Show (folder)");
  });

  it("recycles a movie's folder with its NFO, poster and subtitles", async () => {
    const file = write(path.join(movieRoot, "Movie (2020)", "Movie (2020).mkv"));
    write(path.join(movieRoot, "Movie (2020)", "Movie (2020).nfo"));
    write(path.join(movieRoot, "Movie (2020)", "poster.jpg"));
    write(path.join(movieRoot, "Movie (2020)", "Subs", "en.srt"));
    const id = await insertMovie("Movie", file);

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(path.join(movieRoot, "Movie (2020)"))).toBe(false);
  });

  it("leaves the folder when another title's file is in it", async () => {
    const shared = path.join(movieRoot, "Collection");
    const a = write(path.join(shared, "A (2020).mkv"));
    const b = write(path.join(shared, "B (2021).mkv"));
    const idA = await insertMovie("A", a);
    await insertMovie("B", b);

    await authed(request(app).delete(`/api/media/${idA}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
  });

  it("leaves the folder when it still holds media nobody tracks", async () => {
    const file = write(path.join(movieRoot, "Movie (2020)", "Movie (2020).mkv"));
    const stray = write(path.join(movieRoot, "Movie (2020)", "Movie (2020) Director's Cut.mkv"));
    const id = await insertMovie("Movie", file);

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(stray)).toBe(true);
  });

  it("leaves the folder when the setting is off, and never touches disk without deleteFiles", async () => {
    const file = write(path.join(movieRoot, "Movie (2020)", "Movie (2020).mkv"));
    write(path.join(movieRoot, "Movie (2020)", "poster.jpg"));
    const keep = await insertMovie("Kept", write(path.join(movieRoot, "Kept (2020)", "Kept (2020).mkv")));
    const id = await insertMovie("Movie", file);

    await authed(request(app).delete(`/api/media/${keep}`)).expect(204);
    expect(fs.existsSync(path.join(movieRoot, "Kept (2020)", "Kept (2020).mkv"))).toBe(true);

    setSetting("removeFolderOnDelete", "0");
    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);
    expect(fs.existsSync(path.join(movieRoot, "Movie (2020)", "poster.jpg"))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("takes the folder in a bulk delete too, after the files", async () => {
    const file = write(path.join(movieRoot, "Bulk (2020)", "Bulk (2020).mkv"));
    write(path.join(movieRoot, "Bulk (2020)", "Bulk (2020).nfo"));
    const id = await insertMovie("Bulk", file);

    await authed(request(app).post("/api/media/bulk/delete")).send({ mediaItemIds: [id], deleteFiles: true }).expect(200);

    expect(fs.existsSync(path.join(movieRoot, "Bulk (2020)"))).toBe(false);
  });
});

describe("deleting one file (MM13)", () => {
  it("recycles an episode's file, leaves the episode missing and keeps it monitored by default", async () => {
    const e1 = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.mkv"));
    const e2 = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E02.mkv"));
    const { id, episodeIds } = await insertShow("Show", [e1, e2]);

    const res = await authed(request(app).delete(`/api/media/${id}/episodes/${episodeIds[0]}/file`));

    expect(res.status).toBe(200);
    expect(fs.existsSync(e1)).toBe(false);
    expect(fs.existsSync(e2)).toBe(true);
    const ep = (await db.prepare("SELECT has_file, file_path, quality, monitored FROM episodes WHERE id = ?").get(episodeIds[0])) as any;
    expect(Number(ep.has_file)).toBe(0);
    expect(ep.file_path).toBeNull();
    expect(ep.quality).toBeNull();
    expect(Number(ep.monitored)).toBe(1);
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any).has_file).toBe(1);
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c).toBe(1);
  });

  it("unmonitors it with ?unmonitor=1, or when the setting says so, and the parent stops claiming a file when none is left", async () => {
    const e1 = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.mkv"));
    const { id, episodeIds } = await insertShow("Show", [e1]);

    await authed(request(app).delete(`/api/media/${id}/episodes/${episodeIds[0]}/file?unmonitor=1`)).expect(200);

    const ep = (await db.prepare("SELECT monitored FROM episodes WHERE id = ?").get(episodeIds[0])) as any;
    expect(Number(ep.monitored)).toBe(0);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any).has_file)).toBe(0);

    const e2 = write(path.join(tvRoot, "Other", "Season 01", "Other - S01E01.mkv"));
    const other = await insertShow("Other", [e2]);
    setSetting("unmonitorDeletedFiles", "1");
    await authed(request(app).delete(`/api/media/${other.id}/episodes/${other.episodeIds[0]}/file`)).expect(200);
    expect(Number(((await db.prepare("SELECT monitored FROM episodes WHERE id = ?").get(other.episodeIds[0])) as any).monitored)).toBe(0);
    await authed(request(app).delete(`/api/media/${other.id}/episodes/${other.episodeIds[0]}/file?unmonitor=0`)).expect(404);
  });

  it("clears every episode a multi-episode file covers", async () => {
    const both = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01-E02.mkv"));
    const { id, episodeIds } = await insertShow("Show", [both, both]);

    await authed(request(app).delete(`/api/media/${id}/episodes/${episodeIds[0]}/file`)).expect(200);

    const rows = (await db.prepare("SELECT has_file FROM episodes WHERE media_item_id = ?").all(id)) as any[];
    expect(rows.map((r) => Number(r.has_file))).toEqual([0, 0]);
  });

  it("deletes a movie's file and leaves the movie missing", async () => {
    const file = write(path.join(movieRoot, "Movie (2020)", "Movie (2020).mkv"));
    const id = await insertMovie("Movie", file);

    await authed(request(app).delete(`/api/media/${id}/file`)).expect(200);

    expect(fs.existsSync(file)).toBe(false);
    const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(id)) as any;
    expect(Number(row.has_file)).toBe(0);
    expect(row.path).toBeNull();
  });

  it("answers 404 for an entry with no file", async () => {
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'None', 'none', 1, 0, 'missing')").run()).lastInsertRowid);
    await authed(request(app).delete(`/api/media/${id}/file`)).expect(404);
  });

  it("refuses while the file's root folder looks offline, and changes nothing", async () => {
    const offlineRoot = path.join(tmp, "offline");
    fs.mkdirSync(offlineRoot);
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(offlineRoot);
    const id = await insertMovie("Gone", path.join(offlineRoot, "Gone (2020)", "Gone (2020).mkv"));

    const res = await authed(request(app).delete(`/api/media/${id}/file`));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/missing or empty/);
    expect(Number(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(id)) as any).has_file)).toBe(1);
  });

  it("removes the emptied season and series folders only when deleteEmptyFolders is on", async () => {
    const e1 = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.mkv"));
    const { id, episodeIds } = await insertShow("Show", [e1]);
    await authed(request(app).delete(`/api/media/${id}/episodes/${episodeIds[0]}/file`)).expect(200);
    expect(fs.existsSync(path.join(tvRoot, "Show", "Season 01"))).toBe(true);

    const e2 = write(path.join(tvRoot, "Two", "Season 01", "Two - S01E01.mkv"));
    const two = await insertShow("Two", [e2]);
    setSetting("deleteEmptyFolders", "1");
    await authed(request(app).delete(`/api/media/${two.id}/episodes/${two.episodeIds[0]}/file`)).expect(200);
    expect(fs.existsSync(path.join(tvRoot, "Two"))).toBe(false);
    expect(fs.existsSync(tvRoot)).toBe(true);
  });
});

describe("what a delete may take and refuse (R25-05, R25-06, R25-15, R25-19)", () => {
  async function insertMovieAt(file: string, title = "Live Aid"): Promise<number> {
    return insertMovie(title, file);
  }

  it("leaves a category folder alone when other content in a format the type does not list is in it", async () => {
    const live = write(path.join(movieRoot, "Concerts", "Live Aid (1985)", "Live Aid.mkv"));
    write(path.join(movieRoot, "Concerts", "Woodstock (1970)", "Woodstock.m2ts"));
    write(path.join(movieRoot, "Concerts", "Queen at Wembley.ts"));
    write(path.join(movieRoot, "Concerts", "Pulse.iso"));
    const id = await insertMovieAt(live);

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(path.join(movieRoot, "Concerts", "Live Aid (1985)"))).toBe(false);
    expect(fs.existsSync(path.join(movieRoot, "Concerts", "Woodstock (1970)", "Woodstock.m2ts"))).toBe(true);
    expect(fs.existsSync(path.join(movieRoot, "Concerts", "Queen at Wembley.ts"))).toBe(true);
    expect(fs.existsSync(path.join(movieRoot, "Concerts", "Pulse.iso"))).toBe(true);
  });

  it("never recycles a folder that is a root folder or holds one", async () => {
    const nested = path.join(tvRoot, "Kids");
    fs.mkdirSync(nested, { recursive: true });
    write(path.join(nested, "keep.txt"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')").run(nested);
    const file = write(path.join(tvRoot, "Show", "Season 01", "Show - S01E01.mkv"));
    const { id } = await insertShow("Show", [file]);
    await db.prepare("UPDATE media_items SET library_folder = 'Kids', root_folder_id = (SELECT id FROM root_folders WHERE path = ?) WHERE id = ?").run(tvRoot, id);

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    expect(fs.existsSync(path.join(nested, "keep.txt"))).toBe(true);
  });

  it("keeps files of other kinds in the title's folder when the recycle bin is off", async () => {
    const file = write(path.join(movieRoot, "Film (2020)", "Film (2020).mkv"));
    write(path.join(movieRoot, "Film (2020)", "poster.jpg"));
    const notes = write(path.join(movieRoot, "Film (2020)", "my-notes-about-film.docx"));
    const id = await insertMovie("Film", file);
    setSetting("recycleBinEnabled", "0");

    await authed(request(app).delete(`/api/media/${id}?deleteFiles=1`)).expect(204);

    setSetting("recycleBinEnabled", "1");
    expect(fs.existsSync(notes)).toBe(true);
  });

  it("refuses to delete the file of a series row whose path is its folder, and of a folder that is not an album", async () => {
    const dir = path.join(tvRoot, "Show");
    fs.mkdirSync(path.join(dir, "Season 01"), { recursive: true });
    const { id } = await insertShow("Show", []);
    await db.prepare("UPDATE media_items SET path = ? WHERE id = ?").run(dir, id);

    const res = await authed(request(app).delete(`/api/media/${id}/file`));

    expect(res.status).toBe(409);
    expect(fs.existsSync(dir)).toBe(true);

    const movieDir = path.join(movieRoot, "Odd");
    fs.mkdirSync(movieDir, { recursive: true });
    const movie = await insertMovie("Odd", movieDir);
    expect((await authed(request(app).delete(`/api/media/${movie}/file`))).status).toBe(409);
    expect(fs.existsSync(movieDir)).toBe(true);
  });

  it("refuses when another entry uses the same file", async () => {
    const file = write(path.join(movieRoot, "Twin (2020)", "Twin (2020).mkv"));
    const a = await insertMovie("Twin", file);
    await insertMovie("Twin Again", file);

    const res = await authed(request(app).delete(`/api/media/${a}/file`));

    expect(res.status).toBe(409);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("clears an album's tracks when its folder is deleted", async () => {
    const musicRoot = path.join(tmp, "music");
    fs.mkdirSync(musicRoot);
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'artist')").run(musicRoot);
    const album = path.join(musicRoot, "Artist", "Album");
    write(path.join(album, "01.flac"));
    const artistId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', 1, 1, 'downloaded')").run()).lastInsertRowid);
    const subId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Album', 1, 1, ?)").run(artistId, album)).lastInsertRowid);
    await db.prepare("INSERT INTO tracks (sub_item_id, track_number, title, has_file, file_path) VALUES (?, 1, 'One', 1, ?)").run(subId, path.join(album, "01.flac"));

    await authed(request(app).delete(`/api/media/${artistId}/subitems/${subId}/file`)).expect(200);

    const track = (await db.prepare("SELECT has_file, file_path FROM tracks WHERE sub_item_id = ?").get(subId)) as any;
    expect(Number(track.has_file)).toBe(0);
    expect(track.file_path).toBeNull();
    await db.prepare("DELETE FROM tracks").run();
    await db.prepare("DELETE FROM root_folders WHERE path = ?").run(musicRoot);
  });

  it("cleans the stored folder of a title that has no files in a bulk delete too", async () => {
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Empty', 'empty', (SELECT id FROM root_folders WHERE path = ?), 'Empty', 1, 0, 'missing')").run(tvRoot))
        .lastInsertRowid
    );
    write(path.join(tvRoot, "Empty", "poster.jpg"));

    await authed(request(app).post("/api/media/bulk/delete")).send({ mediaItemIds: [id], deleteFiles: true }).expect(200);

    expect(fs.existsSync(path.join(tvRoot, "Empty"))).toBe(false);
  });
});
