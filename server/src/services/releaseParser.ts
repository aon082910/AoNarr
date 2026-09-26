import type { QualityName } from "./quality.js";

export type ReleaseFlag = "proper" | "repack" | "extended" | "unrated" | "directorscut" | "imax";

export interface ParsedRelease {
  seasonNumber: number | null;
  episodeNumbers: number[] | null; // null when not an episode release (movie, full-season, album, book); [] for a "12.5" special
  isFullSeason: boolean;
  year: number | null;
  quality: QualityName | "Unknown";
  source: string | null; // "Remux"/"Bluray"/"WEBDL"/"WEBRip"/"HDTV"/"DVD" — the source half of `quality`, split out as its own custom-format condition
  resolution: string | null; // "2160p"/"1080p"/"720p" — the resolution half of `quality`
  flags: ReleaseFlag[]; // proper/repack/edition tags found in the title
  languages: string[]; // lowercased audio/subtitle language tags found in the title, e.g. ["french","multi"]
  releaseGroup: string | null; // the tag after the final hyphen, e.g. "RARBG", or a leading fansub "[Group]"
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
  /** The episodes a ranged fansub pack covers ("S2 - 13-24", "S2 - 01 ~ 12"), inclusive. Such a
   * release is still `isFullSeason` (it imports as a pack), but only matches episodes inside the
   * range. Null or absent for every other release, including a pack of the whole season. */
  episodeRange?: [number, number] | null;
}

// Group 3 (hyphenated range end, e.g. "S01E01-E03"/"S01E01-03") and group 4 (a chain of bare
// "E\d+" tags with no hyphen, e.g. "S01E01E02E03") are mutually exclusive alternatives — a title
// only ever uses one multi-episode convention or the other, never both.
// A single "." / "_" / space may sit between the season and episode tags ("Show.S01.E05").
const SEASON_EP_RANGE = /\bS(\d{1,2})[._ ]?E(\d{1,3})(?:-E?(\d{1,3})|((?:E\d{1,3})+))?\b/i;
// "1x01" scene/P2P notation, the same convention libraryScan.ts's filename-based detector already
// recognizes — used as a fallback only when SxxExx doesn't match, since SxxExx is unambiguous while
// this format risks colliding with e.g. a bare resolution/codec tag if not scoped narrowly.
const SEASON_EP_X_FORMAT = /\b0*(\d{1,2})x0*(\d{1,3})\b/i;
// Fansub season numbering: "[SubsPlease] Show S2 - 05 (1080p)", "Show Season 2 - 05 [1080p]". Without
// this the bare "S2"/"Season 2" reads as a season pack, so episode 5 would satisfy every episode of
// the season.
// Neither a "~ NN" range end (group 4) nor an unspaced "-NN" one (group 5) ever starts an episode
// title, so anything may follow them. A spaced " - NN" second number (group 6) often does
// ("S2 - 05 - 7 Deadly Sins"), so it is a range end only when a bracket, a "+ OVA" extra, a
// resolution or the end of the title follows (optionally after "END"). A decimal ("S2 - 12.5") is
// a recap or special between two regular episodes.
const SEASON_DASH_EPISODE =
  /\bS(?:eason\s*)?(\d{1,2})\s+-\s+0*(\d{1,3})(\.\d)?(?:v\d)?(?=[\s[(~-]|$)(?:\s*~\s*0*(\d{1,3})(?:v\d)?(?![\da-z])|-0*(\d{1,3})(?:v\d)?(?![\da-z])|\s*-\s*0*(\d{1,3})(?:v\d)?(?!\d)(?=\s*(?:end\s*)?(?:[[(+]|\d{3,4}[pi]\b|$)))?/i;
// "The Office Season 1 - 9 Complete" and "Friends Season 1 - 10 Complete" are multi-season
// collections, not episode 9 or 10: a spelled-out season followed by an unpadded single digit, or
// any match followed by a collection word, is left to the season-pack rules below.
const MULTI_SEASON_TAIL = /^[\s._\-[(]*(?:complete|collection|box\s*set|series|seasons?)\b/i;
function seasonDashEpisode(title: string): RegExpMatchArray | null {
  const m = title.match(SEASON_DASH_EPISODE);
  if (!m || m.index === undefined) return null;
  if (MULTI_SEASON_TAIL.test(title.slice(m.index + m[0].length))) return null;
  const spelledOut = /^season/i.test(m[0]);
  const unpaddedSingleDigit = /-\s+[1-9](?!\d)/.test(m[0]) && !m[4] && !m[5] && !m[6];
  if (spelledOut && unpaddedSingleDigit) return null;
  return m;
}
// A dash range of this many episodes or more ("S2 - 01-12") is a batch, not a multi-episode release.
const DASH_RANGE_BATCH_SIZE = 4;
const SEASON_ONLY = /\bS(\d{1,2})\b(?![\s._-]*E\d)/i;
const FULL_SEASON_HINT = /\b(complete|season\s?\d{1,2}|full season)\b/i;
// Fansub batch tag; bracketed only, since "Batch" is also an ordinary title word.
const BATCH_TAG = /[[(]\s*batch\s*[\])]/i;
const YEAR = /\b(19|20)\d{2}\b/;
// Matches "2024.08.25", "2024-08-25", or "2024 08 25" — the three separators scene releases
// actually use; month/day are sanity-range-checked below since this alone can't tell a real date
// apart from three coincidentally date-shaped numbers.
const AIR_DATE = /\b((?:19|20)\d{2})[.\-\s](\d{1,2})[.\-\s](\d{1,2})\b/;
// Anime fansub convention: "[Group] Show Title - 145 [1080p]" — a bare number after " - " with
// no SxxExx designator anywhere in the title. Deliberately narrow (requires the space-hyphen-space
// separator) to avoid catching an arbitrary number elsewhere in the title.
// The lookahead alone keeps a "1080p" token out, so a genuine episode 480/720/1080 still parses.
const ABSOLUTE_EPISODE = /\s-\s0*(\d{1,4})(?=\s|\[|\(|$)/;
// A season-less fansub batch ("[Group] Show - 01 ~ 12 [1080p]"): the same range conventions as
// SEASON_DASH_EPISODE, with an absolute number's four digits.
const ABSOLUTE_RANGE =
  /\s-\s0*(\d{1,4})(?:v\d)?(?:\s*~\s*0*(\d{1,4})(?![\da-z])|-0*(\d{1,4})(?:v\d)?(?![\da-z])|\s+-\s+0*(\d{1,4})(?:v\d)?(?!\d)(?=\s*(?:end\s*)?(?:[[(+]|\d{3,4}[pi]\b|$)))/i;
const IMDB_ID = /\btt\d{7,8}\b/i;

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
// Sources that are SD when no resolution is given: TV/satellite captures and BD/BR rips. Bare "WEB"
// only counts followed by a codec ("Show.S01E01.WEB.h264-GRP"), since it's also a title word.
const SD_SOURCE = /\b(sdtv|pdtv|tvrip|dsr|dsrip|satrip|dvb|dvbrip|bdrip|brrip)\b|\bweb[ ._-]+(?:[hx][ .]?26[45]|hevc|avc|xvid|divx)\b/i;
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
// An untagged title ending in a hyphenated source token ("...WEB-DL", "...Blu-ray") has no group.
const TRAILING_SOURCE_TOKEN = /(?:web|blu|bd|dvd|hd)-(?:dl|ray|rip)$/i;
// Nor does one ending in an episode range or a hyphenated resolution ("S01E01-02", "S2 - 05-06",
// "S2 - 05-1080p"): the tail is the range end or the resolution.
const TRAILING_RANGE_END = /\d-(?:E?\d{1,3}(?:v\d)?|\d{3,4}[pi])$/i;
// Fansub convention: the group leads the title in brackets ("[SubsPlease] Show - 05 (1080p)").
const LEADING_BRACKET_GROUP = /^\[([^\]]+)\]/;
// The CRC32 a fansub release ends with ("... (1080p) [ABCD1234]").
const FANSUB_HASH = /\[[0-9a-f]{8}\]$/i;
// Numbers, years, format/quality/source, language, content-kind and platform words that also lead
// titles ("[FLAC] Artist - Album", "[MP3 320]", "[VOSTFR] Show - 05") — none of them names a group.
const NON_GROUP_WORD =
  /^(?:\d+|\d{3,4}[pi]|4k|uhd|hd|sd|hdr\d*|dv|sdr|\d{1,2}bit|\d+k(?:bps|hz)?|kbps|khz|v[02]|flac|mp3|aac|alac|ogg|opus|wav|ape|dsd|m4a|m4b|lossless|hi|res|hires|epub|pdf|mobi|azw\d?|cb[rz7]|djvu|web|webdl|webrip|dl|rip|blu|ray|bluray|bd|bdrip|brrip|remux|hdtv|dvd|dvd[59]|dvdrip|[hx]26[45]|hevc|avc|xvid|divx|eng|jpn|jap|ger|fre|fra|ita|spa|rus|kor|chi|chs|cht|dual|audio|multiple|subs?|subbed|subtitles?|dub|dubbed|raws?|ost|cd|vinyl|audiobook|unabridged|abridged|retail|discography|nsw|ps[1-5p]|psv|nds|3ds|gba|gbc|wii|wiiu|n64|snes|xbox|x360)$/i;

// Music and book formats. A title tagged with one ("[Artist] Album - 01 [FLAC]", "[Author] Series - 03
// (epub)") and carrying no video marker leads with an artist or author, not a fansub group. AAC and
// Opus are common fansub audio too, which is why a video marker overrides the format tag.
const AUDIO_BOOK_FORMAT_WORD =
  /^(?:flac|mp3|aac|alac|ogg|opus|wav|ape|dsd|m4a|m4b|lossless|\d{1,2}bit|\d*khz|\d*kbps|epub|pdf|mobi|azw\d?|cb[rz7]|djvu|audiobook|unabridged|abridged|discography)$/i;
const VIDEO_MARKER = /\b(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|4k|[hx]\.?26[45]|hevc|avc|xvid|divx|bd|bdrip|bluray|hi10p?|10bit|web(?:-?dl|-?rip)?)\b/i;
const BRACKET_TAG = /[[(]([^\])]*)[\])]/g;
const ABSOLUTE_EPISODE_ALL = new RegExp(ABSOLUTE_EPISODE.source, "g");
const YEAR_SHAPED = /^(?:19|20)\d{2}$/;

function tagWords(tag: string): string[] {
  return tag.split(/[\s_,+\-/]+/).filter(Boolean);
}

function isNonGroupTag(tag: string): boolean {
  const words = tagWords(tag);
  return words.length > 0 && words.every((w) => NON_GROUP_WORD.test(w) || Object.hasOwn(LANGUAGE_TAGS, w.toLowerCase()));
}

function hasAudioOrBookTag(text: string): boolean {
  if (VIDEO_MARKER.test(text)) return false;
  for (const [, tag] of text.matchAll(BRACKET_TAG)) {
    if (isNonGroupTag(tag) && tagWords(tag).some((w) => AUDIO_BOOK_FORMAT_WORD.test(w))) return true;
  }
  return false;
}

function detectLanguages(title: string): string[] {
  const found = new Set<string>();
  for (const match of title.matchAll(LANGUAGE_PATTERN)) {
    found.add(LANGUAGE_TAGS[match[1].toLowerCase()]);
  }
  return Array.from(found);
}

function detectReleaseGroup(title: string): string | null {
  const trimmed = title.trim();
  const match = trimmed.match(RELEASE_GROUP);
  // A trailing resolution ("Title-1080p", "1080p-2160p") names a quality, never a group.
  if (match && !TRAILING_SOURCE_TOKEN.test(trimmed) && !TRAILING_RANGE_END.test(trimmed) && !/^(?:\d{3,4}[pi]|4k|8k)$/i.test(match[1])) return match[1];
  // Only a fansub-shaped title leads with its group; music, book and tracker titles lead with a
  // format, language or site tag ("[FLAC] Artist - Album", "[www.site.org] Movie"). A year after
  // " - " ("Compilation - 2020") is a release date, not an episode number.
  const episodeNumbered = [...trimmed.matchAll(ABSOLUTE_EPISODE_ALL)].some((m) => !YEAR_SHAPED.test(m[1]));
  // Music and book titles never carry a season-numbered episode or a CRC32.
  // A season-less episode range ("[Group] Show - 01-04 [1080p]") is fansub numbering too.
  const fansubOnly = !!seasonDashEpisode(trimmed) || FANSUB_HASH.test(trimmed) || isAbsoluteBatch(trimmed);
  if (!episodeNumbered && !fansubOnly) return null;
  const leadingMatch = trimmed.match(LEADING_BRACKET_GROUP);
  if (!leadingMatch) return null;
  const leading = leadingMatch[1].trim();
  if (!leading || leading.includes(".") || isNonGroupTag(leading)) return null;
  if (!fansubOnly && hasAudioOrBookTag(trimmed.slice(leadingMatch[0].length))) return null;
  return leading;
}

function isAbsoluteBatch(title: string): boolean {
  const match = title.match(ABSOLUTE_RANGE);
  if (!match) return false;
  const end = match[2] ?? match[3] ?? match[4];
  // "Discography - 1999-2005" spans years, not episodes.
  if (YEAR_SHAPED.test(end)) return false;
  return !!match[2] || Number(end) - Number(match[1]) + 1 >= DASH_RANGE_BATCH_SIZE;
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
  // Only the resolutions the quality ladder actually has tiers for — 480p/576p are exposed on
  // `resolution` for custom-format conditions, but "WEBDL-480p" isn't a quality: a 576i DVD rip
  // grades as plain "DVD", and any other sub-720p video release as the "SD" tier.
  const resolution = detectResolution(title);
  const suffix = resolution === "2160p" || resolution === "1080p" || resolution === "720p" ? resolution : null;
  const source = detectSource(title);
  // A theatrical capture is never a real WEB/Bluray tier, whatever resolution it claims — falling
  // through to the WEBDL default below graded "Movie.1080p.HDCAM" as WEBDL-1080p, which any
  // profile allowing that tier would happily auto-grab.
  if (source === "Cam" || source === "Telesync" || source === "Telecine" || source === "Workprint") return "Unknown";
  if (!suffix) {
    if (source === "DVD") return "DVD";
    // Only a sub-HD encode is the ladder's "SD" tier: resolution-less scene naming
    // ("Show.S01E01.HDTV.x264-LOL"), a 480p/576p encode, or an SD capture/rip. A resolution-less
    // remux, disc image or plain "BluRay" ("Movie.COMPLETE.BLURAY") is a full-size HD release —
    // graded SD, any profile allowing SD would grab it, and a 720p release would "upgrade" it.
    if (source === "Remux" || detectQualityModifier(title) === "brdisk") return "Unknown";
    if (resolution || source === "HDTV" || source === "WEBDL" || source === "WEBRip" || SD_SOURCE.test(title)) return "SD";
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
  let episodeRange: [number, number] | null = null;

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
    const dashMatch = seasonDashEpisode(title);
    const xMatch = dashMatch ? null : title.match(SEASON_EP_X_FORMAT);
    if (dashMatch) {
      seasonNumber = Number(dashMatch[1]);
      const start = Number(dashMatch[2]);
      const tildeEnd = dashMatch[4];
      const rangeEnd = tildeEnd ?? dashMatch[5] ?? dashMatch[6];
      const end = rangeEnd ? Number(rangeEnd) : start;
      if (BATCH_TAG.test(title) || tildeEnd || (rangeEnd && end - start + 1 >= DASH_RANGE_BATCH_SIZE)) {
        // "~", a [Batch] tag and a long range are the fansub batch conventions; a short dash range
        // is a multi-episode release, the same as "S02E05-E06".
        isFullSeason = true;
        if (rangeEnd && end >= start) episodeRange = [start, end];
      } else if (dashMatch[3]) {
        // A special numbered between two episodes is neither of them, nor a pack.
        episodeNumbers = [];
      } else {
        episodeNumbers = [];
        for (let e = start; e <= Math.max(start, end); e++) episodeNumbers.push(e);
      }
    } else if (xMatch) {
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
        } else if (BATCH_TAG.test(title) || isAbsoluteBatch(title)) {
          // With no season, the pack matches no specific episode, which beats matching its first.
          isFullSeason = true;
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
    if (absMatch) absoluteEpisode = Number(absMatch[1]);
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
    episodeRange,
  };
}

/** True if a parsed release plausibly satisfies a specific wanted episode. */
function matchesSeasonEpisode(parsed: ParsedRelease, seasonNumber: number, episodeNumber: number): boolean {
  if (parsed.seasonNumber !== null && parsed.seasonNumber !== seasonNumber) return false;
  if (parsed.episodeNumbers) return parsed.episodeNumbers.includes(episodeNumber);
  if (parsed.isFullSeason) {
    if (parsed.seasonNumber !== seasonNumber) return false;
    const range = parsed.episodeRange;
    return !range || (episodeNumber >= range[0] && episodeNumber <= range[1]);
  }
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
