import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * Talks to the real TRaSH-Guides repository on GitHub, so it only runs when asked: AONARR_LIVE_TRASH=1. It covers what the
 * stubbed tests cannot: the file shapes TRaSH publishes today, the format sync, and a profile import on top of the synced
 * formats (scores and language). A failure here usually means TRaSH changed a file format.
 */
const live = process.env.AONARR_LIVE_TRASH === "1";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  if (!live) return;
  ({ db } = await setupTestDb());
});

describe.skipIf(!live)("TRaSH-Guides, live", () => {
  it("syncs the Radarr custom formats and imports a quality profile with its scores", async () => {
    const { syncTrashFormats } = await import("../src/services/trashSync.js");
    const { listTrashProfiles, importTrashProfile } = await import("../src/services/trashProfiles.js");

    const sync = await syncTrashFormats("radarr");
    expect(sync.error).toBeUndefined();
    expect(sync.added + sync.updated).toBeGreaterThan(20);
    expect(sync.failed).toEqual([]);
    const formats = Number(((await db.prepare("SELECT COUNT(*) AS c FROM custom_formats WHERE trash_id IS NOT NULL").get()) as { c: number }).c);
    expect(formats).toBeGreaterThan(20);

    const profiles = await listTrashProfiles("radarr");
    expect(profiles.length).toBeGreaterThan(3);
    const pick = profiles.find((p) => /1080p/i.test(p.name)) ?? profiles[0];

    const result = await importTrashProfile("radarr", pick.file);
    expect(result.allowedQualities.length).toBeGreaterThan(0);
    expect(result.cutoff).toBeTruthy();
    expect(result.scoresApplied).toBeGreaterThan(5);
    const row = (await db.prepare("SELECT name, language FROM quality_profiles WHERE id = ?").get(result.profileId)) as { name: string; language: string | null };
    expect(row.name).toBe(pick.name);
    // Whatever language the profile names ("Original", "Any", a language) must have been read without an error.
    expect(typeof result.languageNamed).toBe("boolean");
    console.log(`[live] ${pick.name}: ${result.scoresApplied} scores, ${result.missingFormats.length} formats missing, language ${row.language ?? "any"}${result.languageNote ? ` (${result.languageNote})` : ""}`);
  }, 180_000);

  it("reads the Sonarr profile list too", async () => {
    const { listTrashProfiles } = await import("../src/services/trashProfiles.js");
    const profiles = await listTrashProfiles("sonarr");
    expect(profiles.length).toBeGreaterThan(2);
  }, 120_000);
});
