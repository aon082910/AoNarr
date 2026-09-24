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

async function createTag(name: string): Promise<number> {
  const res = await request(app).post("/api/tags").set("X-Api-Key", apiKey).send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createIndexer(name: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES (?, 'torrent', ?)").run(name, `http://${name.toLowerCase()}.invalid`))
      .lastInsertRowid
  );
}

async function createProfile(body: Record<string, unknown>): Promise<number> {
  const res = await request(app).post("/api/release-profiles").set("X-Api-Key", apiKey).send(body);
  expect(res.status).toBe(201);
  return res.body.id;
}

async function rawScope(profileId: number): Promise<{ tag_ids: string | null; indexer_ids: string | null }> {
  return (await db.prepare("SELECT tag_ids, indexer_ids FROM release_profiles WHERE id = ?").get(profileId)) as {
    tag_ids: string | null;
    indexer_ids: string | null;
  };
}

// tag_ids/indexer_ids are JSON arrays with no foreign key: a profile scoped only to a deleted id
// used to match nothing ever again, while the Settings UI showed it as unrestricted.
describe("deleting a tag or indexer that release profiles are scoped to", () => {
  it("drops the deleted tag id from every profile, clearing the scope once none are left", async () => {
    const kids = await createTag("kids");
    const teens = await createTag("teens");
    const onlyKids = await createProfile({ name: "Only Kids", mustNotContain: ["KIDSONLYTERM"], tagIds: [kids] });
    const both = await createProfile({ name: "Kids And Teens", mustNotContain: ["BOTHTAGSTERM"], tagIds: [kids, teens] });

    const res = await request(app).delete(`/api/tags/${kids}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    expect((await rawScope(onlyKids)).tag_ids).toBeNull();
    expect(JSON.parse((await rawScope(both)).tag_ids!)).toEqual([teens]);
  });

  it("makes a profile scoped only to the deleted tag apply to every item again", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    const tag = await createTag("doomed");
    await createProfile({ name: "No Banned Term", mustNotContain: ["TAGSCOPEDTERM"], tagIds: [tag] });
    const untaggedItemId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Untagged Movie', 'untagged movie', 1, 0, 'unknown')")
          .run()
      ).lastInsertRowid
    );
    const title = "Untagged.Movie.2020.TAGSCOPEDTERM.x264";

    expect((await scoreRelease(title, null, null, "movie", null, untaggedItemId, null)).rejected).toBe(false);

    await request(app).delete(`/api/tags/${tag}`).set("X-Api-Key", apiKey).expect(204);

    const after = await scoreRelease(title, null, null, "movie", null, untaggedItemId, null);
    expect(after.rejected).toBe(true);
    expect(after.rejectReason).toContain("No Banned Term");
  });

  it("drops the deleted indexer id from every profile the same way", async () => {
    const idxA = await createIndexer("IdxA");
    const idxB = await createIndexer("IdxB");
    const onlyA = await createProfile({ name: "Only A", mustNotContain: ["ONLYATERM"], indexerIds: [idxA] });
    const both = await createProfile({ name: "A And B", mustNotContain: ["BOTHINDEXERSTERM"], indexerIds: [idxA, idxB] });
    const unrelated = await createProfile({ name: "Only B", mustNotContain: ["ONLYBTERM"], indexerIds: [idxB] });

    const res = await request(app).delete(`/api/indexers/${idxA}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    expect((await rawScope(onlyA)).indexer_ids).toBeNull();
    expect(JSON.parse((await rawScope(both)).indexer_ids!)).toEqual([idxB]);
    expect(JSON.parse((await rawScope(unrelated)).indexer_ids!)).toEqual([idxB]);
  });

  it("still returns 404 for a tag or indexer that doesn't exist", async () => {
    await request(app).delete("/api/tags/999999").set("X-Api-Key", apiKey).expect(404);
    await request(app).delete("/api/indexers/999999").set("X-Api-Key", apiKey).expect(404);
  });
});
