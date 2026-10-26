import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { log } from "./logger.js";
import { episodePlanFor, subItemPlanFor } from "./searchPlan.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { recordLeafOutcome } from "./searchBackoff.js";
import { qualityRank } from "./quality.js";
import { loadPending, pendingExpired, removePending, type PendingRow } from "./pendingStore.js";
import {
  chooseBestResult,
  existingFileQuality,
  getQualityProfile,
  grab,
  grabBestRelease,
  isAlreadyQueued,
  loadDelayProfiles,
  noteUnavailableClient,
  pickDelayProfile,
  rowsToDownloadClients,
  rowsToIndexers,
  tagIdsForMediaItem,
  targetIdentityOf,
  type TargetName,
} from "./scheduler.js";
import type { MediaItem } from "../types/index.js";

/**
 * Judges the releases the delay profile held back (pendingStore.ts) again and grabs the ones whose
 * delay has run out. Runs every few minutes from the job registry. A saved release whose target now
 * has a file or a queued download, or that is a week old, is dropped.
 */

async function leafHasFile(row: PendingRow): Promise<boolean> {
  const found = (await db.prepare(`SELECT has_file FROM ${row.leafTable} WHERE id = ?`).get(row.leafId)) as { has_file: number | boolean | null } | undefined;
  return !found || !!Number(found.has_file);
}

/** One saved release: true when it was grabbed. */
async function judgeOne(row: PendingRow, ctx: { delayProfiles: Awaited<ReturnType<typeof loadDelayProfiles>>; indexers: Awaited<ReturnType<typeof rowsToIndexers>>; clients: Awaited<ReturnType<typeof rowsToDownloadClients>>; unavailable: Map<number, string> }): Promise<boolean> {
  const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(row.mediaItemId);
  if (!itemRow) {
    await removePending(row.id);
    return false;
  }
  const item = mediaItemFromRow(itemRow) as MediaItem;
  const episodeId = row.leafTable === "episodes" ? row.leafId : null;
  const subItemId = row.leafTable === "sub_items" ? row.leafId : null;
  if ((await leafHasFile(row)) || (await isAlreadyQueued(item.id, episodeId, subItemId))) {
    await removePending(row.id);
    return false;
  }

  const profile = await getQualityProfile(item.qualityProfileId);
  const delayProfile = pickDelayProfile(ctx.delayProfiles, await tagIdsForMediaItem(item.id));
  // The delay profile was removed: nothing holds the release any more, and a search will find it.
  if (!delayProfile) {
    await removePending(row.id);
    return false;
  }

  let target = null;
  let name: TargetName = { title: item.title };
  let identity = targetIdentityOf(item);
  if (episodeId) {
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
    if (!ep) {
      await removePending(row.id);
      return false;
    }
    target = (await episodePlanFor(item, ep)).target;
  } else if (subItemId) {
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
    if (!sub) {
      await removePending(row.id);
      return false;
    }
    subItemPlanFor(item, sub);
    name = { title: sub.title, parentTitle: item.title };
  }
  const onDisk = await existingFileQuality(item, episodeId, subItemId);
  const usable = ctx.clients.filter((c) => !ctx.unavailable.has(c.id));
  const blocklisted = await getBlocklistedTitles(item.id);
  const choose = (remaining: typeof row.release[]) =>
    chooseBestResult(
      remaining,
      profile?.allowedQualities ?? [],
      profile?.cutoff ?? "",
      item.qualityProfileId,
      profile?.minFormatScore ?? 0,
      target,
      blocklisted,
      item.type,
      delayProfile,
      subItemId ? null : identity,
      item.id,
      {
        clients: usable,
        upgradeFromRank: onDisk === undefined ? null : qualityRank(onDisk),
        name,
        indexers: ctx.indexers,
        label: item.title,
      }
    );

  try {
    const outcome = await grabBestRelease([row.release], usable, choose, (client, chosen) => grab(client, item, episodeId, subItemId, chosen, 0, null, "auto"));
    if (outcome?.grabbed) {
      await removePending(row.id);
      await recordLeafOutcome(row.leafTable, row.leafId, true);
      log.info(`[pending] grabbed "${row.release.title}" for "${item.title}" once its delay ended`);
      return true;
    }
  } catch (err) {
    if (!noteUnavailableClient(err, ctx.unavailable)) log.warn(`[pending] "${row.release.title}" failed:`, (err as Error).message);
  }
  return false;
}

export async function runPendingReleases(): Promise<{ checked: number; grabbed: number }> {
  const rows = await loadPending();
  if (rows.length === 0) return { checked: 0, grabbed: 0 };
  const ctx = {
    delayProfiles: await loadDelayProfiles(),
    indexers: await rowsToIndexers(),
    clients: await rowsToDownloadClients(),
    unavailable: new Map<number, string>(),
  };
  let grabbed = 0;
  for (const row of rows) {
    if (pendingExpired(row.firstSeenAt)) {
      await removePending(row.id);
      continue;
    }
    try {
      if (await judgeOne(row, ctx)) grabbed++;
    } catch (err) {
      log.warn("[pending] could not judge a saved release:", (err as Error).message);
    }
  }
  return { checked: rows.length, grabbed };
}
