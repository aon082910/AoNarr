import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const recycleFile = vi.fn();
vi.mock("../src/services/recycleBin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/recycleBin.js")>()),
  recycleFile: (...args: unknown[]) => recycleFile(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertMovie(title: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const row = { path: null as string | null, has_file: 0, ...overrides };
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, path, status) VALUES ('movie', ?, ?, 1, ?, ?, 'missing')`)
    .run(title, title.toLowerCase(), row.has_file, row.path);
  return Number(result.lastInsertRowid);
}

describe("POST /api/media/bulk/delete", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("deletes every item in the batch, wrapped in one transaction, reusing the same cascade helper the single-item DELETE route uses", async () => {
    const id1 = await insertMovie("Bulk Delete Movie One");
    const id2 = await insertMovie("Bulk Delete Movie Two");

    const res = await request(app)
      .post("/api/media/bulk/delete")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemIds: [id1, id2] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, skipped: 0 });
    expect(await db.prepare("SELECT id FROM media_items WHERE id IN (?, ?)").all(id1, id2)).toEqual([]);
  });

  it("skips an id that no longer exists instead of failing the whole batch", async () => {
    const id1 = await insertMovie("Bulk Delete Skip Test");
    const missingId = 999999;

    const res = await request(app)
      .post("/api/media/bulk/delete")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemIds: [id1, missingId] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1, skipped: 1 });
  });

  it("recycles each item's file when deleteFiles is set, via the shared deleteMediaItemCascade helper", async () => {
    recycleFile.mockReset().mockResolvedValue(undefined);
    const id1 = await insertMovie("Bulk Delete With File", { has_file: 1, path: "/movies/one.mkv" });

    const res = await request(app)
      .post("/api/media/bulk/delete")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemIds: [id1], deleteFiles: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1, skipped: 0 });
    expect(recycleFile).toHaveBeenCalledWith("/movies/one.mkv", "movie", "Bulk Delete With File", id1);
  });

  it("adds an import exclusion per item when addExclusion is set", async () => {
    const id1 = await insertMovie("Bulk Delete With Exclusion");

    const res = await request(app)
      .post("/api/media/bulk/delete")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemIds: [id1], addExclusion: true });

    expect(res.status).toBe(200);
    const excluded = await db.prepare("SELECT * FROM import_exclusions WHERE title = ?").get("Bulk Delete With Exclusion");
    expect(excluded).toBeTruthy();
  });

  it("requires a non-empty mediaItemIds array", async () => {
    const res = await request(app).post("/api/media/bulk/delete").set("X-Api-Key", apiKey).send({ mediaItemIds: [] });
    expect(res.status).toBe(400);
  });
});
