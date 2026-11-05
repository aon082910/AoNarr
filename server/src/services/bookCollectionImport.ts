/**
 * Which book a file of a downloaded collection is. Readarr identifies a book's files by the metadata inside them; here a
 * collection is told apart by its file names (and, for a book in a folder of its own, the folder's name), which is how
 * every ebook collection is laid out: "Terry Pratchett - Discworld 01 - The Colour of Magic (1983).epub". The match is the
 * strictest one: once the author, the year, the series and its number, the edition and the format are taken off a name, what
 * is left must be the book's title word for word. A file that fits no book, or more than one, is not placed. The ebook's
 * own embedded title is not read.
 */

export interface MatchableBook {
  id: number;
  title: string;
  seriesName: string | null;
  seriesPosition: number | null;
  /** Whether the grab was for this book. Matched all the same, so a file of a book that is in the library already is not
   * mistaken for a wanted book of a similar name. */
  target: boolean;
}

export interface BookFile {
  /** Where it is; only used to tell files apart. */
  path: string;
  /** Its name without the extension. */
  name: string;
  ext: string;
  size: number;
  /** The name of the folder it is in, when that is not the folder of the whole release: a book that has a folder of its own. */
  folder: string | null;
}

export type FileMatch =
  | { kind: "book"; bookId: number; target: boolean }
  | { kind: "unmatched"; reason: string }
  | { kind: "ambiguous"; reason: string };

/** The formats a book is filed in, best first (the order the importer prefers them in). */
export const BOOK_FORMAT_ORDER = [".epub", ".azw3", ".azw", ".mobi", ".pdf"];

const ARTICLES = new Set(["the", "a", "an"]);
const FILE_NOISE = new Set([...ARTICLES, "epub", "epub3", "mobi", "azw", "azw3", "pdf", "ebook", "ebooks", "retail", "kindle", "mp3", "m4b", "ocr", "scan", "hq", "calibre"]);
const SERIES_NOISE = new Set([...ARTICLES, "series", "saga", "trilogy", "cycle", "books", "novels"]);
const POSITION_WORDS = new Set(["book", "vol", "volume", "part", "no", "nr", "number"]);
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const FOLDED_LETTERS: Record<string, string> = { æ: "ae", ø: "o", ß: "ss", œ: "oe" };
const YEAR_WORD = /^(?:1[5-9]|20)\d{2}$/;
// "Illustrated Edition", "2nd Edition", "Revised Ed.": an edition's name, which every release of a book words its own way.
const EDITION_PHRASE = /\b(?:(?:\d+(?:st|nd|rd|th)|illustrated|revised|updated|expanded|anniversary|deluxe|special|collector'?s|limited|annotated|international|original|new)\s+){0,2}(?:edition|ed\b)\.?/gi;
const POSITION_ONLY = /^\s*(?:(?:book|vol(?:ume)?|part|no|nr|number)\.?\s*|#\s*)?0*\d{1,3}(?:\.\d+)?\s*$/i;
const YEAR_ONLY = /^\s*(?:1[5-9]|20)\d{2}\s*$/;
const LEADING_POSITION = /^\s*(?:(?:book|vol(?:ume)?|part|no|nr|number)\.?\s*|#\s*)?0*\d{1,3}(?:\.\d+)?\s*[.\-–—:)]*\s+(?=\S)/i;

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[æøßœ]/g, (c) => FOLDED_LETTERS[c])
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ");
}

/** The words that identify a title: folded, without the articles and the given noise, numbers without their zeros, roman numerals as digits. */
function wordsOf(text: string, drop: ReadonlySet<string> = ARTICLES): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => (/^\d+$/.test(word) ? word.replace(/^0+(?=\d)/, "") : ROMAN[word] ?? word))
    .filter((word) => word !== "" && !drop.has(word));
}

const sameWords = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
const unbracketed = (text: string) => text.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");

function compact(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

interface Context {
  authorWords: string[];
  authorCompact: string;
  /** The words of each series name the author's books are in. */
  seriesWords: string[][];
}

function seriesNameOf(book: { title: string; seriesName: string | null }): string | null {
  if (book.seriesName?.trim()) return book.seriesName.trim();
  const m = book.title.match(/\(([^()]*?)[,\s]*#\s*\d+(?:\.\d+)?\s*\)/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/** The word lists that stand for a book: its title less brackets and editions, the part before a subtitle when no other book
 * has it too, and the subtitle alone when the part before it is the book's series ("Mistborn: The Final Empire"). */
export function bookKeys(book: MatchableBook, all: MatchableBook[]): string[][] {
  const base = unbracketed(book.title).replace(EDITION_PHRASE, " ");
  const keys: string[][] = [wordsOf(base)];
  const parts = base.split(/\s*:\s*|\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const main = wordsOf(parts[0]);
    const mainOf = (other: MatchableBook) => wordsOf(unbracketed(other.title).replace(EDITION_PHRASE, " ").split(/\s*:\s*|\s+[-–—]\s+/)[0]);
    const shared = all.some((other) => other.id !== book.id && (sameWords(mainOf(other), main) || sameWords(wordsOf(unbracketed(other.title)), main)));
    if (main.length > 0 && !shared) keys.push(main);
    const series = seriesNameOf(book);
    if (parts.length === 2 && series && sameWords(main, wordsOf(series, SERIES_NOISE))) keys.push(wordsOf(parts[1]));
  }
  return keys.filter((key) => key.length > 0);
}

/** Whether a segment of a file name is the author's name: spelled out, run together, last name first, initials left off, or the surname alone. */
function isAuthor(segment: string, ctx: Context, allowSurname: boolean): boolean {
  const words = wordsOf(segment);
  if (words.length === 0) return false;
  if (sameWords(words, ctx.authorWords) || (ctx.authorCompact !== "" && words.join("") === ctx.authorCompact)) return true;
  if (segment.includes(",")) {
    const flipped = wordsOf(segment.split(",").map((part) => part.trim()).reverse().join(" "));
    if (sameWords(flipped, ctx.authorWords) || (ctx.authorCompact !== "" && flipped.join("") === ctx.authorCompact)) return true;
  }
  const bare = words.filter((word) => word.length > 1);
  const authorBare = ctx.authorWords.filter((word) => word.length > 1);
  if (bare.length >= 2 && sameWords(bare, authorBare)) return true;
  return allowSurname && ctx.authorWords.length >= 2 && sameWords(words, ctx.authorWords.slice(-1));
}

/** Whether a segment is a series' name, with or without its number ("Discworld", "Discworld 01", "Discworld Book 1"). */
function isSeriesSegment(segment: string, ctx: Context): boolean {
  const words = wordsOf(segment, SERIES_NOISE);
  if (words.length === 0) return false;
  const trimmed = [...words];
  while (trimmed.length > 1 && (/^\d+$/.test(trimmed[trimmed.length - 1]) || POSITION_WORDS.has(trimmed[trimmed.length - 1]))) trimmed.pop();
  return ctx.seriesWords.some((series) => sameWords(words, series) || sameWords(trimmed, series));
}

/** Every way a name can read as a book's title, as word lists. */
function readings(name: string, ctx: Context): string[][] {
  const text = unbracketed(name.replace(/_/g, " ").replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, " "))
    .replace(EDITION_PHRASE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const spaced = text.split(/\s+[-–—~|]\s+/).map((segment) => segment.trim()).filter(Boolean);
  // "Pratchett-Mort": a name with no spaced separator may still be author, then title.
  const tight = spaced.length === 1 ? text.split(/\s*[-–—]\s*/).map((segment) => segment.trim()).filter(Boolean) : [];
  const out = new Map<string, string[]>();
  const add = (words: string[]) => {
    if (words.length > 0) out.set(words.join(" "), words);
  };
  for (const segments of [spaced, tight]) {
    if (segments.length === 0) continue;
    // What is left of the name once the author and the numbers are taken off; a title can be a series' name ("Dune") or a
    // year ("1984"), so the variants that keep those are read as well.
    const dropping = (series: boolean, years: boolean) =>
      segments.filter((segment) => {
        if (segments.length === 1) return true;
        if (isAuthor(segment, ctx, true) || POSITION_ONLY.test(segment)) return false;
        if ((years && YEAR_ONLY.test(segment)) || (series && isSeriesSegment(segment, ctx))) return false;
        return wordsOf(segment, FILE_NOISE).length > 0;
      });
    for (const kept of [dropping(true, true), dropping(false, true), dropping(false, false)]) {
      if (kept.length > 0) addReadings(kept.join(" "), ctx, add);
    }
  }
  return Array.from(out.values());
}

/** The readings of the part of a name that is the title, with its numbers and tags in front or behind. */
function addReadings(joined: string, ctx: Context, add: (words: string[]) => void): void {
  const base = wordsOf(joined, FILE_NOISE);
  add(base);
  // "Terry Pratchett Mort": the author's name glued to the front or the back.
  if (ctx.authorWords.length > 0 && base.length > ctx.authorWords.length) {
    if (sameWords(base.slice(0, ctx.authorWords.length), ctx.authorWords)) add(base.slice(ctx.authorWords.length));
    if (sameWords(base.slice(-ctx.authorWords.length), ctx.authorWords)) add(base.slice(0, -ctx.authorWords.length));
  }
  // "01. The Colour of Magic", "Book 3 - Title": a number in front is the book's place, not its title.
  const noLead = joined.replace(LEADING_POSITION, "");
  if (noLead !== joined) add(wordsOf(noLead, FILE_NOISE));
  // "Discworld 01 The Colour of Magic": the series and its number in front.
  for (const series of ctx.seriesWords) {
    if (base.length > series.length && sameWords(base.slice(0, series.length), series)) {
      let rest = base.slice(series.length);
      while (rest.length > 1 && POSITION_WORDS.has(rest[0])) rest = rest.slice(1);
      if (rest.length > 1 && /^\d+$/.test(rest[0])) rest = rest.slice(1);
      add(rest);
    }
  }
  // "The Colour of Magic by Terry Pratchett".
  const by = base.lastIndexOf("by");
  if (by > 0 && (sameWords(base.slice(by + 1), ctx.authorWords) || base.slice(by + 1).join("") === ctx.authorCompact)) add(base.slice(0, by));
  // "Mort 1987": a year beside other words.
  const withoutYears = base.filter((word) => !YEAR_WORD.test(word));
  if (withoutYears.length > 0 && withoutYears.length < base.length) add(withoutYears);
}

/**
 * Tells each file of a downloaded collection which book it is. A file holds a book when its name, taken off the author, the year,
 * the series and its number, the edition and the format, is the book's title; a book in a folder of its own may carry the title
 * in the folder's name instead (when the file's own name names none). A file that fits two books, or none, is left alone.
 */
export function matchBookFiles(files: BookFile[], author: string, books: MatchableBook[]): Map<string, FileMatch> {
  const authorWords = wordsOf(author);
  const ctx: Context = {
    authorWords,
    authorCompact: compact(author),
    seriesWords: books
      .map((book) => seriesNameOf(book))
      .filter((name): name is string => !!name)
      .map((name) => wordsOf(name, SERIES_NOISE))
      .filter((words) => words.length > 0),
  };
  const byKey = new Map<string, MatchableBook[]>();
  for (const book of books) {
    for (const key of bookKeys(book, books)) {
      const k = key.join(" ");
      const list = byKey.get(k) ?? [];
      if (!list.includes(book)) list.push(book);
      byKey.set(k, list);
    }
  }
  const lookup = (candidates: string[][]): MatchableBook[] => {
    const found = new Map<number, MatchableBook>();
    for (const words of candidates) for (const book of byKey.get(words.join(" ")) ?? []) found.set(book.id, book);
    return Array.from(found.values());
  };
  // A folder names a book for its file only when everything in it is that one work (its formats).
  const dirOf = (file: BookFile) => file.path.slice(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")));
  const stems = new Map<string, Set<string>>();
  for (const file of files) {
    if (file.folder === null) continue;
    const key = dirOf(file);
    const set = stems.get(key) ?? new Set<string>();
    set.add(wordsOf(file.name, FILE_NOISE).join(" "));
    stems.set(key, set);
  }
  const result = new Map<string, FileMatch>();
  for (const file of files) {
    let found = lookup(readings(file.name, ctx));
    let via = file.name;
    if (found.length === 0 && file.folder !== null) {
      if ((stems.get(dirOf(file))?.size ?? 0) === 1) {
        found = lookup(readings(file.folder, ctx));
        via = file.folder;
      }
    }
    if (found.length === 0) {
      result.set(file.path, { kind: "unmatched", reason: `"${file.name}${file.ext}" is not the name of any book of this author` });
    } else if (found.length > 1) {
      result.set(file.path, { kind: "ambiguous", reason: `"${via}" fits ${found.length} books (${found.map((b) => `"${b.title}"`).join(", ")})` });
    } else {
      result.set(file.path, { kind: "book", bookId: found[0].id, target: found[0].target });
    }
  }
  return result;
}

/** The file to place for each book the files matched: the best format, then the larger file. The others are other copies of the book. */
export function chooseFilePerBook(files: BookFile[], matches: Map<string, FileMatch>): Map<number, { chosen: BookFile; others: BookFile[] }> {
  const byBook = new Map<number, BookFile[]>();
  for (const file of files) {
    const match = matches.get(file.path);
    if (match?.kind === "book") byBook.set(match.bookId, [...(byBook.get(match.bookId) ?? []), file]);
  }
  const rank = (file: BookFile) => {
    const at = BOOK_FORMAT_ORDER.indexOf(file.ext.toLowerCase());
    return at < 0 ? BOOK_FORMAT_ORDER.length : at;
  };
  const out = new Map<number, { chosen: BookFile; others: BookFile[] }>();
  for (const [bookId, list] of byBook) {
    const sorted = [...list].sort((a, b) => rank(a) - rank(b) || b.size - a.size || a.path.localeCompare(b.path));
    out.set(bookId, { chosen: sorted[0], others: sorted.slice(1) });
  }
  return out;
}
