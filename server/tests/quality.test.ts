import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

describe("quality", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("ranks qualities according to the seeded default order (worst to best)", async () => {
    const { qualityRank } = await import("../src/services/quality.js");
    expect(qualityRank("SD")).toBeLessThan(qualityRank("HDTV-1080p"));
    expect(qualityRank("HDTV-1080p")).toBeLessThan(qualityRank("Bluray-1080p"));
    expect(qualityRank("Bluray-1080p")).toBeLessThan(qualityRank("Remux-2160p"));
  });

  it("returns -1 for an unknown or null quality name", async () => {
    const { qualityRank } = await import("../src/services/quality.js");
    expect(qualityRank("NotAThing")).toBe(-1);
    expect(qualityRank(null)).toBe(-1);
  });

  it("picks the highest-ranked allowed quality at or below cutoff", async () => {
    const { pickBestAllowedQuality } = await import("../src/services/quality.js");
    const allowed = ["HDTV-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-2160p"];
    const best = pickBestAllowedQuality(["HDTV-1080p", "WEBDL-1080p", "Remux-2160p"], allowed, "Bluray-1080p");
    // Remux-2160p is allowed and present but above cutoff — WEBDL-1080p should win as the
    // highest-ranked candidate still at or below the Bluray-1080p cutoff.
    expect(best).toBe("WEBDL-1080p");
  });

  it("falls back to the best available allowed quality when nothing meets the cutoff", async () => {
    const { pickBestAllowedQuality } = await import("../src/services/quality.js");
    const allowed = ["HDTV-1080p", "WEBDL-1080p", "Bluray-1080p"];
    // Only a quality above the cutoff is actually present among candidates.
    const best = pickBestAllowedQuality(["Bluray-1080p"], allowed, "HDTV-1080p");
    expect(best).toBe("Bluray-1080p");
  });

  it("returns null when no candidate quality is in the allowed set at all", async () => {
    const { pickBestAllowedQuality } = await import("../src/services/quality.js");
    const best = pickBestAllowedQuality(["SD"], ["Bluray-1080p"], "Bluray-1080p");
    expect(best).toBeNull();
  });

  it("rejects a release outside its quality's configured size bounds, passes one inside", async () => {
    const { loadQualityCaches, sizeWithinQualityBounds } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET min_size_mb = ?, max_size_mb = ? WHERE name = ?").run(2000, 15000, "Bluray-1080p");
    await loadQualityCaches();

    expect(sizeWithinQualityBounds("Bluray-1080p", 200 * 1_000_000)).toBe(false); // 200MB, too small
    expect(sizeWithinQualityBounds("Bluray-1080p", 8000 * 1_000_000)).toBe(true); // 8GB, within range
    expect(sizeWithinQualityBounds("Bluray-1080p", 20000 * 1_000_000)).toBe(false); // 20GB, too big
  });

  it("passes anything when a quality has no configured size bounds", async () => {
    const { sizeWithinQualityBounds } = await import("../src/services/quality.js");
    expect(sizeWithinQualityBounds("SD", 1)).toBe(true);
    expect(sizeWithinQualityBounds("SD", 999_999_999_999)).toBe(true);
  });

  it("passes when size or quality name is unknown/missing", async () => {
    const { sizeWithinQualityBounds } = await import("../src/services/quality.js");
    expect(sizeWithinQualityBounds(null, 1)).toBe(true);
    expect(sizeWithinQualityBounds("Bluray-1080p", null)).toBe(true);
  });

  it("computes distance from a quality's preferred size, neutral (0) when unset", async () => {
    const { loadQualityCaches, preferredSizeDistance } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET preferred_size_mb = ? WHERE name = ?").run(8000, "Bluray-1080p");
    await loadQualityCaches();

    expect(preferredSizeDistance("Bluray-1080p", 8000 * 1_000_000)).toBe(0);
    expect(preferredSizeDistance("Bluray-1080p", 6000 * 1_000_000)).toBe(2000);
    expect(preferredSizeDistance("WEBDL-1080p", 6000 * 1_000_000)).toBe(0); // no preferred size configured
    expect(preferredSizeDistance(null, 6000 * 1_000_000)).toBe(0);
  });
});
