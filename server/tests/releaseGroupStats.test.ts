import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

async function getRow(group: string): Promise<any> {
  return db.prepare("SELECT * FROM release_group_stats WHERE release_group = ?").get(group);
}

describe("recordGroupSuccess / recordGroupFailure", () => {
  it("creates a new row on the first recorded success", async () => {
    const { recordGroupSuccess } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("NewGroup");
    const row = await getRow("NewGroup");
    expect(row).toBeDefined();
    expect(Number(row.successes)).toBe(1);
    expect(Number(row.failures)).toBe(0);
  });

  it("creates a new row on the first recorded failure", async () => {
    const { recordGroupFailure } = await import("../src/services/releaseGroupStats.js");
    await recordGroupFailure("FailFirst");
    const row = await getRow("FailFirst");
    expect(row).toBeDefined();
    expect(Number(row.successes)).toBe(0);
    expect(Number(row.failures)).toBe(1);
  });

  it("increments successes on repeated calls instead of overwriting", async () => {
    const { recordGroupSuccess } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("RepeatGroup");
    await recordGroupSuccess("RepeatGroup");
    await recordGroupSuccess("RepeatGroup");
    const row = await getRow("RepeatGroup");
    expect(Number(row.successes)).toBe(3);
  });

  it("tracks successes and failures independently for the same group", async () => {
    const { recordGroupSuccess, recordGroupFailure } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("MixedGroup");
    await recordGroupSuccess("MixedGroup");
    await recordGroupFailure("MixedGroup");
    const row = await getRow("MixedGroup");
    expect(Number(row.successes)).toBe(2);
    expect(Number(row.failures)).toBe(1);
  });

  it("keeps different groups' counters independent", async () => {
    const { recordGroupSuccess, recordGroupFailure } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("GroupA-Indep");
    await recordGroupFailure("GroupB-Indep");
    expect(Number((await getRow("GroupA-Indep")).successes)).toBe(1);
    expect(Number((await getRow("GroupA-Indep")).failures)).toBe(0);
    expect(Number((await getRow("GroupB-Indep")).successes)).toBe(0);
    expect(Number((await getRow("GroupB-Indep")).failures)).toBe(1);
  });
});

describe("getGroupReputation", () => {
  it("returns the neutral 0.5 score for a group with no history at all", async () => {
    const { getGroupReputation } = await import("../src/services/releaseGroupStats.js");
    expect(await getGroupReputation("NeverSeenGroup")).toBe(0.5);
  });

  it("returns the neutral 0.5 score when fewer than 3 total outcomes are recorded", async () => {
    const { recordGroupSuccess, getGroupReputation } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("TooFewOutcomes");
    await recordGroupSuccess("TooFewOutcomes");
    // Only 2 total outcomes recorded so far — below the trust threshold of 3.
    expect(await getGroupReputation("TooFewOutcomes")).toBe(0.5);
  });

  it("returns the real successes/total ratio once at least 3 outcomes are recorded", async () => {
    const { recordGroupSuccess, recordGroupFailure, getGroupReputation } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("EnoughOutcomes");
    await recordGroupSuccess("EnoughOutcomes");
    await recordGroupFailure("EnoughOutcomes");
    // 2 successes / 3 total = 0.666...
    expect(await getGroupReputation("EnoughOutcomes")).toBeCloseTo(2 / 3, 5);
  });

  it("returns close to 0 for a group that has only ever failed (with enough history)", async () => {
    const { recordGroupFailure, getGroupReputation } = await import("../src/services/releaseGroupStats.js");
    await recordGroupFailure("AlwaysFails");
    await recordGroupFailure("AlwaysFails");
    await recordGroupFailure("AlwaysFails");
    expect(await getGroupReputation("AlwaysFails")).toBe(0);
  });
});

describe("listReleaseGroupStats", () => {
  it("sorts groups by total recorded activity, most active first", async () => {
    const { recordGroupSuccess, recordGroupFailure, listReleaseGroupStats } = await import("../src/services/releaseGroupStats.js");
    await recordGroupSuccess("QuietGroup-List");
    await recordGroupSuccess("BusyGroup-List");
    await recordGroupSuccess("BusyGroup-List");
    await recordGroupFailure("BusyGroup-List");
    await recordGroupSuccess("MediumGroup-List");
    await recordGroupFailure("MediumGroup-List");

    const stats = await listReleaseGroupStats();
    const names = stats.map((s) => s.releaseGroup);
    const busyIdx = names.indexOf("BusyGroup-List");
    const mediumIdx = names.indexOf("MediumGroup-List");
    const quietIdx = names.indexOf("QuietGroup-List");

    expect(busyIdx).toBeGreaterThanOrEqual(0);
    expect(mediumIdx).toBeGreaterThan(busyIdx);
    expect(quietIdx).toBeGreaterThan(mediumIdx);
  });
});
