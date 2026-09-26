import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertShow(extraMetadata: Record<string, unknown> | null): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, extra_metadata) VALUES ('series', 'Patch Show', 'patch show', 1, 0, 'continuing', ?, ?)`
    )
    .run(JSON.stringify({ tvdb: "81189", tmdb: "1396" }), extraMetadata ? JSON.stringify(extraMetadata) : null);
  return Number(result.lastInsertRowid);
}

async function storedExtraMetadata(id: number): Promise<any> {
  const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as any;
  return row.extra_metadata ? JSON.parse(row.extra_metadata) : null;
}

describe("PATCH /api/media/:id extraMetadata", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("keeps the stored record of merged-in provider ids when Apply Merge clears the staged data", async () => {
    // The page loaded before a background provider match recorded tmdb as merged in, so its copy
    // (what Apply Merge sends back, minus the provider keys) doesn't have it.
    const id = await insertShow({ tmdb: { title: "Patch Show" }, additionalProviderIds: { tmdb: "1396" } });

    const res = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ overview: "Merged", extraMetadata: {} });

    expect(res.status).toBe(200);
    expect(await storedExtraMetadata(id)).toEqual({ additionalProviderIds: { tmdb: "1396" } });
    expect(res.body.extraMetadata).toEqual({ additionalProviderIds: { tmdb: "1396" } });
    expect(res.body.overview).toBe("Merged");
  });

  it("records an older item's merged-in ids before Apply Merge drops the staged results they're inferred from", async () => {
    const { childListProviderIds } = await import("../src/services/libraryScan.js");
    const id = await insertShow({ tmdb: { title: "Patch Show", externalIds: { tmdb: "1396" } } });
    const childListIds = async () => childListProviderIds((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any);
    expect(await childListIds()).toEqual({ tvdb: "81189" });

    const res = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ overview: "Merged", extraMetadata: {} });

    expect(res.status).toBe(200);
    expect(await storedExtraMetadata(id)).toEqual({ additionalProviderIds: { tmdb: "1396" } });
    expect(await childListIds()).toEqual({ tvdb: "81189" });
  });

  it("keeps a stored record that says nothing was merged in", async () => {
    const id = await insertShow({ tmdb: { title: "Patch Show", externalIds: { tmdb: "1396" } }, additionalProviderIds: {} });

    await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ extraMetadata: {} });

    expect(await storedExtraMetadata(id)).toEqual({ additionalProviderIds: {} });
  });

  it("ignores a client's own value for the merged-in provider ids", async () => {
    const id = await insertShow({ performers: ["A"], additionalProviderIds: { tmdb: "1396" } });

    await request(app)
      .patch(`/api/media/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ extraMetadata: { performers: ["B"], additionalProviderIds: { tvdb: "81189" } } });

    expect(await storedExtraMetadata(id)).toEqual({ performers: ["B"], additionalProviderIds: { tmdb: "1396" } });
  });

  it("never records merged-in provider ids a client sends for an item that has none", async () => {
    const id = await insertShow({ tmdb: { title: "Patch Show" } });

    await request(app)
      .patch(`/api/media/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ extraMetadata: { performers: ["A"], additionalProviderIds: { tmdb: "1396" } } });

    expect(await storedExtraMetadata(id)).toEqual({ performers: ["A"] });
  });

  it("leaves extra_metadata alone when the request doesn't carry it", async () => {
    const id = await insertShow({ tmdb: { title: "Patch Show" }, additionalProviderIds: { tmdb: "1396" } });

    await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ monitored: 0 });

    expect(await storedExtraMetadata(id)).toEqual({ tmdb: { title: "Patch Show" }, additionalProviderIds: { tmdb: "1396" } });
  });
});
