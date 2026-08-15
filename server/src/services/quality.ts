import { db } from "../db/client.js";

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

let rankCache: Map<string, number> | null = null;
let sizeBoundsCache: Map<string, SizeBounds> | null = null;

function loadRanks(): Map<string, number> {
  const rows = db.prepare("SELECT name, rank FROM qualities ORDER BY rank").all() as {
    name: string;
    rank: number;
  }[];
  return new Map(rows.map((r) => [r.name, r.rank]));
}

function loadSizeBounds(): Map<string, SizeBounds> {
  const rows = db.prepare("SELECT name, min_size_mb, max_size_mb FROM qualities").all() as {
    name: string;
    min_size_mb: number | null;
    max_size_mb: number | null;
  }[];
  return new Map(rows.map((r) => [r.name, { minSizeMb: r.min_size_mb, maxSizeMb: r.max_size_mb }]));
}

/** Call after any write to the `qualities` table so subsequent rank/size lookups see the change. */
export function invalidateQualityRankCache(): void {
  rankCache = null;
  sizeBoundsCache = null;
}

export function qualityRank(name: string | null): number {
  if (!name) return -1;
  if (!rankCache) rankCache = loadRanks();
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
  if (!sizeBoundsCache) sizeBoundsCache = loadSizeBounds();
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
