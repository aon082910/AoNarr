import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

// db/client.ts's SQLite seed runs once, at module load, and can't be re-triggered here; its
// Postgres twin seedPostgresDefaults only uses portable SQL, so it's exercised directly against
// whichever backend this run uses.
describe("seedPostgresDefaults — default 'Any' quality profile", () => {
  beforeAll(async () => {
    ({ db, apiKey } = await setupTestDb());
  });

  async function profileNames(): Promise<string[]> {
    return ((await db.prepare("SELECT name FROM quality_profiles ORDER BY id").all()) as { name: string }[]).map((r) => r.name);
  }

  it("doesn't re-create 'Any' after an admin renamed it", async () => {
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('My Renamed Default', ?, 'SD')").run(JSON.stringify(["SD"]));

    await seedPostgresDefaults(db);

    expect(await profileNames()).toEqual(["My Renamed Default"]);
  });

  it("doesn't re-create 'Any' after an admin deleted it but kept other profiles", async () => {
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('HD-1080p', ?, 'Bluray-1080p')").run(JSON.stringify(["Bluray-1080p"]));
    await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('Ultra-HD', ?, 'Remux-2160p')").run(JSON.stringify(["Remux-2160p"]));

    await seedPostgresDefaults(db);

    expect(await profileNames()).toEqual(["HD-1080p", "Ultra-HD"]);
  });

  it("seeds 'Any' into an empty quality_profiles table, and leaves existing qualities and the API key alone", async () => {
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");
    await db.prepare("DELETE FROM quality_profiles").run();
    const qualitiesBefore = await db.prepare("SELECT id, name, rank FROM qualities ORDER BY rank").all();

    await seedPostgresDefaults(db);

    const profiles = (await db.prepare("SELECT name, allowed_qualities, cutoff FROM quality_profiles").all()) as any[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("Any");
    expect(profiles[0].cutoff).toBe("WEBDL-1080p");
    expect(JSON.parse(profiles[0].allowed_qualities)).toContain("WEBDL-1080p");
    expect(await db.prepare("SELECT id, name, rank FROM qualities ORDER BY rank").all()).toEqual(qualitiesBefore);
    const { getSetting } = await import("../src/services/settingsStore.js");
    expect(getSetting("apiKey")).toBe(apiKey);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'apiKey'").get()) as { c: number | string }).c)).toBe(1);
  });
});
