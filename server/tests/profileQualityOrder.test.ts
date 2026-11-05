import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let q: typeof import("../src/services/quality.js");
let rules: typeof import("../src/services/upgradeRules.js");
let sched: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  q = await import("../src/services/quality.js");
  rules = await import("../src/services/upgradeRules.js");
  sched = await import("../src/services/scheduler.js");
  await q.loadQualityCaches();
});

/** A profile that prefers WEB-DL to Blu-ray (the audit's example), and the global order, which prefers the disc. */
const WEB_FIRST = { groups: [], order: ["Bluray-1080p", "WEBDL-1080p"] };
const DISC_FIRST = { groups: [], order: ["WEBDL-1080p", "Bluray-1080p"] };
const GLOBAL = { groups: [], order: null };

function release(title: string, seeders = 50): any {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title,
    size: 4_000_000_000,
    seeders,
    leechers: 1,
    publishDate: new Date().toISOString(),
    downloadUrl: `magnet:?xt=urn:btih:${title}`,
    protocol: "torrent",
    category: null,
  };
}

let serial = 0;
async function insertProfile(over: { allowed?: string[]; cutoff: string; order?: string[] | null; groups?: string[][]; preferCutoff?: boolean }): Promise<number> {
  const result = await db
    .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups, quality_order, prefer_cutoff_quality) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      `order-${++serial}-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(over.allowed ?? ["WEBDL-1080p", "Bluray-1080p"]),
      over.cutoff,
      JSON.stringify(over.groups ?? []),
      over.order ? JSON.stringify(over.order) : null,
      over.preferCutoff === false ? 0 : 1
    );
  return Number(result.lastInsertRowid);
}

async function mappedProfile(id: number) {
  const { getQualityProfile } = await import("../src/services/scheduler.js");
  return (await getQualityProfile(id))!;
}

describe("what a profile's order is read from", () => {
  it("reads a stored order as a list of different names, and anything else as no order", () => {
    expect(q.parseQualityOrder(JSON.stringify(["B", "A"]))).toEqual(["B", "A"]);
    expect(q.parseQualityOrder(["B", "A", "B", "", 4])).toEqual(["B", "A"]);
    for (const none of [null, undefined, "", "[]", "not json", "{}", "42", [], {}]) expect(q.parseQualityOrder(none as any)).toBeNull();
  });

  it("builds a profile's ranking from its row in one place, and from a mapped profile the same way", () => {
    const row = { quality_groups: JSON.stringify([["A", "B"]]), quality_order: JSON.stringify(["B", "A"]) };
    expect(q.rankingFromRow(row)).toEqual({ groups: [["A", "B"]], order: ["B", "A"] });
    expect(q.rankingFromRow({ quality_groups: "[]", quality_order: null })).toEqual({ groups: [], order: null });
    expect(q.rankingFromRow(null)).toEqual(q.GLOBAL_RANKING);
    expect(q.rankingOf({ qualityGroups: [["A", "B"]], qualityOrder: ["B", "A"] })).toEqual({ groups: [["A", "B"]], order: ["B", "A"] });
    expect(q.rankingOf({ qualityGroups: [], qualityOrder: [] })).toEqual(q.GLOBAL_RANKING);
    expect(q.rankingOf(undefined)).toEqual(q.GLOBAL_RANKING);
  });
});

describe("the ranking helpers with a profile's own order", () => {
  it("rank by the global order exactly as before when the profile has no order", () => {
    for (const a of DEFAULT_NAMES()) {
      expect(q.orderedRank(a, GLOBAL)).toBe(q.qualityRank(a));
      expect(q.groupedRank(a, GLOBAL)).toBe(q.qualityRank(a));
      expect(q.groupedRank(a)).toBe(q.qualityRank(a));
      expect(q.groupedRank(a, q.GLOBAL_RANKING)).toBe(q.qualityRank(a));
      for (const b of ["WEBDL-1080p", "Bluray-720p", "SD"]) {
        expect(q.isUnderCutoff(a, b, GLOBAL)).toBe(q.qualityRank(a) >= 0 && q.qualityRank(a) < q.qualityRank(b));
        expect(Math.sign(q.compareQualities(a, b, GLOBAL))).toBe(Math.sign(q.qualityRank(a) - q.qualityRank(b)));
      }
    }
    expect(q.groupedRank(null, GLOBAL)).toBe(-1);
    expect(q.groupedRank("Not A Quality", GLOBAL)).toBe(-1);
  });

  it("rank the qualities a profile lists in the profile's order, and one it leaves out where it belongs among them", () => {
    expect(q.groupedRank("WEBDL-1080p", WEB_FIRST)).toBeGreaterThan(q.groupedRank("Bluray-1080p", WEB_FIRST));
    expect(q.groupedRank("WEBDL-1080p", DISC_FIRST)).toBeLessThan(q.groupedRank("Bluray-1080p", DISC_FIRST));
    // A quality the order leaves out ranks where the global ladder puts it among the listed ones (the place
    // reconcileQualityOrder gives it), not below all of them: lower ones stay below, a higher one stays above.
    for (const lower of ["SD", "HDTV-1080p"]) {
      expect(q.groupedRank(lower, WEB_FIRST), lower).toBeLessThan(q.groupedRank("Bluray-1080p", WEB_FIRST));
    }
    expect(q.groupedRank("Remux-2160p", WEB_FIRST)).toBeGreaterThan(q.groupedRank("WEBDL-1080p", WEB_FIRST));
    expect(q.groupedRank("Remux-2160p", WEB_FIRST)).toBeGreaterThan(q.groupedRank("Bluray-1080p", WEB_FIRST));
    // Among themselves the unlisted ones keep the global order.
    expect(q.groupedRank("SD", WEB_FIRST)).toBeLessThan(q.groupedRank("HDTV-1080p", WEB_FIRST));
    expect(q.groupedRank("HDTV-1080p", WEB_FIRST)).toBeLessThan(q.groupedRank("Remux-2160p", WEB_FIRST));
    // One between two listed qualities on the ladder lands between them.
    const ends = { groups: [], order: ["WEBDL-1080p", "Remux-1080p"] };
    expect(q.groupedRank("WEBDL-1080p", ends)).toBeLessThan(q.groupedRank("Bluray-1080p", ends));
    expect(q.groupedRank("Bluray-1080p", ends)).toBeLessThan(q.groupedRank("Remux-1080p", ends));
  });

  it("rank a short order exactly as the same order completed with the missing qualities does", () => {
    const names = DEFAULT_NAMES().filter((n) => q.qualityRank(n) >= 0);
    const everything = ladderNames();
    const shortOrders = [["Bluray-1080p", "WEBDL-1080p"], ["WEBDL-1080p", "Bluray-1080p"], ["WEBDL-1080p", "Remux-1080p"], ["Remux-2160p", "SD"], ["HDTV-720p"], ["Ghost-1080p", "WEBDL-1080p"]];
    for (const order of shortOrders) {
      const completed = q.reconcileQualityOrder(order, everything);
      const sorted = (o: string[]) => [...names].sort((a, b) => q.groupedRank(a, { groups: [], order: o }) - q.groupedRank(b, { groups: [], order: o }));
      expect(sorted(order), order.join(",")).toEqual(sorted(completed));
    }
  });

  it("never rank a quality that is not on the ladder, whatever the order lists", () => {
    const odd = { groups: [], order: ["Ghost-1080p", "WEBDL-1080p"] };
    expect(q.groupedRank("Ghost-1080p", odd)).toBe(-1);
    expect(q.groupedRank(null, odd)).toBe(-1);
    // (A name that is not on the ladder is never a place others are put in front of; Remux-2160p is above the one listed tier.)
    expect(q.groupedRank("WEBDL-1080p", odd)).toBeLessThan(q.groupedRank("Remux-2160p", odd));
    expect(q.groupedRank("SD", odd)).toBeLessThan(q.groupedRank("WEBDL-1080p", odd));
  });

  it("rank a group as its best member in the profile's order", () => {
    const ranking = { groups: [["WEBDL-1080p", "WEBRip-1080p"]], order: ["WEBDL-1080p", "Bluray-1080p", "WEBRip-1080p"] };
    // WEBRip is the last listed, so the group is the best tier there is, above Blu-ray.
    expect(q.groupedRank("WEBDL-1080p", ranking)).toBe(q.groupedRank("WEBRip-1080p", ranking));
    expect(q.groupedRank("WEBDL-1080p", ranking)).toBeGreaterThan(q.groupedRank("Bluray-1080p", ranking));
    expect(q.sameQualityGroup("WEBDL-1080p", "WEBRip-1080p", ranking)).toBe(true);
    expect(q.sameQualityGroup("WEBDL-1080p", "Bluray-1080p", ranking)).toBe(false);
  });

  it("read the cutoff in the profile's order", () => {
    // A WEB-DL file under a Blu-ray cutoff: unmet by the global order, met when the profile ranks WEB-DL higher.
    expect(q.isUnderCutoff("WEBDL-1080p", "Bluray-1080p", GLOBAL)).toBe(true);
    expect(q.isUnderCutoff("WEBDL-1080p", "Bluray-1080p", WEB_FIRST)).toBe(false);
    expect(q.isUnderCutoff("Bluray-1080p", "WEBDL-1080p", WEB_FIRST)).toBe(true);
    expect(q.isUnderCutoff("Bluray-1080p", "WEBDL-1080p", GLOBAL)).toBe(false);
    // A file of a quality the profile leaves out is judged by where it belongs among the listed ones: a Remux-2160p is
    // past a WEB-DL cutoff, as it is without an order (it used to be "under" it, which got it replaced by a worse file),
    // and an SD file is still under it.
    expect(q.isUnderCutoff("Remux-2160p", "WEBDL-1080p", WEB_FIRST)).toBe(false);
    expect(q.isUnderCutoff("Remux-2160p", "WEBDL-1080p", GLOBAL)).toBe(false);
    expect(q.isUnderCutoff("SD", "WEBDL-1080p", WEB_FIRST)).toBe(true);
    expect(q.cutoffIsRanked("WEBDL-1080p", WEB_FIRST)).toBe(true);
    expect(q.cutoffIsRanked("Ghost-1080p", WEB_FIRST)).toBe(false);
  });

  it("turn a global rank into the profile's rank of that quality, and again harmlessly", () => {
    const webRank = q.qualityRank("WEBDL-1080p");
    const inProfile = q.groupRankOfRank(webRank, WEB_FIRST);
    expect(inProfile).toBe(q.groupedRank("WEBDL-1080p", WEB_FIRST));
    expect(q.groupRankOfRank(inProfile, WEB_FIRST)).toBe(inProfile);
    expect(q.groupRankOfRank(webRank, GLOBAL)).toBe(webRank);
    expect(q.groupRankOfRank(-1, WEB_FIRST)).toBe(-1);
    // A quality the order leaves out converts too, and converting its profile rank again changes nothing.
    const remuxRank = q.groupRankOfRank(q.qualityRank("Remux-2160p"), WEB_FIRST);
    expect(remuxRank).toBe(q.groupedRank("Remux-2160p", WEB_FIRST));
    expect(q.groupRankOfRank(remuxRank, WEB_FIRST)).toBe(remuxRank);
  });

  it("pick the best allowed quality in the profile's order", () => {
    const both = ["WEBDL-1080p", "Bluray-1080p"];
    // Not capped at the cutoff: the best allowed quality on offer wins, and which that is depends on the profile.
    expect(q.pickBestAllowedQuality(both, both, "Bluray-1080p", false, GLOBAL)).toBe("Bluray-1080p");
    expect(q.pickBestAllowedQuality(both, both, "Bluray-1080p", false, WEB_FIRST)).toBe("WEBDL-1080p");
    expect(q.pickBestAllowedQuality(both, both, "WEBDL-1080p", false, DISC_FIRST)).toBe("Bluray-1080p");
    // Capped at the cutoff: nothing above it while something at or below it is on offer.
    expect(q.pickBestAllowedQuality(both, both, "WEBDL-1080p", true, DISC_FIRST)).toBe("WEBDL-1080p");
    // (WEB_FIRST ranks the disc lowest: a disc cutoff is the bottom of the profile, and WEB-DL is above it.)
    expect(q.pickBestAllowedQuality(both, both, "Bluray-1080p", true, WEB_FIRST)).toBe("Bluray-1080p");
    expect(q.pickBestAllowedQuality(both, both, "WEBDL-1080p", true, WEB_FIRST)).toBe("WEBDL-1080p");
  });

  it("order a list of qualities best-first the way the profile prefers them", () => {
    const names = ["Bluray-1080p", "HDTV-1080p", "WEBDL-1080p", "SD"];
    expect([...names].sort((a, b) => q.compareQualities(b, a, WEB_FIRST))).toEqual(["WEBDL-1080p", "Bluray-1080p", "HDTV-1080p", "SD"]);
    expect([...names].sort((a, b) => q.compareQualities(b, a, GLOBAL))).toEqual(["Bluray-1080p", "WEBDL-1080p", "HDTV-1080p", "SD"]);
  });
});

/** Every quality on the ladder. */
function ladderNames(): string[] {
  return DEFAULT_NAMES().filter((n) => q.qualityRank(n) >= 0);
}

function DEFAULT_NAMES(): string[] {
  return ["SD", "SDTV", "DVD", "HDTV-720p", "WEBDL-720p", "Bluray-720p", "HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-1080p", "WEBDL-2160p", "Remux-2160p", "CAM", "Raw-HD", "BR-DISK", "Not A Quality"];
}

describe("a profile that prefers WEB-DL to Blu-ray and one that prefers the reverse, through the real decisions", () => {
  const both = ["WEBDL-1080p", "Bluray-1080p"];

  it("pick different releases of the same two candidates", async () => {
    const web = release("Movie.2020.1080p.WEB-DL.x264-GRPA", 5);
    const disc = release("Movie.2020.1080p.BluRay.x264-GRPB", 900);
    // Both profiles take the best they allow (not capped), so the order alone decides.
    const webFirst = await insertProfile({ cutoff: "WEBDL-1080p", order: ["Bluray-1080p", "WEBDL-1080p"], preferCutoff: false });
    const discFirst = await insertProfile({ cutoff: "Bluray-1080p", order: ["WEBDL-1080p", "Bluray-1080p"], preferCutoff: false });
    const globalOrder = await insertProfile({ cutoff: "Bluray-1080p", order: null, preferCutoff: false });

    const pick = async (profileId: number, cutoff: string) =>
      (await sched.chooseBestResult([web, disc], both, cutoff, profileId, 0, null, new Set(), "movie"))?.result;

    expect(await pick(webFirst, "WEBDL-1080p")).toBe(web);
    expect(await pick(discFirst, "Bluray-1080p")).toBe(disc);
    // No order of its own: the global order, which has the disc on top, as before.
    expect(await pick(globalOrder, "Bluray-1080p")).toBe(disc);
  });

  it("stop at the cutoff in the profile's order", async () => {
    const web = release("Movie.2020.1080p.WEB-DL.x264-GRPA", 5);
    const disc = release("Movie.2020.1080p.BluRay.x264-GRPB", 900);
    // Capped at a WEB-DL cutoff: a profile that ranks the disc below WEB-DL may take it, one that ranks it above may not.
    const discBelow = await insertProfile({ cutoff: "WEBDL-1080p", order: ["Bluray-1080p", "WEBDL-1080p"] });
    const discAbove = await insertProfile({ cutoff: "WEBDL-1080p", order: ["WEBDL-1080p", "Bluray-1080p"] });
    const choose = async (profileId: number) => (await sched.chooseBestResult([web, disc], both, "WEBDL-1080p", profileId, 0, null, new Set(), "movie"))?.result;

    expect(await choose(discBelow)).toBe(web); // best of what is at or below the cutoff
    expect(await choose(discAbove)).toBe(web); // the disc is above the cutoff: only the WEB-DL is at or below it
    // And with only the disc on offer: below the cutoff it is taken, above it it is the fallback.
    expect((await sched.chooseBestResult([disc], both, "WEBDL-1080p", discBelow, 0, null, new Set(), "movie"))?.result).toBe(disc);
    expect((await sched.chooseBestResult([disc], both, "WEBDL-1080p", discAbove, 0, null, new Set(), "movie"))?.result).toBe(disc);
  });

  it("judge the upgrade of a file on disk by the profile's order", async () => {
    const webFirst = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ cutoff: "WEBDL-1080p", order: ["Bluray-1080p", "WEBDL-1080p"] })));
    const discFirst = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ cutoff: "Bluray-1080p", order: ["WEBDL-1080p", "Bluray-1080p"] })));
    const globalOrder = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ cutoff: "Bluray-1080p", order: null })));
    const file = (quality: string) => ({ quality, releaseTitle: null, formatScore: null });
    const offer = (quality: string) => ({ quality, title: `Movie.2020.${quality}-GRP` });
    const mode = rules.propersMode();

    // A disc on disk and a WEB-DL on offer: an upgrade only for the profile that ranks WEB-DL above the disc.
    expect(rules.judgeUpgrade(webFirst, mode, file("Bluray-1080p"), offer("WEBDL-1080p"))).toBe("yes");
    expect(rules.judgeUpgrade(discFirst, mode, file("Bluray-1080p"), offer("WEBDL-1080p"))).toBe("no");
    expect(rules.judgeUpgrade(globalOrder, mode, file("Bluray-1080p"), offer("WEBDL-1080p"))).toBe("no");
    // The reverse.
    expect(rules.judgeUpgrade(webFirst, mode, file("WEBDL-1080p"), offer("Bluray-1080p"))).toBe("no");
    expect(rules.judgeUpgrade(discFirst, mode, file("WEBDL-1080p"), offer("Bluray-1080p"))).toBe("yes");
    expect(rules.judgeUpgrade(globalOrder, mode, file("WEBDL-1080p"), offer("Bluray-1080p"))).toBe("yes");
  });

  it("decide whether the cutoff is met by the profile's order", async () => {
    // Both cut off at the disc; one of them ranks WEB-DL above it.
    const webAboveDisc = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ cutoff: "Bluray-1080p", order: ["Bluray-1080p", "WEBDL-1080p"] })));
    const globalOrder = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ cutoff: "Bluray-1080p", order: null })));
    const webFile = { quality: "WEBDL-1080p", releaseTitle: null, formatScore: null };

    expect(rules.qualityCutoffMet(webAboveDisc, webFile)).toBe(true);
    expect(rules.cutoffNotMet(webAboveDisc, webFile)).toBe(false);
    expect(rules.qualityCutoffMet(globalOrder, webFile)).toBe(false);
    expect(rules.cutoffNotMet(globalOrder, webFile)).toBe(true);
    expect(sched.meetsCutoff("WEBDL-1080p", "Bluray-1080p", q.rankingOf(webAboveDisc))).toBe(true);
    expect(sched.isBelowCutoff("WEBDL-1080p", "Bluray-1080p", q.rankingOf(globalOrder))).toBe(true);
  });

  it("list a file as cutoff unmet by the profile's order, on the auto-upgrade list and on the library filter", async () => {
    const { findUpgradeCandidates, clearUpgradeCandidatesCache } = await import("../src/services/upgradeCandidates.js");
    const { buildMediaQuery } = await import("../src/services/mediaQuery.js");
    const aboveDisc = await insertProfile({ cutoff: "Bluray-1080p", order: ["Bluray-1080p", "WEBDL-1080p"] });
    const global = await insertProfile({ cutoff: "Bluray-1080p", order: null });
    const insertMovie = async (title: string, profileId: number) =>
      Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', ?, ?, 1, 1, 'WEBDL-1080p', ?, 'unknown')")
            .run(title, title.toLowerCase(), profileId)
        ).lastInsertRowid
      );
    const metId = await insertMovie("Order Met", aboveDisc);
    const unmetId = await insertMovie("Order Unmet", global);
    clearUpgradeCandidatesCache();

    const candidates = (await findUpgradeCandidates()).map((c) => c.mediaItemId);
    expect(candidates).toContain(unmetId);
    expect(candidates).not.toContain(metId);

    const filter = await buildMediaQuery({ status: "cutoffUnmet", allowedTypes: null });
    const inFilter = async (id: number) => !!(await db.prepare(`SELECT m.id FROM ${filter.fromClause} WHERE ${filter.where} AND m.id = ?`).get(...filter.params, id));
    expect(await inFilter(unmetId)).toBe(true);
    expect(await inFilter(metId)).toBe(false);
  });
});

describe("a profile with no order behaves as it did before profiles could have one", () => {
  it("decides every pair of qualities as the global ranks do", () => {
    const names = DEFAULT_NAMES().filter((n) => q.qualityRank(n) >= 0);
    for (const quality of names) {
      for (const cutoff of names) {
        expect(q.isUnderCutoff(quality, cutoff, GLOBAL), `${quality} under ${cutoff}`).toBe(q.qualityRank(quality) < q.qualityRank(cutoff));
        expect(sched.meetsCutoff(quality, cutoff, GLOBAL), `${quality} meets ${cutoff}`).toBe(q.qualityRank(quality) >= q.qualityRank(cutoff));
        expect(sched.meetsCutoff(quality, cutoff, q.rankingFromRow({ quality_groups: "[]", quality_order: null }))).toBe(sched.meetsCutoff(quality, cutoff));
      }
    }
  });

  it("still reads a bare list of groups (the shape before profiles had an order) as a ranking with no order", () => {
    const groups = [["WEBDL-1080p", "WEBRip-1080p"]];
    expect((q.groupedRank as any)("WEBRip-1080p", groups)).toBe(q.groupedRank("WEBRip-1080p", { groups, order: null }));
    expect((q.sameQualityGroup as any)("WEBRip-1080p", "WEBDL-1080p", groups)).toBe(true);
  });
});

// Round 30f review H1: the editor and older clients save an order of only the allowed qualities. A file on disk whose
// quality the profile does not allow (a Remux-2160p in a profile of two 1080p tiers) used to rank below every listed
// tier, so it read as "cutoff unmet" and was replaced by a worse file.
describe("a file whose quality the profile's order leaves out", () => {
  const twoTiers = ["WEBDL-1080p", "Bluray-1080p"];

  it("stays above the cutoff, with no upgrade verdict and no Cutoff Unmet row, as it does without an order", async () => {
    const { findUpgradeCandidates, clearUpgradeCandidatesCache } = await import("../src/services/upgradeCandidates.js");
    const { buildMediaQuery } = await import("../src/services/mediaQuery.js");
    const ordered = await insertProfile({ allowed: twoTiers, cutoff: "Bluray-1080p", order: twoTiers });
    const plain = await insertProfile({ allowed: twoTiers, cutoff: "Bluray-1080p", order: null });
    const orderedProfile = rules.upgradeProfileOf(await mappedProfile(ordered));
    const plainProfile = rules.upgradeProfileOf(await mappedProfile(plain));
    const remux = { quality: "Remux-2160p", releaseTitle: null, formatScore: null };
    const mode = rules.propersMode();

    for (const profile of [orderedProfile, plainProfile]) {
      expect(rules.qualityCutoffMet(profile, remux)).toBe(true);
      expect(rules.cutoffNotMet(profile, remux)).toBe(false);
      expect(rules.judgeUpgrade(profile, mode, remux, { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRP" })).not.toBe("yes");
      expect(rules.judgeUpgrade(profile, mode, remux, { quality: "Bluray-1080p", title: "Movie.2020.1080p.BluRay.x264-GRP" })).not.toBe("yes");
    }

    const insertMovie = async (title: string, profileId: number, quality: string) =>
      Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', ?, ?, 1, 1, ?, ?, 'unknown')")
            .run(title, title.toLowerCase(), quality, profileId)
        ).lastInsertRowid
      );
    const remuxInOrdered = await insertMovie("Short Order Remux", ordered, "Remux-2160p");
    const remuxInPlain = await insertMovie("No Order Remux", plain, "Remux-2160p");
    // The lowest tier the profile does not allow is still under its cutoff, with an order or without one.
    const sdInOrdered = await insertMovie("Short Order SD", ordered, "SD");
    clearUpgradeCandidatesCache();

    const candidates = (await findUpgradeCandidates()).map((c) => c.mediaItemId);
    expect(candidates).not.toContain(remuxInOrdered);
    expect(candidates).not.toContain(remuxInPlain);
    expect(candidates).toContain(sdInOrdered);

    const filter = await buildMediaQuery({ status: "cutoffUnmet", allowedTypes: null });
    const inFilter = async (id: number) => !!(await db.prepare(`SELECT m.id FROM ${filter.fromClause} WHERE ${filter.where} AND m.id = ?`).get(...filter.params, id));
    expect(await inFilter(remuxInOrdered)).toBe(false);
    expect(await inFilter(remuxInPlain)).toBe(false);
    expect(await inFilter(sdInOrdered)).toBe(true);
  });

  it("is not replaced by a worse release found by the search", async () => {
    const ordered = await insertProfile({ allowed: twoTiers, cutoff: "Bluray-1080p", order: twoTiers });
    const ranking = q.rankingOf(await mappedProfile(ordered));
    // What the search and the importer ask: is the candidate better than what is on disk? A WEB-DL over a Remux-2160p is not.
    expect(q.groupedRank("WEBDL-1080p", ranking)).toBeLessThan(q.groupedRank("Remux-2160p", ranking));
    expect(q.groupedRank("Bluray-1080p", ranking)).toBeLessThan(q.groupedRank("Remux-2160p", ranking));
    const web = release("Movie.2020.1080p.WEB-DL.x264-GRPA", 5);
    // The automatic search for an upgrade of the Remux (upgradeFromRank is the global rank of what is on disk).
    const picked = await sched.chooseBestResult([web], twoTiers, "Bluray-1080p", ordered, 0, null, new Set(), "movie", null, null, null, { upgradeFromRank: q.qualityRank("Remux-2160p") });
    expect(picked).toBeNull();
  });

  it("does not change what a profile that ranks WEB-DL above Blu-ray decides about the qualities it lists", async () => {
    // (The tests above, with a short order: the WEB-DL is the top of this profile, so a Blu-ray is under its cutoff.)
    const webAbove = rules.upgradeProfileOf(await mappedProfile(await insertProfile({ allowed: twoTiers, cutoff: "WEBDL-1080p", order: ["Bluray-1080p", "WEBDL-1080p"] })));
    const file = (quality: string) => ({ quality, releaseTitle: null, formatScore: null });
    expect(rules.qualityCutoffMet(webAbove, file("WEBDL-1080p"))).toBe(true);
    expect(rules.qualityCutoffMet(webAbove, file("Bluray-1080p"))).toBe(false);
    expect(rules.qualityCutoffMet(webAbove, file("Remux-2160p"))).toBe(true);
    expect(rules.qualityCutoffMet(webAbove, file("HDTV-1080p"))).toBe(false);
    expect(rules.judgeUpgrade(webAbove, rules.propersMode(), file("Bluray-1080p"), { quality: "WEBDL-1080p", title: "Movie.2020.1080p.WEB-DL.x264-GRP" })).toBe("yes");
  });
});
