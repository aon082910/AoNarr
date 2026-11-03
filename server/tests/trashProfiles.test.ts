import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { translateTrashProfile, type TrashProfileFile } from "../src/services/trashProfiles.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

// TRaSH-Guides docs/json/radarr/quality-profiles/hd-bluray-web.json, shortened.
const hdBlurayWeb: TrashProfileFile = {
  trash_id: "d1d67249d3890e49bc12e275d989a7e9",
  name: "HD Bluray + WEB",
  trash_description: "Quality Profile that covers:<br>- WEBDL: 1080p<br>- Bluray: 720p, 1080p",
  upgradeAllowed: true,
  cutoff: "Bluray-1080p",
  minFormatScore: 0,
  cutoffFormatScore: 10000,
  minUpgradeFormatScore: 1,
  items: [
    { name: "Bluray-1080p", allowed: true },
    { name: "WEB 1080p", allowed: true, items: ["WEBRip-1080p", "WEBDL-1080p"] },
    { name: "Bluray-720p", allowed: true },
    { name: "Raw-HD", allowed: false },
    { name: "Remux-2160p", allowed: false },
    { name: "SDTV", allowed: false },
  ],
  formatItems: { "HD Bluray Tier 01": "tier01", "WEB Tier 01": "webtier01", "Repack/Proper": "repack", "Never Synced": "ghost" },
};

const ranks = new Map(
  ["SD", "DVD", "HDTV-720p", "WEBRip-720p", "WEBDL-720p", "Bluray-720p", "HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-1080p", "HDTV-2160p", "WEBRip-2160p", "WEBDL-2160p", "Bluray-2160p", "Remux-2160p"].map((n, i) => [n, i])
);

const formats = new Map([
  ["tier01", { id: 1, name: "HD Bluray Tier 01", trash_scores: JSON.stringify({ default: 1800, "anime-radarr": 900 }) }],
  ["webtier01", { id: 2, name: "WEB Tier 01", trash_scores: JSON.stringify({ default: 1700 }) }],
  ["repack", { id: 3, name: "Repack/Proper", trash_scores: null }],
]);

describe("translateTrashProfile (ST15)", () => {
  it("maps allowed qualities, a group, the cutoff and the upgrade settings", () => {
    const t = translateTrashProfile(hdBlurayWeb, ranks, formats);

    expect(t.allowedQualities.sort()).toEqual(["Bluray-1080p", "Bluray-720p", "WEBDL-1080p", "WEBRip-1080p"]);
    expect(t.qualityGroups).toEqual([["WEBRip-1080p", "WEBDL-1080p"]]);
    expect(t.cutoff).toBe("Bluray-1080p");
    expect(t).toMatchObject({ upgradeAllowed: true, minFormatScore: 0, cutoffFormatScore: 10000, minUpgradeFormatScore: 1, scoreSet: "default" });
  });

  it("scores the formats it can, and reports the ones not synced and the ones with no score", () => {
    const t = translateTrashProfile(hdBlurayWeb, ranks, formats);

    expect(t.scores).toEqual([
      { customFormatId: 1, formatName: "HD Bluray Tier 01", score: 1800 },
      { customFormatId: 2, formatName: "WEB Tier 01", score: 1700 },
    ]);
    expect(t.missingFormats).toEqual(["Never Synced"]);
    expect(t.unscoredFormats).toEqual(["Repack/Proper"]);
  });

  it("takes the score of the chosen set, and the default set where a format has none for it", () => {
    const t = translateTrashProfile(hdBlurayWeb, ranks, formats, "anime-radarr");

    expect(t.scoreSet).toBe("anime-radarr");
    expect(t.scores.map((s) => s.score)).toEqual([900, 1700]);
  });

  it("uses the profile's own score set when it names one", () => {
    const t = translateTrashProfile({ ...hdBlurayWeb, trash_score_set: "anime-radarr" }, ranks, formats);
    expect(t.scoreSet).toBe("anime-radarr");
  });

  it("resolves a group cutoff to the group's lowest member, and reports qualities AoNarr has no tier for", () => {
    const t = translateTrashProfile(
      {
        ...hdBlurayWeb,
        cutoff: "WEB 1080p",
        items: [
          { name: "Bluray-1080p", allowed: true },
          { name: "WEB 1080p", allowed: true, items: ["WEBRip-1080p", "WEBDL-1080p"] },
          { name: "Raw-HD", allowed: true },
          { name: "BR-DISK", allowed: true },
        ],
      },
      ranks,
      formats
    );

    expect(t.cutoff).toBe("WEBRip-1080p");
    expect(t.unmappedQualities.sort()).toEqual(["BR-DISK", "Raw-HD"]);
  });

  it("folds the standard-definition names into AoNarr's SD and DVD tiers", () => {
    const t = translateTrashProfile(
      {
        ...hdBlurayWeb,
        cutoff: "DVD",
        items: [
          { name: "DVD", allowed: true },
          { name: "DVD-R", allowed: true },
          { name: "SDTV", allowed: true },
          { name: "WEB 480p", allowed: true, items: ["WEBRip-480p", "WEBDL-480p"] },
          { name: "Bluray-576p", allowed: true },
        ],
      },
      ranks,
      formats
    );

    expect(t.allowedQualities.sort()).toEqual(["DVD", "SD"]);
    expect(t.cutoff).toBe("DVD");
    expect(t.qualityGroups).toEqual([]); // both members are SD: one quality is not a group
  });

  it("falls back to the best allowed quality when the cutoff names nothing", () => {
    expect(translateTrashProfile({ ...hdBlurayWeb, cutoff: "No Such Quality" }, ranks, formats).cutoff).toBe("Bluray-1080p");
  });
});

/** Stubs fetch for the GitHub directory listing, the per-file downloads and the raw profile file. */
function mockTrashRepo(profiles: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) {
        return { ok: true, json: async () => Object.keys(profiles).map((name) => ({ name, type: "file", download_url: `https://raw.test/${name}` })) } as any;
      }
      const name = url.split("/").pop() as string;
      const body = profiles[name];
      if (body === undefined) return { ok: false, status: 404 } as any;
      return { ok: true, json: async () => body } as any;
    })
  );
}

describe("GET /api/custom-formats/trash-profiles", () => {
  it("lists the profiles, tidying the description", async () => {
    mockTrashRepo({ "hd-bluray-web.json": hdBlurayWeb, "notes.json": { not: "a profile" } });

    const res = await authed(request(app).get("/api/custom-formats/trash-profiles?app=radarr"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ file: "hd-bluray-web.json", name: "HD Bluray + WEB", description: "Quality Profile that covers: - WEBDL: 1080p - Bluray: 720p, 1080p", scoreSet: "default" }]);
  });

  it("answers 502 when GitHub does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as any));

    const res = await authed(request(app).get("/api/custom-formats/trash-profiles?app=radarr"));

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("HTTP 503");
  });
});

describe("POST /api/custom-formats/trash-profiles/import", () => {
  async function addSyncedFormat(name: string, trashId: string, scores: Record<string, number> | null) {
    const result = await db
      .prepare("INSERT INTO custom_formats (name, patterns, trash_id, trash_scores) VALUES (?, '[]', ?, ?)")
      .run(name, trashId, scores ? JSON.stringify(scores) : null);
    return Number(result.lastInsertRowid);
  }

  it("creates the profile with its groups and upgrade settings, and scores the synced formats", async () => {
    const tier01 = await addSyncedFormat("HD Bluray Tier 01", "tier01", { default: 1800 });
    await addSyncedFormat("WEB Tier 01", "webtier01", { default: 1700 });
    await addSyncedFormat("Repack/Proper", "repack", null);
    mockTrashRepo({ "hd-bluray-web.json": hdBlurayWeb });

    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "hd-bluray-web.json" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "HD Bluray + WEB", created: true, scoresApplied: 2, cutoff: "Bluray-1080p", missingFormats: ["Never Synced"], unscoredFormats: ["Repack/Proper"] });
    const row = (await db.prepare("SELECT * FROM quality_profiles WHERE name = 'HD Bluray + WEB'").get()) as any;
    expect(JSON.parse(row.allowed_qualities).sort()).toEqual(["Bluray-1080p", "Bluray-720p", "WEBDL-1080p", "WEBRip-1080p"]);
    expect(JSON.parse(row.quality_groups)).toEqual([["WEBRip-1080p", "WEBDL-1080p"]]);
    expect([Number(row.cutoff_format_score), Number(row.min_upgrade_format_score), Number(row.upgrade_allowed), Number(row.prefer_cutoff_quality)]).toEqual([10000, 1, 1, 0]);
    const score = (await db.prepare("SELECT score FROM quality_profile_format_scores WHERE quality_profile_id = ? AND custom_format_id = ?").get(row.id, tier01)) as any;
    expect(Number(score.score)).toBe(1800);
  });

  it("updates the profile of the same name on a second import instead of adding another, and re-scores", async () => {
    await db.prepare("UPDATE custom_formats SET trash_scores = ? WHERE trash_id = 'tier01'").run(JSON.stringify({ default: 2000 }));
    mockTrashRepo({ "hd-bluray-web.json": { ...hdBlurayWeb, upgradeAllowed: false } });

    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "hd-bluray-web.json" });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    const rows = (await db.prepare("SELECT upgrade_allowed FROM quality_profiles WHERE name = 'HD Bluray + WEB'").all()) as any[];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].upgrade_allowed)).toBe(0);
    const score = (await db.prepare("SELECT s.score FROM quality_profile_format_scores s JOIN custom_formats f ON f.id = s.custom_format_id WHERE f.trash_id = 'tier01'").get()) as any;
    expect(Number(score.score)).toBe(2000);
  });

  it("leaves the scores of formats the TRaSH profile does not list alone", async () => {
    const mine = await addSyncedFormat("My Own Format", "mine", { default: 50 });
    const profileId = ((await db.prepare("SELECT id FROM quality_profiles WHERE name = 'HD Bluray + WEB'").get()) as any).id;
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, 77)").run(profileId, mine);
    mockTrashRepo({ "hd-bluray-web.json": hdBlurayWeb });

    await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "hd-bluray-web.json" }).expect(200);

    const score = (await db.prepare("SELECT score FROM quality_profile_format_scores WHERE quality_profile_id = ? AND custom_format_id = ?").get(profileId, mine)) as any;
    expect(Number(score.score)).toBe(77);
  });

  it("uses the score set the caller names", async () => {
    await db.prepare("UPDATE custom_formats SET trash_scores = ? WHERE trash_id = 'tier01'").run(JSON.stringify({ default: 1800, "anime-radarr": 900 }));
    mockTrashRepo({ "hd-bluray-web.json": { ...hdBlurayWeb, name: "HD Bluray + WEB (anime)" } });

    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "hd-bluray-web.json", scoreSet: "anime-radarr" });

    expect(res.body.scoreSet).toBe("anime-radarr");
    const score = (await db.prepare("SELECT s.score FROM quality_profile_format_scores s JOIN quality_profiles p ON p.id = s.quality_profile_id JOIN custom_formats f ON f.id = s.custom_format_id WHERE p.name = 'HD Bluray + WEB (anime)' AND f.trash_id = 'tier01'").get()) as any;
    expect(Number(score.score)).toBe(900);
  });

  it("refuses a file name that is not a plain profile file, and a file that is not a profile", async () => {
    mockTrashRepo({ "readme.json": { hello: "world" } });
    expect((await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "../secrets.json" })).status).toBe(400);
    expect((await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr" })).status).toBe(400);
    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "readme.json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not a TRaSH-Guides quality profile");
  });

  it("refuses a profile none of whose qualities AoNarr has", async () => {
    mockTrashRepo({ "cams.json": { name: "Only CAM", cutoff: "CAM", items: [{ name: "CAM", allowed: true }, { name: "TELESYNC", allowed: true }] } });

    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "radarr", file: "cams.json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("None of this profile's qualities");
    expect(await db.prepare("SELECT 1 FROM quality_profiles WHERE name = 'Only CAM'").get()).toBeFalsy();
  });

  it("answers 502 when GitHub does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as any));

    const res = await authed(request(app).post("/api/custom-formats/trash-profiles/import")).send({ app: "sonarr", file: "web-1080p.json" });

    expect(res.status).toBe(502);
  });
});
