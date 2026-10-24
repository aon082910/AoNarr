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
  /** The series/movie/album title the release names, isolated the way Sonarr/Radarr's parsers do:
   * what stands between a leading "[Group]"/"[tag]" and the first season/episode/absolute-number/
   * air-date marker, else the title year (`titleYear`), else the first quality/source/codec token,
   * with dots and underscores read as spaces ("Blade.Runner.2049.2017.1080p" -> "Blade Runner
   * 2049", "[SubsPlease] Jujutsu Kaisen - 25 (1080p)" -> "Jujutsu Kaisen"). "" when nothing is left
   * (a hashed name, a bare "S01E01"). The identity gate (releaseIdentity.ts) compares this against
   * the target's title; nothing else should guess a title from the raw release name. */
  title: string;
  /** The year that belongs to the title, by Radarr's rule: the first (19|20)xx token with at least
   * one title token before it, not immediately followed by another year token ("Blade.Runner.2049.
   * 2017" -> 2017, "2001.A.Space.Odyssey.1968" -> 1968, "1917.2019" -> 2019), and standing before
   * the episode marker or any quality token ("Show.S01E01.2019" -> null, the year names the
   * encode's date or an episode, not the show). A year inside an air date ("The.Daily.Show.2024.
   * 08.25") never counts. `year` keeps the older first-match behaviour for the custom-format "year"
   * condition and the ranking tiebreaker; identity decisions use this field. */
  titleYear: number | null;
  /** The seasons a multi-season pack spans, inclusive ("S01-S05", "Seasons 1-5"); `seasonNumber`
   * is the first. Null or absent for every other release. Recognised only: a pack is still taken
   * for its first season alone, because grabbing and importing one pack for several seasons is
   * bookkeeping the queue does not do yet. */
  seasonRange?: [number, number] | null;
  /** The whole name is an obfuscated token (a 32-character hash, Sonarr's other hashed shapes)
   * with no title to compare. For release and queue titles; a file inside a folder that names its
   * release is often called exactly this, so file names are not to be judged by it. */
  rejected: boolean;
}

// Group 3 (hyphenated range end, e.g. "S01E01-E03"/"S01E01-03"), groups 4-5 (a repeated season tag,
// "S01E01-S01E02") and group 6 (a chain of "E\d+" tags with no hyphen, e.g. "S01E01E02E03" or
// "S01E01.E02") are mutually exclusive alternatives — a title only ever uses one multi-episode
// convention or the other, never both.
// A single "." / "_" / space may sit between the season and episode tags ("Show.S01.E05").
const SEASON_EP_RANGE = /\bS(\d{1,2})[._ ]?E(\d{1,3})(?:-E?(\d{1,3})|-S(\d{1,2})[._ ]?E(\d{1,3})|((?:[._ ]?E\d{1,3})+))?\b/i;
// A range this long is a typo or a different number, not a multi-episode release.
const MAX_EPISODE_RANGE = 100;
// "1x01" scene/P2P notation, the same convention libraryScan.ts's filename-based detector already
// recognizes — used as a fallback only when SxxExx doesn't match, since SxxExx is unambiguous while
// this format risks colliding with e.g. a bare resolution/codec tag if not scoped narrowly. A second
// episode number joins it as "1x01-02" or "1x01x02".
const SEASON_EP_X_FORMAT = /\b0*(\d{1,2})x0*(\d{1,3})(?:[-x]0*(\d{1,3}))?\b/i;
// "Show.Name.Season.2.Episode.5": the spelled-out form.
const SEASON_WORD_EPISODE = /\bSeason[ ._]?0*(\d{1,2})[ ._-]*(?:Episode|Ep)[ ._]?0*(\d{1,3})\b/i;
// A multi-season pack: "S01-S05", "Seasons 1-5", "Season 1 to 9".
const SEASON_RANGE =
  /\b(?:S(\d{1,2})[ ._]*-[ ._]*S(\d{1,2})|Seasons?[ ._]?(\d{1,2})[ ._]*(?:-|to|thru)[ ._]*(?:Season[ ._]?)?(\d{1,2}))\b(?![ ._]*-?[ ._]*E\d)/i;
// "2nd Season - 05" is "Season 2 - 05": same shape, written the way AniList titles it.
const ORDINAL_SEASON = /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi;
// Sonarr's list of hashed release names, which carry nothing to compare against a title.
const HASHED_NAMES = [/^[0-9a-zA-Z]{32}/, /^[a-z0-9]{24}$/, /^[A-Z]{11}\d{3}$/, /^[a-z]{12}\d{3}$/, /^Backup_\d{5,}S\d{2}-\d{2}$/];
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
  // "2nd Season" reads as "Season 2", padded so every index stays where it was.
  const read = title.replace(ORDINAL_SEASON, (whole, n: string) => `Season ${Number(n)}`.padEnd(whole.length));
  const m = read.match(SEASON_DASH_EPISODE);
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
const FULL_SEASON_HINT = /\b(complete|seasons?[\s._]?\d{1,2}|full season)\b/i;
// "Movie.2010.COMPLETE.BLURAY": a disc image of a film, not a season pack.
const DISC_TAG_AFTER = /^[ ._-]+(?:blu-?ray|bd|bdrip|remux|dvd[59r]?|uhd)\b/i;
const YEAR_BEFORE = /(?:19|20)\d{2}[ ._-]+$/;
// Fansub batch tag; bracketed only, since "Batch" is also an ordinary title word.
const BATCH_TAG = /[[(]\s*batch\s*[\])]/i;
const YEAR = /\b(19|20)\d{2}\b/;
// Matches "2024.08.25", "2024-08-25", or "2024 08 25" — the three separators scene releases
// actually use; month/day are sanity-range-checked below since this alone can't tell a real date
// apart from three coincidentally date-shaped numbers.
const AIR_DATE = /\b((?:19|20)\d{2})[.\-\s](\d{1,2})[.\-\s](\d{1,2})\b/;
// The same date with the year last ("08.25.2024", "25.08.2024"); see parseReleaseTitle for how the
// first two numbers are read.
const AIR_DATE_YEAR_LAST = /\b(\d{1,2})[.\-\s](\d{1,2})[.\-\s]((?:19|20)\d{2})\b/;
// Anime fansub convention: "[Group] Show Title - 145 [1080p]" — a bare number after " - " with
// no SxxExx designator anywhere in the title. Deliberately narrow (requires the space-hyphen-space
// separator) to avoid catching an arbitrary number elsewhere in the title.
// The lookahead alone keeps a "1080p" token out, so a genuine episode 480/720/1080 still parses.
const ABSOLUTE_EPISODE = /\s-\s0*(\d{1,4})(?:v\d)?(?=\s|\[|\(|$)/;
// A season-less fansub batch ("[Group] Show - 01 ~ 12 [1080p]"): the same range conventions as
// SEASON_DASH_EPISODE, with an absolute number's four digits.
const ABSOLUTE_RANGE =
  /\s-\s0*(\d{1,4})(?:v\d)?(?:\s*~\s*0*(\d{1,4})(?![\da-z])|-0*(\d{1,4})(?:v\d)?(?![\da-z])|\s+-\s+0*(\d{1,4})(?:v\d)?(?!\d)(?=\s*(?:end\s*)?(?:[[(+]|\d{3,4}[pi]\b|$)))/i;
const IMDB_ID = /\btt\d{7,8}\b/i;

// Title isolation (see ParsedRelease.title). A run of leading bracketed tags: the fansub group, a
// tracker's "[www.site.org]", a leading "[1080p]"/"(FLAC)" format tag.
const LEADING_TAGS = /^(?:\s*[[(][^\])]*[\])])+\s*/;
// An unbracketed tracker prefix ("www.1TamilMV.xyz - Movie Name (2020)"). "www." is required, as in
// Radarr's WebsitePrefixRegex, so a dotted title before " - " ("Dr.Stone - 05") is not read as a site.
const LEADING_SITE = /^www\.[\w-]+(?:\.[a-z]{2,})+\s*[-–]?\s*/i;
// The first quality/source/codec/pack word after the title ends it. Bare "cam" and "web" are left
// out (they are ordinary title words: "Cam", "Charlotte's Web"); "web" counts only as part of
// WEB-DL/WEBRip or when a codec follows it, the same way SD_SOURCE reads it. "complete" alone is a
// title word ("Complete Unknown"); it ends a title only with a pack word.
const TITLE_END_MARKER =
  /\b(?:\d{3,4}[pi]|4k|uhd|bluray|blu-ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|web[ ._-]+(?:[hx][ .]?26[45]|hevc|avc|xvid|divx)|hdtv|pdtv|sdtv|dvdrip|dvd[59]?|hdrip|hdcam|camrip|telesync|hdts|telecine|hdtc|workprint|[hx][ .]?26[45]|hevc|avc|av1|xvid|divx|proper|repack|complete[ ._-]+(?:series|seasons?|collection|box[ ._-]?set|pack|edition)|seasons?[ ._-]?\d{1,2}|hi10p?|10bit)\b/gi;
const YEAR_ALL = /\b(19|20)\d{2}\b/g;
// Another year right after this one ("1984.2024", "Blade Runner 2049 (2017)"): this one is part of
// the title (Radarr's `(?!...\W(19|20)\d{2})` lookahead, plus the bracketed Plex/YTS form).
const YEAR_FOLLOWED_BY_YEAR = /^[.\-_ ]+[[(]?(?:19|20)\d{2}\b/;
// Words a cut leaves dangling at the end of a title ("Show Name The" of "Show.Name.The.Complete.Series").
const TRAILING_ARTICLE = /\s+(?:the|a|an|and|of)$/i;
// An edition phrase written before the year ("Alien.Directors.Cut.1979") is not part of the title.
const TRAILING_EDITION =
  /\s+(?:directors?'?\s?cut|extended(?:\s(?:cut|edition))?|unrated|remastered|imax|theatrical(?:\scut)?|final\scut|ultimate\s(?:cut|edition)|criterion(?:\s(?:collection|edition))?|uncut|redux|collectors?\sedition)$/i;
// A pack word after a bare "complete" ("Show.Name.COMPLETE.1080p", "Complete.Season"), or a year/
// season token before it: then "complete" is the pack marker, not a title word.
const COMPLETE_PACK_AFTER = /^[ ._-]+(?:series|seasons?|collection|box[ ._-]?set|pack|edition|bluray|blu-ray|bd|remux|\d{3,4}[pi])\b/i;
const COMPLETE_PACK_BEFORE = /(?:(?:19|20)\d{2}|\bS\d{1,2}|seasons?[ ._-]?\d{1,2})[ ._-]+$/i;

function minDefined(...values: (number | null | undefined)[]): number | null {
  let min: number | null = null;
  for (const v of values) if (v != null && (min === null || v < min)) min = v;
  return min;
}

/** Where the title's own words start: after any leading bracketed tags and tracker prefixes. */
function titleStart(title: string): number {
  let start = 0;
  for (;;) {
    const rest = title.slice(start);
    const skip = rest.match(LEADING_TAGS)?.[0].length || rest.match(LEADING_SITE)?.[0].length || 0;
    if (!skip) return start;
    start += skip;
  }
}

/** Whether a title token (a letter or digit) stands between `from` and `to`. */
function hasTitleToken(title: string, from: number, to: number): boolean {
  return /[\p{L}\p{N}]/u.test(title.slice(from, to));
}

/** Index of the first quality/source/codec word that has a title token before it, or null. */
function firstQualityMarker(title: string, start: number): number | null {
  for (const m of title.matchAll(TITLE_END_MARKER)) {
    const at = m.index ?? 0;
    if (at >= start && hasTitleToken(title, start, at)) return at;
  }
  return null;
}

/** The year that belongs to the title — see ParsedRelease.titleYear. `bound` is the index the
 * year has to stand before (the episode marker, else the first quality word); `airDate` is the
 * air-date match the year must not be part of. */
function detectTitleYear(title: string, start: number, bound: number | null, airDate: RegExpMatchArray | null, releaseGroup: string | null): { year: number; index: number } | null {
  const trimmed = title.trimEnd();
  for (const m of title.matchAll(YEAR_ALL)) {
    const at = m.index ?? 0;
    if (at < start || !hasTitleToken(title, start, at)) continue;
    if (bound != null && at >= bound) continue;
    if (airDate && airDate.index != null && at >= airDate.index && at < airDate.index + airDate[0].length) continue;
    // Another year follows: this one is the title's. Unless what follows is the air date
    // ("Show.Name.2018.2024.08.25"), whose year is no title year either way.
    const follow = title.slice(at + 4).match(YEAR_FOLLOWED_BY_YEAR);
    if (follow && !(airDate && airDate.index === at + follow[0].length)) continue;
    // The trailing "-2024" of "Show.Name.x264-2024" is the release group, not a year.
    if (releaseGroup === m[0] && at + 4 === trimmed.length && title[at - 1] === "-") continue;
    return { year: Number(m[0]), index: at };
  }
  return null;
}

function cleanTitleSlice(slice: string): string {
  return slice
    .replace(/[._]/g, " ")
    .replace(/[\s\-–—:]*[[({]*\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_EDITION, "")
    .replace(TRAILING_ARTICLE, "")
    .trim();
}

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

const MAX_SEASON_RANGE = 50;
const TRAILING_LANGUAGES = new RegExp(`(?:[ ._\\-]+(?:${Object.keys(LANGUAGE_TAGS).join("|")}))+[ ._\\-]*$`, "i");
const TRAILING_QUALITY_MODIFIER = /(?:[ ._-]+(?:regional|r5|screener|scr|dvdscr|bdscr|rawhd|brdisk|bdmv|bd25|bd50))+[ ._-]*$/i;

/**
 * The text language, edition and quality-modifier tags are looked for in: everything but the title.
 * That is the leading tags plus what follows the cut (the year, the numbering or the first quality
 * word), plus tag words standing at the end of the title itself — "Movie.FRENCH.1080p" has no year
 * to end the title before its language. With nothing to cut at, the whole name.
 */
function tagScanText(title: string, start: number, cutAt: number | null): string {
  if (cutAt === null) return title;
  const slice = title.slice(start, cutAt);
  const tails = [
    slice.match(TRAILING_LANGUAGES)?.[0],
    slice.match(TRAILING_QUALITY_MODIFIER)?.[0],
    slice.replace(/[._]/g, " ").trimEnd().match(TRAILING_EDITION)?.[0],
  ];
  return [title.slice(0, start), ...tails, title.slice(cutAt)].filter(Boolean).join(" ");
}

/** A range's end, or its start when the "end" is no plausible range end. */
function cappedEnd(start: number, end: number): number {
  return end - start >= MAX_EPISODE_RANGE ? start : end;
}

export function parseReleaseTitle(title: string): ParsedRelease {
  let seasonNumber: number | null = null;
  let episodeNumbers: number[] | null = null;
  let isFullSeason = false;
  let episodeRange: [number, number] | null = null;
  // Where the numbering (season/episode/absolute/air-date/pack) marker starts: the title ends there.
  let markerIndex: number | null = null;

  const rangeMatch = title.match(SEASON_EP_RANGE);
  if (rangeMatch) {
    markerIndex = rangeMatch.index ?? null;
    seasonNumber = Number(rangeMatch[1]);
    const start = Number(rangeMatch[2]);
    if (rangeMatch[6]) {
      // Chained "E01E02E03" / "E01.E02" tags — an explicit list, not necessarily contiguous.
      episodeNumbers = [start];
      for (const m of rangeMatch[6].matchAll(/E(\d{1,3})/gi)) episodeNumbers.push(Number(m[1]));
    } else {
      // Single episode, or a hyphenated "-E03"/"-03" range end, or a repeated season tag
      // ("S01E01-S01E02", the same season only) — inclusive.
      const end = cappedEnd(start, rangeMatch[3] ? Number(rangeMatch[3]) : rangeMatch[5] && Number(rangeMatch[4]) === seasonNumber ? Number(rangeMatch[5]) : start);
      episodeNumbers = [];
      for (let e = start; e <= end; e++) episodeNumbers.push(e);
    }
  } else {
    const dashMatch = seasonDashEpisode(title);
    const xMatch = dashMatch ? null : title.match(SEASON_EP_X_FORMAT);
    const wordMatch = dashMatch || xMatch ? null : title.match(SEASON_WORD_EPISODE);
    if (dashMatch) {
      markerIndex = dashMatch.index ?? null;
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
      markerIndex = xMatch.index ?? null;
      seasonNumber = Number(xMatch[1]);
      const start = Number(xMatch[2]);
      const end = xMatch[3] ? cappedEnd(start, Number(xMatch[3])) : start;
      episodeNumbers = [];
      for (let e = start; e <= Math.max(start, end); e++) episodeNumbers.push(e);
    } else if (wordMatch) {
      markerIndex = wordMatch.index ?? null;
      seasonNumber = Number(wordMatch[1]);
      episodeNumbers = [Number(wordMatch[2])];
    } else {
      const seasonMatch = title.match(SEASON_ONLY);
      if (seasonMatch) {
        markerIndex = seasonMatch.index ?? null;
        seasonNumber = Number(seasonMatch[1]);
        isFullSeason = true;
      } else {
        const fullSeasonMatch = title.match(FULL_SEASON_HINT);
        if (fullSeasonMatch) {
          // The title ends at the pack word only when a title stands before it and, for a bare
          // "complete", a pack/quality word follows or a year/season precedes it: "Complete.Unknown.
          // 2016" is a movie title (isFullSeason stays as it was, see the corpus).
          const at = fullSeasonMatch.index ?? 0;
          const bareComplete = /^complete$/i.test(fullSeasonMatch[1]);
          const after = title.slice(at + fullSeasonMatch[0].length);
          const before = title.slice(0, at);
          // "Inception.2010.COMPLETE.BLURAY" is a film's disc image.
          const discImage = bareComplete && DISC_TAG_AFTER.test(after) && YEAR_BEFORE.test(before);
          const packMarker = hasTitleToken(title, titleStart(title), at) && (!bareComplete || COMPLETE_PACK_AFTER.test(after) || COMPLETE_PACK_BEFORE.test(before)) && !discImage;
          if (packMarker) markerIndex = at;
          // A bare "complete" that is no pack marker is a title word ("Complete.Unknown.2016").
          if (!bareComplete || packMarker) {
            isFullSeason = true;
            // Only the "season <N>" alternative actually names a season ("complete"/"full season"
            // don't) — extract it so a title like "Show Name Season 3 ..." (space-separated, no
            // "S03" abbreviation) can still match a request for that specific season.
            const digits = fullSeasonMatch[1].match(/(\d{1,2})/);
            if (digits) seasonNumber = Number(digits[1]);
          }
        } else if (BATCH_TAG.test(title) || isAbsoluteBatch(title)) {
          // With no season, the pack matches no specific episode, which beats matching its first.
          isFullSeason = true;
          // Only a marker after the leading tags bounds the title: a "[Batch]" among them is a tag,
          // not where the title ends.
          const afterStart = (i: number | undefined) => (i != null && i >= titleStart(title) ? i : null);
          markerIndex = minDefined(afterStart(title.match(ABSOLUTE_RANGE)?.index), afterStart(title.match(BATCH_TAG)?.index));
        }
      }
    }
  }

  const yearMatch = title.match(YEAR);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  let airDate: string | null = null;
  let dateMatch = title.match(AIR_DATE);
  if (dateMatch) {
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      airDate = `${dateMatch[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  } else {
    // Year-last dates: "08.25.2024" (MM.DD, the US convention Sonarr assumes when both numbers
    // could be a month) or "25.08.2024" (DD.MM, when only that reading is a valid date).
    const yearLast = title.match(AIR_DATE_YEAR_LAST);
    if (yearLast) {
      const first = Number(yearLast[1]);
      const second = Number(yearLast[2]);
      const monthDay = first >= 1 && first <= 12 && second >= 1 && second <= 31 ? [first, second] : second >= 1 && second <= 12 && first >= 1 && first <= 31 ? [second, first] : null;
      if (monthDay) {
        airDate = `${yearLast[3]}-${String(monthDay[0]).padStart(2, "0")}-${String(monthDay[1]).padStart(2, "0")}`;
        dateMatch = yearLast;
      }
    }
  }

  let absoluteEpisode: number | null = null;
  if (seasonNumber === null && episodeNumbers === null && !isFullSeason) {
    const absMatch = title.match(ABSOLUTE_EPISODE);
    if (absMatch) {
      absoluteEpisode = Number(absMatch[1]);
      markerIndex = absMatch.index ?? null;
    }
  }
  if (airDate && dateMatch) markerIndex = minDefined(markerIndex, dateMatch.index);

  const imdbMatch = title.match(IMDB_ID);
  const releaseGroup = detectReleaseGroup(title);

  // Title and title year. The numbering marker bounds both; without one, the first quality word
  // does. A year never comes from after that bound (an encode date, an episode's year), and the
  // title never runs past the year, a bracket, or the trailing "-GROUP".
  const start = titleStart(title);
  const qualityAt = firstQualityMarker(title, start);
  const titleYearInfo = detectTitleYear(title, start, minDefined(markerIndex, qualityAt), airDate ? dateMatch : null, releaseGroup);
  // A bracket ends the title, except a short qualifier that IS part of it: "Shameless (US)" must
  // stay distinct from "Shameless", and "(2017)" is handled by the title year.
  const bracketAt = (() => {
    for (let i = start; i < title.length; i++) {
      if ((title[i] === "[" || title[i] === "(") && hasTitleToken(title, start, i)) {
        const close = title.indexOf(title[i] === "(" ? ")" : "]", i + 1);
        if (close !== -1 && /^(?:[A-Z]{2,3}|(?:19|20)\d{2})$/.test(title.slice(i + 1, close))) continue;
        return i;
      }
    }
    return null;
  })();
  const trimmedTitle = title.trimEnd();
  const groupAt = releaseGroup && trimmedTitle.endsWith(`-${releaseGroup}`) ? trimmedTitle.length - releaseGroup.length - 1 : null;
  const cutAt = minDefined(markerIndex, titleYearInfo?.index, qualityAt, bracketAt, groupAt);
  const isolatedTitle = cleanTitleSlice(title.slice(start, cutAt ?? undefined));
  // Language, edition and quality-modifier tags are read from outside the title: "French
  // Connection" is no French release and "Final Destination" no Final edition.
  const tags = tagScanText(title, start, cutAt);

  let seasonRange: [number, number] | null = null;
  if (isFullSeason && episodeNumbers === null) {
    const rangeSeasons = title.match(SEASON_RANGE);
    if (rangeSeasons) {
      const first = Number(rangeSeasons[1] ?? rangeSeasons[3]);
      const last = Number(rangeSeasons[2] ?? rangeSeasons[4]);
      if (first === seasonNumber && last > first && last - first < MAX_SEASON_RANGE) seasonRange = [first, last];
    }
  }

  return {
    title: isolatedTitle,
    titleYear: titleYearInfo?.year ?? null,
    seasonNumber,
    episodeNumbers,
    isFullSeason,
    year,
    quality: detectQuality(title),
    source: detectSource(title),
    resolution: detectResolution(title),
    flags: detectFlags(title),
    languages: detectLanguages(tags),
    releaseGroup,
    airDate,
    absoluteEpisode,
    imdbId: imdbMatch ? imdbMatch[0].toLowerCase() : null,
    edition: detectEdition(tags),
    qualityModifier: detectQualityModifier(tags),
    releaseType: detectReleaseType(isFullSeason, episodeNumbers),
    episodeRange,
    seasonRange,
    rejected: HASHED_NAMES.some((pattern) => pattern.test(title.trim())),
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

/** A series' scene numbering by number: each scene "season:episode" that differs from the aired
 * one, mapped to the aired "season:episode" of the episode that carries it (see
 * sceneNumbering.ts sceneIndexFor). */
export type SceneIndex = ReadonlyMap<string, string>;

/**
 * `sceneSeasonNumber`/`sceneEpisodeNumber` (from TheXEM, see services/sceneNumbering.ts) are an
 * alternative to the metadata provider's own numbering — not every release for a scene-mapped show
 * uses the scene numbering (some groups number correctly anyway), so a release fitting either
 * matches. With `sceneIndex` the two are no longer equals: scene numbering comes first, and the
 * aired numbers count only while they are no other episode's scene numbers. "Show.S05E01" is TVDB
 * S01E05 of a show whose aired S05E01 is a different episode, and must not match both.
 */
export function releaseMatchesEpisode(
  parsed: ParsedRelease,
  seasonNumber: number,
  episodeNumber: number,
  sceneSeasonNumber?: number | null,
  sceneEpisodeNumber?: number | null,
  absoluteEpisodeNumber?: number | null,
  sceneIndex?: SceneIndex | null
): boolean {
  if (sceneSeasonNumber != null && sceneEpisodeNumber != null) {
    if (matchesSeasonEpisode(parsed, sceneSeasonNumber, sceneEpisodeNumber)) return true;
  }
  if (matchesSeasonEpisode(parsed, seasonNumber, episodeNumber)) {
    const aired = `${seasonNumber}:${episodeNumber}`;
    const owner = sceneIndex?.get(aired);
    if (owner === undefined || owner === aired) return true;
    // These aired numbers are another episode's scene numbers: the release is that episode's.
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
