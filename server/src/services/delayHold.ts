import type { SearchResult } from "../types/index.js";
import { qualityRank } from "./quality.js";
import type { PreferredProtocol } from "./releaseRanking.js";

/**
 * Sonarr/Radarr-style delay profiles (RssSync/DelaySpecification): an automatic grab waits N
 * minutes per protocol, to give the preferred protocol a window to show up before settling for the
 * other. AoNarr has no store of releases it has seen, so the releases of one search stand in for
 * Sonarr's pending list, and a release's age is measured from its own publish date.
 */

export interface DelayProfile {
  enableUsenet: boolean;
  enableTorrent: boolean;
  usenetDelayMinutes: number;
  torrentDelayMinutes: number;
  bypassIfHighestQuality: boolean;
  /** Which protocol wins between equal releases, and the only one the quality bypass applies to.
   * "none" keeps no preference: every protocol counts as preferred. */
  preferredProtocol: PreferredProtocol;
  /** A held release whose custom-format score reaches `minimumBypassFormatScore` is not held
   * (Sonarr's BypassIfAboveCustomFormatScore). */
  bypassIfAboveFormatScore: boolean;
  minimumBypassFormatScore: number;
}

export interface DelayContext {
  /** The quality profile's cutoff and allowed qualities: the bypass compares against the best
   * quality the profile would grab. */
  cutoff: string;
  allowedQualities: string[];
  /** The profile caps its pick at the cutoff (quality_profiles.prefer_cutoff_quality), so the
   * cutoff is the best quality it would grab. */
  preferCutoffQuality: boolean;
  /** The admin ran this search themselves (bulk "Search selected"): Sonarr never delays those. A
   * disabled protocol still counts. */
  userInvoked: boolean;
  now?: number;
}

export interface DelayOutcome<T> {
  /** May be grabbed now. */
  kept: T[];
  /** Its protocol is switched off in the profile: never eligible. */
  disabled: T[];
  /** Younger than the delay: eligible once it has aged, or once an older release for the same
   * target shows the delay has run out. */
  held: T[];
}

/** The best quality the profile would grab: its cutoff when it caps there, else its highest allowed one. */
export function bestGrabbableQuality(ctx: Pick<DelayContext, "cutoff" | "allowedQualities" | "preferCutoffQuality">): string | null {
  if (ctx.preferCutoffQuality && ctx.cutoff) return ctx.cutoff;
  const allowed = ctx.allowedQualities.filter((q) => qualityRank(q) >= 0);
  if (allowed.length > 0) return [...allowed].sort((a, b) => qualityRank(b) - qualityRank(a))[0];
  return ctx.cutoff || null;
}

function delayMinutesFor(profile: DelayProfile, protocol: SearchResult["protocol"]): number {
  return protocol === "torrent" ? profile.torrentDelayMinutes : profile.usenetDelayMinutes;
}

function ageMinutes(result: SearchResult, now: number): number | null {
  if (!result.publishDate) return null;
  const at = new Date(result.publishDate).getTime();
  return Number.isNaN(at) ? null : (now - at) / 60_000;
}

/**
 * Splits the releases that survived every other rejection into those a delay profile lets through
 * now and those it holds.
 *
 * - A protocol that is switched off is never eligible; http and slskd results are not gated.
 * - A release with no delay, from a user-invoked search, or with no usable publish date goes
 *   through (its age can't be judged, so it isn't held forever).
 * - bypassIfHighestQuality lets a release through when its quality is at or above the best the
 *   profile would grab and it is on the preferred protocol.
 * - Once the oldest release on offer is past the delay, every one of them goes through: the wait
 *   was for a better release to appear, and the older one has already had it.
 */
export function applyDelayProfile<T extends { result: SearchResult }>(
  items: T[],
  profile: DelayProfile | null,
  ctx: DelayContext,
  qualityOf: (item: T) => string
): DelayOutcome<T> {
  const outcome: DelayOutcome<T> = { kept: [], disabled: [], held: [] };
  if (!profile) {
    outcome.kept = items;
    return outcome;
  }
  const now = ctx.now ?? Date.now();
  const best = profile.bypassIfHighestQuality ? bestGrabbableQuality(ctx) : null;
  const oldest = items.reduce((max, { result }) => {
    const age = result.protocol === "torrent" || result.protocol === "usenet" ? ageMinutes(result, now) : null;
    return age != null && age > max ? age : max;
  }, -Infinity);

  for (const item of items) {
    const { result } = item;
    const protocol = result.protocol;
    if (protocol !== "torrent" && protocol !== "usenet") {
      outcome.kept.push(item);
      continue;
    }
    if (protocol === "torrent" ? !profile.enableTorrent : !profile.enableUsenet) {
      outcome.disabled.push(item);
      continue;
    }
    const delay = delayMinutesFor(profile, protocol);
    if (ctx.userInvoked || delay <= 0) {
      outcome.kept.push(item);
      continue;
    }
    if (best && qualityRank(qualityOf(item)) >= qualityRank(best) && (profile.preferredProtocol === "none" || profile.preferredProtocol === protocol)) {
      outcome.kept.push(item);
      continue;
    }
    const age = ageMinutes(result, now);
    if (age == null || age >= delay || oldest >= delay) outcome.kept.push(item);
    else outcome.held.push(item);
  }
  return outcome;
}
