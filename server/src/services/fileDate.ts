import fsp from "node:fs/promises";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

/**
 * Sonarr's and Radarr's `FileDate`: an imported file is dated by its air date (or a film's release date) instead of the
 * day it was downloaded, so a media server that sorts by file date lists a season in air order.
 * `fileDate`: "none" (default), "localAirDate" (noon, local time) or "utcAirDate" (noon, UTC).
 */

export type FileDateMode = "none" | "localAirDate" | "utcAirDate";

export function fileDateMode(): FileDateMode {
  const raw = getSetting("fileDate");
  return raw === "localAirDate" || raw === "utcAirDate" ? raw : "none";
}

/** The first year a file can be dated by: the epoch is 1970, and a day before it is a negative time that some file
 * systems and network shares refuse or store wrong. A year below it is skipped, not clamped to the epoch, which would
 * date a 1950 film as 1970 and sort it among the 1970s ones. */
export const FILE_DATE_MIN_YEAR = 1971;
/** The last year: a far-future placeholder date (2999) is not a day to date a file by either. */
export const FILE_DATE_MAX_YEAR = 2100;

/** Why a readable day cannot date a file, or null when it can (or when it is not a day at all). */
export function fileDateSkipReason(day: string | null | undefined): string | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return null;
  const year = Number(m[1]);
  if (year < FILE_DATE_MIN_YEAR) return `${day} is before ${FILE_DATE_MIN_YEAR}`;
  if (year > FILE_DATE_MAX_YEAR) return `${day} is after ${FILE_DATE_MAX_YEAR}`;
  return null;
}

/** The modification time a day gives under a mode, or null (no mode, no readable day, or a day no file is dated by). */
export function mtimeFor(day: string | null | undefined, mode: FileDateMode = fileDateMode()): Date | null {
  if (mode === "none" || !day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  if (fileDateSkipReason(day)) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const when = mode === "utcAirDate" ? new Date(Date.UTC(year, month - 1, date, 12)) : new Date(year, month - 1, date, 12);
  return Number.isNaN(when.getTime()) || when.getTime() < 0 ? null : when;
}

/** Dates `filePath` by `day` under the setting. Best effort: a read-only share is not a failed import. */
export async function applyFileDate(filePath: string, day: string | null | undefined): Promise<void> {
  const when = mtimeFor(day);
  if (!when) {
    // Not silent: the admin turned the setting on, and this file keeps the day it was imported.
    const reason = fileDateMode() === "none" ? null : fileDateSkipReason(day);
    if (reason) log.info(`[fileDate] "${filePath}" keeps its own date: ${reason}`);
    return;
  }
  await fsp.utimes(filePath, when, when).catch((err) => log.debug(`[fileDate] could not date "${filePath}": ${(err as Error).message}`));
}
