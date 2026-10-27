/**
 * Stricter reading of a music, book, audiobook, comic, manga or ROM release name than "it contains the
 * wanted title's words": the title must STAND on its own in the name, with nothing but the artist or
 * author, a year, a format or edition tag beside it. "Frank Herbert - Dune Messiah" is not "Dune",
 * "Queen - Live Greatest Hits" is not "Greatest Hits", "New Super Mario Bros." is not "Super Mario Bros.",
 * "Batman Annual 012" is not "Batman #12". Lidarr (SingleAlbumSearchMatchSpecification), Readarr
 * (AuthorSpecification, BookRequestedSpecification) and the ROM and comic name grammars do the same.
 *
 * Pure: it is asked after scheduler.ts's looser containment test has passed, and can only refuse.
 */

/**
 * A title without the edition a provider tacks on after a dash or colon ("Thriller - Remastered", "Rumours: Deluxe
 * Edition", "Abbey Road - 2019 Mix"): the release for the plain album is the one wanted, and a release of the
 * edition names the plain title as well. A title that is nothing but the suffix is left alone.
 */
export function editionlessTitle(title: string): string {
  const stripped = title
    .replace(/\s*[-–:]\s*(?:\d{4}\s+)?(?:(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?(?:anniversary|deluxe|remaster(?:ed)?|expanded|special|collector'?s|super deluxe|limited|bonus|reissue|extended|mono|stereo|digital|explicit|clean|legacy|platinum)(?:\s+(?:version|edition|mix|tracks?|mastered))*(?:\s+\d{4})?)\s*$/i, "")
    .trim();
  return stripped.length > 0 ? stripped : title;
}

export interface NonVideoName {
  title: string;
  parentTitle?: string | null;
  /** The titles of the parent's other children, for a book. */
  siblingTitles?: string[];
  /** An album's release year and the years of the artist's other albums of the same title. */
  releaseYear?: number | null;
  sameTitledYears?: number[];
}

const STOPWORDS = new Set(["a", "an", "the", "and", "of", "to", "in", "on", "at", "for", "by", "with"]);
const FOLDED_LETTERS: Record<string, string> = { æ: "ae", ø: "o", ß: "ss", œ: "oe" };
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

interface Token {
  text: string;
  /** The characters between the previous token and this one ("" for the first). */
  gap: string;
  /** Where in the source string it starts. */
  at: number;
}

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[æøßœ]/g, (c) => FOLDED_LETTERS[c])
    .replace(/['’`]/g, "");
}

/** Letters and digits as tokens with the text between them, digits and letters split ("v05" -> v, 5). */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  // Format names that carry a digit stay whole ("mp3", "m4b"), else they split into a word and a number.
  const re = /\b(?:mp3|m4[ab]|azw3)\b|\p{L}+|\p{N}+/gu;
  const source = fold(text);
  let last = 0;
  for (const m of source.matchAll(re)) {
    const at = m.index ?? 0;
    const raw = m[0];
    out.push({ text: /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : raw, gap: source.slice(last, at), at });
    last = at + raw.length;
  }
  return out;
}

const words = (tokens: Token[]) => tokens.map((t) => t.text);

/** Tokens without the stopwords, each kept token taking the gaps of the stopwords before it: a break that stood
 * in front of "the" ("Stephen King - The Shining") is still a break in front of "shining". */
function withoutStopwords(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let carried = "";
  for (const t of tokens) {
    if (STOPWORDS.has(t.text)) {
      carried += t.gap + " ";
      continue;
    }
    out.push({ ...t, gap: carried + t.gap });
    carried = "";
  }
  return out;
}

const significant = (text: string) => withoutStopwords(tokenize(text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ")));

/** The release name as the text outside brackets, with the separators release names use read as spaces. */
function coreOf(releaseTitle: string): string {
  return releaseTitle
    .replace(/&amp;/gi, "&")
    .replace(/_/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\.(?:epub|mobi|azw3?|pdf|cbz|cbr|flac|mp3|m4b|m4a|zip|7z|rar|iso|chd|nes|sfc|smc|gba|gbc|gb|n64|z64|nds|3ds|bin|cue)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const bracketsOf = (releaseTitle: string): string => Array.from(releaseTitle.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g), (m) => m[1] ?? m[2] ?? m[3] ?? "").join(" ");

/** A break in a name that starts something new: a colon, a dash, a bracket, a bar. */
const BOUNDARY = /[:\-|/()[\]]/;
/** The words that join two works into one release. */
const JOINER = /[&+]/;

const FORMAT_WORDS = new Set([
  "epub", "mobi", "azw", "azw3", "pdf", "cbz", "cbr", "djvu", "ebook", "ebooks", "retail", "flac", "mp3", "m4b", "m4a", "aac", "alac", "ogg", "opus", "wav", "lossless",
  "web", "cd", "vinyl", "audiobook", "unabridged", "abridged", "digital", "scan", "scans", "hq",
  "rip", "ripped", "dsd", "sacd", "hdcd", "vbr", "lame", "cue", "log", "eac", "cdda", "wv", "ape", "dvd", "bluray", "kindle", "scanned", "ocr", "retail", "mp4",
]);
const EDITION_WORDS = new Set([
  "deluxe", "remastered", "remaster", "expanded", "anniversary", "edition", "version", "reissue", "bonus", "mono", "stereo", "special", "collectors", "limited", "illustrated", "revised",
  "updated", "complete", "new", "original", "extended", "explicit", "clean", "tracks", "disc", "discs", "cds", "lp", "lps", "bit", "khz", "kbps", "st", "nd", "rd", "th",
  "super", "mix", "studio", "album", "japan", "import", "uk", "us", "eu", "xcd", "xlp",
]);
const UNIT_WORDS = new Set(["cd", "cds", "bit", "khz", "kbps", "lp", "lps", "tracks", "disc", "discs", "st", "nd", "rd", "th", "xcd", "xlp", "dvd", "k", "g"]);
const VOLUME_WORDS = new Set(["vol", "volume", "part", "pt"]);
const BIT_DEPTHS = new Set(["16", "24", "32"]);
const BITRATES = new Set(["128", "160", "192", "224", "256", "320"]);
const SAMPLE_RATES = new Set(["44", "48", "88", "96", "176", "192"]);
const isYear = (t: string) => /^(?:1[89]|20)\d\d$/.test(t);

/** Where `sequence` occurs in `tokens` as a run, or -1. */
function findRun(tokens: string[], sequence: string[]): number {
  if (sequence.length === 0) return -1;
  for (let i = 0; i + sequence.length <= tokens.length; i++) if (sequence.every((t, j) => tokens[i + j] === t)) return i;
  return -1;
}

/** Every place `sequence` occurs in `tokens` as a run. */
function findRuns(tokens: string[], sequence: string[]): number[] {
  const at: number[] = [];
  if (sequence.length === 0) return at;
  for (let i = 0; i + sequence.length <= tokens.length; i++) if (sequence.every((t, j) => tokens[i + j] === t)) at.push(i);
  return at;
}

/** Whether `a` and `b` are the same run of words, numbers written as roman or arabic alike. */
function sameWords(a: string[], b: string[]): boolean {
  const norm = (list: string[]) => list.map((t) => ROMAN[t] ?? t);
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

interface StandOptions {
  /** Tokens that may stand beside the title without being another title: the author or artist, series words. */
  allowed: Set<string>;
  /** Words that, beside the title, make another work or edition of it. Refused wherever they stand in the core. */
  refuse: RegExp;
}

/**
 * Whether the run at `at` (length `length`) in `core` stands alone: nothing but allowed words, years and
 * unit-numbers directly beside it before the next break. A break (colon, dash, bracket) ends the check on
 * that side: a subtitle or a bracket tag follows a title and names nothing else; a joiner ("&", "+") does not.
 */
function standsAlone(core: Token[], at: number, length: number, options: StandOptions, leftNumbersAllowed = true): string | null {
  const allowedWord = (t: Token, index: number, side: "left" | "right"): boolean => {
    if (options.allowed.has(t.text) || FORMAT_WORDS.has(t.text) || EDITION_WORDS.has(t.text) || STOPWORDS.has(t.text)) return true;
    if (isYear(t.text)) return true;
    if (/^\d+$/.test(t.text)) {
      if (side === "left") return leftNumbersAllowed;
      // A number right after a title: a year, a disc or bit depth with its unit ("2CD", "24 bit"), not a sequel.
      if (UNIT_WORDS.has(core[index + 1]?.text ?? "")) return true;
      // "24-96": a bit depth and a sample rate written as a pair.
      if (BIT_DEPTHS.has(t.text) && SAMPLE_RATES.has(core[index + 1]?.text ?? "")) return true;
      // "MP3 320": a bitrate right after a format word.
      return BITRATES.has(t.text) && (FORMAT_WORDS.has(core[index - 1]?.text ?? "") || FORMAT_WORDS.has(core[index + 1]?.text ?? ""));
    }
    return false;
  };
  // Right of the title. From the first year or format word on, the name is in its tag zone ("1997 FLAC Parlophone",
  // "2021 Ray Porter m4b"): the words there describe the release and are not another title, but a volume marker,
  // a roman numeral or a bare number still names a later entry.
  let tagZone = false;
  for (let k = at + length; k < core.length; k++) {
    const t = core[k];
    // "Greatest Hits Vol. 1" is the first volume of the title searched for, which is the title itself.
    if (VOLUME_WORDS.has(t.text) && core[k + 1]?.text === "1" && !BOUNDARY.test(core[k + 1].gap)) {
      k++;
      continue;
    }
    // "MP3 V0": a variable-bitrate quality, not a sequel.
    if (tagZone && t.text === "v" && /^[0-2]$/.test(core[k + 1]?.text ?? "")) {
      k++;
      continue;
    }
    if (BOUNDARY.test(t.gap) && !JOINER.test(t.gap)) break;
    const fits = allowedWord(t, k, "right");
    if (JOINER.test(t.gap) && !fits && !options.allowed.has(t.text)) return `it joins "${t.text}" to the title`;
    if (!fits) {
      const laterEntry = VOLUME_WORDS.has(t.text) || (ROMAN[t.text] !== undefined && t.text !== "x" && t.text !== "v") || /^\d+$/.test(t.text);
      if (!tagZone || laterEntry) return `"${t.text}" follows the title`;
    }
    if (isYear(t.text) || FORMAT_WORDS.has(t.text)) tagZone = true;
  }
  // Left of the title.
  for (let k = at - 1; k >= 0; k--) {
    const next = core[k + 1];
    if (next && BOUNDARY.test(next.gap) && !JOINER.test(next.gap)) break;
    if (next && JOINER.test(next.gap) && !options.allowed.has(core[k].text)) return `it joins "${core[k].text}" to the title`;
    if (!allowedWord(core[k], k, "left")) return `"${core[k].text}" comes before the title`;
  }
  return null;
}

/** Words that name a different work from the one searched for, wherever they stand. */
const BOOK_OTHER_WORK =
  /\b(summary|summaries|workbook|study guide|companion|cliffs ?notes|analysis|for kids|junior|graphic novel|coloring book|trivia|quiz book|bundle|box ?set|omnibus|sampler|excerpt|preview|cheat ?sheet|book club)\b/i;
const ALBUM_OTHER_WORK = /\b(live|sessions?|karaoke|tribute|singles?|ep|instrumentals?|bootleg|demos?|covers|remixes|rarities|b-sides|outtakes|unplugged|acoustic version|lullaby)\b/i;
const AUDIO_TAGS = /\b(m4b|mp3|audiobook|unabridged|abridged|narrated by|audible)\b/i;
const EBOOK_TAGS = /\b(epub|mobi|azw3?|pdf|djvu|ebook|cbz|cbr)\b/i;

const seriesWordsOf = (title: string): string[] => {
  const m = title.match(/\(([^)]*?)(?:,?\s*#?\d+[\d.]*)?\)/);
  return m ? significant(m[1]).map((t) => t.text) : [];
};
const authorWordsOf = (parent: string | null | undefined): string[] => {
  if (!parent) return [];
  const tokens = significant(parent).map((t) => t.text);
  // "J.R.R. Tolkien" is also written "JRR Tolkien": the initials run together.
  const initials = tokenize(parent).map((t) => t.text);
  const joined: string[] = [];
  let run = "";
  for (const t of [...initials, ""]) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) joined.push(run);
      run = "";
    }
  }
  return [...tokens, ...joined];
};

/** Why a book or audiobook release is not the wanted book, or null. */
function bookRejection(releaseTitle: string, name: NonVideoName, mediaType: string): string | null {
  const wantedText = `${name.parentTitle ?? ""} ${name.title}`;
  const other = releaseTitle.match(BOOK_OTHER_WORK);
  if (other && !BOOK_OTHER_WORK.test(wantedText)) return `it is a "${other[1]}", not the book`;
  // "Foundation 1-7", "Dune Chronicles 1-6": several books in one release.
  const range = /(?:^|\s)(\d{1,2})\s*-\s*(\d{1,2})(?=\s|$)/.exec(coreOf(releaseTitle));
  if (range && Number(range[2]) > Number(range[1]) && !/\b\d{1,2}\s*-\s*\d{1,2}\b/.test(name.title)) return "it is a range of books";
  const haystack = `${releaseTitle}`;
  if (mediaType === "author" && AUDIO_TAGS.test(haystack) && !EBOOK_TAGS.test(haystack)) return "it is an audiobook, and an ebook is wanted";
  if (mediaType === "audiobook" && EBOOK_TAGS.test(haystack) && !AUDIO_TAGS.test(haystack)) return "it is an ebook, and an audiobook is wanted";

  const core = tokenize(coreOf(releaseTitle).replace(/\bby\b/gi, "-"));
  const wanted = significant(name.title);
  if (wanted.length === 0) return null;
  const allowed = new Set([...authorWordsOf(name.parentTitle), ...seriesWordsOf(name.title), "book"]);
  const coreTokens = withoutStopwords(core);
  const coreWords = words(coreTokens);
  // The whole title, else its part before the subtitle (releases leave subtitles off).
  const mainParts = name.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/\s*:\s*|\s+[-–—]\s+/);
  // "Mistborn: The Final Empire (Mistborn, #1)": a release of the book often names only the part after the series.
  const seriesWords = seriesWordsOf(name.title);
  const subtitleOnly =
    mainParts.length === 2 && seriesWords.length > 0 && significant(mainParts[0]).every((t) => seriesWords.includes(t.text)) ? [significant(mainParts[1]).map((t) => t.text)] : [];
  const candidates = [wanted.map((t) => t.text), ...(mainParts.length > 1 ? [significant(mainParts[0]).map((t) => t.text)] : []),
    ...subtitleOnly].filter((c) => c.length > 0);
  for (const sequence of candidates) {
    const places = findRuns(coreWords, sequence);
    if (places.length === 0) continue;
    // "Dune 01 - Dune": the title may stand in the name more than once, and one place standing alone is enough.
    let verdict: string | null = "";
    for (const at of places) {
      verdict = standsAlone(coreTokens, at, sequence.length, { allowed, refuse: BOOK_OTHER_WORK }, true);
      if (verdict === null) break;
    }
    if (verdict === null) {
      // A sibling that carries the wanted title as its start is the sibling's release when its other words are here.
      const sibling = (name.siblingTitles ?? []).find((s) => {
        const tokens = significant(s).map((t) => t.text);
        return tokens.length > sequence.length && findRun(tokens, sequence) === 0 && tokens.every((t) => coreWords.includes(t));
      });
      return sibling ? `it names "${sibling}", another book` : null;
    }
    if (sequence === candidates[candidates.length - 1]) return verdict;
  }
  return "the title is not on its own in the name";
}

/** The years a release name states, in brackets or not. */
function statedYears(releaseTitle: string): number[] {
  return Array.from(releaseTitle.replace(/_/g, " ").matchAll(/(?<!\d)((?:19|20)\d\d)(?!\d)/g), (m) => Number(m[1]));
}

/** Why an album release is not the wanted album, or null. */
function albumRejection(releaseTitle: string, name: NonVideoName): string | null {
  const wantedText = `${name.parentTitle ?? ""} ${name.title}`;
  const core = tokenize(coreOf(releaseTitle));
  const wanted = significant(name.title).map((t) => t.text);
  const parent = significant(name.parentTitle ?? "").map((t) => t.text);
  if (wanted.length === 0) return null;
  // A self-titled album ("Metallica - Metallica") is left to the looser test: the name and the title are one run.
  if (parent.length > 0 && wanted.every((t) => parent.includes(t))) return null;
  const tags = bracketsOf(releaseTitle);
  const other = `${coreOf(releaseTitle)} ${tags}`.match(ALBUM_OTHER_WORK);
  if (other && !ALBUM_OTHER_WORK.test(wantedText)) return `it is a "${other[1]}" release, not the album`;
  const coreTokens = withoutStopwords(core);
  const coreWords = coreTokens.map((t) => t.text);
  const at = findRun(coreWords, wanted);
  // The title only in a bracket tag ("1989 [FLAC] (Red Edition)"): another album.
  if (at < 0) return "the title is not in the name outside its tags";
  // The artist leads, so a run that starts inside the artist's own words is the artist's name, not the album.
  const allowed = new Set([...parent, "va", "various", "artists"]);
  // Two albums of one title by one artist ("Greatest Hits" 1981 and 2008): a year naming the other one is the other one.
  const stated = statedYears(releaseTitle);
  if (name.releaseYear && name.sameTitledYears?.length && stated.length > 0 && !stated.includes(name.releaseYear) && stated.some((y) => name.sameTitledYears!.includes(y))) {
    return `it is the ${stated.join("/")} album of that name, not the ${name.releaseYear} one`;
  }
  return standsAlone(coreTokens, at, wanted.length, { allowed, refuse: ALBUM_OTHER_WORK }, true);
}

const ROM_PLATFORM = /\s-\s*(?:nes|snes|sfc|gba|gbc|gb|n64|nds|3ds|genesis|mega drive|master system|ps[1-5p]?|psx|psp|xbox|pc|switch|dreamcast|saturn|wii|gamecube)$/i;
const ROM_BAD_FLAGS = /\[[bhtopf]\d+[a-z]?\]|\[[bhtopf]\]|\((?:[^)]*\b)?(?:hack|beta|proto|prototype|demo|pirate|sample|unl|aftermarket|bootleg|kiosk|trainer)\b[^)]*\)/i;

/** Platform and region words a ROM release puts at either end of the game's name, outside any bracket. */
const ROM_EDGE_WORDS =
  "super nintendo|nintendo entertainment system|nintendo 64|nintendo ds|nintendo switch|game boy color|game boy advance|game boy|sony playstation|playstation \\d|sega genesis|sega mega drive|sega master system|nes|snes|sfc|gba|gbc|gb|n64|nds|3ds|genesis|ps[1-5p]|psx|psp|xbox|pc|switch|dreamcast|saturn|wii|gamecube|usa|europe|japan|pal|ntsc|eur|jpn";
const ROM_EDGE_START = new RegExp(`^(?:${ROM_EDGE_WORDS})\\s*[-:]?\\s+(?=\\S)`, "i");
const ROM_EDGE_END = new RegExp(`\\s*[-:]?\\s+(?:${ROM_EDGE_WORDS})$`, "i");

/** A ROM title without the platform or region words at its ends ("SNES - Chrono Trigger", "Chrono Trigger USA")
 * and without "Version" ("Pokemon Emerald Version"), which names the cartridge and not the game. */
function withoutRomEdges(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(ROM_EDGE_START, "").replace(ROM_EDGE_END, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/\bver(?:sion|\.)?(?=\s|$)/gi, " ");
}

/** The game's title in a ROM release name: the text before its first bracket, ", The" moved to the front. */
export function romTitleOf(releaseTitle: string): string {
  let t = releaseTitle
    .replace(/_/g, " ")
    .replace(/\.(?:zip|7z|rar|nes|sfc|smc|gba|gbc|gb|n64|z64|v64|nds|3ds|iso|chd|bin|cue|gdi|cso|pbp|wbfs|rvz|wad|gcm|nsp|xci|gen|smd|sms|gg|pce|a26|a78)$/i, "");
  const bracket = t.search(/[([]/);
  if (bracket > 0) t = t.slice(0, bracket);
  t = t.replace(ROM_PLATFORM, "").trim();
  const trailingThe = t.match(/^(.*),\s*(the|a|an)$/i);
  return trailingThe ? `${trailingThe[2]} ${trailingThe[1]}` : t;
}

/** Why a ROM release is not the wanted game, or null. */
function romRejection(releaseTitle: string, name: NonVideoName): string | null {
  const flag = releaseTitle.match(ROM_BAD_FLAGS);
  if (flag && !ROM_BAD_FLAGS.test(name.title)) return `it is a modified or unfinished dump (${flag[0]})`;
  const release = significant(withoutRomEdges(romTitleOf(releaseTitle))).map((t) => t.text);
  const wanted = significant(withoutRomEdges(name.title)).map((t) => t.text);
  if (wanted.length === 0 || release.length === 0) return null;
  // "Mario Bros" for "Super Mario Bros."-style titles is not the same game: the words must be the title's.
  return sameWords(release, wanted) ? null : "the game's name is not the wanted title";
}

const COMIC_COLLECTED = /\b(tpb|annual|omnibus|deluxe|hardcover|hc|compendium|collected|trade paperback|graphic novel|absolute)\b/i;

/** A comic or manga release's issue, volume and chapter numbers. */
export function comicNumbersOf(releaseTitle: string): { series: string; issue: number | null; volume: number | null; chapters: [number, number] | null; collected: boolean; range: boolean } {
  const text = releaseTitle.replace(/_/g, " ").replace(/\.(?:cbz|cbr|pdf|epub)$/i, "");
  const collected = COMIC_COLLECTED.test(text);
  const chapterRange = text.match(/\bc(\d{1,4})\s*-\s*(?:c)?(\d{1,4})\b/i);
  const chapterOne = text.match(/\b(?:c|ch\.?|chapter)\s*0*(\d{1,4}(?:\.\d)?)\b/i);
  const volume = text.match(/\bv(?:ol(?:ume)?\.?)?\s*0*(\d{1,3})\b/i);
  // "001-012" is a run of issues; "300 - 2019" is an issue and a year.
  const runOfIssues = /(?:^|[\s])0*(\d{1,4})\s*-\s*0*(\d{1,4})(?:\s|$|\()/.exec(text.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  const issueRange = !!runOfIssues && Number(runOfIssues[2]) > Number(runOfIssues[1]) && Number(runOfIssues[2]) < 1900 && !chapterRange;
  const series = text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/\s(?:#|v\d|vol|c\d|ch\.?|chapter|\d{1,4}\b)/i)[0].trim();
  const issueMatch = text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .match(/(?:#|\bissue\s*|\b)0*(\d{1,4}(?:\.\d)?)(?![\d.]*\s*(?:of|covers?))\s*$/i);
  return {
    series,
    issue: chapterOne ? Number(chapterOne[1]) : issueMatch ? Number(issueMatch[1]) : null,
    volume: volume ? Number(volume[1]) : null,
    chapters: chapterRange ? [Number(chapterRange[1]), Number(chapterRange[2])] : null,
    collected,
    range: issueRange,
  };
}

/** Why a comic or manga release is not the wanted issue or chapter, or null. */
function comicRejection(releaseTitle: string, name: NonVideoName, mediaType: string): string | null {
  const wantedNumber = name.title.match(/^\s*(?:#|issue\s*#?\s*|chapter\s*|ch\.?\s*)(\d+(?:\.\d+)?)/i);
  if (!wantedNumber || !name.parentTitle) return null;
  const number = Number(wantedNumber[1]);
  // A series that is called "Absolute Carnage" or "Batman Annual" is not a collected edition for having the word.
  const wantedIsCollected = /\b(tpb|annual|omnibus|volume|vol\b)/i.test(name.title) || COMIC_COLLECTED.test(name.parentTitle);
  const parsed = comicNumbersOf(releaseTitle);
  const text = releaseTitle.replace(/_/g, " ");
  if (!wantedIsCollected && parsed.collected) return "it is a collected edition, not the single issue";
  const core = tokenize(coreOf(text));
  const parent = significant(name.parentTitle).map((t) => t.text);
  const coreWords = words(withoutStopwords(core));
  const at = findRun(coreWords, parent);
  if (at < 0) return "the series is not named";
  // The series is followed by the issue (or a volume marker and then the issue), nothing else.
  let k = at + parent.length;
  const rest = coreWords.slice(k);
  if (rest.length > 0 && !/^\d+$/.test(rest[0]) && !["v", "vol", "volume", "c", "ch", "chapter", "issue", "no", "number"].includes(rest[0])) {
    return `"${rest[0]}" follows the series name`;
  }
  if (mediaType === "manga") {
    // A volume ("v05 (c036-044)") holds a run of chapters: it is the chapter wanted only if the run reaches it.
    if (parsed.chapters) return number >= parsed.chapters[0] && number <= parsed.chapters[1] ? null : "its chapters do not include the one wanted";
    if (parsed.volume != null && parsed.issue === parsed.volume) return "it is a volume with no chapter numbers";
  }
  if (parsed.range) return "it is a run of issues";
  // The issue is the first number after the series name (and its volume marker): "Spawn 300 Variant", "Saga - 054 - Title".
  const issueAfterSeries = (): number | null => {
    for (let i = 0; i < rest.length; i++) {
      if (!/^\d+$/.test(rest[i])) continue;
      const before = rest[i - 1];
      if (before === "v" || before === "vol" || before === "volume") continue;
      return Number(rest[i]);
    }
    return null;
  };
  const issue = mediaType === "manga" ? parsed.issue ?? issueAfterSeries() : issueAfterSeries() ?? parsed.issue;
  if (issue == null) return "no issue number could be read";
  return issue === number ? null : `it is issue ${issue}`;
}

/**
 * Why `releaseTitle` is not the wanted title for the media type, or null when it may be. Types the module has
 * no grammar for (video, podcast, ...) are never refused here.
 */
export function nonVideoRejection(releaseTitle: string, name: NonVideoName, mediaType: string): string | null {
  switch (mediaType) {
    case "author":
    case "audiobook":
      return bookRejection(releaseTitle, name, mediaType);
    case "artist":
      return albumRejection(releaseTitle, name);
    case "rom":
      return romRejection(releaseTitle, name);
    case "comic":
    case "manga":
      return comicRejection(releaseTitle, name, mediaType);
    default:
      return null;
  }
}

/** Types whose files can be replaced by a better format of the same album, book or issue (N24). ROMs have no ladder. */
const FORMAT_UPGRADE_TYPES = new Set(["artist", "author", "audiobook", "comic", "manga"]);
/** How much better (by nonVideoPreference) a release must be than the file's to replace it: lossy to lossless, mobi or
 * pdf to epub, cbr or pdf to cbz; never a bitrate step or an equal format. */
export const FORMAT_UPGRADE_STEP = 20;
const BEST_FORMAT_PREFERENCE = 100;

/**
 * The preference of the file an album, book or issue has, when a better format is worth searching for: null when
 * the type has no ladder, the release it came from is unknown, or it is already the best format.
 */
export function formatUpgradeFloor(mediaType: string, fileReleaseTitle: string | null | undefined): number | null {
  if (!FORMAT_UPGRADE_TYPES.has(mediaType) || !fileReleaseTitle) return null;
  const preference = nonVideoPreference(fileReleaseTitle, mediaType);
  return preference + FORMAT_UPGRADE_STEP > BEST_FORMAT_PREFERENCE + 5 ? null : preference;
}

/**
 * How much better one release of a title is than another of the same, for the types with no quality tiers:
 * the lossless rip over the lossy one, the ebook format a reader opens everywhere, the ROM dump in the
 * region the owner reads. Higher is better; only the order between releases of one title matters.
 */
export function nonVideoPreference(releaseTitle: string, mediaType: string): number {
  const t = releaseTitle.toLowerCase();
  switch (mediaType) {
    case "artist": {
      if (/\b(?:flac|alac|ape|wavpack|lossless|dsd|sacd)\b/.test(t)) return 100 + (/\b(?:24[- ]?bit|24[- ]\d{2,3}|hi-?res)\b/.test(t) ? 5 : 0);
      if (/\b(?:mp3|320|v0|256)\b/.test(t)) return /\b(?:320|v0)\b/.test(t) ? 60 : /\b256\b/.test(t) ? 55 : 45;
      if (/\b(?:aac|ogg|opus|m4a)\b/.test(t)) return 35;
      return 45;
    }
    case "author": {
      if (/\bepub\b/.test(t)) return 100;
      if (/\bazw3?\b/.test(t)) return 90;
      if (/\bmobi\b/.test(t)) return 70;
      if (/\bpdf\b/.test(t)) return 40;
      return 50;
    }
    case "audiobook": {
      if (/\bm4b\b/.test(t)) return 100;
      if (/\b(?:flac|alac)\b/.test(t)) return 80;
      if (/\bmp3\b/.test(t)) return 70;
      return 50;
    }
    case "comic":
    case "manga": {
      if (/\bcbz\b/.test(t)) return 100;
      if (/\bcbr\b/.test(t)) return 80;
      if (/\bpdf\b/.test(t)) return 40;
      return 60;
    }
    case "rom": {
      let score = 50;
      if (/\((?:[^)]*\b)?world\b/.test(t)) score += 10;
      else if (/\((?:[^)]*\b)?(?:usa|us)\b/.test(t)) score += 8;
      else if (/\((?:[^)]*\b)?europe\b/.test(t)) score += 5;
      else if (/\((?:[^)]*\b)?japan\b/.test(t)) score += 2;
      const rev = t.match(/\(rev\s*([a-z0-9]+)\)/);
      if (rev) score += /^\d+$/.test(rev[1]) ? Math.min(Number(rev[1]), 9) : rev[1].charCodeAt(0) - 96;
      if (/\[!\]/.test(t)) score += 3;
      if (/\[a\d*\]/.test(t)) score -= 3;
      if (/\((?:[^)]*\b)?(?:beta|proto|prototype|demo|sample|unl)\b/.test(t)) score -= 30;
      return score;
    }
    default:
      return 0;
  }
}
