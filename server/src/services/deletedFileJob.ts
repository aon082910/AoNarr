import { checkForDeletedFiles, unmonitorStillMissing, type ClearedFileRows } from "./deletedFileCheck.js";
import { scanAndImportAllLibraries } from "./libraryScan.js";
import { log } from "./logger.js";
import { getSetting, setSetting } from "./settingsStore.js";

/** The rows the check cleared and has not yet unmonitored (they wait for the follow-up scan), kept across a crash or restart. */
const PENDING_KEY = "deletedFilePendingUnmonitor";

function readPending(): ClearedFileRows {
  try {
    const parsed = JSON.parse(getSetting(PENDING_KEY) || "{}") as Partial<ClearedFileRows>;
    const ids = (value: unknown): number[] => (Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n > 0) : []);
    return { mediaItems: ids(parsed.mediaItems), episodes: ids(parsed.episodes), subItems: ids(parsed.subItems) };
  } catch {
    return { mediaItems: [], episodes: [], subItems: [] };
  }
}

function writePending(rows: ClearedFileRows): void {
  const empty = rows.mediaItems.length + rows.episodes.length + rows.subItems.length === 0;
  setSetting(PENDING_KEY, empty ? "" : JSON.stringify(rows));
}

function merge(a: ClearedFileRows, b: ClearedFileRows): ClearedFileRows {
  const union = (x: number[], y: number[]) => Array.from(new Set([...x, ...y]));
  return { mediaItems: union(a.mediaItems, b.mediaItems), episodes: union(a.episodes, b.episodes), subItems: union(a.subItems, b.subItems) };
}

/**
 * The nightly Deleted File Check. A file another tool only moved or renamed (Radarr/Sonarr sharing
 * the library, a media-server cleanup) used to read as gone at 03:00 and stay "missing" until the
 * 05:00 library scan re-found it: two hours in which the title was wanted again and a second copy
 * could be grabbed. When the check clears anything, the library is scanned straight away; "Unmonitor
 * Deleted" is applied afterwards, to the rows the scan did not re-link. The rows waiting for that are kept in
 * settings until it is done, so a crash or restart between the check and the scan's end does not lose them (they
 * would never be looked at again: a row already cleared is not "missing" at the next check); the next run scans
 * first and then unmonitors them with the new ones.
 */
export async function runDeletedFileCheckJob(signal?: AbortSignal): Promise<void> {
  const leftover = readPending();
  const { missing, cleared, aborted } = await checkForDeletedFiles({ holdUnmonitor: true });
  const waiting = merge(leftover, cleared);
  writePending(waiting);
  if (aborted) {
    log.warn("[deletedFileCheck] a storage location stopped answering, so the check was cut short and the follow-up library scan was skipped");
    return;
  }
  const hasLeftover = waiting.mediaItems.length + waiting.episodes.length + waiting.subItems.length > 0;
  if (missing === 0 && !hasLeftover) return;
  let scanned = false;
  try {
    scanned = await scanAndImportAllLibraries(signal);
  } catch (err) {
    log.warn("[deletedFileCheck] library scan after the check failed:", (err as Error).message);
  }
  // A scan that was aborted, threw, found another scan of a type already running or met a share that did not answer
  // re-linked nothing it did not look at: unmonitoring now would hit files that only moved. The rows stay pending
  // (stored above) and the next run scans again before it decides.
  if (signal?.aborted || !scanned) {
    if (!signal?.aborted) log.warn("[deletedFileCheck] the library scan did not finish for every library, so \"Unmonitor Deleted\" waits for the next run");
    return;
  }
  const unmonitored = await unmonitorStillMissing(waiting);
  writePending({ mediaItems: [], episodes: [], subItems: [] });
  if (unmonitored > 0) log.info(`[deletedFileCheck] ${unmonitored} item(s) still missing after the scan were unmonitored`);
}
