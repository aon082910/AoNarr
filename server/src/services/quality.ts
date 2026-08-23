import { db } from "../db/index.js";
import { log } from "./logger.js";

/** Seed order used to populate the `qualities` table on first boot. Editable afterward via Settings. */
export const DEFAULT_QUALITY_ORDER = [
  "SD",
  "DVD",
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "HDTV-1080p",
  "WEBRip-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-1080p",
  "HDTV-2160p",
  "WEBRip-2160p",
  "WEBDL-2160p",
  "Bluray-2160p",
  "Remux-2160p",
] as const;

export type QualityName = string;

interface SizeBounds {
  minSizeMb: number | null;
  maxSizeMb: number | null;
}

/**
 * `qualityRank`/`sizeWithinQualityBounds`/`preferredSizeDistance` are called synchronously from
 * deep inside release-parsing/scoring code (search, import, scheduler — likely the single hottest
 * read path in the app after settings), so — same reasoning and same pattern as
 * `services/settingsStore.ts` — the small `qualities` table (~15 rows) is kept as an in-memory
 * cache with a synchronous read API, populated at startup and refreshed in the background
 * whenever `invalidateQualityRankCache()` is called after a write. A caller that writes to
 * `qualities` and immediately re-reads through one of these functions in the very same request
 * could theoretically see a stale value for the brief moment the background refresh is still in
 * flight; nothing in this codebase does that (every write route responds with its own updated row
 * directly, not by re-reading through this cache).
 */
let rankCache = new Map<string, number>();
let sizeBoundsCache = new Map<string, SizeBounds>();
let preferredSizeCache = new Map<string, number | null>();

async function loadRanks(): Promise<Map<string, number>> {
  const rows = (await db.prepare("SELECT name, rank FROM qualities ORDER BY rank").all()) as {
    name: string;
    rank: number;
  }[];
  return new Map(rows.map((r) => [r.name, r.rank]));
}

async function loadSizeBounds(): Promise<Map<string, SizeBounds>> {
  const rows = (await db.prepare("SELECT name, min_size_mb, max_size_mb FROM qualities").all()) as {
    name: string;
    min_size_mb: number | null;
    max_size_mb: number | null;
  }[];
  return new Map(rows.map((r) => [r.name, { minSizeMb: r.min_size_mb, maxSizeMb: r.max_size_mb }]));
}

async function loadPreferredSizes(): Promise<Map<string, number | null>> {
  const rows = (await db.prepare("SELECT name, preferred_size_mb FROM qualities").all()) as {
    name: string;
    preferred_size_mb: number | null;
  }[];
  return new Map(rows.map((r) => [r.name, r.preferred_size_mb]));
}

/** Actually awaitable version of the refresh, for the one place (server startup) that needs the
 * cache populated before anything else runs rather than "eventually, in the background." */
export async function loadQualityCaches(): Promise<void> {
  [rankCache, sizeBoundsCache, preferredSizeCache] = await Promise.all([loadRanks(), loadSizeBounds(), loadPreferredSizes()]);
}

/** Call after any write to the `qualities` table so subsequent rank/size lookups see the change.
 * Fire-and-forget (kept synchronous/void on purpose — see the module comment above) so its two
 * existing call sites don't need to become async themselves. */
export function invalidateQualityRankCache(): void {
  loadQualityCaches().catch((err) => log.error("[quality] failed to refresh cache:", (err as Error).message));
}

/** How far a release's size is from its quality's configured preferred size, in MB — smaller is
 * better. Used only as a tiebreaker between releases already equal on format score/seeders/group
 * reputation, never to reject anything (unlike min/max size bounds). No preferred size configured,
 * or no size on the release, is treated as a neutral tie (0), not a penalty. */
export function preferredSizeDistance(qualityName: string | null, sizeBytes: number | null): number {
  if (!qualityName || sizeBytes == null) return 0;
  const preferredMb = preferredSizeCache.get(qualityName);
  if (preferredMb == null) return 0;
  return Math.abs(sizeBytes / 1_000_000 - preferredMb);
}

export function qualityRank(name: string | null): number {
  if (!name) return -1;
  return rankCache.get(name) ?? -1;
}

/**
 * Whether a release's size fits the min/max size configured for its parsed quality. Qualities
 * with no bounds set (the default) always pass — this only rejects releases when the admin has
 * explicitly configured a size range for that quality (e.g. to catch a mislabeled/fake release
 * claiming "1080p" at 200MB). Unknown size (no bounds configured, or size not provided) passes.
 */
export function sizeWithinQualityBounds(qualityName: string | null, sizeBytes: number | null): boolean {
  if (!qualityName || sizeBytes == null) return true;
  const bounds = sizeBoundsCache.get(qualityName);
  if (!bounds) return true;

  const sizeMb = sizeBytes / 1_000_000;
  if (bounds.minSizeMb != null && sizeMb < bounds.minSizeMb) return false;
  if (bounds.maxSizeMb != null && sizeMb > bounds.maxSizeMb) return false;
  return true;
}

/**
 * Picks the best candidate quality allowed by a profile: the highest-ranked quality that is
 * both in the profile's allowed list and at or below the cutoff. If nothing meets the cutoff,
 * falls back to the best allowed quality available among the candidates (still an upgrade path,
 * just short of ideal) rather than grabbing nothing.
 */
export function pickBestAllowedQuality(
  candidateQualities: string[],
  allowedQualities: string[],
  cutoff: string
): string | null {
  const cutoffRank = qualityRank(cutoff);
  const allowedSet = new Set(allowedQualities);

  const eligible = candidateQualities
    .filter((q) => allowedSet.has(q))
    .sort((a, b) => qualityRank(b) - qualityRank(a));

  if (eligible.length === 0) return null;

  const atOrBelowCutoff = eligible.filter((q) => qualityRank(q) <= cutoffRank);
  return atOrBelowCutoff[0] ?? eligible[0];
}
