import { db } from "../db/index.js";
import { log } from "./logger.js";
import { waitForScansAfterAdd } from "./scanOnAdd.js";

/**
 * "Search on add" of an import list: Sonarr and Radarr start a search for what a list just added
 * instead of waiting for the next scheduled one. The search waits for the disk scan that follows an
 * add (scanOnAdd.ts) and skips an item that scan found a file for, so a title that is already on disk
 * is not downloaded a second time.
 *
 * The suite sets AONARR_SEARCH_ON_ADD=0: a search that outlives the test that added the item would
 * run against a database the next test file has already reset.
 */

/** How long after the add the search starts; longer than the 20 s delay of the scan the add queues. */
const SEARCH_DELAY_MS = 30_000;
const queued = new Set<number>();

export function searchOnAddEnabled(): boolean {
  return process.env.AONARR_SEARCH_ON_ADD !== "0";
}

/** Queues one search for a just-added item. Safe to call twice for the same item. */
export function queueSearchAfterAdd(itemId: number | bigint | null | undefined, delayMs = SEARCH_DELAY_MS): void {
  if (itemId == null || !searchOnAddEnabled()) return;
  const id = Number(itemId);
  if (queued.has(id)) return;
  queued.add(id);
  setTimeout(() => {
    void run(id).finally(() => queued.delete(id));
  }, delayMs).unref?.();
}

async function run(id: number): Promise<void> {
  try {
    await waitForScansAfterAdd();
    const item = (await db.prepare("SELECT id, title, monitored, has_file FROM media_items WHERE id = ?").get(id)) as
      | { id: number; title: string; monitored: number; has_file: number }
      | undefined;
    if (!item || !Number(item.monitored) || Number(item.has_file)) return;
    // Loaded here: the scheduler pulls in most of the server, and this module is imported by the add paths.
    const { searchAndGrabTargets } = await import("./scheduler.js");
    const [result] = await searchAndGrabTargets([{ mediaItemId: id }]);
    if (result?.grabbed || (result?.childrenGrabbed ?? 0) > 0) log.info(`[searchOnAdd] "${item.title}": grabbed a release right after the list added it`);
  } catch (err) {
    log.warn(`[searchOnAdd] searching for item ${id} after its add failed:`, (err as Error).message);
  }
}
