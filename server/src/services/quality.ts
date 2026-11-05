import { db } from "../db/index.js";
import {
  DEFAULT_QUALITY_ORDER,
  DVD_IMAGE_QUALITY,
  EXTENDED_LADDER_TIERS,
  SD_CLASS_QUALITIES,
} from "../db/qualityLadder.js";
import { log } from "./logger.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
import { getSetting, setSetting } from "./settingsStore.js";
import {
  GLOBAL_RANKING,
  parseQualityGroups,
  parseQualityOrder,
  rankingFromRow,
  rankingOf,
  type ProfileRanking,
  type QualityGroups,
} from "./qualityGroups.js";

export { GLOBAL_RANKING, parseQualityGroups, parseQualityOrder, rankingFromRow, rankingOf, type ProfileRanking, type QualityGroups };

/** Seed order used to populate the `qualities` table on first boot. Editable afterward via Settings. */
export { DEFAULT_QUALITY_ORDER };

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

/**
 * One-time extension of the ladder to Starr's: the pre-release copies (WORKPRINT, CAM, TELESYNC, TELECINE, REGIONAL,
 * DVDSCR) at the very bottom, SDTV, DVD-R, WEBRip/WEBDL-480p and Bluray-480p/576p among the standard-definition
 * tiers, and BR-DISK and Raw-HD at the top (see db/qualityLadder.ts). The release parser grades these names from
 * now on; before, a 480p web rip, a 576p disc rip and SDTV all read "SD", and a CAM, a disc image or a raw capture
 * read "Unknown" or a web tier.
 *
 * Each missing tier goes right after its nearest predecessor on the default ladder that this install has (the
 * first one at the front), so an install whose admin reordered or deleted tiers keeps its own order around the
 * new ones. The ranks are rewritten 0..n-1 in one transaction, the same way a reorder does it (rank is UNIQUE).
 *
 * Profiles keep behaving as they did: one that allows "SD" gains the SD-class tiers beside it (the releases it took
 * as SD are still taken) and SD and those tiers are one quality group, so a file stored as "SD" is not replaced by an
 * SDTV release that read as SD before (an admin who wants them told apart removes the group); one that allows "DVD"
 * gains DVD-R; and a group already holding SD or DVD takes the new members into it. No profile gains a pre-release
 * tier, BR-DISK or Raw-HD: those were refused or mis-graded before, so the admin opts in. No cutoff is touched, and what files, history and the blocklist recorded keeps its
 * name. The new SD-class tiers start with the size limits of "SD" (DVD-R those of "DVD"), so a 480p release is held
 * to the limits it was held to when it read "SD".
 *
 * A settings flag makes it run once, so an admin who deletes a new tier keeps it deleted. A failure is logged and
 * retried at the next start; it never stops the app.
 */
export async function ensureExtendedQualityLadder(): Promise<void> {
  if (getSetting("qualityLadderExtended") === "1") return;
  try {
    await extendQualityLadder();
    setSetting("qualityLadderExtended", "1");
  } catch (err) {
    log.error("[quality] could not extend the quality ladder:", (err as Error).message);
  }
}

interface LadderRow {
  id: number;
  name: string;
  rank: number;
  min_size_mb: number | null;
  max_size_mb: number | null;
  preferred_size_mb: number | null;
}

/** The tiers the extension adds that `present` lacks, with the place each takes in the new order. */
export function planLadderExtension(present: string[]): { order: string[]; added: string[] } {
  const order = [...present];
  const added: string[] = [];
  const defaults: readonly string[] = DEFAULT_QUALITY_ORDER;
  for (const name of EXTENDED_LADDER_TIERS) {
    if (order.includes(name)) continue;
    let at = 0;
    for (let i = defaults.indexOf(name) - 1; i >= 0; i--) {
      const before = order.indexOf(defaults[i]);
      if (before !== -1) {
        at = before + 1;
        break;
      }
    }
    order.splice(at, 0, name);
    added.push(name);
  }
  return { order, added };
}

/** A profile's allowed list with `names` put right after `anchor` (at the end when the anchor is not there). */
function withAfter(list: string[], anchor: string, names: string[]): string[] {
  const missing = names.filter((n) => !list.includes(n));
  if (missing.length === 0) return list;
  const next = [...list];
  next.splice(next.indexOf(anchor) + 1, 0, ...missing);
  return next;
}

async function extendQualityLadder(): Promise<void> {
  const rows = (await db
    .prepare("SELECT id, name, rank, min_size_mb, max_size_mb, preferred_size_mb FROM qualities ORDER BY rank")
    .all()) as LadderRow[];
  // An empty table is not an install that was extended: there is nothing to put the new tiers around.
  if (rows.length === 0) return;
  const { order, added } = planLadderExtension(rows.map((r) => r.name));
  if (added.length === 0) return;

  const byName = new Map(rows.map((r) => [r.name, r]));
  const sdClass = SD_CLASS_QUALITIES.filter((n) => added.includes(n));
  const dvdImage = added.includes(DVD_IMAGE_QUALITY) ? [DVD_IMAGE_QUALITY] : [];
  // The size limits an added tier starts with: its predecessor class's, so what was held to them stays held to them.
  const limitsFrom = (name: string): LadderRow | undefined =>
    (SD_CLASS_QUALITIES as readonly string[]).includes(name) ? byName.get("SD") : name === DVD_IMAGE_QUALITY ? byName.get("DVD") : undefined;

  await db.transaction(async () => {
    // rank is UNIQUE: park every row on a negative rank, then give each its place in the new order.
    for (let i = 0; i < rows.length; i++) {
      await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(-(i + 1), rows[i].id);
    }
    for (let rank = 0; rank < order.length; rank++) {
      const existing = byName.get(order[rank]);
      if (existing) {
        await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(rank, existing.id);
      } else {
        const from = limitsFrom(order[rank]);
        await db
          .prepare("INSERT INTO qualities (name, rank, min_size_mb, max_size_mb, preferred_size_mb) VALUES (?, ?, ?, ?, ?)")
          .run(order[rank], rank, from?.min_size_mb ?? null, from?.max_size_mb ?? null, from?.preferred_size_mb ?? null);
      }
    }

    const profiles = (await db.prepare("SELECT id, allowed_qualities, quality_groups FROM quality_profiles").all()) as {
      id: number;
      allowed_qualities: string | null;
      quality_groups: string | null;
    }[];
    for (const profile of profiles) {
      let allowed: unknown;
      try {
        allowed = JSON.parse(profile.allowed_qualities ?? "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(allowed) || allowed.some((q) => typeof q !== "string")) continue;
      let nextAllowed = allowed as string[];
      if (nextAllowed.includes("SD")) nextAllowed = withAfter(nextAllowed, "SD", sdClass);
      if (nextAllowed.includes("DVD")) nextAllowed = withAfter(nextAllowed, "DVD", dvdImage);

      // A group that holds SD (or DVD) takes the new members of that class, when the profile now allows them.
      const groups = parseQualityGroups(profile.quality_groups);
      const grouped = new Set(groups.flat());
      const nextGroups = groups.map((group) => {
        const gained = [...(group.includes("SD") ? sdClass : []), ...(group.includes("DVD") ? dvdImage : [])].filter((n) => nextAllowed.includes(n) && !group.includes(n));
        return gained.length > 0 ? [...group, ...gained] : group;
      });
      // SD that is in no group becomes one with the tiers split out of it: they were one tier, and a profile that
      // allowed SD must not start upgrading an "SD" file to the SDTV release of the same kind.
      if (nextAllowed.includes("SD") && !grouped.has("SD")) {
        const split = sdClass.filter((n) => nextAllowed.includes(n) && !grouped.has(n));
        if (split.length > 0) nextGroups.push(["SD", ...split]);
      }

      const allowedChanged = nextAllowed !== allowed;
      const groupsChanged = nextGroups.length !== groups.length || nextGroups.some((g, i) => g.length !== groups[i].length);
      if (!allowedChanged && !groupsChanged) continue;
      await db
        .prepare("UPDATE quality_profiles SET allowed_qualities = ?, quality_groups = ? WHERE id = ?")
        .run(JSON.stringify(nextAllowed), JSON.stringify(parseQualityGroups(nextGroups)), profile.id);
    }
  });
  log.info(`[quality] extended the quality ladder with ${added.join(", ")}`);
}

/**
 * Startup repair for quality profiles whose cutoff is not a quality on the ladder (a renamed or deleted tier, a
 * typo, a value stored before a rename). Such a cutoff reads as "never reached", which makes every monitored file
 * under the profile an upgrade candidate. The cutoff is set to the profile's best allowed quality (the highest
 * rank among its allowed qualities and the members of its groups) and a warning names the profile, the old and
 * the new value. A profile with no ranked allowed quality is left alone, so the Health warning stays for the
 * admin. A profile with a ranked cutoff (even one it does not allow) or no cutoff is never touched, which also
 * makes the repair idempotent. Returns the number of profiles changed.
 */
export async function repairUnrankedCutoffs(): Promise<number> {
  const ladder = new Map(((await db.prepare("SELECT name, rank FROM qualities").all()) as { name: string; rank: number }[]).map((r) => [r.name, Number(r.rank)]));
  if (ladder.size === 0) return 0;
  const rows = (await db.prepare("SELECT id, name, cutoff, allowed_qualities, quality_groups, quality_order FROM quality_profiles").all()) as {
    id: number;
    name: string;
    cutoff: string | null;
    allowed_qualities: string | null;
    quality_groups: string | null;
    quality_order: string | null;
  }[];
  let repaired = 0;
  for (const row of rows) {
    const cutoff = (row.cutoff ?? "").trim();
    if (!cutoff || ladder.has(cutoff)) continue;
    let allowed: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_qualities ?? "[]");
      if (Array.isArray(parsed)) allowed = parsed.filter((q): q is string => typeof q === "string");
    } catch {
      // an unreadable list gives nothing to repair from
    }
    const candidates = new Set(allowed);
    for (const group of parseQualityGroups(row.quality_groups)) {
      if (group.some((q) => allowed.includes(q))) for (const q of group) candidates.add(q);
    }
    // "Best" as the profile ranks the ladder, so a profile that puts WEB-DL above Blu-ray is repaired to its WEB-DL.
    const order = rankingFromRow({ quality_order: row.quality_order }).order;
    const orderBase = Math.max(...ladder.values()) + 1;
    const profileRank = (q: string): number => {
      const at = order ? order.indexOf(q) : -1;
      return at >= 0 ? orderBase + at : (ladder.get(q) as number);
    };
    let best: string | null = null;
    for (const q of candidates) {
      if (!ladder.has(q)) continue;
      if (best === null || profileRank(q) > profileRank(best)) best = q;
    }
    if (best === null) continue;
    await db.prepare("UPDATE quality_profiles SET cutoff = ? WHERE id = ?").run(best, row.id);
    log.warn(`[quality] profile "${row.name}" (id ${row.id}): its cutoff "${cutoff}" is not a quality on the ladder, so it was set to the best quality the profile allows, "${best}"`);
    repaired++;
  }
  return repaired;
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
/** Above every rank on the ladder: where a profile's own order starts (see orderedRank). */
let profileRankBase = 0;

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
  profileRankBase = Math.max(-1, ...Array.from(rankCache.values(), Number)) + 1;
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

/** A quality's place on the global ladder (-1 when it is not on it). A profile reads its own: see groupedRank. */
export function qualityRank(name: string | null): number {
  if (!name) return -1;
  return rankCache.get(name) ?? -1;
}

/**
 * How the helpers below are handed a profile's ranking. The type is a ProfileRanking; a bare list of groups (what
 * the helpers took before a profile could have an order) is still read as one with no order, which keeps the
 * callers and tests written for that shape working.
 */
function asRanking(ranking: ProfileRanking | QualityGroups | null | undefined): ProfileRanking {
  if (!ranking) return GLOBAL_RANKING;
  return Array.isArray(ranking) ? { groups: ranking, order: null } : ranking;
}

/**
 * A quality's rank in a profile's order, before any grouping: its global rank for a profile with no order of its own;
 * for one with an order, the places in that order sit above every global rank, so a quality missing from the list ranks
 * below every listed one, in global order among the unlisted. -1 for a quality that is not on the ladder, whatever the
 * order says.
 */
export function orderedRank(name: string | null, ranking?: ProfileRanking | null): number {
  const own = qualityRank(name);
  const order = asRanking(ranking).order;
  if (own < 0 || !order) return own;
  const at = order.indexOf(name as string);
  return at < 0 ? own : profileRankBase + at;
}

/** A quality's rank in a profile: that of the best quality in its group, else its own, in the profile's order. */
export function groupedRank(name: string | null, ranking?: ProfileRanking | null): number {
  const r = asRanking(ranking);
  const own = orderedRank(name, r);
  if (!name || own < 0 || r.groups.length === 0) return own;
  const group = r.groups.find((g) => g.includes(name));
  return group ? Math.max(...group.map((n) => orderedRank(n, r))) : own;
}

/**
 * Whether a file of `quality` is still under the profile's cutoff. A cutoff that is not on the quality
 * ladder (a renamed or deleted tier) can never be reached, so a file of a known quality is under it and
 * upgrades go on, instead of the file reading as "at the cutoff" because every rank is above -1. No cutoff
 * set means nothing is under it, and a file of unknown quality is not known to be under any.
 */
export function isUnderCutoff(quality: string | null, cutoff: string | null | undefined, ranking?: ProfileRanking | null): boolean {
  const rank = groupedRank(quality, ranking);
  if (rank < 0 || !cutoff) return false;
  const cutoffRank = groupedRank(cutoff, ranking);
  return cutoffRank < 0 || rank < cutoffRank;
}

/** Whether the profile's cutoff is a quality on the ladder (an empty cutoff is not set, so not one). */
export function cutoffIsRanked(cutoff: string | null | undefined, ranking?: ProfileRanking | null): boolean {
  return !!cutoff && groupedRank(cutoff, ranking) >= 0;
}

/**
 * The profile rank of whichever quality has the global `rank` (callers that only hold a rank, such as the rank of
 * what is on disk, hand over that). A rank that is already a profile rank maps to itself, so converting twice is harmless.
 */
export function groupRankOfRank(rank: number, ranking?: ProfileRanking | null): number {
  const r = asRanking(ranking);
  if (rank < 0 || (r.groups.length === 0 && !r.order)) return rank;
  for (const [name, own] of rankCache) if (own === rank) return groupedRank(name, r);
  return rank;
}

/** Whether two qualities are the same tier in a profile. */
export function sameQualityGroup(a: string | null, b: string | null, ranking?: ProfileRanking | null): boolean {
  if (a === b) return true;
  const groups = asRanking(ranking).groups;
  return !!a && !!b && groups.some((g) => g.includes(a) && g.includes(b));
}

/**
 * Which of two qualities a profile prefers: positive when `a` is better, negative when `b` is, 0 when they
 * are the same tier (or both unknown). The sort every "best first" list uses.
 */
export function compareQualities(a: string | null, b: string | null, ranking?: ProfileRanking | null): number {
  return groupedRank(a, ranking) - groupedRank(b, ranking);
}

/**
 * A profile's order after its allowed list changed without a new order: a quality now allowed that the order leaves out
 * would rank below every listed one, so each is put in front of the first listed quality that is higher on the global
 * ladder (at the end when none is). The order is otherwise as it was.
 */
export function reconcileQualityOrder(order: string[], allowed: string[]): string[] {
  const next = [...order];
  for (const name of allowed) {
    if (next.includes(name) || qualityRank(name) < 0) continue;
    const before = next.findIndex((n) => qualityRank(n) > qualityRank(name));
    next.splice(before < 0 ? next.length : before, 0, name);
  }
  return next;
}

/** The ranking of the profile with this id: its groups and its order (the global ranking for no profile). */
export async function rankingForProfile(profileId: number | null | undefined): Promise<ProfileRanking> {
  if (!profileId) return GLOBAL_RANKING;
  const row = (await db.prepare("SELECT quality_groups, quality_order FROM quality_profiles WHERE id = ?").get(profileId)) as
    | { quality_groups: string | null; quality_order: string | null }
    | undefined;
  return rankingFromRow(row);
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
  capAtCutoff = true,
  ranking?: ProfileRanking | null
): string | null {
  const cutoffRank = groupedRank(cutoff, ranking);
  const allowedSet = new Set(allowedQualities);

  const eligible = candidateQualities
    .filter((q) => allowedSet.has(q))
    .sort((a, b) => groupedRank(b, ranking) - groupedRank(a, ranking));

  if (eligible.length === 0) return null;

  // A profile that does not cap at the cutoff takes the best allowed quality on offer, as Sonarr/Radarr do.
  if (!capAtCutoff) return eligible[0];
  const atOrBelowCutoff = eligible.filter((q) => groupedRank(q, ranking) <= cutoffRank);
  return atOrBelowCutoff[0] ?? eligible[0];
}
