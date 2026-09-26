import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function createProfile(name: string): Promise<number> {
  const res = await request(app)
    .post("/api/quality-profiles")
    .set("X-Api-Key", apiKey)
    .send({ name, allowedQualities: ["1080p"], cutoff: "1080p" });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("DELETE /api/quality-profiles/:id", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("409s while media items still use the profile, and leaves them on it", async () => {
    const profileId = await createProfile("In Use By Items");
    for (const title of ["Profile Movie A", "Profile Movie B"]) {
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, quality_profile_id) VALUES ('movie', ?, ?, ?)")
        .run(title, title.toLowerCase(), profileId);
    }

    const res = await request(app).delete(`/api/quality-profiles/${profileId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("2 media items");
    expect(await db.prepare("SELECT id FROM quality_profiles WHERE id = ?").get(profileId)).toBeDefined();
    const onProfile = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE quality_profile_id = ?").get(profileId)) as any;
    expect(Number(onProfile.c)).toBe(2);
  });

  it("409s while an import list still uses the profile", async () => {
    const profileId = await createProfile("In Use By List");
    await db
      .prepare("INSERT INTO import_lists (name, type, url, quality_profile_id) VALUES ('Profile List', 'rss', 'https://example.com/list', ?)")
      .run(profileId);

    const res = await request(app).delete(`/api/quality-profiles/${profileId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("1 import list");
    expect(await db.prepare("SELECT id FROM quality_profiles WHERE id = ?").get(profileId)).toBeDefined();
  });

  it("deletes a profile nothing uses", async () => {
    const profileId = await createProfile("Unused Profile");

    const res = await request(app).delete(`/api/quality-profiles/${profileId}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(await db.prepare("SELECT id FROM quality_profiles WHERE id = ?").get(profileId)).toBeUndefined();
  });

  it("404s for a profile that doesn't exist", async () => {
    const res = await request(app).delete("/api/quality-profiles/999999").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });
});
