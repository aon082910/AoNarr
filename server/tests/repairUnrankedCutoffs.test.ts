import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let quality: typeof import("../src/services/quality.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  quality = await import("../src/services/quality.js");
  await quality.loadQualityCaches();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM quality_profiles WHERE name LIKE 'Repair %'").run();
});

async function addProfile(name: string, cutoff: string, allowed: string[], groups: string[][] | null = null): Promise<number> {
  const result = await db
    .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, quality_groups) VALUES (?, ?, ?, ?)")
    .run(`Repair ${name}`, JSON.stringify(allowed), cutoff, JSON.stringify(groups ?? []));
  return Number(result.lastInsertRowid);
}

const cutoffOf = async (id: number) => ((await db.prepare("SELECT cutoff FROM quality_profiles WHERE id = ?").get(id)) as { cutoff: string | null }).cutoff;

describe("repairUnrankedCutoffs", () => {
  it("sets a cutoff that is not on the ladder to the best allowed quality, and says so", async () => {
    const id = await addProfile("Renamed", "Ultra-HD-Gone", ["WEBDL-720p", "WEBDL-1080p", "Bluray-720p"]);

    expect(await quality.repairUnrankedCutoffs()).toBeGreaterThanOrEqual(1);

    expect(await cutoffOf(id)).toBe("WEBDL-1080p");
  });

  it("also looks at the members of the profile's quality groups, and ignores allowed names that are not on the ladder", async () => {
    const id = await addProfile("Grouped", "Gone", ["WEBDL-720p", "Nonsense"], [["WEBDL-720p", "Bluray-1080p"]]);

    await quality.repairUnrankedCutoffs();

    expect(await cutoffOf(id)).toBe("Bluray-1080p");
  });

  it("leaves a valid cutoff alone, including one the profile does not allow", async () => {
    const valid = await addProfile("Valid", "WEBDL-1080p", ["WEBDL-720p", "WEBDL-1080p"]);
    const notAllowed = await addProfile("Not allowed", "Remux-2160p", ["WEBDL-720p", "WEBDL-1080p"]);
    const none = await addProfile("No cutoff", "", ["WEBDL-720p"]);

    await quality.repairUnrankedCutoffs();

    expect(await cutoffOf(valid)).toBe("WEBDL-1080p");
    expect(await cutoffOf(notAllowed)).toBe("Remux-2160p");
    expect(await cutoffOf(none)).toBe("");
  });

  it("leaves a profile with no ranked allowed quality alone (the Health warning stays)", async () => {
    const empty = await addProfile("Empty", "Gone", []);
    const unknown = await addProfile("Unknown names", "Gone", ["Nonsense", "AlsoNonsense"]);

    await quality.repairUnrankedCutoffs();

    expect(await cutoffOf(empty)).toBe("Gone");
    expect(await cutoffOf(unknown)).toBe("Gone");
  });

  it("is idempotent: a second run changes nothing", async () => {
    await addProfile("Twice", "Gone", ["WEBDL-720p", "WEBDL-1080p"]);
    const first = await quality.repairUnrankedCutoffs();
    const second = await quality.repairUnrankedCutoffs();

    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
  });
});
