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

  it("drops the 'original' rows an earlier refresh or merge left, and the lookup's markers, on a rematch (I19)", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertMovie("Extraction 2", 2023);
    const { syncPrimaryTitle, storeAliases } = await import("../src/services/releaseAliases.js");
    await syncPrimaryTitle(id);
    // Another film's name, added when a duplicate was merged into this row, and what the old match told us.
    await storeAliases(id, ["Extraction"], "original");
    await db
      .prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?")
      .run(JSON.stringify({ aliasesCheckedAt: "2026-10-01T00:00:00.000Z", aliasesVersion: 2, originCountry: ["US"], keep: "me" }), id);

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Extraction", year: 2020, externalIds: { tmdb: "5" } });
    expect(res.status).toBe(200);

    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([["Extraction", "primary"]]);
    const extra = JSON.parse(((await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string }).extra_metadata);
    expect(extra).toMatchObject({ keep: "me" });
    expect(extra.aliasesCheckedAt).toBeUndefined();
    expect(extra.aliasesVersion).toBeUndefined();
    expect(extra.originCountry).toBeUndefined();
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

describe("renaming an item re-keys its aliases (I18)", () => {
  it("keeps the old title as an alias, makes the new one primary, and keys the new title at once", async () => {
    const id = await insertMovie("The Rename Show", 2005);
    const { syncPrimaryTitle } = await import("../src/services/releaseAliases.js");
    await syncPrimaryTitle(id);

    const patched = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ title: "The Rename Show (US)" });
    expect(patched.status).toBe(200);
    expect(((await db.prepare("SELECT clean_title FROM media_items WHERE id = ?").get(id)) as { clean_title: string }).clean_title).toBe("renameshowus");

    // Before the fix the old title stayed the primary row until the next start, which dropped it.
    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([
      ["The Rename Show", "original"],
      ["The Rename Show (US)", "primary"],
    ]);
  });

  it("leaves the aliases alone when the edit does not change the title", async () => {
    const id = await insertMovie("Same Title Film", 2005);
    const { syncPrimaryTitle, storeAliases } = await import("../src/services/releaseAliases.js");
    await syncPrimaryTitle(id);
    await storeAliases(id, ["Other Name"], "user");
    const res = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ title: "Same Title Film", monitored: 0 });
    expect(res.status).toBe(200);
    const rows = (await request(app).get(`/api/media/${id}/aliases`).set("X-Api-Key", apiKey)).body;
    expect(rows.map((r: any) => [r.title, r.source])).toEqual([
      ["Same Title Film", "primary"],
      ["Other Name", "user"],
    ]);
  });
});
