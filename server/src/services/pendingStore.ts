import { db } from "../db/index.js";
import type { SearchResult } from "../types/index.js";

/**
 * Releases the delay profile held back, kept so they are grabbed when the delay ends instead of
 * being found again by chance (Sonarr's PendingReleaseService). A search that finds a release the
 * delay holds saves it here against the target (an episode, a film or a sub-item); the job in
 * pendingReleases.ts judges the saved ones again every few minutes. A saved release is dropped
 * when its target gets a file, is queued, or a week has passed.
 */

export type PendingTable = "media_items" | "episodes" | "sub_items";

export const PENDING_MAX_AGE_DAYS = 7;

export interface PendingRow {
  id: number;
  mediaItemId: number;
  leafTable: PendingTable;
  leafId: number;
  release: SearchResult;
  firstSeenAt: string;
}

const keyOf = (table: PendingTable, leafId: number, downloadUrl: string) => `${table}:${leafId}:${downloadUrl}`;

/** Saves a held release; a release already saved for the target keeps its first-seen time. */
export async function recordPending(table: PendingTable, leafId: number, mediaItemId: number, release: SearchResult): Promise<void> {
  if (!release.downloadUrl) return;
  const existing = await db.prepare("SELECT id FROM pending_releases WHERE pending_key = ?").get(keyOf(table, leafId, release.downloadUrl));
  if (existing) return;
  await db
    .prepare("INSERT INTO pending_releases (media_item_id, leaf_table, leaf_id, release, pending_key) VALUES (?, ?, ?, ?, ?)")
    .run(mediaItemId, table, leafId, JSON.stringify(release), keyOf(table, leafId, release.downloadUrl));
}

export async function loadPending(): Promise<PendingRow[]> {
  const rows = (await db.prepare("SELECT * FROM pending_releases ORDER BY id").all()) as any[];
  const out: PendingRow[] = [];
  for (const row of rows) {
    try {
      out.push({
        id: Number(row.id),
        mediaItemId: Number(row.media_item_id),
        leafTable: row.leaf_table,
        leafId: Number(row.leaf_id),
        release: JSON.parse(row.release),
        firstSeenAt: row.first_seen_at,
      });
    } catch {
      await removePending(Number(row.id)); // unreadable: nothing to grab
    }
  }
  return out;
}

export async function removePending(id: number): Promise<void> {
  await db.prepare("DELETE FROM pending_releases WHERE id = ?").run(id);
}

/** Every release saved for one target, e.g. once it has been grabbed some other way. */
export async function clearPendingFor(table: PendingTable, leafId: number): Promise<void> {
  await db.prepare("DELETE FROM pending_releases WHERE leaf_table = ? AND leaf_id = ?").run(table, leafId);
}

export function pendingExpired(firstSeenAt: string, now = Date.now()): boolean {
  const at = Date.parse(firstSeenAt.includes("T") ? firstSeenAt : `${firstSeenAt.replace(" ", "T")}Z`);
  return Number.isFinite(at) && now - at > PENDING_MAX_AGE_DAYS * 86_400_000;
}
