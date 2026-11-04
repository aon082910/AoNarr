import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let rules: typeof import("../src/services/upgradeRules.js");
let quality: typeof import("../src/services/quality.js");
let sched: typeof import("../src/services/scheduler.js");
let packs: typeof import("../src/services/seasonPacks.js");
let health: typeof import("../src/services/healthReport.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  rules = await import("../src/services/upgradeRules.js");
  quality = await import("../src/services/quality.js");
  sched = await import("../src/services/scheduler.js");
  packs = await import("../src/services/seasonPacks.js");
  health = await import("../src/services/healthReport.js");
  await quality.loadQualityCaches();
});

// A cutoff naming a quality that is not on the ladder (renamed, deleted, mistyped).
const GONE = "Ultra-HD-Gone";

const profile = (over: Partial<import("../src/services/upgradeRules.js").UpgradeProfile> = {}) => ({
  cutoff: GONE,
  upgradeAllowed: true,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  ...over,
});
const file = (quality = "WEBDL-1080p") => ({ quality, releaseTitle: "Movie.2020.1080p.WEB-DL.x264-GRPA", formatScore: 0 });

describe("a cutoff that is not on the quality ladder is never reached (Round 30c)", () => {
  it("isUnderCutoff reads any file of a known quality as under it, and no file of unknown quality or no cutoff", () => {
    expect(quality.isUnderCutoff("Remux-2160p", GONE)).toBe(true);
    expect(quality.isUnderCutoff("WEBDL-720p", GONE)).toBe(true);
    // Unchanged: a ranked cutoff compares, a file of unknown quality is not known to be under anything, no cutoff is none.
    expect(quality.isUnderCutoff("WEBDL-720p", "WEBDL-1080p")).toBe(true);
    expect(quality.isUnderCutoff("WEBDL-1080p", "WEBDL-1080p")).toBe(false);
    expect(quality.isUnderCutoff("Remux-2160p", "WEBDL-1080p")).toBe(false);
    expect(quality.isUnderCutoff("Unknown", GONE)).toBe(false);
    expect(quality.isUnderCutoff(null, GONE)).toBe(false);
    expect(quality.isUnderCutoff("WEBDL-1080p", "")).toBe(false);
    expect(quality.cutoffIsRanked(GONE)).toBe(false);
    expect(quality.cutoffIsRanked("")).toBe(false);
    expect(quality.cutoffIsRanked("WEBDL-1080p")).toBe(true);
  });

  it("a better release replaces the file under the single-episode rule, which used to read the cutoff as reached", () => {
    const better = { title: "Movie.2020.2160p.WEB-DL.x265-GRPB", quality: "WEBDL-2160p" };
    expect(rules.qualityCutoffMet(profile(), file("Remux-2160p"))).toBe(false);
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), better)).toBe("yes");
    // A real cutoff that is met still refuses it.
    expect(rules.judgeUpgrade(profile({ cutoff: "WEBDL-1080p" }), "preferAndUpgrade", file(), better)).toBe("no");
    // Never a worse or equal quality, cutoff or not.
    expect(rules.judgeUpgrade(profile(), "preferAndUpgrade", file(), { title: "Movie.2020.720p.WEB-DL-GRPB", quality: "WEBDL-720p" })).toBe("no");
  });

  it("cutoffNotMet and isBelowCutoff keep a file of known quality open to upgrades, and a profile that allows none closed", () => {
    expect(rules.cutoffNotMet(profile(), file())).toBe(true);
    expect(rules.cutoffNotMet(profile({ upgradeAllowed: false }), file())).toBe(false);
    expect(rules.cutoffNotMet(profile(), file("Unknown"))).toBe(false);
    expect(sched.isBelowCutoff("WEBDL-1080p", GONE)).toBe(true);
    expect(sched.isBelowCutoff("WEBDL-1080p", "WEBDL-1080p")).toBe(false);
    // meetsCutoff (the search entry points) already read an unranked cutoff as not met.
    expect(sched.meetsCutoff("Remux-2160p", GONE)).toBe(false);
  });

  it("a search replaces a file at an unranked cutoff with a better release", async () => {
    const release = (title: string): any => ({
      indexerId: null,
      indexerName: "T",
      title,
      size: 4_000_000_000,
      seeders: 50,
      leechers: 1,
      publishDate: new Date(Date.now() - 86_400_000 * 30).toISOString(),
      downloadUrl: `magnet:?xt=${title}`,
      protocol: "torrent",
      category: null,
    });
    const better = release("Movie.2020.2160p.WEB-DL.x265-GRPB");
    const chosen = await sched.chooseBestResult([better], ["WEBDL-1080p", "WEBDL-2160p"], GONE, null, 0, null, new Set(), "movie", null, null, null, {
      existing: { file: file(), profile: profile() },
    });
    expect(chosen?.result).toBe(better);
  });

  it("a season pack counts the files of a finished season as upgradable by an unranked cutoff", () => {
    const episodes = [1, 2, 3].map((n) => ({
      seasonNumber: 1,
      episodeNumber: n,
      sceneSeason: null,
      sceneEpisode: null,
      monitored: true,
      hasFile: true,
      quality: "WEBDL-1080p",
      airDate: "2020-01-01",
      releaseTitle: `Show.S01E0${n}.1080p.WEB-DL-GRPA`,
      formatScore: 0,
    }));
    const verdict = packs.judgeSeasonPack({
      parsed: { episodeRange: null },
      season: 1,
      episodes,
      item: { type: "series", seriesType: null },
      packQuality: "WEBDL-1080p",
      cutoff: GONE,
      couldUpgrade: profile(),
    });
    expect(verdict).toMatchObject({ ok: true, wanted: 3 });
    // The same season at a ranked cutoff it has reached has nothing to upgrade.
    expect(
      packs.judgeSeasonPack({
        parsed: { episodeRange: null },
        season: 1,
        episodes,
        item: { type: "series", seriesType: null },
        packQuality: "WEBDL-1080p",
        cutoff: "WEBDL-1080p",
        couldUpgrade: profile({ cutoff: "WEBDL-1080p" }),
      }).ok
    ).toBe(false);
  });
});

describe("upgrade candidates and the Cutoff Unmet filter with an unranked cutoff", () => {
  beforeEach(async () => {
    const { clearUpgradeCandidatesCache } = await import("../src/services/upgradeCandidates.js");
    clearUpgradeCandidatesCache();
    await db.prepare("DELETE FROM media_items").run();
    await db.prepare("DELETE FROM quality_profiles WHERE name LIKE 'Gone %'").run();
  });

  it("lists a movie whose profile cutoff is not on the ladder as an upgrade candidate", async () => {
    const { findUpgradeCandidates } = await import("../src/services/upgradeCandidates.js");
    const profileId = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Gone cutoff', '[]', ?)").run(GONE)).lastInsertRowid);
    const movieId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', 'Open Ended', 'x', 1, 1, 'WEBDL-1080p', ?, 'unknown')")
          .run(profileId)
      ).lastInsertRowid
    );
    expect((await findUpgradeCandidates()).map((c) => c.mediaItemId)).toContain(movieId);
  });

  it("includes such a movie in the Cutoff Unmet library filter", async () => {
    const { buildMediaQuery } = await import("../src/services/mediaQuery.js");
    const profileId = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Gone cutoff 2', '[]', ?)").run(GONE)).lastInsertRowid);
    const movieId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', 'Also Open', 'x', 1, 1, 'WEBDL-1080p', ?, 'unknown')")
          .run(profileId)
      ).lastInsertRowid
    );
    const q = await buildMediaQuery({ status: "cutoffUnmet", allowedTypes: null });
    expect(q.where).not.toBeNull();
    const row = await db.prepare(`SELECT m.id FROM ${q.fromClause} WHERE ${q.where} AND m.id = ?`).get(...q.params, movieId);
    expect(row).toBeTruthy();
  });
});

describe("the Health check for a quality profile's cutoff (source quality-cutoff)", () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM quality_profiles WHERE name LIKE 'Health %'").run();
  });

  const insert = async (name: string, allowed: string[], cutoff: string, groups = "[]") =>
    Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups) VALUES (?, ?, ?, ?)")
          .run(name, JSON.stringify(allowed), cutoff, groups)
      ).lastInsertRowid
    );

  it("reports a cutoff that is not on the ladder, and one the profile does not allow, and nothing for a sound profile", async () => {
    const gone = await insert("Health gone", ["WEBDL-1080p"], GONE);
    const notAllowed = await insert("Health not allowed", ["WEBDL-720p", "WEBDL-1080p"], "Remux-2160p");
    await insert("Health fine", ["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p");
    await insert("Health no cutoff", ["WEBDL-1080p"], "");
    // A cutoff that shares a group with an allowed quality is allowed.
    await insert("Health grouped", ["WEBDL-1080p"], "Bluray-1080p", JSON.stringify([["WEBDL-1080p", "Bluray-1080p"]]));

    const issues = (await health.qualityCutoffIssues()).filter((i) => i.source !== "quality-cutoff:0");
    const mine = issues.filter((i) => i.message.includes('"Health '));

    expect(mine.map((i) => i.source).sort()).toEqual([`quality-cutoff:${gone}`, `quality-cutoff:${notAllowed}`].sort());
    expect(mine.find((i) => i.source === `quality-cutoff:${gone}`)).toMatchObject({ severity: "warning", transient: false });
    expect(mine.find((i) => i.source === `quality-cutoff:${gone}`)!.message).toContain("not a quality on the ladder");
    expect(mine.find((i) => i.source === `quality-cutoff:${notAllowed}`)!.message).toContain("not one of the qualities it allows");
  });

  it("is part of the health report", async () => {
    await insert("Health in report", ["WEBDL-1080p"], GONE);
    health.clearHealthReportCache();
    const report = await health.getHealthReport({ refresh: true });
    expect(report.issues.some((i) => i.source.startsWith("quality-cutoff:") && i.message.includes("Health in report"))).toBe(true);
  });
});
