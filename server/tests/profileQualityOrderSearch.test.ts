import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchAllIndexers = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/indexerClient.js")>()),
  searchAllIndexers: (...args: unknown[]) => searchAllIndexers(...args),
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
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run();
  searchAllIndexers.mockReset().mockResolvedValue([]);
});

function release(title: string, seeders: number): Record<string, unknown> {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title,
    size: 5_000_000_000,
    seeders,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: `magnet:?xt=urn:btih:${title}`,
    protocol: "torrent",
    category: null,
  };
}

async function movieWithProfile(order: string[] | null, cutoff: string, name: string): Promise<number> {
  const profileId = Number(
    (
      await db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_order, prefer_cutoff_quality) VALUES (?, ?, ?, ?, 0)")
        .run(`search-order-${name}-${Math.random().toString(36).slice(2)}`, JSON.stringify(["WEBDL-1080p", "Bluray-1080p"]), cutoff, order ? JSON.stringify(order) : null)
    ).lastInsertRowid
  );
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES ('movie', 'Movie', 'movie', 1, 0, 'missing', ?)")
        .run(profileId)
    ).lastInsertRowid
  );
}

describe("the interactive search lists releases in the item's profile's quality order", () => {
  const web = release("Movie.2020.1080p.WEB-DL.x264-GRPA", 5);
  const disc = release("Movie.2020.1080p.BluRay.x264-GRPB", 900);

  it("puts the WEB-DL first, and as the automatic pick, for a profile that ranks it above the disc", async () => {
    const movieId = await movieWithProfile(["Bluray-1080p", "WEBDL-1080p"], "WEBDL-1080p", "web");
    searchAllIndexers.mockResolvedValue([disc, web]);

    const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.parsedQuality)).toEqual(["WEBDL-1080p", "Bluray-1080p"]);
    expect(res.body.map((r: any) => r.wouldAutoGrab)).toEqual([true, false]);
    // The rank a UI sorts by follows the profile too.
    expect(res.body[0].qualityRank).toBeGreaterThan(res.body[1].qualityRank);
  });

  it("puts the disc first for a profile that ranks it above the WEB-DL, and for one with no order of its own", async () => {
    for (const order of [["WEBDL-1080p", "Bluray-1080p"], null]) {
      const movieId = await movieWithProfile(order, "Bluray-1080p", order ? "disc" : "global");
      searchAllIndexers.mockResolvedValue([web, disc]);

      const res = await request(app).get(`/api/search/${movieId}`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body.map((r: any) => r.parsedQuality), JSON.stringify(order)).toEqual(["Bluray-1080p", "WEBDL-1080p"]);
      expect(res.body.map((r: any) => r.wouldAutoGrab)).toEqual([true, false]);
      expect(res.body[0].qualityRank).toBeGreaterThan(res.body[1].qualityRank);
    }
  });
});
