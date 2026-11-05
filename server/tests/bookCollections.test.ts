import { describe, it, expect } from "vitest";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import {
  analyzeCollectionName,
  collectionFormatProblem,
  coverageOf,
  judgeCollection,
  releaseNamesAuthor,
  titleSeriesOf,
  type CollectionBook,
} from "../src/services/bookCollections.js";

const NOW = new Date("2026-11-04T00:00:00Z");
const isUnreleased = (date: string | null) => !!date && new Date(date) > NOW;

function book(id: number, title: string, releaseDate: string | null, extra: Partial<CollectionBook> = {}): CollectionBook {
  return { id, title, releaseDate, monitored: true, hasFile: false, seriesName: null, seriesPosition: null, ...extra };
}

/** Ten Discworld novels with their series positions, then two standalone books. */
function pratchett(): CollectionBook[] {
  const discworld = ["The Colour of Magic", "The Light Fantastic", "Equal Rites", "Mort", "Sourcery", "Wyrd Sisters", "Pyramids", "Guards! Guards!", "Eric", "Moving Pictures"];
  return [
    ...discworld.map((title, i) => book(i + 1, title, `${1983 + i}-01-01`, { seriesName: "Discworld", seriesPosition: i + 1 })),
    book(11, "Good Omens", "1990-05-01"),
    book(12, "Nation", "2008-09-01"),
  ];
}

describe("parsing a collection of books", () => {
  it.each([
    ["Terry Pratchett - Complete Collection [EPUB]", { kind: "complete" }],
    ["Terry Pratchett - Complete Works [epub]", { kind: "complete" }],
    ["Terry Pratchett - Collected Works", { kind: "complete" }],
    ["Terry Pratchett - Bibliography (1983-2015) [EPUB MOBI]", { kind: "complete", from: 1983, to: 2015 }],
    ["Stephen King Omnibus", { kind: "complete" }],
    ["Isaac Asimov Anthology", { kind: "complete" }],
    ["Stephen King Collection", { kind: "complete" }],
    ["Terry.Pratchett.Complete.Collection.EPUB-GRP", { kind: "complete" }],
    ["Terry Pratchett - Discworld Collection (Books 1-41)", { kind: "complete", from: 1, to: 41 }],
    ["Terry Pratchett - Discworld Books 1-41 [EPUB]", { kind: "range", from: 1, to: 41 }],
    ["Brandon Sanderson - Vol. 1-9", { kind: "range", from: 1, to: 9 }],
    ["Brandon Sanderson - Stormlight #1-#4", { kind: "range", from: 1, to: 4 }],
    ["Brandon Sanderson - Mistborn Volumes 01 to 07 EPUB", { kind: "range", from: 1, to: 7 }],
    ["James S. A. Corey - The Expanse - Complete Series (Books 1-9)", { kind: "series", from: 1, to: 9 }],
    ["Suzanne Collins - The Hunger Games Trilogy [EPUB]", { kind: "series", from: 1, to: 3 }],
    ["J.R.R. Tolkien - Middle-earth Box Set", { kind: "series" }],
    ["Dan Simmons - Hyperion Cantos Complete Saga", { kind: "series" }],
    // other languages
    ["Karl May - Gesamtausgabe [EPUB]", { kind: "complete" }],
    ["Emile Zola - Oeuvres complètes", { kind: "complete" }],
    ["Émile Zola - Œuvres complètes (EPUB)", { kind: "complete" }],
    ["Gabriel García Márquez - Obras completas", { kind: "complete" }],
    ["Лев Толстой - Полное собрание сочинений (FB2)", { kind: "complete" }],
    ["Дмитрий Глуховский - Библиография", { kind: "complete" }],
  ])("reads %s", (title, expected) => {
    expect(parseReleaseTitle(title).collection).toEqual(expected);
  });

  it("leaves every other release without the field", () => {
    for (const title of [
      "Terry Pratchett - Mort (1987) [EPUB]",
      "Terry Pratchett - Discworld 04 - Mort [MOBI]",
      "Stephen King - The Shining.epub",
      "Queen - Greatest Hits (1981) [FLAC]",
      "Show.S01E01.1080p.WEB-DL-GRP",
      "Some Movie 1999 1080p",
      // a run of numbers that goes down, or a bracket of bit rates, names no books
      "Some Book - Part 3-2",
      "Queen - A Night at the Opera [320-256]",
    ]) {
      expect(parseReleaseTitle(title).collection, title).toBeUndefined();
    }
  });

  it("does not read a bracket of numbers as books unless a collection word is with it", () => {
    expect(parseReleaseTitle("Terry Pratchett - Discworld (1-41) [EPUB]").collection).toBeUndefined();
    expect(parseReleaseTitle("Terry Pratchett - Discworld Collection (1-41) [EPUB]").collection).toEqual({ kind: "complete", from: 1, to: 41 });
  });

  it("takes a year span that ends before it starts as no span", () => {
    expect(parseReleaseTitle("Terry Pratchett - Bibliography 2015-1983").collection).toEqual({ kind: "complete" });
    expect(parseReleaseTitle("Terry Pratchett - Bibliography 1990-Present").collection).toEqual({ kind: "complete", from: 1990 });
  });

  it("is no episode or discography", () => {
    const parsed = parseReleaseTitle("Terry Pratchett - Discworld Complete Collection Books 1-41 [EPUB]");
    expect(parsed.seasonNumber).toBeNull();
    expect(parsed.episodeNumbers).toBeNull();
    expect(parsed.discography).toBeUndefined();
  });
});

describe("the author a collection names", () => {
  it.each([
    ["Terry Pratchett - Complete Collection [EPUB]", "Terry Pratchett", true],
    ["Terry Pratchett Complete Collection", "Terry Pratchett", true],
    ["Pratchett, Terry - Complete Works", "Terry Pratchett", true],
    ["Terry Pratchett - Discworld - Complete Collection (Books 1-41)", "Terry Pratchett", true],
    ["Discworld - Terry Pratchett - Books 1-41", "Terry Pratchett", true],
    ["Terry.Pratchett.Complete.Collection.EPUB", "Terry Pratchett", true],
    ["Terry.Pratchett.Complete.Collection.EPUB-GRP", "Terry Pratchett", true],
    ["Stephen.King.Complete.Collection.2019.RETAIL.eBook-GRP", "Stephen King", true],
    ["[Group] Terry Pratchett - Complete Collection (EPUB, MOBI, PDF)", "Terry Pratchett", true],
    // spellings
    ["J.K. Rowling - Complete Collection", "J.K. Rowling", true],
    ["JK Rowling - Complete Collection", "J.K. Rowling", true],
    ["J. K. Rowling Collection", "JK Rowling", true],
    ["Ursula Le Guin - Complete Works", "Ursula K. Le Guin", true],
    ["Tolkien, J.R.R. - Collection", "J.R.R. Tolkien", true],
    // not the author
    ["Stephen Kingsley - Complete Collection", "Stephen King", false],
    ["Terry Pratchett and Neil Gaiman - Good Omens Collection", "Terry Pratchett", true],
    ["Neil Gaiman - Complete Collection", "Terry Pratchett", false],
    ["Complete Collection of Fairy Tales", "Terry Pratchett", false],
    ["Complete Collection", "Terry Pratchett", false],
  ])("%s is %s's: %s", (title, author, expected) => {
    expect(releaseNamesAuthor(title, author)).toBe(expected);
  });

  it("gives the words left over as the series it may be of", () => {
    expect(analyzeCollectionName("Terry Pratchett - Discworld Novels 1-41 [EPUB]", "Terry Pratchett").hint).toEqual(["discworld"]);
    expect(analyzeCollectionName("Stephen King The Dark Tower Collection", "Stephen King").hint).toEqual(["dark", "tower"]);
    expect(analyzeCollectionName("Stephen King - Complete Collection [EPUB]", "Stephen King").hint).toEqual([]);
  });
});

describe("the series and place a book title names", () => {
  it("reads a bracket", () => {
    expect(titleSeriesOf("The Final Empire (Mistborn, #1)")).toEqual({ name: "Mistborn", position: 1 });
    expect(titleSeriesOf("A Game of Thrones (A Song of Ice and Fire #1)")).toEqual({ name: "A Song of Ice and Fire", position: 1 });
    expect(titleSeriesOf("Mort (Discworld, #4.5)")).toEqual({ name: "Discworld", position: 4.5 });
    expect(titleSeriesOf("Mort")).toBeNull();
  });
});

describe("what a collection covers", () => {
  it("is every book of the author when the name says no more", () => {
    const parsed = parseReleaseTitle("Terry Pratchett - Complete Collection").collection!;
    const { covered, problem } = coverageOf(parsed, [], pratchett());
    expect(covered).toHaveLength(12);
    expect(problem).toBeNull();
  });

  it("is the books published in the years it spans, and none that have no date", () => {
    const books = [...pratchett(), book(13, "Undated", null)];
    const parsed = parseReleaseTitle("Terry Pratchett - Bibliography (1983-1990)").collection!;
    expect(coverageOf(parsed, [], books).covered.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11]);
  });

  it("is the books at the places it numbers, by series position", () => {
    const parsed = parseReleaseTitle("Terry Pratchett - Discworld Books 1-4 [EPUB]").collection!;
    const hint = analyzeCollectionName("Terry Pratchett - Discworld Books 1-4 [EPUB]", "Terry Pratchett").hint;
    expect(coverageOf(parsed, hint, pratchett()).covered.map((b) => b.id)).toEqual([1, 2, 3, 4]);
  });

  it("reads the place from the title's bracket when the book has no position of its own", () => {
    const books = [
      book(1, "The Final Empire (Mistborn, #1)", "2006-07-17"),
      book(2, "The Well of Ascension (Mistborn, #2)", "2007-08-21"),
      book(3, "The Hero of Ages (Mistborn, #3)", "2008-10-14"),
      book(4, "Elantris", "2005-04-21"),
    ];
    const parsed = parseReleaseTitle("Brandon Sanderson - Mistborn Trilogy [EPUB]").collection!;
    const hint = analyzeCollectionName("Brandon Sanderson - Mistborn Trilogy [EPUB]", "Brandon Sanderson").hint;
    expect(coverageOf(parsed, hint, books).covered.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it("is the books of the series a name gives, whatever the other words say", () => {
    const books = [
      ...pratchett(),
      book(20, "The Wee Free Men (Tiffany Aching, #1)", "2003-05-01"),
      book(21, "A Hat Full of Sky (Tiffany Aching, #2)", "2004-05-01"),
    ];
    const parsed = parseReleaseTitle("Terry Pratchett - Tiffany Aching Complete Series").collection!;
    const hint = analyzeCollectionName("Terry Pratchett - Tiffany Aching Complete Series", "Terry Pratchett").hint;
    expect(coverageOf(parsed, hint, books).covered.map((b) => b.id)).toEqual([20, 21]);
  });

  it("calls a 'complete series' of an author with one series by that series, and of one with several, unplaceable", () => {
    const parsed = parseReleaseTitle("Terry Pratchett - Complete Series").collection!;
    const single = [book(1, "A", "2000-01-01", { seriesName: "Alpha" }), book(2, "B", "2001-01-01", { seriesName: "Alpha" }), book(3, "C", "2002-01-01")];
    expect(coverageOf(parsed, [], single)).toMatchObject({ problem: null });
    expect(coverageOf(parsed, [], single).covered.map((b) => b.id)).toEqual([1, 2]);
    const several = [...single, book(4, "D", "2003-01-01", { seriesName: "Beta" })];
    expect(coverageOf(parsed, [], several).problem).toMatch(/does not say which/);
  });

  it("cannot place numbers when no book of the author has a series or a position, and says so", () => {
    const books = [book(1, "Mort", "1987-11-12"), book(2, "Sourcery", "1988-05-01"), book(3, "Eric", "1990-05-01")];
    const parsed = parseReleaseTitle("Terry Pratchett - Books 1-9").collection!;
    const result = coverageOf(parsed, [], books);
    expect(result.problem).toMatch(/none of this author's books has a series or a place in one/);
    // What the name leaves open is returned for a hand pick to decide on.
    expect(result.covered).toHaveLength(3);
  });

  it("takes the books of the series it names when none of them has a position", () => {
    const books = [
      book(1, "Mort", "1987-11-12", { seriesName: "Discworld" }),
      book(2, "Sourcery", "1988-05-01", { seriesName: "Discworld" }),
      book(3, "Good Omens", "1990-05-01"),
    ];
    const parsed = parseReleaseTitle("Terry Pratchett - Discworld Books 1-9").collection!;
    const hint = analyzeCollectionName("Terry Pratchett - Discworld Books 1-9", "Terry Pratchett").hint;
    const result = coverageOf(parsed, hint, books);
    expect(result.problem).toBeNull();
    expect(result.covered.map((b) => b.id)).toEqual([1, 2]);
  });

  it("takes the books that are in a series at all when it names none and none has a position", () => {
    const books = [book(1, "Mort", "1987-11-12", { seriesName: "Discworld" }), book(2, "Dune", "1965-08-01", { seriesName: "Dune" }), book(3, "Good Omens", "1990-05-01")];
    const parsed = parseReleaseTitle("Terry Pratchett - Books 1-9").collection!;
    const result = coverageOf(parsed, [], books);
    expect(result.problem).toBeNull();
    expect(result.covered.map((b) => b.id)).toEqual([1, 2]);
  });

  it("cannot place a series that none of the books is tagged with", () => {
    const parsed = parseReleaseTitle("Terry Pratchett - Rincewind Complete Series").collection!;
    const hint = analyzeCollectionName("Terry Pratchett - Rincewind Complete Series", "Terry Pratchett").hint;
    expect(coverageOf(parsed, hint, pratchett()).problem).toMatch(/"rincewind", which none of this author's books is tagged/);
  });
});

describe("the format a collection is in", () => {
  it("refuses an audiobook collection for an ebook library, and the other way round", () => {
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [M4B]", "author")).toMatch(/audiobook/);
    expect(collectionFormatProblem("Terry Pratchett - Complete Audiobook Collection [MP3]", "author")).toMatch(/audiobook/);
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [EPUB]", "audiobook")).toMatch(/ebook collection/);
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [M4B]", "audiobook")).toBeNull();
  });

  it("takes a collection of ebooks in several formats, or in none named", () => {
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [EPUB, MOBI, PDF]", "author")).toBeNull();
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection", "author")).toBeNull();
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection eBooks", "author")).toBeNull();
    // an audiobook release that also ships the ebooks is still one the library can use
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [EPUB + MP3]", "author")).toBeNull();
  });

  it("refuses a format the library cannot import", () => {
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [DJVU]", "author")).toMatch(/not one this library imports/);
    expect(collectionFormatProblem("Terry Pratchett - Complete Collection [CBZ]", "author")).toMatch(/not one this library imports/);
  });
});

describe("judging a collection", () => {
  const options = { minWanted: 3, minShare: 0.3, isUnreleased };
  const books = pratchett();

  it("takes a collection of the author that adds enough missing books", () => {
    const verdict = judgeCollection("Terry Pratchett - Complete Collection [EPUB]", "Terry Pratchett", books, options);
    expect(verdict.ok).toBe(true);
    expect(verdict.wanted).toHaveLength(12);
    expect(verdict.covered).toHaveLength(12);
  });

  it("takes a scene-style name, group and all", () => {
    const verdict = judgeCollection("Terry.Pratchett.Complete.Collection.EPUB-GRP", "Terry Pratchett", books, options);
    expect(verdict.ok).toBe(true);
    expect(verdict.wanted).toHaveLength(12);
  });

  it("is not a collection when the release is not named like one", () => {
    const verdict = judgeCollection("Terry Pratchett - Mort [EPUB]", "Terry Pratchett", books, options);
    expect(verdict).toMatchObject({ ok: false, reason: "It is not a collection of books" });
  });

  it("refuses another author's collection, and a namesake's", () => {
    expect(judgeCollection("Neil Gaiman - Complete Collection", "Terry Pratchett", books, options)).toMatchObject({ ok: false, reason: "It is not named for Terry Pratchett" });
    expect(judgeCollection("Terry Pratchett Jr - Complete Collection", "Terry Pratchett", books, options).ok).toBe(false);
  });

  it("wants at least three missing books for an automatic grab, and one for a hand pick", () => {
    const fewMissing = books.map((b) => (b.id > 2 ? { ...b, hasFile: true } : b));
    const automatic = judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", fewMissing, options);
    expect(automatic).toMatchObject({ ok: false, reason: "It would add only 2 missing books; a collection is taken for at least 3" });
    // A hand pick has neither the minimum nor the share.
    expect(judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", fewMissing, { minWanted: 1, isUnreleased }).ok).toBe(true);
    const none = books.map((b) => ({ ...b, hasFile: true }));
    expect(judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", none, { ...options, minWanted: 1 })).toMatchObject({ ok: false, reason: "It covers no book that is missing" });
  });

  it("wants 30% of the books it covers missing, stricter than a discography's quarter", () => {
    // 3 of 12 missing is 25%: enough for a discography, not for a collection.
    const mostlyOwned = books.map((b) => (b.id > 3 ? { ...b, hasFile: true } : b));
    const verdict = judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", mostlyOwned, options);
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { reason: string }).reason).toMatch(/3 missing books of the 12 it covers/);
    // 4 of 12 is a third.
    const fourMissing = books.map((b) => (b.id > 4 ? { ...b, hasFile: true } : b));
    expect(judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", fourMissing, options).ok).toBe(true);
  });

  it("does not count unmonitored books or those with files as wanted", () => {
    const mixed = books.map((b) => (b.id === 1 ? { ...b, hasFile: true } : b.id === 2 ? { ...b, monitored: false } : b));
    const verdict = judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", mixed, options);
    expect(verdict.ok).toBe(true);
    expect(verdict.wanted.map((b) => b.id)).not.toContain(1);
    expect(verdict.wanted.map((b) => b.id)).not.toContain(2);
    expect(verdict.covered).toHaveLength(12);
  });

  it("refuses a release that would contain a book that is not out yet", () => {
    const withUpcoming = [...books, book(30, "The Next Book", "2999-01-01")];
    const verdict = judgeCollection("Terry Pratchett - Complete Collection", "Terry Pratchett", withUpcoming, options);
    expect(verdict).toMatchObject({ ok: false, reason: 'It would include "The Next Book", which is not out yet' });
    // Years that stop before it are fine.
    expect(judgeCollection("Terry Pratchett - Bibliography (1983-2015)", "Terry Pratchett", withUpcoming, options).ok).toBe(true);
  });

  it("is a book, not a collection, when the book has the word in its own title", () => {
    const stories = [book(1, "The Complete Stories", "1971-01-01"), ...pratchett().slice(0, 5)];
    const verdict = judgeCollection("Terry Pratchett - The Complete Stories [EPUB]", "Terry Pratchett", stories, { ...options, minWanted: 1 });
    expect(verdict).toMatchObject({ ok: false, isBook: true });
    // The same release for a library without that book is a collection.
    expect(judgeCollection("Terry Pratchett - The Complete Stories [EPUB]", "Terry Pratchett", pratchett(), { ...options, minWanted: 1 }).ok).toBe(true);
  });

  it("refuses the wrong format", () => {
    expect(judgeCollection("Terry Pratchett - Complete Collection [M4B]", "Terry Pratchett", books, options)).toMatchObject({ ok: false, reason: expect.stringMatching(/audiobook/) });
    expect(judgeCollection("Terry Pratchett - Complete Collection [M4B]", "Terry Pratchett", books, { ...options, mediaType: "audiobook" }).ok).toBe(true);
  });

  it("covers the books of a range by their place in the series", () => {
    const verdict = judgeCollection("Terry Pratchett - Discworld Books 1-4 [EPUB]", "Terry Pratchett", books, { ...options, minWanted: 3 });
    expect(verdict.ok).toBe(true);
    expect(verdict.covered.map((b) => b.id)).toEqual([1, 2, 3, 4]);
    // 4 of the 10 Discworld books are owned: the 1-4 range now adds none.
    const owned = books.map((b) => (b.id <= 4 ? { ...b, hasFile: true } : b));
    expect(judgeCollection("Terry Pratchett - Discworld Books 1-4 [EPUB]", "Terry Pratchett", owned, { ...options, minWanted: 1 })).toMatchObject({ ok: false, reason: "It covers no book that is missing" });
  });

  it("refuses a range the library cannot place, but hands back what it leaves open for a hand pick to decide on", () => {
    const unplaced = [book(1, "Mort", "1987-11-12"), book(2, "Sourcery", "1988-05-01"), book(3, "Eric", "1990-05-01"), book(4, "Nation", "2008-09-01")];
    const verdict = judgeCollection("Terry Pratchett - Books 1-9 [EPUB]", "Terry Pratchett", unplaced, options);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/none of this author's books has a series or a place in one/);
    expect(verdict.wanted).toHaveLength(4);
    // With a series named as well, the series is what the library cannot place.
    const named = judgeCollection("Terry Pratchett - Discworld Books 1-9 [EPUB]", "Terry Pratchett", unplaced, options);
    expect((named as { reason: string }).reason).toMatch(/names "discworld"/);
    expect(named.wanted).toHaveLength(4);
  });

  it("refuses a series that the library has no books of", () => {
    const verdict = judgeCollection("Terry Pratchett - Rincewind Collection", "Terry Pratchett", books, options);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/tagged with as its series/);
  });

  it("covers nothing when the years it spans hold no book", () => {
    expect(judgeCollection("Terry Pratchett - Bibliography (1950-1960)", "Terry Pratchett", books, options)).toMatchObject({
      ok: false,
      reason: "None of this author's books are in what it spans",
    });
  });
});
