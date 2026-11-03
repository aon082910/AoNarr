import { describe, it, expect, beforeAll } from "vitest";

// vitest.config.ts turns the seeding off for the rest of the suite (they feed releases of any size);
// this file is the one that checks the product default.
process.env.AONARR_SEED_QUALITY_SIZES = "1";

import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

type SizeRow = { name: string; min_size_mb: number | null; max_size_mb: number | null; preferred_size_mb: number | null };

async function sizes(): Promise<Map<string, SizeRow>> {
  const rows = (await db.prepare("SELECT name, min_size_mb, max_size_mb, preferred_size_mb FROM qualities").all()) as SizeRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

// Probe 2 of the settings audit: a fresh install had no size limits at all, so a 5 MB "1080p" or a
// 90 GB "720p" was size-acceptable until the admin filled in 16 rows. Starr ships per-minute limits.
describe("a new install starts with Starr's size limits, per minute (ST7)", () => {
  it("seeds a minimum and a maximum for every tier below Bluray-1080p, and an open maximum from there up", async () => {
    const q = await sizes();

    expect(q.get("SD")).toMatchObject({ min_size_mb: 2, max_size_mb: 100 });
    expect(q.get("HDTV-720p")).toMatchObject({ min_size_mb: 3, max_size_mb: 125 });
    expect(q.get("WEBDL-1080p")).toMatchObject({ min_size_mb: 4, max_size_mb: 130 });
    expect(q.get("Bluray-1080p")?.min_size_mb).toBe(4);
    expect(q.get("Bluray-1080p")?.max_size_mb).toBeNull();
    for (const name of ["Remux-1080p", "HDTV-2160p", "WEBDL-2160p", "Bluray-2160p", "Remux-2160p"]) {
      expect(q.get(name)?.min_size_mb, name).toBe(35);
      expect(q.get(name)?.max_size_mb, name).toBeNull();
    }
  });

  it("covers all sixteen tiers, each with a minimum", async () => {
    const q = await sizes();
    expect(q.size).toBe(16);
    for (const row of q.values()) expect(row.min_size_mb, row.name).not.toBeNull();
  });

  it("reads the numbers per minute, so a season pack and an episode are judged alike", async () => {
    const { sizeLimitMode } = await import("../src/services/releaseRuntime.js");
    expect(sizeLimitMode()).toBe("perMinute");
  });

  it("rejects a 5 MB fake and a 90 GB 720p, and accepts a normal 1080p web release, once the caches are loaded", async () => {
    const { loadQualityCaches, sizeWithinQualityBounds } = await import("../src/services/quality.js");
    await loadQualityCaches();
    const MB = 1024 * 1024;
    // runtime 100 minutes: 4..130 MB per minute is 400 MB..13 GB
    expect(sizeWithinQualityBounds("WEBDL-1080p", 5 * MB, 100)).toBe(false);
    expect(sizeWithinQualityBounds("HDTV-720p", 90 * 1024 * MB, 100)).toBe(false);
    expect(sizeWithinQualityBounds("WEBDL-1080p", 4000 * MB, 100)).toBe(true);
    expect(sizeWithinQualityBounds("Remux-2160p", 80 * 1024 * MB, 100)).toBe(true);
  });

  it("leaves a database that already has qualities alone", async () => {
    await db.prepare("UPDATE qualities SET min_size_mb = NULL, max_size_mb = NULL, preferred_size_mb = NULL").run();
    await db.prepare("DELETE FROM settings WHERE key = 'sizeLimitMode'").run();
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");

    await seedPostgresDefaults(db);

    const q = await sizes();
    expect([...q.values()].every((r) => r.min_size_mb === null && r.max_size_mb === null)).toBe(true);
    expect(await db.prepare("SELECT value FROM settings WHERE key = 'sizeLimitMode'").get()).toBeFalsy();
  });

  it("seeds an empty qualities table through the Postgres seed path too (the same defaults)", async () => {
    await db.prepare("DELETE FROM qualities").run();
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");

    await seedPostgresDefaults(db);

    const q = await sizes();
    expect(q.get("WEBDL-1080p")).toMatchObject({ min_size_mb: 4, max_size_mb: 130 });
    expect((await db.prepare("SELECT value FROM settings WHERE key = 'sizeLimitMode'").get()) as any).toMatchObject({ value: "perMinute" });
  });
});
