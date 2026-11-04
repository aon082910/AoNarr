import { describe, it, expect } from "vitest";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import { albumsCoveredBy, albumYear, judgeDiscography, releaseNamesArtist, type DiscographyAlbum } from "../src/services/discography.js";
import { matchAlbumFolders, type MatchableAlbum } from "../src/services/discographyMatch.js";

const NOW = new Date("2026-11-04T00:00:00Z");
const isUnreleased = (date: string | null) => !!date && new Date(date) > NOW;

function album(id: number, title: string, releaseDate: string | null, extra: Partial<DiscographyAlbum> = {}): DiscographyAlbum {
  return { id, title, releaseDate, monitored: true, hasFile: false, ...extra };
}

const QUEEN = [
  album(1, "Queen", "1973-07-13"),
  album(2, "Queen II", "1974-03-08"),
  album(3, "Sheer Heart Attack", "1974-11-08"),
  album(4, "A Night at the Opera", "1975-11-21"),
  album(5, "News of the World", "1977-10-28"),
  album(6, "Innuendo", "1991-02-04"),
];

describe("parsing a discography", () => {
  it.each([
    ["Queen - Discography (1973-1995) [FLAC]", { from: 1973, to: 1995 }],
    ["Queen - Discography 1973-95 FLAC", { from: 1973, to: 1995 }],
    ["Metallica Discografia 1983 to 2016 MP3", { from: 1983, to: 2016 }],
    ["Artist - Discography 1990-Present [FLAC]", { from: 1990, to: null }],
    ["Queen - Discography [FLAC]", { from: null, to: null }],
    ["Queen.Discography.FLAC-GROUP", { from: null, to: null }],
    ["Rammstein - Diskografie (1995-2022)", { from: 1995, to: 2022 }],
  ])("reads %s", (title, expected) => {
    const parsed = parseReleaseTitle(title);
    expect(parsed.discography).toEqual(expected);
    // It is no episode, season or batch of anything.
    expect(parsed.isFullSeason).toBe(false);
    expect(parsed.seasonNumber).toBeNull();
    expect(parsed.episodeNumbers).toBeNull();
  });

  it("reads a complete discography with spaces round the dash", () => {
    // (The parser also takes "Complete ... (1973 - 1995)" for a pack of a season; no music type looks at that.)
    expect(parseReleaseTitle("Queen - Complete Discography (1973 - 1995) [MP3 320]").discography).toEqual({ from: 1973, to: 1995 });
  });

  it("leaves every other release without the field", () => {
    for (const title of ["Queen - A Night at the Opera (1975) [FLAC]", "Queen - Greatest Hits (1981) [FLAC]", "Show.S01.1080p.WEB-DL-GRP", "Some Movie 1999-2005 1080p"]) {
      expect(parseReleaseTitle(title).discography).toBeUndefined();
    }
  });

  it("takes a span that ends before it starts as no discography, not as all of the albums", () => {
    expect(parseReleaseTitle("Queen - Discography 1995-1973").discography).toBeUndefined();
  });

  it("reads the word in other scripts", () => {
    expect(parseReleaseTitle("Кино - Дискография (1982-1990) [FLAC]").discography).toEqual({ from: 1982, to: 1990 });
    expect(parseReleaseTitle("Queen - Discographyx").discography).toBeUndefined();
  });
});

describe("the albums a discography covers", () => {
  it("is all of the artist's when it names no years", () => {
    expect(albumsCoveredBy({ from: null, to: null }, QUEEN)).toHaveLength(6);
    expect(albumsCoveredBy(undefined, QUEEN)).toHaveLength(6);
  });

  it("is the albums dated inside the years, both ends included", () => {
    expect(albumsCoveredBy({ from: 1974, to: 1977 }, QUEEN).map((a) => a.id)).toEqual([2, 3, 4, 5]);
    expect(albumsCoveredBy({ from: 1977, to: null }, QUEEN).map((a) => a.id)).toEqual([5, 6]);
  });

  it("leaves out an album with no date when years are named", () => {
    const withUndated = [...QUEEN, album(7, "Unknown Date", null)];
    expect(albumsCoveredBy({ from: 1973, to: 1995 }, withUndated).map((a) => a.id)).not.toContain(7);
    expect(albumsCoveredBy({ from: null, to: null }, withUndated).map((a) => a.id)).toContain(7);
  });

  it("reads the year of a full, month or year date", () => {
    expect(albumYear("2011-05-03")).toBe(2011);
    expect(albumYear("2011-05")).toBe(2011);
    expect(albumYear("2011")).toBe(2011);
    expect(albumYear(null)).toBeNull();
    expect(albumYear("soon")).toBeNull();
  });
});

describe("judging a discography", () => {
  const judge = (title: string, albums: DiscographyAlbum[], minWanted = 2) => judgeDiscography(title, albums, { minWanted, isUnreleased });

  it("takes one that covers enough missing albums and lists them", () => {
    const verdict = judge("Queen - Discography (1973-1977) [FLAC]", QUEEN);
    expect(verdict.ok).toBe(true);
    expect(verdict.wanted.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    expect(verdict.covered.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts only monitored albums without files as wanted", () => {
    const albums = [QUEEN[0], { ...QUEEN[1], hasFile: true }, { ...QUEEN[2], monitored: false }, QUEEN[3], QUEEN[4]];
    const verdict = judge("Queen - Discography (1973-1977)", albums);
    expect(verdict.ok).toBe(true);
    expect(verdict.wanted.map((a) => a.id)).toEqual([1, 4, 5]);
    expect(verdict.covered).toHaveLength(5);
  });

  it("refuses one that would include an album that is not out yet", () => {
    const verdict = judge("Queen - Discography [FLAC]", [...QUEEN, album(8, "Next Record", "2027-01-01")]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('It would include "Next Record", which is not out yet');
  });

  it("takes one whose years stop before the unreleased album", () => {
    expect(judge("Queen - Discography (1973-1995)", [...QUEEN, album(8, "Next Record", "2027-01-01")]).ok).toBe(true);
  });

  it("refuses one that would add too few missing albums", () => {
    const albums = QUEEN.map((a, i) => (i === 0 ? a : { ...a, hasFile: true }));
    const verdict = judge("Queen - Discography [FLAC]", albums);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("It would add only 1 missing album; a discography is taken for at least 2");
    expect(judge("Queen - Discography [FLAC]", albums, 1).ok).toBe(true);
  });

  it("says when it covers nothing that is missing", () => {
    const verdict = judge("Queen - Discography", QUEEN.map((a) => ({ ...a, hasFile: true })), 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("It covers no album that is missing");
  });

  it("says when the years it names hold none of the artist's albums", () => {
    const verdict = judge("Queen - Discography (2001-2010)", QUEEN);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("2001-2010");
  });

  it("is not a judgment of a release that is no discography", () => {
    const verdict = judge("Queen - Innuendo (1991) [FLAC]", QUEEN);
    expect(verdict.ok).toBe(false);
  });

  it("refuses, for an automatic grab, a discography that would add a small share of the albums it covers", () => {
    const forty = Array.from({ length: 40 }, (_, i) => album(100 + i, `Record ${i}`, `${1970 + (i % 30)}-01-01`, { hasFile: i >= 2 }));
    const automatic = judgeDiscography("Queen - Discography [FLAC]", forty, { minWanted: 2, minShare: 0.25, isUnreleased });
    expect(automatic.ok).toBe(false);
    if (!automatic.ok) expect(automatic.reason).toContain("2 missing albums of the 40 it covers");
    // By hand there is no such share.
    expect(judgeDiscography("Queen - Discography [FLAC]", forty, { minWanted: 1, isUnreleased }).ok).toBe(true);
    // A fourth of the albums is enough.
    const tenth = forty.map((a, i) => ({ ...a, hasFile: i >= 10 }));
    expect(judgeDiscography("Queen - Discography [FLAC]", tenth, { minWanted: 2, minShare: 0.25, isUnreleased }).ok).toBe(true);
  });

  it("is not a discography when it is the album that has the word in its own title", () => {
    const pet = [album(1, "Discography: The Complete Singles Collection", "1991-01-01"), album(2, "Actually", "1987-09-07")];
    const verdict = judge("Pet Shop Boys - Discography: The Complete Singles Collection (1991) [FLAC]", pet, 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.isAlbum).toBe(true);
      expect(verdict.reason).toContain("It is the album");
    }
    expect(judge("Pet Shop Boys - Discography (1985-1995) [FLAC]", pet, 1).ok).toBe(true);
  });
});

describe("whose discography a release is", () => {
  it.each([
    ["Queen - Discography (1973-1995) [FLAC]", "Queen", true],
    ["Queen Discography 1973-1995", "Queen", true],
    ["Queen - Complete Discography", "Queen", true],
    ["[FLAC] Queen - Discography", "Queen", true],
    ["Queen_-_Discography_(1973-1995)", "Queen", true],
    ["The Beatles - Discography", "Beatles", true],
    ["Beatles - Discography", "The Beatles", true],
    ["AC DC - Discography (1975-2020)", "AC/DC", true],
    ["Björk - Discography", "Bjork", true],
    ["Queen Latifah - Discography", "Queen", false],
    ["Queens of the Stone Age - Discography", "Queen", false],
    ["Queen & David Bowie - Discography", "Queen", false],
    ["Metallica - Discography", "Queen", false],
    ["Pink - Discography (2000-2019) [FLAC]", "P!nk", true],
    ["REM - Discography", "R.E.M.", true],
    ["R.E.M. - Discography", "REM", true],
    ["ACDC - Discography", "AC/DC", true],
    ["Kesha - Discography", "Ke$ha", true],
    ["The The - Discography", "The The", true],
    ["Дискография - Кино", "Кино", true],
    ["Pinkerton - Discography", "P!nk", false],
  ])("%s for %s is %s", (title, artist, expected) => {
    expect(releaseNamesArtist(title, artist)).toBe(expected);
  });
});

describe("telling the folders of a discography apart", () => {
  const albums: MatchableAlbum[] = QUEEN.map((a) => ({ id: a.id, title: a.title, releaseDate: a.releaseDate, target: true }));
  const folder = (name: string, files = 10) => ({ path: `/dl/${name}`, name, files });
  const matchOf = (name: string, set: MatchableAlbum[] = albums, artist = "Queen") => matchAlbumFolders([folder(name)], artist, set).get(`/dl/${name}`)!;

  it.each([
    ["1974 - Queen II [FLAC]", 2],
    ["Queen II (1974)", 2],
    ["Queen - Queen II (1974) [FLAC 24-96]", 2],
    ["(1975) A Night At The Opera", 4],
    ["1975 - A Night at the Opera (Deluxe Edition)", 4],
    ["1977 News Of The World", 5],
    ["Sheer Heart Attack - 2011 Remaster", 3],
    ["Innuendo [FLAC]", 6],
    ["Queen 2", 2],
    ["Queen_-_Innuendo", 6],
  ])("reads %s as album %i", (name, id) => {
    expect(matchOf(name)).toEqual({ kind: "album", albumId: id, target: true });
  });

  it("tells a self-titled album from the artist's name in front of it", () => {
    expect(matchOf("1973 - Queen")).toEqual({ kind: "album", albumId: 1, target: true });
    expect(matchOf("Queen - Queen (1973)")).toEqual({ kind: "album", albumId: 1, target: true });
    expect(matchOf("Queen")).toEqual({ kind: "album", albumId: 1, target: true });
  });

  it("does not mistake one album for another that starts the same", () => {
    // "Queen II" is not "Queen"; "Queen" is not "Queen II".
    expect(matchOf("Queen II")).toMatchObject({ kind: "album", albumId: 2 });
    expect(matchOf("Queen III")).toMatchObject({ kind: "unmatched" });
  });

  it("leaves a folder that is no album of the artist", () => {
    expect(matchOf("Scans")).toMatchObject({ kind: "unmatched" });
    expect(matchOf("Videos 1973-1995")).toMatchObject({ kind: "unmatched" });
  });

  it("tells same-titled albums apart by the year in the folder name", () => {
    const hits: MatchableAlbum[] = [
      { id: 10, title: "Greatest Hits", releaseDate: "1981-10-26", target: false },
      { id: 11, title: "Greatest Hits", releaseDate: "2000-01-01", target: true },
    ];
    expect(matchOf("Greatest Hits (1981)", hits)).toEqual({ kind: "album", albumId: 10, target: false });
    expect(matchOf("2000 - Greatest Hits", hits)).toEqual({ kind: "album", albumId: 11, target: true });
    expect(matchOf("Greatest Hits", hits)).toMatchObject({ kind: "ambiguous" });
  });

  it("reads an album whose title is a year", () => {
    const swift: MatchableAlbum[] = [{ id: 20, title: "1989", releaseDate: "2014-10-27", target: true }];
    expect(matchOf("Taylor Swift - 1989 (2014) [FLAC]", swift, "Taylor Swift")).toMatchObject({ kind: "album", albumId: 20 });
    expect(matchOf("2014 - 1989", swift, "Taylor Swift")).toMatchObject({ kind: "album", albumId: 20 });
    expect(matchOf("1989", swift, "Taylor Swift")).toMatchObject({ kind: "album", albumId: 20 });
  });

  it("takes the plainer of two folders of one album, and then the one with more files", () => {
    const folders = [folder("1974 - Queen II (Deluxe Edition)", 20), folder("1974 - Queen II", 11), folder("Queen II [FLAC]", 12)];
    const result = matchAlbumFolders(folders, "Queen", albums);
    expect(result.get("/dl/1974 - Queen II")).toMatchObject({ kind: "duplicate" });
    expect(result.get("/dl/Queen II [FLAC]")).toMatchObject({ kind: "album", albumId: 2 });
    expect(result.get("/dl/1974 - Queen II (Deluxe Edition)")).toMatchObject({ kind: "duplicate" });
  });

  it("leaves the disc folders of one album laid side by side, instead of taking half the album", () => {
    for (const names of [
      ["1975 - A Night at the Opera (Disc 1)", "1975 - A Night at the Opera (Disc 2)"],
      ["A Night at the Opera CD1", "A Night at the Opera CD2"],
      ["1975 - A Night at the Opera [CD2]", "1975 - A Night at the Opera"],
    ]) {
      const result = matchAlbumFolders(names.map((n, i) => folder(n, 5 + i)), "Queen", albums);
      for (const name of names) expect(result.get(`/dl/${name}`), name).toMatchObject({ kind: "ambiguous" });
    }
    // A third folder of the album is no better placed.
    const three = matchAlbumFolders([folder("A Night at the Opera CD1"), folder("A Night at the Opera CD2"), folder("A Night at the Opera")], "Queen", albums);
    expect(three.get("/dl/A Night at the Opera")).toMatchObject({ kind: "ambiguous" });
  });

  it("prefers the lossless folder when two copies are otherwise alike", () => {
    const result = matchAlbumFolders([folder("1974 - Queen II [MP3 320]", 30), folder("1974 - Queen II [FLAC]", 10)], "Queen", albums);
    expect(result.get("/dl/1974 - Queen II [FLAC]")).toMatchObject({ kind: "album", albumId: 2 });
    expect(result.get("/dl/1974 - Queen II [MP3 320]")).toMatchObject({ kind: "duplicate" });
  });

  it("marks an album that was not wanted, so it stays in the download", () => {
    const owned = albums.map((a) => (a.id === 2 ? { ...a, target: false } : a));
    expect(matchOf("1974 - Queen II", owned)).toEqual({ kind: "album", albumId: 2, target: false });
  });

  it("matches nothing from an empty folder name", () => {
    expect(matchOf("")).toMatchObject({ kind: "unmatched" });
  });
});
