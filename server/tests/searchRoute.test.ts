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

describe("GET /api/search/:mediaItemId — name and upgrade verdicts (N18, D4)", () => {
  it("says whether each release names the album searched for, and why not", async () => {
    const artistId = await insertItem("artist", "Queen");
    const subId = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Greatest Hits', 1, 0)").run(artistId)).lastInsertRowid);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Queen - Greatest Hits (1981) [FLAC]", downloadUrl: "magnet:?xt=urn:btih:a" }),
      release({ title: "Queen - Greatest Hits Live (2005) [FLAC]", downloadUrl: "magnet:?xt=urn:btih:b" }),
      release({ title: "ABBA - Greatest Hits (1975) [FLAC]", downloadUrl: "magnet:?xt=urn:btih:c" }),
    ]);

    const res = await request(app).get(`/api/search/${artistId}?subItemId=${subId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const byTitle = Object.fromEntries(res.body.map((r: any) => [r.title, r]));
    expect(byTitle["Queen - Greatest Hits (1981) [FLAC]"]).toMatchObject({ nameOk: true, nameReason: null });
    expect(byTitle["Queen - Greatest Hits Live (2005) [FLAC]"].nameOk).toBe(false);
    expect(byTitle["Queen - Greatest Hits Live (2005) [FLAC]"].nameReason).toMatch(/live/i);
    expect(byTitle["ABBA - Greatest Hits (1975) [FLAC]"].nameOk).toBe(false);
    // The ones that name it come first.
    expect(res.body[0].title).toBe("Queen - Greatest Hits (1981) [FLAC]");
  });

  it("says whether a release would replace the file the movie has, and shows a PROPER", async () => {
    const profileId = Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
          .run(`Upg ${Math.random()}`, JSON.stringify(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"]), "Bluray-1080p")
      ).lastInsertRowid
    );
    const movieId = await insertItem("movie", "Movie", profileId);
    await db.prepare("UPDATE media_items SET has_file = 1, quality = 'WEBDL-1080p', file_release_title = 'Movie.2020.1080p.WEB-DL-GRPA' WHERE id = ?").run(movieId);
    searchAllIndexers.mockResolvedValue([
      release({ title: "Movie.2020.1080p.BluRay-GRPB", downloadUrl: "magnet:?xt=urn:btih:a" }),
      release({ title: "Movie.2020.720p.WEB-DL-GRPB", downloadUrl: "magnet:?xt=urn:btih:b" }),
      release({ title: "Movie.2020.PROPER.1080p.WEB-DL-GRPC", downloadUrl: "magnet:?xt=urn:btih:c" }),
    ]);

    const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const byTitle = Object.fromEntries(res.body.map((r: any) => [r.title, r]));
    expect(byTitle["Movie.2020.1080p.BluRay-GRPB"].upgrade).toBe("yes");
    expect(byTitle["Movie.2020.720p.WEB-DL-GRPB"].upgrade).toBe("no");
    expect(byTitle["Movie.2020.PROPER.1080p.WEB-DL-GRPC"]).toMatchObject({ upgrade: "yes", revisionLabel: "PROPER / v2" });
    expect(byTitle["Movie.2020.1080p.BluRay-GRPB"].revisionLabel).toBeNull();
    // A movie with no file has nothing to replace.
    const empty = await insertItem("movie", "Empty Movie", profileId);
    const none = await request(app).get(`/api/search/${empty}`).set("X-Api-Key", apiKey);
    expect(none.body.every((r: any) => r.upgrade === null)).toBe(true);
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
    expect(hints).toMatchObject({ season: 4, episode: 2, queryTitle: "Office US", alternateQueries: ["Office S04E02", "Das Buro S04E02"] });
    // Whoever asked can stop the search, and is told which indexers answered.
    expect(hints.signal).toBeInstanceOf(AbortSignal);
    expect(typeof hints.onOutcome).toBe("function");
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
    // The season's episodes: a pack for a season the show has no episodes for fails the pack guards.
    for (let n = 1; n <= 3; n++) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, ?, ?, '2020-01-01', 1, 0)").run(showId, n, `E${n}`);
    }
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

// Round 20 (backend parity audit SR6, DL20): a manual grab goes through grab()'s guards.
describe("POST /api/search/:mediaItemId/grab — the guards of every other grab (Round 20)", () => {
  it("refuses the same release twice for one target, sending it to the client once", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    const adapter = { addDownload: vi.fn(async (_c: unknown, url: string) => ({ downloadId: `id-${url}` })), getStatus: vi.fn(async () => []) };
    getDownloadClientAdapter.mockReturnValue(adapter);
    const body = { title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:one", protocol: "torrent" };

    const first = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send(body);
    const second = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error ?? second.body.message).toMatch(/already in the queue/);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    const rows = (await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").all(movieId)) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("still takes a different release for a target that is already queued, as the admin chose it", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    const send = (title: string, url: string) =>
      request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ title, downloadUrl: url, protocol: "torrent" });

    expect((await send("Movie.2020.1080p.WEB-DL-AAA", "magnet:?xt=urn:btih:aaa")).status).toBe(201);
    expect((await send("Movie.2020.720p.WEB-DL-BBB", "magnet:?xt=urn:btih:bbb")).status).toBe(201);
  });

  it("answers 409 when the client says it already has this download for another entry", async () => {
    await insertTorrentClient();
    const first = await insertItem("movie", "Movie");
    const other = await insertItem("movie", "Another Movie");
    const adapter = { addDownload: vi.fn(async () => ({ downloadId: "same-hash" })), getStatus: vi.fn(async () => []) };
    getDownloadClientAdapter.mockReturnValue(adapter);

    const a = await request(app).post(`/api/search/${first}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" });
    const b = await request(app).post(`/api/search/${other}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP2", downloadUrl: "magnet:?xt=urn:btih:y", protocol: "torrent" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    expect((await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").all(other)) as unknown[]).toHaveLength(0);
  });

  it("answers 502 with the client's reason when it refuses the release, and queues nothing", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async () => {
        throw new Error('qBittorrent did not add the torrent (it answered "Fails.")');
      }),
      getStatus: vi.fn(async () => []),
    });

    const res = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP", downloadUrl: "http://indexer/dead.torrent", protocol: "torrent" });

    expect(res.status).toBe(502);
    expect(res.body.error ?? res.body.message).toMatch(/could not be added.*did not add the torrent/);
    expect((await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").all(movieId)) as unknown[]).toHaveLength(0);
  });

  it("answers 503 when the download client itself is unreachable", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }),
      getStatus: vi.fn(async () => []),
    });

    const res = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" });

    expect(res.status).toBe(503);
    expect(res.body.error ?? res.body.message).toMatch(/unavailable/);
  });
});

describe("POST /api/search/:mediaItemId/grab — two clicks at once (Round 20 review)", () => {
  it("sends the release to the client once when the same grab arrives twice together", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    let adds = 0;
    const adapter = {
      addDownload: vi.fn(async () => {
        adds++;
        await new Promise((resolve) => setTimeout(resolve, 40)); // a client that takes a moment, as a real one does
        return { downloadId: `job-${adds}` }; // a usenet client gives every add its own id
      }),
      getStatus: vi.fn(async () => []),
    };
    getDownloadClientAdapter.mockReturnValue(adapter);
    const body = { title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "http://indexer/dl?id=1", protocol: "torrent" };

    const [a, b] = await Promise.all([
      request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send(body),
      request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send(body),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").all(movieId)) as unknown[]).toHaveLength(1);
  });

  it("does not put a link with an API key in the error it answers", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async () => {
        throw new Error('Too many redirects resolving download URL "http://indexer/api?t=get&apikey=SECRET-KEY"');
      }),
      getStatus: vi.fn(async () => []),
    });

    const res = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP", downloadUrl: "http://indexer/dl", protocol: "torrent" });

    expect(JSON.stringify(res.body)).not.toContain("SECRET-KEY");
  });

  it("stores no size for a release whose size the indexer did not give", async () => {
    await insertTorrentClient();
    const movieId = await insertItem("movie", "Movie");

    const res = await request(app).post(`/api/search/${movieId}/grab`).set("X-Api-Key", apiKey).send({ title: "Movie.2020.1080p-GRP", downloadUrl: "magnet:?xt=urn:btih:nosize", protocol: "torrent" });

    expect(res.status).toBe(201);
    const row = (await db.prepare("SELECT size FROM queue WHERE media_item_id = ?").get(movieId)) as { size: number | null };
    expect(row.size).toBeNull();
  });
});

describe("POST /api/search/:mediaItemId/grab — a 409 says whether repeating can help (Round 30b)", () => {
  let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
  beforeAll(async () => {
    ({ setSetting } = await import("../src/services/settingsStore.js"));
  });

  const grab = (mediaItemId: number, body: Record<string, unknown>) => request(app).post(`/api/search/${mediaItemId}/grab`).set("X-Api-Key", apiKey).send(body);
  const queueRows = async (mediaItemId: number) => (await db.prepare("SELECT id FROM queue WHERE media_item_id = ?").all(mediaItemId)) as unknown[];
  const movieBody = { title: "Movie.2020.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:one", protocol: "torrent" };

  /** An adapter that hands out an id of its own per release and counts what it was given. */
  function adapterWithOwnIds() {
    const adapter = { addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: `id-${url}` })), getStatus: vi.fn(async () => []) };
    getDownloadClientAdapter.mockReturnValue(adapter);
    return adapter;
  }

  async function insertArtistWithUnreleasedAlbum(): Promise<number> {
    const artistId = await insertItem("artist", "Queen");
    for (const [title, date] of [
      ["Queen", "1973-07-13"],
      ["Queen II", "1974-03-08"],
      ["The Next Record", "2999-01-01"],
    ]) {
      await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(artistId, title, date);
    }
    return artistId;
  }

  describe("a refusal the admin may confirm answers code override", () => {
    it.each([
      ["force", { force: true }],
      ["the matching override", { overrides: ["blocklisted"] }],
    ])("a blocklisted release: refused with code override, taken with %s", async (_label, confirm) => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");
      await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(movieId, movieBody.title);
      const adapter = adapterWithOwnIds();

      const refused = await grab(movieId, movieBody);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "override" });
      expect(refused.body.error).toMatch(/blocklisted/);
      expect(adapter.addDownload).not.toHaveBeenCalled();

      const confirmed = await grab(movieId, { ...movieBody, ...confirm });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.code).toBeUndefined();
      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    });

    it("an override for another rejection does not lift the blocklist", async () => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");
      await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(movieId, movieBody.title);
      const adapter = adapterWithOwnIds();

      const res = await grab(movieId, { ...movieBody, overrides: ["quality", "identity"] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("override");
      expect(adapter.addDownload).not.toHaveBeenCalled();
    });

    it.each([
      ["force", { force: true }],
      ["the discography override", { overrides: ["discography"] }],
      ["the season-pack override the list sends for a pack", { overrides: ["season-pack"] }],
    ])("a discography that includes an album not out yet: refused with code override, taken with %s", async (_label, confirm) => {
      await insertTorrentClient();
      const artistId = await insertArtistWithUnreleasedAlbum();
      const adapter = adapterWithOwnIds();
      const body = { title: "Queen - Discography [FLAC]", downloadUrl: "magnet:?xt=urn:btih:disco", protocol: "torrent" };

      const refused = await grab(artistId, body);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("override");
      expect(refused.body.error).toMatch(/not out yet.*Grab it anyway to override/);
      expect(adapter.addDownload).not.toHaveBeenCalled();

      const confirmed = await grab(artistId, { ...body, ...confirm });
      expect(confirmed.status).toBe(201);
      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["force", { force: true }],
      ["the identity override", { overrides: ["identity"] }],
    ])("a release the enforcing identity gate rejects: refused with code override, taken with %s", async (_label, confirm) => {
      setSetting("strictReleaseIdentity.movie", "enforce");
      try {
        await insertTorrentClient();
        const movieId = await insertItem("movie", "Dune");
        await db.prepare("UPDATE media_items SET year = 2021 WHERE id = ?").run(movieId);
        const adapter = adapterWithOwnIds();
        const body = { title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", downloadUrl: "magnet:?xt=urn:btih:part2", protocol: "torrent" };

        const refused = await grab(movieId, body);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe("override");
        expect(refused.body.error).toMatch(/Grab it anyway, or add the release's title as an alias/);
        expect(adapter.addDownload).not.toHaveBeenCalled();

        const confirmed = await grab(movieId, { ...body, ...confirm });
        expect(confirmed.status).toBe(201);
        expect(adapter.addDownload).toHaveBeenCalledTimes(1);
      } finally {
        setSetting("strictReleaseIdentity.movie", "");
      }
    });
  });

  describe("a refusal repeating cannot help answers code duplicate, and force does not override it", () => {
    it("a release already in the queue for the item", async () => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");
      const adapter = adapterWithOwnIds();

      expect((await grab(movieId, movieBody)).status).toBe(201);
      const again = await grab(movieId, movieBody);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("duplicate");
      expect(again.body.error).toMatch(/already in the queue for this item/);

      // force is for rejections: it no longer lets the same release in twice, and neither do the overrides.
      const forced = await grab(movieId, { ...movieBody, force: true });
      expect(forced.status).toBe(409);
      expect(forced.body.code).toBe("duplicate");
      const overridden = await grab(movieId, { ...movieBody, overrides: ["blocklisted", "identity", "discography", "season-pack", "quality"] });
      expect(overridden.status).toBe(409);
      expect(overridden.body.code).toBe("duplicate");

      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
      expect(await queueRows(movieId)).toHaveLength(1);
    });

    it("stays a duplicate when the same release is also blocklisted and force is set", async () => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");
      const adapter = adapterWithOwnIds();
      expect((await grab(movieId, movieBody)).status).toBe(201);
      await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(movieId, movieBody.title);

      const res = await grab(movieId, { ...movieBody, force: true });

      // The blocklist is overridden by force, and what is left is the copy already on its way.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("duplicate");
      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    });

    it("a download the client already has for another entry", async () => {
      await insertTorrentClient();
      const first = await insertItem("movie", "Movie");
      const other = await insertItem("movie", "Another Movie");
      const adapter = { addDownload: vi.fn(async () => ({ downloadId: "same-hash" })), getStatus: vi.fn(async () => []) };
      getDownloadClientAdapter.mockReturnValue(adapter);

      expect((await grab(first, { title: "Movie.2020.1080p-GRP", downloadUrl: "magnet:?xt=urn:btih:x", protocol: "torrent" })).status).toBe(201);
      const second = { title: "Movie.2020.1080p-GRP2", downloadUrl: "magnet:?xt=urn:btih:y", protocol: "torrent" };
      const refused = await grab(other, second);
      const forced = await grab(other, { ...second, force: true });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "duplicate", error: "The download client already has this download for another entry." });
      expect(forced.status).toBe(409);
      expect(forced.body.code).toBe("duplicate");
      expect(await queueRows(other)).toHaveLength(0);
    });

    it("the same release sent again while the first is still being handed to the client, even with force", async () => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");
      // The first request is held inside the client, so no queue row exists yet when the second arrives: only the check
      // inside the per-item chain (DuplicateGrabError) can catch it.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let entered!: () => void;
      const inClient = new Promise<void>((resolve) => (entered = resolve));
      let adds = 0;
      const adapter = {
        addDownload: vi.fn(async () => {
          adds++;
          entered();
          await gate;
          return { downloadId: `job-${adds}` };
        }),
        getStatus: vi.fn(async () => []),
      };
      getDownloadClientAdapter.mockReturnValue(adapter);

      const first = grab(movieId, movieBody).then((r) => r);
      await inClient;
      const second = grab(movieId, { ...movieBody, force: true }).then((r) => r);
      // Let the second request get past the route's own queue check and wait behind the first.
      await new Promise((resolve) => setTimeout(resolve, 100));
      open();
      const [a, b] = await Promise.all([first, second]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(409);
      expect(b.body.code).toBe("duplicate");
      expect(adapter.addDownload).toHaveBeenCalledTimes(1);
      expect(await queueRows(movieId)).toHaveLength(1);
    });
  });

  describe("an answer that is not a 409 carries no code", () => {
    it("a client that refuses the release (502), one that is unreachable (503) and a missing downloadUrl (400)", async () => {
      await insertTorrentClient();
      const movieId = await insertItem("movie", "Movie");

      getDownloadClientAdapter.mockReturnValue({
        addDownload: vi.fn(async () => {
          throw new Error("qBittorrent did not add the torrent");
        }),
        getStatus: vi.fn(async () => []),
      });
      const refused = await grab(movieId, movieBody);
      expect(refused.status).toBe(502);
      expect(refused.body.code).toBeUndefined();

      getDownloadClientAdapter.mockReturnValue({
        addDownload: vi.fn(async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }),
        getStatus: vi.fn(async () => []),
      });
      const down = await grab(movieId, { ...movieBody, downloadUrl: "magnet:?xt=urn:btih:two" });
      expect(down.status).toBe(503);
      expect(down.body.code).toBeUndefined();

      const missing = await grab(movieId, { title: movieBody.title });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBeUndefined();
    });
  });
});
