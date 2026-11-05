import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";
import { fetchMovieByTmdbId } from "./metadata.js";
import { queueScanAfterAdd } from "./scanOnAdd.js";
import { applyRootFolderDefaults } from "./rootFolderDefaults.js";
import { notifyAdded } from "./notifications.js";
import { evaluateRulesForItem } from "./autoTag.js";

/** How long a new movie waits for TMDB before it is added without release dates. */
const RELEASE_LOOKUP_TIMEOUT_MS = 8000;

/**
 * A list sync adds items one after another, so a TMDB that is down would cost every item the full
 * timeout. After this many failures in a row the lookups stop for a while; the weekly metadata
 * refresh fills the dates in later.
 */
const LOOKUP_FAILURES_BEFORE_PAUSE = 3;
const LOOKUP_PAUSE_MS = 5 * 60 * 1000;
let lookupFailuresInARow = 0;
let lookupsPausedUntil = 0;

/** For tests: forget earlier failures. */
export function resetReleaseLookupBreaker(): void {
  lookupFailuresInARow = 0;
  lookupsPausedUntil = 0;
}

function parseIds(raw: unknown): Record<string, string> {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What every path that adds a wanted item must do once the row exists, so that an item that comes
 * from a list, a watchlist, a request or a webhook behaves like one added on the Add Media screen:
 *
 * - minimum availability takes the instance default (`defaultMinimumAvailability`). Without it the
 *   column stays empty, which the search gate reads as "announced", so an unreleased film is searched
 *   every cycle from the day it is added.
 * - a movie gets the release dates the gate waits for. A date the source already gave is kept; the
 *   rest (and the digital and physical dates "released" waits for) come from TMDB. Only looked up when
 *   the default can gate at all.
 * - `createEmptyFoldersOnAdd` creates the item's library folder.
 *
 * Best effort: the item is already in the library, so a failed lookup or mkdir is logged and never
 * thrown into the sync that added it.
 */
export async function finishWantedAdd(
  itemId: number | bigint | null | undefined,
  source: { releaseDate?: string | null } = {}
): Promise<void> {
  if (itemId == null) return;
  try {
    const row = (await db
      .prepare("SELECT id, type, title, year, external_ids, root_folder_id, release_date, minimum_availability FROM media_items WHERE id = ?")
      .get(Number(itemId))) as
      | {
          id: number;
          type: string;
          title: string;
          year: number | null;
          external_ids: string | null;
          root_folder_id: number | null;
          release_date: string | null;
          minimum_availability: string | null;
        }
      | undefined;
    if (!row) return;

    const availability = row.minimum_availability || getSetting("defaultMinimumAvailability") || "announced";
    const sourceDate = source.releaseDate ? String(source.releaseDate).slice(0, 10) : null;
    await db
      .prepare("UPDATE media_items SET minimum_availability = COALESCE(minimum_availability, ?), release_date = COALESCE(release_date, ?) WHERE id = ?")
      .run(availability, sourceDate, row.id);

    const externalIds = parseIds(row.external_ids);
    const haveDate = !!(row.release_date || sourceDate);
    // "announced" never waits; "inCinemas" waits on the release date alone; "released" also on the
    // digital and physical dates.
    const needsLookup = row.type === "movie" && (availability === "released" || (availability === "inCinemas" && !haveDate));
    if (needsLookup && externalIds.tmdb && getSetting("tmdbApiKey") && Date.now() >= lookupsPausedUntil) {
      try {
        const detail = await withTimeout(fetchMovieByTmdbId(String(externalIds.tmdb)), RELEASE_LOOKUP_TIMEOUT_MS);
        lookupFailuresInARow = 0;
        // The runtime is kept too: a size limit read per minute needs it, and without it a film is
        // judged as 110 minutes and an episode as 45 until the first refresh.
        await db
          .prepare(
            `UPDATE media_items SET release_date = COALESCE(release_date, ?),
               digital_release_date = COALESCE(digital_release_date, ?), physical_release_date = COALESCE(physical_release_date, ?),
               runtime_minutes = COALESCE(runtime_minutes, ?)
             WHERE id = ?`
          )
          .run(detail.releaseDate ?? null, detail.digitalReleaseDate ?? null, detail.physicalReleaseDate ?? null, detail.runtimeMinutes ?? null, row.id);
      } catch (err) {
        if (++lookupFailuresInARow >= LOOKUP_FAILURES_BEFORE_PAUSE) {
          lookupFailuresInARow = 0;
          lookupsPausedUntil = Date.now() + LOOKUP_PAUSE_MS;
          log.warn("[addDefaults] TMDB release date lookups failed 3 times in a row; pausing them for 5 minutes");
        }
        log.warn(`[addDefaults] no release dates for "${row.title}" yet (${(err as Error).message}); the next metadata refresh fills them`);
      }
    }

    if (getSetting("createEmptyFoldersOnAdd") === "1" && row.root_folder_id != null) {
      const root = (await db.prepare("SELECT path FROM root_folders WHERE id = ?").get(row.root_folder_id)) as { path: string } | undefined;
      if (root) {
        // Loaded here: the importer pulls in most of the server, and this module is imported by it.
        const { createLibraryFolderSkeleton } = await import("./importer.js");
        createLibraryFolderSkeleton({ type: row.type as any, title: row.title, year: row.year, externalIds: row.external_ids }, root.path);
      }
    }
    // The root folder's default profile, monitor choice and tags, for what the adder left empty.
    await applyRootFolderDefaults(row.id);
    // Auto tagging rules, after the list's and the folder's own tags are in (a tag already there is never taken over).
    await evaluateRulesForItem(row.id);
    notifyAdded(row.title, row.type, { mediaItemId: Number(row.id) }).catch(() => undefined);

    // A title a list or a request adds may already be on disk. The delay lets the caller put in the episodes.
    queueScanAfterAdd(row.id, 20_000);
  } catch (err) {
    log.warn(`[addDefaults] could not finish adding item ${itemId}:`, (err as Error).message);
  }
}
