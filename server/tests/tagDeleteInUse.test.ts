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

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

async function createTag(name: string): Promise<number> {
  const res = await authed(request(app).post("/api/tags")).send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createItem(title: string): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 0, 'unknown')")
        .run(title, title.toLowerCase())
    ).lastInsertRowid
  );
}

// Starr refuses to delete a tag that is in use (TagService.cs). AoNarr used to delete the tag's delay
// profile with it (ON DELETE CASCADE) and widen a release profile scoped only to it to every item.
describe("DELETE /api/tags/:id for a tag that is in use (ST9)", () => {
  it("refuses with 409 and keeps the delay profile that is scoped to the tag", async () => {
    const tag = await createTag("kids-delay");
    const profile = Number(
      (await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes, torrent_delay_minutes) VALUES (?, 120, 240)").run(tag)).lastInsertRowid
    );

    const res = await authed(request(app).delete(`/api/tags/${tag}`));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/delay profile/i);
    expect(await db.prepare("SELECT id FROM tags WHERE id = ?").get(tag)).toBeTruthy();
    expect(await db.prepare("SELECT id FROM delay_profiles WHERE id = ?").get(profile)).toBeTruthy();
  });

  it("refuses with 409 and names the release profile scoped to the tag, leaving its scope as it was", async () => {
    const tag = await createTag("kids-release");
    const other = await createTag("teens-release");
    const only = (await authed(request(app).post("/api/release-profiles")).send({ name: "no-horror-for-kids", mustNotContain: ["horror"], tagIds: [tag] })).body.id;
    const both = (await authed(request(app).post("/api/release-profiles")).send({ name: "kids-and-teens", mustNotContain: ["gore"], tagIds: [tag, other] })).body.id;

    const res = await authed(request(app).delete(`/api/tags/${tag}`));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no-horror-for-kids");
    expect(res.body.error).toContain("kids-and-teens");
    expect(res.body.usage.releaseProfiles.map((p: any) => p.name).sort()).toEqual(["kids-and-teens", "no-horror-for-kids"]);
    const rows = (await db.prepare("SELECT id, tag_ids FROM release_profiles WHERE id IN (?, ?)").all(only, both)) as { id: number; tag_ids: string }[];
    expect(rows.map((r) => JSON.parse(r.tag_ids)).sort()).toEqual([[tag], [tag, other]].sort());
  });

  it("refuses a tag that carries a retention period while items are tagged with it", async () => {
    const tag = await createTag("keep-longer");
    await authed(request(app).patch(`/api/tags/${tag}`)).send({ retentionDays: 365 }).expect(200);
    const item = await createItem("Tagged Movie");
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(item, tag);

    const res = await authed(request(app).delete(`/api/tags/${tag}`));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/retention/i);
    expect(res.body.usage.items).toBe(1);
  });

  it("deletes a tag that is only attached to items, and detaches it from them", async () => {
    const tag = await createTag("plain-label");
    const item = await createItem("Labelled Movie");
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(item, tag);

    await authed(request(app).delete(`/api/tags/${tag}`)).expect(204);

    expect(await db.prepare("SELECT 1 FROM media_item_tags WHERE tag_id = ?").get(tag)).toBeFalsy();
  });

  it("deletes the tag once the profiles that used it are gone", async () => {
    const tag = await createTag("freed");
    const profile = (await authed(request(app).post("/api/release-profiles")).send({ name: "uses-freed", mustNotContain: ["x"], tagIds: [tag] })).body.id;
    await authed(request(app).delete(`/api/tags/${tag}`)).expect(409);

    await authed(request(app).delete(`/api/release-profiles/${profile}`)).expect(204);
    await authed(request(app).delete(`/api/tags/${tag}`)).expect(204);
  });

  it("still returns 404 for an unknown tag", async () => {
    await authed(request(app).delete("/api/tags/999999")).expect(404);
  });
});
