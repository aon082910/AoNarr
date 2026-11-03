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

async function tagId(name: string): Promise<number> {
  return (await db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number }).id;
}

describe("the settings template carries delay profiles, release profiles and tags (ST19)", () => {
  it("exports them, with the tag of each profile by name instead of by id", async () => {
    const kids = (await authed(request(app).post("/api/tags")).send({ name: "tpl-kids" })).body.id;
    await authed(request(app).patch(`/api/tags/${kids}`)).send({ retentionDays: 90 });
    await db
      .prepare(
        `INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, order_index, preferred_protocol)
         VALUES (?, 1, 1, 120, 240, 0, 'usenet')`
      )
      .run(kids);
    await authed(request(app).post("/api/release-profiles")).send({
      name: "tpl-no-horror",
      mustNotContain: ["horror"],
      preferred: [{ term: "REMUX", score: 50 }],
      mediaTypes: ["movie"],
      tagIds: [kids],
      indexerIds: [9999],
    });

    const res = await authed(request(app).get("/api/settings/template/export"));

    expect(res.status).toBe(200);
    expect(res.body.templateVersion).toBe(2);
    expect(res.body.tags).toEqual(expect.arrayContaining([{ name: "tpl-kids", retentionDays: 90 }]));
    expect(res.body.delayProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagName: "tpl-kids", usenetDelayMinutes: 120, torrentDelayMinutes: 240, preferredProtocol: "usenet" }),
      ])
    );
    const release = res.body.releaseProfiles.find((p: any) => p.name === "tpl-no-horror");
    expect(release).toMatchObject({ mustNotContain: ["horror"], mediaTypes: ["movie"], tagNames: ["tpl-kids"] });
    expect(release.preferred).toEqual([{ term: "REMUX", score: 50 }]);
    // Indexers belong to one instance, so a profile's indexer scope is not exported.
    expect(release.indexerIds).toBeUndefined();
  });

  it("imports into an empty instance: the tags first, then the profiles that name them", async () => {
    const exported = (await authed(request(app).get("/api/settings/template/export"))).body;
    await db.prepare("DELETE FROM delay_profiles").run();
    await db.prepare("DELETE FROM release_profiles").run();
    await db.prepare("DELETE FROM tags").run();

    const res = await authed(request(app).post("/api/settings/template/import")).send(exported);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tagsImported: 1, delayProfilesImported: 1, releaseProfilesImported: 1 });
    const kids = await tagId("tpl-kids");
    const tag = (await db.prepare("SELECT retention_days FROM tags WHERE id = ?").get(kids)) as { retention_days: number };
    expect(Number(tag.retention_days)).toBe(90);
    const delay = (await db.prepare("SELECT * FROM delay_profiles WHERE tag_id = ?").get(kids)) as any;
    expect(Number(delay.usenet_delay_minutes)).toBe(120);
    expect(delay.preferred_protocol).toBe("usenet");
    const release = (await db.prepare("SELECT * FROM release_profiles WHERE name = 'tpl-no-horror'").get()) as any;
    expect(JSON.parse(release.tag_ids)).toEqual([kids]);
    expect(release.indexer_ids).toBeNull();
    expect(JSON.parse(release.must_not_contain)).toEqual(["horror"]);
  });

  it("importing the same template twice updates in place instead of piling up copies", async () => {
    const exported = (await authed(request(app).get("/api/settings/template/export"))).body;

    await authed(request(app).post("/api/settings/template/import")).send(exported).expect(200);
    await authed(request(app).post("/api/settings/template/import")).send(exported).expect(200);

    const releaseCount = (await db.prepare("SELECT COUNT(*) AS c FROM release_profiles WHERE name = 'tpl-no-horror'").get()) as { c: number | string };
    const delayCount = (await db.prepare("SELECT COUNT(*) AS c FROM delay_profiles WHERE tag_id = ?").get(await tagId("tpl-kids"))) as { c: number | string };
    const tagCount = (await db.prepare("SELECT COUNT(*) AS c FROM tags WHERE name = 'tpl-kids'").get()) as { c: number | string };
    expect([Number(releaseCount.c), Number(delayCount.c), Number(tagCount.c)]).toEqual([1, 1, 1]);
  });

  it("still accepts a version 1 template that has none of the new sections", async () => {
    const res = await authed(request(app).post("/api/settings/template/import")).send({
      templateVersion: 1,
      qualities: [],
      qualityProfiles: [],
      customFormats: [],
      formatScores: [],
      namingTemplates: {},
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tagsImported: 0, delayProfilesImported: 0, releaseProfilesImported: 0 });
  });

  it("matches the default delay profile (no tag) by that, and skips a profile whose tag name it cannot create", async () => {
    await db.prepare("DELETE FROM delay_profiles").run();

    await authed(request(app).post("/api/settings/template/import"))
      .send({
        templateVersion: 2,
        delayProfiles: [
          { tagName: null, enableUsenet: true, enableTorrent: true, usenetDelayMinutes: 5, torrentDelayMinutes: 10, orderIndex: 99, preferredProtocol: "torrent" },
          { tagName: "   ", usenetDelayMinutes: 1, torrentDelayMinutes: 1 },
        ],
      })
      .expect(200);

    const rows = (await db.prepare("SELECT tag_id, usenet_delay_minutes FROM delay_profiles").all()) as { tag_id: number | null; usenet_delay_minutes: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tag_id).toBeNull();
    expect(Number(rows[0].usenet_delay_minutes)).toBe(5);
  });
});

// Review F1, F2, F6, F11 of Round 23.
describe("the settings template keeps what it must (review F1, F2, F6, F11)", () => {
  const importTemplate = (body: Record<string, unknown>) => authed(request(app).post("/api/settings/template/import")).send({ templateVersion: 2, ...body });

  it("carries a tag's 'never archive' retention of -1 across an export and an import", async () => {
    await db.prepare("DELETE FROM tags").run();
    const tag = (await authed(request(app).post("/api/tags")).send({ name: "tpl-never" })).body.id;
    await db.prepare("UPDATE tags SET retention_days = -1 WHERE id = ?").run(tag);
    const exported = (await authed(request(app).get("/api/settings/template/export"))).body;
    expect(exported.tags).toEqual(expect.arrayContaining([{ name: "tpl-never", retentionDays: -1 }]));
    await db.prepare("DELETE FROM tags").run();

    await importTemplate({ tags: exported.tags }).expect(200);

    const row = (await db.prepare("SELECT retention_days FROM tags WHERE name = 'tpl-never'").get()) as { retention_days: number };
    expect(Number(row.retention_days)).toBe(-1);
  });

  it("brings in a release profile that was scoped to indexers switched off, with no indexer scope", async () => {
    await db.prepare("DELETE FROM release_profiles").run();

    await importTemplate({ releaseProfiles: [{ name: "only-one-tracker", enabled: true, mustNotContain: ["x265"], indexerScoped: true }] }).expect(200);

    const row = (await db.prepare("SELECT enabled, indexer_ids FROM release_profiles WHERE name = 'only-one-tracker'").get()) as any;
    expect(Number(row.enabled)).toBe(0);
    expect(row.indexer_ids).toBeNull();
  });

  it("leaves an existing profile's on/off state and indexer scope alone when the template's copy was indexer-scoped", async () => {
    await db.prepare("DELETE FROM release_profiles").run();
    await db.prepare("INSERT INTO release_profiles (name, enabled, must_not_contain, indexer_ids) VALUES ('scoped-here', 1, '[\"cam\"]', '[7]')").run();

    await importTemplate({ releaseProfiles: [{ name: "scoped-here", enabled: false, mustNotContain: ["hdcam"], indexerScoped: true }] }).expect(200);

    const row = (await db.prepare("SELECT enabled, indexer_ids, must_not_contain FROM release_profiles WHERE name = 'scoped-here'").get()) as any;
    expect(Number(row.enabled)).toBe(1);
    expect(row.indexer_ids).toBe("[7]");
    expect(JSON.parse(row.must_not_contain)).toEqual(["hdcam"]);
  });

  it("keeps two release profiles with one name apart, and does not add copies on a second import", async () => {
    await db.prepare("DELETE FROM release_profiles").run();
    const template = {
      releaseProfiles: [
        { name: "Block CAM", mustNotContain: ["CAM"] },
        { name: "Block CAM", mustNotContain: ["TS", "HDCAM"] },
      ],
    };

    const first = await importTemplate(template).expect(200);
    const second = await importTemplate(template).expect(200);

    expect(first.body).toMatchObject({ releaseProfilesImported: 2, releaseProfilesCreated: 2 });
    expect(second.body).toMatchObject({ releaseProfilesImported: 2, releaseProfilesCreated: 0 });
    const rows = (await db.prepare("SELECT must_not_contain FROM release_profiles WHERE name = 'Block CAM' ORDER BY id").all()) as { must_not_contain: string }[];
    expect(rows.map((r) => JSON.parse(r.must_not_contain))).toEqual([["CAM"], ["TS", "HDCAM"]]);
  });

  it("exports the size mode with the quality sizes, and an import sets it, so the numbers keep their meaning", async () => {
    const { setSetting, getSetting } = await import("../src/services/settingsStore.js");
    setSetting("sizeLimitMode", "perMinute");
    const exported = (await authed(request(app).get("/api/settings/template/export"))).body;
    expect(exported.sizeLimitMode).toBe("perMinute");

    setSetting("sizeLimitMode", "absolute");
    await importTemplate({ sizeLimitMode: "perMinute", qualities: exported.qualities }).expect(200);
    expect(getSetting("sizeLimitMode")).toBe("perMinute");

    await importTemplate({ sizeLimitMode: "absolute", qualities: exported.qualities }).expect(200);
    expect(getSetting("sizeLimitMode")).toBe("absolute");

    // A template without qualities, or without a mode, leaves the instance's mode alone.
    await importTemplate({ sizeLimitMode: "perMinute" }).expect(200);
    expect(getSetting("sizeLimitMode")).toBe("absolute");
    await importTemplate({ qualities: exported.qualities }).expect(200);
    expect(getSetting("sizeLimitMode")).toBe("absolute");
  });

  it("ignores odd delay profile entries instead of resetting the default profile or failing with a 500", async () => {
    await db.prepare("DELETE FROM delay_profiles").run();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes, torrent_delay_minutes) VALUES (NULL, 120, 240)").run();

    await importTemplate({ delayProfiles: [{}, null, "text", 5, { tagName: "x" }] }).expect(200);

    const row = (await db.prepare("SELECT usenet_delay_minutes, torrent_delay_minutes FROM delay_profiles WHERE tag_id IS NULL").get()) as any;
    expect([Number(row.usenet_delay_minutes), Number(row.torrent_delay_minutes)]).toEqual([120, 240]);
  });

  it("falls back to no delay for a number past the integer limit, instead of storing it or failing on Postgres", async () => {
    await db.prepare("DELETE FROM delay_profiles").run();

    await importTemplate({ delayProfiles: [{ tagName: null, usenetDelayMinutes: 1e12, torrentDelayMinutes: 30 }] }).expect(200);

    const row = (await db.prepare("SELECT usenet_delay_minutes, torrent_delay_minutes FROM delay_profiles WHERE tag_id IS NULL").get()) as any;
    expect([Number(row.usenet_delay_minutes), Number(row.torrent_delay_minutes)]).toEqual([0, 30]);
  });

  it("skips entries in the other lists that are not objects", async () => {
    await importTemplate({ tags: [null, 3, { name: "tpl-ok" }], releaseProfiles: [null, "x"] }).expect(200);
    expect(await db.prepare("SELECT id FROM tags WHERE name = 'tpl-ok'").get()).toBeTruthy();
  });
});
