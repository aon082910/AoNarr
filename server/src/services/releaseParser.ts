import type { QualityName } from "./quality.js";

export type ReleaseFlag = "proper" | "repack" | "extended" | "unrated" | "directorscut" | "imax";

export interface ParsedRelease {
  seasonNumber: number | null;
  episodeNumbers: number[] | null; // null when not an episode release (movie, full-season, album, book)
  isFullSeason: boolean;
  year: number | null;
  quality: QualityName | "Unknown";
  source: string | null; // "Remux"/"Bluray"/"WEBDL"/"WEBRip"/"HDTV"/"DVD" — the source half of `quality`, split out as its own custom-format condition
  resolution: string | null; // "2160p"/"1080p"/"720p" — the resolution half of `quality`
  flags: ReleaseFlag[]; // proper/repack/edition tags found in the title
  languages: string[]; // lowercased audio/subtitle language tags found in the title, e.g. ["french","multi"]
  releaseGroup: string | null; // the tag after the final hyphen, e.g. "RARBG"
  /** YYYY-MM-DD, when the title carries a full date (daily/talk-show releases are named by air
   * date instead of season/episode, e.g. "Show.Name.2024.08.25.1080p...") — null otherwise. Only
   * consulted for "daily"-type series; harmless to detect unconditionally on everything else. */
  airDate: string | null;
  /** A bare "Show Title - 145" style number, the common anime-fansub convention for long-running
   * shows with no season/episode designator at all. Only attempted when no SxxExx/full-season
   * pattern matched (so it never overrides a real season/episode detection) — see
   * releaseMatchesEpisode's `absoluteEpisodeNumber` param for how this gets used. */
  absoluteEpisode: number | null;
  /** An IMDb id embedded directly in the release title itself (some release groups/indexers tag
   * these on, e.g. "Movie.Name.2020.1080p.WEBRip.x264-GROUP[tt1234567]") — rare, but when present
   * it's an unambiguous identity signal worth preferring over a plain title/year comparison. Most
   * releases don't carry one; null in that case (see indexerClient.ts for the other, more common
   * source of an id — an indexer's own Torznab response attributes, not the title text). */
  imdbId: string | null;
  /** Free-text edition phrase (e.g. "Director's Cut", "Criterion Edition", "Remastered") — a more
   * open-ended, regex-testable superset of the fixed directorscut/extended/unrated/imax `flags`
   * above, matching Radarr's own "Edition" custom-format condition. Null when nothing matched. */
  edition: string | null;
  /** Radarr's "Quality Modifier" — scene-release vocabulary for a handful of quality tiers that
   * aren't a plain source+resolution combination. Null when none apply. */
  qualityModifier: "regional" | "screener" | "rawhd" | "brdisk" | null;
  /** Sonarr's "Release Type" — derived from the same season/episode parse above, not its own
   * pattern: a season-pack release, a multi-episode release, a single episode, or null for
   * anything that isn't an episodic release at all (movie, album, book, full-series). */
  releaseType: "single" | "multi" | "seasonPack" | null;
}

// Group 3 (hyphenated range end, e.g. "S01E01-E03"/"S01E01-03") and group 4 (a chain of bare
// "E\d+" tags with no hyphen, e.g. "S01E01E02E03") are mutually exclusive alternatives — a title
// only ever uses one multi-episode convention or the other, never both.
const SEASON_EP_RANGE = /\bS(\d{1,2})E(\d{1,3})(?:-E?(\d{1,3})|((?:E\d{1,3})+))?\b/i;
// "1x01" scene/P2P notation, the same convention libraryScan.ts's filename-based detector already
// recognizes — used as a fallback only when SxxExx doesn't match, since SxxExx is unambiguous while
// this format risks colliding with e.g. a bare resolution/codec tag if not scoped narrowly.
const SEASON_EP_X_FORMAT = /\b0*(\d{1,2})x0*(\d{1,3})\b/i;
const SEASON_ONLY = /\bS(\d{1,2})\b(?!\s*E\d)/i;
const FULL_SEASON_HINT = /\b(complete|season\s?\d{1,2}|full season)\b/i;
const YEAR = /\b(19|20)\d{2}\b/;
// Matches "2024.08.25", "2024-08-25", or "2024 08 25" — the three separators scene releases
// actually use; month/day are sanity-range-checked below since this alone can't tell a real date
// apart from three coincidentally date-shaped numbers.
const AIR_DATE = /\b((?:19|20)\d{2})[.\-\s](\d{1,2})[.\-\s](\d{1,2})\b/;
// Anime fansub convention: "[Group] Show Title - 145 [1080p]" — a bare number after " - " with
// no SxxExx designator anywhere in the title. Deliberately narrow (requires the space-hyphen-space
// separator) to avoid catching an arbitrary number elsewhere in the title.
const ABSOLUTE_EPISODE = /\s-\s0*(\d{1,4})(?=\s|\[|\(|$)/;
const IMDB_ID = /\btt\d{7,8}\b/i;
const COMMON_RESOLUTIONS = new Set([480, 576, 720, 1080, 2160]);

const RESOLUTION_2160 = /\b(2160p|4k|uhd)\b/i;
const RESOLUTION_1080 = /\b1080p\b/i;
const RESOLUTION_720 = /\b720p\b/i;
const RESOLUTION_576 = /\b576[pi]\b/i;
const RESOLUTION_480 = /\b480[pi]\b/i;

const SOURCE_REMUX = /\bremux\b/i;
const SOURCE_BLURAY = /\b(bluray|blu-ray|bdrip)\b/i;
const SOURCE_WEBDL = /\b(web-?dl|webdl)\b/i;
const SOURCE_WEBRIP = /\bwebrip\b/i;
const SOURCE_HDTV = /\bhdtv\b/i;
const SOURCE_DVD = /\bdvd(rip)?\b/i;
// Movie-only, lowest-quality theatrical-capture sources (Radarr/Whisparr's own Source vocabulary,
// AoNarr had no equivalent for any of these) — kept narrow ("ts"/"tc" alone are too short/ambiguous
// to safely match as bare words against an arbitrary title.
const SOURCE_CAM = /\b(cam|hdcam|camrip)\b/i;
const SOURCE_TELESYNC = /\b(telesync|hdts)\b/i;
const SOURCE_TELECINE = /\b(telecine|hdtc)\b/i;
const SOURCE_WORKPRINT = /\bworkprint\b/i;

const QUALITY_MODIFIER_REGIONAL = /\b(regional|r5)\b/i;
const QUALITY_MODIFIER_SCREENER = /\b(screener|scr|dvdscr|bdscr)\b/i;
const QUALITY_MODIFIER_RAWHD = /\brawhd\b/i;
const QUALITY_MODIFIER_BRDISK = /\b(brdisk|bdmv|bd25|bd50)\b/i;

// Radarr's own edition vocabulary, trimmed to the common cases — deliberately broader than (and
// overlapping with) the fixed directorscut/extended/unrated/imax flags above, since this is meant
// to be regex-tested rather than matched as a fixed enum.
const EDITION_PATTERN =
  /\b(ultimate|special|criterion|anniversary|theatrical|extended|unrated|directors?'?s?|redux|final|imax|remastered|uncut|collectors?'?s?)[\s.]?(cut|edition|version)?\b/i;

// "real" is deliberately not included here — unlike proper/repack/imax/etc, it's a common English
// word (collides constantly with ordinary titles), so it's not safe to detect with a bare regex
// the way real Sonarr/Radarr can (they check it against a controlled release-name grammar, not a
// simple whole-word scan over an arbitrary title string).
const FLAG_PATTERNS: [ReleaseFlag, RegExp][] = [
  ["proper", /\bproper\b/i],
  ["repack", /\brepack\b/i],
  ["extended", /\bextended\b/i],
  ["unrated", /\bunrated\b/i],
  ["directorscut", /\bdirectors?[\s.]?cut\b/i],
  ["imax", /\bimax\b/i],
];

// Common language/audio tags seen in scene/P2P release titles. Matched as whole words,
// case-insensitive; the map value is the canonical lowercase tag stored on the parsed result.
const LANGUAGE_TAGS: Record<string, string> = {
  multi: "multi",
  vostfr: "vostfr",
  vff: "vff",
  vfq: "vfq",
  truefrench: "french",
  french: "french",
  german: "german",
  italian: "italian",
  spanish: "spanish",
  dutch: "dutch",
  russian: "russian",
  korean: "korean",
  japanese: "japanese",
  danish: "danish",
  swedish: "swedish",
  norwegian: "norwegian",
  polish: "polish",
  portuguese: "portuguese",
  english: "english",
};
const LANGUAGE_PATTERN = new RegExp(`\\b(${Object.keys(LANGUAGE_TAGS).join("|")})\\b`, "gi");

// Release group convention: a trailing "-GROUPNAME" with no further dots/spaces/hyphens after it.
const RELEASE_GROUP = /-([A-Za-z0-9]+)$/;

function detectLanguages(title: string): string[] {
  const found = new Set<string>();
  for (const match of title.matchAll(LANGUAGE_PATTERN)) {
    found.add(LANGUAGE_TAGS[match[1].toLowerCase()]);
  }
  return Array.from(found);
}

function detectReleaseGroup(title: string): string | null {
  const match = title.trim().match(RELEASE_GROUP);
  return match ? match[1] : null;
}

function detectResolution(title: string): string | null {
  if (RESOLUTION_2160.test(title)) return "2160p";
  if (RESOLUTION_1080.test(title)) return "1080p";
  if (RESOLUTION_720.test(title)) return "720p";
  if (RESOLUTION_576.test(title)) return "576p";
  if (RESOLUTION_480.test(title)) return "480p";
  return null;
}

function detectReleaseType(isFullSeason: boolean, episodeNumbers: number[] | null): ParsedRelease["releaseType"] {
  if (isFullSeason) return "seasonPack";
  if (episodeNumbers && episodeNumbers.length > 1) return "multi";
  if (episodeNumbers && episodeNumbers.length === 1) return "single";
  return null;
}

function detectSource(title: string): string | null {
  if (SOURCE_REMUX.test(title)) return "Remux";
  if (SOURCE_BLURAY.test(title)) return "Bluray";
  if (SOURCE_WEBDL.test(title)) return "WEBDL";
  if (SOURCE_WEBRIP.test(title)) return "WEBRip";
  if (SOURCE_HDTV.test(title)) return "HDTV";
  if (SOURCE_DVD.test(title)) return "DVD";
  if (SOURCE_CAM.test(title)) return "Cam";
  if (SOURCE_TELESYNC.test(title)) return "Telesync";
  if (SOURCE_TELECINE.test(title)) return "Telecine";
  if (SOURCE_WORKPRINT.test(title)) return "Workprint";
  return null;
}

function detectQualityModifier(title: string): ParsedRelease["qualityModifier"] {
  if (QUALITY_MODIFIER_REGIONAL.test(title)) return "regional";
  if (QUALITY_MODIFIER_SCREENER.test(title)) return "screener";
  if (QUALITY_MODIFIER_RAWHD.test(title)) return "rawhd";
  if (QUALITY_MODIFIER_BRDISK.test(title)) return "brdisk";
  return null;
}

function detectEdition(title: string): string | null {
  const match = title.match(EDITION_PATTERN);
  return match ? match[0].replace(/\./g, " ").trim() : null;
}

function detectFlags(title: string): ReleaseFlag[] {
  return FLAG_PATTERNS.filter(([, pattern]) => pattern.test(title)).map(([flag]) => flag);
}

function detectQuality(title: string): QualityName | "Unknown" {
  const suffix = detectResolution(title);
  const source = detectSource(title);
  if (!suffix) {
    if (source === "DVD") return "DVD";
    return "Unknown";
  }

  if (source === "Remux") return `Remux-${suffix}` as QualityName;
  if (source === "Bluray") return `Bluray-${suffix}` as QualityName;
  if (source === "WEBDL") return `WEBDL-${suffix}` as QualityName;
  if (source === "WEBRip") return `WEBRip-${suffix}` as QualityName;
  if (source === "HDTV") return `HDTV-${suffix}` as QualityName;

  // Resolution present but no recognizable source tag: assume WEB-DL, the most common case.
  return `WEBDL-${suffix}` as QualityName;
}

export function parseReleaseTitle(title: string): ParsedRelease {
  let seasonNumber: number | null = null;
  let episodeNumbers: number[] | null = null;
  let isFullSeason = false;

  const rangeMatch = title.match(SEASON_EP_RANGE);
  if (rangeMatch) {
    seasonNumber = Number(rangeMatch[1]);
    const start = Number(rangeMatch[2]);
    if (rangeMatch[4]) {
      // Chained "E01E02E03" tags — an explicit list, not necessarily contiguous.
      episodeNumbers = [start];
      for (const m of rangeMatch[4].matchAll(/E(\d{1,3})/gi)) episodeNumbers.push(Number(m[1]));
    } else {
      // Single episode, or a hyphenated "-E03"/"-03" range end — inclusive.
      const end = rangeMatch[3] ? Number(rangeMatch[3]) : start;
      episodeNumbers = [];
      for (let e = start; e <= end; e++) episodeNumbers.push(e);
    }
  } else {
    const xMatch = title.match(SEASON_EP_X_FORMAT);
    if (xMatch) {
      seasonNumber = Number(xMatch[1]);
      episodeNumbers = [Number(xMatch[2])];
    } else {
      const seasonMatch = title.match(SEASON_ONLY);
      if (seasonMatch) {
        seasonNumber = Number(seasonMatch[1]);
        isFullSeason = true;
      } else {
        const fullSeasonMatch = title.match(FULL_SEASON_HINT);
        if (fullSeasonMatch) {
          isFullSeason = true;
          // Only the "season <N>" alternative actually names a season ("complete"/"full season"
          // don't) — extract it so a title like "Show Name Season 3 ..." (space-separated, no
          // "S03" abbreviation) can still match a request for that specific season.
          const digits = fullSeasonMatch[1].match(/(\d{1,2})/);
          if (digits) seasonNumber = Number(digits[1]);
        }
      }
    }
  }

  const yearMatch = title.match(YEAR);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  let airDate: string | null = null;
  const dateMatch = title.match(AIR_DATE);
  if (dateMatch) {
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      airDate = `${dateMatch[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  let absoluteEpisode: number | null = null;
  if (seasonNumber === null && episodeNumbers === null && !isFullSeason) {
    const absMatch = title.match(ABSOLUTE_EPISODE);
    if (absMatch) {
      const n = Number(absMatch[1]);
      if (!COMMON_RESOLUTIONS.has(n)) absoluteEpisode = n;
    }
  }

  const imdbMatch = title.match(IMDB_ID);

  return {
    seasonNumber,
    episodeNumbers,
    isFullSeason,
    year,
    quality: detectQuality(title),
    source: detectSource(title),
    resolution: detectResolution(title),
    flags: detectFlags(title),
    languages: detectLanguages(title),
    releaseGroup: detectReleaseGroup(title),
    airDate,
    absoluteEpisode,
    imdbId: imdbMatch ? imdbMatch[0].toLowerCase() : null,
    edition: detectEdition(title),
    qualityModifier: detectQualityModifier(title),
    releaseType: detectReleaseType(isFullSeason, episodeNumbers),
  };
}

/** True if a parsed release plausibly satisfies a specific wanted episode. */
function matchesSeasonEpisode(parsed: ParsedRelease, seasonNumber: number, episodeNumber: number): boolean {
  if (parsed.seasonNumber !== null && parsed.seasonNumber !== seasonNumber) return false;
  if (parsed.episodeNumbers) return parsed.episodeNumbers.includes(episodeNumber);
  if (parsed.isFullSeason) return parsed.seasonNumber === seasonNumber;
  return false;
}

/**
 * `sceneSeasonNumber`/`sceneEpisodeNumber` (from TheXEM, see services/sceneNumbering.ts) are an
 * OR alternative, not a replacement — a release matches if it fits either the metadata provider's
 * own numbering or the scene group's numbering, since not every release for a scene-mapped show
 * necessarily uses the scene numbering (some groups number correctly anyway).
 */
export function releaseMatchesEpisode(
  parsed: ParsedRelease,
  seasonNumber: number,
  episodeNumber: number,
  sceneSeasonNumber?: number | null,
  sceneEpisodeNumber?: number | null,
  absoluteEpisodeNumber?: number | null
): boolean {
  if (matchesSeasonEpisode(parsed, seasonNumber, episodeNumber)) return true;
  if (sceneSeasonNumber != null && sceneEpisodeNumber != null) {
    if (matchesSeasonEpisode(parsed, sceneSeasonNumber, sceneEpisodeNumber)) return true;
  }
  // Only ever consulted as a last resort — a release that already parsed a real SxxExx (even a
  // wrong one) never falls through to this, since a bare-number match is far weaker evidence.
  if (absoluteEpisodeNumber != null && parsed.absoluteEpisode === absoluteEpisodeNumber) return true;
  return false;
}

/** Same idea as releaseMatchesEpisode, for "daily"-type series (talk shows, news) whose releases
 * are named by air date instead of season/episode — see AIR_DATE above. */
export function releaseMatchesAirDate(parsed: ParsedRelease, airDate: string): boolean {
  return parsed.airDate === airDate;
}
