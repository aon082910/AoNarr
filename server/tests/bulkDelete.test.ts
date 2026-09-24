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
    // Recycled after the delete has committed, so the item row (and the FK it would point at) is gone.
    expect(recycleFile).toHaveBeenCalledWith("/movies/one.mkv", "movie", "Bulk Delete With File", null);
  });

  it("recycles files only after the delete transaction has committed, so a slow file move can't block other transactions", async () => {
    // On SQLite the transaction is a bare BEGIN on the one shared connection — a recycle running
    // inside it would make this nested db.transaction() throw "cannot start a transaction within a
    // transaction", which is exactly what a concurrent request would have hit.
    const seen: { rowGone: boolean; nestedTxError: unknown }[] = [];
    let id1 = 0;
    recycleFile.mockReset().mockImplementation(async () => {
      let nestedTxError: unknown = null;
      try {
        await db.transaction(async () => {
          await db.prepare("SELECT 1").get();
        });
      } catch (err) {
        nestedTxError = err;
      }
      const row = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(id1);
      seen.push({ rowGone: !row, nestedTxError });
    });
    id1 = await insertMovie("Bulk Delete Deferred Recycle One", { has_file: 1, path: "/movies/deferred-one.mkv" });
    const id2 = await insertMovie("Bulk Delete Deferred Recycle Two", { has_file: 1, path: "/movies/deferred-two.mkv" });

    const res = await request(app)
      .post("/api/media/bulk/delete")
      .set("X-Api-Key", apiKey)
      .send({ mediaItemIds: [id1, id2], deleteFiles: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, skipped: 0 });
    expect(recycleFile.mock.calls.map((c) => c[0])).toEqual(["/movies/deferred-one.mkv", "/movies/deferred-two.mkv"]);
    expect(seen).toEqual([
      { rowGone: true, nestedTxError: null },
      { rowGone: true, nestedTxError: null },
    ]);
  });

  // SQLite-only trigger syntax; the transactional behavior under test is the route's, not the driver's.
  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("doesn't touch any file when the delete transaction rolls back", async () => {
    recycleFile.mockReset().mockResolvedValue(undefined);
    const id1 = await insertMovie("Bulk Delete Rollback", { has_file: 1, path: "/movies/rollback.mkv" });
    const id2 = await insertMovie("Bulk Delete Rollback Boom", { has_file: 1, path: "/movies/boom.mkv" });
    await db.exec(
      "CREATE TRIGGER bulk_delete_fail BEFORE DELETE ON media_items WHEN OLD.title = 'Bulk Delete Rollback Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END"
    );
    let res;
    try {
      res = await request(app)
        .post("/api/media/bulk/delete")
        .set("X-Api-Key", apiKey)
        .send({ mediaItemIds: [id1, id2], deleteFiles: true });
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS bulk_delete_fail");
    }

    expect(res.status).toBe(500);
    expect(recycleFile).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(id1)).toBeTruthy();
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
