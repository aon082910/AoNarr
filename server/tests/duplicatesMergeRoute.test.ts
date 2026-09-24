import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

async function insertAdult(title: string, legacyShape: string | null, hasFile: 0 | 1, path: string | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, path, status, legacy_shape) VALUES ('adult', ?, ?, 2020, 1, ?, ?, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), hasFile, path, legacyShape)
    ).lastInsertRowid
  );
}

// The Duplicates page groups a legacy item with a converted one; merging them is skipped to keep
// the loser's files, and without these ids in the response the page couldn't say why nothing merged.
describe("POST /api/duplicates/merge — shape-mismatched losers", () => {
  it("returns the skipped loser ids and leaves those items in place", async () => {
    const keeperId = await insertAdult("Route Mixed Shape", null, 0);
    const compatibleId = await insertAdult("Route Mixed Shape", null, 0);
    const legacyId = await insertAdult("Route Mixed Shape", "single", 1, "/adult/route-mixed.mp4");

    const res = await request(app)
      .post("/api/duplicates/merge")
      .set("X-Api-Key", apiKey)
      .send({ keeperId, loserIds: [compatibleId, legacyId], deleteFiles: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ merged: 1, skippedShapeMismatch: [legacyId] });
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(compatibleId)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(legacyId)).toBeDefined();
  });

  it("returns an empty skippedShapeMismatch when every loser merged", async () => {
    const keeperId = await insertAdult("Route Same Shape", null, 0);
    const loserId = await insertAdult("Route Same Shape", null, 0);

    const res = await request(app).post("/api/duplicates/merge").set("X-Api-Key", apiKey).send({ keeperId, loserIds: [loserId] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ merged: 1, skippedShapeMismatch: [] });
  });
});
