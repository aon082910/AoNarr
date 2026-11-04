import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { statfsAsync } from "./fsAsync.js";

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

/** What an import keeps free below the files it places (Sonarr's MinimumFreeSpaceWhenImporting): the global reserve, or the root folder's own minimum when that is larger. */
export function importReserveBytes(rootMinFreeSpaceGb: number | null | undefined): number {
  const rootBytes = Number(rootMinFreeSpaceGb) > 0 ? Number(rootMinFreeSpaceGb) * 1_000_000_000 : 0;
  return Math.max(freeSpaceReserveBytes(), rootBytes);
}

const cache = new Map<string, { at: number; freeBytes: number | null }>();

/** How long a search waits for a mount to say how much room it has: a dead share must not stall it. */
const STATFS_TIMEOUT_MS = 5_000;

/** Free bytes at a path, read at most every 30 seconds (a search can judge hundreds of releases). Asked
 * of the file system without blocking the event loop; a mount that does not answer reads as unknown. */
export async function freeBytesAt(folderPath: string, now = Date.now()): Promise<number | null> {
  const hit = cache.get(folderPath);
  if (hit && now - hit.at < CACHE_MS) return hit.freeBytes;
  let freeBytes: number | null = null;
  try {
    const stat = await statfsAsync(folderPath, STATFS_TIMEOUT_MS);
    // A filesystem that reports no blocks at all says nothing about its free space.
    if (stat && stat.blocks * stat.bsize > 0) freeBytes = stat.bavail * stat.bsize;
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
  return row?.path ? await freeBytesAt(row.path) : null;
}

/** Whether a release of this size would leave less than the reserve free. */
export function exceedsFreeSpace(sizeBytes: number | null, freeBytes: number | null, reserveBytes: number): boolean {
  return sizeBytes != null && freeBytes != null && sizeBytes > freeBytes - reserveBytes;
}

/** Why the release does not fit, as a sentence, or null when it does. */
export function freeSpaceReason(sizeBytes: number | null, freeBytes: number | null, reserveBytes: number): string | null {
  return exceedsFreeSpace(sizeBytes, freeBytes, reserveBytes)
    ? `it is ${Math.round((sizeBytes ?? 0) / 1e9)} GB, more than the ${Math.max(0, Math.round((freeBytes! - reserveBytes) / 1e9))} GB free on the root folder`
    : null;
}

/** For tests: forget the cached readings. */
export function clearFreeSpaceCache(): void {
  cache.clear();
}
