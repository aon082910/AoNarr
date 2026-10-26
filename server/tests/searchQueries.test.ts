import { describe, it, expect } from "vitest";
import {
  absoluteSuffix,
  looseTitleVariants,
  albumQueryTitle,
  childNumberOf,
  cleanSceneTitle,
  dailyDateWords,
  episodeSuffix,
  foldDiacritics,
  mainBookTitle,
  movieQuery,
  seasonSuffix,
  singleItemQuery,
  stripIrcFormatting,
  subItemQuery,
  withoutQualifier,
} from "../src/services/searchQueries.js";

describe("cleanSceneTitle (Sonarr's GetCleanSceneTitle)", () => {
  it("drops a leading The, apostrophes, dots, brackets and accents, and writes & as and", () => {
    expect(cleanSceneTitle("The Office (US)")).toBe("Office US");
    expect(cleanSceneTitle("Marvel's Agents of S.H.I.E.L.D.")).toBe("Marvels Agents of SHIELD");
    expect(cleanSceneTitle("Léon: The Professional")).toBe("Leon The Professional");
    expect(cleanSceneTitle("Mr. & Mrs. Smith")).toBe("Mr and Mrs Smith");
    expect(cleanSceneTitle("Law & Order: SVU")).toBe("Law and Order SVU");
    expect(cleanSceneTitle("Straße")).toBe("Strasse");
    expect(cleanSceneTitle("Shōgun")).toBe("Shogun");
  });

  it("keeps a title that is all digits, a lone The, and a title with no words", () => {
    expect(cleanSceneTitle("24")).toBe("24");
    expect(cleanSceneTitle("The")).toBe("The");
    expect(cleanSceneTitle("The The")).toBe("The");
    expect(cleanSceneTitle("!!!")).toBe("!!!");
  });

  it("keeps a The before a number, which alone would match too much", () => {
    expect(cleanSceneTitle("The 100")).toBe("The 100");
    expect(cleanSceneTitle("The 4400")).toBe("The 4400");
    expect(cleanSceneTitle("The Wire")).toBe("Wire");
  });

  it("keeps other scripts whole, with the marks that are part of their letters", () => {
    expect(cleanSceneTitle("進撃の巨人")).toBe("進撃の巨人");
    expect(cleanSceneTitle("Война и мир")).toBe("Война и мир");
    expect(cleanSceneTitle("Йога: ёж")).toBe("Йога ёж");
    expect(cleanSceneTitle("हिन्दी फिल्म")).toBe("हिन्दी फिल्म");
    expect(cleanSceneTitle("ภาพยนตร์ไทย")).toBe("ภาพยนตร์ไทย");
  });

  it("leaves & out for music and books", () => {
    expect(cleanSceneTitle("Simon & Garfunkel", { ampersand: "drop" })).toBe("Simon Garfunkel");
  });
});

describe("looseTitleVariants", () => {
  it("offers the dotted initialisms and decimals with their dots as spaces, and a joined ampersand", () => {
    expect(looseTitleVariants("S.W.A.T.")).toEqual(["S W A T"]);
    expect(looseTitleVariants("Evangelion 3.0")).toEqual(["Evangelion 3 0"]);
    expect(looseTitleVariants("Marvel's Agents of S.H.I.E.L.D.")).toEqual(["Marvels Agents of S H I E L D"]);
    expect(looseTitleVariants("AT&T")).toEqual(["ATT", "AT and T", "ATandT"]);
    expect(looseTitleVariants("Q&A")).toEqual(["QA", "Q and A", "QandA"]);
  });

  it("offers nothing for a title with no punctuation that carries words", () => {
    expect(looseTitleVariants("The Office (US)")).toEqual([]);
    expect(looseTitleVariants("Law & Order")).toEqual([]);
  });
});

describe("foldDiacritics", () => {
  it("removes accents and writes ligatures and stroked letters out", () => {
    expect(foldDiacritics("Ærø Œuvre Łódź Þór Ðe")).toBe("AEro OEuvre Lodz Thor De");
  });
});

describe("query suffixes", () => {
  it("writes the numbers the way a release does", () => {
    expect(episodeSuffix(3, 1)).toBe(" S03E01");
    expect(episodeSuffix(12, 105)).toBe(" S12E105");
    expect(seasonSuffix(2)).toBe(" S02");
    expect(absoluteSuffix(5)).toBe(" 05");
    expect(absoluteSuffix(1085)).toBe(" 1085");
  });

  it("writes a daily date as words, with the dashed form beside it", () => {
    expect(dailyDateWords("2024-08-25")).toEqual({ spaced: "2024 08 25", dashed: "2024-08-25" });
    expect(dailyDateWords("2024-08-25T00:00:00.000Z")).toEqual({ spaced: "2024 08 25", dashed: "2024-08-25" });
  });
});

describe("film and ROM queries", () => {
  it("asks for a film by its clean title and year, and a ROM by its title alone", () => {
    expect(movieQuery("The Matrix", 1999)).toBe("Matrix 1999");
    expect(movieQuery("Se7en", null)).toBe("Se7en");
    expect(singleItemQuery("movie", "Dune: Part Two", 2024)).toBe("Dune Part Two 2024");
    expect(singleItemQuery("rom", "Super Mario Bros.", 1985)).toBe("Super Mario Bros");
  });
});

describe("title helpers", () => {
  it("cuts a book's title where a scene or Readarr would", () => {
    expect(mainBookTitle("Mistborn: The Final Empire (Mistborn, #1)")).toBe("Mistborn");
    expect(mainBookTitle("Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones")).toBe("Atomic Habits");
    expect(mainBookTitle("Title - Subtitle")).toBe("Title");
    expect(mainBookTitle("Spider-Man")).toBe("Spider-Man");
    expect(mainBookTitle("Dune")).toBe("Dune");
  });

  it("takes bracketed edition notes off an album's title, and a trailing qualifier off a series' name", () => {
    expect(albumQueryTitle("Thriller (25th Anniversary Edition)")).toBe("Thriller");
    expect(albumQueryTitle("Abbey Road [Remastered]")).toBe("Abbey Road");
    expect(withoutQualifier("Saga (2012)")).toBe("Saga");
    expect(withoutQualifier("Batman")).toBe("Batman");
  });

  it("reads the number a Comic Vine or MangaDex child starts with", () => {
    expect(childNumberOf("#12 - Chapter Twelve")).toBe(12);
    expect(childNumberOf("Chapter 1085 — Romance Dawn")).toBe(1085);
    expect(childNumberOf("Issue 5")).toBe(5);
    expect(childNumberOf("12")).toBe(12);
    expect(childNumberOf("#2.5")).toBe(2.5);
    expect(childNumberOf("Annual")).toBeNull();
  });
});

describe("subItemQuery", () => {
  it("asks for a book by its author and main title, then by the title alone", () => {
    expect(subItemQuery("author", "Brandon Sanderson", "Mistborn: The Final Empire (Mistborn, #1)")).toEqual({
      query: "Brandon Sanderson Mistborn",
      alternateQueries: ["Mistborn"],
    });
    expect(subItemQuery("audiobook", "James Clear", "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones")).toEqual({
      query: "James Clear Atomic Habits",
      alternateQueries: ["Atomic Habits"],
    });
  });

  it("asks for an album without its edition notes, a compilation as VA, and a self-titled album with its year", () => {
    expect(subItemQuery("artist", "Michael Jackson", "Thriller (25th Anniversary Edition)").query).toBe("Michael Jackson Thriller");
    expect(subItemQuery("artist", "Various Artists", "Now That's What I Call Music! 100")).toEqual({
      query: "VA Now Thats What I Call Music 100",
      alternateQueries: ["Now Thats What I Call Music 100"],
    });
    expect(subItemQuery("artist", "Weezer", "Weezer", { releaseYear: 2001 }).query).toBe("Weezer Weezer 2001");
    expect(subItemQuery("artist", "Weezer", "Weezer").query).toBe("Weezer Weezer");
    expect(subItemQuery("artist", "Queen", "Greatest Hits", { releaseYear: 1981 }).query).toBe("Queen Greatest Hits");
  });

  it("asks for a comic issue by its padded number, then the plain one, and a manga chapter by its number", () => {
    // The volume's year is in the query, so another volume's issue 12 is not what comes back; the plain forms are for the rest.
    expect(subItemQuery("comic", "Saga (2012)", "#12 - Chapter Twelve")).toEqual({ query: "Saga 2012 012", alternateQueries: ["Saga 012", "Saga 12"] });
    expect(subItemQuery("comic", "Batman (2016-2021)", "#12")).toEqual({ query: "Batman 2016 012", alternateQueries: ["Batman 012", "Batman 12"] });
    expect(subItemQuery("comic", "Saga", "#12 - Chapter Twelve")).toEqual({ query: "Saga 012", alternateQueries: ["Saga 12"] });
    expect(subItemQuery("comic", "Batman", "#1000")).toEqual({ query: "Batman 1000", alternateQueries: [] });
    expect(subItemQuery("comic", "Saga", "Annual")).toEqual({ query: "Saga Annual", alternateQueries: [] });
    expect(subItemQuery("manga", "One Piece", "Chapter 1085 — Romance Dawn")).toEqual({
      query: "One Piece 1085",
      alternateQueries: ["One Piece c1085", "One Piece Chapter 1085"],
    });
    expect(subItemQuery("manga", "One Piece", "Chapter 5").alternateQueries).toEqual(["One Piece c005", "One Piece Chapter 5"]);
  });

  it("also asks for the artist, author or series under the punctuation a scene may keep", () => {
    expect(subItemQuery("artist", "R.E.M.", "Murmur")).toEqual({ query: "REM Murmur", alternateQueries: ["R E M Murmur"] });
    expect(subItemQuery("author", "J.R.R. Tolkien", "The Hobbit")).toEqual({
      query: "JRR Tolkien Hobbit",
      alternateQueries: ["J R R Tolkien Hobbit", "Hobbit"],
    });
  });

  it("asks for a self-titled album without its year too, for a reissue dated another year", () => {
    expect(subItemQuery("artist", "Weezer", "Weezer", { releaseYear: 1994 })).toEqual({ query: "Weezer Weezer 1994", alternateQueries: ["Weezer Weezer"] });
  });

  it("writes any other child as its parent and its own title, cleaned", () => {
    expect(subItemQuery("course", "The Course", "Lesson: One")).toEqual({ query: "Course Lesson One", alternateQueries: [] });
  });
});

describe("stripIrcFormatting", () => {
  it("removes mIRC colour, bold, underline and reset codes and nothing else", () => {
    const line = "\u0002New Torrent:\u0002 \u000304Show.Name.S01E05.1080p.WEB.h264-GRP\u0003 - \u000312,01https://tracker.example/dl/1\u000F";
    expect(stripIrcFormatting(line)).toBe("New Torrent: Show.Name.S01E05.1080p.WEB.h264-GRP - https://tracker.example/dl/1");
    expect(stripIrcFormatting("\u001Funderlined\u001F \u001Ditalic\u001D")).toBe("underlined italic");
    expect(stripIrcFormatting("plain 24 text")).toBe("plain 24 text");
  });
});
