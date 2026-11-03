import fs from "node:fs";
import { db } from "../db/index.js";

/** When more than one root folder is configured for a media type and the caller didn't pick
 * one explicitly, auto-select the one with the most free disk space right now. */
export async function autoSelectRootFolderId(mediaType: string): Promise<number | null> {
  const folders = (await db
    .prepare("SELECT id, path FROM root_folders WHERE media_type = ?")
    .all(mediaType)) as { id: number; path: string }[];
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0].id;

  let best: { id: number; freeBytes: number } | null = null;
  for (const folder of folders) {
    let freeBytes = -1;
    try {
      const stat = fs.statfsSync(folder.path);
      freeBytes = stat.bavail * stat.bsize;
    } catch {
      // unreachable path — treat as least preferred, but still a valid fallback candidate
    }
    if (!best || freeBytes > best.freeBytes) best = { id: folder.id, freeBytes };
  }
  return best!.id;
}

/** True if no new grab should go to a media item's root folder: it is configured to pause new grabs at
 * a quota and is at/over that quota, or it has a minimum free space and has less than that free.
 * Checked live via `statfs`, same as the disk-space table, not a cached percentage that could go stale
 * between checks. An unreachable path (mount not present, etc.) is never treated as full — that's a
 * different problem for the health check to surface, not a reason to silently stop grabbing. */
export async function isRootFolderOverQuota(rootFolderId: number | null): Promise<boolean> {
  if (!rootFolderId) return false;
  const folder = (await db
    .prepare("SELECT path, quota_percent, pause_grabs_at_quota, min_free_space_gb FROM root_folders WHERE id = ?")
    .get(rootFolderId)) as
    | { path: string; quota_percent: number | null; pause_grabs_at_quota: number; min_free_space_gb: number | null }
    | undefined;
  if (!folder) return false;
  const pausesAtQuota = !!folder.pause_grabs_at_quota && folder.quota_percent !== null;
  const hasMinimum = folder.min_free_space_gb != null && Number(folder.min_free_space_gb) > 0;
  if (!pausesAtQuota && !hasMinimum) return false;

  try {
    const stat = fs.statfsSync(folder.path);
    const totalBytes = stat.blocks * stat.bsize;
    if (totalBytes === 0) return false;
    const freeBytes = stat.bavail * stat.bsize;
    if (hasMinimum && freeBytes < Number(folder.min_free_space_gb) * 1024 ** 3) return true;
    if (!pausesAtQuota) return false;
    const percentUsed = ((totalBytes - freeBytes) / totalBytes) * 100;
    return percentUsed >= folder.quota_percent!;
  } catch {
    return false;
  }
}
