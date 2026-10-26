import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "sub_items", "media_items", "download_clients"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  searchAllIndexers.mockReset().mockResolvedValue([]);
  getDownloadClientAdapter.mockReset().mockReturnValue({
    addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: url })),
    getStatus: vi.fn(async () => []),
  });
});

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

async function insertTorrentClient(): Promise<void> {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run();
}

describe("GET /api/search/:mediaItemId", () => {
  it("marks a book release as allowed even when the author's profile only lists video tiers", async () => {
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)").run(`Video ${Math.random()}`, JSON.stringify(["WEBDL-1080p"]), "WEBDL-1080p"))
        .lastInsertRowid
    );
    const authorId = await insertItem("author", "Author", profileId);
    searchAllIndexers.mockResolvedValue([release({ title: "Author - Book (2010) [EPUB]" })]);

    const res = await request(app).get(`/api/search/${authorId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ parsedQuality: "Unknown", allowedByProfile: true, sizeAllowed: true });
  });

  it("doesn't fail a release whose size the indexer didn't report against its quality's minimum size", async () => {
    const { loadQualityCaches } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET min_size_mb = 1000 WHERE name = 'WEBDL-1080p'").run();
    await loadQualityCaches();
    try {
      const movieId = await insertItem("movie", "Movie");
      searchAllIndexers.mockResolvedValue([release({ size: 0 })]);

      const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body[0].sizeAllowed).toBe(true);
    } finally {
      await db.prepare("UPDATE qualities SET min_size_mb = NULL WHERE name = 'WEBDL-1080p'").run();
      await loadQualityCaches();
    }
  });
});

describe("GET /api/search/:mediaItemId — the order is what an automatic search would pick (D20)", () => {
  it("lists the release an automatic search would grab first, ahead of a better-seeded lower quality", async () => {
    await insertTorrentClient();
    const profileId = Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
          .run(`Pick ${Math.random()}`, JSON.stringify(["WEBDL-720p", "WEBDL-1080p"]), "WEBDL-1080p")
      ).lastInsertRowid
    );
    const movieId = await insertItem("movie", "Movie", profileId);
    const low = release({ title: "Movie.2020.720p.WEB-DL-AAA", seeders: 500, downloadUrl: "magnet:?xt=urn:btih:low" });
    const high = release({ title: "Movie.2020.1080p.WEB-DL-BBB", seeders: 20, downloadUrl: "magnet:?xt=urn:btih:high" });
    searchAllIndexers.mockResolvedValue([low, high]);

    const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.title)).toEqual(["Movie.2020.1080p.WEB-DL-BBB", "Movie.2020.720p.WEB-DL-AAA"]);
    expect(res.body.map((r: any) => r.wouldAutoGrab)).toEqual([true, false]);
  });

  it("marks no release when the search has no single pick (a season)", async () => {
    await insertTorrentClient();
    const showId = await insertItem("series", "Some Show");
    searchAllIndexers.mockResolvedValue([release({ title: "Some.Show.S01.1080p.WEB-DL-GRP" })]);

    const res = await request(app).get(`/api/search/${showId}?seasonNumber=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.every((r: any) => r.wouldAutoGrab === false)).toBe(true);
  });
});

describe("GET /api/search/:mediaItemId — what the indexers are asked", () => {
  async function insertShow(title: string, externalIds: Record<string, string>): Promise<number> {
    const id = await insertItem("series", title);
    await db.prepare("UPDATE media_items SET external_ids = ? WHERE id = ?").run(JSON.stringify(externalIds), id);
    return id;
  }

  it("asks for a show's episode by tvdb id and its scene numbers, and under the show's other titles", async () => {
    const showId = await insertShow("The Office (US)", { tvdb: "73244", imdb: "tt0386676", tmdb: "2316" });
    const epId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, monitored, has_file) VALUES (?, 3, 1, 4, 2, 1, 0)")
          .run(showId)
      ).lastInsertRowid
    );
    const { storeAliases } = await import("../src/services/releaseAliases.js");
    await storeAliases(showId, ["Das Büro"], "tmdb_alt");

    const res = await request(app).get(`/api/search/${showId}?episodeId=${epId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const [, query, , bypassCache, externalIds, hints] = searchAllIndexers.mock.calls[0];
    // Written the way a scene names the show: no "The", no brackets, no accents.
    expect(query).toBe("Office US S04E02");
    expect(bypassCache).toBe(true);
    expect(externalIds).toEqual({ tvdb: "73244" });
    expect(hints).toEqual({ season: 4, episode: 2, queryTitle: "Office US", alternateQueries: ["Office S04E02", "Das Buro S04E02"] });
  });

  it("asks for a whole season by season alone, and a whole show by its ids and no numbers", async () => {
    const showId = await insertShow("Season Show", { tvdb: "555", imdb: "tt0555555" });

    await request(app).get(`/api/search/${showId}?seasonNumber=2`).set("X-Api-Key", apiKey);
    expect(searchAllIndexers.mock.calls[0][4]).toEqual({ tvdb: "555" });
    expect(searchAllIndexers.mock.calls[0][5]).toMatchObject({ season: 2, episode: null });

    searchAllIndexers.mockClear();
    await request(app).get(`/api/search/${showId}`).set("X-Api-Key", apiKey);
    expect(searchAllIndexers.mock.calls[0][4]).toEqual({ tvdb: "555", imdb: "tt0555555" });
    expect(searchAllIndexers.mock.calls[0][5].season ?? null).toBeNull();
    expect(searchAllIndexers.mock.calls[0][5].episode ?? null).toBeNull();
  });

  it("asks for a daily show's episode by its date, and marks the release of that day as the one asked for", async () => {
    const showId = await insertShow("Late Night", { tvdb: "71256" });
    await db.prepare("UPDATE media_items SET series_type = 'daily' WHERE id = ?").run(showId);
    const epId = Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, air_date, monitored, has_file) VALUES (?, 2024, 101, '2024-08-25', 1, 0)")
          .run(showId)
      ).lastInsertRowid
    );
    searchAllIndexers.mockResolvedValue([
      release({ title: "Late.Night.2024.08.25.1080p.WEB.h264-GRP", downloadUrl: "magnet:?xt=day" }),
      release({ title: "Late.Night.2024.08.24.1080p.WEB.h264-GRP", downloadUrl: "magnet:?xt=other" }),
    ]);

    const res = await request(app).get(`/api/search/${showId}?episodeId=${epId}`).set("X-Api-Key", apiKey);

    const [, query, , , externalIds, hints] = searchAllIndexers.mock.calls[0];
    expect(query).toBe("Late Night 2024 08 25");
    expect(externalIds).toEqual({ tvdb: "71256" });
    expect(hints).toMatchObject({ airDate: "2024-08-25", alternateQueries: ["Late Night 2024-08-25"] });
    expect(res.body.map((r: any) => [r.title, r.matchesTarget])).toEqual([
      ["Late.Night.2024.08.25.1080p.WEB.h264-GRP", true],
      ["Late.Night.2024.08.24.1080p.WEB.h264-GRP", false],
    ]);
  });

  it("asks for an anime episode by its absolute number, with the season form beside it", async () => {
    const showId = await insertShow("Jujutsu Kaisen", { anilist: "113415" });
    await db.prepare("UPDATE media_items SET type = 'anime' WHERE id = ?").run(showId);
    const epId = Number(
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 25, 1, 0)").run(showId)).lastInsertRowid
    );
    for (let n = 1; n < 25; n++) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, ?, 1, 0)").run(showId, n);
    }

    await request(app).get(`/api/search/${showId}?episodeId=${epId}`).set("X-Api-Key", apiKey);

    const [, query, , , , hints] = searchAllIndexers.mock.calls[0];
    expect(query).toBe("Jujutsu Kaisen 25");
    expect(hints).toMatchObject({ season: 1, episode: 25, absolute: 25, alsoQueries: ["Jujutsu Kaisen S01E25"] });
  });
});

describe("POST /api/search/:mediaItemId/grab", () => {
  it("rounds a fractional size before storing it, so the queue insert works on Postgres too", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");

    const res = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:frac", protocol: "torrent", size: 1_400_000_000.5 });

    expect(res.status).toBe(201);
    const row = (await db.prepare("SELECT size FROM queue WHERE media_item_id = ?").get(movieId)) as { size: number | string };
    expect(Number(row.size)).toBe(1_400_000_001);
  });
});

describe("POST /api/search/bulk", () => {
  it("searches a show's missing episodes one by one and never grabs a release for the show as a whole", async () => {
    await insertTorrentClient();
    const showId = await insertItem("series", "Show");
    const epId = Number(
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 1, 'Ep', '2020-01-01', 1, 0)").run(showId))
        .lastInsertRowid
    );
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) =>
      query === "Show S01E01" ? [release({ title: "Show.S01E01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=e1" })] : [release({ title: "Show.S03E07.2160p.WEB-DL-GRP" })]
    );

    const res = await request(app).post("/api/search/bulk").set("X-Api-Key", apiKey).send({ targets: [{ mediaItemId: showId }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mediaItemId: showId, grabbed: true, childrenSearched: 1, childrenGrabbed: 1 }]);
    const rows = (await db.prepare("SELECT episode_id FROM queue WHERE media_item_id = ?").all(showId)) as { episode_id: number }[];
    expect(rows).toEqual([{ episode_id: epId }]);
  });

  it("won't replace a movie's file with a release that isn't an upgrade", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    await db.prepare("UPDATE media_items SET has_file = 1, quality = 'Bluray-1080p' WHERE id = ?").run(movieId);
    searchAllIndexers.mockResolvedValue([release({ title: "Movie.2020.1080p.WEB-DL-GRP" })]);

    const res = await request(app).post("/api/search/bulk").set("X-Api-Key", apiKey).send({ targets: [{ mediaItemId: movieId }] });

    expect(res.body).toEqual([{ mediaItemId: movieId, grabbed: false, error: "No release found that's an upgrade over Bluray-1080p" }]);
    expect(await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").get(movieId)).toBeUndefined();
  });
});

describe("identity gate on the manual search surfaces", () => {
  it("annotates each result with the identity verdict and sorts a release naming the item first", async () => {
    const movieId = await insertItem("movie", "Dune");
    await db.prepare("UPDATE media_items SET year = 2021 WHERE id = ?").run(movieId);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", seeders: 900, downloadUrl: "magnet:?xt=p2" }),
      release({ title: "Dune.2021.1080p.BluRay.x264-GRP", seeders: 3, downloadUrl: "magnet:?xt=d" }),
    ]);

    const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => [r.title, r.identityOk, r.identityMatch])).toEqual([
      ["Dune.2021.1080p.BluRay.x264-GRP", true, "title"],
      ["Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", false, "none"],
    ]);
    expect(res.body[1].identityReason).toMatch(/doesn't name "Dune"/);
  });

  it("records a manual grab as interactive, with how the release matched, and never blocks it", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Dune");
    await db.prepare("UPDATE media_items SET year = 2021 WHERE id = ?").run(movieId);

    const ok = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Dune.2021.1080p.BluRay.x264-GRP", downloadUrl: "magnet:?xt=urn:btih:dune", protocol: "torrent" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ matchType: "title", grabSource: "interactive" });

    const forced = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", downloadUrl: "magnet:?xt=urn:btih:part2", protocol: "torrent" });
    expect(forced.status).toBe(201);
    expect(forced.body).toMatchObject({ matchType: "none", grabSource: "interactive" });
  });
});

describe("manual grab with indexer ids", () => {
  it("records an id-confirmed match when the UI forwards the indexer's imdb id", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Dune");
    await db.prepare("UPDATE media_items SET year = 2021, external_ids = ? WHERE id = ?").run(JSON.stringify({ imdb: "tt1160419" }), movieId);

    const res = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Dune.Part.One.2021.1080p.WEB-GRP", imdbId: "tt1160419", downloadUrl: "magnet:?xt=urn:btih:part1", protocol: "torrent" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ matchType: "id", grabSource: "interactive" });
  });
});

describe("manual grab under an enforcing identity gate (Round 3)", () => {
  let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
  beforeAll(async () => {
    ({ setSetting } = await import("../src/services/settingsStore.js"));
  });

  it("refuses a release the gate rejects with 409 once, grabs it with force, and records the forced grab as interactive", async () => {
    setSetting("strictReleaseIdentity.movie", "enforce");
    try {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Dune");
      await db.prepare("UPDATE media_items SET year = 2021 WHERE id = ?").run(movieId);
      const body = { title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", downloadUrl: "magnet:?xt=urn:btih:part2", protocol: "torrent" };

      const refused = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send(body);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/doesn't name "Dune".*Grab it anyway, or add the release's title as an alias/);
      expect(await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").get(movieId)).toBeUndefined();
      // The refusal comes before the download client is touched, or the release would sit in the
      // client with no queue row and the confirmed retry would add it a second time.
      const adapter = getDownloadClientAdapter() as { addDownload: ReturnType<typeof vi.fn> };
      expect(adapter.addDownload).not.toHaveBeenCalled();

      const forced = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ ...body, force: true });
      expect(forced.status).toBe(201);
      expect(forced.body).toMatchObject({ matchType: "none", grabSource: "interactive" });
      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    } finally {
      setSetting("strictReleaseIdentity.movie", "");
    }
  });

  it("accepts a release named by one of the item's alternate titles on both surfaces", async () => {
    setSetting("strictReleaseIdentity.movie", "enforce");
    try {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "The Fall Guy");
      await db.prepare("UPDATE media_items SET year = 2024 WHERE id = ?").run(movieId);
      const { storeAliases } = await import("../src/services/releaseAliases.js");
      await storeAliases(movieId, ["Kaskader"], "tmdb_alt");
      searchAllIndexers.mockResolvedValue([release({ title: "Kaskader.2024.1080p.WEB-DL-GRP" })]);

      const listed = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);
      expect(listed.status).toBe(200);
      expect(listed.body[0]).toMatchObject({ identityOk: true, identityMatch: "alias", parsedTitle: "Kaskader" });

      const grabbed = await request(app)
        .post(`/api/search/${movieId}/grab`)
        .set("X-Api-Key", apiKey)
        .send({ title: "Kaskader.2024.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:kaskader", protocol: "torrent" });
      expect(grabbed.status).toBe(201);
      expect(grabbed.body).toMatchObject({ matchType: "alias", grabSource: "interactive" });
    } finally {
      setSetting("strictReleaseIdentity.movie", "");
    }
  });

  it("never refuses in log mode, and reports the parsed title the UI offers as an alias", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Dune");
    await db.prepare("UPDATE media_items SET year = 2021 WHERE id = ?").run(movieId);
    searchAllIndexers.mockResolvedValue([release({ title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP" })]);

    const listed = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);
    expect(listed.body[0]).toMatchObject({ identityOk: false, parsedTitle: "Dune Part Two" });

    const res = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", downloadUrl: "magnet:?xt=urn:btih:logmode", protocol: "torrent" });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/search/:mediaItemId — releases that can never import (matching Round 7)", () => {
  it("flags a multi-season pack, a split season, a raw disc, a sample and a cam copy, and sorts them below a clean release", async () => {
    const showId = await insertItem("series", "Show Name");
    searchAllIndexers.mockResolvedValue([
      release({ title: "Show.Name.S01-S05.COMPLETE.1080p.BluRay.x265-GRP", seeders: 900, downloadUrl: "magnet:?xt=pack" }),
      release({ title: "Show.Name.S01.Part.1.1080p.WEB-DL-GRP", seeders: 800, downloadUrl: "magnet:?xt=part" }),
      release({ title: "Show.Name.S01.1080p.Full.Blu-ray.AVC.DTS-HD.MA.5.1-GRP", seeders: 700, downloadUrl: "magnet:?xt=disc" }),
      release({ title: "Show.Name.S01.Sample.1080p.WEB-DL-GRP", size: 40_000_000, seeders: 600, downloadUrl: "magnet:?xt=sample" }),
      release({ title: "Show.Name.S01.1080p.WEB-DL.DDP5.1.H.264-GRP", seeders: 5, downloadUrl: "magnet:?xt=clean" }),
    ]);

    const res = await request(app).get(`/api/search/${showId}?seasonNumber=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ downloadUrl: "magnet:?xt=clean", rejected: false });
    const byUrl = Object.fromEntries(res.body.map((r: any) => [r.downloadUrl, r]));
    expect(byUrl["magnet:?xt=pack"]).toMatchObject({ rejected: true, rejectReason: expect.stringMatching(/several seasons/) });
    expect(byUrl["magnet:?xt=part"]).toMatchObject({ rejected: true, rejectReason: expect.stringMatching(/split season/) });
    expect(byUrl["magnet:?xt=disc"]).toMatchObject({ rejected: true, rejectReason: expect.stringMatching(/disc image/) });
    expect(byUrl["magnet:?xt=sample"]).toMatchObject({ rejected: true, rejectReason: expect.stringMatching(/sample/) });
  });

  it("still lets the user grab a rejected release by hand", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Disc Movie");
    const res = await request(app)
      .post(`/api/search/${movieId}/grab`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Disc.Movie.2010.1080p.Blu-ray.AVC.DTS-HD.MA.5.1-GRP", downloadUrl: "magnet:?xt=urn:btih:disc", protocol: "torrent" });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/search/:mediaItemId — the gate knows about same-titled shows (matching Round 8)", () => {
  it("rejects the original show's bare-titled release for the reboot, and accepts the one that names its year", async () => {
    await insertItem("series", "Charmed");
    const rebootId = await insertItem("series", "Charmed");
    await db.prepare("UPDATE media_items SET year = 1998 WHERE title = 'Charmed' AND id <> ?").run(rebootId);
    await db.prepare("UPDATE media_items SET year = 2018 WHERE id = ?").run(rebootId);
    const { syncPrimaryTitle } = await import("../src/services/releaseAliases.js");
    for (const row of (await db.prepare("SELECT id FROM media_items WHERE title = 'Charmed'").all()) as { id: number }[]) await syncPrimaryTitle(row.id);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Charmed.S01E01.720p.HDTV.x264-LOL", downloadUrl: "magnet:?xt=bare" }),
      release({ title: "Charmed.2018.S01E01.720p.HDTV.x264-LOL", downloadUrl: "magnet:?xt=year" }),
    ]);

    const res = await request(app).get(`/api/search/${rebootId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const byUrl = Object.fromEntries(res.body.map((r: any) => [r.downloadUrl, r]));
    expect(byUrl["magnet:?xt=year"]).toMatchObject({ identityOk: true });
    expect(byUrl["magnet:?xt=bare"]).toMatchObject({ identityOk: false, identityRejection: "year" });
  });
});

describe("GET /api/search/:mediaItemId — a season a scene split (matching Round 10)", () => {
  async function insertEpisodes(showId: number, scenes: (number | null)[]): Promise<void> {
    for (const [index, scene] of scenes.entries()) {
      await db
        .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, monitored, has_file) VALUES (?, 1, ?, ?, ?, 1, 0)")
        .run(showId, index + 1, scene, scene === null ? null : index + 1);
    }
  }
  const byUrl = (body: any[]) => Object.fromEntries(body.map((r) => [r.downloadUrl, r]));

  it("asks under each season number the scene calls the season by, and takes the packs of each as its own", async () => {
    const showId = await insertItem("series", "Split Show");
    await insertEpisodes(showId, [1, 1, 2, 2]);
    searchAllIndexers.mockImplementation(async (_indexers: unknown, query: string) => {
      if (query === "Split Show S01") return [release({ title: "Split.Show.S01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=one" }), release({ title: "Split.Show.S03.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=three" })];
      if (query === "Split Show S02") return [release({ title: "Split.Show.S02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=two" })];
      return [];
    });

    const res = await request(app).get(`/api/search/${showId}?seasonNumber=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Split Show S01", "Split Show S02"]);
    const results = byUrl(res.body);
    expect(results["magnet:?xt=one"]).toMatchObject({ matchesTarget: true });
    expect(results["magnet:?xt=two"]).toMatchObject({ matchesTarget: true });
    expect(results["magnet:?xt=three"]).toMatchObject({ matchesTarget: false });
  });

  it("asks once, under the season's own number, for a show with no scene numbering", async () => {
    const showId = await insertItem("series", "Plain Show");
    await insertEpisodes(showId, [null, null]);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Plain.Show.S01.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=one" }),
      release({ title: "Plain.Show.S02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=two" }),
    ]);

    const res = await request(app).get(`/api/search/${showId}?seasonNumber=1`).set("X-Api-Key", apiKey);

    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Plain Show S01"]);
    const results = byUrl(res.body);
    expect(results["magnet:?xt=one"]).toMatchObject({ matchesTarget: true });
    expect(results["magnet:?xt=two"]).toMatchObject({ matchesTarget: false });
  });
});

describe("GET /api/search/:mediaItemId — one release found by two queries of a season a scene splits", () => {
  it("is listed once, and the lowest scene season number is the main query", async () => {
    const showId = await insertItem("series", "Overlap Show");
    for (const [index, scene] of [[1, 3], [2, 3], [3, 2], [4, 2]] as const) {
      await db
        .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, monitored, has_file) VALUES (?, 1, ?, ?, ?, 1, 0)")
        .run(showId, index, scene, index);
    }
    const shared = release({ title: "Overlap.Show.S02.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=shared" });
    searchAllIndexers.mockResolvedValue([shared]);

    const res = await request(app).get(`/api/search/${showId}?seasonNumber=1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(searchAllIndexers.mock.calls.map((c) => c[1])).toEqual(["Overlap Show S02", "Overlap Show S03"]);
    expect(res.body).toHaveLength(1);
  });
});
