/**
 * The text an indexer is asked for. Pure functions, no database: scheduler.ts, the interactive
 * search and the retry path all build their queries here, so one fix reaches every path.
 *
 * Indexers match the words of a query against release names, which scene groups write without
 * apostrophes, dots, accents or a leading "The" and with "and" for "&" (Sonarr's
 * SearchCriteriaBase.GetCleanSceneTitle, Lidarr's and Readarr's GetQueryTitle). A query written the
 * way the metadata provider spells the title ("Marvel's Agents of S.H.I.E.L.D.", "Léon: The
 * Professional") finds none of them on an all-words indexer.
 */

const LETTER_FOLDS: Record<string, string> = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ø": "o", "Ø": "O", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D",
};

/** The Latin letters without their accents ("Léon" -> "Leon", "Straße" -> "Strasse"). The marks of
 * other scripts are part of their letters (Cyrillic "й", Devanagari vowel signs) and stay. */
export function foldDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/([A-Za-z])[\u0300-\u036f]+/g, "$1")
    .replace(/[ßæÆœŒøØðÐþÞłŁđĐ]/g, (c) => LETTER_FOLDS[c])
    .normalize("NFC");
}

export interface CleanOptions {
  /** "and" (the default) writes " & " as "and", the way scene names do; "drop" leaves it out, for
   * music and books, whose names mostly keep or lose the "&" altogether. */
  ampersand?: "and" | "drop";
  /** "space" writes a dot as a space ("S.W.A.T." as "S W A T") instead of removing it ("SWAT"). */
  dots?: "space";
  /** What a "&" with no spaces round it ("AT&T") becomes instead of a split: "remove" ("ATT"),
   * "and" ("AT and T") or "joined-and" ("ATandT"). */
  bareAmpersand?: "remove" | "and" | "joined-and";
}

/**
 * Sonarr's GetCleanSceneTitle: no leading "The", " & " as "and", apostrophes and dots removed, every
 * other non-word run a single space, accents folded. "The Office (US)" -> "Office US",
 * "Marvel's Agents of S.H.I.E.L.D." -> "Marvels Agents of SHIELD". A "The" before a number stays
 * ("The 100", "The 4400"): "100" alone matches too much.
 */
export function cleanSceneTitle(title: string, opts: CleanOptions = {}): string {
  const folded = foldDiacritics(title).trim();
  let text = folded.replace(/^the\s+(?!\d)/i, "");
  text = opts.ampersand === "drop" ? text.replace(/\s&\s/g, " ") : text.replace(/\s&\s/g, " and ");
  text = text.replace(/[`'’‘´]/g, "");
  text = text.replace(/\./g, opts.dots === "space" ? " " : "");
  if (opts.bareAmpersand) text = text.replace(/&/g, opts.bareAmpersand === "remove" ? "" : opts.bareAmpersand === "and" ? " and " : "and");
  text = text.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
  // A title of nothing but punctuation has no words to search by: send it as it is.
  return text || folded;
}

/**
 * Other ways a scene may write a title whose punctuation carries words, when they differ from
 * cleanSceneTitle: "S.W.A.T." and "Evangelion 3.0" with their dots as spaces (a scene writes
 * "S.W.A.T" as "S W A T" to a search that splits on dots), "AT&T" as "ATT", "AT and T" and "ATandT".
 * The clean form is the main query; these are for an indexer it found nothing at.
 */
export function looseTitleVariants(title: string, opts: CleanOptions = {}): string[] {
  const main = cleanSceneTitle(title, opts).toLowerCase();
  const seen = new Set([main]);
  const out: string[] = [];
  const forms = [
    cleanSceneTitle(title, { ...opts, dots: "space" }),
    cleanSceneTitle(title, { ...opts, bareAmpersand: "remove" }),
    cleanSceneTitle(title, { ...opts, bareAmpersand: "and" }),
    cleanSceneTitle(title, { ...opts, bareAmpersand: "joined-and" }),
  ];
  for (const variant of forms) {
    const key = variant.toLowerCase();
    if (!variant || seen.has(key)) continue;
    seen.add(key);
    out.push(variant);
  }
  return out;
}

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** " S03E01"; the numbers are the scene's where the show has them. */
export function episodeSuffix(season: number, episode: number): string {
  return ` S${pad(season)}E${pad(episode)}`;
}

export function seasonSuffix(season: number): string {
  return ` S${pad(season)}`;
}

/** "2024-08-25" (or a full timestamp) as the "2024 08 25" a daily show's releases carry, with the
 * dashes a few trackers keep as the alternate. */
export function dailyDateWords(airDate: string): { spaced: string; dashed: string } {
  const day = airDate.slice(0, 10);
  return { spaced: day.replace(/-/g, " "), dashed: day };
}

export function absoluteSuffix(absolute: number): string {
  return ` ${pad(absolute)}`;
}

/** The movie convention (Radarr: "<clean title> <year>"). */
export function movieQuery(title: string, year: number | null | undefined): string {
  const clean = cleanSceneTitle(title);
  return year ? `${clean} ${year}` : clean;
}

/** A series, comic or manga title without its trailing "(2012)"/"(US)"-style qualifier, for the
 * types whose releases are never named by it. */
export function withoutQualifier(title: string): string {
  const stripped = title.replace(/\s*[(\[][^()\[\]]*[)\]]\s*$/, "").trim();
  return stripped || title;
}

/** The part of a book title Readarr searches by (Parser.SplitBookTitle): before a subtitle colon,
 * a " - " subtitle or a bracketed series note. "Mistborn: The Final Empire (Mistborn, #1)" ->
 * "Mistborn". */
export function mainBookTitle(title: string): string {
  const cut = title.search(/\s*(?::|\s-\s|\s[–—]\s|\(|\[)/);
  const main = (cut > 0 ? title.slice(0, cut) : title).trim();
  return main || title.trim();
}

/** An album's title without its bracketed edition notes ("Thriller (25th Anniversary Edition)"). */
export function albumQueryTitle(title: string): string {
  const stripped = title.replace(/\s*[(\[][^()\[\]]*[)\]]/g, "").trim();
  return stripped || title.trim();
}

/** The year in a trailing "(2012)" or "(2012-2018)" volume note of a comic's series name, or null. */
export function volumeYearOf(title: string): number | null {
  const m = title.match(/\(\s*((?:19|20)\d{2})\b[^()]*\)\s*$/);
  return m ? Number(m[1]) : null;
}

/** The issue or chapter number a Comic Vine ("#12 - Name") or MangaDex ("Chapter 1085 — Name")
 * title starts with. */
export function childNumberOf(title: string): number | null {
  const m = title.match(/^\s*(?:#|issue\s+|chapter\s+|ch\.?\s*|vol(?:ume)?\.?\s*)?(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function numberWords(n: number, width = 0): string {
  return Number.isInteger(n) ? pad(n, width) : String(n);
}

export interface SubItemQuery {
  query: string;
  /** Complete other queries, tried where the main one found nothing. */
  alternateQueries: string[];
}

/**
 * The query for one album, book, issue or chapter of a parent artist, author or series.
 *
 * - Books and audiobooks: author and main title (Readarr's tiers), then the title alone.
 * - Albums: artist and album without bracketed edition notes; "Various Artists" is "VA"; a
 *   self-titled album gets its year (Lidarr).
 * - Comics: "Series 012" (the number as the release names it) and "Series 12". Manga: "Series 1085".
 * - Anything else: the parent and the child as they are, cleaned.
 */
export function subItemQuery(type: string, parentTitle: string, subTitle: string, opts: { releaseYear?: number | null } = {}): SubItemQuery {
  const text = (value: string) => cleanSceneTitle(value, { ampersand: "drop" });
  const joined = (...parts: string[]) => parts.filter(Boolean).join(" ");
  /** The same query with the parent written another way ("R.E.M." as "R E M"), for each way there is. */
  const parentForms = (build: (parent: string) => string): string[] => looseTitleVariants(parentTitle, { ampersand: "drop" }).map(build);
  switch (type) {
    case "author":
    case "audiobook": {
      const book = text(mainBookTitle(subTitle));
      const author = text(parentTitle);
      return { query: joined(author, book), alternateQueries: [...parentForms((parent) => joined(parent, book)), ...(book ? [book] : [])] };
    }
    case "artist": {
      const album = text(albumQueryTitle(subTitle));
      const artist = /^various artists$/i.test(parentTitle.trim()) ? "VA" : text(parentTitle);
      if (artist === "VA") return { query: joined(artist, album), alternateQueries: album ? [album] : [] };
      const selfTitled = !!album && album.toLowerCase() === artist.toLowerCase();
      const year = selfTitled && opts.releaseYear ? String(opts.releaseYear) : "";
      // A self-titled album is asked by its year, and without it for a reissue dated another year.
      return {
        query: joined(artist, album, year),
        alternateQueries: [...(year ? [joined(artist, album)] : []), ...parentForms((parent) => joined(parent, album, year))],
      };
    }
    case "comic": {
      const series = text(withoutQualifier(parentTitle));
      const volumeYear = volumeYearOf(parentTitle);
      const n = childNumberOf(subTitle);
      if (n == null) return { query: joined(series, text(subTitle)), alternateQueries: [] };
      // Another volume of the series has an issue of the same number: the volume's year, when the
      // series name carries one, is in the main query, and the plain forms are for an indexer that
      // files the issue under another year (a cover date).
      const padded = joined(series, numberWords(n, 3));
      const plain = joined(series, numberWords(n));
      const forms = [padded, plain].filter((q, i, all) => all.indexOf(q) === i);
      if (volumeYear) return { query: joined(series, String(volumeYear), numberWords(n, 3)), alternateQueries: forms };
      return { query: padded, alternateQueries: forms.slice(1) };
    }
    case "manga": {
      const series = text(withoutQualifier(parentTitle));
      const n = childNumberOf(subTitle);
      if (n == null) return { query: joined(series, text(subTitle)), alternateQueries: [] };
      return { query: joined(series, numberWords(n)), alternateQueries: [joined(series, `c${numberWords(n, 3)}`), joined(series, "Chapter", numberWords(n))] };
    }
    default:
      return { query: joined(text(parentTitle), text(subTitle)), alternateQueries: [] };
  }
}

/** The query for a whole item that is searched as one release: a film is "<title> <year>", a ROM
 * only its title (No-Intro, Redump and scene names carry no year). */
export function singleItemQuery(type: string, title: string, year: number | null | undefined): string {
  return type === "rom" ? cleanSceneTitle(title) : movieQuery(title, year);
}

/** mIRC colour, bold, underline, italic, reverse and reset codes: a colourised announce channel
 * wraps every field in them, and none is part of the title or the URL. */
export function stripIrcFormatting(text: string): string {
  return text.replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/g, "").replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, "");
}
