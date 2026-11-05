import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { DEFAULT_QUALITY_ORDER, EXTENDED_LADDER_TIERS, LEGACY_QUALITY_ORDER, SD_CLASS_QUALITIES } from "../src/db/qualityLadder.js";

// Round 30f review M2: a settings template made before the quality ladder was extended names "SD" for what is now
// several tiers. Importing it must give its profiles what the migration gave every profile that allowed SD or DVD,
// or the import undoes the migration (a 480p WEB-DL or an SDTV capture, no longer "SD", would be refused).

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);
/** (The import reads a profile's minFormatScore and maxSizeGb as named parameters, so every profile carries them.) */
const importTemplate = (body: { qualityProfiles: object[] }) =>
  authed(request(app).post("/api/settings/template/import")).send({ ...body, qualityProfiles: body.qualityProfiles.map((p) => ({ minFormatScore: 0, maxSizeGb: null, ...p })) });

async function profile(name: string): Promise<{ allowed: string[]; groups: string[][]; order: string[] | null }> {
  const row = (await db.prepare("SELECT allowed_qualities, quality_groups, quality_order FROM quality_profiles WHERE name = ?").get(name)) as any;
  return { allowed: JSON.parse(row.allowed_qualities), groups: JSON.parse(row.quality_groups), order: row.quality_order ? JSON.parse(row.quality_order) : null };
}

/** The profiles an install from before the extension had, as a template of that time wrote them (no qualityOrder). */
const OLD_PROFILES: { name: string; allowedQualities: string[]; qualityGroups?: string[][]; cutoff: string }[] = [
  { name: "sd and dvd", allowedQualities: ["SD", "DVD", "HDTV-720p", "WEBDL-1080p"], qualityGroups: [], cutoff: "HDTV-720p" },
  { name: "sd grouped", allowedQualities: ["SD", "DVD", "WEBDL-720p", "WEBRip-720p"], qualityGroups: [["SD", "DVD"], ["WEBDL-720p", "WEBRip-720p"]], cutoff: "WEBDL-720p" },
  { name: "hd only", allowedQualities: ["WEBDL-1080p", "Bluray-1080p"], qualityGroups: [["WEBDL-1080p", "Bluray-1080p"]], cutoff: "Bluray-1080p" },
  { name: "before groups", allowedQualities: ["SD", "HDTV-720p"], cutoff: "HDTV-720p" },
  { name: "everything", allowedQualities: [], qualityGroups: [], cutoff: "SD" },
];

/** What the migration makes of the same profiles: the install as it was, then the real migration. */
async function migratedProfiles(): Promise<Record<string, { allowed: string[]; groups: string[][] }>> {
  const { ensureExtendedQualityLadder, loadQualityCaches } = await import("../src/services/quality.js");
  const { setSetting } = await import("../src/services/settingsStore.js");
  await db.prepare("DELETE FROM quality_profiles").run();
  await db.prepare("DELETE FROM qualities").run();
  for (const [rank, name] of LEGACY_QUALITY_ORDER.entries()) await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run(name, rank);
  for (const p of OLD_PROFILES) {
    await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups) VALUES (?, ?, ?, ?)")
      .run(`migrated ${p.name}`, JSON.stringify(p.allowedQualities), p.cutoff, JSON.stringify(p.qualityGroups ?? []));
  }
  setSetting("qualityLadderExtended", "");
  await ensureExtendedQualityLadder();
  await loadQualityCaches();
  const result: Record<string, { allowed: string[]; groups: string[][] }> = {};
  for (const p of OLD_PROFILES) {
    const { allowed, groups } = await profile(`migrated ${p.name}`);
    result[p.name] = { allowed, groups };
  }
  return result;
}

describe("importing a settings template made before the ladder was extended", () => {
  it("gives its profiles exactly what the migration gives profiles that allowed SD or DVD", async () => {
    const expected = await migratedProfiles();
    // (The ladder is the extended one again, as on any install after the migration ran.)
    expect((await db.prepare("SELECT name FROM qualities ORDER BY rank").all() as { name: string }[]).map((r) => r.name)).toEqual([...DEFAULT_QUALITY_ORDER]);
    // The migration did something to the profiles that list SD or DVD, and nothing to the others.
    expect(expected["sd and dvd"].allowed).toEqual(expect.arrayContaining([...SD_CLASS_QUALITIES, "DVD-R"]));
    expect(expected["sd and dvd"].groups).toEqual([["SD", ...SD_CLASS_QUALITIES]]);
    expect(expected["hd only"].allowed).toEqual(["WEBDL-1080p", "Bluray-1080p"]);

    const old = { templateVersion: 2, qualityProfiles: OLD_PROFILES.map((p) => ({ ...p, name: `template ${p.name}` })) };
    const res = await importTemplate(old);
    expect(res.status).toBe(200);

    for (const p of OLD_PROFILES) {
      const imported = await profile(`template ${p.name}`);
      expect(imported.allowed, p.name).toEqual(expected[p.name].allowed);
      expect(imported.groups, p.name).toEqual(expected[p.name].groups);
    }
    // The point of it: a profile restored from the template still takes what it took as "SD".
    const { rankingFromRow, groupedRank, sameQualityGroup } = await import("../src/services/quality.js");
    const sd = await profile("template sd and dvd");
    expect(sd.allowed).toContain("SDTV");
    expect(sameQualityGroup("SD", "SDTV", rankingFromRow({ quality_groups: JSON.stringify(sd.groups) }))).toBe(true);
    expect(groupedRank("SDTV", rankingFromRow({ quality_groups: JSON.stringify(sd.groups) }))).toBe(groupedRank("SD", rankingFromRow({ quality_groups: JSON.stringify(sd.groups) })));
  });

  it("adds only the tiers this install has, and leaves a profile with its own order whole", async () => {
    const { loadQualityCaches } = await import("../src/services/quality.js");
    await db.prepare("DELETE FROM qualities WHERE name = 'WEBRip-480p'").run();
    await loadQualityCaches();
    await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups, quality_order) VALUES ('own order', ?, 'HDTV-720p', '[]', ?)").run(
      JSON.stringify(["HDTV-720p"]),
      JSON.stringify(["HDTV-720p"])
    );
    const res = await importTemplate({ qualityProfiles: [{ name: "own order", allowedQualities: ["SD", "HDTV-720p"], qualityGroups: [], cutoff: "HDTV-720p" }] });
    expect(res.status).toBe(200);

    const after = await profile("own order");
    expect(after.allowed).toEqual(["SD", "SDTV", "WEBDL-480p", "Bluray-480p", "Bluray-576p", "HDTV-720p"]);
    expect(after.allowed).not.toContain("WEBRip-480p");
    expect(after.groups).toEqual([["SD", "SDTV", "WEBDL-480p", "Bluray-480p", "Bluray-576p"]]);
    // The order the profile already had is kept and completed with what the template allows now.
    expect(after.order).toEqual(expect.arrayContaining(after.allowed));
    expect(after.order![after.order!.length - 1]).toBe("HDTV-720p");
  });

  it("does not touch a template made since: it carries a qualityOrder (null or a list), so its profiles are as written", async () => {
    const res = await importTemplate({
      qualityProfiles: [
        { name: "new null order", allowedQualities: ["SD", "HDTV-720p"], qualityGroups: [], qualityOrder: null, cutoff: "HDTV-720p" },
        { name: "new list order", allowedQualities: ["SD", "DVD", "HDTV-720p"], qualityGroups: [["SD", "DVD"]], qualityOrder: ["SD", "DVD", "HDTV-720p"], cutoff: "HDTV-720p" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await profile("new null order")).toEqual({ allowed: ["SD", "HDTV-720p"], groups: [], order: null });
    expect(await profile("new list order")).toEqual({ allowed: ["SD", "DVD", "HDTV-720p"], groups: [["SD", "DVD"]], order: ["SD", "DVD", "HDTV-720p"] });
  });

  it("does not touch a template whose profiles already list the new tiers", async () => {
    const res = await importTemplate({ qualityProfiles: [{ name: "lists new tiers", allowedQualities: ["SD", "SDTV", "HDTV-720p"], qualityGroups: [], cutoff: "HDTV-720p" }] });
    expect(res.status).toBe(200);
    expect(await profile("lists new tiers")).toMatchObject({ allowed: ["SD", "SDTV", "HDTV-720p"], groups: [] });
  });

  it("names the extension's tiers in one place the check and the migration share", async () => {
    const { templatePredatesLadderExtension } = await import("../src/services/quality.js");
    expect(templatePredatesLadderExtension([{ allowedQualities: ["SD"] }])).toBe(true);
    expect(templatePredatesLadderExtension([{ allowedQualities: ["SD"], qualityOrder: null }])).toBe(false);
    expect(templatePredatesLadderExtension([{ allowedQualities: [EXTENDED_LADDER_TIERS[0]] }])).toBe(false);
    expect(templatePredatesLadderExtension([])).toBe(false);
    expect(templatePredatesLadderExtension(undefined)).toBe(false);
  });
});
