import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let q: typeof import("../src/services/quality.js");
let rules: typeof import("../src/services/upgradeRules.js");
let sched: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  q = await import("../src/services/quality.js");
  rules = await import("../src/services/upgradeRules.js");
  sched = await import("../src/services/scheduler.js");
  await q.loadQualityCaches();
});

const GROUPS = [["WEBDL-1080p", "WEBRip-1080p"]];

function release(title: string, seeders = 50): any {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title,
    size: 4_000_000_000,
    seeders,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: "magnet:?xt=urn:btih:abc",
    protocol: "torrent",
    category: null,
  };
}

async function profileWithGroups(groups: string[][], over: Record<string, unknown> = {}): Promise<number> {
  const result = await db
    .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups) VALUES (?, ?, ?, ?)")
    .run(
      `groups-${Math.random().toString(36).slice(2)}`,
      JSON.stringify((over.allowed as string[]) ?? ["HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p"]),
      (over.cutoff as string) ?? "Bluray-1080p",
      JSON.stringify(groups)
    );
  return Number(result.lastInsertRowid);
}

describe("quality groups (Round 13, D16)", () => {
  it("reads only well-formed groups", () => {
    expect(q.parseQualityGroups(JSON.stringify(GROUPS))).toEqual(GROUPS);
    expect(q.parseQualityGroups("not json")).toEqual([]);
    expect(q.parseQualityGroups([["A"], ["B", "B"], "x", ["C", "D"], ["D", "E"]])).toEqual([["C", "D"]]);
    expect(q.parseQualityGroups(null)).toEqual([]);
  });

  it("ranks a group as its best member, and leaves other qualities alone", () => {
    expect(q.qualityRank("WEBRip-1080p")).toBeLessThan(q.qualityRank("WEBDL-1080p"));
    expect(q.groupedRank("WEBRip-1080p", GROUPS)).toBe(q.qualityRank("WEBDL-1080p"));
    expect(q.groupedRank("WEBDL-1080p", GROUPS)).toBe(q.qualityRank("WEBDL-1080p"));
    expect(q.groupedRank("Bluray-1080p", GROUPS)).toBe(q.qualityRank("Bluray-1080p"));
    expect(q.groupedRank("WEBRip-1080p", [])).toBe(q.qualityRank("WEBRip-1080p"));
    expect(q.groupedRank(null, GROUPS)).toBe(-1);
    expect(q.groupRankOfRank(q.qualityRank("WEBRip-1080p"), GROUPS)).toBe(q.qualityRank("WEBDL-1080p"));
    expect(q.sameQualityGroup("WEBRip-1080p", "WEBDL-1080p", GROUPS)).toBe(true);
    expect(q.sameQualityGroup("WEBRip-1080p", "Bluray-1080p", GROUPS)).toBe(false);
  });

  it("is not an upgrade within a group, unless the format score or a revision says so", () => {
    const profile = rules.upgradeProfileOf({ cutoff: "Bluray-1080p", qualityGroups: GROUPS });
    const file = { quality: "WEBRip-1080p", releaseTitle: "Movie.2020.1080p.WEBRip.x264-GRPA", formatScore: 0 };
    const plain = rules.upgradeProfileOf({ cutoff: "Bluray-1080p" });
    // Without the group WEB-DL is a better tier; with it the two are one.
    expect(rules.judgeUpgrade(plain, "preferAndUpgrade", file, { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRPB" })).toBe("yes");
    expect(rules.judgeUpgrade(profile, "preferAndUpgrade", file, { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRPB" })).toBe("no");
    // The format cutoff decides inside a group, as it does inside any single quality.
    const scored = rules.upgradeProfileOf({ cutoff: "Bluray-1080p", qualityGroups: GROUPS, cutoffFormatScore: 100, minUpgradeFormatScore: 10 });
    expect(rules.judgeUpgrade(scored, "preferAndUpgrade", file, { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRPB" })).toBe("needs-score");
    expect(rules.judgeUpgrade(scored, "preferAndUpgrade", file, { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRPB", score: 50 })).toBe("yes");
    // A group member counts as meeting a cutoff set on another member.
    const cutoffWeb = rules.upgradeProfileOf({ cutoff: "WEBDL-1080p", qualityGroups: GROUPS });
    expect(rules.qualityCutoffMet(cutoffWeb, file)).toBe(true);
    expect(rules.qualityCutoffMet(rules.upgradeProfileOf({ cutoff: "WEBDL-1080p" }), file)).toBe(false);
    expect(rules.cutoffNotMet(cutoffWeb, file)).toBe(false);
  });

  it("chooses between the members of a group by custom-format score and seeders, not by their rank", async () => {
    const profileId = await profileWithGroups(GROUPS, { cutoff: "WEBDL-1080p" });
    const allowed = ["HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p"];
    const rip = release("Movie.2020.1080p.WEBRip.x264-GRPA", 900);
    const web = release("Movie.2020.1080p.WEB-DL.x264-GRPB", 5);
    // Ungrouped, the better-ranked WEB-DL wins despite the seeders.
    const ungrouped = await profileWithGroups([], { cutoff: "WEBDL-1080p" });
    expect((await sched.chooseBestResult([rip, web], allowed, "WEBDL-1080p", ungrouped, 0, null, new Set(), "movie"))?.result).toBe(web);
    // Grouped, the two are one tier and the better-seeded rip wins.
    expect((await sched.chooseBestResult([rip, web], allowed, "WEBDL-1080p", profileId, 0, null, new Set(), "movie"))?.result).toBe(rip);
  });

  it("does not take a release of the file's own group as an upgrade", async () => {
    const profileId = await profileWithGroups(GROUPS, { cutoff: "Bluray-1080p" });
    const allowed = ["HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p"];
    const web = release("Movie.2020.1080p.WEB-DL.x264-GRPB");
    const onDisk = q.qualityRank("WEBRip-1080p");
    expect(await sched.chooseBestResult([web], allowed, "Bluray-1080p", profileId, 0, null, new Set(), "movie", null, null, null, { upgradeFromRank: onDisk })).toBeNull();
    const bluray = release("Movie.2020.1080p.BluRay.x264-GRPC");
    expect((await sched.chooseBestResult([web, bluray], allowed, "Bluray-1080p", profileId, 0, null, new Set(), "movie", null, null, null, { upgradeFromRank: onDisk }))?.result).toBe(bluray);
  });

  it("reads the cutoff of a group from any member", () => {
    expect(sched.meetsCutoff("WEBRip-1080p", "WEBDL-1080p", GROUPS)).toBe(true);
    expect(sched.meetsCutoff("WEBRip-1080p", "WEBDL-1080p")).toBe(false);
    expect(sched.isBelowCutoff("WEBRip-1080p", "WEBDL-1080p", GROUPS)).toBe(false);
    expect(sched.isBelowCutoff("HDTV-1080p", "WEBDL-1080p", GROUPS)).toBe(true);
  });
});

describe("quality groups on the profile API", () => {
  const post = (body: unknown) => request(app).post("/api/quality-profiles").set("X-Api-Key", apiKey).send(body);
  const base = { name: "", allowedQualities: ["WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p"], cutoff: "Bluray-1080p" };

  it("stores valid groups and returns them", async () => {
    const res = await post({ ...base, name: "grouped", qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]] });
    expect(res.status).toBe(201);
    expect(res.body.qualityGroups).toEqual([["WEBRip-1080p", "WEBDL-1080p"]]);
    const none = await post({ ...base, name: "ungrouped" });
    expect(none.body.qualityGroups).toEqual([]);
  });

  it("refuses a group of one, an overlap, a name outside the allowed list and a bad shape", async () => {
    expect((await post({ ...base, name: "g1", qualityGroups: [["WEBRip-1080p"]] })).status).toBe(400);
    expect((await post({ ...base, name: "g2", qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"], ["WEBDL-1080p", "Bluray-1080p"]] })).status).toBe(400);
    expect((await post({ ...base, name: "g3", qualityGroups: [["WEBRip-1080p", "HDTV-720p"]] })).status).toBe(400);
    expect((await post({ ...base, name: "g4", qualityGroups: "all" })).status).toBe(400);
  });

  it("edits groups, and dissolves one when its qualities are dropped from the profile", async () => {
    const created = await post({ ...base, name: "edit-me", qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]] });
    const id = created.body.id;
    const patched = await request(app).patch(`/api/quality-profiles/${id}`).set("X-Api-Key", apiKey).send({ qualityGroups: [["WEBDL-1080p", "Bluray-1080p"]] });
    expect(patched.status).toBe(200);
    const shrunk = await request(app).patch(`/api/quality-profiles/${id}`).set("X-Api-Key", apiKey).send({ allowedQualities: ["WEBDL-1080p", "Bluray-1080p"] });
    expect(shrunk.status).toBe(200);
    const list = await request(app).get("/api/quality-profiles").set("X-Api-Key", apiKey);
    expect(list.body.find((p: any) => p.id === id).qualityGroups).toEqual([["WEBDL-1080p", "Bluray-1080p"]]);
    const dropped = await request(app).patch(`/api/quality-profiles/${id}`).set("X-Api-Key", apiKey).send({ allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p" });
    expect(dropped.status).toBe(200);
    const after = await request(app).get("/api/quality-profiles").set("X-Api-Key", apiKey);
    expect(after.body.find((p: any) => p.id === id).qualityGroups).toEqual([]);
  });

  it("travels in the settings template export", async () => {
    await post({ ...base, name: "exported", qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]], upgradeAllowed: false, cutoffFormatScore: 50, minUpgradeFormatScore: 7 });
    const res = await request(app).get("/api/settings/template/export").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    const p = res.body.qualityProfiles.find((x: any) => x.name === "exported");
    expect(p).toMatchObject({ qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]], upgradeAllowed: false, cutoffFormatScore: 50, minUpgradeFormatScore: 7 });
  });
});

describe("quality groups: the places the review found", () => {
  it("dissolves a group when one of its qualities is deleted", async () => {
    const quality = Number((await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Group-Test-Quality', 998)").run()).lastInsertRowid);
    const res = await request(app)
      .post("/api/quality-profiles")
      .set("X-Api-Key", apiKey)
      .send({ name: "delete-group", allowedQualities: ["WEBRip-1080p", "WEBDL-1080p", "Group-Test-Quality"], cutoff: "WEBDL-1080p", qualityGroups: [["WEBRip-1080p", "Group-Test-Quality"]] });
    expect(res.status).toBe(201);
    expect((await request(app).delete(`/api/qualities/${quality}`).set("X-Api-Key", apiKey)).status).toBe(204);
    const list = await request(app).get("/api/quality-profiles").set("X-Api-Key", apiKey);
    expect(list.body.find((p: any) => p.id === res.body.id).qualityGroups).toEqual([]);
  });

  it("keeps a profile's own upgrade fields and groups when a backup from before them is imported", async () => {
    const created = await request(app)
      .post("/api/quality-profiles")
      .set("X-Api-Key", apiKey)
      .send({ name: "keep-me", allowedQualities: ["WEBRip-1080p", "WEBDL-1080p"], cutoff: "WEBDL-1080p", qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]], upgradeAllowed: false, cutoffFormatScore: 40 });
    expect(created.status).toBe(201);
    const imported = await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .send({ qualityProfiles: [{ name: "keep-me", allowedQualities: ["WEBRip-1080p", "WEBDL-1080p"], cutoff: "WEBDL-1080p", minFormatScore: 0, maxSizeGb: null }] });
    expect(imported.status).toBe(200);
    const list = await request(app).get("/api/quality-profiles").set("X-Api-Key", apiKey);
    expect(list.body.find((p: any) => p.name === "keep-me")).toMatchObject({ qualityGroups: [["WEBRip-1080p", "WEBDL-1080p"]], upgradeAllowed: false, cutoffFormatScore: 40 });
    // A profile new to the instance gets the defaults.
    await request(app)
      .post("/api/settings/template/import")
      .set("X-Api-Key", apiKey)
      .send({ qualityProfiles: [{ name: "brand-new", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", minFormatScore: 0, maxSizeGb: null }] });
    const after = await request(app).get("/api/quality-profiles").set("X-Api-Key", apiKey);
    expect(after.body.find((p: any) => p.name === "brand-new")).toMatchObject({ qualityGroups: [], upgradeAllowed: true, cutoffFormatScore: 0, minUpgradeFormatScore: 1 });
  });
});
