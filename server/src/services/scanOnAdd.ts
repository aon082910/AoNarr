import { db } from "../db/index.js";
import { isBackgroundJobRunning } from "./backgroundJobs.js";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";

/**
 * Sonarr and Radarr end an add with a disk scan of the title's folder, so a title that is already on disk is linked
 * within seconds. Without it AoNarr showed such a title as missing, searched for it, and the download then landed on
 * top of the file that was already there. The scan is the "Scan & Import" one limited to the added titles, run in the
 * background.
 *
 * Adds are coalesced: a list sync that adds 200 titles used to walk the whole root folder 200 times. Now every add
 * within a short window joins one pending batch, and the batch runs as one scan per media type (one walk of the root
 * folders for all of its titles). A batch that finds a whole-library scan of its type running (the scan refuses to
 * overlap) is retried once the running scan has ended, instead of being dropped.
 *
 * Setting `scanOnAdd` = "0" turns it off. The suite sets AONARR_SCAN_ON_ADD=0: a scan that outlives the test that
 * added the item would write into a database the next test file has already reset.
 */

/** A batch starts this long after the last add joined it... */
let debounceMs = 3000;
/** ...but never later than this after the first one, so a sync that keeps adding for minutes still gets its scans. */
let maxWaitMs = 20_000;
/** How often a batch that met a running whole-library scan looks whether that scan has ended. */
let retryPollMs = 2000;
/** A batch gives up waiting for the running scan after this long. */
const RETRY_GIVE_UP_MS = 30 * 60 * 1000;

/** For tests: shorter timings. */
export function setScanOnAddTiming(timing: { debounceMs?: number; maxWaitMs?: number; retryPollMs?: number }): void {
  if (timing.debounceMs !== undefined) debounceMs = timing.debounceMs;
  if (timing.maxWaitMs !== undefined) maxWaitMs = timing.maxWaitMs;
  if (timing.retryPollMs !== undefined) retryPollMs = timing.retryPollMs;
}

interface ScanTarget {
  id: number;
  title: string;
}

/** Items waiting for their batch to start, and every item that is waiting or part of a batch that has not finished. */
const pending = new Set<number>();
const queued = new Set<number>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;
/** Batches being scanned right now, and batches waiting for a whole-library scan to end. */
let scanning = 0;
let waitingForRunningScan = 0;
/** Adds whose delay (see queueScanAfterAdd) has not passed yet. */
let delayedAdds = 0;

export function scanOnAddEnabled(): boolean {
  return process.env.AONARR_SCAN_ON_ADD !== "0" && getSetting("scanOnAdd") !== "0";
}

/** Queues a scan of one just-added item. `delayMs` gives a caller that fills in the item's episodes after the insert time to finish. */
export function queueScanAfterAdd(itemId: number | bigint | null | undefined, delayMs = 0): void {
  if (itemId == null || !scanOnAddEnabled()) return;
  const id = Number(itemId);
  if (queued.has(id)) return;
  queued.add(id);
  if (delayMs > 0) {
    delayedAdds++;
    setTimeout(() => {
      delayedAdds--;
      join(id);
    }, delayMs).unref?.();
  } else {
    join(id);
  }
}

function join(id: number): void {
  pending.add(id);
  const now = Date.now();
  if (batchTimer) clearTimeout(batchTimer);
  else firstPendingAt = now;
  const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now));
  batchTimer = setTimeout(startBatch, wait);
  batchTimer.unref?.();
}

function startBatch(): void {
  batchTimer = null;
  const ids = [...pending];
  pending.clear();
  scanning++;
  void runBatch(ids)
    .catch((err) => log.warn("[scanOnAdd] a scan after adds failed:", (err as Error).message))
    .finally(() => {
      scanning--;
    });
}

async function runBatch(ids: number[]): Promise<void> {
  // Loaded here: the scan pulls in most of the server, and this module is imported by the add paths.
  const { scanAndImportItems } = await import("./libraryScan.js");
  const rows = (await db
    .prepare(`SELECT id, type, title FROM media_items WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids)) as { id: number; type: string; title: string }[];
  const byType = new Map<string, ScanTarget[]>();
  for (const row of rows) {
    const list = byType.get(row.type) ?? [];
    list.push({ id: Number(row.id), title: row.title });
    byType.set(row.type, list);
  }
  for (const id of ids) if (!rows.some((r) => Number(r.id) === id)) queued.delete(id);
  for (const [type, targets] of byType) {
    try {
      const result = await scanAndImportItems(type, targets, true);
      if (result.alreadyRunning) {
        // A whole-library scan of this type is running: it refuses to overlap and walks these titles' files itself,
        // but only the files it has not passed yet. Scan again once it has ended.
        waitForRunningScanThenRetry(type, targets);
        continue;
      }
      if (result.matched > 0) log.info(`[scanOnAdd] ${type}: linked ${result.matched} file(s) already on disk for ${targets.length} added title(s)`);
    } catch (err) {
      log.warn(`[scanOnAdd] scanning ${targets.length} ${type} title(s) after their add failed:`, (err as Error).message);
    }
    for (const t of targets) queued.delete(t.id);
  }
}

/** One retry, started when the whole-library scan has ended. A second refusal is logged and dropped. */
function waitForRunningScanThenRetry(type: string, targets: ScanTarget[]): void {
  waitingForRunningScan++;
  const startedWaiting = Date.now();
  const finish = () => {
    waitingForRunningScan--;
    for (const t of targets) queued.delete(t.id);
  };
  const check = () => {
    if (isBackgroundJobRunning("scan", type)) {
      if (Date.now() - startedWaiting > RETRY_GIVE_UP_MS) {
        log.warn(`[scanOnAdd] gave up waiting for the ${type} scan to end; ${targets.length} added title(s) were not scanned`);
        finish();
        return;
      }
      setTimeout(check, retryPollMs).unref?.();
      return;
    }
    void (async () => {
      try {
        const { scanAndImportItems } = await import("./libraryScan.js");
        const result = await scanAndImportItems(type, targets, true);
        if (result.alreadyRunning) log.warn(`[scanOnAdd] the ${type} scan was busy again; ${targets.length} added title(s) were not scanned`);
        else if (result.matched > 0) log.info(`[scanOnAdd] ${type}: linked ${result.matched} file(s) already on disk for ${targets.length} added title(s) (after the running scan)`);
      } catch (err) {
        log.warn(`[scanOnAdd] the retried scan of ${targets.length} ${type} title(s) failed:`, (err as Error).message);
      } finally {
        finish();
      }
    })();
  };
  setTimeout(check, retryPollMs).unref?.();
}

/** For tests: wait until every queued scan has run. */
export async function waitForScansAfterAdd(): Promise<void> {
  while (delayedAdds > 0 || batchTimer || pending.size > 0 || scanning > 0 || waitingForRunningScan > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}
