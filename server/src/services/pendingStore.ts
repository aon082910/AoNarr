import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
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

/** A day, on top of the delay window, that a forgotten release stays forgotten. */
const FORGET_EXTRA_MS = 86_400_000;

/** The key a forgotten release is stored under: a hash of the link, which can carry an indexer key. */
const forgottenKeyOf = (table: PendingTable, leafId: number, downloadUrl: string) => `${table}:${leafId}:${createHash("sha256").update(downloadUrl).digest("hex")}`;

/** A UTC time in the shape the database's own clock writes (YYYY-MM-DD HH:MM:SS), so it compares as text. */
const dbTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Forgets a held release for good measure: it leaves the held list and is not held again by a later search
 * or RSS sync while the delay would still have been running (plus a day). `delayMinutes` is the profile's
 * delay for the release's protocol. The release can still be grabbed once it has aged, like any other.
 */
export async function forgetPending(row: PendingRow, delayMinutes: number): Promise<void> {
  const link = row.release.downloadUrl;
  if (link) {
    const now = Date.now();
    const key = forgottenKeyOf(row.leafTable, row.leafId, link);
    const expiresAt = dbTime(now + Math.max(0, delayMinutes) * 60_000 + FORGET_EXTRA_MS);
    const existing = await db.prepare("SELECT id FROM forgotten_releases WHERE forgotten_key = ?").get(key);
    if (existing) await db.prepare("UPDATE forgotten_releases SET expires_at = ? WHERE id = ?").run(expiresAt, (existing as { id: number }).id);
    else
      await db
        .prepare("INSERT INTO forgotten_releases (media_item_id, leaf_table, leaf_id, forgotten_key, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.mediaItemId, row.leafTable, row.leafId, key, expiresAt);
  }
  await removePending(row.id);
}

/** Whether the admin forgot this release for this target and the time it stays forgotten has not passed. */
async function isForgotten(table: PendingTable, leafId: number, downloadUrl: string): Promise<boolean> {
  const found = await db
    .prepare(`SELECT id FROM forgotten_releases WHERE forgotten_key = ? AND expires_at > ${nowExpr(db)}`)
    .get(forgottenKeyOf(table, leafId, downloadUrl));
  return !!found;
}

/** Drops the forgotten releases whose time has passed. */
export async function pruneForgotten(): Promise<void> {
  await db.prepare(`DELETE FROM forgotten_releases WHERE expires_at <= ${nowExpr(db)}`).run();
}

/** Saves a held release; a release already saved for the target keeps its first-seen time. A release the admin forgot is not saved. */
export async function recordPending(table: PendingTable, leafId: number, mediaItemId: number, release: SearchResult): Promise<void> {
  if (!release.downloadUrl) return;
  if (await isForgotten(table, leafId, release.downloadUrl)) return;
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
