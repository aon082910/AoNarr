import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let status: typeof import("../src/services/clientStatus.js");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-starr-"));

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  status = await import("../src/services/clientStatus.js");
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const send = (method: "post" | "put" | "delete", url: string, body?: unknown) => request(app)[method](url).set("X-Api-Key", apiKey).send(body as object);

async function insert(sql: string, ...params: unknown[]): Promise<number> {
  return Number((await db.prepare(sql).run(...params)).lastInsertRowid);
}

async function item(type: string, title: string, over: Record<string, unknown> = {}): Promise<number> {
  const row = { year: 2020, external_ids: "{}", monitored: 1, has_file: 0, path: null, release_date: null, quality: null, root_folder_id: null, ...over };
  return insert(
    "INSERT INTO media_items (type, title, sort_title, year, external_ids, monitored, has_file, path, release_date, quality, root_folder_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')",
    type,
    title,
    title.toLowerCase(),
    row.year,
    row.external_ids,
    row.monitored,
    row.has_file,
    row.path,
    row.release_date,
    row.quality,
    row.root_folder_id
  );
}

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "sub_items", "media_item_tags", "media_items", "root_folders", "indexers", "download_client_status", "download_clients", "tags", "blocklist"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  status.resetClientStatuses();
});

describe("the Starr surface: reaching it and logging in", () => {
  it("answers /ping without a key and names a Starr version in every response", async () => {
    const res = await request(app).get("/sonarr/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "OK" });
    expect(res.headers["x-application-version"]).toMatch(/^4\./);
    expect((await request(app).get("/radarr/ping")).headers["x-application-version"]).toMatch(/^5\./);
  });

  it("takes the key as a header, an apikey query parameter or a Bearer token, and nothing else", async () => {
    expect((await request(app).get("/sonarr/api/v3/system/status")).status).toBe(401);
    expect((await request(app).get("/sonarr/api/v3/system/status").set("X-Api-Key", "wrong")).status).toBe(401);
    expect((await request(app).get("/sonarr/api/v3/system/status").set("X-Api-Key", apiKey)).status).toBe(200);
    expect((await request(app).get(`/sonarr/api/v3/system/status?apikey=${apiKey}`)).status).toBe(200);
    expect((await request(app).get("/sonarr/api/v3/system/status").set("Authorization", `Bearer ${apiKey}`)).status).toBe(200);
  });

  it("does not open /health to everyone as the native API does", async () => {
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).get("/sonarr/api/v3/health")).status).toBe(401);
  });

  it("names the API version of each app and answers an unknown path as Starr does", async () => {
    expect((await get("/sonarr/api")).body).toEqual({ current: "v3", deprecated: [] });
    expect((await get("/lidarr/api")).body).toEqual({ current: "v1", deprecated: [] });
    const missing = await get("/sonarr/api/v3/nothing-here");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ message: "NotFound" });
    // The v1 apps do not answer under v3.
    expect((await get("/lidarr/api/v3/system/status")).status).toBe(404);
  });

  it("reports a status a tool can read", async () => {
    const res = await get("/sonarr/api/v3/system/status");
    expect(res.body).toMatchObject({ appName: "Sonarr", instanceName: "AoNarr", version: "4.0.9.2244", urlBase: "/sonarr", isProduction: true });
    expect((await get("/readarr/api/v1/system/status")).body).toMatchObject({ appName: "Readarr", urlBase: "/readarr" });
  });

  it("writes its own OpenAPI document from the routes it has", async () => {
    const doc = (await get("/radarr/api/v3/openapi.json")).body;
    expect(doc.paths["/api/v3/movie"].get).toBeDefined();
    expect(doc.paths["/api/v3/movie/{id}"].put).toBeDefined();
    expect(doc.paths["/api/v3/series"]).toBeUndefined();
    expect(doc.paths["/ping"]).toBeDefined();
  });
});

describe("shared settings as each app sees them", () => {
  it("lists only the root folders of the app's library types", async () => {
    await insert("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'series', 'TV')", folder);
    await insert("INSERT INTO root_folders (path, media_type, name) VALUES ('/nowhere/movies', 'movie', 'Movies')");
    const sonarr = (await get("/sonarr/api/v3/rootfolder")).body;
    expect(sonarr).toHaveLength(1);
    expect(sonarr[0]).toMatchObject({ path: folder, accessible: true, unmappedFolders: [] });
    expect(sonarr[0].totalSpace).toBeGreaterThan(0);
    const radarr = (await get("/radarr/api/v3/rootfolder")).body;
    expect(radarr).toHaveLength(1);
    expect(radarr[0]).toMatchObject({ path: "/nowhere/movies", accessible: false });
    expect((await get("/lidarr/api/v1/rootfolder")).body).toEqual([]);
    expect((await get(`/sonarr/api/v3/rootfolder/${radarr[0].id}`)).status).toBe(404);
  });

  it("lists, adds, renames and deletes tags, shared by every app", async () => {
    const created = await send("post", "/radarr/api/v3/tag", { label: "4k" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ label: "4k" });
    expect((await get("/sonarr/api/v3/tag")).body.map((t: any) => t.label)).toContain("4k");
    const renamed = await send("put", `/sonarr/api/v3/tag/${created.body.id}`, { label: "uhd" });
    expect(renamed.body).toMatchObject({ id: created.body.id, label: "uhd" });
    expect((await send("delete", `/sonarr/api/v3/tag/${created.body.id}`)).status).toBe(200);
    expect((await get(`/sonarr/api/v3/tag/${created.body.id}`)).status).toBe(404);
  });

  it("describes a quality profile as Starr does: a cutoff id and every quality with its allowed flag", async () => {
    const profiles = (await get("/radarr/api/v3/qualityprofile")).body;
    expect(profiles.length).toBeGreaterThan(0);
    const profile = profiles[0];
    expect(profile).toMatchObject({ name: expect.any(String), upgradeAllowed: expect.any(Boolean), cutoff: expect.any(Number) });
    expect(profile.items.length).toBeGreaterThan(5);
    expect(profile.items[0]).toMatchObject({ quality: { id: expect.any(Number), name: expect.any(String), source: expect.any(String), resolution: expect.any(Number) }, allowed: expect.any(Boolean) });
    expect(profile.language).toEqual({ id: -1, name: "Any" });
    expect((await get(`/sonarr/api/v3/qualityprofile/${profile.id}`)).body.id).toBe(profile.id);
    expect((await get("/sonarr/api/v3/qualityprofile/999999")).status).toBe(404);
  });

  it("has a language profile for Sonarr only, and metadata profiles for Lidarr and Readarr only", async () => {
    expect((await get("/sonarr/api/v3/languageprofile")).body).toEqual([expect.objectContaining({ id: 1, name: "Any" })]);
    expect((await get("/radarr/api/v3/languageprofile")).status).toBe(404);
    expect((await get("/radarr/api/v3/language")).body[0]).toMatchObject({ id: -1, name: "Any" });
    await insert("INSERT INTO metadata_profiles (name) VALUES ('Standard Test')");
    expect((await get("/lidarr/api/v1/metadataprofile")).body.some((p: any) => p.name === "Standard Test")).toBe(true);
    expect((await get("/readarr/api/v1/metadataprofile")).status).toBe(200);
    expect((await get("/sonarr/api/v3/metadataprofile")).status).toBe(404);
  });

  it("lists the download clients without their credentials", async () => {
    await insert("INSERT INTO download_clients (name, type, host, port, username, password, enabled) VALUES ('Seedbox', 'qbittorrent', 'sb.local', 8080, 'me', 'secret-pass', 1)");
    await insert("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Usenet', 'sabnzbd', 'sab.local', 8081, 1)");
    const clients = (await get("/sonarr/api/v3/downloadclient")).body;
    expect(clients.map((c: any) => [c.name, c.implementation, c.protocol])).toEqual([
      ["Seedbox", "QBittorrent", "torrent"],
      ["Usenet", "Sabnzbd", "usenet"],
    ]);
    expect(JSON.stringify(clients)).not.toMatch(/secret-pass|"me"/);
  });

  it("turns AoNarr's health issues into Starr's list", async () => {
    const health = (await get("/sonarr/api/v3/health")).body;
    expect(Array.isArray(health)).toBe(true);
    for (const issue of health) expect(issue).toMatchObject({ source: expect.any(String), type: expect.stringMatching(/^(error|warning)$/), message: expect.any(String) });
  });
});

describe("indexers pushed by Prowlarr", () => {
  const field = (name: string, value: unknown) => ({ name, value });
  const push = (over: Record<string, unknown> = {}) => ({
    name: "Tracker (Prowlarr)",
    implementation: "Torznab",
    configContract: "TorznabSettings",
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: false,
    priority: 10,
    tags: [],
    fields: [
      field("baseUrl", "http://127.0.0.1:9/7/"),
      field("apiPath", "/api"),
      field("apiKey", "prowlarr-key"),
      field("categories", [5030, 5040]),
      field("animeCategories", [5070]),
      field("minimumSeeders", 3),
      field("seedCriteria.seedRatio", 1.5),
      field("seedCriteria.seedTime", 4320),
    ],
    ...over,
  });

  it("describes the Newznab and Torznab settings in the schema", async () => {
    const schema = (await get("/sonarr/api/v3/indexer/schema")).body;
    expect(schema.map((s: any) => s.implementation)).toEqual(["Newznab", "Torznab"]);
    const torznab = schema.find((s: any) => s.implementation === "Torznab");
    expect(torznab.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(["baseUrl", "apiPath", "apiKey", "categories", "animeCategories", "minimumSeeders", "seedCriteria.seedRatio", "seedCriteria.seedTime", "seedCriteria.seasonPackSeedTime"]));
    expect(schema.find((s: any) => s.implementation === "Newznab").fields.map((f: any) => f.name)).not.toContain("minimumSeeders");
    expect((await get("/radarr/api/v3/indexer/schema")).body[1].fields.map((f: any) => f.name)).not.toContain("animeCategories");
  });

  it("adds an indexer, stores its settings as AoNarr's and lists it back as Starr's", async () => {
    const created = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    expect(created.status).toBe(201);
    const row = (await db.prepare("SELECT * FROM indexers WHERE id = ?").get(created.body.id)) as any;
    expect(row).toMatchObject({ name: "Tracker (Prowlarr)", protocol: "torznab", url: "http://127.0.0.1:9/7", priority: 10, minimum_seeders: 3, enable_interactive_search: 0, seed_ratio: 1.5, seed_time_minutes: 4320 });
    expect(row.categories.split(",").sort()).toEqual(["5030", "5040", "5070"]);
    expect(row.media_types.split(",")).toEqual(expect.arrayContaining(["series"]));
    expect(row.media_types).not.toMatch(/movie|artist/);

    const listed = (await get("/sonarr/api/v3/indexer")).body;
    expect(listed).toHaveLength(1);
    const fields = Object.fromEntries(listed[0].fields.map((f: any) => [f.name, f.value]));
    // What Prowlarr sent comes back as it sent it (it edits the indexer again when anything differs); the key is masked.
    expect(fields).toMatchObject({
      baseUrl: "http://127.0.0.1:9/7/",
      apiKey: "********",
      categories: [5030, 5040],
      animeCategories: [5070],
      minimumSeeders: 3,
      "seedCriteria.seedRatio": 1.5,
      "seedCriteria.seedTime": 4320,
    });
    expect(listed[0]).toMatchObject({ implementation: "Torznab", protocol: "torrent", enableInteractiveSearch: false, priority: 10 });
  });

  it("hands back exactly what each app pushed, so Prowlarr finds nothing to edit", async () => {
    const sonarrPush = push({
      fields: [
        field("baseUrl", "http://127.0.0.1:9/7/"),
        field("apiPath", "/api"),
        field("apiKey", "prowlarr-key"),
        field("categories", [5030, 5040]),
        field("animeCategories", [5070]),
        field("animeStandardFormatSearch", true),
        field("additionalParameters", "&extra=1"),
        field("minimumSeeders", 3),
        field("seedCriteria.seedRatio", 1.5),
        field("seedCriteria.seedTime", 4320),
        field("seedCriteria.seasonPackSeedTime", 10080),
        field("rejectBlocklistedTorrentHashesWhileGrabbing", true),
      ],
    });
    const created = await send("post", "/sonarr/api/v3/indexer?forceSave=true", sonarrPush);
    const radarrPush = push({
      fields: [field("baseUrl", "http://127.0.0.1:9/7/"), field("apiPath", "/api"), field("apiKey", "prowlarr-key"), field("categories", [2000, 2040]), field("minimumSeeders", 3), field("seedCriteria.seedRatio", 1.5), field("seedCriteria.seedTime", 4320)],
    });
    const second = await send("post", "/radarr/api/v3/indexer?forceSave=true", radarrPush);
    expect(second.body.id).toBe(created.body.id);

    // Each app reads its own push back, whichever was pushed first.
    const wanted = (resource: any) => Object.fromEntries(resource.fields.map((f: any) => [f.name, f.value]));
    const sonarr = wanted((await get("/sonarr/api/v3/indexer")).body[0]);
    expect(sonarr).toMatchObject({
      baseUrl: "http://127.0.0.1:9/7/",
      categories: [5030, 5040],
      animeCategories: [5070],
      animeStandardFormatSearch: true,
      additionalParameters: "&extra=1",
      "seedCriteria.seasonPackSeedTime": 10080,
      rejectBlocklistedTorrentHashesWhileGrabbing: true,
    });
    const radarr = wanted((await get("/radarr/api/v3/indexer")).body[0]);
    expect(radarr).toMatchObject({ categories: [2000, 2040] });
    expect(radarr.animeCategories).toBeUndefined();
    // The row itself serves both, each category once.
    const row = (await db.prepare("SELECT categories FROM indexers WHERE id = ?").get(created.body.id)) as any;
    expect(row.categories.split(",").sort()).toEqual(["2000", "2040", "5030", "5040", "5070"]);
  });

  it("does not reset the searches' back-off when a push repeats what the indexer already says", async () => {
    const created = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    const show = await item("series", "Backed Off");
    const episode = await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, auto_search_misses) VALUES (?, 1, 1, 1, 6)", show);
    const misses = async () => Number(((await db.prepare("SELECT auto_search_misses FROM episodes WHERE id = ?").get(episode)) as any).auto_search_misses);

    // Prowlarr sends the indexer back as it read it, with the key masked.
    const echoed = (await get("/sonarr/api/v3/indexer")).body[0];
    const again = await send("put", `/sonarr/api/v3/indexer/${created.body.id}?forceSave=true`, echoed);
    expect(again.status).toBe(200);
    expect(await misses()).toBe(6);
    const row = (await db.prepare("SELECT api_key, categories FROM indexers WHERE id = ?").get(created.body.id)) as any;
    expect(row.api_key).not.toContain("********");
    expect(row.categories.split(",").sort()).toEqual(["5030", "5040", "5070"]);

    // A real change does reset it: a new indexer setting can find what the others could not.
    await send("put", `/sonarr/api/v3/indexer/${created.body.id}?forceSave=true`, { ...echoed, priority: 33 });
    expect(await misses()).toBe(0);
  });

  it("keeps the real key when Prowlarr sends the masked one back", async () => {
    const created = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    const echoed = (await get("/sonarr/api/v3/indexer")).body[0];
    expect(echoed.fields.find((f: any) => f.name === "apiKey").value).toBe("********");
    await send("put", `/sonarr/api/v3/indexer/${created.body.id}?forceSave=true`, echoed);
    const stored = (await db.prepare("SELECT api_key FROM indexers WHERE id = ?").get(created.body.id)) as any;
    const { decryptValue } = await import("../src/services/encryption.js");
    expect(decryptValue(stored.api_key)).toBe("prowlarr-key");
  });

  it("does not take over an indexer the admin added or AoNarr pulled, and does not delete one when the push goes", async () => {
    const mine = await insert("INSERT INTO indexers (name, protocol, url, api_key, media_types, priority, enabled) VALUES ('Mine', 'torznab', 'http://127.0.0.1:9/7', 'my-key', 'series', 5, 0)");
    const refused = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    expect(refused.status).toBe(400);
    expect(refused.body[0]).toMatchObject({ propertyName: "BaseUrl", errorMessage: expect.stringContaining('"Mine"') });
    const row = (await db.prepare("SELECT name, priority, enabled, config FROM indexers WHERE id = ?").get(mine)) as any;
    expect(row).toMatchObject({ name: "Mine", priority: 5, enabled: 0, config: null });
    // And what Prowlarr never pushed cannot be removed through the push.
    expect((await send("delete", `/sonarr/api/v3/indexer/${mine}`)).status).toBe(404);
    expect(await db.prepare("SELECT 1 FROM indexers WHERE id = ?").get(mine)).toBeDefined();
  });

  it("lists only what was pushed to that app, not the indexers the admin added or pulled", async () => {
    await insert("INSERT INTO indexers (name, protocol, url, media_types) VALUES ('Mine', 'torznab', 'http://mine.example/1', 'series')");
    await insert(`INSERT INTO indexers (name, protocol, url, media_types, config) VALUES ('Pulled', 'torznab', 'http://prowlarr.example/3', 'series', '{"prowlarrId":3}')`);
    expect((await get("/sonarr/api/v3/indexer")).body).toEqual([]);
    await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    expect((await get("/sonarr/api/v3/indexer")).body).toHaveLength(1);
    expect((await get("/radarr/api/v3/indexer")).body).toEqual([]);
  });

  it("serves the same indexer pushed to two apps from one row, and takes it back one app at a time", async () => {
    const first = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    const second = await send("post", "/radarr/api/v3/indexer?forceSave=true", push({ fields: push().fields.map((f) => (f.name === "categories" ? field("categories", [2000, 2040]) : f.name === "animeCategories" ? field("animeCategories", []) : f)) }));
    // Pushed second, the Radarr values did not replace what Sonarr reads.
    expect(Object.fromEntries((await get("/sonarr/api/v3/indexer")).body[0].fields.map((f: any) => [f.name, f.value])).categories).toEqual([5030, 5040]);
    expect(second.body.id).toBe(first.body.id);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM indexers").get()) as any).c)).toBe(1);
    const types = (((await db.prepare("SELECT media_types FROM indexers WHERE id = ?").get(first.body.id)) as any).media_types as string).split(",");
    expect(types).toEqual(expect.arrayContaining(["series", "movie"]));

    expect((await send("delete", `/radarr/api/v3/indexer/${first.body.id}`)).status).toBe(200);
    const left = (await db.prepare("SELECT media_types FROM indexers WHERE id = ?").get(first.body.id)) as any;
    expect(left.media_types).not.toMatch(/movie/);
    expect((await get("/radarr/api/v3/indexer")).body).toEqual([]);
    expect((await get("/sonarr/api/v3/indexer")).body).toHaveLength(1);

    expect((await send("delete", `/sonarr/api/v3/indexer/${first.body.id}`)).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM indexers WHERE id = ?").get(first.body.id)).toBeUndefined();
    expect((await send("delete", `/sonarr/api/v3/indexer/${first.body.id}`)).status).toBe(404);
  });

  it("edits an indexer and keeps the app's push through the edit", async () => {
    const created = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push());
    const edited = push({ name: "Renamed", priority: 40, fields: push().fields.map((f) => (f.name === "minimumSeeders" ? field("minimumSeeders", 8) : f)) });
    const res = await send("put", `/sonarr/api/v3/indexer/${created.body.id}?forceSave=true`, edited);
    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT name, priority, minimum_seeders, config FROM indexers WHERE id = ?").get(created.body.id)) as any;
    expect(row).toMatchObject({ name: "Renamed", priority: 40, minimum_seeders: 8 });
    expect(JSON.parse(row.config).starrApps).toEqual(["sonarr"]);
  });

  it("tests the indexer before it keeps it, and says which field is wrong", async () => {
    const refused = await send("post", "/sonarr/api/v3/indexer", push());
    expect(refused.status).toBe(400);
    expect(refused.body[0]).toMatchObject({ propertyName: "BaseUrl", errorMessage: expect.stringMatching(/Unable to connect to indexer/) });
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM indexers").get()) as any).c)).toBe(0);
    expect((await send("post", "/sonarr/api/v3/indexer/test", push())).status).toBe(400);
  });

  it("refuses an indexer kind and an address it cannot use", async () => {
    const kind = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push({ implementation: "Rarbg" }));
    expect(kind.status).toBe(400);
    expect(kind.body[0].propertyName).toBe("Implementation");
    const address = await send("post", "/sonarr/api/v3/indexer?forceSave=true", push({ fields: [field("baseUrl", "not a url"), field("apiPath", "/api"), field("apiKey", "k")] }));
    expect(address.body[0].propertyName).toBe("BaseUrl");
  });
});

describe("the library", () => {
  it("lists series with their seasons and statistics, and the episodes and files under them", async () => {
    const rootId = await insert("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')", folder);
    const id = await item("series", "Test Show", { external_ids: JSON.stringify({ tvdb: "81189", tmdb: "1396", imdb: "tt0903747" }), root_folder_id: rootId, path: path.join(folder, "Test Show") });
    const ep = (season: number, number: number, airDate: string, hasFile: number, filePath: string | null) =>
      insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file, file_path, quality, size_bytes) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", id, season, number, `Episode ${number}`, airDate, hasFile, filePath, hasFile ? "WEBDL-1080p" : null, hasFile ? 1000 : null);
    const e1 = await ep(1, 1, "2000-01-01", 1, path.join(folder, "Test Show", "S01E01.mkv"));
    await ep(1, 2, "2000-01-08", 0, null);
    await ep(2, 1, "2099-01-01", 0, null);

    const list = (await get("/sonarr/api/v3/series")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: "Test Show", tvdbId: 81189, tmdbId: 1396, imdbId: "tt0903747", titleSlug: "test-show", rootFolderPath: folder, monitored: true, seriesType: "standard" });
    expect(list[0].seasons.map((s: any) => s.seasonNumber)).toEqual([1, 2]);
    // Sonarr's EpisodeCount: a monitored episode that has aired, or one with a file. The 2099 one has not aired.
    expect(list[0].statistics).toMatchObject({ seasonCount: 2, episodeFileCount: 1, episodeCount: 2, totalEpisodeCount: 3, sizeOnDisk: 1000 });
    expect(list[0].seasons[0].statistics).toMatchObject({ episodeFileCount: 1, episodeCount: 2, percentOfEpisodes: 50 });
    expect(list[0].seasons[1].statistics).toMatchObject({ episodeCount: 0, totalEpisodeCount: 1, percentOfEpisodes: 100 });
    expect(list[0].nextAiring).toMatch(/^2099-01-01/);

    expect((await get("/sonarr/api/v3/series?tvdbId=81189")).body).toHaveLength(1);
    expect((await get("/sonarr/api/v3/series?tvdbId=1")).body).toHaveLength(0);
    expect((await get(`/sonarr/api/v3/series/${id}`)).body.id).toBe(id);
    // It is a Sonarr: no movie of the same id range, and no Radarr resources.
    expect((await get(`/radarr/api/v3/movie/${id}`)).status).toBe(404);

    const episodes = (await get(`/sonarr/api/v3/episode?seriesId=${id}`)).body;
    expect(episodes.map((e: any) => [e.seasonNumber, e.episodeNumber, e.hasFile])).toEqual([[1, 1, true], [1, 2, false], [2, 1, false]]);
    expect(episodes[0].episodeFileId).toBe(e1);
    expect(episodes[1].episodeFileId).toBe(0);
    expect((await get(`/sonarr/api/v3/episode?seriesId=${id}&seasonNumber=2`)).body).toHaveLength(1);
    expect((await get("/sonarr/api/v3/episode")).status).toBe(400);
    const withSeries = (await get(`/sonarr/api/v3/episode?seriesId=${id}&includeSeries=true&includeEpisodeFile=true`)).body;
    expect(withSeries[0].series.title).toBe("Test Show");
    expect(withSeries[0].episodeFile.path).toMatch(/S01E01\.mkv$/);

    const files = (await get(`/sonarr/api/v3/episodefile?seriesId=${id}`)).body;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: e1, seriesId: id, seasonNumber: 1, relativePath: "S01E01.mkv", size: 1000, quality: { quality: { name: "WEBDL-1080p", source: "web", resolution: 1080 } } });
    expect((await get(`/sonarr/api/v3/episodefile/${e1}`)).body.id).toBe(e1);
  });

  it("lists movies with the file, the release dates and a tmdb title slug", async () => {
    const rootId = await insert("INSERT INTO root_folders (path, media_type) VALUES ('/movies', 'movie')");
    const id = await item("movie", "Test Movie", { external_ids: JSON.stringify({ tmdb: "603", imdb: "tt0133093" }), root_folder_id: rootId, has_file: 1, path: "/movies/Test Movie (2020)/Test Movie.mkv", release_date: "2020-03-31", quality: "Bluray-1080p" });
    await item("movie", "Not Here", { monitored: 0 });
    const movies = (await get("/radarr/api/v3/movie")).body;
    expect(movies).toHaveLength(2);
    const movie = movies.find((m: any) => m.id === id);
    expect(movie).toMatchObject({ title: "Test Movie", tmdbId: 603, imdbId: "tt0133093", titleSlug: "603", hasFile: true, status: "released", isAvailable: true, folder: "Test Movie (2020)", path: "/movies/Test Movie (2020)", rootFolderPath: "/movies", monitored: true });
    expect(movie.inCinemas).toMatch(/^2020-03-31/);
    expect(movie.movieFile).toMatchObject({ movieId: id, relativePath: "Test Movie.mkv", path: "/movies/Test Movie (2020)/Test Movie.mkv", quality: { quality: { name: "Bluray-1080p", source: "bluray", resolution: 1080 } } });
    expect((await get("/radarr/api/v3/movie?tmdbId=603")).body).toHaveLength(1);
    expect((await get(`/radarr/api/v3/moviefile?movieId=${id}`)).body).toHaveLength(1);
    expect((await get("/radarr/api/v3/moviefile")).body).toHaveLength(1);
    expect((await get(`/radarr/api/v3/moviefile/${id}`)).body.movieId).toBe(id);
    expect((await get("/radarr/api/v3/movie/9999999")).status).toBe(404);
  });

  it("lists artists with albums and authors with books", async () => {
    const artist = await item("artist", "Test Artist", { external_ids: JSON.stringify({ musicbrainz: "mb-1" }) });
    const album = await insert("INSERT INTO sub_items (media_item_id, title, release_date, external_id, monitored, has_file, file_path, quality) VALUES (?, 'First Album', '2001-01-01', 'mb-a1', 1, 1, '/music/a/01.flac', 'FLAC')", artist);
    await insert("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, 'Second Album', '2002-01-01', 1, 0)", artist);
    const author = await item("author", "Test Author");
    const book = await insert("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'A Book', 1, 0)", author);

    const artists = (await get("/lidarr/api/v1/artist")).body;
    expect(artists[0]).toMatchObject({ artistName: "Test Artist", foreignArtistId: "mb-1", statistics: { albumCount: 2, trackFileCount: 1, totalTrackCount: 2, percentOfTracks: 50 } });
    expect((await get(`/lidarr/api/v1/album?artistId=${artist}`)).body.map((a: any) => a.title)).toEqual(["First Album", "Second Album"]);
    expect((await get(`/lidarr/api/v1/album/${album}`)).body).toMatchObject({ artistId: artist, foreignAlbumId: "mb-a1" });
    expect((await get(`/lidarr/api/v1/trackfile?artistId=${artist}`)).body[0]).toMatchObject({ albumId: album, path: "/music/a/01.flac", quality: { quality: { name: "FLAC" } } });
    expect((await get("/readarr/api/v1/author")).body[0]).toMatchObject({ authorName: "Test Author" });
    expect((await get(`/readarr/api/v1/book?authorId=${author}`)).body[0]).toMatchObject({ id: book, title: "A Book", authorId: author });
    expect((await get("/lidarr/api/v1/author")).status).toBe(404);
    const monitored = await send("put", "/lidarr/api/v1/album/monitor", { albumIds: [album], monitored: false });
    expect(monitored.body[0]).toMatchObject({ id: album, monitored: false });
  });

  it("changes monitoring and tags through PUT, and removes a title with DELETE", async () => {
    const id = await item("series", "Editable Show");
    await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored) VALUES (?, 1, 1, 1)", id);
    await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored) VALUES (?, 2, 1, 1)", id);
    const tag = (await send("post", "/sonarr/api/v3/tag", { label: "keep" })).body.id;
    const res = await send("put", `/sonarr/api/v3/series/${id}`, { id, monitored: false, tags: [tag], seasons: [{ seasonNumber: 2, monitored: false }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ monitored: false, tags: [tag] });
    expect(res.body.seasons.map((s: any) => [s.seasonNumber, s.monitored])).toEqual([[1, true], [2, false]]);
    // The id in the body, to the collection, as Overseerr sends it.
    const again = await send("put", "/sonarr/api/v3/series", { id, monitored: true, tags: [] });
    expect(again.body).toMatchObject({ monitored: true, tags: [] });
    expect((await send("delete", `/sonarr/api/v3/series/${id}`)).status).toBe(200);
    expect((await get(`/sonarr/api/v3/series/${id}`)).status).toBe(404);
  });
});

describe("queue, history, calendar and wanted", () => {
  async function seed() {
    const showId = await item("series", "Queue Show", { monitored: 1 });
    const epId = await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 1, 'Pilot', '2000-01-01', 1, 0)", showId);
    const movieId = await item("movie", "Queue Movie", { release_date: "2000-06-01" });
    const clientId = await insert("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Seedbox', 'qbittorrent', 'sb.local', 8080, 1)");
    const indexerId = await insert("INSERT INTO indexers (name, protocol, url) VALUES ('Tracker', 'torznab', 'http://t.example')");
    const q = (media: number, episode: number | null, title: string, st: string, extra: Record<string, unknown> = {}) =>
      insert(
        "INSERT INTO queue (media_item_id, episode_id, title, indexer_id, download_client_id, download_id, size, quality, status, progress, protocol, eta_seconds, size_left, client_state, status_message, import_skipped_reason, download_path) VALUES (?, ?, ?, ?, ?, ?, 1000, 'WEBDL-1080p', ?, ?, 'torrent', ?, ?, ?, ?, ?, ?)",
        media,
        episode,
        title,
        indexerId,
        clientId,
        `hash-${title}`,
        st,
        extra.progress ?? 0.25,
        extra.eta ?? 3725,
        extra.sizeLeft ?? 750,
        extra.clientState ?? null,
        extra.message ?? null,
        extra.skipped ?? null,
        extra.path ?? null
      );
    const downloading = await q(showId, epId, "Queue.Show.S01E01.1080p-GRP", "downloading");
    const movieDone = await q(movieId, null, "Queue.Movie.2000.1080p-GRP", "completed", { progress: 1, skipped: "A sample", path: "/dl/Queue.Movie" });
    return { showId, epId, movieId, clientId, indexerId, downloading, movieDone };
  }

  it("shows each app only its own downloads, in Starr's words", async () => {
    const s = await seed();
    const sonarr = (await get("/sonarr/api/v3/queue")).body;
    expect(sonarr).toMatchObject({ page: 1, pageSize: 10, totalRecords: 1 });
    expect(sonarr.records[0]).toMatchObject({
      id: s.downloading,
      seriesId: s.showId,
      episodeId: s.epId,
      title: "Queue.Show.S01E01.1080p-GRP",
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
      protocol: "torrent",
      downloadClient: "Seedbox",
      indexer: "Tracker",
      downloadId: "hash-Queue.Show.S01E01.1080p-GRP",
      size: 1000,
      sizeleft: 750,
      timeleft: "01:02:05",
    });
    expect(sonarr.records[0].estimatedCompletionTime).toBeDefined();
    const radarr = (await get("/radarr/api/v3/queue")).body.records[0];
    expect(radarr).toMatchObject({ movieId: s.movieId, status: "completed", trackedDownloadState: "importBlocked", trackedDownloadStatus: "warning", outputPath: "/dl/Queue.Movie" });
    expect(radarr.statusMessages[0].messages).toEqual(["A sample"]);
    expect((await get("/lidarr/api/v1/queue")).body.totalRecords).toBe(0);
  });

  it("shows a grab Throttlearr is holding as queued with a Held message, and not as a problem", async () => {
    const s = await seed();
    await db
      .prepare("UPDATE queue SET status = 'queued', download_id = NULL, progress = 0, eta_seconds = NULL, size_left = NULL, gate_state = 'held', gate_reason = 'Seedbox has 3 of 3 jobs' WHERE id = ?")
      .run(s.downloading);
    const record = (await get("/sonarr/api/v3/queue")).body.records[0];
    expect(record).toMatchObject({ id: s.downloading, status: "queued", trackedDownloadStatus: "ok", trackedDownloadState: "downloading", sizeleft: 1000 });
    expect(record.statusMessages[0].messages).toEqual(["Held: Seedbox has 3 of 3 jobs"]);
    expect(record.downloadId).toBeUndefined();
    expect(record.timeleft).toBeUndefined();
    expect((await get("/sonarr/api/v3/queue/status")).body).toMatchObject({ errors: false, warnings: false });
  });

  it("pages the queue, embeds the title and part on request, and counts it", async () => {
    const s = await seed();
    const embedded = (await get("/sonarr/api/v3/queue?includeSeries=true&includeEpisode=true")).body.records[0];
    expect(embedded.series.title).toBe("Queue Show");
    expect(embedded.episode).toMatchObject({ id: s.epId, title: "Pilot" });
    expect((await get("/sonarr/api/v3/queue/status")).body).toMatchObject({ totalCount: 1, count: 1, errors: false, warnings: false });
    expect((await get("/radarr/api/v3/queue/status")).body).toMatchObject({ totalCount: 1, warnings: true });
    expect((await get("/sonarr/api/v3/queue/details")).body).toHaveLength(1);
    expect((await get(`/sonarr/api/v3/queue/details?seriesId=${s.showId + 99}`)).body).toHaveLength(0);
  });

  it("removes a download from the queue with the flags Starr sends, and not one of another app", async () => {
    const s = await seed();
    expect((await send("delete", `/radarr/api/v3/queue/${s.downloading}?removeFromClient=false`)).status).toBe(404);
    const res = await send("delete", `/sonarr/api/v3/queue/${s.downloading}?removeFromClient=false&blocklist=true&skipRedownload=true`);
    expect(res.status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(s.downloading)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(1);
    const bulk = await send("delete", "/radarr/api/v3/queue/bulk?removeFromClient=false", { ids: [s.movieDone] });
    expect(bulk.status).toBe(200);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM queue").get()) as any).c)).toBe(0);
  });

  it("reports a failed download as an error", async () => {
    const s = await seed();
    await db.prepare("UPDATE queue SET status = 'failed', status_message = 'Out of space' WHERE id = ?").run(s.downloading);
    const record = (await get("/sonarr/api/v3/queue")).body.records[0];
    expect(record).toMatchObject({ status: "failed", trackedDownloadStatus: "error", trackedDownloadState: "failed", errorMessage: "Out of space" });
    expect((await get("/sonarr/api/v3/queue/status")).body.errors).toBe(true);
  });

  it("names history events as each app does, without the release's link", async () => {
    const s = await seed();
    const h = (event: string, data: unknown, episode: number | null = null) =>
      insert("INSERT INTO history (media_item_id, event_type, data, episode_id, created_at) VALUES (?, ?, ?, ?, ?)", s.showId, event, JSON.stringify(data), episode, "2024-05-01 10:00:00");
    await h("grabbed", { releaseTitle: "Queue.Show.S01E01.1080p-GRP", downloadId: "hash-1", quality: "WEBDL-1080p", size: 1000, downloadUrl: "https://idx/dl?apikey=SECRET", indexerName: "Tracker" }, s.epId);
    await h("imported", { releaseTitle: "Queue.Show.S01E01.1080p-GRP", downloadId: "hash-1", path: "/tv/Queue Show/S01E01.mkv" }, s.epId);
    await h("failed", { releaseTitle: "Other" });
    await h("deleted", { label: "gone" });
    await h("subtitleDownloaded", {});
    const page = (await get("/sonarr/api/v3/history")).body;
    expect(page.totalRecords).toBe(4);
    expect(page.records.map((r: any) => r.eventType).sort()).toEqual(["downloadFailed", "downloadFolderImported", "episodeFileDeleted", "grabbed"]);
    const grabbed = page.records.find((r: any) => r.eventType === "grabbed");
    expect(grabbed).toMatchObject({ seriesId: s.showId, episodeId: s.epId, sourceTitle: "Queue.Show.S01E01.1080p-GRP", downloadId: "hash-1", date: "2024-05-01T10:00:00.000Z", data: { indexer: "Tracker", size: "1000" }, quality: { quality: { name: "WEBDL-1080p" } } });
    expect(JSON.stringify(page)).not.toMatch(/SECRET|apikey/);
    expect((await get("/sonarr/api/v3/history?eventType=grabbed")).body.totalRecords).toBe(1);
    expect((await get("/sonarr/api/v3/history?eventType=3")).body.records[0].eventType).toBe("downloadFolderImported");
    expect((await get("/sonarr/api/v3/history?downloadId=hash-1")).body.totalRecords).toBe(2);
    expect((await get("/sonarr/api/v3/history?pageSize=2&page=2&sortDirection=ascending")).body.records).toHaveLength(2);
    expect((await get("/radarr/api/v3/history")).body.totalRecords).toBe(0);
    expect((await get("/sonarr/api/v3/history/since?date=2024-04-01")).body).toHaveLength(4);
    expect((await get("/sonarr/api/v3/history/since?date=2025-01-01")).body).toHaveLength(0);
    expect((await get(`/sonarr/api/v3/history/series?seriesId=${s.showId}&eventType=grabbed`)).body).toHaveLength(1);
  });

  it("filters history by the plural and the singular spellings Starr clients send, and by each app's own event numbers", async () => {
    const s = await seed();
    const other = await item("series", "Other Show");
    await insert("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', ?, '2024-05-01 10:00:00')", s.showId, JSON.stringify({ releaseTitle: "A", downloadId: "abc%def" }));
    await insert("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', ?, '2024-05-01 10:00:00')", other, JSON.stringify({ releaseTitle: "B", downloadId: "abcXdef" }));
    const movie = await insert("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'renamed', ?, '2024-05-01 10:00:00')", s.movieId, JSON.stringify({ label: "m" }));
    expect((await get("/sonarr/api/v3/history")).body.totalRecords).toBe(2);
    expect((await get(`/sonarr/api/v3/history?seriesIds=${s.showId}`)).body.totalRecords).toBe(1);
    expect((await get(`/sonarr/api/v3/history?seriesId=${s.showId}`)).body.totalRecords).toBe(1);
    expect((await get(`/sonarr/api/v3/history?seriesIds=${other}&seriesIds=${s.showId}`)).body.totalRecords).toBe(2);
    expect((await get(`/radarr/api/v3/history?movieIds=${s.movieId}`)).body.totalRecords).toBe(1);
    // A percent sign in a download id is a character of the id.
    expect((await get("/sonarr/api/v3/history?downloadId=abc%25def")).body.totalRecords).toBe(1);
    expect((await get("/sonarr/api/v3/history?downloadId=%25")).body.totalRecords).toBe(0);
    // Radarr's own numbers: movieFileRenamed is 8, and 6 is movieFileDeleted.
    expect((await get("/radarr/api/v3/history?eventType=8")).body.records.map((r: any) => r.id)).toEqual([movie]);
    expect((await get("/radarr/api/v3/history?eventType=6")).body.totalRecords).toBe(0);
  });

  it("answers an error in Starr's shape, and keeps an app's bulk delete and monitor calls to its own titles", async () => {
    const denied = await request(app).get("/sonarr/api/v3/queue");
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ message: "Invalid or missing credentials" });

    const s = await seed();
    // The series download is not Radarr's: the call stops before it removes anything.
    const bulk = await send("delete", "/radarr/api/v3/queue/bulk?removeFromClient=false", { ids: [s.movieDone, s.downloading] });
    expect(bulk.status).toBe(404);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM queue").get()) as any).c)).toBe(2);

    const author = await item("author", "An Author");
    const book = await insert("INSERT INTO sub_items (media_item_id, title, monitored) VALUES (?, 'A Book', 1)", author);
    const foreign = await send("put", "/lidarr/api/v1/album/monitor", { albumIds: [book], monitored: false });
    expect(foreign.body).toEqual([]);
    expect(Number(((await db.prepare("SELECT monitored FROM sub_items WHERE id = ?").get(book)) as any).monitored)).toBe(1);
  });

  it("lists what airs or releases in a range, per app", async () => {
    const s = await seed();
    await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 2, 'Later', '2000-01-08', 1, 0)", s.showId);
    const sonarr = (await get("/sonarr/api/v3/calendar?start=2000-01-01&end=2000-01-05&includeSeries=true")).body;
    expect(sonarr.map((e: any) => e.title)).toEqual(["Pilot"]);
    expect(sonarr[0].series.title).toBe("Queue Show");
    expect((await get("/radarr/api/v3/calendar?start=2000-05-01&end=2000-07-01")).body.map((m: any) => m.title)).toEqual(["Queue Movie"]);
    expect((await get("/radarr/api/v3/calendar?start=2001-05-01&end=2001-07-01")).body).toEqual([]);
  });

  it("pages what is missing, and what is below its cutoff", async () => {
    const s = await seed();
    const missing = (await get("/sonarr/api/v3/wanted/missing?pageSize=5&includeSeries=true")).body;
    expect(missing).toMatchObject({ page: 1, pageSize: 5, totalRecords: 1 });
    expect(missing.records[0]).toMatchObject({ id: s.epId, title: "Pilot", series: { title: "Queue Show" } });
    expect((await get("/radarr/api/v3/wanted/missing")).body.records.map((m: any) => m.title)).toEqual(["Queue Movie"]);
    expect((await get("/lidarr/api/v1/wanted/missing")).body.totalRecords).toBe(0);
    expect((await get("/sonarr/api/v3/wanted/cutoff")).body).toMatchObject({ totalRecords: 0, records: [] });
    await db.prepare("UPDATE media_items SET monitored = 0 WHERE id = ?").run(s.showId);
    expect((await get("/sonarr/api/v3/wanted/missing")).body.totalRecords).toBe(0);
  });
});

describe("commands", () => {
  it("refuses a command it does not run and a title it does not have", async () => {
    expect((await send("post", "/sonarr/api/v3/command", { name: "Nonsense" })).status).toBe(400);
    // A name that only exists on every JavaScript object is not a command.
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect((await send("post", "/sonarr/api/v3/command", { name })).status, name).toBe(400);
    }
    expect((await get("/sonarr/api/v3/command")).body.some((c: any) => c.name === "toString")).toBe(false);
    expect((await send("post", "/sonarr/api/v3/command", {})).status).toBe(400);
    const missing = await send("post", "/sonarr/api/v3/command", { name: "SeriesSearch", seriesId: 999999 });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("NotFound");
  });

  it("runs a search and keeps its record", async () => {
    const id = await item("series", "Searched Show");
    const res = await send("post", "/sonarr/api/v3/command", { name: "SeriesSearch", seriesId: id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "SeriesSearch", commandName: "Series Search", status: expect.stringMatching(/^(started|completed)$/), body: expect.objectContaining({ seriesId: id }) });
    const listed = (await get("/sonarr/api/v3/command")).body;
    expect(listed.some((c: any) => c.id === res.body.id)).toBe(true);
    expect((await get(`/sonarr/api/v3/command/${res.body.id}`)).body.name).toBe("SeriesSearch");
    // A command belongs to the app that ran it.
    expect((await get(`/radarr/api/v3/command/${res.body.id}`)).status).toBe(404);
  });

  it("searches a movie only for the Radarr that has it", async () => {
    const movie = await item("movie", "Searched Movie");
    expect((await send("post", "/sonarr/api/v3/command", { name: "MoviesSearch", movieIds: [movie] })).status).toBe(400);
    expect((await send("post", "/radarr/api/v3/command", { name: "MoviesSearch", movieIds: [movie] })).status).toBe(201);
    expect((await send("post", "/radarr/api/v3/command", { name: "MoviesSearch", movieIds: [movie + 5000] })).status).toBe(404);
  });
});

describe("only /ping is open", () => {
  it("answers 401 to every route the surface has when no key is sent", async () => {
    const { STARR_ROUTE_DOCS } = await import("../src/starr/routeDocs.js");
    expect(STARR_ROUTE_DOCS.size).toBeGreaterThan(60);
    for (const doc of STARR_ROUTE_DOCS.values()) {
      for (const appKey of doc.apps) {
        const version = appKey === "lidarr" || appKey === "readarr" ? "v1" : "v3";
        const url = `/${appKey}/api/${version}${doc.path.replace(/:[A-Za-z]+/g, "1")}`;
        const res = await request(app)[doc.method](url).send({});
        expect(res.status, `${doc.method.toUpperCase()} ${url}`).toBe(401);
      }
    }
  });
});

describe("nginx forwards the four mounts", () => {
  it("lists them in both bundled configs", () => {
    for (const file of ["combined/nginx.conf", "web/nginx.conf.template"]) {
      const text = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", file), "utf-8");
      expect(text, file).toMatch(/^\s*location ~ \^\/\(sonarr\|radarr\|lidarr\|readarr\)\/\(api\|ping\)\(\/\|\$\) \{\s*\n?\s*access_log \S+ aonarr_starr;/m);
      // The log format names the path, not the request line that carries the query string.
      expect(text, file).toMatch(/^log_format aonarr_starr '[^']*\$uri[^']*';/m);
      expect(text, file).not.toMatch(/^log_format aonarr_starr '[^']*\$(request|args|query_string)\b/m);
    }
  });
});

