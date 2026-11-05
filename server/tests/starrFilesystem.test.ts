import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * GET /filesystem of the Starr mounts (the folder pickers of Bazarr and of Starr itself) lists folders, and file names and sizes on
 * request. It is confined to the places AoNarr uses: the root folders, the downloads folder, the local side of a remote path
 * mapping, a Blackhole client's watch folder and the scanPathAllowList. Above them it names only the way down.
 */
let app: Express;
let apiKey: string;
let downloads: string;
let tree: string;
let movies: string;
let mapped: string;
let watch: string;
let allow: string;
let secret: string;
let linksOut = false;

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const list = (folder: string, query = "") => get(`/radarr/api/v3/filesystem?path=${encodeURIComponent(folder)}${query}`);
const names = (res: request.Response) => (res.body.directories as { name: string }[]).map((d) => d.name);
const firstSegment = (p: string) => path.relative(path.parse(p).root, p).split(path.sep)[0];

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  const { db } = await import("../src/db/index.js");
  const { config } = await import("../src/config.js");
  const { setSetting } = await import("../src/services/settingsStore.js");
  downloads = config.downloadsDir;

  tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-picker-")));
  movies = path.join(tree, "movies");
  mapped = path.join(tree, "mapped");
  watch = path.join(tree, "watch");
  allow = path.join(tree, "allow");
  secret = path.join(tree, "secret");
  fs.mkdirSync(path.join(movies, "Film (2020)"), { recursive: true });
  fs.writeFileSync(path.join(movies, "Film (2020)", "Film.mkv"), "12345");
  fs.mkdirSync(path.join(mapped, "inner"), { recursive: true });
  fs.mkdirSync(watch);
  fs.mkdirSync(path.join(allow, "inner"), { recursive: true });
  fs.mkdirSync(path.join(downloads, "Release"), { recursive: true });
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "passwd.txt"), "hunter2");
  try {
    // A link inside an allowed folder that leaves it, and one that stays in it.
    fs.symlinkSync(secret, path.join(movies, "escape"), "dir");
    fs.symlinkSync(path.join(movies, "Film (2020)"), path.join(allow, "alias"), "dir");
    linksOut = true;
  } catch {
    // a platform that does not allow links: those tests skip
  }

  await db.prepare("DELETE FROM root_folders").run(); // the defaults the app seeds are other places
  await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(movies);
  const qbit = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port) VALUES ('Qbit', 'qbittorrent', 'qbittorrent.local', 8080)").run()).lastInsertRowid);
  await db.prepare("INSERT INTO download_clients (name, type, host, port) VALUES ('Hole', 'blackhole', ?, 0)").run(watch);
  await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/remote/', ?)").run(qbit, mapped);
  setSetting("scanPathAllowList", allow);
});

afterAll(() => {
  fs.rmSync(tree, { recursive: true, force: true });
});

describe("GET /filesystem lists the places AoNarr uses", () => {
  it("lists a root folder: its folders, and its files with their size on request", async () => {
    const res = await list(movies, "&includeFiles=true");
    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(tree);
    // The link that leaves the folder is not a folder to the listing (links are never followed).
    expect(names(res)).toEqual(["Film (2020)"]);
    const inner = await list(path.join(movies, "Film (2020)"), "&includeFiles=true");
    expect(inner.body.files).toEqual([{ type: "file", name: "Film.mkv", path: path.join(movies, "Film (2020)", "Film.mkv"), size: 5, lastModified: expect.any(String) }]);
  });

  it("lists the downloads folder, the local side of a remote path mapping, a watch folder and the allow list", async () => {
    expect(names(await list(downloads))).toContain("Release");
    expect(names(await list(mapped))).toEqual(["inner"]);
    expect(names(await list(watch))).toEqual([]);
    expect((await list(watch)).status).toBe(200);
    expect(names(await list(path.join(allow, "inner")))).toEqual([]);
    expect(names(await list(allow))).toContain("inner");
    // A trailing separator and a path that is not normalized name the same folder.
    expect(names(await list(`${mapped}${path.sep}`))).toEqual(["inner"]);
    expect(names(await list(path.join(mapped, "inner", "..")))).toEqual(["inner"]);
  });

  it("lists a folder that is missing under an allowed one as empty, as Starr does", async () => {
    const res = await list(path.join(movies, "nowhere"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ directories: [], files: [] });
  });
});

describe("GET /filesystem refuses everything else", () => {
  it("answers a Starr-shaped 400, and no name, for a folder outside the places AoNarr uses", async () => {
    for (const outside of [secret, "/etc", "/proc", `${movies}/../secret`, "relative/folder", path.join(secret, "nested")]) {
      const res = await list(outside, "&includeFiles=true");
      expect(res.status, outside).toBe(400);
      expect(res.body, outside).toEqual({ message: "path is not one AoNarr uses" });
    }
    // The same through the other mounts, which share the handler.
    expect((await get(`/sonarr/api/v3/filesystem?path=${encodeURIComponent(secret)}`)).status).toBe(400);
    expect((await get(`/lidarr/api/v1/filesystem?path=${encodeURIComponent(secret)}`)).status).toBe(400);
  });

  it("refuses a link inside an allowed folder that points outside it, and follows one that stays inside", async (ctx) => {
    if (!linksOut) return ctx.skip();
    const out = await list(path.join(movies, "escape"), "&includeFiles=true");
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).not.toContain("passwd");
    // Inside the allow list, a link to a root folder's subfolder leads to an allowed place.
    expect((await list(path.join(allow, "alias"), "&includeFiles=true")).status).toBe(200);
  });
});

describe("GET /filesystem above the allowed folders", () => {
  it("shows at / only the first folders of the way to an allowed folder, and no files", async () => {
    const wanted = [...new Set([downloads, movies, mapped, watch, allow].map(firstSegment))].sort((a, b) => a.localeCompare(b));
    for (const res of [await list("/", "&includeFiles=true"), await get("/radarr/api/v3/filesystem")]) {
      expect(res.status).toBe(200);
      expect(res.body.parent).toBeNull();
      expect(names(res)).toEqual(wanted);
      expect(res.body.files).toEqual([]);
      expect(names(res)).not.toContain("etc");
    }
  });

  it("shows, at each folder on the way, only the folders that lead to an allowed one", async () => {
    const res = await list(tree, "&includeFiles=true");
    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(path.dirname(tree));
    // secret is beside them but leads to nothing AoNarr uses.
    expect(names(res)).toEqual(["allow", "mapped", "movies", "watch"]);
    expect(res.body.files).toEqual([]);
    expect(res.body.directories[0]).toEqual({ type: "folder", name: "allow", path: path.join(tree, "allow") + path.sep, size: 0 });
    const bare = await list(tree, "&allowFoldersWithoutTrailingSlashes=true");
    expect(bare.body.directories[0].path).toBe(path.join(tree, "allow"));
  });

  it("does not take a sibling of an allowed folder for an ancestor", async () => {
    const res = await list(path.join(tree, "mov"));
    expect(res.status).toBe(400);
  });
});
