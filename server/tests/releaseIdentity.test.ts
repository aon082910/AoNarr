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
    expect(identityKey("X-Men")).toBe("x men");
  });

  it("reads a lone I, V or X as a numeral only at the end of a title or of its part before a subtitle", () => {
    expect(identityKey("Rocky V")).toBe("rocky 5");
    expect(identityKey("Star Wars: Episode V - The Empire Strikes Back")).toBe("star wars episode 5 the empire strikes back");
    expect(identityKey("Star Wars Episode 5")).toBe("star wars episode 5");
    expect(identityKey("Malcolm X")).toBe(identityKey("Malcolm.X"));
    // A title that is only the letter stays itself.
    expect(identityKey("X")).toBe("x");
  });

  it("folds the letters accent stripping leaves, and writes % as a word", () => {
    expect(identityKey("Die Straße")).toBe("die strasse");
    expect(identityKey("Ríkið Þórs Ísland")).toBe("rikid thors island");
    expect(identityKey("3%")).toBe("3 percent");
    expect(identityKey("3%")).not.toBe(identityKey("3"));
    expect(identityKey("Æon Flux")).toBe("aeon flux");
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
    // A provider that stores the US show as a bare "The Office" (TMDB does) leaves the scene's
    // region tag as the only hint, so it is accepted for a bare title, ranked below a plain title
    // match. A title that names another region is not.
    expect(verdict("The.Office.US.S03E01.720p.HDTV-GRP", item({ type: "series", title: "The Office", year: 2001 }))).toMatchObject({ ok: true, matchType: "title-region" });
    expect(verdict("The.Office.US.S03E01.720p.HDTV-GRP", item({ type: "series", title: "The Office (UK)", year: 2001 }))).toMatchObject({ ok: false, reason: "title" });
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

describe("releaseIdentifiesTarget — review follow-ups", () => {
  it("reads a title's own year-shaped number back when the release carries no production year", () => {
    expect(verdict("Blade.Runner.2049.1080p.BluRay.x264-GRP", item({ title: "Blade Runner 2049", year: 2017 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Blade.Runner.2049.1080p.BluRay.x264-GRP", item({ title: "Blade Runner", year: 1982 }))).toMatchObject({ ok: false, reason: "year" });
    expect(verdict("Death.Race.2000.1080p.BluRay-GRP", item({ title: "Death Race 2000", year: 1975 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Class.of.1984.1080p.BluRay-GRP", item({ title: "Class of 1984", year: 1982 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Blade Runner 2049 (2017) [1080p] [BluRay] [5.1] [YTS.MX]", item({ title: "Blade Runner 2049", year: 2017 }))).toMatchObject({ ok: true, matchType: "title" });
  });

  it("accepts a scene region tag for a title the provider stores bare, but not for another region", () => {
    expect(verdict("Shameless.US.S01E01.720p.HDTV-GRP", item({ type: "series", title: "Shameless", year: 2011 }))).toMatchObject({ ok: true, matchType: "title-region" });
    expect(verdict("Shameless.US.S01E01.720p.HDTV-GRP", item({ type: "series", title: "Shameless (UK)", year: 2004 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Shameless (US) S01E01 720p HDTV x264-GRP", item({ type: "series", title: "Shameless", year: 2004 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Shameless (US) S01E01 720p HDTV x264-GRP", item({ type: "series", title: "Shameless (US)", year: 2011 }))).toMatchObject({ ok: true, matchType: "title" });
  });

  it("matches either half of an AKA dual title", () => {
    expect(verdict("The.Fall.Guy.AKA.Kaskader.2024.1080p.WEB-GRP", item({ title: "The Fall Guy", year: 2024 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("The.Fall.Guy.AKA.Kaskader.2024.1080p.WEB-GRP", item({ title: "Kaskader", year: 2024 }))).toMatchObject({ ok: true, matchType: "title" });
  });

  it("tolerates a dropped leading article, except when a bare number would be left", () => {
    expect(verdict("Flash.S01E01.1080p.WEB-GRP", item({ type: "series", title: "The Flash", year: 2014 }))).toMatchObject({ ok: true, matchType: "title-main" });
    expect(verdict("The.Office.S03E01.720p.HDTV-GRP", item({ type: "series", title: "Office", year: 2005 }))).toMatchObject({ ok: true, matchType: "title-main" });
    expect(verdict("100.S01E01.1080p.WEB-GRP", item({ type: "series", title: "The 100", year: 2014 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("matches anime whose provider title names the season differently from the release", () => {
    const s2 = item({ type: "anime", title: "JUJUTSU KAISEN Season 2", year: 2023 });
    expect(verdict("[SubsPlease] Jujutsu Kaisen S2 - 05 (1080p) [ABCD1234]", s2)).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Jujutsu.Kaisen.S02E05.1080p.WEB-GRP", s2)).toMatchObject({ ok: true, matchType: "title" });
    // A show's shorter name needs an alias row; the part before the subtitle is not enough.
    const mushoku = item({ type: "anime", title: "Mushoku Tensei: Jobless Reincarnation Season 2", year: 2023 });
    expect(verdict("[SubsPlease] Mushoku Tensei 2nd Season - 05 (1080p)", mushoku)).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("[SubsPlease] Mushoku Tensei 2nd Season - 05 (1080p)", { ...mushoku, aliases: ["Mushoku Tensei 2nd Season"] })).toMatchObject({ ok: true, matchType: "alias" });
    // Movies keep their sequel numbers.
    expect(verdict("Scream.2.1997.1080p.BluRay-GRP", item({ title: "Scream", year: 1996 }))).toMatchObject({ ok: false, reason: "title" });
  });

  it("accepts a title that contains quality-like words, an edition before the year, and a site prefix", () => {
    expect(verdict("Complete.Unknown.2016.1080p.WEB-GRP", item({ title: "Complete Unknown", year: 2016 }))).toMatchObject({ ok: true });
    expect(verdict("Alien.Directors.Cut.1979.1080p.BluRay-GRP", item({ title: "Alien", year: 1979 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("www.Site.org - Movie.Name.2019.1080p.BluRay.x264-GRP", item({ title: "Movie Name", year: 2019 }))).toMatchObject({ ok: true });
    expect(verdict("Show.Name.25.08.2024.1080p.WEB-GRP", item({ type: "series", title: "Show Name", year: 2010 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("[Batch] Show - 01-12 [1080p]", item({ type: "anime", title: "Show", year: 2020 }))).toMatchObject({ ok: true });
  });
});

describe("releaseIdentifiesTarget — id means id only", () => {
  it("reports a title match when both the title and the indexer id match, and 'id' only when the title doesn't", () => {
    const matrix = item({ title: "The Matrix", year: 1999, externalIds: { imdb: "tt0133093" } });
    expect(verdict("The.Matrix.1999.1080p.BluRay-GRP", matrix, { imdbId: "tt0133093" })).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Some.Other.Name.1999.1080p.BluRay-GRP", matrix, { imdbId: "tt0133093" })).toMatchObject({ ok: true, matchType: "id" });
    // The id settles a year contradiction too: the indexer knows better than a mis-scraped year.
    expect(verdict("The.Matrix.2010.1080p.BluRay-GRP", matrix, { imdbId: "tt0133093" })).toMatchObject({ ok: true, matchType: "id" });
  });
});

describe("releaseIdentifiesTarget — Round 8", () => {
  it("takes the part of a title before its subtitle for a film only, never for a show (I1)", () => {
    expect(verdict("Dexter.S01E01.720p.HDTV.x264-CTU", item({ type: "series", title: "Dexter: New Blood", year: 2021 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("FBI.S06E05.1080p.WEB.h264-GRP", item({ type: "series", title: "FBI: Most Wanted", year: 2020 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Law.and.Order.S24E05.1080p.WEB-GRP", item({ type: "series", title: "Law & Order: Special Victims Unit", year: 1999 }))).toMatchObject({ ok: false, reason: "title" });
    // An alias row is how a show gets a shorter name.
    expect(verdict("Law.and.Order.SVU.S24E05.1080p.WEB-GRP", item({ type: "series", title: "Law & Order: Special Victims Unit", year: 1999, aliases: ["Law and Order SVU"] }))).toMatchObject({ ok: true, matchType: "alias" });
    // A film keeps it.
    expect(verdict("Leon.1994.1080p.BluRay-GRP", item({ title: "Léon: The Professional", year: 1994 }))).toMatchObject({ ok: true, matchType: "title-main" });
  });

  it("takes a scene region tag only for the item known to come from that country, or one with nothing to confuse it with (I3)", () => {
    const office = (originCountry: string[] | undefined, sibling: boolean) =>
      item({ type: "series", title: "The Office", year: 2005, originCountry, hasSameBaseSibling: sibling });
    expect(verdict("The.Office.US.S01E01.720p.HDTV-GRP", office(["US"], true))).toMatchObject({ ok: true, matchType: "title-region" });
    expect(verdict("The.Office.US.S01E01.720p.HDTV-GRP", office(["GB"], true))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("The.Office.UK.S01E01.720p.HDTV-GRP", office(["GB"], true))).toMatchObject({ ok: true, matchType: "title-region" });
    // Nothing known about where it was made: fine unless another show shares the title.
    expect(verdict("The.Office.US.S01E01.720p.HDTV-GRP", office(undefined, false))).toMatchObject({ ok: true, matchType: "title-region" });
    expect(verdict("The.Office.US.S01E01.720p.HDTV-GRP", office(undefined, true))).toMatchObject({ ok: false, reason: "title" });
  });

  it("compares a season the same way on the release, the title and every alias (I5)", () => {
    const frieren = item({ type: "anime", title: "Frieren: Beyond Journey's End Season 2", year: 2026, aliases: ["Sousou no Frieren 2nd Season", "Sousou no Frieren"] });
    expect(verdict("[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [ABCD1234]", { ...frieren, aliases: ["Sousou no Frieren 2nd Season"] })).toMatchObject({ ok: true, matchType: "alias" });
    // The sequel's item, a release that names no season: the first season's episode 5.
    expect(verdict("[SubsPlease] Mushoku Tensei - 05 (1080p) [ABCD1234]", item({ type: "anime", title: "Mushoku Tensei Season 2", year: 2023 }))).toMatchObject({ ok: false, reason: "title" });
    // Season 3 is not season 2, however the title writes it.
    expect(verdict("[Group] Shingeki no Kyojin S3 - 05 (1080p)", item({ type: "anime", title: "Attack on Titan Season 2", year: 2017, aliases: ["Shingeki no Kyojin Season 2"] }))).toMatchObject({ ok: false });
    expect(verdict("[Group] Shingeki no Kyojin S3 - 05 (1080p)", item({ type: "anime", title: "Attack on Titan Season 3", year: 2018, aliases: ["Shingeki no Kyojin Season 3"] }))).toMatchObject({ ok: true, matchType: "alias" });
    // A part named without a number is an alias row's job.
    expect(verdict("Attack.on.Titan.The.Final.Season.Part.2.-.05", item({ type: "anime", title: "Attack on Titan: The Final Season Part 2", year: 2022 }))).toMatchObject({ ok: false });
  });

  it("holds a show with a same-titled sibling to its own year, and gives a yearless release to the older one (I6)", () => {
    const qaf = item({ type: "series", title: "Queer as Folk", year: 1999, hasSameBaseSibling: true });
    expect(verdict("Queer.as.Folk.2000.S01E01.720p.HDTV-GRP", qaf)).toMatchObject({ ok: false, reason: "year" });
    expect(verdict("Queer.as.Folk.1999.S01E01.720p.HDTV-GRP", qaf)).toMatchObject({ ok: true });
    // Without a sibling to confuse it with, a year one off still passes.
    expect(verdict("Queer.as.Folk.2000.S01E01.720p.HDTV-GRP", item({ type: "series", title: "Queer as Folk", year: 1999 }))).toMatchObject({ ok: true });
    const remake = item({ type: "series", title: "Charmed", year: 2018, hasSameBaseSibling: true, hasEarlierSameTitle: true });
    expect(verdict("Charmed.S01E01.720p.HDTV.x264-LOL", remake)).toMatchObject({ ok: false, reason: "year" });
    expect(verdict("Charmed.2018.S01E01.720p.HDTV.x264-LOL", remake)).toMatchObject({ ok: true });
    // A film keeps its slack of a year either way.
    expect(verdict("Heat.1996.1080p.BluRay-GRP", item({ title: "Heat", year: 1995, hasSameBaseSibling: true }))).toMatchObject({ ok: true });
  });

  it("matches the other spellings of a title: umlauts, ß, ð, %, a lone roman numeral (I14)", () => {
    expect(verdict("Die.Bruecke.2008.German.DL.1080p.BluRay.x264-GRP", item({ title: "Die Brücke", year: 2008 }))).toMatchObject({ ok: true });
    expect(verdict("Fack.ju.Goehte.2013.German.1080p.BluRay.x264-GRP", item({ title: "Fack ju Göhte", year: 2013 }))).toMatchObject({ ok: true });
    expect(verdict("Die.Strasse.2020.German.1080p.WEB.h264-GRP", item({ title: "Die Straße", year: 2020 }))).toMatchObject({ ok: true });
    expect(verdict("Die.Brucke.2008.1080p.BluRay.x264-GRP", item({ title: "Die Brücke", year: 2008 }))).toMatchObject({ ok: true });
    expect(verdict("3.Percent.S01E01.720p.HDTV.x264-GRP", item({ type: "series", title: "3%", year: 2016 }))).toMatchObject({ ok: true });
    expect(verdict("3.S01E01.720p.HDTV.x264-GRP", item({ type: "series", title: "3%", year: 2016 }))).toMatchObject({ ok: false, reason: "title" });
    expect(verdict("Rocky.5.1990.1080p.BluRay.x264-GRP", item({ title: "Rocky V", year: 1990 }))).toMatchObject({ ok: true });
    expect(verdict("Star.Wars.Episode.5.1980.1080p.BluRay.x264-GRP", item({ title: "Star Wars: Episode V - The Empire Strikes Back", year: 1980 }))).toMatchObject({ ok: true, matchType: "title-main" });
    // Different words stay different: ü is not simply u for a title with another reading.
    expect(verdict("Die.Mauer.2008.1080p.BluRay.x264-GRP", item({ title: "Die Brücke", year: 2008 }))).toMatchObject({ ok: false });
  });

  it("matches either side of a dual title joined by a slash or a bar (P13f)", () => {
    expect(verdict("Bosch.Legacy./.Босх.Спадок.S02E01.1080p.WEB-DL-GRP", item({ type: "series", title: "Bosch: Legacy", year: 2022 }))).toMatchObject({ ok: true, matchType: "title" });
    expect(verdict("Босх.Спадок./.Bosch.Legacy.S02E01.1080p.WEB-DL-GRP", item({ type: "series", title: "Bosch: Legacy", year: 2022 }))).toMatchObject({ ok: true });
    expect(verdict("Bosch.Legacy.|.Босх.Спадок.S02E01.1080p.WEB-DL-GRP", item({ type: "series", title: "Босх: Спадок", year: 2022 }))).toMatchObject({ ok: true });
  });
});
