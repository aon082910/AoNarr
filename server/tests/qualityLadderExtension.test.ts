import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import {
  DEFAULT_PROFILE_QUALITIES,
  DEFAULT_QUALITY_ORDER,
  LEGACY_QUALITY_ORDER,
  OPT_IN_QUALITIES,
  SD_CLASS_QUALITIES,
} from "../src/db/qualityLadder.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function ladder(): Promise<{ name: string; rank: number; min: number | null; max: number | null; preferred: number | null }[]> {
  return ((await db.prepare("SELECT name, rank, min_size_mb, max_size_mb, preferred_size_mb FROM qualities ORDER BY rank").all()) as any[]).map((r) => ({
    name: r.name,
    rank: Number(r.rank),
    min: r.min_size_mb,
    max: r.max_size_mb,
    preferred: r.preferred_size_mb,
  }));
}

async function profile(name: string): Promise<{ allowed: string[]; cutoff: string; groups: string[][]; raw: string }> {
  const row = (await db.prepare("SELECT allowed_qualities, cutoff, quality_groups FROM quality_profiles WHERE name = ?").get(name)) as any;
  let allowed: string[] = [];
  try {
    allowed = JSON.parse(row.allowed_qualities);
  } catch {
    // the broken profile
  }
  return { allowed, cutoff: row.cutoff, groups: JSON.parse(row.quality_groups), raw: row.allowed_qualities };
}

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

describe("a new install", () => {
  it("starts with the whole extended ladder, ranked 0..n-1, and the migration has nothing to do", async () => {
    const { ensureExtendedQualityLadder } = await import("../src/services/quality.js");
    const { getSetting } = await import("../src/services/settingsStore.js");
    expect((await ladder()).map((r) => r.name)).toEqual([...DEFAULT_QUALITY_ORDER]);
    expect((await ladder()).map((r) => r.rank)).toEqual(DEFAULT_QUALITY_ORDER.map((_, i) => i));
    // The default profile allows SD and the SD-class tiers beside it: a 480p WEB-DL is no longer "SD".
    const any = await profile("Any");
    expect(any.allowed).toEqual([...DEFAULT_PROFILE_QUALITIES]);
    expect(any.allowed).not.toContain("CAM");
    // Started already extended: the flag is set, and a second call changes nothing.
    expect(getSetting("qualityLadderExtended")).toBe("1");
    await ensureExtendedQualityLadder();
    expect((await ladder()).map((r) => r.name)).toEqual([...DEFAULT_QUALITY_ORDER]);
    expect(await profile("Any")).toEqual(any);
  });

  it("seeds the same ladder and default profile from the Postgres seed (its portable SQL runs on either database)", async () => {
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("DELETE FROM qualities").run();

    await seedPostgresDefaults(db);

    expect((await ladder()).map((r) => r.name)).toEqual([...DEFAULT_QUALITY_ORDER]);
    expect((await profile("Any")).allowed).toEqual([...DEFAULT_PROFILE_QUALITIES]);
  });
});

describe("planLadderExtension", () => {
  it("puts each missing tier after its nearest predecessor on the default ladder that is present", async () => {
    const { planLadderExtension } = await import("../src/services/quality.js");
    // An admin who reordered the ladder and deleted most of it.
    const plan = planLadderExtension(["DVD", "SD", "Remux-2160p", "HDTV-720p"]);
    expect(plan.order).toEqual([
      "WORKPRINT",
      "CAM",
      "TELESYNC",
      "TELECINE",
      "REGIONAL",
      "DVDSCR",
      "DVD",
      "DVD-R",
      "SD",
      "SDTV",
      "WEBRip-480p",
      "WEBDL-480p",
      "Bluray-480p",
      "Bluray-576p",
      "Remux-2160p",
      "BR-DISK",
      "Raw-HD",
      "HDTV-720p",
    ]);
    expect(plan.added).toHaveLength(plan.order.length - 4);
  });

  it("adds nothing to a ladder that already has every new tier, and never re-adds an older tier an admin deleted", async () => {
    const { planLadderExtension } = await import("../src/services/quality.js");
    const withoutBluray720 = DEFAULT_QUALITY_ORDER.filter((n) => n !== "Bluray-720p");
    const plan = planLadderExtension([...withoutBluray720]);
    expect(plan.added).toEqual([]);
    expect(plan.order).toEqual([...withoutBluray720]);
  });
});

describe("extending the ladder of an install from before it had Starr's tiers", () => {
  /** The ladder as it was, ranked 0..15, with size limits on SD and DVD the admin had set. */
  async function installBefore(): Promise<void> {
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("DELETE FROM qualities").run();
    for (const [rank, name] of LEGACY_QUALITY_ORDER.entries()) {
      const limits = name === "SD" ? [5, 800, 400] : name === "DVD" ? [10, 1600, null] : [null, null, null];
      await db.prepare("INSERT INTO qualities (name, rank, min_size_mb, max_size_mb, preferred_size_mb) VALUES (?, ?, ?, ?, ?)").run(name, rank, ...limits);
    }
    const insert = (name: string, allowed: unknown, cutoff: string, groups: string[][] = []) =>
      db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups) VALUES (?, ?, ?, ?)")
        .run(name, typeof allowed === "string" ? allowed : JSON.stringify(allowed), cutoff, JSON.stringify(groups));
    await insert("sd and dvd", ["SD", "DVD", "HDTV-720p", "WEBDL-1080p"], "HDTV-720p");
    await insert("sd grouped", ["SD", "DVD", "WEBDL-720p", "WEBRip-720p"], "WEBDL-720p", [["SD", "DVD"], ["WEBDL-720p", "WEBRip-720p"]]);
    await insert("hd only", ["WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p", [["WEBDL-1080p", "Bluray-1080p"]]);
    await insert("has some already", ["SD", "SDTV", "DVD"], "DVD");
    await insert("allows everything", [], "SD");
    await insert("unreadable", "not json", "SD");
    await insert("cutoff off the list", ["SD", "HDTV-720p"], "Bluray-1080p");
    // Files, history and the blocklist name their qualities: they are never rewritten.
    await db.prepare("DELETE FROM media_items").run();
    await db
      .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality, status) VALUES ('movie', 'Old SD file', 'old', 1, 1, 'SD', 'unknown')")
      .run();
  }

  async function snapshot() {
    const names = ["sd and dvd", "sd grouped", "hd only", "has some already", "allows everything", "unreadable", "cutoff off the list"];
    return { ladder: await ladder(), profiles: await Promise.all(names.map((n) => profile(n))) };
  }

  it("inserts the new tiers at the right ranks, copies the size limits of SD and DVD, and gives profiles what they took before", async () => {
    const { ensureExtendedQualityLadder } = await import("../src/services/quality.js");
    const { getSetting, setSetting } = await import("../src/services/settingsStore.js");
    await installBefore();
    setSetting("qualityLadderExtended", "");

    await ensureExtendedQualityLadder();

    const after = await ladder();
    expect(after.map((r) => r.name)).toEqual([...DEFAULT_QUALITY_ORDER]);
    expect(after.map((r) => r.rank)).toEqual(DEFAULT_QUALITY_ORDER.map((_, i) => i));
    // The pre-release tiers are the very bottom, BR-DISK and Raw-HD the top, SD where it was relative to DVD.
    expect(after.slice(0, 6).map((r) => r.name)).toEqual(["WORKPRINT", "CAM", "TELESYNC", "TELECINE", "REGIONAL", "DVDSCR"]);
    expect(after.slice(-2).map((r) => r.name)).toEqual(["BR-DISK", "Raw-HD"]);
    const at = (name: string) => after.findIndex((r) => r.name === name);
    // Everything that was SD still ranks between SD and DVD, as it did when it was all SD.
    expect(at("SD")).toBeLessThan(at("SDTV"));
    expect(at("Bluray-576p")).toBeLessThan(at("DVD"));
    expect(at("DVD")).toBeLessThan(at("DVD-R"));
    expect(at("DVD-R")).toBeLessThan(at("HDTV-720p"));
    // The limits SD and DVD had carry to what was graded as them; the tiers nothing was graded as start open.
    const limits = (name: string) => after.find((r) => r.name === name)!;
    for (const name of SD_CLASS_QUALITIES) expect(limits(name), name).toMatchObject({ min: 5, max: 800, preferred: 400 });
    expect(limits("SD")).toMatchObject({ min: 5, max: 800, preferred: 400 });
    expect(limits("DVD")).toMatchObject({ min: 10, max: 1600, preferred: null });
    expect(limits("DVD-R")).toMatchObject({ min: 10, max: 1600, preferred: null });
    for (const name of OPT_IN_QUALITIES) expect(limits(name), name).toMatchObject({ min: null, max: null, preferred: null });
    expect(limits("Remux-2160p")).toMatchObject({ min: null, max: null, preferred: null });

    // A profile that allowed SD allows the SD-class tiers beside it, one that allowed DVD allows DVD-R; no cutoff moved.
    // SD and the tiers split out of it are one quality group, so they stay the one tier they were.
    const sdTiers = [...SD_CLASS_QUALITIES];
    expect(await profile("sd and dvd")).toMatchObject({ allowed: ["SD", ...sdTiers, "DVD", "DVD-R", "HDTV-720p", "WEBDL-1080p"], cutoff: "HDTV-720p", groups: [["SD", ...sdTiers]] });
    expect(await profile("sd grouped")).toMatchObject({
      allowed: ["SD", ...sdTiers, "DVD", "DVD-R", "WEBDL-720p", "WEBRip-720p"],
      cutoff: "WEBDL-720p",
      // A group holding SD or DVD takes the new members of that class; the other group is as it was.
      groups: [["SD", "DVD", ...sdTiers, "DVD-R"], ["WEBDL-720p", "WEBRip-720p"]],
    });
    // A profile with neither is untouched, down to the group.
    expect(await profile("hd only")).toMatchObject({ allowed: ["WEBDL-1080p", "Bluray-1080p"], cutoff: "Bluray-1080p", groups: [["WEBDL-1080p", "Bluray-1080p"]] });
    // One that already lists some of the new names gains only what it lacks, and none twice.
    expect(await profile("has some already")).toMatchObject({
      allowed: ["SD", "WEBRip-480p", "WEBDL-480p", "Bluray-480p", "Bluray-576p", "SDTV", "DVD", "DVD-R"],
      groups: [["SD", ...sdTiers]],
    });
    // "Allows everything" (an empty list) stays that way, an unreadable list is left for the admin, a stray cutoff is not repaired here.
    expect((await profile("allows everything")).allowed).toEqual([]);
    expect((await profile("unreadable")).raw).toBe("not json");
    expect(await profile("cutoff off the list")).toMatchObject({ allowed: ["SD", ...sdTiers, "HDTV-720p"], cutoff: "Bluray-1080p", groups: [["SD", ...sdTiers]] });

    // The point of the group: every decision a profile made about SD is the one it makes now about the tiers split out of it.
    const { loadQualityCaches, groupedRank, isUnderCutoff, rankingFromRow, sameQualityGroup } = await import("../src/services/quality.js");
    await loadQualityCaches();
    const row = (await db.prepare("SELECT quality_groups, quality_order FROM quality_profiles WHERE name = 'sd and dvd'").get()) as any;
    const ranking = rankingFromRow(row);
    for (const name of sdTiers) {
      expect(groupedRank(name, ranking), name).toBe(groupedRank("SD", ranking));
      expect(sameQualityGroup(name, "SD", ranking), name).toBe(true);
      // Under a DVD or an HD cutoff exactly when an SD file was; at an SD cutoff exactly when it was not.
      expect(isUnderCutoff(name, "DVD", ranking), name).toBe(true);
      expect(isUnderCutoff(name, "HDTV-720p", ranking), name).toBe(true);
      expect(isUnderCutoff(name, "SD", ranking), name).toBe(false);
    }
    expect(isUnderCutoff("SD", "DVD", ranking)).toBe(true);

    // No profile gained a pre-release tier, BR-DISK or Raw-HD.
    for (const name of ["sd and dvd", "sd grouped", "hd only", "has some already", "cutoff off the list"]) {
      const p = await profile(name);
      for (const optIn of OPT_IN_QUALITIES) expect(p.allowed, `${name} / ${optIn}`).not.toContain(optIn);
      for (const group of p.groups) for (const optIn of OPT_IN_QUALITIES) expect(group).not.toContain(optIn);
    }

    // What files recorded keeps its name.
    const file = (await db.prepare("SELECT quality FROM media_items WHERE title = 'Old SD file'").get()) as { quality: string };
    expect(file.quality).toBe("SD");
    expect(getSetting("qualityLadderExtended")).toBe("1");
  });

  it("changes nothing the second time, with the flag set or not", async () => {
    const { ensureExtendedQualityLadder } = await import("../src/services/quality.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    const once = await snapshot();

    await ensureExtendedQualityLadder();
    expect(await snapshot()).toEqual(once);

    setSetting("qualityLadderExtended", "");
    await ensureExtendedQualityLadder();
    expect(await snapshot()).toEqual(once);
  });

  it("leaves a tier deleted afterwards deleted", async () => {
    const { ensureExtendedQualityLadder } = await import("../src/services/quality.js");
    await db.prepare("DELETE FROM qualities WHERE name = 'CAM'").run();
    await ensureExtendedQualityLadder();
    expect((await ladder()).map((r) => r.name)).not.toContain("CAM");
  });

  it("keeps an admin's own order around the new tiers, on a ladder the admin trimmed", async () => {
    const { ensureExtendedQualityLadder } = await import("../src/services/quality.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("DELETE FROM qualities").run();
    for (const [rank, name] of ["WEBDL-1080p", "SD", "Bluray-1080p", "DVD"].entries()) {
      await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run(name, rank);
    }
    setSetting("qualityLadderExtended", "");

    await ensureExtendedQualityLadder();

    const names = (await ladder()).map((r) => r.name);
    // The admin's WEBDL-1080p, SD, Bluray-1080p, DVD stay in that order; the new tiers slot in beside their neighbours.
    expect(names.filter((n) => ["WEBDL-1080p", "SD", "Bluray-1080p", "DVD"].includes(n))).toEqual(["WEBDL-1080p", "SD", "Bluray-1080p", "DVD"]);
    expect(names.slice(0, 6)).toEqual(["WORKPRINT", "CAM", "TELESYNC", "TELECINE", "REGIONAL", "DVDSCR"]);
    expect(names.indexOf("SDTV")).toBe(names.indexOf("SD") + 1);
    expect(names.indexOf("DVD-R")).toBe(names.indexOf("DVD") + 1);
    expect((await ladder()).map((r) => r.rank)).toEqual(names.map((_, i) => i));
  });
});
