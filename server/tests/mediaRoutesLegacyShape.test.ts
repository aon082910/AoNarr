import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertCourse(title: string, legacyShape: string | null): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, legacy_shape) VALUES ('course', ?, ?, 1, 1, 'downloaded', ?)`)
    .run(title, title.toLowerCase(), legacyShape);
  return Number(result.lastInsertRowid);
}

describe("GET /api/media/:id children for a course's shape", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("returns a not-yet-converted course's lessons from sub_items", async () => {
    const id = await insertCourse("Legacy Rust Course", "collection");
    for (const [i, title] of ["Ownership", "Borrowing"].entries()) {
      await db
        .prepare(`INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file, file_path) VALUES (?, ?, ?, 1, 1, ?)`)
        .run(id, title, `2020-01-0${i + 1}`, `/courses/Legacy Rust Course/${title}.mp4`);
    }

    const res = await request(app).get(`/api/media/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.legacyShape).toBe("collection");
    expect(res.body.children.map((c: any) => c.title)).toEqual(["Ownership", "Borrowing"]);
    expect(res.body.seasons).toEqual([]);
  });

  it("returns a converted course's lessons from episodes", async () => {
    const id = await insertCourse("Converted Go Course", null);
    await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored) VALUES (?, 1, 1, 'Goroutines', 1)`).run(id);

    const res = await request(app).get(`/api/media/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.children.map((c: any) => c.title)).toEqual(["Goroutines"]);
  });
});
