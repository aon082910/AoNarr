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

/** What a failed provider lookup says about the item and about the run. */
export type AliasFailure =
  /** The provider has nothing for this item (no record, no id to ask by, a type it has no titles for). */
  | "definitive"
  /** The setup is at fault: no or a refused API key. */
  | "setup"
  /** The provider is rate limiting us. */
  | "rate-limited"
  /** A network error or a provider-side failure that may not repeat. */
  | "transient";

export function classifyAliasFailure(message: string): AliasFailure {
  if (/API key/i.test(message) || /HTTP 40[13]\b/.test(message)) return "setup";
  if (/HTTP 429\b/.test(message)) return "rate-limited";
  if (/HTTP 404\b|has no record|needs a TMDB id|aren't available for/i.test(message)) return "definitive";
  return "transient";
}

function aliasSourceFor(type: string, externalIds: Record<string, string>): AliasSource {
  return (type === "anime" || type === "manga") && externalIds.anilist ? "anilist_synonym" : "tmdb_alt";
}

/** Fetches the provider's alternate titles for one item and stores them. Returns the number added;
 * throws when the provider can't be asked (no id, no API key, an error). Marks the item checked so
 * the backfill doesn't ask again for an item the provider has nothing for. A failure that says
 * nothing about the item (a missing or refused API key, a rate limit, a network error) leaves it
 * unchecked, so a later run asks again. */
export async function refreshProviderAliases(mediaItemId: number): Promise<number> {
  const row = (await db.prepare("SELECT id, type, title, external_ids FROM media_items WHERE id = ?").get(mediaItemId)) as any;
  if (!row || !usesQualityTiers(row.type)) return 0;
  let externalIds: Record<string, string> = {};
  try {
    externalIds = row.external_ids ? JSON.parse(row.external_ids) : {};
  } catch {
    externalIds = {};
  }
  const source = aliasSourceFor(row.type, externalIds);
  let titles: string[];
  try {
    titles = await fetchAlternateTitlesFor(row.type as MediaType, externalIds);
  } catch (err) {
    if (classifyAliasFailure((err as Error).message) === "definitive") await markAliasesChecked(row.id);
    throw err;
  }
  const added = await storeAliases(mediaItemId, titles, source);
  await markAliasesChecked(row.id);
  if (added > 0) log.info(`[aliases] "${row.title}": stored ${added} alternate title(s) from ${source === "anilist_synonym" ? "AniList" : "TMDB"}`);
  return added;
}

/** Sets the checked marker inside extra_metadata. The column is read again here, not carried over
 * from before the provider call: the item's other writers (a provider match staging its result)
 * run while that call is in flight, and writing back the earlier copy would erase their update.
 * The write only lands if the column still holds what was just read. */
async function markAliasesChecked(mediaItemId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as { extra_metadata: string | null } | undefined;
    if (!row) return;
    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra_metadata ? JSON.parse(row.extra_metadata) : {};
    } catch {
      extra = {};
    }
    extra[ALIASES_CHECKED_KEY] = new Date().toISOString();
    const result = await db
      .prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ? AND COALESCE(extra_metadata, '') = ?")
      .run(JSON.stringify(extra), mediaItemId, row.extra_metadata ?? "");
    if (result.changes > 0) return;
  }
  log.warn(`[aliases] item ${mediaItemId} kept changing while it was being marked checked; it will be asked about again`);
}

/** Items the provider hasn't been asked about yet: quality-tiered types with an id to ask by. */
async function itemsNeedingAliases(): Promise<{ id: number; title: string; source: AliasSource }[]> {
  const rows = (await db.prepare("SELECT id, type, title, external_ids, extra_metadata FROM media_items WHERE external_ids IS NOT NULL").all()) as any[];
  const items: { id: number; title: string; source: AliasSource }[] = [];
  for (const r of rows) {
    if (!usesQualityTiers(r.type)) continue;
    try {
      const extra = r.extra_metadata ? JSON.parse(r.extra_metadata) : {};
      if (extra[ALIASES_CHECKED_KEY]) continue;
      const ids = r.external_ids ? JSON.parse(r.external_ids) : {};
      if (ids.tmdb || ids.anilist) items.push({ id: r.id, title: r.title, source: aliasSourceFor(r.type, ids) });
    } catch {
      // A row whose JSON can't be read has no ids to ask by.
    }
  }
  return items;
}

const BACKFILL_PAUSE_MS = 300;
// AniList allows 90 requests a minute, and has been serving 30 while it is degraded.
const ANILIST_PAUSE_MS = 2100;
// Failures in a row that say nothing about the item, after which the provider is not asked again this run.
const MAX_CONSECUTIVE_FAILURES = 3;

// Set before the first await: the startup kick, the scheduled run and an admin's "Run now" can all
// arrive while the item list is still being read, before the background job is registered.
let backfilling = false;

/** Asks the provider for every unchecked item's alternate titles, one at a time with a pause
 * between calls (decision 6: a background job after the migration, rate-limited). Reported in the
 * Background Jobs widget; safe to run repeatedly, it only visits items not checked before. */
export async function backfillProviderAliases(signal?: AbortSignal): Promise<{ checked: number; added: number }> {
  if (backfilling || isBackgroundJobRunning("matchProviders", "aliases")) return { checked: 0, added: 0 };
  backfilling = true;
  try {
    const items = await itemsNeedingAliases();
    if (items.length === 0) return { checked: 0, added: 0 };
    const jobId = startBackgroundJob("matchProviders", "aliases", "Fetching alternate titles", items.length);
    let checked = 0;
    let added = 0;
    let error: string | undefined;
    // A provider that can't be asked this run (no usable key, rate limited, down): its items wait
    // for the next run while the other provider's carry on.
    const unavailable = new Set<AliasSource>();
    let consecutiveFailures = 0;
    try {
      for (const [index, item] of items.entries()) {
        if (signal?.aborted) break;
        if (unavailable.has(item.source)) continue;
        try {
          added += await refreshProviderAliases(item.id);
          consecutiveFailures = 0;
        } catch (err) {
          const message = (err as Error).message;
          const failure = classifyAliasFailure(message);
          if (failure === "definitive") {
            consecutiveFailures = 0;
            log.info(`[aliases] "${item.title}": ${message}`);
          } else {
            consecutiveFailures++;
            error ??= message;
            log.info(`[aliases] "${item.title}": ${message}; it will be asked about again on a later run`);
            if (failure !== "transient" || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) unavailable.add(item.source);
            if (unavailable.has(item.source)) log.info(`[aliases] not asking ${item.source === "anilist_synonym" ? "AniList" : "TMDB"} again this run`);
            continue;
          }
        }
        checked++;
        incrementBackgroundJobDone("matchProviders", "aliases");
        if (index < items.length - 1) await new Promise((resolve) => setTimeout(resolve, item.source === "anilist_synonym" ? ANILIST_PAUSE_MS : BACKFILL_PAUSE_MS));
      }
      updateBackgroundJob("matchProviders", "aliases", { done: checked });
    } finally {
      finishBackgroundJob(jobId, error);
    }
    if (checked > 0 || error) log.info(`[aliases] alternate-title backfill: ${checked} item(s) checked, ${added} title(s) stored${error ? ` (stopped asking: ${error})` : ""}`);
    return { checked, added };
  } finally {
    backfilling = false;
  }
}
