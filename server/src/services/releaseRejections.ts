import { getSetting } from "./settingsStore.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
import { usesQualityTiers } from "./quality.js";
import type { ParsedRelease } from "./releaseParser.js";

/**
 * Releases the Starr apps refuse before any quality or title decision, because grabbing them can
 * never end in a usable import: a pack of several seasons, one part of a split season, a season's
 * extras, an untouched disc image, a sample, and (for films) a copy with subtitles burned in.
 * One verdict shared by the automatic grab (`chooseBestResult`), the IRC announce path and the
 * interactive search's annotation, so all three agree on what is refused.
 *
 * The multi-season, raw-disc, sample and hard-coded-subtitle rules each have an off switch — the
 * settings `rejectMultiSeasonPacks`, `rejectRawDiscs`, `rejectSamples` and `rejectHardcodedSubs`
 * (any value but "0" keeps the rule on). A partial season or extras pack satisfies no episode, so
 * it has none: nothing could use it.
 */

export type ReleaseRejectionCode = "partial-season" | "season-extras" | "multi-season" | "raw-disc" | "sample" | "hardcoded-subs";

export interface ReleaseRejection {
  code: ReleaseRejectionCode;
  /** Sentence-case reason, as shown in the log and the interactive search. */
  reason: string;
}

/** Sonarr/Radarr treat a release this small with "sample" in its name as the sample clip. */
const SAMPLE_MAX_BYTES = 70 * 1_000_000;
const SAMPLE_WORD = /\bsample\b/i;

function ruleOn(setting: string): boolean {
  return getSetting(setting) !== "0";
}

export function releaseRejection(
  parsed: ParsedRelease,
  release: { title: string; size?: number | null },
  mediaType: string
): ReleaseRejection | null {
  // Music, books, comics and ROMs have no season, disc image or burned-in subtitle to speak of.
  if (!usesQualityTiers(mediaType)) return null;

  if (parsed.seasonPart) {
    return { code: "partial-season", reason: "One part of a split season (Part/Vol): it holds no whole season and no single episode" };
  }
  if (parsed.seasonExtra) {
    return { code: "season-extras", reason: "A season's extras or subtitle pack, not its episodes" };
  }
  if (parsed.seasonRange && ruleOn("rejectMultiSeasonPacks")) {
    const [first, last] = parsed.seasonRange;
    return { code: "multi-season", reason: `A pack of several seasons (${first}-${last}) can't be queued or imported as one season` };
  }
  if (parsed.rawDisc && ruleOn("rejectRawDiscs")) {
    return { code: "raw-disc", reason: "A raw Blu-ray/DVD disc image, not an encode: it can't be imported" };
  }
  if (SAMPLE_WORD.test(release.title) && release.size != null && release.size > 0 && release.size < SAMPLE_MAX_BYTES && ruleOn("rejectSamples")) {
    return { code: "sample", reason: "A sample clip (the name says sample and the size is under 70 MB)" };
  }
  if (parsed.hardcodedSubs && MEDIA_TYPES[mediaType]?.shape === "single" && ruleOn("rejectHardcodedSubs")) {
    return { code: "hardcoded-subs", reason: "Subtitles are burned into the picture" };
  }
  return null;
}
