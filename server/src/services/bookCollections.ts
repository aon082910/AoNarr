import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { albumYear } from "./discography.js";
import { isCollectionTitle, parseReleaseTitle, withoutCollectionWords, type ParsedRelease } from "./releaseParser.js";

/**
 * Collections of an author's books ("Terry Pratchett - Complete Collection (Books 1-41) [EPUB]"): the book counterpart of
 * discographies (discography.ts). One grab of such a release satisfies the wanted books it covers, and the importer files
 * each book's file under that book (bookCollectionImport.ts). This file decides which books a release covers and whether it
 * is worth grabbing; the search, queue and import sides call it. Books are collected more loosely than albums (a "Collection"
 * is very often another author's, or a series, or a mislabelled dump), so the automatic bar is higher than a discography's.
 */

/** Whether collections of books are grabbed at all (Settings, default on). */
export function collectionGrabsEnabled(): boolean {
  return getSetting("collectionGrabs") !== "0";
}

/** The key an author's search for a collection has in season_searches (an author has no seasons in it); -1 is the discography's. */
export const COLLECTION_SEARCH_KEY = -2;

/** An automatic search takes a collection only when it would add at least this many missing books. A release picked by hand has no minimum. */
export const MIN_WANTED_FOR_AUTOMATIC_COLLECTION = 3;

/** And at least this share of the books it covers: stricter than a discography's (25%), because collections are mislabelled more often. */
export const MIN_WANTED_SHARE_FOR_AUTOMATIC_COLLECTION = 0.3;

/** The library types whose books are grabbed as collections. */
export const COLLECTION_ITEM_TYPES: ReadonlySet<string> = new Set(["author"]);

export interface CollectionBook {
  id: number;
  title: string;
  releaseDate: string | null;
  monitored: boolean;
  hasFile: boolean;
  /** The series the book is tagged with (series_name), else the one its title names: "(Discworld, #1)". */
  seriesName: string | null;
  /** Its place in the series (series_position), else the number its title gives. */
  seriesPosition: number | null;
}

/** The series and number a book title names in its trailing bracket: "The Colour of Magic (Discworld, #1)". */
export function titleSeriesOf(title: string): { name: string; position: number } | null {
  const m = title.match(/\(([^()]*?)[,\s]*#\s*(\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;
  const name = m[1].replace(/[\s,]+$/, "").trim();
  return name ? { name, position: Number(m[2]) } : null;
}

/** A book's series and position: its own columns first, the title's bracket for what they leave out. */
export function bookSeriesOf(book: { title: string; seriesName?: string | null; seriesPosition?: number | null }): { name: string | null; position: number | null } {
  const fromTitle = titleSeriesOf(book.title);
  const name = book.seriesName?.trim() || fromTitle?.name || null;
  const position = book.seriesPosition != null && Number.isFinite(Number(book.seriesPosition)) ? Number(book.seriesPosition) : fromTitle?.position ?? null;
  return { name, position };
}

/** An author's books, as a collection is judged against them. */
export async function collectionBooksOf(mediaItemId: number): Promise<CollectionBook[]> {
  const rows = (await db
    .prepare("SELECT id, title, release_date, monitored, has_file, series_name, series_position FROM sub_items WHERE media_item_id = ? ORDER BY release_date, id")
    .all(mediaItemId)) as { id: number; title: string; release_date: string | null; monitored: number; has_file: number; series_name: string | null; series_position: number | string | null }[];
  return rows.map((row) => {
    const series = bookSeriesOf({ title: row.title, seriesName: row.series_name, seriesPosition: row.series_position == null ? null : Number(row.series_position) });
    return {
      id: Number(row.id),
      title: row.title,
      releaseDate: row.release_date,
      monitored: !!Number(row.monitored),
      hasFile: !!Number(row.has_file),
      seriesName: series.name,
      seriesPosition: series.position,
    };
  });
}

/** A book that is wanted from a collection: monitored, out, and without a file. */
export function isWantedBook(book: CollectionBook, isUnreleased: (releaseDate: string | null) => boolean): boolean {
  return book.monitored && !book.hasFile && !isUnreleased(book.releaseDate);
}

// ---- Names ----------------------------------------------------------------------------------------------------------

const ARTICLES = new Set(["the", "a", "an"]);
// Words of a release name that say what it is, not whose it is or which series.
const NAME_NOISE = new Set([
  ...ARTICLES, "of", "by", "epub", "epub3", "mobi", "azw", "azw3", "kfx", "pdf", "djvu", "fb2", "ebook", "ebooks", "book", "books", "novel", "novels", "retail",
  "kindle", "mp3", "m4b", "flac", "audiobook", "audiobooks", "library", "series", "saga", "set", "pack", "bundle", "complete", "collected", "full", "edition",
  "updated", "new", "ocr", "scan", "scans", "hq", "collection", "collections", "works", "stories", "all", "fixed", "layout", "unabridged", "abridged",
]);
const FOLDED_LETTERS: Record<string, string> = { æ: "ae", ø: "o", ß: "ss", œ: "oe" };
// Symbols a name uses for a letter ("Ke$ha").
const LETTER_SYMBOLS: Record<string, string> = { "!": "i", $: "s", "@": "a", "€": "e" };

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[æøßœ]/g, (c) => FOLDED_LETTERS[c])
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ");
}

function wordsOf(text: string, drop: ReadonlySet<string>): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !drop.has(word));
}

/** A name with the punctuation, spaces and a leading "The" taken out, for the spellings words cannot compare ("J.K." and "JK"). */
function compactName(text: string): string {
  const folded = fold(text)
    .replace(/[!$@€]/g, (c) => LETTER_SYMBOLS[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return folded.length > 3 && folded.startsWith("the") ? folded.slice(3) : folded;
}

const sameWords = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
const withoutInitials = (list: string[]) => list.filter((word) => word.length > 1);

/** What of a segment of a release name is left once the author's name is taken off it, or null when it does not carry it. */
function afterAuthor(segment: string, authorWords: string[], authorCompact: string): string[] | null {
  const segmentWords = wordsOf(segment, NAME_NOISE);
  if (segmentWords.length === 0) return null;
  const candidates = [segmentWords];
  // "Pratchett, Terry" is "Terry Pratchett".
  if (segment.includes(",")) candidates.push(wordsOf(segment.split(",").map((part) => part.trim()).reverse().join(" "), NAME_NOISE));
  for (const words of candidates) {
    if (sameWords(words, authorWords) || (authorCompact !== "" && words.join("") === authorCompact)) return [];
    // The initials may be left off or spelled out: "Ursula Le Guin" for "Ursula K. Le Guin".
    const bare = withoutInitials(words);
    const authorBare = withoutInitials(authorWords);
    if (bare.length >= 2 && sameWords(bare, authorBare)) return [];
  }
  // The name leads or ends the segment and something else is with it ("Stephen King Dark Tower"): what is left is for the caller to judge.
  if (authorWords.length >= 2) {
    if (segmentWords.length > authorWords.length && sameWords(segmentWords.slice(0, authorWords.length), authorWords)) return segmentWords.slice(authorWords.length);
    if (segmentWords.length > authorWords.length && sameWords(segmentWords.slice(-authorWords.length), authorWords)) return segmentWords.slice(0, -authorWords.length);
  }
  return null;
}

export interface CollectionNameFacts {
  /** The release names the author. */
  namesAuthor: boolean;
  /** The words of the name that are neither the author's nor a collection word: the series it may be of. */
  hint: string[];
}

/**
 * Whether a collection release is the named author's, and what else its name says: once the collection words, the book
 * numbers, the years and the format tags are taken off, a segment of the name (split by " - " and ":") is the author and the
 * rest is the series, if any. "Stephen King - The Dark Tower Collection" and "Stephen King Collection" name Stephen King;
 * "Stephen Kingsley - Complete Collection" does not. The spellings of J.K. / JK Rowling and "Pratchett, Terry" are one name.
 */
export function analyzeCollectionName(releaseTitle: string, author: string): CollectionNameFacts {
  const authorWords = wordsOf(author, ARTICLES);
  const authorCompact = compactName(author);
  if (authorWords.length === 0 && authorCompact === "") return { namesAuthor: false, hint: [] };
  const cleaned = withoutCollectionWords(releaseTitle.replace(/_/g, " "))
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ")
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const segments = cleaned
    .split(/\s*[:|]\s*|\s+[-–—~]\s+/)
    .map((segment) => segment.replace(/^[\s\-–—~:|,.]+|[\s\-–—~:|,.]+$/g, ""))
    .filter((segment) => segment !== "");
  for (let i = 0; i < segments.length; i++) {
    const rest = afterAuthor(segments[i], authorWords, authorCompact);
    if (rest === null) continue;
    const others = segments.filter((_, j) => j !== i).flatMap((segment) => wordsOf(segment, NAME_NOISE));
    return { namesAuthor: true, hint: [...rest, ...others].filter((word) => !/^\d+$/.test(word)) };
  }
  return { namesAuthor: false, hint: [] };
}

/** Whether a release names the author (the check of discography.releaseNamesArtist, for books). */
export function releaseNamesAuthor(releaseTitle: string, author: string): boolean {
  return analyzeCollectionName(releaseTitle, author).namesAuthor;
}

// ---- What a release covers ------------------------------------------------------------------------------------------------

/** Whether the words a release names are the series a book is in ("Dark Tower" and "The Dark Tower Series"). */
function seriesIs(hint: string[], seriesName: string | null): boolean {
  return !!seriesName && sameWords(hint, wordsOf(seriesName, NAME_NOISE));
}

export interface Coverage {
  /** The books the release holds, as far as its name tells. */
  covered: CollectionBook[];
  /** Why the library cannot place what the name says, when it cannot: `covered` is then every book the name leaves open. */
  problem: string | null;
}

/**
 * The books a collection covers. A name with years covers the books published in them; one that names a series the books of
 * that series; numbers ("Books 1-9", a trilogy) the books at those places in their series. A name with none of these covers
 * every book of the author. What the library cannot place (a series no book is tagged with, numbers when no book has a
 * series position) is a `problem`: the books it leaves open are returned, but an automatic grab is refused.
 */
export function coverageOf(parsed: NonNullable<ParsedRelease["collection"]>, hint: string[], books: CollectionBook[]): Coverage {
  let pool = books;
  let problem: string | null = null;
  const { kind, from, to } = parsed;
  if (from !== undefined && from >= 1000) {
    pool = pool.filter((book) => {
      const year = albumYear(book.releaseDate);
      return year != null && year >= from && (to === undefined || year <= to);
    });
  }
  if (hint.length > 0) {
    const named = pool.filter((book) => seriesIs(hint, bookSeriesOf(book).name));
    if (named.length > 0) pool = named;
    else problem = `It names "${hint.join(" ")}", which none of this author's books is tagged with as its series`;
  } else if (kind === "series") {
    // "Complete Series" of an author whose books are in one series is that series.
    const names = Array.from(new Set(pool.map((book) => bookSeriesOf(book).name).filter((name): name is string => !!name).map((name) => wordsOf(name, NAME_NOISE).join(" "))));
    if (names.length === 1) pool = pool.filter((book) => wordsOf(bookSeriesOf(book).name ?? "", NAME_NOISE).join(" ") === names[0]);
    else problem = "It is the complete series of the author, and does not say which";
  }
  if (from !== undefined && from < 1000) {
    const placed = pool.filter((book) => bookSeriesOf(book).position != null);
    if (placed.length === 0) {
      problem = problem ?? `It numbers the books ${from}${to !== undefined ? `-${to}` : ""}, and none of this author's books has a series position to tell which those are`;
    } else {
      pool = placed.filter((book) => {
        const position = bookSeriesOf(book).position!;
        return position >= from && position <= (to ?? from);
      });
    }
  }
  return { covered: pool, problem };
}

// ---- Formats ------------------------------------------------------------------------------------------------------------------

const AUDIO_FORMAT = /(?<![\p{L}\p{N}])(?:m4b|mp3|audio[ ._-]?books?|unabridged|abridged|narrated|audible|flac|aac|ogg)(?![\p{L}\p{N}])/iu;
const SPECIFIC_EBOOK_FORMAT = /(?<![\p{L}\p{N}])(?:epub3?|mobi|azw3?|kfx|pdf|djvu|fb2|lit|cbz|cbr)(?![\p{L}\p{N}])/giu;
const EBOOK_WORD = /(?<![\p{L}\p{N}])(?:e-?books?|kindle)(?![\p{L}\p{N}])/iu;
const IMPORTABLE_EBOOK = new Set(["epub", "epub3", "mobi", "azw", "azw3", "pdf"]);

/** Why the format a release names is not one the library type wants, or null (a name with no format passes: the importer files what it can). */
export function collectionFormatProblem(releaseTitle: string, mediaType: string): string | null {
  const audio = AUDIO_FORMAT.test(releaseTitle);
  const named = Array.from(releaseTitle.matchAll(SPECIFIC_EBOOK_FORMAT), (m) => m[0].toLowerCase());
  const ebook = named.length > 0 || EBOOK_WORD.test(releaseTitle);
  if (mediaType === "audiobook") return ebook && !audio ? "It is an ebook collection, and audiobooks are wanted" : null;
  if (audio && !ebook) return "It is an audiobook collection, and this library holds ebooks";
  if (named.length > 0 && !named.some((format) => IMPORTABLE_EBOOK.has(format))) return `Its format (${named[0]}) is not one this library imports`;
  return null;
}

// ---- The judge ------------------------------------------------------------------------------------------------------------------

export type CollectionVerdict =
  | { ok: true; covered: CollectionBook[]; wanted: CollectionBook[] }
  | { ok: false; reason: string; covered: CollectionBook[]; wanted: CollectionBook[]; isBook?: true };

export interface CollectionJudgeOptions {
  /** Fewest missing books the release must add. */
  minWanted: number;
  /** The share of the books it covers that must be missing (0 to 1). */
  minShare?: number;
  /** Whether a book's release date is still ahead (scheduler.isNotYetReleased). */
  isUnreleased: (releaseDate: string | null) => boolean;
  /** The library type: an ebook library takes no audiobook collection, an audiobook library no ebook one. Default: author. */
  mediaType?: string;
}

/** The library book whose own title is, or holds, the collection word ("The Complete Stories") when the release is named for it. */
export function bookNamedByRelease(releaseTitle: string, books: CollectionBook[]): CollectionBook | undefined {
  const compactRelease = compactName(releaseTitle);
  return books.find((book) => {
    if (!isCollectionTitle(book.title)) return false;
    const own = compactName(book.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
    return own.length >= 6 && compactRelease.includes(own);
  });
}

/**
 * Whether a collection release is worth grabbing for this author: it is a collection, of this author (not a series or a
 * namesake), in a format the library wants, covering books of which none is unreleased (a grab would file a book that is not
 * out), the library can place what it says, and enough of the books it covers are missing. `wanted` is what the grab is
 * recorded against. A book with the word in its own title is that book, not a collection.
 */
export function judgeCollection(releaseTitle: string, author: string, books: CollectionBook[], options: CollectionJudgeOptions): CollectionVerdict {
  const parsed = parseReleaseTitle(releaseTitle).collection;
  if (!parsed) return { ok: false, reason: "It is not a collection of books", covered: [], wanted: [] };
  const named = bookNamedByRelease(releaseTitle, books);
  if (named) return { ok: false, reason: `It is the book "${named.title}", not a collection`, covered: [], wanted: [], isBook: true };
  const formatProblem = collectionFormatProblem(releaseTitle, options.mediaType ?? "author");
  if (formatProblem) return { ok: false, reason: formatProblem, covered: [], wanted: [] };
  const facts = analyzeCollectionName(releaseTitle, author);
  if (!facts.namesAuthor) return { ok: false, reason: `It is not named for ${author}`, covered: [], wanted: [] };
  const { covered, problem } = coverageOf(parsed, facts.hint, books);
  const wanted = covered.filter((book) => isWantedBook(book, options.isUnreleased));
  if (problem) return { ok: false, reason: problem, covered, wanted };
  if (covered.length === 0) return { ok: false, reason: "None of this author's books are in what it spans", covered, wanted };
  const unreleased = covered.find((book) => options.isUnreleased(book.releaseDate));
  if (unreleased) return { ok: false, reason: `It would include "${unreleased.title}", which is not out yet`, covered, wanted };
  if (wanted.length < options.minWanted) {
    return {
      ok: false,
      reason:
        wanted.length === 0
          ? "It covers no book that is missing"
          : `It would add only ${wanted.length} missing book${wanted.length === 1 ? "" : "s"}; a collection is taken for at least ${options.minWanted}`,
      covered,
      wanted,
    };
  }
  if (options.minShare && wanted.length < Math.ceil(covered.length * options.minShare)) {
    return {
      ok: false,
      reason: `It would add only ${wanted.length} missing book${wanted.length === 1 ? "" : "s"} of the ${covered.length} it covers; the books are better searched one by one`,
      covered,
      wanted,
    };
  }
  return { ok: true, covered, wanted };
}

/** Whether a release name is a collection of books at all. */
export function isCollectionRelease(releaseTitle: string): boolean {
  return isCollectionTitle(releaseTitle) && !!parseReleaseTitle(releaseTitle).collection;
}

/** The titles of the releases that already filled books of this author: a collection that did is not taken again. */
export async function importedReleaseTitles(mediaItemId: number): Promise<Set<string>> {
  const rows = (await db
    .prepare("SELECT DISTINCT file_release_title AS title FROM sub_items WHERE media_item_id = ? AND file_release_title IS NOT NULL")
    .all(mediaItemId)) as { title: string }[];
  return new Set(rows.map((row) => row.title));
}
