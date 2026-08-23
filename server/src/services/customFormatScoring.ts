import { db } from "../db/client.js";
import { parseReleaseTitle, type ReleaseFlag } from "./releaseParser.js";

export interface ConditionGroup {
  type?: "title" | "size" | "language" | "releaseGroup" | "source" | "resolution" | "year" | "releaseFlags"; // defaults to "title" for backward compatibility
  patterns?: string[]; // title/releaseGroup conditions: OR'd together
  minMb?: number | null; // size conditions: inclusive lower bound
  maxMb?: number | null; // size conditions: inclusive upper bound
  languages?: string[]; // language conditions: any of these tags (see releaseParser's LANGUAGE_TAGS)
  sources?: string[]; // source conditions: any of "Remux"/"Bluray"/"WEBDL"/"WEBRip"/"HDTV"/"DVD"
  resolutions?: string[]; // resolution conditions: any of "2160p"/"1080p"/"720p"
  minYear?: number | null; // year conditions: inclusive lower bound
  maxYear?: number | null; // year conditions: inclusive upper bound
  flags?: ReleaseFlag[]; // releaseFlags conditions: any of proper/repack/extended/unrated/directorscut/imax
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
 * Evaluates one condition group against a release. Types:
 * - title: any pattern matches the full release title (OR within the group).
 * - size: release size falls within [minMb, maxMb] (either bound optional). No size available
 *   never passes.
 * - language: any of the group's language tags was detected in the title (see releaseParser).
 * - releaseGroup: any pattern matches the parsed trailing release-group tag (e.g. "RARBG"). No
 *   group detected never passes.
 * - source: any of the group's sources (Remux/Bluray/WEBDL/WEBRip/HDTV/DVD) matches the parsed
 *   source. No source detected never passes.
 * - resolution: any of the group's resolutions (2160p/1080p/720p) matches the parsed resolution.
 * - year: parsed year falls within [minYear, maxYear] (either bound optional). No year detected
 *   never passes.
 * - releaseFlags: any of the group's flags (proper/repack/extended/unrated/directorscut/imax) was
 *   detected in the title.
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

  if (group.type === "source") {
    const detected = parseReleaseTitle(title).source;
    if (!detected) return group.negate ? true : false;
    const anyMatch = (group.sources ?? []).some((s) => s.toLowerCase() === detected.toLowerCase());
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "resolution") {
    const detected = parseReleaseTitle(title).resolution;
    if (!detected) return group.negate ? true : false;
    const anyMatch = (group.resolutions ?? []).some((r) => r.toLowerCase() === detected.toLowerCase());
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "year") {
    const detected = parseReleaseTitle(title).year;
    if (detected == null) return group.negate ? true : false;
    const inRange = (group.minYear == null || detected >= group.minYear) && (group.maxYear == null || detected <= group.maxYear);
    return group.negate ? !inRange : inRange;
  }

  if (group.type === "releaseFlags") {
    const detected = parseReleaseTitle(title).flags;
    const anyMatch = (group.flags ?? []).some((f) => detected.includes(f));
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
 * Scores a release against every defined custom format that applies to the given media type
 * (Sonarr/Radarr-style): each format is a list of condition groups — title-regex, size-range,
 * language, release-group, source, resolution, year, or release-flags, OR'd within a group, AND'd
 * across groups, each optionally negated — and contributes whatever score the given quality
 * profile assigns it (0 if the profile has no override for that format). A format with no
 * `mediaTypes` restriction (the default) applies to every library type, matching the pre-scoping
 * behavior every existing custom format already has.
 */
export function scoreRelease(
  releaseTitle: string,
  releaseSizeBytes: number | null,
  qualityProfileId: number | null,
  mediaType: string | null = null
): ReleaseScore {
  const formats = db.prepare("SELECT * FROM custom_formats").all() as {
    id: number;
    name: string;
    patterns: string;
    media_types: string | null;
  }[];
  const matches: CustomFormatMatch[] = [];

  for (const format of formats) {
    if (mediaType && format.media_types) {
      let restrictedTo: string[];
      try {
        restrictedTo = JSON.parse(format.media_types);
      } catch {
        restrictedTo = [];
      }
      if (restrictedTo.length > 0 && !restrictedTo.includes(mediaType)) continue;
    }

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
