import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertRootFolder(): Promise<{ id: number; realPath: string }> {
  const realPath = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-rootfolder-"));
  const id = Number(
    (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(realPath)).lastInsertRowid
  );
  return { id, realPath };
}

describe("recordDiskUsageSamples", () => {
  it("records one sample for a real, reachable root folder path", async () => {
    const { recordDiskUsageSamples } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();

    await recordDiskUsageSamples();

    const rows = (await db.prepare("SELECT * FROM disk_usage_samples WHERE root_folder_id = ?").all(id)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].total_bytes).toBeGreaterThan(0);
  });

  it("records the space the server can actually use, not blocks reserved for root", async () => {
    const { recordDiskUsageSamples } = await import("../src/services/storageForecast.js");
    const { id, realPath } = await insertRootFolder();
    const realStatfs = fs.statfsSync;
    vi.spyOn(fs, "statfsSync").mockImplementation(((p: string, ...rest: unknown[]) =>
      p === realPath ? ({ bfree: 30, bavail: 10, blocks: 100, bsize: 1000 } as any) : (realStatfs as any)(p, ...rest)) as any);

    await recordDiskUsageSamples();

    const row = (await db.prepare("SELECT free_bytes, total_bytes FROM disk_usage_samples WHERE root_folder_id = ?").get(id)) as {
      free_bytes: number | string;
      total_bytes: number | string;
    };
    expect({ free: Number(row.free_bytes), total: Number(row.total_bytes) }).toEqual({ free: 10_000, total: 100_000 });
  });

  it("drops samples recorded when reserved blocks still counted as free, once", async () => {
    const { recordDiskUsageSamples } = await import("../src/services/storageForecast.js");
    const { deleteSetting } = await import("../src/services/settingsStore.js");
    const { id } = await insertRootFolder();
    const insertOldSample = () =>
      db
        .prepare("INSERT INTO disk_usage_samples (root_folder_id, free_bytes, total_bytes, sampled_at) VALUES (?, 1, 1000, ?)")
        .run(id, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString());
    const oldSampleCount = async () =>
      Number(((await db.prepare("SELECT COUNT(*) AS n FROM disk_usage_samples WHERE root_folder_id = ? AND free_bytes = 1").get(id)) as { n: number | string }).n);
    deleteSetting("diskUsageSamplesUsableSpace");
    await insertOldSample();

    await recordDiskUsageSamples();

    expect(await oldSampleCount()).toBe(0);
    expect(await db.prepare("SELECT id FROM disk_usage_samples WHERE root_folder_id = ?").get(id)).toBeDefined();

    // Rows written after that aren't dropped again.
    await insertOldSample();
    await recordDiskUsageSamples();

    expect(await oldSampleCount()).toBe(1);
  });

  it("doesn't record a second sample for the same folder on the same calendar day", async () => {
    const { recordDiskUsageSamples } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();

    await recordDiskUsageSamples();
    await recordDiskUsageSamples();

    const rows = (await db.prepare("SELECT * FROM disk_usage_samples WHERE root_folder_id = ?").all(id)) as any[];
    expect(rows).toHaveLength(1);
  });

  it("skips a root folder whose path doesn't exist, without throwing or affecting other folders", async () => {
    const { recordDiskUsageSamples } = await import("../src/services/storageForecast.js");
    const badId = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/definitely/does/not/exist', 'movie')").run()).lastInsertRowid
    );
    const { id: goodId } = await insertRootFolder();

    await expect(recordDiskUsageSamples()).resolves.not.toThrow();

    expect(await db.prepare("SELECT id FROM disk_usage_samples WHERE root_folder_id = ?").get(badId)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM disk_usage_samples WHERE root_folder_id = ?").get(goodId)).toBeDefined();
  });
});

describe("getStorageForecast", () => {
  async function insertSample(rootFolderId: number, freeBytes: number, sampledAt: Date): Promise<void> {
    await db
      .prepare("INSERT INTO disk_usage_samples (root_folder_id, free_bytes, total_bytes, sampled_at) VALUES (?, ?, ?, ?)")
      .run(rootFolderId, freeBytes, 1_000_000_000_000, sampledAt.toISOString());
  }

  it("returns null with fewer than two samples", async () => {
    const { getStorageForecast } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();
    await insertSample(id, 500_000_000_000, new Date());

    expect(await getStorageForecast(id)).toBeNull();
  });

  it("returns null when the samples don't span enough time yet to trust a trend", async () => {
    const { getStorageForecast } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();
    const now = new Date();
    await insertSample(id, 500_000_000_000, new Date(now.getTime() - 60_000));
    await insertSample(id, 499_000_000_000, now);

    expect(await getStorageForecast(id)).toBeNull();
  });

  it("forecasts days-until-full from a shrinking free-space trend", async () => {
    const { getStorageForecast } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    // 100GB free 10 days ago, 50GB free now -> losing 5GB/day -> 10 days left at that rate.
    await insertSample(id, 100_000_000_000, tenDaysAgo);
    await insertSample(id, 50_000_000_000, now);

    const forecast = await getStorageForecast(id);
    expect(forecast).not.toBeNull();
    expect(forecast!.bytesPerDay).toBeCloseTo(5_000_000_000, -6);
    expect(forecast!.daysUntilFull).toBe(10);
    expect(forecast!.sampleSpanDays).toBe(10);
  });

  it("reports no forecast (null daysUntilFull) when free space is growing, not shrinking", async () => {
    const { getStorageForecast } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    // Someone freed up space — free bytes went UP over the window.
    await insertSample(id, 50_000_000_000, tenDaysAgo);
    await insertSample(id, 100_000_000_000, now);

    const forecast = await getStorageForecast(id);
    expect(forecast!.daysUntilFull).toBeNull();
    expect(forecast!.bytesPerDay).toBeLessThan(0);
  });

  it("only uses the oldest and newest sample, ignoring points in between", async () => {
    const { getStorageForecast } = await import("../src/services/storageForecast.js");
    const { id } = await insertRootFolder();
    const now = new Date();
    await insertSample(id, 100_000_000_000, new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));
    await insertSample(id, 1_000_000_000, new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)); // a wild mid-window outlier
    await insertSample(id, 50_000_000_000, now);

    const forecast = await getStorageForecast(id);
    // Straight-line from first to last only: (100GB - 50GB) / 10 days = 5GB/day, ignoring the outlier.
    expect(forecast!.bytesPerDay).toBeCloseTo(5_000_000_000, -6);
  });
});
