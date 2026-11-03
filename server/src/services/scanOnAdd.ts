import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";

/**
 * Sonarr and Radarr end an add with a disk scan of the title's folder, so a title that is already on disk is linked
 * within seconds. Without it AoNarr showed such a title as missing, searched for it, and the download then landed on
 * top of the file that was already there. The scan is the per-item "Scan & Import" one, run in the background, one at
 * a time, so a list sync that adds a hundred titles does not start a hundred scans at once.
 *
 * Setting `scanOnAdd` = "0" turns it off. The suite sets AONARR_SCAN_ON_ADD=0: a scan that outlives the test that
 * added the item would write into a database the next test file has already reset.
 */

const waiting: number[] = [];
const queued = new Set<number>();
let draining = false;

export function scanOnAddEnabled(): boolean {
  return process.env.AONARR_SCAN_ON_ADD !== "0" && getSetting("scanOnAdd") !== "0";
}

/** Queues a scan of one just-added item. `delayMs` gives a caller that fills in the item's episodes after the insert time to finish. */
export function queueScanAfterAdd(itemId: number | bigint | null | undefined, delayMs = 0): void {
  if (itemId == null || !scanOnAddEnabled()) return;
  const id = Number(itemId);
  if (queued.has(id)) return;
  queued.add(id);
  const enqueue = () => {
    waiting.push(id);
    void drain();
  };
  if (delayMs > 0) setTimeout(enqueue, delayMs).unref?.();
  else enqueue();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Loaded here: the scan pulls in most of the server, and this module is imported by the add paths.
    const { scanAndImportOneMediaItem } = await import("./libraryScan.js");
    for (let id = waiting.shift(); id !== undefined; id = waiting.shift()) {
      queued.delete(id);
      try {
        const result = await scanAndImportOneMediaItem(id, undefined, undefined, true);
        if (result.matched > 0) log.info(`[scanOnAdd] item ${id}: linked ${result.matched} file(s) already on disk`);
      } catch (err) {
        log.warn(`[scanOnAdd] scanning item ${id} after its add failed:`, (err as Error).message);
      }
    }
  } finally {
    draining = false;
  }
}

/** For tests: wait until every queued scan has run. */
export async function waitForScansAfterAdd(): Promise<void> {
  while (draining || waiting.length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}
