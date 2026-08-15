import { db } from "../db/client.js";
import { parseReleaseTitle } from "./releaseParser.js";

export interface ConditionGroup {
  type?: "title" | "size" | "language" | "releaseGroup"; // defaults to "title" for backward compatibility
  patterns?: string[]; // title/releaseGroup conditions: OR'd together
  minMb?: number | null; // size conditions: inclusive lower bound
  maxMb?: number | null; // size conditions: inclusive upper bound
  languages?: string[]; // language conditions: any of these tags (see releaseParser's LANGUAGE_TAGS)
  negate: boolean; // if true, the group passes when it would otherwise NOT
}

export interface CustomFormatMatch {
  id: number;
  name: string;
  score: number;
}

export interface ReleaseScore {
  totalScore: number;
  matches: CustomFormatMatch[];
}

function testPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false; // invalid user-supplied regex; skip rather than crash the search
  }
}

/**
 * Evaluates one condition group against a release. Four types:
 * - title: any pattern matches the full release title (OR within the group).
 * - size: release size falls within [minMb, maxMb] (either bound optional). No size available
 *   never passes.
 * - language: any of the group's language tags was detected in the title (see releaseParser).
 * - releaseGroup: any pattern matches the parsed trailing release-group tag (e.g. "RARBG"). No
 *   group detected never passes.
 * Every type inverts under `negate` (e.g. "must not contain x265", "must not be French").
 */
function groupPasses(group: ConditionGroup, title: string, sizeBytes: number | null): boolean {
  if (group.type === "size") {
    if (sizeBytes == null) return false;
    const sizeMb = sizeBytes / 1_000_000;
    const inRange = (group.minMb == null || sizeMb >= group.minMb) && (group.maxMb == null || sizeMb <= group.maxMb);
    return group.negate ? !inRange : inRange;
  }

  if (group.type === "language") {
    const detected = parseReleaseTitle(title).languages;
    const anyMatch = (group.languages ?? []).some((lang) => detected.includes(lang.toLowerCase()));
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "releaseGroup") {
    const detected = parseReleaseTitle(title).releaseGroup;
    if (!detected) return group.negate ? true : false;
    const anyMatch = (group.patterns ?? []).some((p) => testPattern(p, detected));
    return group.negate ? !anyMatch : anyMatch;
  }

  const anyMatch = (group.patterns ?? []).some((p) => testPattern(p, title));
  return group.negate ? !anyMatch : anyMatch;
}

/** A format matches only if every one of its condition groups passes (AND across groups). */
export function formatMatches(groups: ConditionGroup[], title: string, sizeBytes: number | null = null): boolean {
  if (groups.length === 0) return false;
  return groups.every((g) => groupPasses(g, title, sizeBytes));
}

/**
 * Scores a release against every defined custom format (Sonarr/Radarr-style): each format is a
 * list of condition groups — title-regex, size-range, language, or release-group, OR'd within a
 * group, AND'd across groups, each optionally negated — and contributes whatever score the given
 * quality profile assigns it (0 if the profile has no override for that format).
 */
export function scoreRelease(
  releaseTitle: string,
  releaseSizeBytes: number | null,
  qualityProfileId: number | null
): ReleaseScore {
  const formats = db.prepare("SELECT * FROM custom_formats").all() as {
    id: number;
    name: string;
    patterns: string;
  }[];
  const matches: CustomFormatMatch[] = [];

  for (const format of formats) {
    let groups: ConditionGroup[];
    try {
      groups = JSON.parse(format.patterns);
    } catch {
      continue;
    }
    if (!formatMatches(groups, releaseTitle, releaseSizeBytes)) continue;

    let score = 0;
    if (qualityProfileId) {
      const row = db
        .prepare(
          "SELECT score FROM quality_profile_format_scores WHERE quality_profile_id = ? AND custom_format_id = ?"
        )
        .get(qualityProfileId, format.id) as { score: number } | undefined;
      score = row?.score ?? 0;
    }

    matches.push({ id: format.id, name: format.name, score });
  }

  return { totalScore: matches.reduce((sum, m) => sum + m.score, 0), matches };
}
