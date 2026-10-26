import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

async function ladder(): Promise<string[]> {
  return ((await db.prepare("SELECT name FROM qualities ORDER BY rank").all()) as { name: string }[]).map((r) => r.name);
}

describe("the quality ladder has a 720p Blu-ray tier", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  it("seeds Bluray-720p between WEBDL-720p and HDTV-1080p, in every default", async () => {
    const { DEFAULT_QUALITY_ORDER, qualityRank } = await import("../src/services/quality.js");
    const order = [...DEFAULT_QUALITY_ORDER];
    expect(order.indexOf("Bluray-720p")).toBe(order.indexOf("WEBDL-720p") + 1);
    expect(order.indexOf("HDTV-1080p")).toBe(order.indexOf("Bluray-720p") + 1);
    expect(await ladder()).toEqual(order);
    expect(qualityRank("WEBDL-720p")).toBeLessThan(qualityRank("Bluray-720p"));
    expect(qualityRank("Bluray-720p")).toBeLessThan(qualityRank("HDTV-1080p"));
    const profile = (await db.prepare("SELECT allowed_qualities FROM quality_profiles WHERE name = 'Any'").get()) as { allowed_qualities: string } | undefined;
    expect(JSON.parse(profile!.allowed_qualities)).toContain("Bluray-720p");
  });

  it("adds the tier to a ladder seeded without it, moves the ranks above it, and does so once", async () => {
    const { ensureBluray720pQuality, DEFAULT_QUALITY_ORDER } = await import("../src/services/quality.js");
    const { setSetting } = await import("../src/services/settingsStore.js");

    // The ladder as an install from before this tier was added holds it.
    await db.prepare("DELETE FROM qualities WHERE name = 'Bluray-720p'").run();
    for (const [i, name] of DEFAULT_QUALITY_ORDER.filter((n) => n !== "Bluray-720p").entries()) {
      await db.prepare("UPDATE qualities SET rank = ? WHERE name = ?").run(-(i + 1), name);
    }
    for (const [i, name] of DEFAULT_QUALITY_ORDER.filter((n) => n !== "Bluray-720p").entries()) {
      await db.prepare("UPDATE qualities SET rank = ? WHERE name = ?").run(i, name);
    }
    await db.prepare("DELETE FROM quality_profiles").run();
    const insertProfile = async (name: string, allowed: string[], cutoff: string) =>
      db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)").run(name, JSON.stringify(allowed), cutoff);
    await insertProfile("web720 and disc1080", ["SD", "WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    await insertProfile("web only", ["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p");
    await insertProfile("has it already", ["Bluray-720p", "WEBDL-720p", "Bluray-1080p"], "Bluray-1080p");
    setSetting("bluray720pTierAdded", "");

    await ensureBluray720pQuality();

    expect(await ladder()).toEqual([...DEFAULT_QUALITY_ORDER]);
    const allowed = async (name: string): Promise<string[]> =>
      JSON.parse(((await db.prepare("SELECT allowed_qualities FROM quality_profiles WHERE name = ?").get(name)) as { allowed_qualities: string }).allowed_qualities);
    expect(await allowed("web720 and disc1080")).toEqual(["SD", "WEBDL-720p", "Bluray-720p", "WEBDL-1080p", "Bluray-1080p"]);
    expect(await allowed("web only")).toEqual(["WEBDL-720p", "WEBDL-1080p"]);
    expect(await allowed("has it already")).toEqual(["Bluray-720p", "WEBDL-720p", "Bluray-1080p"]);
    // No cutoff moved.
    expect(((await db.prepare("SELECT cutoff FROM quality_profiles WHERE name = 'web only'").get()) as { cutoff: string }).cutoff).toBe("WEBDL-1080p");

    // An admin who deletes the tier afterwards keeps it deleted.
    await db.prepare("DELETE FROM qualities WHERE name = 'Bluray-720p'").run();
    await ensureBluray720pQuality();
    expect(await ladder()).not.toContain("Bluray-720p");
  });

  it("leaves a ladder with neither anchor tier alone", async () => {
    const { ensureBluray720pQuality } = await import("../src/services/quality.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    await db.prepare("DELETE FROM qualities WHERE name IN ('WEBDL-720p', 'HDTV-1080p', 'Bluray-720p')").run();
    const before = await ladder();
    setSetting("bluray720pTierAdded", "");
    await ensureBluray720pQuality();
    expect(await ladder()).toEqual(before);
  });
});
