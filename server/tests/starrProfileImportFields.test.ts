import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let importStarrQualityProfiles: (typeof import("../src/services/starrImport.js"))["importStarrQualityProfiles"];
let previewStarrQualityProfiles: (typeof import("../src/services/starrImport.js"))["previewStarrQualityProfiles"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ importStarrQualityProfiles, previewStarrQualityProfiles } = await import("../src/services/starrImport.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockProfiles(profiles: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => profiles }) as any)
  );
}

async function storedProfile(name: string) {
  return (await db
    .prepare(
      "SELECT allowed_qualities, cutoff, min_format_score, prefer_cutoff_quality, upgrade_allowed, cutoff_format_score, min_upgrade_format_score, quality_groups FROM quality_profiles WHERE name = ?"
    )
    .get(name)) as Record<string, any>;
}

// Probe 1 of the settings audit: a profile set to "never replace a file" came in with upgrades on,
// the format-score cutoff and increment dropped, the groups flattened and the cutoff cap still on.
describe("importStarrQualityProfiles keeps the profile's upgrade settings (ST2)", () => {
  const radarrProfile = {
    id: 7,
    name: "HD-1080p no upgrades",
    upgradeAllowed: false,
    cutoff: 7,
    minFormatScore: 0,
    cutoffFormatScore: 10000,
    minUpgradeFormatScore: 25,
    items: [
      { quality: { id: 4, name: "HDTV-720p" }, items: [], allowed: true },
      {
        id: 1000,
        name: "WEB 1080p",
        allowed: true,
        items: [
          { quality: { id: 3, name: "WEBDL-1080p" }, items: [], allowed: true },
          { quality: { id: 15, name: "WEBRip-1080p" }, items: [], allowed: true },
        ],
      },
      { quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true },
    ],
    formatItems: [],
  };

  it("stores upgrade allowed, the format-score cutoff, the minimum increment and the quality groups", async () => {
    mockProfiles([radarrProfile]);

    const result = await importStarrQualityProfiles("http://radarr:7878", "key", "radarr", [7]);

    expect(result.added).toBe(1);
    const row = await storedProfile("HD-1080p no upgrades");
    expect(Number(row.upgrade_allowed)).toBe(0);
    expect(Number(row.cutoff_format_score)).toBe(10000);
    expect(Number(row.min_upgrade_format_score)).toBe(25);
    expect(JSON.parse(row.quality_groups)).toEqual([["WEBDL-1080p", "WEBRip-1080p"]]);
    expect(JSON.parse(row.allowed_qualities).sort()).toEqual(["Bluray-1080p", "HDTV-720p", "WEBDL-1080p", "WEBRip-1080p"]);
  });

  it("turns the cutoff cap off, because Radarr and Sonarr take the best allowed quality and use the cutoff only to stop upgrading", async () => {
    mockProfiles([{ ...radarrProfile, id: 8, name: "Cap check" }]);

    await importStarrQualityProfiles("http://radarr:7878", "key", "radarr", [8]);

    expect(Number((await storedProfile("Cap check")).prefer_cutoff_quality)).toBe(0);
  });

  it("keeps the defaults for a profile that does not carry the fields (an older Starr)", async () => {
    mockProfiles([
      { id: 9, name: "Old Starr", cutoff: 1, items: [{ quality: { id: 1, name: "Bluray-1080p" }, allowed: true }] },
    ]);

    await importStarrQualityProfiles("http://radarr:7878", "key", "radarr", [9]);

    const row = await storedProfile("Old Starr");
    expect(Number(row.upgrade_allowed)).toBe(1);
    expect(Number(row.cutoff_format_score)).toBe(0);
    expect(Number(row.min_upgrade_format_score)).toBe(1);
    expect(JSON.parse(row.quality_groups)).toEqual([]);
  });

  it("leaves out a group member that has no AoNarr quality, and a group left with one member is not a group", async () => {
    mockProfiles([
      {
        id: 10,
        name: "Half Mapped Group",
        cutoff: 2,
        items: [
          { quality: { id: 2, name: "Bluray-1080p" }, allowed: true },
          {
            id: 2000,
            name: "Mixed",
            allowed: true,
            items: [
              { quality: { id: 20, name: "Unknown" }, allowed: true },
              { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
            ],
          },
        ],
      },
    ]);

    await importStarrQualityProfiles("http://radarr:7878", "key", "radarr", [10]);

    expect(JSON.parse((await storedProfile("Half Mapped Group")).quality_groups)).toEqual([]);
  });

  it("shows the fields in the preview too", async () => {
    mockProfiles([{ ...radarrProfile, id: 11, name: "Preview" }]);

    const [preview] = await previewStarrQualityProfiles("http://radarr:7878", "key", "radarr");

    expect(preview).toMatchObject({ upgradeAllowed: false, cutoffFormatScore: 10000, minUpgradeFormatScore: 25 });
    expect(preview.qualityGroups).toEqual([["WEBDL-1080p", "WEBRip-1080p"]]);
  });
});
