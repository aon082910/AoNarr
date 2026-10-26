import { groupedRank, type QualityGroups } from "./quality.js";
import { getSetting } from "./settingsStore.js";
import { parseReleaseTitle, type ReleaseRevision } from "./releaseParser.js";

/**
 * When a release replaces the file a target already has, after Sonarr/Radarr's UpgradableSpecification
 * (IsUpgradable, QualityCutoffNotMet, IsRevisionUpgrade) and RepackSpecification. One pure place for the rule,
 * used by the search, the RSS sync, the upgrade job's candidate list and the Cutoff Unmet page.
 *
 * - A better quality replaces the file only while the file is below the profile's cutoff.
 * - At the same quality, a release replaces the file when its custom-format score beats the file's by at least
 *   the profile's minimum increment while the file's score is under the profile's format cutoff (a cutoff of 0
 *   switches this off), or when it is a later revision of the same release.
 * - A REPACK or RERIP (or an anime "v2") replaces only the file of its own release group: it is that group's
 *   re-upload. A PROPER may come from anyone.
 * - A profile that does not allow upgrades replaces nothing.
 */

/** What to do with a PROPER, REPACK or "v2": prefer it and let it replace the file (the default, as in Sonarr),
 * prefer it for a missing target but never replace a file with it, or ignore revisions altogether. */
export type PropersMode = "preferAndUpgrade" | "doNotUpgrade" | "doNotPrefer";

export function normalizePropersMode(value: unknown): PropersMode {
  return value === "doNotUpgrade" || value === "doNotPrefer" ? value : "preferAndUpgrade";
}

/** The admin's choice (setting `downloadPropersAndRepacks`); Sonarr's default is to prefer and upgrade. */
export function propersMode(): PropersMode {
  return normalizePropersMode(getSetting("downloadPropersAndRepacks"));
}

export interface UpgradeProfile {
  cutoff: string;
  /** Qualities the profile treats as one tier (quality.ts QualityGroups). */
  qualityGroups?: QualityGroups;
  upgradeAllowed: boolean;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
}

/** The file a target has: its quality, the release it came from (null when unknown: a manual import, a scan)
 * and the custom-format score that release had when it was imported (null when not computed). */
export interface ExistingFile {
  quality: string | null;
  releaseTitle: string | null;
  formatScore: number | null;
}

export interface UpgradeOffer {
  quality: string;
  title: string;
  /** The release's custom-format score, once known; undefined before scoring. */
  score?: number;
}

export function upgradeProfileOf(
  profile: { cutoff?: string; qualityGroups?: QualityGroups; upgradeAllowed?: boolean; cutoffFormatScore?: number; minUpgradeFormatScore?: number } | null | undefined
): UpgradeProfile {
  return {
    cutoff: profile?.cutoff ?? "",
    qualityGroups: profile?.qualityGroups ?? [],
    upgradeAllowed: profile?.upgradeAllowed !== false,
    cutoffFormatScore: profile?.cutoffFormatScore ?? 0,
    minUpgradeFormatScore: profile?.minUpgradeFormatScore ?? 1,
  };
}

/** Whether the file's quality has reached the profile's cutoff. A file whose quality is not on this ladder (a
 * deleted tier, "Unknown") never has: nothing is known about it to say it is enough. */
export function qualityCutoffMet(profile: UpgradeProfile, file: ExistingFile): boolean {
  if (!profile.cutoff) return false;
  const current = groupedRank(file.quality, profile.qualityGroups);
  return current >= 0 && current >= groupedRank(profile.cutoff, profile.qualityGroups);
}

/** The format cutoff: switched off at 0, otherwise a file scoring less (an unknown score counts as 0) is below it. */
export function formatCutoffNotMet(profile: UpgradeProfile, file: ExistingFile): boolean {
  return profile.cutoffFormatScore > 0 && (file.formatScore ?? 0) < profile.cutoffFormatScore;
}

/** The file is still worth a search for something better: its quality is under the cutoff, or its score is under
 * the format cutoff. */
export function cutoffNotMet(profile: UpgradeProfile, file: ExistingFile): boolean {
  if (!profile.upgradeAllowed) return false;
  const rank = groupedRank(file.quality, profile.qualityGroups);
  const qualityBelow = !!profile.cutoff && rank >= 0 && rank < groupedRank(profile.cutoff, profile.qualityGroups);
  return qualityBelow || formatCutoffNotMet(profile, file);
}

function revisionOf(title: string | null | undefined): ReleaseRevision {
  return title ? parseReleaseTitle(title).revision ?? { version: 1, real: 0, isRepack: false } : { version: 1, real: 0, isRepack: false };
}

/** Which of two revisions is later: a higher REAL count first, then the version. Positive when `a` is later. */
export function compareRevisions(a: ReleaseRevision, b: ReleaseRevision): number {
  return a.real - b.real || a.version - b.version;
}

function sameGroup(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Whether a later revision of the file's own release replaces it, by the PROPER/REPACK rules above. */
export function revisionUpgrade(mode: PropersMode, existingTitle: string | null, candidateTitle: string): boolean {
  if (mode === "doNotUpgrade" || !existingTitle) return false;
  const existing = parseReleaseTitle(existingTitle);
  const candidate = parseReleaseTitle(candidateTitle);
  const later = compareRevisions(candidate.revision ?? revisionOf(candidateTitle), existing.revision ?? revisionOf(existingTitle)) > 0;
  if (!later) return false;
  // A re-upload of a release is the group's own: only its file is replaced by it.
  if (candidate.revision?.isRepack && !sameGroup(candidate.releaseGroup, existing.releaseGroup)) return false;
  return true;
}

export type UpgradeVerdict = "yes" | "no" | "needs-score";

/**
 * Whether the candidate replaces the file. "needs-score" means only the format-score rule could still say yes and
 * the candidate has not been scored yet: ask again with its score.
 */
export function judgeUpgrade(profile: UpgradeProfile, mode: PropersMode, file: ExistingFile, candidate: UpgradeOffer): UpgradeVerdict {
  if (!profile.upgradeAllowed) return "no";
  const current = groupedRank(file.quality, profile.qualityGroups);
  const next = groupedRank(candidate.quality, profile.qualityGroups);
  if (next > current) return qualityCutoffMet(profile, file) ? "no" : "yes";
  if (next < current || current < 0) return "no";
  // The same quality.
  if (revisionUpgrade(mode, file.releaseTitle, candidate.title)) return "yes";
  if (!formatCutoffNotMet(profile, file)) return "no";
  if (candidate.score === undefined) return "needs-score";
  return candidate.score - (file.formatScore ?? 0) >= Math.max(1, profile.minUpgradeFormatScore) ? "yes" : "no";
}
