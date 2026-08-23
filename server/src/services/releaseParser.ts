import type { QualityName } from "./quality.js";

export interface ParsedRelease {
  seasonNumber: number | null;
  episodeNumbers: number[] | null; // null when not an episode release (movie, full-season, album, book)
  isFullSeason: boolean;
  year: number | null;
  quality: QualityName | "Unknown";
  languages: string[]; // lowercased audio/subtitle language tags found in the title, e.g. ["french","multi"]
  releaseGroup: string | null; // the tag after the final hyphen, e.g. "RARBG"
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

const RESOLUTION_2160 = /\b(2160p|4k|uhd)\b/i;
const RESOLUTION_1080 = /\b1080p\b/i;
const RESOLUTION_720 = /\b720p\b/i;

const SOURCE_REMUX = /\bremux\b/i;
const SOURCE_BLURAY = /\b(bluray|blu-ray|bdrip)\b/i;
const SOURCE_WEBDL = /\b(web-?dl|webdl)\b/i;
const SOURCE_WEBRIP = /\bwebrip\b/i;
const SOURCE_HDTV = /\bhdtv\b/i;
const SOURCE_DVD = /\bdvd(rip)?\b/i;

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

function detectQuality(title: string): QualityName | "Unknown" {
  const is2160 = RESOLUTION_2160.test(title);
  const is1080 = RESOLUTION_1080.test(title);
  const is720 = RESOLUTION_720.test(title);

  const isRemux = SOURCE_REMUX.test(title);
  const isBluray = SOURCE_BLURAY.test(title);
  const isWebdl = SOURCE_WEBDL.test(title);
  const isWebrip = SOURCE_WEBRIP.test(title);
  const isHdtv = SOURCE_HDTV.test(title);
  const isDvd = SOURCE_DVD.test(title);

  const suffix = is2160 ? "2160p" : is1080 ? "1080p" : is720 ? "720p" : null;
  if (!suffix) {
    if (isDvd) return "DVD";
    return "Unknown";
  }

  if (isRemux) return `Remux-${suffix}` as QualityName;
  if (isBluray) return `Bluray-${suffix}` as QualityName;
  if (isWebdl) return `WEBDL-${suffix}` as QualityName;
  if (isWebrip) return `WEBRip-${suffix}` as QualityName;
  if (isHdtv) return `HDTV-${suffix}` as QualityName;

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
      } else if (FULL_SEASON_HINT.test(title)) {
        isFullSeason = true;
      }
    }
  }

  const yearMatch = title.match(YEAR);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  return {
    seasonNumber,
    episodeNumbers,
    isFullSeason,
    year,
    quality: detectQuality(title),
    languages: detectLanguages(title),
    releaseGroup: detectReleaseGroup(title),
  };
}

/** True if a parsed release plausibly satisfies a specific wanted episode. */
export function releaseMatchesEpisode(
  parsed: ParsedRelease,
  seasonNumber: number,
  episodeNumber: number
): boolean {
  if (parsed.seasonNumber !== null && parsed.seasonNumber !== seasonNumber) return false;
  if (parsed.episodeNumbers) return parsed.episodeNumbers.includes(episodeNumber);
  if (parsed.isFullSeason) return parsed.seasonNumber === seasonNumber;
  return false;
}
