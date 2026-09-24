import { db } from "../db/index.js";
import { parseReleaseTitle, type ReleaseFlag } from "./releaseParser.js";

export type IndexerFlag = "freeleech" | "halfleech";

export type QualityModifier = "regional" | "screener" | "rawhd" | "brdisk";
export type ReleaseTypeCondition = "single" | "multi" | "seasonPack";

export interface ConditionGroup {
  type?:
    | "title"
    | "size"
    | "language"
    | "releaseGroup"
    | "source"
    | "resolution"
    | "year"
    | "releaseFlags"
    | "indexerFlag"
    | "edition"
    | "qualityModifier"
    | "releaseType"; // defaults to "title" for backward compatibility
  patterns?: string[]; // title/releaseGroup/edition conditions: OR'd together (regex)
  minMb?: number | null; // size conditions: inclusive lower bound
  maxMb?: number | null; // size conditions: inclusive upper bound
  languages?: string[]; // language conditions: any of these tags (see releaseParser's LANGUAGE_TAGS)
  sources?: string[]; // source conditions: any of "Remux"/"Bluray"/"WEBDL"/"WEBRip"/"HDTV"/"DVD"/"Cam"/"Telesync"/"Telecine"/"Workprint"
  resolutions?: string[]; // resolution conditions: any of "2160p"/"1080p"/"720p"/"576p"/"480p"
  minYear?: number | null; // year conditions: inclusive lower bound
  maxYear?: number | null; // year conditions: inclusive upper bound
  flags?: ReleaseFlag[]; // releaseFlags conditions: any of proper/repack/extended/unrated/directorscut/imax
  indexerFlags?: IndexerFlag[]; // indexerFlag conditions: any of freeleech/halfleech (from Torznab's downloadvolumefactor)
  qualityModifiers?: QualityModifier[]; // qualityModifier conditions: any of regional/screener/rawhd/brdisk
  releaseTypes?: ReleaseTypeCondition[]; // releaseType conditions: any of single/multi/seasonPack
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
  rejected: boolean;
  rejectReason?: string;
}

function testPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false; // invalid user-supplied regex; skip rather than crash the search
  }
}

const JS_REGEX_FLAGS = new Set(["i", "m", "s"]);

/** Release Profile term matching, Radarr/Sonarr/Lidarr-style: a term wrapped as `/pattern/flags` is
 * a regex (flags outside i/m/s — e.g. .NET's `x`/`n` — are simply dropped rather than erroring,
 * since JS has no equivalent); anything else is a plain case-insensitive substring match, matching
 * every real app's own default term behavior. Always case-insensitive even for a regex term with no
 * explicit `i` flag, consistent with every other pattern match already in this file. */
function testTerm(term: string, text: string): boolean {
  const regexMatch = term.match(/^\/(.+)\/([a-zA-Z]*)$/);
  if (regexMatch) {
    const flags = new Set(regexMatch[2].split("").filter((c) => JS_REGEX_FLAGS.has(c)));
    flags.add("i");
    try {
      return new RegExp(regexMatch[1], Array.from(flags).join("")).test(text);
    } catch {
      return false; // invalid user-supplied regex; skip rather than crash the search
    }
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

/**
 * Evaluates one condition group against a release. Types:
 * - title: any pattern matches the full release title (OR within the group).
 * - size: release size falls within [minMb, maxMb] (either bound optional). No size available
 *   never passes.
 * - language: any of the group's language tags was detected in the title (see releaseParser).
 * - releaseGroup: any pattern matches the parsed trailing release-group tag (e.g. "RARBG"). No
 *   group detected never passes.
 * - source: any of the group's sources (Remux/Bluray/WEBDL/WEBRip/HDTV/DVD/Cam/Telesync/Telecine/
 *   Workprint) matches the parsed source. No source detected never passes.
 * - resolution: any of the group's resolutions (2160p/1080p/720p/576p/480p) matches the parsed
 *   resolution.
 * - year: parsed year falls within [minYear, maxYear] (either bound optional). No year detected
 *   never passes.
 * - releaseFlags: any of the group's flags (proper/repack/extended/unrated/directorscut/imax) was
 *   detected in the title.
 * - edition: any pattern matches the parsed free-text edition phrase (Radarr's "Edition" condition
 *   — a regex-testable superset of the fixed directorscut/extended/unrated/imax flags above). No
 *   edition detected never passes.
 * - qualityModifier: any of the group's modifiers (regional/screener/rawhd/brdisk) matches the
 *   parsed one. No modifier detected never passes.
 * - releaseType: any of the group's types (single/multi/seasonPack) matches the parsed one
 *   (Sonarr's "Release Type" — derived from the same season/episode parse, not its own pattern). A
 *   non-episodic release (movie, album, book) never passes.
 * Every type inverts under `negate` (e.g. "must not contain x265", "must not be French").
 */
function groupPasses(group: ConditionGroup, title: string, sizeBytes: number | null, downloadVolumeFactor: number | null): boolean {
  if (group.type === "indexerFlag") {
    // Unknown status (indexer didn't report downloadvolumefactor at all) never matches — a "must
    // be freeleech" condition should exclude a release whose freeleech status is simply unknown,
    // not treat "unknown" as satisfying it.
    if (downloadVolumeFactor == null) return group.negate ? true : false;
    const detected: IndexerFlag | null = downloadVolumeFactor === 0 ? "freeleech" : downloadVolumeFactor === 0.5 ? "halfleech" : null;
    const anyMatch = detected != null && (group.indexerFlags ?? []).includes(detected);
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "size") {
    if (sizeBytes == null) return group.negate ? true : false;
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

  if (group.type === "edition") {
    const detected = parseReleaseTitle(title).edition;
    if (!detected) return group.negate ? true : false;
    const anyMatch = (group.patterns ?? []).some((p) => testPattern(p, detected));
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "qualityModifier") {
    const detected = parseReleaseTitle(title).qualityModifier;
    if (!detected) return group.negate ? true : false;
    const anyMatch = (group.qualityModifiers ?? []).includes(detected);
    return group.negate ? !anyMatch : anyMatch;
  }

  if (group.type === "releaseType") {
    const detected = parseReleaseTitle(title).releaseType;
    if (!detected) return group.negate ? true : false;
    // Case-insensitive, same as source/resolution above — the HTTP route lowercases stored
    // releaseTypes on save, while the parser's own releaseType value is camelCase ("seasonPack").
    const anyMatch = (group.releaseTypes ?? []).some((t) => t.toLowerCase() === detected.toLowerCase());
    return group.negate ? !anyMatch : anyMatch;
  }

  const anyMatch = (group.patterns ?? []).some((p) => testPattern(p, title));
  return group.negate ? !anyMatch : anyMatch;
}

/** A format matches only if every one of its condition groups passes (AND across groups). */
export function formatMatches(
  groups: ConditionGroup[],
  title: string,
  sizeBytes: number | null = null,
  downloadVolumeFactor: number | null = null
): boolean {
  if (groups.length === 0) return false;
  return groups.every((g) => groupPasses(g, title, sizeBytes, downloadVolumeFactor));
}

/**
 * Radarr/Sonarr/Lidarr-style Release Profiles: must-contain/must-not-contain/preferred term lists,
 * evaluated independently of (and in addition to) Custom Formats. A term wrapped as `/pattern/flags`
 * is a regex (see testTerm); anything else is a plain substring match. Profiles are AND'd together —
 * a release failing any single enabled profile's must-not-contain or must-contain gate is rejected
 * overall, regardless of what other profiles say; preferred-term hits across every profile simply
 * add to the score. `indexerId`/`mediaItemId` scope a profile to specific indexers/tags, same as
 * every real app's own Indexer/Tags restriction — blank (the common case) applies to everything.
 */
async function evaluateReleaseProfiles(
  title: string,
  mediaType: string | null,
  mediaItemId: number | null,
  indexerId: number | null
): Promise<{ scoreBonus: number; rejected: boolean; rejectReason?: string }> {
  const profiles = (await db.prepare("SELECT * FROM release_profiles WHERE enabled = 1").all()) as {
    id: number;
    name: string;
    must_contain: string;
    must_not_contain: string;
    preferred: string;
    media_types: string | null;
    indexer_ids: string | null;
    tag_ids: string | null;
  }[];
  let scoreBonus = 0;
  // Lazily loaded at most once — only profiles that actually restrict by tag need it.
  let itemTagIds: number[] | null = null;

  for (const p of profiles) {
    if (mediaType && p.media_types) {
      let restrictedTo: string[];
      try {
        restrictedTo = JSON.parse(p.media_types);
      } catch {
        restrictedTo = [];
      }
      if (restrictedTo.length > 0 && !restrictedTo.includes(mediaType)) continue;
    }

    if (p.indexer_ids) {
      let restrictedIndexers: number[] = [];
      try {
        restrictedIndexers = JSON.parse(p.indexer_ids);
      } catch {
        restrictedIndexers = [];
      }
      if (restrictedIndexers.length > 0 && (indexerId == null || !restrictedIndexers.includes(indexerId))) continue;
    }

    if (p.tag_ids) {
      let restrictedTags: number[] = [];
      try {
        restrictedTags = JSON.parse(p.tag_ids);
      } catch {
        restrictedTags = [];
      }
      if (restrictedTags.length > 0) {
        if (itemTagIds === null) {
          itemTagIds = mediaItemId
            ? (
                (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(mediaItemId)) as {
                  tag_id: number;
                }[]
              ).map((r) => r.tag_id)
            : [];
        }
        if (!itemTagIds.some((t) => restrictedTags.includes(t))) continue;
      }
    }

    let mustContain: string[] = [];
    let mustNotContain: string[] = [];
    let preferred: { term: string; score: number }[] = [];
    try {
      mustContain = JSON.parse(p.must_contain);
    } catch {
      // malformed row — treat as no requirement rather than crash scoring
    }
    try {
      mustNotContain = JSON.parse(p.must_not_contain);
    } catch {
      // ditto
    }
    try {
      preferred = JSON.parse(p.preferred);
    } catch {
      // ditto
    }

    const forbiddenHit = mustNotContain.find((t) => t && testTerm(t, title));
    if (forbiddenHit) {
      return { scoreBonus: 0, rejected: true, rejectReason: `Release profile "${p.name}": contains "${forbiddenHit}"` };
    }
    if (mustContain.length > 0 && !mustContain.some((t) => t && testTerm(t, title))) {
      return {
        scoreBonus: 0,
        rejected: true,
        rejectReason: `Release profile "${p.name}": missing a required term (${mustContain.join(", ")})`,
      };
    }
    for (const pref of preferred) {
      if (pref.term && testTerm(pref.term, title)) scoreBonus += Number(pref.score) || 0;
    }
  }

  return { scoreBonus, rejected: false };
}

/**
 * Scores a release against every defined custom format that applies to the given media type
 * (Sonarr/Radarr-style): each format is a list of condition groups — title-regex, size-range,
 * language, release-group, source, resolution, year, or release-flags, OR'd within a group, AND'd
 * across groups, each optionally negated — and contributes whatever score the given quality
 * profile assigns it (0 if the profile has no override for that format). A format with no
 * `mediaTypes` restriction (the default) applies to every library type, matching the pre-scoping
 * behavior every existing custom format already has. `mediaItemId`/`indexerId` are only consulted
 * for Release Profiles' own Tags/Indexer restriction (Custom Formats have no such concept).
 */
export async function scoreRelease(
  releaseTitle: string,
  releaseSizeBytes: number | null,
  qualityProfileId: number | null,
  mediaType: string | null = null,
  downloadVolumeFactor: number | null = null,
  mediaItemId: number | null = null,
  indexerId: number | null = null
): Promise<ReleaseScore> {
  const formats = (await db.prepare("SELECT * FROM custom_formats").all()) as {
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
    if (!formatMatches(groups, releaseTitle, releaseSizeBytes, downloadVolumeFactor)) continue;

    let score = 0;
    if (qualityProfileId) {
      const row = (await db
        .prepare(
          "SELECT score FROM quality_profile_format_scores WHERE quality_profile_id = ? AND custom_format_id = ?"
        )
        .get(qualityProfileId, format.id)) as { score: number } | undefined;
      score = row?.score ?? 0;
    }

    matches.push({ id: format.id, name: format.name, score });
  }

  const profileResult = await evaluateReleaseProfiles(releaseTitle, mediaType, mediaItemId, indexerId);
  let rejected = profileResult.rejected;
  let rejectReason = profileResult.rejectReason;

  // A quality profile's maximum size is a hard ceiling independent of any per-quality min/max
  // bounds (services/quality.ts's sizeWithinQualityBounds, which only ever compares a release
  // against the bounds configured for the specific quality it parsed as) — this rejects a release
  // outright once it's over the profile's own limit, regardless of which quality that was. Skipped
  // when the release's size isn't known at all, same "don't reject on missing data" default the
  // size condition type above already uses.
  if (!rejected && qualityProfileId && releaseSizeBytes != null) {
    const profileRow = (await db.prepare("SELECT max_size_gb FROM quality_profiles WHERE id = ?").get(qualityProfileId)) as
      | { max_size_gb: number | null }
      | undefined;
    if (profileRow?.max_size_gb != null) {
      const maxBytes = profileRow.max_size_gb * 1e9;
      if (releaseSizeBytes > maxBytes) {
        rejected = true;
        rejectReason = `Exceeds this quality profile's maximum size (${profileRow.max_size_gb} GB)`;
      }
    }
  }

  const totalScore = matches.reduce((sum, m) => sum + m.score, 0) + profileResult.scoreBonus;
  return { totalScore, matches, rejected, rejectReason };
}
