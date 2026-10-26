import { describe, it, expect } from "vitest";
import { comicNumbersOf, nonVideoPreference, nonVideoRejection, romTitleOf } from "../src/services/nonVideoMatch.js";

const reject = (release: string, name: { title: string; parentTitle?: string; siblingTitles?: string[] }, type: string) => nonVideoRejection(release, name, type);

describe("books: the title stands on its own (Round 14, N1, N13)", () => {
  const dune = { title: "Dune", parentTitle: "Frank Herbert", siblingTitles: ["Dune Messiah", "Children of Dune", "God Emperor of Dune"] };

  it.each([
    "Frank Herbert - Dune (1965) [EPUB]",
    "Dune - Frank Herbert [EPUB]",
    "Dune by Frank Herbert (epub)",
    "Herbert, Frank - Dune (1965) [EPUB MOBI]",
    "Frank Herbert - Dune - 40th Anniversary Edition [EPUB]",
  ])("takes %s", (release) => {
    expect(reject(release, dune, "author")).toBeNull();
  });

  it.each([
    "Frank Herbert - Dune Messiah (1969) [EPUB]",
    "Frank Herbert - Children of Dune [EPUB]",
    "Frank Herbert - God Emperor of Dune [EPUB]",
    "Frank Herbert - Dune Chronicles 1-6 [EPUB]",
    "The Road to Dune - Frank Herbert, Brian Herbert [EPUB]",
    "Dune (Graphic Novel) Vol 1 - Frank Herbert [CBZ]",
    "Frank Herbert - Dune [M4B]",
  ])("refuses %s", (release) => {
    expect(reject(release, dune, "author")).not.toBeNull();
  });

  it("refuses series siblings, bundles, summaries and workbooks", () => {
    const foundation = { title: "Foundation", parentTitle: "Isaac Asimov", siblingTitles: ["Foundation and Empire", "Second Foundation"] };
    expect(reject("Isaac Asimov - Foundation [EPUB]", foundation, "author")).toBeNull();
    for (const bad of ["Isaac Asimov - Foundation and Empire [EPUB]", "Isaac Asimov - Second Foundation [EPUB]", "Isaac Asimov - Prelude to Foundation [EPUB]", "Isaac Asimov - Foundation 1-7 [EPUB]"]) {
      expect(reject(bad, foundation, "author"), bad).not.toBeNull();
    }
    const habits = { title: "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones", parentTitle: "James Clear" };
    expect(reject("James Clear - Atomic Habits (2018) [EPUB]", habits, "author")).toBeNull();
    expect(reject("James Clear - Atomic Habits - Tiny Changes Remarkable Results [EPUB]", habits, "author")).toBeNull();
    expect(reject("Summary of Atomic Habits by James Clear [EPUB]", habits, "author")).not.toBeNull();
    expect(reject("Atomic Habits Workbook - James Clear [PDF]", habits, "author")).not.toBeNull();
    const shining = { title: "The Shining", parentTitle: "Stephen King" };
    expect(reject("Stephen King - The Shining (1977) [EPUB]", shining, "author")).toBeNull();
    expect(reject("Stephen King - The Shining & Doctor Sleep [EPUB]", shining, "author")).not.toBeNull();
  });

  it("an audiobook wants audio, and an ebook is refused for it", () => {
    const hail = { title: "Project Hail Mary", parentTitle: "Andy Weir" };
    expect(reject("Andy Weir - Project Hail Mary [M4B]", hail, "audiobook")).toBeNull();
    expect(reject("Andy Weir - Project Hail Mary [EPUB]", hail, "audiobook")).not.toBeNull();
  });
});

describe("music: the album stands on its own (Round 14, N2)", () => {
  const album = (artist: string, title: string) => ({ title, parentTitle: artist });

  it.each([
    ["Queen", "Greatest Hits", "Queen - Greatest Hits [FLAC]"],
    ["Queen", "Greatest Hits", "Queen-Greatest_Hits-1981-FLAC"],
    ["Michael Jackson", "Thriller", "Michael Jackson - Thriller (1982) [FLAC]"],
    ["Michael Jackson", "Thriller", "Michael Jackson - Thriller (Deluxe Edition) [FLAC 24-96]"],
    ["Pink Floyd", "The Wall", "Pink Floyd - The Wall (1979) [FLAC]"],
    ["Daft Punk", "Discovery", "Daft Punk - Discovery 2001 FLAC"],
  ])("takes %s / %s: %s", (artist, title, release) => {
    expect(reject(release, album(artist, title), "artist")).toBeNull();
  });

  it.each([
    ["Queen", "Greatest Hits", "Queen - Live Greatest Hits (2005) [FLAC]"],
    ["Fleetwood Mac", "Rumours", "Fleetwood Mac - Rumours Live (2023) [FLAC]"],
    ["Michael Jackson", "Thriller", "Michael Jackson - Thriller 25 (Super Deluxe Edition) [FLAC]"],
    ["Michael Jackson", "Thriller", "Michael Jackson - Thriller - Live (2010) [MP3]"],
    ["The Beatles", "Abbey Road", "The Beatles - Abbey Road Sessions (Bootleg) [MP3]"],
    ["Taylor Swift", "Red", "Taylor Swift - 1989 (2014) [FLAC] (Red Edition)"],
    ["The Beatles", "1", "The Beatles - Abbey Road (2019 Mix) [FLAC] (Disc 1)"],
    ["Metallica", "Master of Puppets", "Metallica - Master of Puppets + Ride the Lightning (2CD) [FLAC]"],
    ["Pink Floyd", "The Wall", "Pink Floyd - Is There Anybody Out There - The Wall Live 1980-81 [FLAC]"],
    ["Daft Punk", "Discovery", "Daft Punk - Alive 2007 (Discovery Tour) [FLAC]"],
  ])("refuses %s / %s: %s", (artist, title, release) => {
    expect(reject(release, album(artist, title), "artist")).not.toBeNull();
  });

  it("takes a volume-one marker, a bit depth and sample rate pair, and refuses the second volume", () => {
    const hits = album("Queen", "Greatest Hits");
    expect(reject("Queen - Greatest Hits Vol. 1 [FLAC]", hits, "artist")).toBeNull();
    expect(reject("Queen - Greatest Hits 24-96 FLAC", hits, "artist")).toBeNull();
    expect(reject("Queen - Greatest Hits Vol. 2 [FLAC]", hits, "artist")).not.toBeNull();
    expect(reject("Queen - Greatest Hits 3 [FLAC]", hits, "artist")).not.toBeNull();
  });

  it("leaves a self-titled album to the looser test", () => {
    expect(reject("Metallica - Metallica (1991) [FLAC]", album("Metallica", "Metallica"), "artist")).toBeNull();
  });
});

describe("ROMs: the game's name is the title (Round 14, N3)", () => {
  const rom = (title: string) => ({ title });

  it("reads the title before the first bracket, a trailing \", The\" moved to the front", () => {
    expect(romTitleOf("Super Mario Bros. (World)")).toBe("Super Mario Bros.");
    expect(romTitleOf("Legend of Zelda, The (USA) (Rev 1).zip")).toBe("The Legend of Zelda");
    expect(romTitleOf("Doom - PC")).toBe("Doom");
  });

  it.each([
    ["Super Mario Bros.", "Super Mario Bros. (World)"],
    ["Super Mario Bros.", "Super Mario Bros. (USA) (Rev A)"],
    ["The Legend of Zelda", "Legend of Zelda, The (USA) (Rev 1)"],
    ["Final Fantasy VII", "Final Fantasy VII (USA) (Disc 1)"],
    ["Street Fighter II", "Street Fighter 2 (USA)"],
  ])("takes %s: %s", (title, release) => {
    expect(reject(release, rom(title), "rom")).toBeNull();
  });

  it.each([
    ["Super Mario Bros.", "New Super Mario Bros. (USA) (NDS)"],
    ["Super Mario Bros.", "Super Mario Bros. - The Lost Levels (Japan)"],
    ["Super Mario Bros.", "Super Mario Bros. Deluxe (USA, Europe) (GBC)"],
    ["Super Mario Bros.", "Super Mario Bros. (World) (Hack)"],
    ["Super Mario Bros.", "Super Mario Bros. (World) [b1]"],
    ["Super Mario Bros.", "Super Mario Bros. + Duck Hunt (USA)"],
    ["Tetris", "Tetris Effect - Connected (PS4)"],
    ["Final Fantasy VII", "Final Fantasy VII Remake Intergrade (PC)"],
    ["Doom", "Doom Eternal (PC)"],
    ["Mega Man 2", "Mega Man X2 (USA)"],
    ["Pokemon Red Version", "Pokemon - Fire Red Version (USA)"],
  ])("refuses %s: %s", (title, release) => {
    expect(reject(release, rom(title), "rom")).not.toBeNull();
  });

  it("a wanted title that is itself a hack still takes one", () => {
    expect(reject("Super Mario Bros. Hack (World) (Hack)", rom("Super Mario Bros. Hack (Hack)"), "rom")).toBeNull();
  });
});

describe("comics and manga: the series, then the issue (Round 14, N4, N10)", () => {
  const batman = { title: "#12 - The Court of Owls", parentTitle: "Batman (2016)" };

  it("reads the numbers of a name", () => {
    expect(comicNumbersOf("Batman 012 (2016) (Digital)")).toMatchObject({ issue: 12, collected: false, range: false });
    expect(comicNumbersOf("Batman 001-012 (2016)")).toMatchObject({ range: true });
    expect(comicNumbersOf("One Piece v05 (c036-044) (Digital)")).toMatchObject({ volume: 5, chapters: [36, 44] });
    expect(comicNumbersOf("Batman Annual 012 (1988)")).toMatchObject({ collected: true });
  });

  it.each(["Batman 012 (2016) (Digital)", "Batman 12 (2016)", "Batman #12 (2016)", "Batman v3 012 (2016)"])("takes %s", (release) => {
    expect(reject(release, batman, "comic")).toBeNull();
  });

  it.each([
    "Batman Beyond 012 (2016)",
    "Batman - The Long Halloween 012 (1997)",
    "Batman Annual 012 (1988)",
    "Batman 001-012 (2016)",
    "Batman 2016 Vol 12 TPB",
    "Batman 011 (2016)",
  ])("refuses %s", (release) => {
    expect(reject(release, batman, "comic")).not.toBeNull();
  });

  it("matches the issue number, not an issue-of count or the covers", () => {
    expect(reject("Saga 012 (2013) (Digital) (1 of 2 covers)", { title: "#1 - Chapter One", parentTitle: "Saga" }, "comic")).not.toBeNull();
    expect(reject("Saga Vol. 1 TPB (2012)", { title: "#1 - Chapter One", parentTitle: "Saga" }, "comic")).not.toBeNull();
    expect(reject("The Walking Dead 005 (2004)", { title: "#5 - Issue", parentTitle: "The Walking Dead" }, "comic")).toBeNull();
    expect(reject("The Walking Dead - Negan Lives 005", { title: "#5 - Issue", parentTitle: "The Walking Dead" }, "comic")).not.toBeNull();
  });

  it("a manga volume is the chapter only when its chapter range reaches it", () => {
    const chapter = (n: number) => ({ title: `Chapter ${n}`, parentTitle: "One Piece" });
    expect(reject("One Piece v01 (c001-008) (Digital)", chapter(5), "manga")).toBeNull();
    expect(reject("One Piece v05 (c036-044) (Digital)", chapter(5), "manga")).not.toBeNull();
    expect(reject("One Piece v05 (Digital)", chapter(5), "manga")).not.toBeNull();
    expect(reject("One Piece c005 (Digital)", chapter(5), "manga")).toBeNull();
    expect(reject("One Piece Chapter 5", chapter(5), "manga")).toBeNull();
    expect(reject("One Piece c006", chapter(5), "manga")).not.toBeNull();
  });
});

describe("two albums of one title are told apart by year (Round 14, N16)", () => {
  const hits2008 = { title: "Greatest Hits", parentTitle: "Queen", releaseYear: 2008, sameTitledYears: [1981] };
  it("refuses the other year's album and takes its own or an undated one", () => {
    expect(reject("Queen - Greatest Hits (1981) [FLAC]", hits2008, "artist")).not.toBeNull();
    expect(reject("Queen - Greatest Hits (2008) [FLAC]", hits2008, "artist")).toBeNull();
    expect(reject("Queen - Greatest Hits [FLAC]", hits2008, "artist")).toBeNull();
    // A year that is neither album's is a reissue year and is left alone.
    expect(reject("Queen - Greatest Hits (2011 Remaster) [FLAC]", hits2008, "artist")).toBeNull();
  });
  it("does nothing without a same-titled album", () => {
    expect(reject("Queen - Greatest Hits (1981) [FLAC]", { title: "Greatest Hits", parentTitle: "Queen", releaseYear: 2008 }, "artist")).toBeNull();
  });
});

describe("which release of the title is best (Round 14, N7, N23)", () => {
  const better = (type: string, good: string, bad: string) => expect(nonVideoPreference(good, type)).toBeGreaterThan(nonVideoPreference(bad, type));
  it("prefers lossless music, then the higher bitrate", () => {
    better("artist", "Queen - Greatest Hits [FLAC]", "Queen - Greatest Hits [MP3 320]");
    better("artist", "Queen - Greatest Hits [MP3 320]", "Queen - Greatest Hits [MP3 128]");
    better("artist", "Queen - Greatest Hits [FLAC 24-96]", "Queen - Greatest Hits [FLAC]");
  });
  it("prefers epub, then azw3, mobi and pdf", () => {
    better("author", "Dune [EPUB]", "Dune [AZW3]");
    better("author", "Dune [AZW3]", "Dune [MOBI]");
    better("author", "Dune [MOBI]", "Dune [PDF]");
    better("audiobook", "Dune [M4B]", "Dune [MP3]");
    better("comic", "Saga 012 (2013) cbz", "Saga 012 (2013) pdf");
  });
  it("prefers a world or USA ROM, a later revision and a good dump over a beta", () => {
    better("rom", "Super Mario Bros. (World)", "Super Mario Bros. (Japan)");
    better("rom", "Super Mario Bros. (USA)", "Super Mario Bros. (Europe)");
    better("rom", "Super Mario Bros. (USA) (Rev 1)", "Super Mario Bros. (USA)");
    better("rom", "Super Mario Bros. (USA)", "Super Mario Bros. (USA) (Beta)");
  });
  it("has no opinion about other types", () => {
    expect(nonVideoPreference("Anything", "movie")).toBe(0);
  });
});

describe("types it has no grammar for", () => {
  it("never refuses a movie, a series or a podcast", () => {
    expect(nonVideoRejection("Anything.At.All.2020.1080p", { title: "Something Else" }, "movie")).toBeNull();
    expect(nonVideoRejection("Anything", { title: "Else" }, "podcast")).toBeNull();
  });
});

describe("real-world names the first draft refused (Round 14 review)", () => {
  const taken = (type: string, name: { title: string; parentTitle?: string }, releases: string[]) => {
    for (const r of releases) expect(nonVideoRejection(r, name, type), r).toBeNull();
  };

  it("takes a comic by its issue number wherever the name puts it", () => {
    taken("comic", { title: "#12 - X", parentTitle: "Batman (2016)" }, ["Batman 012 (2016) (Digital).cbz", "Batman 12 - Title Words (2016)"]);
    taken("comic", { title: "#54 - X", parentTitle: "Saga" }, ["Saga - 054 - Title Words"]);
    taken("comic", { title: "#300 - X", parentTitle: "Spawn" }, ["Spawn 300 Variant (2019)", "Spawn #300 (Image) 2019", "Spawn 300 - 2019"]);
    taken("comic", { title: "#3 - X", parentTitle: "Absolute Carnage" }, ["Absolute Carnage 003 (2019)"]);
    taken("comic", { title: "#1 - X", parentTitle: "Batman Annual" }, ["Batman Annual 001 (2016)"]);
    expect(nonVideoRejection("Spawn 301 - 2019", { title: "#300 - X", parentTitle: "Spawn" }, "comic")).not.toBeNull();
  });

  it("takes a ROM named with its platform or region outside the brackets, and a game with brackets like [PSX]", () => {
    taken("rom", { title: "Chrono Trigger" }, ["Chrono Trigger USA", "Chrono Trigger - Super Nintendo", "SNES - Chrono Trigger (USA)"]);
    taken("rom", { title: "Castlevania: Symphony of the Night" }, ["Castlevania - Symphony of the Night [PSX]", "Castlevania - Symphony of the Night [PC]"]);
    taken("rom", { title: "Pokemon Emerald" }, ["Pokemon - Emerald Version (USA, Europe)"]);
    expect(nonVideoRejection("Super Mario World (USA)", { title: "Super Mario" }, "rom")).not.toBeNull();
    expect(nonVideoRejection("Chrono Trigger [b1]", { title: "Chrono Trigger" }, "rom")).not.toBeNull();
  });

  it("takes an album whose name carries ripper, label, country or bitrate tags after the year or format", () => {
    const album = { title: "OK Computer", parentTitle: "Radiohead" };
    taken("artist", album, [
      "Radiohead - OK Computer 1997 Japan",
      "Radiohead - OK Computer 1997 FLAC Parlophone",
      "Radiohead - OK Computer 1997 FLAC EAC",
      "Radiohead - OK Computer 1997 CDDA FLAC",
      "Radiohead - OK Computer 1997 Studio Album",
      "Radiohead - OK Computer MP3 320",
      "Radiohead - OK Computer 256 AAC",
      "Radiohead - OK Computer 1997 180g Vinyl",
      "Radiohead - OK Computer 2xCD FLAC",
      "Radiohead - OK Computer FLAC+CUE",
      "Radiohead - OK Computer MP3+FLAC",
      "Radiohead - OK Computer 1997 MP3 VBR V0",
    ]);
    taken("artist", { title: "Abbey Road", parentTitle: "The Beatles" }, ["The Beatles - Abbey Road 2019 Mix Digital Remaster"]);
    taken("artist", { title: "Nevermind", parentTitle: "Nirvana" }, ["Nirvana - Nevermind Remastered 30th Anniversary Super Deluxe"]);
    taken("artist", { title: "Rumours", parentTitle: "Fleetwood Mac" }, ["Fleetwood Mac - Rumours Expanded &amp; Remastered", "Fleetwood Mac - Rumours 35th Anniversary Deluxe Edition 3CD+DVD"]);
    // A later entry in the tag zone is still a later entry.
    expect(nonVideoRejection("Radiohead - OK Computer 1997 FLAC Vol 2", album, "artist")).not.toBeNull();
    expect(nonVideoRejection("Radiohead - OK Computer 1997 FLAC 3", album, "artist")).not.toBeNull();
  });

  it("takes a book named with its series, publisher, narrator or several formats", () => {
    const dune = { title: "Dune", parentTitle: "Frank Herbert" };
    taken("author", dune, ["Frank Herbert - Dune 01 - Dune", "Dune 1965 Gollancz epub", "Frank Herbert - Dune MOBI+EPUB"]);
    taken("author", { title: "The Hunger Games", parentTitle: "Suzanne Collins" }, ["Suzanne Collins - Hunger Games 1 - The Hunger Games"]);
    taken("audiobook", { title: "Project Hail Mary", parentTitle: "Andy Weir" }, ["Andy Weir - Project Hail Mary 2021 Ray Porter m4b", "Andy Weir - Project Hail Mary audiobook 128k"]);
  });
});
