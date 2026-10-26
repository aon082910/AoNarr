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
    expect(query).toBe("The Office (US) S04E02");
    expect(bypassCache).toBe(true);
    expect(externalIds).toEqual({ tvdb: "73244" });
    expect(hints).toEqual({ season: 4, episode: 2, alternateQueries: ["The Office S04E02", "The Office US S04E02", "Das Büro S04E02"] });
  });

  it("asks for a whole season by season alone, and a whole show by its ids and no numbers", async () => {
    const showId = await insertShow("Season Show", { tvdb: "555", imdb: "tt0555555" });

    await request(app).get(`/api/search/${showId}?seasonNumber=2`).set("X-Api-Key", apiKey);
    expect(searchAllIndexers.mock.calls[0][4]).toEqual({ tvdb: "555" });
    expect(searchAllIndexers.mock.calls[0][5]).toMatchObject({ season: 2, episode: null });

    searchAllIndexers.mockClear();
    await request(app).get(`/api/search/${showId}`).set("X-Api-Key", apiKey);
    expect(searchAllIndexers.mock.calls[0][4]).toEqual({ tvdb: "555", imdb: "tt0555555" });
    expect(searchAllIndexers.mock.calls[0][5]).toMatchObject({ season: null, episode: null });
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
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file) VALUES (?, 1, 1, 'Ep', 1, 0)").run(showId))
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
