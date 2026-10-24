import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const refreshOneMediaItem = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/libraryScan.js")>()),
  refreshOneMediaItem: (...args: unknown[]) => refreshOneMediaItem(...args),
}));

const refreshProviderAliases = vi.fn(async () => 0);
vi.mock("../src/services/aliasBackfill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/aliasBackfill.js")>()),
  refreshProviderAliases: (...args: unknown[]) => refreshProviderAliases(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

async function insertMovie(title: string, year: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie', ?, ?, ?, 1, 0, 'missing')")
        .run(title, title.toLowerCase(), year)
    ).lastInsertRowid
  );
}

describe("/api/media/:id/aliases", () => {
  it("lists, adds and removes an item's alternate titles", async () => {
    const id = await insertMovie("Attack on Titan", 2013);

    const empty = await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const added = await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({ title: "  Shingeki no Kyojin " });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject([{ mediaItemId: id, title: "Shingeki no Kyojin", cleanTitle: "shingekinokyojin", source: "user" }]);

    // The same title again (another spelling) is not duplicated.
    const again = await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({ title: "Shingeki No Kyojin" });
    expect(again.status).toBe(201);
    expect(again.body).toHaveLength(1);

    const removed = await request(app).delete(`/api/media/${id}/aliases/${added.body[0].id}`).set("X-Api-Key", apiKey);
    expect(removed.status).toBe(204);
    expect((await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body).toEqual([]);
    expect((await request(app).delete(`/api/media/${id}/aliases/${added.body[0].id}`).set("X-Api-Key", apiKey)).status).toBe(404);
  });

  it("rejects a missing title and an unknown item", async () => {
    const id = await insertMovie("Alias Validation");
    expect((await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({})).status).toBe(400);
    expect((await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({ title: "   " })).status).toBe(400);
    expect((await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({ title: 42 })).status).toBe(400);
    expect((await request(app).get(`/api/media/999999/aliases`).set("X-Api-Key", apiKey)).status).toBe(404);
    expect((await request(app).post(`/api/media/999999/aliases`).set("X-Api-Key", apiKey).send({ title: "x" })).status).toBe(404);
  });

  it("does not store the item's own title as an alias", async () => {
    const id = await insertMovie("Own Title Film");
    const res = await request(app).post(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey).send({ title: "own title film" });
    expect(res.status).toBe(201);
    expect(res.body.filter((r: any) => r.source === "user")).toEqual([]);
  });
});

describe("rematch and add keep the alias index current", () => {
  it("drops the previous title after a rematch, since it is usually another work's, and rekeys the primary title", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMovie("Wrong Family Film", 2001);
    const { syncPrimaryTitle, storeAliases } = await import("../src/services/releaseAliases.js");
    await syncPrimaryTitle(id);
    // What the wrong match brought, and what the admin typed in, before the rematch.
    await storeAliases(id, ["Wrong Film Foreign Title"], "tmdb_alt");
    await storeAliases(id, ["My Own Name For It"], "user");

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Correct Film", year: 2001, externalIds: { tmdb: "2" } });
    expect(res.status).toBe(200);

    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([
      ["Correct Film", "primary"],
      ["My Own Name For It", "user"],
    ]);
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(id) as any).clean_title).toBe("correctfilm");
  });

  it("keeps the previous title as an 'original' alias when the rematch says it was one of the item's own names", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMovie("Folder Name Film", 2001);
    const { syncPrimaryTitle } = await import("../src/services/releaseAliases.js");
    await syncPrimaryTitle(id);

    const res = await request(app)
      .post(`/api/media/${id}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Correct Film Again", year: 2001, externalIds: { tmdb: "3" }, keepOldTitleAsAlias: true });
    expect(res.status).toBe(200);

    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([
      ["Folder Name Film", "original"],
      ["Correct Film Again", "primary"],
    ]);
  });

  it("keeps the previous title as an 'original' alias when the rematch says so for an item that was never keyed", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMovie("Never Keyed Film", 2001);

    const res = await request(app)
      .post(`/api/media/${id}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({ title: "Keyed Now Film", year: 2001, externalIds: { tmdb: "4" }, keepOldTitleAsAlias: true });
    expect(res.status).toBe(200);

    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([
      ["Never Keyed Film", "original"],
      ["Keyed Now Film", "primary"],
    ]);
  });

  it("keys a newly added item's title and asks the providers for its alternate titles", async () => {
    refreshProviderAliases.mockClear();
    const res = await request(app)
      .post("/api/media")
      .set("X-Api-Key", apiKey)
      .send({ type: "movie", title: "Freshly Added Film", year: 2020, externalIds: { tmdb: "77" } });
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(id) as any).clean_title).toBe("freshlyaddedfilm");
    expect(refreshProviderAliases).toHaveBeenCalledWith(id);
    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows).toMatchObject([{ title: "Freshly Added Film", source: "primary" }]);
  });
});
