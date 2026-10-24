import { describe, it, expect } from "vitest";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import { identityKey, releaseIdentifiesTarget, type IdentityTarget } from "../src/services/releaseIdentity.js";

function item(overrides: Partial<IdentityTarget> & Pick<IdentityTarget, "title">): IdentityTarget {
  return { type: "movie", year: null, externalIds: {}, ...overrides };
}

function verdict(releaseTitle: string, target: IdentityTarget, ids: { imdbId?: string; tmdbId?: string } = {}) {
  return releaseIdentifiesTarget({ title: releaseTitle, ...ids }, parseReleaseTitle(releaseTitle), target);
}

describe("identityKey", () => {
  it("folds case, accents, punctuation and apostrophes", () => {
    expect(identityKey("Grey's Anatomy")).toBe("greys anatomy");
    expect(identityKey("Law & Order")).toBe("law and order");
    expect(identityKey("Léon: The Professional")).toBe("leon the professional");
  });

  it("reads roman numerals as digits, but leaves the words I, V and X alone", () => {
    expect(identityKey("Rocky II")).toBe("rocky 2");
    expect(identityKey("Star Wars Episode IV")).toBe("star wars episode 4");
    expect(identityKey("I Robot")).toBe("i robot");
    expect(identityKey("V for Vendetta")).toBe("v for vendetta");
  });
});

describe("releaseIdentifiesTarget", () => {
  const dune2021 = item({ title: "Dune", year: 2021, externalIds: { imdb: "tt1160419" } });

  it("accepts a release naming the title with the item's year", () => {
    expect(verdict("Dune.2021.1080p.BluRay.x264-GRP", dune2021)).toMatchObject({ ok: true, matchType: "title" });
  });

  it("rejects a sequel or longer title that merely starts with the item's title", () => {
    expect(verdict("Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP", dune2021)).toMatchObject({ ok: false, matchType: "none", reason: "title" });
    expect(verdict("Up.in.the.Air.2009.1080p.WEB.x265-GRP", item({ title: "Up", year: 2009 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Aliens.1986.1080p.BluRay-GRP", item({ title: "Alien", year: 1979 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Extraction.2.2023.1080p.NF.WEB-DL-GRP", item({ title: "Extraction", year: 2020 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("rejects a title that ends with the item's title", () => {
    expect(verdict("Dead.Heat.1988.1080p.BluRay-GRP", item({ title: "Heat", year: 1995 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("rejects the same title from another year, within a year of tolerance", () => {
    expect(verdict("Dune.2021.1080p.BluRay.x264-GRP", item({ title: "Dune", year: 1984 }))).toMatchObject({ ok: false, matchType: "none", reason: "year" });
    expect(verdict("Heat.1996.1080p.BluRay-GRP", item({ title: "Heat", year: 1995 }))).toMatchObject({ ok: true, matchType: "title" });
  });

  it("accepts a yeared release for an item with no year, as title-noyear", () => {
    expect(verdict("Dune.2021.1080p.BluRay.x264-GRP", item({ title: "Dune" }))).toMatchObject({ ok: true, matchType: "title-noyear" });
  });

  it("accepts a yearless release for a known target", () => {
    expect(verdict("Charmed.S01E01.1080p.WEB-GRP", item({ type: "series", title: "Charmed (2018)", year: 2018 }))).toMatchObject({ ok: true, matchType: "title" });
  });

  it("tells a remake's episode from the original's by the year in the release", () => {
    const charmed2018 = item({ type: "series", title: "Charmed (2018)", year: 2018 });
    const charmed1998 = item({ type: "series", title: "Charmed", year: 1998 });
    expect(verdict("Charmed.2018.S01E01.1080p.AMZN.WEB-DL-NTb", charmed2018)).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Charmed.2018.S01E01.1080p.AMZN.WEB-DL-NTb", charmed1998)).toMatchObject({ ok: false, reason: "year" });
    expect(verdict("Charmed.1998.S01E01.1080p.WEB-GRP", charmed2018)).toMatchObject({ ok: false, reason: "year" });
  });

  it("reads a year qualifier in the item's title when the item has no year of its own", () => {
    expect(verdict("Charmed.1998.S01E01.1080p.WEB-GRP", item({ type: "series", title: "Charmed (2018)" }))).toMatchObject({ ok: false, reason: "year" });
  });

  it("tolerates a country qualifier written with or without brackets, and its absence", () => {
    const officeUS = item({ type: "series", title: "The Office (US)", year: 2005 });
    expect(verdict("The.Office.US.S03E01.720p.HDTV-GRP", officeUS)).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("The.Office.S03E01.720p.HDTV-GRP", officeUS)).toMatchObject({ ok: true, matchType: "title" });
    // The UK show is a different item; a release that says US is not it.
    expect(verdict("The.Office.US.S03E01.720p.HDTV-GRP", item({ type: "series", title: "The Office", year: 2001 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("skips the year check for an air-dated release", () => {
    const daily = item({ type: "series", title: "The Daily Show", year: 1996 });
    expect(verdict("The.Daily.Show.2024.08.25.1080p.WEB-GRP", daily)).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("The.Late.Show.2024.08.25.1080p.WEB-GRP", daily)).toMatchObject({ ok: false, reason: "title" });
  });

  it("matches roman numerals against digits and digits in titles", () => {
    expect(verdict("Rocky.2.1979.1080p.BluRay-GRP", item({ title: "Rocky II", year: 1979 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Blade.Runner.2049.2017.1080p.BluRay.x264-GRP", item({ title: "Blade Runner 2049", year: 2017 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Blade.Runner.2049.2017.1080p.BluRay.x264-GRP", item({ title: "Blade Runner", year: 1982 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("24.S01E03.720p.HDTV-GRP", item({ type: "series", title: "24", year: 2001 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Breaking.Bad.S01E03.720p.HDTV-GRP", item({ type: "series", title: "24", year: 2001 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("accepts the part of a title before its subtitle, ranked as title-main", () => {
    expect(verdict("Leon.1994.1080p.BluRay-GRP", item({ title: "Léon: The Professional", year: 1994 }))).toMatchObject({ ok: true, matchType: "title-main" });
    expect(verdict("Star.Wars.Episode.4.1977.1080p.BluRay-GRP", item({ title: "Star Wars: Episode IV - A New Hope", year: 1977 }))).toMatchObject({
      ok: true,
      matchType: "title-main",
    });
    // The subtitle alone is not the title.
    expect(verdict("The.Professional.1994.1080p.BluRay-GRP", item({ title: "Léon: The Professional", year: 1994 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("accepts an alias when the caller supplies one", () => {
    const aot = item({ type: "anime", title: "Attack on Titan", year: 2013, aliases: ["Shingeki no Kyojin"] });
    expect(verdict("Shingeki.no.Kyojin.S04E01.1080p.WEB-GRP", aot)).toMatchObject({ ok: true, matchType: "alias" });
    expect(verdict("Shingeki.no.Kyojin.S04E01.1080p.WEB-GRP", item({ ...aot, aliases: [] }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("lets an indexer-reported or title-embedded id settle it regardless of the title", () => {
    expect(verdict("Some.Other.Name.2021.1080p.WEB-GRP", dune2021, { imdbId: "TT1160419" })).toMatchObject({ ok: true, matchType: "id" });
    expect(verdict("Some.Other.Name.2021.1080p.WEB-GRP[tt1160419]", dune2021)).toMatchObject({ ok: true, matchType: "id" });
    expect(verdict("Some.Other.Name.2021.1080p.WEB-GRP", dune2021)).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Some.Other.Name.2021.1080p.WEB-GRP", dune2021, { imdbId: "tt0000001" })).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Some.Other.Name.2021.1080p.WEB-GRP", item({ title: "Dune", year: 2021, externalIds: { tmdb: "438631" } }), { tmdbId: "438631" })).toMatchObject({
      ok: true,
      matchType: "id",
    });
  });

  it("rejects a release whose title can't be read", () => {
    expect(verdict("S01E01.1080p.WEB-GRP", item({ type: "series", title: "Show", year: 2015 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("only needs the item title to appear inside the release for sports/PPV/course/adult/video", () => {
    const ufc = item({ type: "ppv", title: "UFC 300", year: 2024 });
    expect(verdict("UFC.300.Pereira.vs.Hill.PPV.1080p.WEB-GRP", ufc)).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("UFC.301.Pantoja.vs.Erceg.PPV.1080p.WEB-GRP", ufc)).toMatchObject({ ok: false, reason: "title" });
    // Whole words: "UFC 30" is not inside "UFC 300".
    expect(verdict("UFC.300.Pereira.vs.Hill.PPV.1080p.WEB-GRP", item({ type: "ppv", title: "UFC 30", year: 2001 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Formula.1.2024.Round.05.Chinese.Grand.Prix.Race.1080p.WEB-GRP", item({ type: "sports", title: "Formula 1", year: 2024 }))).toMatchObject({ ok: true });
  });
});
