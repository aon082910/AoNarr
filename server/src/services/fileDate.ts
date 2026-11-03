import fsp from "node:fs/promises";
import { getSetting } from "./settingsStore.js";

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

/** The modification time a day gives under a mode, or null (no mode, or no readable day). */
export function mtimeFor(day: string | null | undefined, mode: FileDateMode = fileDateMode()): Date | null {
  if (mode === "none" || !day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const when = mode === "utcAirDate" ? new Date(Date.UTC(year, month - 1, date, 12)) : new Date(year, month - 1, date, 12);
  return Number.isNaN(when.getTime()) || year < 1971 ? null : when;
}

/** Dates `filePath` by `day` under the setting. Best effort: a read-only share is not a failed import. */
export async function applyFileDate(filePath: string, day: string | null | undefined): Promise<void> {
  const when = mtimeFor(day);
  if (!when) return;
  await fsp.utimes(filePath, when, when).catch(() => undefined);
}
