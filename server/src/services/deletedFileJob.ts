import { checkForDeletedFiles, unmonitorStillMissing } from "./deletedFileCheck.js";
import { scanAndImportAllLibraries } from "./libraryScan.js";
import { log } from "./logger.js";

/**
 * The nightly Deleted File Check. A file another tool only moved or renamed (Radarr/Sonarr sharing
 * the library, a media-server cleanup) used to read as gone at 03:00 and stay "missing" until the
 * 05:00 library scan re-found it: two hours in which the title was wanted again and a second copy
 * could be grabbed. When the check clears anything, the library is scanned straight away; "Unmonitor
 * Deleted" is applied afterwards, to the rows the scan did not re-link.
 */
export async function runDeletedFileCheckJob(signal?: AbortSignal): Promise<void> {
  const { missing, cleared, aborted } = await checkForDeletedFiles({ holdUnmonitor: true });
  if (aborted) {
    log.warn("[deletedFileCheck] a storage location stopped answering, so the check was cut short and the follow-up library scan was skipped");
    return;
  }
  if (missing === 0) return;
  try {
    await scanAndImportAllLibraries(signal);
  } catch (err) {
    log.warn("[deletedFileCheck] library scan after the check failed:", (err as Error).message);
  }
  // A scan that was aborted re-linked nothing: unmonitoring now would hit files it never got to look for.
  if (signal?.aborted) return;
  const unmonitored = await unmonitorStillMissing(cleared);
  if (unmonitored > 0) log.info(`[deletedFileCheck] ${unmonitored} item(s) still missing after the scan were unmonitored`);
}
