import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * Round 30g, group 4: what a live run of Prowlarr 2.7.0.5723 and Bazarr 1.6.2 against AoNarr's Starr-compatible layer found.
 * The Prowlarr request bodies in fixtures/prowlarr-2.7-push.json were captured from that run.
 */

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let syncFromProwlarr: (typeof import("../src/services/prowlarrSync.js"))["syncFromProwlarr"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

const fixtures = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "prowlarr-2.7-push.json"), "utf8"));

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ syncFromProwlarr } = await import("../src/services/prowlarrSync.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const send = (method: "post" | "put" | "delete", url: string, body?: unknown) => request(app)[method](url).set("X-Api-Key", apiKey).send(body as object);

async function insert(sql: string, ...params: unknown[]): Promise<number> {
  return Number((await db.prepare(sql).run(...params)).lastInsertRowid);
}

beforeEach(async () => {
  for (const t of ["episodes", "sub_items", "media_item_tags", "media_items", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const wanted = (resource: any) => Object.fromEntries(resource.fields.map((f: any) => [f.name, f.value]));

describe("Prowlarr 2.7 pushing an indexer (request bodies as captured)", () => {
  const cases: [string, string, string][] = [
    ["sonarrNewznab", "sonarr", "v3"],
    ["radarrNewznab", "radarr", "v3"],
    ["sonarrTorznab", "sonarr", "v3"],
    ["radarrTorznab", "radarr", "v3"],
    ["lidarrNewznab", "lidarr", "v1"],
    ["readarrNewznab", "readarr", "v1"],
  ];

  it.each(cases)("%s: the indexer is added and listed back with every field Prowlarr compares as it sent it", async (key, mount, version) => {
    const pushed = fixtures[key];
    const created = await send("post", `/${mount}/api/${version}/indexer?forceSave=true`, pushed);
    expect(created.status).toBe(201);

    const listed = (await get(`/${mount}/api/${version}/indexer`)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.body.id,
      name: pushed.name,
      implementation: pushed.implementation,
      configContract: pushed.configContract,
      enableRss: pushed.enableRss,
      enableAutomaticSearch: pushed.enableAutomaticSearch,
      enableInteractiveSearch: pushed.enableInteractiveSearch,
      priority: pushed.priority,
    });
    const back = wanted(listed[0]);
    for (const f of pushed.fields) {
      // The key is masked on the way out; Prowlarr accepts the mask as equal to its own.
      expect({ name: f.name, value: back[f.name] }).toEqual({ name: f.name, value: f.name === "apiKey" ? "********" : f.value });
    }
    // And the same through the single-indexer read Prowlarr makes for the mapped id.
    expect(wanted((await get(`/${mount}/api/${version}/indexer/${created.body.id}`)).body)).toEqual(back);
  });

  it("takes the Sonarr and Radarr push of one Prowlarr indexer as one row, each app reading back its own categories", async () => {
    const first = await send("post", "/sonarr/api/v3/indexer?forceSave=true", fixtures.sonarrNewznab);
    const second = await send("post", "/radarr/api/v3/indexer?forceSave=true", fixtures.radarrNewznab);
    expect(second.body.id).toBe(first.body.id);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM indexers").get()) as any).c)).toBe(1);
    expect(wanted((await get("/sonarr/api/v3/indexer")).body[0]).categories).toEqual([5000, 5030, 5040, 5045]);
    expect(wanted((await get("/radarr/api/v3/indexer")).body[0]).categories).toEqual([2000, 2040, 2045]);
  });

  it("does not let AoNarr's own pull from Prowlarr rename, re-key or re-type a pushed row", async () => {
    setSetting("prowlarrUrl", "http://aon30gg4-prowlarr:9696");
    setSetting("prowlarrApiKey", "prowlarr-own-key");
    // The fixture's address is Prowlarr's caps proxy for its indexer 1, which is also where the pull puts it.
    const pushed = await send("post", "/sonarr/api/v3/indexer?forceSave=true", fixtures.sonarrNewznab);
    const before = (await db.prepare("SELECT * FROM indexers WHERE id = ?").get(pushed.body.id)) as any;
    expect(before.name).toBe("StubNab (Prowlarr)");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 1, name: "StubNab", protocol: "usenet", enable: true, capabilities: { categories: [{ id: 5000, subCategories: [{ id: 5040 }] }] } },
          { id: 2, name: "Pulled only", protocol: "torrent", enable: true, capabilities: { categories: [{ id: 2000 }] } },
        ],
      })
    );
    const result = await syncFromProwlarr();

    // Prowlarr's push is left as it was: renaming it made Prowlarr edit it back at every sync, and the pull rename it again.
    const after = (await db.prepare("SELECT * FROM indexers WHERE id = ?").get(pushed.body.id)) as any;
    expect(after).toEqual(before);
    // An indexer only the pull knows is still pulled.
    expect(result).toEqual({ synced: 1 });
    const rows = (await db.prepare("SELECT name, url FROM indexers ORDER BY id").all()) as any[];
    expect(rows.map((r) => r.name)).toEqual(["StubNab (Prowlarr)", "Pulled only"]);
    // The pushed row also stays what the push surface reads back.
    expect((await get("/sonarr/api/v3/indexer")).body.map((i: any) => i.name)).toEqual(["StubNab (Prowlarr)"]);
  });
});

describe("the languages of a file, as Bazarr reads them", () => {
  const info = (...languages: (string | null)[]) => JSON.stringify({ videoCodec: "h264", audioCodec: "aac", audioStreams: languages.map((language) => ({ codec: "aac", language, channels: 2 })), subtitleStreams: [] });

  async function movie(title: string, mediaInfo: string | null): Promise<number> {
    return insert(
      "INSERT INTO media_items (type, title, sort_title, year, external_ids, monitored, has_file, path, quality, media_info, size_bytes, status) VALUES ('movie', ?, ?, 2020, '{}', 1, 1, ?, 'WEBDL-1080p', ?, 123459, 'unknown')",
      title,
      title.toLowerCase(),
      `/media/movies/${title}/${title}.mkv`,
      mediaInfo
    );
  }

  it("names the language of the audio track AoNarr probed, instead of English for every file", async () => {
    const id = await movie("Anime Film", info("jpn"));
    const file = (await get(`/radarr/api/v3/moviefile/${id}`)).body;
    expect(file.languages).toEqual([{ id: 8, name: "Japanese" }]);
    // The same list sits in the movie's embedded file.
    expect((await get(`/radarr/api/v3/movie/${id}`)).body.movieFile.languages).toEqual([{ id: 8, name: "Japanese" }]);
  });

  it("lists every language once, reads a bibliographic code, and skips tags that name no language", async () => {
    const id = await movie("Dubbed", info("eng", "fre", "eng", "und", "mul", null, "qqq"));
    expect((await get(`/radarr/api/v3/moviefile/${id}`)).body.languages).toEqual([
      { id: 1, name: "English" },
      { id: 2, name: "French" },
    ]);
  });

  it("keeps English for a file that is not probed yet or whose tracks carry no language", async () => {
    const unprobed = await movie("Unprobed", null);
    const untagged = await movie("Untagged", info(null, "und"));
    const none = await movie("Silent", JSON.stringify({ videoCodec: "h264", audioStreams: [] }));
    for (const id of [unprobed, untagged, none]) {
      expect((await get(`/radarr/api/v3/moviefile/${id}`)).body.languages).toEqual([{ id: 1, name: "English" }]);
    }
  });

  it("does the same for an episode's file, and gives a language Starr has no id for id 0", async () => {
    const series = await insert("INSERT INTO media_items (type, title, sort_title, year, external_ids, monitored, status) VALUES ('series', 'Show', 'show', 2020, '{}', 1, 'unknown')");
    await insert(
      "INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality, media_info, size_bytes) VALUES (?, 1, 1, 'One', 1, 1, '/media/tv/Show/S01E01.mkv', 'WEBDL-1080p', ?, 1000)",
      series,
      info("spa")
    );
    await insert(
      "INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality, media_info, size_bytes) VALUES (?, 1, 2, 'Two', 1, 1, '/media/tv/Show/S01E02.mkv', 'WEBDL-1080p', ?, 1000)",
      series,
      info("swa")
    );
    const files = (await get(`/sonarr/api/v3/episodefile?seriesId=${series}`)).body;
    expect(files.map((f: any) => f.languages)).toEqual([[{ id: 3, name: "Spanish" }], [{ id: 0, name: "Swahili" }]]);
  });
});

describe("the folder browser of a Starr app (Bazarr's path mapping and root folder pickers)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-fs-"));
  fs.mkdirSync(path.join(base, "a-dir"));
  fs.mkdirSync(path.join(base, "B-dir"));
  fs.mkdirSync(path.join(base, ".hidden"));
  fs.writeFileSync(path.join(base, "movie.mkv"), "12345");
  // The browser lists only places AoNarr uses (tests/starrFilesystem.test.ts); this folder is a root folder for these tests.
  beforeAll(async () => {
    await insert("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')", base);
  });

  it("lists the folders under a path, without hidden ones and without files unless asked", async () => {
    const res = await get(`/radarr/api/v3/filesystem?path=${encodeURIComponent(base)}&allowFoldersWithoutTrailingSlashes=true&includeFiles=false`);
    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(path.dirname(base));
    expect(res.body.directories).toEqual([
      { type: "folder", name: "a-dir", path: path.join(base, "a-dir"), size: 0 },
      { type: "folder", name: "B-dir", path: path.join(base, "B-dir"), size: 0 },
    ]);
    expect(res.body.files).toEqual([]);
  });

  it("ends a folder's path with a separator unless the caller allows folders without one", async () => {
    const res = await get(`/sonarr/api/v3/filesystem?path=${encodeURIComponent(base)}`);
    expect(res.body.directories.map((d: any) => d.path)).toEqual([path.join(base, "a-dir") + path.sep, path.join(base, "B-dir") + path.sep]);
  });

  it("adds the files, with their size, when includeFiles is true", async () => {
    const res = await get(`/lidarr/api/v1/filesystem?path=${encodeURIComponent(base)}&includeFiles=true`);
    expect(res.body.files).toEqual([{ type: "file", name: "movie.mkv", path: path.join(base, "movie.mkv"), size: 5, lastModified: expect.any(String) }]);
  });

  it("answers an empty listing for a path that is missing, and lists the top folder for no path", async () => {
    const missing = await get(`/radarr/api/v3/filesystem?path=${encodeURIComponent(path.join(base, "nowhere"))}`);
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ directories: [], files: [] });
    const top = await get("/radarr/api/v3/filesystem");
    expect(top.status).toBe(200);
    expect(top.body.parent).toBeNull();
  });

  it("is behind the key like the rest of the surface", async () => {
    expect((await request(app).get("/radarr/api/v3/filesystem?path=/")).status).toBe(401);
  });
});
