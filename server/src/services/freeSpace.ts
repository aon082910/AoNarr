import fs from "node:fs";
import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";

/**
 * Sonarr's FreeSpaceSpecification: a release bigger than the free space left on the item's root
 * folder (less a reserve) is not grabbed, because it would download and then fail to import. The
 * importer makes the same check once the download is done; this one saves the download.
 *
 * Settings, no UI yet: `grabFreeSpaceCheck` ("0" turns it off) and `minimumFreeSpaceMb` (the reserve
 * to keep free, default 100, as in Sonarr). A folder that can't be read, or a release of unknown
 * size, is never refused.
 */

const DEFAULT_RESERVE_MB = 100;
const CACHE_MS = 30_000;

export function freeSpaceCheckEnabled(): boolean {
  return getSetting("grabFreeSpaceCheck") !== "0";
}

export function freeSpaceReserveBytes(): number {
  const raw = getSetting("minimumFreeSpaceMb");
  const mb = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return (Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_RESERVE_MB) * 1_000_000;
}

const cache = new Map<string, { at: number; freeBytes: number | null }>();

/** Free bytes at a path, read at most every 30 seconds (a search can judge hundreds of releases). */
export function freeBytesAt(folderPath: string, now = Date.now()): number | null {
  const hit = cache.get(folderPath);
  if (hit && now - hit.at < CACHE_MS) return hit.freeBytes;
  let freeBytes: number | null = null;
  try {
    const stat = fs.statfsSync(folderPath);
    // A filesystem that reports no blocks at all says nothing about its free space.
    if (stat.blocks * stat.bsize > 0) freeBytes = stat.bavail * stat.bsize;
  } catch {
    freeBytes = null;
  }
  cache.set(folderPath, { at: now, freeBytes });
  return freeBytes;
}

/** The free bytes on the root folder a media item is stored in, or null when unknown. */
export async function freeBytesForItem(mediaItemId: number | null): Promise<number | null> {
  if (mediaItemId == null) return null;
  const row = (await db
    .prepare("SELECT r.path AS path FROM media_items m JOIN root_folders r ON r.id = m.root_folder_id WHERE m.id = ?")
    .get(mediaItemId)) as { path: string } | undefined;
  return row?.path ? freeBytesAt(row.path) : null;
}

/** Whether a release of this size would leave less than the reserve free. */
export function exceedsFreeSpace(sizeBytes: number | null, freeBytes: number | null, reserveBytes: number): boolean {
  return sizeBytes != null && freeBytes != null && sizeBytes > freeBytes - reserveBytes;
}

/** For tests: forget the cached readings. */
export function clearFreeSpaceCache(): void {
  cache.clear();
}
