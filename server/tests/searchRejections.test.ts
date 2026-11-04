import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/indexerClient.js")>()),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
}));

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["pending_releases", "history", "queue", "blocklist", "media_item_titles", "episodes", "sub_items", "media_items", "download_clients", "indexers", "delay_profiles"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  searchAllIndexers.mockReset().mockResolvedValue([]);
  getDownloadClientAdapter.mockReset().mockReturnValue({
    addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: url })),
    getStatus: vi.fn(async () => []),
  });
});

afterEach(() => {
  for (const key of ["usenetMinimumAgeMinutes", "seasonPackGuards", "seasonPackShare"]) setSetting(key, "");
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

function release(overrides: Record<string, unknown> = {}) {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title: "Movie.2020.1080p.WEB-DL-GRP",
    size: 5_000_000_000,
    seeders: 10,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: "magnet:?xt=urn:btih:abc",
    protocol: "torrent",
    category: null,
    ...overrides,
  };
}

async function insertItem(type: string, title: string, qualityProfileId: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES (?, ?, ?, 1, 0, 'missing', ?)")
        .run(type, title, title.toLowerCase(), qualityProfileId)
    ).lastInsertRowid
  );
}

async function insertClient(type = "qbittorrent"): Promise<void> {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, ?, 1)").run(`client-${type}`, type);
}

async function insertProfile(allowed: string[], cutoff: string, minFormatScore = 0): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score) VALUES (?, ?, ?, ?)").run(`P ${Math.random()}`, JSON.stringify(allowed), cutoff, minFormatScore))
      .lastInsertRowid
  );
}

async function search(itemId: number, query = "") {
  const res = await authed(request(app).get(`/api/search/${itemId}${query}`));
  expect(res.status).toBe(200);
  return res.body as any[];
}

describe("the list says every reason a release would not be taken (SR1, SR2)", () => {
  it("lists two reasons for a release that fails two checks, each permanent or temporary", async () => {
    await insertClient("sabnzbd");
    const profile = await insertProfile(["Bluray-1080p"], "Bluray-1080p");
    const movie = await insertItem("movie", "Movie", profile);
    setSetting("usenetMinimumAgeMinutes", "120");
    searchAllIndexers.mockResolvedValue([release({ title: "Movie.2020.720p.WEB-DL-GRP", protocol: "usenet", seeders: null, downloadUrl: "http://nzb/1" })]);

    const [row] = await search(movie);

    expect(row.rejections.map((r: any) => [r.code, r.type])).toEqual([["minimum-age", "temporary"], ["quality", "permanent"]]);
    expect(row.rejected).toBe(true);
    expect(row.approved).toBe(false);
    expect(row.temporarilyRejected).toBe(false);
    expect(row.rejectReason).toMatch(/isn't allowed by this quality profile/);
  });

  it("calls a release rejected only by a temporary reason temporarily rejected, not rejected", async () => {
    await insertClient("sabnzbd");
    const movie = await insertItem("movie", "Movie");
    setSetting("usenetMinimumAgeMinutes", "120");
    searchAllIndexers.mockResolvedValue([release({ protocol: "usenet", seeders: null, downloadUrl: "http://nzb/1" })]);

    const [row] = await search(movie);

    expect(row.rejections).toHaveLength(1);
    expect(row).toMatchObject({ temporarilyRejected: true, rejected: false, approved: false });
  });

  it("shows an indexer's minimum seeders, which the list used to ignore", async () => {
    await insertClient();
    const indexerId = Number((await db.prepare("INSERT INTO indexers (name, protocol, url, minimum_seeders) VALUES ('Strict', 'torznab', 'http://strict.invalid', 10)").run()).lastInsertRowid);
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockResolvedValue([release({ indexerId, seeders: 3 }), release({ indexerId, seeders: 50, title: "Movie.2020.1080p.WEB-DL-OTHER", downloadUrl: "magnet:?xt=urn:btih:def" })]);

    const rows = await search(movie);
    const dead = rows.find((r) => r.seeders === 3);
    const healthy = rows.find((r) => r.seeders === 50);

    expect(dead.rejections.map((r: any) => r.code)).toEqual(["seeders"]);
    expect(dead.rejectReason).toMatch(/fewer than its indexer's minimum of 10/);
    expect(healthy.approved).toBe(true);
    expect(healthy.wouldAutoGrab).toBe(true);
  });

  it("shows a score under the profile's minimum, and no download client for the protocol", async () => {
    await insertClient("qbittorrent");
    const profile = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p", 50);
    const movie = await insertItem("movie", "Movie", profile);
    searchAllIndexers.mockResolvedValue([
      release(),
      release({ title: "Movie.2020.1080p.WEB-DL-NZB", protocol: "usenet", seeders: null, downloadUrl: "http://nzb/2" }),
    ]);

    const rows = await search(movie);
    const torrent = rows.find((r) => r.protocol === "torrent");
    const usenet = rows.find((r) => r.protocol === "usenet");

    expect(torrent.rejections.map((r: any) => r.code)).toEqual(["minimum-score"]);
    expect(torrent.rejectReason).toMatch(/score \(0\) is below the profile's minimum \(50\)/);
    expect(usenet.downloadAllowed).toBe(false);
    expect(usenet.rejections.map((r: any) => r.code)).toContain("no-client");
  });

  it("shows a protocol the delay profile turns off", async () => {
    await insertClient("qbittorrent");
    await db.prepare("INSERT INTO delay_profiles (tag_id, enable_torrent, enable_usenet) VALUES (NULL, 0, 1)").run();
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockResolvedValue([release()]);

    const [row] = await search(movie);

    expect(row.rejections.map((r: any) => r.code)).toEqual(["protocol-off"]);
  });

  it("shows a blocklisted release and a release meant for another episode", async () => {
    await insertClient();
    const show = await insertItem("series", "Show");
    const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 1, 'Pilot', '2020-01-01', 1, 0)").run(show)).lastInsertRowid);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Show.S01E01.1080p.WEB-DL-BAD')").run(show);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Show.S01E01.1080p.WEB-DL-BAD", downloadUrl: "magnet:?xt=urn:btih:bad" }),
      release({ title: "Show.S01E02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:two" }),
    ]);

    const rows = await search(show, `?episodeId=${ep}`);

    expect(rows.find((r) => r.title.includes("BAD")).rejections.map((r: any) => r.code)).toContain("blocklisted");
    expect(rows.find((r) => r.title.includes("S01E02")).rejections.map((r: any) => r.code)).toContain("wrong-target");
    expect(rows.find((r) => r.title.includes("S01E02")).rejectReason).toBe("It is not for S01E01");
  });

  it("never marks the automatic pick as anything but approved (the list and the pick use the same checks)", async () => {
    await insertClient();
    const profile = await insertProfile(["WEBDL-1080p", "Bluray-1080p", "WEBDL-720p"], "Bluray-1080p");
    const movie = await insertItem("movie", "Movie", profile);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Movie.2020.1080p.WEB-DL-AAA", seeders: 2, downloadUrl: "magnet:?xt=urn:btih:a" }),
      release({ title: "Movie.2020.720p.WEB-DL-BBB", seeders: 99, downloadUrl: "magnet:?xt=urn:btih:b" }),
      release({ title: "Movie.2020.1080p.BluRay-CCC", seeders: 1, downloadUrl: "magnet:?xt=urn:btih:c" }),
      release({ title: "Movie.2020.SAMPLE.1080p-DDD", size: 30_000_000, downloadUrl: "magnet:?xt=urn:btih:d" }),
    ]);

    const rows = await search(movie);
    const picked = rows.filter((r) => r.wouldAutoGrab);

    expect(picked).toHaveLength(1);
    expect(picked[0].approved).toBe(true);
    expect(rows[0].wouldAutoGrab).toBe(true);
    expect(rows.find((r) => r.title.includes("SAMPLE")).rejected).toBe(true);
  });
});

describe("the list carries what a release is (SR4) and keeps the server's order (SR3)", () => {
  it("returns age, group, languages, packaging, flags, quality rank and position", async () => {
    await insertClient();
    const show = await insertItem("series", "Show");
    const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 1, 'Pilot', '2020-01-01', 1, 0)").run(show)).lastInsertRowid);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    searchAllIndexers.mockResolvedValue([
      release({ title: "Show.S01E01.GERMAN.1080p.WEB-DL-GRP", publishDate: twoHoursAgo, downloadVolumeFactor: 0, downloadUrl: "magnet:?xt=urn:btih:one" }),
      release({ title: "Show.S01.1080p.WEB-DL-PACK", downloadUrl: "magnet:?xt=urn:btih:pack", indexerTags: ["Internal"] }),
    ]);

    const rows = await search(show, `?episodeId=${ep}`);
    const single = rows.find((r) => r.title.includes("S01E01"));
    const pack = rows.find((r) => r.title.includes("PACK"));

    expect(single.ageMinutes).toBeGreaterThanOrEqual(119);
    expect(single).toMatchObject({ releaseGroup: "GRP", releaseType: "single", flags: ["freeleech"] });
    expect(single.languages).toContain("german");
    expect(pack).toMatchObject({ releaseType: "season-pack", flags: ["internal"] });
    expect(single.qualityRank).toBeGreaterThanOrEqual(0);
    expect(rows.map((r) => r.serverRank)).toEqual([1, 2]);
  });

  it("returns a null packaging for a type without episodes, and no age when the indexer gave no date", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockResolvedValue([release({ publishDate: null })]);

    const [row] = await search(movie);

    expect(row.releaseType).toBeNull();
    expect(row.ageMinutes).toBeNull();
  });
});

describe("the pick on a list is the one an automatic search makes (SR8)", () => {
  it("does not offer a full-season pack as the pick while an episode of its season has not aired", async () => {
    await insertClient();
    const show = await insertItem("series", "Show");
    const insertEpisode = async (n: number, airDate: string) =>
      Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, ?, ?, ?, 1, 0)").run(show, n, `E${n}`, airDate)).lastInsertRowid);
    const e1 = await insertEpisode(1, "2020-01-01");
    await insertEpisode(2, "2020-01-08");
    await insertEpisode(3, "2999-01-01");
    searchAllIndexers.mockResolvedValue([
      release({ title: "Show.S01.1080p.WEB-DL-PACK", size: 25_000_000_000, seeders: 200, downloadUrl: "magnet:?xt=urn:btih:pack" }),
      release({ title: "Show.S01E01.1080p.WEB-DL-GRP", seeders: 5, downloadUrl: "magnet:?xt=urn:btih:one" }),
    ]);

    const rows = await search(show, `?episodeId=${e1}`);
    const pack = rows.find((r) => r.title.includes("PACK"));
    const single = rows.find((r) => r.title.includes("S01E01"));

    expect(pack.wouldAutoGrab).toBe(false);
    expect(pack.rejections.map((r: any) => r.code)).toContain("season-pack");
    expect(pack.rejectReason).toMatch(/have not aired/);
    expect(pack.episodesCovered).toBe(3);
    expect(single.wouldAutoGrab).toBe(true);
  });
});

describe("which indexers answered (SR12)", () => {
  it("keeps the array answer by default and adds the indexers' outcomes with detail=1", async () => {
    await insertClient();
    const a = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Good', 'torznab', 'http://good.invalid')").run()).lastInsertRowid);
    const b = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Down', 'torznab', 'http://down.invalid')").run()).lastInsertRowid);
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockImplementation(async (_i: unknown, _q: unknown, _t: unknown, _b: unknown, _ids: unknown, hints: any) => {
      hints.onOutcome({ indexerId: a, indexerName: "Good", ok: true, count: 1 });
      hints.onOutcome({ indexerId: b, indexerName: "Down", ok: false, count: 0, error: "connect ECONNREFUSED" });
      return [release({ indexerId: a })];
    });

    const plain = await authed(request(app).get(`/api/search/${movie}`));
    const detail = await authed(request(app).get(`/api/search/${movie}?detail=1`));

    expect(Array.isArray(plain.body)).toBe(true);
    expect(detail.body.results).toHaveLength(1);
    expect(detail.body.indexers).toEqual([
      { id: a, name: "Good", ok: true, count: 1 },
      { id: b, name: "Down", ok: false, count: 0, error: "connect ECONNREFUSED" },
    ]);
  });

  it("hands the search an abort signal that stays quiet while the request is answered", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    let seen: AbortSignal | undefined;
    searchAllIndexers.mockImplementation(async (_i: unknown, _q: unknown, _t: unknown, _b: unknown, _ids: unknown, hints: any) => {
      seen = hints.signal;
      return [];
    });

    await search(movie);

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
  });
});

describe("the same release on two indexers (SR13)", () => {
  it("keeps the other indexers' links on the row", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockResolvedValue([
      release({ indexerName: "First", downloadUrl: "http://first/dl" }),
      release({ indexerName: "Second", indexerId: 7, downloadUrl: "http://second/dl", infoHash: "abc123" }),
    ]);

    const rows = await search(movie);

    expect(rows).toHaveLength(1);
    expect(rows[0].alsoOnIndexers).toEqual(["Second"]);
    expect(rows[0].alternates).toEqual([{ indexerId: 7, indexerName: "Second", downloadUrl: "http://second/dl", infoHash: "abc123" }]);
  });

  it("tries the next link when the first one is refused, and does not store the alternates", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    const secondIndexer = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Second', 'torznab', 'http://second.invalid')").run()).lastInsertRowid);
    const addDownload = vi.fn(async (_c: unknown, url: string) => {
      if (url === "http://first/dl") throw new Error("404 not found");
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue({ addDownload, getStatus: vi.fn(async () => []) });

    const res = await authed(request(app).post(`/api/search/${movie}/grab`)).send({
      title: "Movie.2020.1080p.WEB-DL-GRP",
      downloadUrl: "http://first/dl",
      protocol: "torrent",
      alternates: [{ indexerId: secondIndexer, indexerName: "Second", downloadUrl: "http://second/dl" }, { indexerId: 424242, downloadUrl: "http://third/dl" }],
    });

    expect(res.status).toBe(201);
    const queued = (await db.prepare("SELECT indexer_id FROM queue WHERE media_item_id = ?").get(movie)) as { indexer_id: number };
    expect(Number(queued.indexer_id)).toBe(secondIndexer);
    expect(addDownload.mock.calls.map((c) => c[1])).toEqual(["http://first/dl", "http://second/dl"]);
    const history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ?").get(movie)) as { data: string };
    expect(history.data).not.toContain("alternates");
  });

  it("answers 502 when every link is refused", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async () => {
        throw new Error("404 not found");
      }),
      getStatus: vi.fn(async () => []),
    });

    const res = await authed(request(app).post(`/api/search/${movie}/grab`)).send({
      title: "Movie.2020.1080p.WEB-DL-GRP",
      downloadUrl: "http://first/dl",
      protocol: "torrent",
      alternates: [{ downloadUrl: "http://second/dl" }],
    });

    expect(res.status).toBe(502);
  });
});

describe("a blocklisted release can be grabbed anyway (SR9)", () => {
  it("answers 409 without force and takes the release with it", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP')").run(movie);
    const body = { title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" };

    const refused = await authed(request(app).post(`/api/search/${movie}/grab`)).send(body);
    const forced = await authed(request(app).post(`/api/search/${movie}/grab`)).send({ ...body, force: true });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/blocklisted/);
    expect(forced.status).toBe(201);
  });
});

describe("what a manual grab leaves in the history (SR10)", () => {
  it("records how it was grabbed, the grade, the client and what it was for", async () => {
    await insertClient();
    const show = await insertItem("series", "Show");
    const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 1, 'Pilot', '2020-01-01', 1, 0)").run(show)).lastInsertRowid);

    const res = await authed(request(app).post(`/api/search/${show}/grab`)).send({
      title: "Show.S01E01.1080p.WEB-DL-GRP",
      downloadUrl: "magnet:?xt=urn:btih:x",
      protocol: "torrent",
      episodeId: ep,
      overrides: ["quality"],
    });

    expect(res.status).toBe(201);
    const row = (await db.prepare("SELECT data, episode_id, sub_item_id, season_number FROM history WHERE media_item_id = ?").get(show)) as any;
    const data = JSON.parse(row.data);
    expect(data).toMatchObject({ grabSource: "interactive", quality: "WEBDL-1080p", clientName: "client-qbittorrent", forced: true, releaseGroup: "GRP" });
    expect(Number(row.episode_id)).toBe(ep);
    expect(row.sub_item_id).toBeNull();
  });

  it("does not mark a grab 'forced' when nothing was overridden", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");

    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" }).expect(201);

    const row = (await db.prepare("SELECT data FROM history WHERE media_item_id = ?").get(movie)) as any;
    expect(JSON.parse(row.data).forced).toBeUndefined();
  });
});

describe("a season pack that is a later revision of what is on disk (SR7)", () => {
  it("accepts a same-quality PROPER pack and refuses the plain one, in the list a season search shows", async () => {
    await insertClient();
    const profile = await insertProfile(["WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    const show = await insertItem("series", "Show", profile);
    for (let n = 1; n <= 4; n++) {
      await db
        .prepare(
          "INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file, quality, file_release_title, file_format_score) VALUES (?, 1, ?, ?, '2020-01-01', 1, 1, 'WEBDL-1080p', ?, 0)"
        )
        .run(show, n, `E${n}`, `Show.S01E0${n}.1080p.WEB-DL-GRP`);
    }
    searchAllIndexers.mockResolvedValue([
      release({ title: "Show.S01.PROPER.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:proper" }),
      release({ title: "Show.S01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:plain" }),
    ]);

    const rows = await search(show, "?seasonNumber=1");
    const proper = rows.find((r) => r.title.includes("PROPER"));
    const plain = rows.find((r) => !r.title.includes("PROPER"));

    expect(proper.rejections.map((r: any) => r.code)).not.toContain("season-pack");
    expect(plain.rejections.map((r: any) => r.code)).toContain("season-pack");
    expect(plain.rejectReason).toMatch(/fill or upgrade none of the 4/);
  });
});

describe("the history feed and the queue show the new facts (SR10, DL12)", () => {
  it("tells on the history feed that a release was picked by hand, and whether it was forced", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ title: "Movie.2020.1080p.WEB-DL-AAA", downloadUrl: "magnet:?xt=urn:btih:a", protocol: "torrent" }).expect(201);
    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ title: "Movie.2020.720p.WEB-DL-BBB", downloadUrl: "magnet:?xt=urn:btih:b", protocol: "torrent", overrides: ["quality"] }).expect(201);

    const res = await authed(request(app).get("/api/activity/timeline"));

    const grabs = res.body.items.filter((e: any) => e.type === "grabbed");
    expect(grabs.map((e: any) => e.source)).toEqual(["interactive", "interactive"]);
    expect(grabs.filter((e: any) => e.forced)).toHaveLength(1);
    expect(grabs.find((e: any) => e.forced).detail).toContain("BBB");
  });

  it("returns what the client said about a download with the queue", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    await db
      .prepare("INSERT INTO queue (media_item_id, title, status, progress, eta_seconds, size_left, client_state, status_message) VALUES (?, 'Movie.2020.1080p-GRP', 'downloading', 0.4, 5400, 3000000000, 'paused', 'Paused or waiting its turn at the download client')")
      .run(movie);

    const res = await authed(request(app).get("/api/activity/queue"));

    expect(res.body.items[0]).toMatchObject({ etaSeconds: 5400, sizeLeft: 3_000_000_000, clientState: "paused", statusMessage: "Paused or waiting its turn at the download client" });
  });
});

describe("the list parses a release as the automatic search does", () => {
  it("approves the release an alias season makes the pick (a cour named by its own title)", async () => {
    await insertClient();
    const anime = await insertItem("anime", "Attack on Titan");
    for (let n = 1; n <= 25; n++) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, ?, ?, '2013-01-01', 1, 1)").run(anime, n, `S1E${n}`);
    }
    let episode5 = 0;
    for (let n = 1; n <= 12; n++) {
      const id = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 4, ?, ?, '2020-01-01', 1, 0)").run(anime, n, `E${n}`)).lastInsertRowid);
      if (n === 5) episode5 = id;
    }
    const { cleanTitle } = await import("../src/services/releaseAliases.js");
    const alias = "Shingeki no Kyojin The Final Season";
    await db.prepare("INSERT INTO media_item_titles (media_item_id, title, clean_title, source, season_number) VALUES (?, ?, ?, 'xem_alias', 4)").run(anime, alias, cleanTitle(alias));
    searchAllIndexers.mockResolvedValue([release({ title: "[Group] Shingeki no Kyojin The Final Season - 05 [1080p]", downloadUrl: "magnet:?xt=urn:btih:alias" })]);

    const [row] = await search(anime, `?episodeId=${episode5}`);

    expect(row).toMatchObject({ wouldAutoGrab: true, approved: true, matchesTarget: true });
    expect(row.rejections).toEqual([]);
  });

  it("does not hold a type with no quality tiers to the profile's minimum score", async () => {
    await insertClient();
    const profile = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p", 5);
    const artist = await insertItem("artist", "Some Artist", profile);
    const album = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Some Album', 1, 0)").run(artist)).lastInsertRowid);
    searchAllIndexers.mockResolvedValue([release({ title: "Some.Artist-Some.Album-2020-FLAC-GRP", size: 300_000_000, downloadUrl: "magnet:?xt=urn:btih:music" })]);

    const [row] = await search(artist, `?subItemId=${album}`);

    expect(row.rejections.map((r: any) => r.code)).not.toContain("minimum-score");
  });

  it("rejects a ROM release that names another game, which the automatic search would not take", async () => {
    await insertClient();
    const rom = await insertItem("rom", "Super Mario Bros");
    searchAllIndexers.mockResolvedValue([release({ title: "The.Legend.Of.Zelda.NES-GRP", size: 100_000, downloadUrl: "magnet:?xt=urn:btih:zelda" })]);

    const [row] = await search(rom);

    expect(row.wouldAutoGrab).toBe(false);
    expect(row.approved).toBe(false);
    expect(row.rejections.map((r: any) => r.code)).toContain("name");
  });

  it("lists only the indexers the search applied to, and a torrent is no copy of an NZB", async () => {
    await insertClient();
    const movieIndexer = Number((await db.prepare("INSERT INTO indexers (name, protocol, url, media_types) VALUES ('Movies', 'torznab', 'http://m.invalid', 'movie')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO indexers (name, protocol, url, media_types) VALUES ('MusicOnly', 'torznab', 'http://music.invalid', 'artist')").run();
    const movie = await insertItem("movie", "Movie");
    searchAllIndexers.mockResolvedValue([
      release({ indexerId: movieIndexer, downloadUrl: "magnet:?xt=urn:btih:t" }),
      release({ indexerId: movieIndexer, protocol: "usenet", seeders: null, downloadUrl: "http://nzb/1" }),
    ]);

    const res = await authed(request(app).get(`/api/search/${movie}?detail=1`));

    expect(res.body.indexers.map((i: any) => i.name)).toEqual(["Movies"]);
    expect(res.body.results).toHaveLength(2);
  });
});

describe("a manual grab does not trust ids it cannot place", () => {
  it("leaves out a stale indexer id instead of failing the queue row after the client took the download", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    const addDownload = vi.fn(async (_c: unknown, url: string) => ({ downloadId: url }));
    getDownloadClientAdapter.mockReturnValue({ addDownload, getStatus: vi.fn(async () => []) });
    await db
      .prepare("INSERT INTO pending_releases (media_item_id, leaf_table, leaf_id, release, pending_key) VALUES (?, 'media_items', ?, ?, 'k1')")
      .run(movie, movie, JSON.stringify(release({ indexerId: 9999, downloadUrl: "magnet:?xt=urn:btih:gone" })));
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as any).id);

    const res = await authed(request(app).post(`/api/activity/pending/${id}/grab`));

    expect(res.status).toBe(201);
    expect(addDownload).toHaveBeenCalledTimes(1);
    const queued = (await db.prepare("SELECT indexer_id FROM queue WHERE media_item_id = ?").get(movie)) as { indexer_id: number | null };
    expect(queued.indexer_id).toBeNull();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM pending_releases").get()) as any).c)).toBe(0);
  });

  it("forgets a held release whose episode is gone and sends nothing to the client", async () => {
    await insertClient();
    const show = await insertItem("series", "Show");
    const addDownload = vi.fn(async (_c: unknown, url: string) => ({ downloadId: url }));
    getDownloadClientAdapter.mockReturnValue({ addDownload, getStatus: vi.fn(async () => []) });
    await db
      .prepare("INSERT INTO pending_releases (media_item_id, leaf_table, leaf_id, release, pending_key) VALUES (?, 'episodes', 424242, ?, 'k2')")
      .run(show, JSON.stringify(release({ title: "Show.S01E01.1080p.WEB-DL-GRP" })));
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as any).id);

    const res = await authed(request(app).post(`/api/activity/pending/${id}/grab`));

    expect(res.status).toBe(404);
    expect(addDownload).not.toHaveBeenCalled();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM pending_releases").get()) as any).c)).toBe(0);
  });

  it("answers 404 for an episode that is not this item's, before the client is touched", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    const addDownload = vi.fn(async (_c: unknown, url: string) => ({ downloadId: url }));
    getDownloadClientAdapter.mockReturnValue({ addDownload, getStatus: vi.fn(async () => []) });

    const res = await authed(request(app).post(`/api/search/${movie}/grab`)).send({ title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent", episodeId: 777 });

    expect(res.status).toBe(404);
    expect(addDownload).not.toHaveBeenCalled();
  });
});

describe("the fallback links are held to the blocklist", () => {
  async function twoIndexers(movie: number) {
    const a = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('A', 'torznab', 'http://a.invalid')").run()).lastInsertRowid);
    const b = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('B', 'torznab', 'http://b.invalid')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, protocol, info_hash) VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP', ?, 'torrent', 'BBBB')").run(movie, b);
    const addDownload = vi.fn(async (_c: unknown, url: string) => {
      if (url === "http://a/dl") throw new Error("404 not found");
      return { downloadId: url };
    });
    getDownloadClientAdapter.mockReturnValue({ addDownload, getStatus: vi.fn(async () => []) });
    return {
      addDownload,
      body: {
        title: "Movie.2020.1080p.WEB-DL-GRP",
        downloadUrl: "http://a/dl",
        protocol: "torrent",
        indexerId: a,
        infoHash: "AAAA",
        alternates: [{ indexerId: b, indexerName: "B", downloadUrl: "http://b/dl", infoHash: "BBBB" }],
      },
    };
  }

  it("does not fall back to a copy whose torrent is blocklisted", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    const { addDownload, body } = await twoIndexers(movie);

    const res = await authed(request(app).post(`/api/search/${movie}/grab`)).send(body);

    expect(res.status).toBe(502);
    expect(addDownload.mock.calls.map((c) => c[1])).toEqual(["http://a/dl"]);
  });

  it("falls back to it when the admin overrides the blocklist", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    const { addDownload, body } = await twoIndexers(movie);

    const res = await authed(request(app).post(`/api/search/${movie}/grab`)).send({ ...body, overrides: ["blocklisted"] });

    expect(res.status).toBe(201);
    expect(addDownload.mock.calls.map((c) => c[1])).toEqual(["http://a/dl", "http://b/dl"]);
  });
});

describe("'forced' in the history means a rejection was overridden", () => {
  const forcedOf = async (movie: number) => {
    const rows = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? ORDER BY id").all(movie)) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data).forced);
  };

  it("records the blocklist as overridden by the codes the admin accepted, and a plain second grab as not forced (a duplicate is refused for good)", async () => {
    await insertClient();
    const movie = await insertItem("movie", "Movie");
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP')").run(movie);
    const body = { title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" };

    await authed(request(app).post(`/api/search/${movie}/grab`)).send(body).expect(409);
    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ ...body, overrides: ["blocklisted"] }).expect(201);
    expect(await forcedOf(movie)).toEqual([true]);

    // The same release a second time is refused whatever the admin confirms: `force` overrides rejections, not a duplicate.
    await db.prepare("DELETE FROM blocklist").run();
    const duplicate = await authed(request(app).post(`/api/search/${movie}/grab`)).send(body).expect(409);
    expect(duplicate.body.code).toBe("duplicate");
    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ ...body, force: true }).expect(409);
    // A different release for the same title is an ordinary grab: nothing was overridden.
    await authed(request(app).post(`/api/search/${movie}/grab`)).send({ title: "Movie.2020.720p.WEB-DL-OTHER", downloadUrl: "magnet:?xt=urn:btih:y", protocol: "torrent" }).expect(201);
    expect(await forcedOf(movie)).toEqual([true, undefined]);
  });
});
