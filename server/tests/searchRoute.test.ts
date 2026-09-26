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
