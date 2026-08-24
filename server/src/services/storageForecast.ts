import fs from "node:fs";
import { db } from "../db/index.js";
import { nowOffsetExpr } from "../db/asyncDb.js";

const SAMPLE_RETENTION_DAYS = 90;

/** Records one free/total-space sample per root folder — at most once per calendar day per
 * folder, so repeated calls (e.g. every /system/status request) don't flood the table. */
export async function recordDiskUsageSamples(): Promise<void> {
  const folders = (await db.prepare("SELECT id, path FROM root_folders").all()) as { id: number; path: string }[];
  const today = new Date().toISOString().slice(0, 10);

  for (const folder of folders) {
    const alreadySampledToday = await db
      .prepare("SELECT id FROM disk_usage_samples WHERE root_folder_id = ? AND sampled_at LIKE ? LIMIT 1")
      .get(folder.id, `${today}%`);
    if (alreadySampledToday) continue;

    try {
      const stat = fs.statfsSync(folder.path);
      await db
        .prepare("INSERT INTO disk_usage_samples (root_folder_id, free_bytes, total_bytes) VALUES (?, ?, ?)")
        .run(folder.id, stat.bfree * stat.bsize, stat.blocks * stat.bsize);
    } catch {
      // root folder path not reachable right now — skip, try again next call
    }
  }

  await db.prepare(`DELETE FROM disk_usage_samples WHERE sampled_at < ${nowOffsetExpr(db, -SAMPLE_RETENTION_DAYS)}`).run();
}

export interface StorageForecast {
  rootFolderId: number;
  daysUntilFull: number | null; // null = not shrinking (or not enough data)
  bytesPerDay: number;
  sampleCount: number;
  sampleSpanDays: number;
}

/** Straight-line forecast from the oldest and newest sample in the retention window — enough
 * signal for "roughly how long until this fills up" without needing real regression. */
export async function getStorageForecast(rootFolderId: number): Promise<StorageForecast | null> {
  const samples = (await db
    .prepare("SELECT free_bytes, sampled_at FROM disk_usage_samples WHERE root_folder_id = ? ORDER BY sampled_at ASC")
    .all(rootFolderId)) as { free_bytes: number; sampled_at: string }[];
  if (samples.length < 2) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = new Date(last.sampled_at).getTime() - new Date(first.sampled_at).getTime();
  const spanDays = spanMs / (1000 * 60 * 60 * 24);
  if (spanDays < 0.5) return null; // not enough elapsed time for a meaningful trend yet

  const bytesFreedPerDay = (last.free_bytes - first.free_bytes) / spanDays;
  const bytesPerDay = -bytesFreedPerDay; // positive = consuming space

  const daysUntilFull = bytesPerDay > 0 ? Math.round(last.free_bytes / bytesPerDay) : null;

  return { rootFolderId, daysUntilFull, bytesPerDay, sampleCount: samples.length, sampleSpanDays: Math.round(spanDays) };
}
