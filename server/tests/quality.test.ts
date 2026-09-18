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

  it("enforces only the minimum bound when max_size_mb is left unconfigured", async () => {
    const { loadQualityCaches, sizeWithinQualityBounds } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET min_size_mb = ?, max_size_mb = NULL WHERE name = ?").run(2000, "WEBDL-1080p");
    await loadQualityCaches();

    expect(sizeWithinQualityBounds("WEBDL-1080p", 500 * 1_000_000)).toBe(false); // below the min
    expect(sizeWithinQualityBounds("WEBDL-1080p", 999_999 * 1_000_000)).toBe(true); // no max configured, so no size is "too big"
  });

  it("enforces only the maximum bound when min_size_mb is left unconfigured", async () => {
    const { loadQualityCaches, sizeWithinQualityBounds } = await import("../src/services/quality.js");
    await db.prepare("UPDATE qualities SET min_size_mb = NULL, max_size_mb = ? WHERE name = ?").run(15000, "HDTV-1080p");
    await loadQualityCaches();

    expect(sizeWithinQualityBounds("HDTV-1080p", 1)).toBe(true); // no min configured, so no size is "too small"
    expect(sizeWithinQualityBounds("HDTV-1080p", 20000 * 1_000_000)).toBe(false); // above the max
  });

  it("pickBestAllowedQuality includes a candidate exactly at the cutoff, not just ones strictly below it", async () => {
    const { pickBestAllowedQuality } = await import("../src/services/quality.js");
    const allowed = ["WEBDL-1080p", "Bluray-1080p", "Remux-2160p"];
    const best = pickBestAllowedQuality(["Bluray-1080p", "Remux-2160p"], allowed, "Bluray-1080p");
    // Remux-2160p is above cutoff; Bluray-1080p sits exactly AT the cutoff and must still win.
    expect(best).toBe("Bluray-1080p");
  });

  it("pickBestAllowedQuality's cutoff-missed fallback still picks the best-ranked of several eligible options", async () => {
    const { pickBestAllowedQuality } = await import("../src/services/quality.js");
    const allowed = ["WEBDL-1080p", "Bluray-1080p", "Remux-2160p"];
    // SD ranks below everything, so nothing meets cutoff — the fallback must still prefer
    // Remux-2160p over WEBDL-1080p by rank, not just return whichever candidate came first.
    const best = pickBestAllowedQuality(["WEBDL-1080p", "Remux-2160p"], allowed, "SD");
    expect(best).toBe("Remux-2160p");
  });

  it("invalidateQualityRankCache asynchronously refreshes the caches without the caller awaiting it", async () => {
    const { invalidateQualityRankCache, qualityRank } = await import("../src/services/quality.js");
    await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run("Round290-New-Quality", 999);

    invalidateQualityRankCache();
    await new Promise((r) => setTimeout(r, 20));

    expect(qualityRank("Round290-New-Quality")).toBe(999);
  });

  it("invalidateQualityRankCache swallows a refresh failure instead of leaking an unhandled rejection", async () => {
    // invalidateQualityRankCache is deliberately fire-and-forget (see the module comment in
    // quality.ts) — it fires loadQualityCaches() and attaches .catch() without awaiting it, so a
    // plain "doesn't throw synchronously" assertion would pass even with the .catch() deleted,
    // since the rejection only surfaces on a later microtask. Force a real read failure by
    // renaming the qualities table out from under it, and listen for process 'unhandledRejection'
    // to actually prove the .catch() does its job.
    const { invalidateQualityRankCache } = await import("../src/services/quality.js");
    await db.prepare("ALTER TABLE qualities RENAME TO qualities_round290_temp").run();

    let unhandled: unknown = null;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.once("unhandledRejection", onUnhandledRejection);
    try {
      invalidateQualityRankCache();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await db.prepare("ALTER TABLE qualities_round290_temp RENAME TO qualities").run();
    }
    expect(unhandled).toBeNull();
  });
});
