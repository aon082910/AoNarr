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

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-mm-"));
  setSetting("recycleBinDir", path.join(tmp, "bin"));
  setSetting("recycleBinEnabled", "1");
});

afterAll(() => {
  setSetting("recycleBinDir", "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ["recycle_bin", "history", "queue", "episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

async function root(name: string, mediaType = "series"): Promise<{ id: number; path: string }> {
  const p = path.join(tmp, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, ".keep"), "x");
  return { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(p, mediaType)).lastInsertRowid), path: p };
}

describe("recycle bin retention of 0 keeps everything (MM19)", () => {
  it("purges old entries by the retention and none when it is 0", async () => {
    const { purgeExpiredRecycleBinEntries } = await import("../src/services/recycleBin.js");
    const file = path.join(tmp, "old.mkv");
    fs.writeFileSync(file, "x");
    const { recycleFile } = await import("../src/services/recycleBin.js");
    await recycleFile(file, "movie", "Old", null);
    await db.prepare("UPDATE recycle_bin SET deleted_at = '2000-01-01 00:00:00'").run();

    setSetting("recycleBinRetentionDays", "0");
    await purgeExpiredRecycleBinEntries();
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c).toBe(1);

    setSetting("recycleBinRetentionDays", "7");
    await purgeExpiredRecycleBinEntries();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM recycle_bin").get()) as any).c)).toBe(0);
    setSetting("recycleBinRetentionDays", "");
  });
});

describe("a naming template that cannot work is refused on save (MM15)", () => {
  it("answers 400 for a series template with no episode token, and takes a good one", async () => {
    const bad = await authed(request(app).put("/api/settings/namingSeriesTemplate")).send({ value: "{parentTitle}/Season {season:00}/{parentTitle}" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/needs \{episode\}/);

    const good = await authed(request(app).put("/api/settings/namingSeriesTemplate")).send({ value: "{Series Title}/Season {season:00}/{Series Title} - S{season:00}E{episode:00}" });
    expect(good.status).toBe(200);
    await authed(request(app).put("/api/settings/namingSeriesTemplate")).send({ value: "" });
  });
});

describe("root folders (MM22)", () => {
  it("says how many titles use a root folder before it is removed", async () => {
    const r = await root("impact");
    await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series', 'A', 'a', ?, 1, 1, 'downloaded')").run(r.id);
    await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('series', 'B', 'b', ?, 1, 0, 'missing')").run(r.id);

    const res = await authed(request(app).get(`/api/root-folders/${r.id}/impact`));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ itemCount: 2, itemsWithFiles: 1 });
    await authed(request(app).get("/api/root-folders/99999/impact")).expect(404);
  });

  it("moves the files of an item to the new root folder when asked with moveFiles", async () => {
    const from = await root("from");
    const to = await root("to");
    const file = path.join(from.path, "Show", "Season 01", "Show - S01E01 - Pilot.mkv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    const showId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Show', 'show', ?, 'Show', 1, 1, 'downloaded')").run(from.id)).lastInsertRowid
    );
    const epId = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path) VALUES (?, 1, 1, 'Pilot', 1, 1, ?)").run(showId, file)).lastInsertRowid);

    const stays = await authed(request(app).patch(`/api/media/${showId}`)).send({ rootFolderId: to.id });
    expect(stays.status).toBe(200);
    expect(stays.body.filesMoved).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);

    const moves = await authed(request(app).patch(`/api/media/${showId}`)).send({ rootFolderId: from.id });
    expect(moves.status).toBe(200);
    const res = await authed(request(app).patch(`/api/media/${showId}`)).send({ rootFolderId: to.id, moveFiles: true });

    expect(res.status).toBe(200);
    expect(res.body.filesMoved.renamed).toHaveLength(1);
    const dest = path.join(to.path, "Show", "Season 01", "Show - S01E01 - Pilot.mkv");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(((await db.prepare("SELECT file_path FROM episodes WHERE id = ?").get(epId)) as any).file_path).toBe(dest);
  });
});

describe("the explicit folder move (MM11)", () => {
  it("moves the show's folder through the route, and answers 409 when something is in the way", async () => {
    const r = await root("shows");
    const showId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, library_folder, monitored, has_file, status) VALUES ('series', 'Renamed', 'renamed', ?, 'Original', 1, 0, 'missing')").run(r.id)).lastInsertRowid
    );
    fs.mkdirSync(path.join(r.path, "Original"));
    fs.mkdirSync(path.join(r.path, "Taken"));

    const taken = await authed(request(app).post(`/api/media/${showId}/move-folder`)).send({ name: "Taken" });
    expect(taken.status).toBe(409);

    const ok = await authed(request(app).post(`/api/media/${showId}/move-folder`)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.to).toBe(path.join(r.path, "Renamed"));
    expect(fs.existsSync(path.join(r.path, "Renamed"))).toBe(true);
  });
});

describe("the manual import's preview (MM26)", () => {
  it("lists the warnings for each file, and an error for a file that is not there", async () => {
    const r = await root("films", "movie");
    const movieId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('movie', 'Film', 'film', 2020, ?, 1, 0, 'missing')").run(r.id)).lastInsertRowid
    );
    const dl = path.join(tmp, "dl");
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, "Film.2020.1080p.mkv"), "x");
    fs.writeFileSync(path.join(dl, "trap.exe"), "x");

    const res = await authed(request(app).post("/api/import/manual/preview")).send({
      mediaItemId: movieId,
      files: [{ sourcePath: path.join(dl, "Film.2020.1080p.mkv") }, { sourcePath: path.join(dl, "missing.mkv") }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].warnings.join(" ")).toMatch(/trap\.exe/);
    expect(res.body.results[1].error).toMatch(/not found/);
  });

  it("imports with the mode asked for: a copy leaves the original", async () => {
    const r = await root("films2", "movie");
    const movieId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('movie', 'Film', 'film', 2020, ?, 1, 0, 'missing')").run(r.id)).lastInsertRowid
    );
    const src = path.join(tmp, "keepers", "Film.2020.mkv");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "payload");

    const res = await authed(request(app).post("/api/import/manual")).send({ mediaItemId: movieId, sourcePath: src, mode: "copy" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(res.body.destPath, "utf-8")).toBe("payload");
  });
});

describe("what the review found in the routes (R25-07, R25-10, R25-13)", () => {
  it("leaves out a template of the settings import that cannot work, as saving it by hand would refuse it", async () => {
    const res = await authed(request(app).post("/api/settings/template/import")).send({
      namingTemplates: { namingSeriesTemplate: "{foo}/{bar}", namingMovieTemplate: "{title} ({year})", namingColonReplacement: "banana" },
    });

    expect(res.status).toBe(200);
    expect(res.body.namingImported).toBe(1);
    const { getSetting } = await import("../src/services/settingsStore.js");
    expect(getSetting("namingSeriesTemplate")).not.toBe("{foo}/{bar}");
    expect(getSetting("namingColonReplacement")).not.toBe("banana");
  });

  it("answers 400 for a mode that is not a strategy, instead of moving the file", async () => {
    const r = await root("modes", "movie");
    const movieId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('movie', 'Film', 'film', 2020, ?, 1, 0, 'missing')").run(r.id)).lastInsertRowid
    );
    const src = path.join(tmp, "dl2", "Film.2020.mkv");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "x");

    const res = await authed(request(app).post("/api/import/manual")).send({ mediaItemId: movieId, sourcePath: src, mode: "Copy" });

    expect(res.status).toBe(400);
    expect(fs.existsSync(src)).toBe(true);
  });

  it("refuses moveFiles for an artist and changes nothing", async () => {
    const from = await root("music-a", "artist");
    const to = await root("music-b", "artist");
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('artist', 'Artist', 'artist', ?, 1, 0, 'missing')").run(from.id)).lastInsertRowid
    );

    const res = await authed(request(app).patch(`/api/media/${id}`)).send({ rootFolderId: to.id, moveFiles: true });

    expect(res.status).toBe(409);
    expect(((await db.prepare("SELECT root_folder_id FROM media_items WHERE id = ?").get(id)) as any).root_folder_id).toBe(from.id);
  });
});
