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

async function insertGroup(mediaType: string, kind: string, name: string, parentId: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, parent_group_id) VALUES (?, ?, ?, ?, ?)")
        .run(mediaType, kind, name, name.toLowerCase(), parentId)
    ).lastInsertRowid
  );
}

// No media type defines groupLevels any more, but groups created earlier still exist and media
// items still point at them — reading one used to 400 for every kind.
describe("library groups without group levels", () => {
  it("GET /:id returns a legacy group as a leaf instead of 400ing", async () => {
    const id = await insertGroup("rom", "system", "Legacy System");
    const res = await request(app).get(`/api/library-groups/${id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.group).toMatchObject({ id, kind: "system", name: "Legacy System", itemCount: 0 });
    expect(res.body.breadcrumb.map((g: { id: number }) => g.id)).toEqual([id]);
    expect(res.body.isDeepestLevel).toBe(true);
    expect(res.body.nextKind).toBeNull();
  });

  it("GET /:id still builds the full breadcrumb for a nested legacy group", async () => {
    const parent = await insertGroup("rom", "system", "Nested System");
    const child = await insertGroup("rom", "maker", "Nested Maker", parent);
    const res = await request(app).get(`/api/library-groups/${child}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.breadcrumb.map((g: { id: number }) => g.id)).toEqual([parent, child]);
    expect(res.body.isDeepestLevel).toBe(true);
  });

  it("POST / answers 410 with a clear message instead of a misleading level error", async () => {
    const res = await request(app)
      .post("/api/library-groups")
      .set("X-Api-Key", apiKey)
      .send({ mediaType: "course", kind: "site", name: "Coursera", website: "coursera.org" });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no longer supported/);
    const created = await db.prepare("SELECT id FROM library_groups WHERE name = 'Coursera'").get();
    expect(created).toBeUndefined();
  });

  it("POST / still rejects an unknown media type with 400", async () => {
    const res = await request(app).post("/api/library-groups").set("X-Api-Key", apiKey).send({ mediaType: "nope", kind: "site", name: "X" });
    expect(res.status).toBe(400);
  });
});
