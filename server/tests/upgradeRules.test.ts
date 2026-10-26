import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let rules: typeof import("../src/services/upgradeRules.js");
let sched: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  rules = await import("../src/services/upgradeRules.js");
  sched = await import("../src/services/scheduler.js");
  const { loadQualityCaches } = await import("../src/services/quality.js");
  await loadQualityCaches();
});

const profile = (over: Partial<import("../src/services/upgradeRules.js").UpgradeProfile> = {}) => ({
  cutoff: "WEBDL-1080p",
  upgradeAllowed: true,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  ...over,
});
const file = (over: Partial<import("../src/services/upgradeRules.js").ExistingFile> = {}) => ({
  quality: "WEBDL-1080p",
  releaseTitle: "Movie.2020.1080p.WEB-DL.x264-GRPA",
  formatScore: 0,
  ...over,
});
const offer = (title: string, quality = "WEBDL-1080p", score?: number) => ({ title, quality, score });

describe("judgeUpgrade (Round 13, D4 and D5)", () => {
  it("replaces a file below the cutoff with a better quality, and never one at the cutoff", () => {
    expect(rules.judgeUpgrade(profile({ cutoff: "Bluray-1080p" }), "preferAndUpgrade", file(), offer("Movie.2020.1080p.BluRay.x264-GRPB", "Bluray-1080p"))).toBe("yes");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), offer("Movie.2020.2160p.WEB-DL.x265-GRPB", "WEBDL-2160p"))).toBe("no");
    expect(rules.judgeUpgrade(profile({ cutoff: "Bluray-1080p" }), "preferAndUpgrade", file({ quality: "WEBDL-1080p" }), offer("Movie.2020.720p.WEB-DL-GRPB", "WEBDL-720p"))).toBe("no");
  });

  it("takes a PROPER from anyone, and a REPACK only from the file's own group", () => {
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), offer("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB"))).toBe("yes");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), offer("Movie.2020.REPACK.1080p.WEB-DL.x264-GRPB"))).toBe("no");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), offer("Movie.2020.REPACK.1080p.WEB-DL.x264-grpa"))).toBe("yes");
    // The same revision again is no upgrade; a later one is.
    const proper = file({ releaseTitle: "Movie.2020.PROPER.1080p.WEB-DL.x264-GRPA" });
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", proper, offer("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB"))).toBe("no");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", proper, offer("Movie.2020.REPACK2.1080p.WEB-DL.x264-GRPA"))).toBe("yes");
  });

  it("an anime v2 replaces only its own group's file", () => {
    const fansub = file({ releaseTitle: "[SubsPlease] Show - 05 (1080p)" });
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", fansub, offer("[SubsPlease] Show - 05v2 (1080p)"))).toBe("yes");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", fansub, offer("[Erai-raws] Show - 05v2 (1080p)"))).toBe("no");
  });

  it("doNotUpgrade and a file of unknown origin take no revision", () => {
    expect(rules.judgeUpgrade(profile(), "doNotUpgrade", file(), offer("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB"))).toBe("no");
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file({ releaseTitle: null }), offer("Movie.2020.REPACK.1080p.WEB-DL.x264-GRPB"))).toBe("no");
  });

  it("a format cutoff keeps a same-quality file upgradable until its score is enough", () => {
    const p = profile({ cutoffFormatScore: 100, minUpgradeFormatScore: 10 });
    expect(rules.judgeUpgrade(p, "preferAndUpgrade", file({ formatScore: 40 }), offer("Movie.2020.1080p.WEB-DL.x264-GRPB"))).toBe("needs-score");
    expect(rules.judgeUpgrade(p, "preferAndUpgrade", file({ formatScore: 40 }), offer("Movie.2020.1080p.WEB-DL.x264-GRPB", "WEBDL-1080p", 60))).toBe("yes");
    expect(rules.judgeUpgrade(p, "preferAndUpgrade", file({ formatScore: 40 }), offer("Movie.2020.1080p.WEB-DL.x264-GRPB", "WEBDL-1080p", 45))).toBe("no");
    expect(rules.judgeUpgrade(p, "preferAndUpgrade", file({ formatScore: 100 }), offer("Movie.2020.1080p.WEB-DL.x264-GRPB", "WEBDL-1080p", 500))).toBe("no");
    // A cutoff of 0 is off.
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file({ formatScore: 0 }), offer("Movie.2020.1080p.WEB-DL.x264-GRPB", "WEBDL-1080p", 500))).toBe("no");
  });

  it("a profile that allows no upgrades replaces nothing, and is never below a cutoff", () => {
    const p = profile({ upgradeAllowed: false, cutoff: "Bluray-1080p" });
    expect(rules.judgeUpgrade(p, "preferAndUpgrade", file({ quality: "HDTV-720p" }), offer("Movie.2020.1080p.BluRay-GRPB", "Bluray-1080p"))).toBe("no");
    expect(rules.cutoffNotMet(p, file({ quality: "HDTV-720p" }))).toBe(false);
  });

  it("cutoffNotMet sees a quality under the cutoff or a score under the format cutoff", () => {
    expect(rules.cutoffNotMet(profile({ cutoff: "Bluray-1080p" }), file({ quality: "WEBDL-1080p" }))).toBe(true);
    expect(rules.cutoffNotMet(profile(), file())).toBe(false);
    expect(rules.cutoffNotMet(profile({ cutoffFormatScore: 50 }), file({ formatScore: 10 }))).toBe(true);
    expect(rules.cutoffNotMet(profile({ cutoffFormatScore: 50 }), file({ formatScore: null }))).toBe(true);
  });
});

describe("chooseBestResult with revisions and a file on disk (Round 13)", () => {
  const ANY = ["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"];
  let n = 0;
  const release = (title: string, over: Record<string, unknown> = {}): any => ({
    indexerId: null,
    indexerName: "T",
    title,
    size: 4_000_000_000,
    seeders: 50,
    leechers: 1,
    publishDate: new Date(Date.now() - 86_400_000 * 30).toISOString(),
    downloadUrl: `magnet:?xt=urn:btih:${++n}`,
    protocol: "torrent",
    category: null,
    ...over,
  });
  const choose = (results: any[], options: object = {}) =>
    sched.chooseBestResult(results, ANY, "WEBDL-1080p", null, 0, null, new Set(), "movie", null, null, null, options);

  it("prefers a PROPER to the original for a missing target, whatever the seeders", async () => {
    const original = release("Movie.2020.1080p.WEB-DL.x264-GRPA", { seeders: 500 });
    const proper = release("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB", { seeders: 5 });
    expect((await choose([original, proper]))?.result).toBe(proper);
  });

  it("ignores revisions when the admin says so", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("downloadPropersAndRepacks", "doNotPrefer");
    try {
      const original = release("Movie.2020.1080p.WEB-DL.x264-GRPA", { seeders: 500 });
      const proper = release("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB", { seeders: 5 });
      expect((await choose([proper, original]))?.result).toBe(original);
    } finally {
      setSetting("downloadPropersAndRepacks", "preferAndUpgrade");
    }
  });

  it("replaces a file of the same quality with a PROPER, or a REPACK of its group, and with nothing else", async () => {
    const existing = { file: file(), profile: profile() };
    const plain = release("Movie.2020.1080p.WEB-DL.x264-GRPB");
    const proper = release("Movie.2020.PROPER.1080p.WEB-DL.x264-GRPB");
    const strangerRepack = release("Movie.2020.REPACK.1080p.WEB-DL.x264-GRPC");
    const ownRepack = release("Movie.2020.REPACK.1080p.WEB-DL.x264-GRPA");
    expect(await choose([plain], { existing })).toBeNull();
    expect(await choose([strangerRepack], { existing })).toBeNull();
    expect((await choose([plain, proper], { existing }))?.result).toBe(proper);
    expect((await choose([plain, strangerRepack, ownRepack], { existing }))?.result).toBe(ownRepack);
  });

  it("replaces a same-quality file by custom-format score only when the gain is enough", async () => {
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'WEBDL-1080p')").run(`Fmt ${Math.random()}`, JSON.stringify(ANY))).lastInsertRowid
    );
    const formatId = Number(
      (await db.prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)").run(`Tier ${Math.random()}`, JSON.stringify([{ type: "releaseGroup", patterns: ["^TIERONE$"], negate: false }]))).lastInsertRowid
    );
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, 300)").run(profileId, formatId);
    const existing = { file: file({ formatScore: 0 }), profile: profile({ cutoffFormatScore: 200, minUpgradeFormatScore: 50 }) };
    const plain = release("Movie.2020.1080p.WEB-DL.x264-GRPB");
    const tier = release("Movie.2020.1080p.WEB-DL.x264-TIERONE");
    const best = await sched.chooseBestResult([plain, tier], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", null, null, null, { existing });
    expect(best?.result).toBe(tier);
    expect(await sched.chooseBestResult([plain], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", null, null, null, { existing })).toBeNull();
  });
});

describe("what a file remembers of its release, and the Cutoff Unmet list (Round 13)", () => {
  it("records the title and the score of an imported file", async () => {
    const { releaseRecordFor, existingFileRecord } = await import("../src/services/fileRelease.js");
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, '[\"WEBDL-1080p\"]', 'WEBDL-1080p')").run(`Rec ${Math.random()}`)).lastInsertRowid
    );
    const itemId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id, quality) VALUES ('movie', 'Rec Movie', 'rec movie', 1, 1, 'unknown', ?, 'WEBDL-1080p')").run(profileId))
        .lastInsertRowid
    );
    expect(await releaseRecordFor({ id: itemId, type: "movie", qualityProfileId: profileId }, undefined, 1)).toEqual({ title: null, score: null });
    const record = await releaseRecordFor({ id: itemId, type: "movie", qualityProfileId: profileId }, "Rec.Movie.2020.1080p.WEB-DL.x264-GRPA", 4_000_000_000);
    expect(record).toMatchObject({ title: "Rec.Movie.2020.1080p.WEB-DL.x264-GRPA" });
    await db.prepare("UPDATE media_items SET file_release_title = ?, file_format_score = ? WHERE id = ?").run(record.title, 42, itemId);
    expect(await existingFileRecord({ id: itemId }, null, null)).toEqual({ quality: "WEBDL-1080p", releaseTitle: "Rec.Movie.2020.1080p.WEB-DL.x264-GRPA", formatScore: 42 });
  });

  it("lists a file at the quality cutoff when its score is under the format cutoff, and none when upgrades are off", async () => {
    const { findUpgradeCandidates, clearUpgradeCandidatesCache } = await import("../src/services/upgradeCandidates.js");
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, cutoff_format_score) VALUES (?, ?, 'WEBDL-1080p', 100)").run(`Cand ${Math.random()}`, JSON.stringify(["WEBDL-1080p"])))
        .lastInsertRowid
    );
    const movie = async (title: string, score: number | null) =>
      Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id, quality, file_format_score) VALUES ('movie', ?, ?, 1, 1, 'unknown', ?, 'WEBDL-1080p', ?)")
            .run(title, title.toLowerCase(), profileId, score)
        ).lastInsertRowid
      );
    const low = await movie("Low Score Movie", 10);
    const high = await movie("High Score Movie", 150);
    clearUpgradeCandidatesCache();
    let ids = (await findUpgradeCandidates()).map((c) => c.mediaItemId);
    expect(ids).toContain(low);
    expect(ids).not.toContain(high);
    await db.prepare("UPDATE quality_profiles SET upgrade_allowed = 0 WHERE id = ?").run(profileId);
    clearUpgradeCandidatesCache();
    ids = (await findUpgradeCandidates()).map((c) => c.mediaItemId);
    expect(ids).not.toContain(low);
  });

  it("the profile route stores the upgrade fields", async () => {
    const made = await request(app)
      .post("/api/quality-profiles")
      .set("X-Api-Key", apiKey)
      .send({ name: "Upgrades", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", upgradeAllowed: false, cutoffFormatScore: 120, minUpgradeFormatScore: 15 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ upgradeAllowed: false, cutoffFormatScore: 120, minUpgradeFormatScore: 15 });
    const patched = await request(app).patch(`/api/quality-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send({ upgradeAllowed: true, cutoffFormatScore: 0 });
    expect(patched.body).toMatchObject({ upgradeAllowed: true, cutoffFormatScore: 0, minUpgradeFormatScore: 15 });
    expect((await request(app).patch(`/api/quality-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send({ cutoffFormatScore: "x" })).status).toBe(400);
    const plain = await request(app).post("/api/quality-profiles").set("X-Api-Key", apiKey).send({ name: "Plain Defaults", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p" });
    expect(plain.body).toMatchObject({ upgradeAllowed: true, cutoffFormatScore: 0, minUpgradeFormatScore: 1 });
  });
});
