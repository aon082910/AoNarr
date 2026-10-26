import type { SearchResult } from "../types/index.js";
import { getSetting } from "./settingsStore.js";

/**
 * Whether a release can be fetched at all, before any quality or title decision (Sonarr's
 * RetentionSpecification, MinimumAgeSpecification and TorrentSeedingSpecification):
 *
 * - a usenet post older than the provider's retention is gone (`usenetRetentionDays`, "0" = no limit);
 * - a usenet post younger than the minimum age may not have reached the provider yet
 *   (`usenetMinimumAgeMinutes`, "0" = no wait);
 * - a torrent with fewer seeders than its indexer's minimum has nobody to download from.
 *
 * The first two settings have no UI, like the other matching settings. An unknown age or an unknown
 * seeder count passes, because nothing says the release is unfit.
 */

function wholeSetting(key: string): number {
  const n = Number(getSetting(key) ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Why the release can't be fetched, or null. `minimumSeedersById` maps an indexer id to its minimum. */
export function availabilityRejection(result: SearchResult, minimumSeedersById: Map<number, number>, now = Date.now()): string | null {
  if (result.protocol === "usenet" && result.publishDate) {
    const at = Date.parse(result.publishDate);
    if (Number.isFinite(at)) {
      const ageMinutes = (now - at) / 60_000;
      const retentionDays = wholeSetting("usenetRetentionDays");
      if (retentionDays > 0 && ageMinutes > retentionDays * 1440) {
        return `it is ${Math.floor(ageMinutes / 1440)} days old, past the usenet retention of ${retentionDays} days`;
      }
      const minimumAge = wholeSetting("usenetMinimumAgeMinutes");
      if (minimumAge > 0 && ageMinutes < minimumAge) {
        return `it is ${Math.max(0, Math.floor(ageMinutes))} minutes old, younger than the usenet minimum age of ${minimumAge} minutes`;
      }
    }
  }
  if (result.protocol === "torrent" && result.seeders != null && result.indexerId != null) {
    const minimum = minimumSeedersById.get(result.indexerId) ?? 0;
    if (minimum > 0 && result.seeders < minimum) return `it has ${result.seeders} seeders, fewer than its indexer's minimum of ${minimum}`;
  }
  return null;
}
