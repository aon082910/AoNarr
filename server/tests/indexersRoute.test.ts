import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let INDEXER_MEDIA_TYPES: string[];
let DEFAULT_INDEXER_MEDIA_TYPES: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ INDEXER_MEDIA_TYPES, DEFAULT_INDEXER_MEDIA_TYPES } = await import("../src/services/indexerClient.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rowById(id: number): Promise<any> {
  return db.prepare("SELECT * FROM indexers WHERE id = ?").get(id);
}

describe("POST /api/indexers — media types", () => {
  it("defaults a new indexer to every indexer-searchable type, so anime/sports/ppv items actually reach it", async () => {
    const res = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Default Types", protocol: "torznab", url: "https://idx.example.com", apiKey: "k", config: null, useFlareSolverr: false });

    expect(res.status).toBe(201);
    expect(res.body.mediaTypes).toBe(DEFAULT_INDEXER_MEDIA_TYPES);
    const types = res.body.mediaTypes.split(",");
    for (const t of ["movie", "series", "anime", "sports", "ppv", "artist", "author", "audiobook", "comic", "manga", "rom", "course", "adult"]) {
      expect(types).toContain(t);
    }
    expect(types).not.toContain("video");
    expect(types).not.toContain("podcast");
  });

  it("stores an explicit media type selection from the form", async () => {
    const res = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Anime Only", protocol: "torznab", url: "https://anime.example.com", mediaTypes: "anime,manga" });

    expect(res.status).toBe(201);
    expect((await rowById(res.body.id)).media_types).toBe("anime,manga");
  });

  it("PATCH updates the media type selection", async () => {
    const created = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Patch Types", protocol: "newznab", url: "https://nzb.example.com" });

    const res = await request(app).patch(`/api/indexers/${created.body.id}`).set("X-Api-Key", apiKey).send({ mediaTypes: "movie,sports" });

    expect(res.status).toBe(200);
    expect(res.body.mediaTypes).toBe("movie,sports");
  });

  it("GET /api/indexers/media-types lists the types the form offers", async () => {
    const res = await request(app).get("/api/indexers/media-types").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INDEXER_MEDIA_TYPES);
  });
});

describe("PATCH /api/indexers/:id — synced indexers keep their sync id", () => {
  it("saving the edit form (config: null for a torznab indexer) keeps the Prowlarr id, so the next sync updates instead of duplicating", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const { syncFromProwlarr } = await import("../src/services/prowlarrSync.js");
    setSetting("prowlarrUrl", "http://prowlarr.local:9696");
    setSetting("prowlarrApiKey", "prowlarr-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 7701, name: "Synced Tracker", protocol: "torrent", enable: true }] })
    );
    await syncFromProwlarr();
    const synced = (await db.prepare("SELECT id FROM indexers WHERE url = ?").get("http://prowlarr.local:9696/7701")) as { id: number };

    const res = await request(app)
      .patch(`/api/indexers/${synced.id}`)
      .set("X-Api-Key", apiKey)
      .send({ name: "Renamed Locally", protocol: "torznab", url: "http://prowlarr.local:9696/7701", apiKey: null, config: null, useFlareSolverr: false });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.config)).toEqual({ prowlarrEnabled: true, prowlarrId: 7701 });

    await syncFromProwlarr();

    const rows = (await db.prepare("SELECT * FROM indexers WHERE url = ?").all("http://prowlarr.local:9696/7701")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(synced.id);
  });

  it("a DDL config replaces the old one but still carries the Jackett id over", async () => {
    const id = Number(
      (
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, config) VALUES ('Jackett Row', 'torznab', 'http://jackett.local/x', ?)")
          .run(JSON.stringify({ jackettId: "x-tracker" }))
      ).lastInsertRowid
    );
    const ddlConfig = { resultsPath: "data", titleField: "name", sizeField: null, downloadUrlField: "url", seedersField: null, publishDateField: null };

    const res = await request(app)
      .patch(`/api/indexers/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ protocol: "ddl", url: "https://api.example.com/search?q={query}", config: ddlConfig });

    expect(res.status).toBe(200);
    expect(JSON.parse((await rowById(id)).config)).toEqual({ ...ddlConfig, jackettId: "x-tracker" });
  });

  it("a PATCH that doesn't mention config leaves it untouched, and a plain indexer's config: null stays null", async () => {
    const created = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Plain", protocol: "torznab", url: "https://plain.example.com" });

    await request(app).patch(`/api/indexers/${created.body.id}`).set("X-Api-Key", apiKey).send({ config: null });
    expect((await rowById(created.body.id)).config).toBeNull();

    const synced = Number(
      (
        await db
          .prepare("INSERT INTO indexers (name, protocol, url, config) VALUES ('Untouched', 'torznab', 'http://prowlarr.local:9696/7702', ?)")
          .run(JSON.stringify({ prowlarrId: 7702 }))
      ).lastInsertRowid
    );
    await request(app).patch(`/api/indexers/${synced}`).set("X-Api-Key", apiKey).send({ name: "Still Synced" });
    expect(JSON.parse((await rowById(synced)).config)).toEqual({ prowlarrId: 7702 });
  });
});
