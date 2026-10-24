import { db } from "../db/index.js";
import { log } from "./logger.js";
import { fetchAlternateTitlesFor } from "./metadata.js";
import { usesQualityTiers } from "./quality.js";
import { finishBackgroundJob, incrementBackgroundJobDone, isBackgroundJobRunning, startBackgroundJob, updateBackgroundJob } from "./backgroundJobs.js";
import { storeAliases, type AliasSource } from "./releaseAliases.js";
import type { MediaType } from "../types/index.js";

/**
 * The provider-facing half of alternate titles (see releaseAliases.ts for storage and lookup): asks
 * TMDB/AniList for an item's alternate titles and stores them, one item at a time or as the
 * rate-limited backfill job (MATCHING_ACCURACY_PLAN.md decision 6). Kept apart from
 * releaseAliases.ts so the importer and scheduler can read aliases without importing metadata.ts.
 */

const ALIASES_CHECKED_KEY = "aliasesCheckedAt";

const MISSING_API_KEY = /API key/i;

/** Fetches the provider's alternate titles for one item and stores them. Returns the number added;
 * throws when the provider can't be asked (no id, no API key). Marks the item checked so the
 * backfill doesn't ask again for an item the provider has nothing for — except when the lookup
 * failed for want of an API key, which is the setup's fault, not the item's: it stays unchecked
 * for a run after the key is configured. */
export async function refreshProviderAliases(mediaItemId: number): Promise<number> {
  const row = (await db.prepare("SELECT id, type, title, external_ids, extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as any;
  if (!row || !usesQualityTiers(row.type)) return 0;
  let externalIds: Record<string, string> = {};
  try {
    externalIds = row.external_ids ? JSON.parse(row.external_ids) : {};
  } catch {
    externalIds = {};
  }
  const source: AliasSource = (row.type === "anime" || row.type === "manga") && externalIds.anilist ? "anilist_synonym" : "tmdb_alt";
  let titles: string[];
  try {
    titles = await fetchAlternateTitlesFor(row.type as MediaType, externalIds);
  } catch (err) {
    if (!MISSING_API_KEY.test((err as Error).message)) await markAliasesChecked(row);
    throw err;
  }
  const added = await storeAliases(mediaItemId, titles, source);
  await markAliasesChecked(row);
  if (added > 0) log.info(`[aliases] "${row.title}": stored ${added} alternate title(s) from ${source === "anilist_synonym" ? "AniList" : "TMDB"}`);
  return added;
}

async function markAliasesChecked(row: { id: number; extra_metadata: string | null }): Promise<void> {
  let extra: Record<string, unknown> = {};
  try {
    extra = row.extra_metadata ? JSON.parse(row.extra_metadata) : {};
  } catch {
    extra = {};
  }
  extra[ALIASES_CHECKED_KEY] = new Date().toISOString();
  await db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify(extra), row.id);
}

/** Items the provider hasn't been asked about yet: quality-tiered types with an id to ask by. */
async function itemsNeedingAliases(): Promise<{ id: number; title: string }[]> {
  const rows = (await db.prepare("SELECT id, type, title, external_ids, extra_metadata FROM media_items WHERE external_ids IS NOT NULL").all()) as any[];
  return rows
    .filter((r) => usesQualityTiers(r.type))
    .filter((r) => {
      try {
        const extra = r.extra_metadata ? JSON.parse(r.extra_metadata) : {};
        if (extra[ALIASES_CHECKED_KEY]) return false;
        const ids = r.external_ids ? JSON.parse(r.external_ids) : {};
        return !!(ids.tmdb || ids.anilist);
      } catch {
        return false;
      }
    })
    .map((r) => ({ id: r.id, title: r.title }));
}

const BACKFILL_PAUSE_MS = 300;

/** Asks the provider for every unchecked item's alternate titles, one at a time with a pause
 * between calls (decision 6: a background job after the migration, rate-limited). Reported in the
 * Background Jobs widget; safe to run repeatedly, it only visits items not checked before. */
export async function backfillProviderAliases(signal?: AbortSignal): Promise<{ checked: number; added: number }> {
  if (isBackgroundJobRunning("matchProviders", "aliases")) return { checked: 0, added: 0 };
  const items = await itemsNeedingAliases();
  if (items.length === 0) return { checked: 0, added: 0 };
  const jobId = startBackgroundJob("matchProviders", "aliases", "Fetching alternate titles", items.length);
  let checked = 0;
  let added = 0;
  let error: string | undefined;
  try {
    for (const item of items) {
      if (signal?.aborted) break;
      try {
        added += await refreshProviderAliases(item.id);
      } catch (err) {
        const message = (err as Error).message;
        // No API key: nothing more will succeed this run.
        if (MISSING_API_KEY.test(message)) {
          error = message;
          break;
        }
        log.info(`[aliases] "${item.title}": ${message}`);
      }
      checked++;
      incrementBackgroundJobDone("matchProviders", "aliases");
      if (checked < items.length) await new Promise((resolve) => setTimeout(resolve, BACKFILL_PAUSE_MS));
    }
    updateBackgroundJob("matchProviders", "aliases", { done: checked });
  } finally {
    finishBackgroundJob(jobId, error);
  }
  if (checked > 0) log.info(`[aliases] alternate-title backfill: ${checked} item(s) checked, ${added} title(s) stored${error ? ` (stopped: ${error})` : ""}`);
  return { checked, added };
}

