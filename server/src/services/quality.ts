import { db } from "../db/index.js";
import { log } from "./logger.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
import { getSetting, setSetting } from "./settingsStore.js";

/** Seed order used to populate the `qualities` table on first boot. Editable afterward via Settings. */
export const DEFAULT_QUALITY_ORDER = [
  "SD",
  "DVD",
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "Bluray-720p",
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

/**
 * One-time upgrade for installs seeded before "Bluray-720p" was on the ladder. The release parser
 * grades every 720p Blu-ray rip that way, and a quality missing from the table can't be allowed by
 * any profile — so those releases were refused, and a 720p Blu-ray file was never rated at all.
 *
 * The tier goes right after WEBDL-720p (before HDTV-1080p when that one is gone), the ranks above
 * it move up by one, and a profile that already allows both WEBDL-720p and Bluray-1080p gains it
 * too (it takes a 720p web release and a 1080p disc rip, so a 720p disc rip is no surprise). A
 * profile's cutoff is never touched. A settings flag makes it run once, so an admin who deletes
 * the tier afterwards keeps it deleted.
 */
export async function ensureBluray720pQuality(): Promise<void> {
  if (getSetting("bluray720pTierAdded") === "1") return;
  try {
    await addBluray720pTier();
  } catch (err) {
    // Not worth stopping the app over; the flag stays unset, so the next start tries again.
    log.error("[quality] could not add the Bluray-720p tier:", (err as Error).message);
  }
}

async function addBluray720pTier(): Promise<void> {
  const rows = (await db.prepare("SELECT id, name, rank FROM qualities ORDER BY rank").all()) as { id: number; name: string; rank: number }[];
  if (rows.length > 0 && !rows.some((r) => r.name === "Bluray-720p")) {
    let at = rows.findIndex((r) => r.name === "WEBDL-720p") + 1;
    if (at === 0) at = rows.findIndex((r) => r.name === "HDTV-1080p");
    if (at >= 0) {
      const newRank = at > 0 ? Number(rows[at - 1].rank) + 1 : Number(rows[0].rank);
      const moving = rows.slice(at);
      await db.transaction(async () => {
        // rank is UNIQUE: park the rows that move on negative ranks, then put them one higher.
        for (let i = 0; i < moving.length; i++) {
          await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(-(i + 1), moving[i].id);
        }
        for (const row of moving) {
          await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(Number(row.rank) + 1, row.id);
        }
        await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, ?)").run("Bluray-720p", newRank);

        const profiles = (await db.prepare("SELECT id, allowed_qualities FROM quality_profiles").all()) as { id: number; allowed_qualities: string }[];
        for (const profile of profiles) {
          let allowed: unknown;
          try {
            allowed = JSON.parse(profile.allowed_qualities);
          } catch {
            continue;
          }
          if (!Array.isArray(allowed) || allowed.includes("Bluray-720p") || !allowed.includes("WEBDL-720p") || !allowed.includes("Bluray-1080p")) continue;
          const next = [...allowed];
          next.splice(next.indexOf("WEBDL-720p") + 1, 0, "Bluray-720p");
          await db.prepare("UPDATE quality_profiles SET allowed_qualities = ? WHERE id = ?").run(JSON.stringify(next), profile.id);
        }
      });
      log.info("[quality] added the Bluray-720p tier to the quality ladder");
    }
  }
  setSetting("bluray720pTierAdded", "1");
}

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
 * reputation, never to reject anything (unlike min/max size bounds). No preferred size configured
 * is treated as a neutral tie (0), not a penalty. A release whose size the indexer didn't report
 * is no evidence of being near the preferred size, so it ranks after every reported size
 * (Number.MAX_VALUE rather than Infinity, so two of them still compare as a tie). */
export function preferredSizeDistance(qualityName: string | null, sizeBytes: number | null, runtimeMinutes?: number | null): number {
  if (!qualityName) return 0;
  const preferredMb = preferredSizeCache.get(qualityName);
  if (preferredMb == null) return 0;
  if (sizeBytes == null) return Number.MAX_VALUE;
  return Math.abs(sizeUnits(sizeBytes, runtimeMinutes) - preferredMb);
}

/** The size in the unit the limits are written in: MB, or MB per minute of video when the release's
 * runtime is given (setting `sizeLimitMode` "perMinute", see releaseRuntime.ts). */
function sizeUnits(sizeBytes: number, runtimeMinutes?: number | null): number {
  const mb = sizeBytes / 1_000_000;
  return runtimeMinutes != null && runtimeMinutes > 0 ? mb / runtimeMinutes : mb;
}

export function qualityRank(name: string | null): number {
  if (!name) return -1;
  return rankCache.get(name) ?? -1;
}

/**
 * The quality ladder is video-only (resolution + source), so an album, ebook, comic, ROM or podcast
 * release always parses as "Unknown". Judging such a type by its profile's tiers filters out every
 * release it could ever find; for these types any quality is acceptable and there is no quality to
 * upgrade by. Derived from the type's file extensions: a type with no video extension has no tiers.
 */
export function usesQualityTiers(mediaType: string): boolean {
  const config = MEDIA_TYPES[mediaType];
  if (!config) return true;
  const videoExtensions = new Set(MEDIA_TYPES.movie.extensions);
  return config.extensions.some((ext) => videoExtensions.has(ext));
}

/** Several indexer adapters report a size of 0 when the indexer gave none. Taken literally, that
 * fails every configured minimum size and matches every "smaller than" size custom format. */
export function knownReleaseSize(size: number | null | undefined): number | null {
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * Whether a release's size fits the min/max size configured for its parsed quality. Qualities
 * with no bounds set (the default) always pass — this only rejects releases when the admin has
 * explicitly configured a size range for that quality (e.g. to catch a mislabeled/fake release
 * claiming "1080p" at 200MB). Unknown size (no bounds configured, or size not provided) passes.
 */
export function sizeWithinQualityBounds(qualityName: string | null, sizeBytes: number | null, runtimeMinutes?: number | null): boolean {
  if (!qualityName || sizeBytes == null) return true;
  const bounds = sizeBoundsCache.get(qualityName);
  if (!bounds) return true;

  const sizeMb = sizeUnits(sizeBytes, runtimeMinutes);
  if (bounds.minSizeMb != null && sizeMb < bounds.minSizeMb) return false;
  if (bounds.maxSizeMb != null && sizeMb > bounds.maxSizeMb) return false;
  return true;
}

/**
 * Picks the best candidate quality allowed by a profile: the highest-ranked quality that is
 * both in the profile's allowed list and at or below the cutoff. If nothing meets the cutoff,
 * falls back to the best allowed quality available among the candidates (still an upgrade path,
 * just short of ideal) rather than grabbing nothing. With `capAtCutoff` off (the profile's
 * prefer_cutoff_quality flag) the cutoff only stops upgrades and the best allowed quality wins.
 */
export function pickBestAllowedQuality(
  candidateQualities: string[],
  allowedQualities: string[],
  cutoff: string,
  capAtCutoff = true
): string | null {
  const cutoffRank = qualityRank(cutoff);
  const allowedSet = new Set(allowedQualities);

  const eligible = candidateQualities
    .filter((q) => allowedSet.has(q))
    .sort((a, b) => qualityRank(b) - qualityRank(a));

  if (eligible.length === 0) return null;

  // A profile that does not cap at the cutoff takes the best allowed quality on offer, as Sonarr/Radarr do.
  if (!capAtCutoff) return eligible[0];
  const atOrBelowCutoff = eligible.filter((q) => qualityRank(q) <= cutoffRank);
  return atOrBelowCutoff[0] ?? eligible[0];
}
