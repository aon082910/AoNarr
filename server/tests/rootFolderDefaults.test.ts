import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let rootDir: string;
let rootId: number;
let defaults: typeof import("../src/services/rootFolderDefaults.js");
let finishWantedAdd: (typeof import("../src/services/addDefaults.js"))["finishWantedAdd"];
let isRootFolderOverQuota: (typeof import("../src/services/rootFolderSelect.js"))["isRootFolderOverQuota"];
let profileId: number;
let metadataProfileId: number;
let tagA: number;
let tagB: number;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  defaults = await import("../src/services/rootFolderDefaults.js");
  ({ finishWantedAdd } = await import("../src/services/addDefaults.js"));
  ({ isRootFolderOverQuota } = await import("../src/services/rootFolderSelect.js"));
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-rootdefaults-"));
});

beforeEach(async () => {
  for (const t of ["media_item_tags", "media_items", "root_folders", "tags", "metadata_profiles", "quality_profiles"]) await db.prepare(`DELETE FROM ${t}`).run();
  rootId = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(rootDir)).lastInsertRowid);
  profileId = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Folder Profile', '[\"SD\"]', 'SD')").run()).lastInsertRowid);
  metadataProfileId = Number((await db.prepare("INSERT INTO metadata_profiles (name) VALUES ('Standard')").run()).lastInsertRowid);
  tagA = Number((await db.prepare("INSERT INTO tags (name) VALUES ('a')").run()).lastInsertRowid);
  tagB = Number((await db.prepare("INSERT INTO tags (name) VALUES ('b')").run()).lastInsertRowid);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const patchRoot = (body: unknown) => request(app as any).patch(`/api/root-folders/${rootId}`).set("X-Api-Key", apiKey).send(body);

describe("root folder defaults (ST25)", () => {
  it("stores the defaults the folder gives what is added into it", async () => {
    const res = await patchRoot({
      defaultQualityProfileId: profileId,
      defaultMetadataProfileId: metadataProfileId,
      defaultMonitor: "future",
      defaultMonitorNewItems: "new",
      defaultTagIds: [tagA],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      defaultQualityProfileId: profileId,
      defaultMetadataProfileId: metadataProfileId,
      defaultMonitor: "future",
      defaultMonitorNewItems: "new",
      defaultTagIds: [tagA],
    });
    const cleared = await patchRoot({ defaultQualityProfileId: null, defaultTagIds: [] });
    expect(cleared.body.defaultQualityProfileId).toBeNull();
    expect(cleared.body.defaultTagIds).toEqual([]);
  });

  it("rejects a profile that does not exist, an unknown monitor choice and a missing tag", async () => {
    expect((await patchRoot({ defaultQualityProfileId: 99999 })).status).toBe(400);
    expect((await patchRoot({ defaultMetadataProfileId: 99999 })).status).toBe(400);
    expect((await patchRoot({ defaultMonitor: "whenever" })).status).toBe(400);
    expect((await patchRoot({ defaultMonitorNewItems: "some" })).status).toBe(400);
    expect((await patchRoot({ defaultTagIds: [99999] })).status).toBe(400);
  });

  it("applyRootFolderDefaults fills what the item left empty and keeps what it has", async () => {
    await patchRoot({ defaultQualityProfileId: profileId, defaultMonitorNewItems: "none", defaultTagIds: [tagA, tagB] });
    const empty = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, status) VALUES ('movie', 'Empty', 'empty', ?, 1, 'missing')").run(rootId)).lastInsertRowid);
    const set = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, status, monitor_new_items) VALUES ('movie', 'Set', 'set', ?, 1, 'missing', 'all')").run(rootId)).lastInsertRowid
    );

    await defaults.applyRootFolderDefaults(empty);
    await defaults.applyRootFolderDefaults(set);

    const row = async (id: number) => (await db.prepare("SELECT quality_profile_id, monitor_new_items FROM media_items WHERE id = ?").get(id)) as any;
    expect(Number((await row(empty)).quality_profile_id)).toBe(profileId);
    expect((await row(empty)).monitor_new_items).toBe("none");
    expect((await row(set)).monitor_new_items).toBe("all");
    const tags = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ? ORDER BY tag_id").all(empty)) as any[];
    expect(tags.map((t) => Number(t.tag_id))).toEqual([tagA, tagB]);
  });

  it("every wanted add goes through them: finishWantedAdd applies the folder's defaults", async () => {
    await patchRoot({ defaultTagIds: [tagB] });
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, status) VALUES ('movie', 'Listed', 'listed', ?, 1, 'missing')").run(rootId)).lastInsertRowid);
    await finishWantedAdd(id);
    const tags = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(id)) as any[];
    expect(tags.map((t) => Number(t.tag_id))).toEqual([tagB]);
  });

  it("a hand add into the folder takes its tags and a request's own tags", async () => {
    await patchRoot({ defaultTagIds: [tagA] });
    const res = await request(app as any)
      .post("/api/media")
      .set("X-Api-Key", apiKey)
      .send({ type: "movie", title: "By Hand", year: 2020, rootFolderId: rootId, tagIds: [tagB] });
    expect(res.status).toBe(201);
    const tags = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ? ORDER BY tag_id").all(res.body.id)) as any[];
    expect(tags.map((t) => Number(t.tag_id))).toEqual([tagA, tagB]);
  });

  it("an Add that names a metadata profile or a monitor-new-items choice stores them; a bad one is refused", async () => {
    const res = await request(app as any)
      .post("/api/metadata/import")
      .set("X-Api-Key", apiKey)
      .send({ type: "movie", title: "Chosen", year: 2021, rootFolderId: rootId, metadataProfileId, monitorNewItems: "none", confirmDuplicate: true });
    expect(res.status).toBe(201);
    expect(Number(res.body.metadataProfileId)).toBe(metadataProfileId);
    expect(res.body.monitorNewItems).toBe("none");

    const bad = await request(app as any).post("/api/metadata/import").set("X-Api-Key", apiKey).send({ type: "movie", title: "Bad", rootFolderId: rootId, monitorNewItems: "some", confirmDuplicate: true });
    expect(bad.status).toBe(400);
    const badProfile = await request(app as any).post("/api/metadata/import").set("X-Api-Key", apiKey).send({ type: "movie", title: "Bad2", rootFolderId: rootId, metadataProfileId: 99999, confirmDuplicate: true });
    expect(badProfile.status).toBe(400);
  });

  it("a hand add with a tag that does not exist is refused before anything is added (L3)", async () => {
    const before = Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c);
    const res = await request(app as any).post("/api/media").set("X-Api-Key", apiKey).send({ type: "movie", title: "Half Added", year: 2020, rootFolderId: rootId, tagIds: [99999] });
    expect(res.status).toBe(400);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(before);
  });

  it("an item's own choices are editable", async () => {
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('artist', 'Band', 'band', 1, 'missing')").run()).lastInsertRowid);
    const ok = await request(app as any).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ monitorNewItems: "new", metadataProfileId });
    expect(ok.status).toBe(200);
    expect(ok.body.monitorNewItems).toBe("new");
    expect(Number(ok.body.metadataProfileId)).toBe(metadataProfileId);
    expect((await request(app as any).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ monitorNewItems: "weekly" })).status).toBe(400);
    expect((await request(app as any).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ metadataProfileId: 99999 })).status).toBe(400);
  });
});

describe("a root folder's minimum free space stops grabs (ST25)", () => {
  const stat = (freeGb: number) => ({ blocks: 1000 * 1024 ** 3 / 4096, bfree: (freeGb * 1024 ** 3) / 4096, bavail: (freeGb * 1024 ** 3) / 4096, bsize: 4096 });

  it("is not over when the folder has no minimum and no quota", async () => {
    vi.spyOn(fs.promises, "statfs").mockImplementation((async () => stat(1)) as any);
    expect(await isRootFolderOverQuota(rootId)).toBe(false);
  });

  it("is over when less than the minimum is free, even with no quota set", async () => {
    await db.prepare("UPDATE root_folders SET min_free_space_gb = 50 WHERE id = ?").run(rootId);
    vi.spyOn(fs.promises, "statfs").mockImplementation((async () => stat(10)) as any);
    expect(await isRootFolderOverQuota(rootId)).toBe(true);
  });

  it("is not over when at least the minimum is free", async () => {
    await db.prepare("UPDATE root_folders SET min_free_space_gb = 50 WHERE id = ?").run(rootId);
    vi.spyOn(fs.promises, "statfs").mockImplementation((async () => stat(80)) as any);
    expect(await isRootFolderOverQuota(rootId)).toBe(false);
  });

  it("an unreachable folder is never treated as full", async () => {
    await db.prepare("UPDATE root_folders SET min_free_space_gb = 50 WHERE id = ?").run(rootId);
    vi.spyOn(fs.promises, "statfs").mockImplementation((async () => {
      throw new Error("gone");
    }) as any);
    expect(await isRootFolderOverQuota(rootId)).toBe(false);
  });

  it("still pauses at the quota as before", async () => {
    await db.prepare("UPDATE root_folders SET quota_percent = 90, pause_grabs_at_quota = 1 WHERE id = ?").run(rootId);
    vi.spyOn(fs.promises, "statfs").mockImplementation((async () => stat(50)) as any); // 95% used
    expect(await isRootFolderOverQuota(rootId)).toBe(true);
  });
});
