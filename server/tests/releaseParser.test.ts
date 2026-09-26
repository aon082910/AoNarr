import { describe, it, expect } from "vitest";
import { parseReleaseTitle, releaseMatchesEpisode, releaseMatchesAirDate } from "../src/services/releaseParser.js";

describe("parseReleaseTitle", () => {
  it("parses a standard SxxExx episode release", () => {
    const p = parseReleaseTitle("Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-GROUP");
    expect(p.seasonNumber).toBe(2);
    expect(p.episodeNumbers).toEqual([5]);
    expect(p.isFullSeason).toBe(false);
    expect(p.quality).toBe("WEBDL-1080p");
    expect(p.source).toBe("WEBDL");
    expect(p.resolution).toBe("1080p");
    expect(p.releaseGroup).toBe("GROUP");
  });

  it("parses a hyphenated multi-episode range", () => {
    const p = parseReleaseTitle("Show.Name.S01E01-E03.720p.HDTV.x264-GROUP");
    expect(p.seasonNumber).toBe(1);
    expect(p.episodeNumbers).toEqual([1, 2, 3]);
  });

  it("parses a chained multi-episode list (not necessarily contiguous)", () => {
    const p = parseReleaseTitle("Show.Name.S01E01E03E05.720p.HDTV.x264-GROUP");
    expect(p.episodeNumbers).toEqual([1, 3, 5]);
  });

  it("parses a bare hyphenated range without the E prefix on the end", () => {
    const p = parseReleaseTitle("Show.Name.S01E01-03.720p.HDTV.x264-GROUP");
    expect(p.episodeNumbers).toEqual([1, 2, 3]);
  });

  it("falls back to 1x01 scene notation when SxxExx doesn't match", () => {
    const p = parseReleaseTitle("Show Name 2x07 Some Title 720p");
    expect(p.seasonNumber).toBe(2);
    expect(p.episodeNumbers).toEqual([7]);
  });

  it("detects a full season pack via SXX with no episode", () => {
    const p = parseReleaseTitle("Show.Name.S03.1080p.WEB-DL.DDP5.1-GROUP");
    expect(p.seasonNumber).toBe(3);
    expect(p.isFullSeason).toBe(true);
    expect(p.episodeNumbers).toBeNull();
  });

  it("reads 'Season 1 - 9 Complete' style multi-season collections as packs, not as one episode", () => {
    for (const title of [
      "The Office Season 1 - 9 Complete 1080p",
      "Friends Season 1 - 10 Complete [1080p]",
      "Breaking Bad Season 1 - 5 1080p BluRay",
      "Show S1 - 07 Collection [1080p]",
    ]) {
      const parsed = parseReleaseTitle(title);
      expect(parsed.episodeNumbers, title).toBeNull();
      expect(parsed.isFullSeason, title).toBe(true);
    }
    // Fansub numbering, padded or explicitly an episode, is still one episode.
    expect(parseReleaseTitle("[Erai-raws] Show Season 2 - 05 [1080p]").episodeNumbers).toEqual([5]);
    expect(parseReleaseTitle("[Group] Show S2 - 5 [1080p]").episodeNumbers).toEqual([5]);
  });

  it("parses fansub 'S2 - 05' / 'Season 2 - 05' numbering as one episode, not a season pack", () => {
    for (const title of ["[SubsPlease] Mushoku Tensei S2 - 05 (1080p) [ABCD1234]", "[Erai-raws] Show Season 2 - 05 [1080p]", "[Group] Show S02 - 05v2 [1080p]"]) {
      const p = parseReleaseTitle(title);
      expect(p).toMatchObject({ seasonNumber: 2, episodeNumbers: [5], isFullSeason: false, releaseType: "single" });
    }
  });

  it("reads a fansub episode title that starts with a number as that one episode, not a season pack", () => {
    for (const title of [
      "[Group] Show S2 - 05 - 7 Deadly Sins [1080p]",
      "[Group] Show Season 2 - 05 - 100 Days [1080p]",
      "[Group] Show S2 - 05 - 1080p",
      "[Group] Show S2 - 05-1080p",
      "[Group] Show S2 - 05-720p",
    ]) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: 2, episodeNumbers: [5], isFullSeason: false, releaseType: "single" });
      expect(releaseMatchesEpisode(p, 2, 5)).toBe(true);
      expect(releaseMatchesEpisode(p, 2, 3)).toBe(false);
    }
  });

  it("parses a short fansub dash range as those episodes, not a season pack", () => {
    const p = parseReleaseTitle("[Group] Show S2 - 05-06 [1080p]");
    expect(p).toMatchObject({ seasonNumber: 2, episodeNumbers: [5, 6], isFullSeason: false, releaseType: "multi" });
    expect(releaseMatchesEpisode(p, 2, 6)).toBe(true);
    expect(releaseMatchesEpisode(p, 2, 3)).toBe(false);
    expect(parseReleaseTitle("[Group] Show Season 2 - 11 - 12")).toMatchObject({ seasonNumber: 2, episodeNumbers: [11, 12], isFullSeason: false });
    expect(parseReleaseTitle("[Group] Show S2 - 05-07 [1080p]")).toMatchObject({ seasonNumber: 2, episodeNumbers: [5, 6, 7], isFullSeason: false });
  });

  it("reads a short dash range followed by a resolution or END as those episodes", () => {
    for (const title of ["[Group] Show S2 - 05-06 1080p", "[Group] Show S2 - 05-06 END [1080p]"]) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: 2, episodeNumbers: [5, 6], isFullSeason: false, releaseType: "multi" });
      expect(releaseMatchesEpisode(p, 2, 3), title).toBe(false);
    }
  });

  it("reads an unspaced short dash range followed by other text as those episodes, never a season pack", () => {
    for (const title of ["Show S2 - 05-06 WEB-DL 1080p", "[Group] Show S2 - 05-06 - Title [1080p]", "[Group] Show S2 - 05-06v2 [1080p]"]) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: 2, episodeNumbers: [5, 6], isFullSeason: false, releaseType: "multi" });
      expect(releaseMatchesEpisode(p, 2, 5), title).toBe(true);
      expect(releaseMatchesEpisode(p, 2, 3), title).toBe(false);
    }
  });

  it("reads a long untagged fansub dash range as a batch, not as that many single episodes", () => {
    const p = parseReleaseTitle("[Group] Show S2 - 01-12 [1080p]");
    expect(p).toMatchObject({ seasonNumber: 2, episodeNumbers: null, isFullSeason: true, releaseType: "seasonPack", episodeRange: [1, 12] });
    expect(parseReleaseTitle("[Group] Show S2 - 13-24 (1080p)")).toMatchObject({ seasonNumber: 2, episodeNumbers: null, isFullSeason: true, episodeRange: [13, 24] });
    expect(parseReleaseTitle("Show S2 - 01-24")).toMatchObject({ seasonNumber: 2, episodeNumbers: null, isFullSeason: true, episodeRange: [1, 24] });
    expect(parseReleaseTitle("Show S2 - 01-12 BD 1080p")).toMatchObject({ seasonNumber: 2, isFullSeason: true, episodeRange: [1, 12] });
  });

  it("matches a ranged batch only against the episodes inside its range", () => {
    const partial = parseReleaseTitle("[Group] Show S2 - 13-24 (1080p)");
    expect(releaseMatchesEpisode(partial, 2, 3)).toBe(false);
    expect(releaseMatchesEpisode(partial, 2, 12)).toBe(false);
    expect(releaseMatchesEpisode(partial, 2, 13)).toBe(true);
    expect(releaseMatchesEpisode(partial, 2, 15)).toBe(true);
    expect(releaseMatchesEpisode(partial, 2, 24)).toBe(true);
    expect(releaseMatchesEpisode(partial, 2, 25)).toBe(false);
    expect(releaseMatchesEpisode(partial, 3, 15)).toBe(false);
    // Scene numbering is held to the same range.
    expect(releaseMatchesEpisode(partial, 1, 3, 2, 3)).toBe(false);
    expect(releaseMatchesEpisode(partial, 1, 3, 2, 14)).toBe(true);

    const tilde = parseReleaseTitle("[Moozzi2] Show S2 - 01 ~ 12 (BD 1920x1080 x.264 Flac)");
    expect(tilde).toMatchObject({ isFullSeason: true, episodeRange: [1, 12] });
    expect(releaseMatchesEpisode(tilde, 2, 1)).toBe(true);
    expect(releaseMatchesEpisode(tilde, 2, 12)).toBe(true);
    expect(releaseMatchesEpisode(tilde, 2, 13)).toBe(false);

    // A pack that names no range still covers the whole season.
    const whole = parseReleaseTitle("Show.Name.S02.1080p.WEB-DL-GROUP");
    expect(whole.episodeRange ?? null).toBeNull();
    expect(releaseMatchesEpisode(whole, 2, 40)).toBe(true);
  });

  it("reads a decimal fansub special ('S2 - 12.5') as none of the season's episodes, and no pack", () => {
    for (const title of ["[Group] Show S02 - 05.5 [1080p]", "[Group] Show S2 - 12.5 (1080p)", "[Group] Show Season 2 - 12.5v2 [1080p]"]) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: 2, episodeNumbers: [], isFullSeason: false, releaseType: null });
      for (const episode of [3, 5, 12, 13]) expect(releaseMatchesEpisode(p, 2, episode), `${title} E${episode}`).toBe(false);
    }
  });

  it("parses a dot-separated 'S01.E05' as season 1 episode 5, not a season pack", () => {
    const p = parseReleaseTitle("Show.S01.E05.1080p.WEB-DL-GRP");
    expect(p).toMatchObject({ seasonNumber: 1, episodeNumbers: [5], isFullSeason: false });
  });

  it("still parses real season packs as full seasons", () => {
    for (const [title, season] of [
      ["Show S02 1080p WEB-DL-GRP", 2],
      ["Show Season 2 1080p WEB-DL-GRP", 2],
      ["Show.S01.1080p.BluRay.x264-GRP", 1],
      ["[Group] Show S01 - 01-12 (Batch) [1080p]", 1],
      ["[Moozzi2] Show S2 - 01 ~ 12 (BD 1920x1080 x.264 Flac)", 2],
      ["[Group] Show Season 2 - 01 - 12 [Batch]", 2],
      ["[Moozzi2] Show S2 - 01 ~ 12 + SP (BD 1920x1080 x.264 Flac)", 2],
      ["[Group] Show S2 - 01 ~ 12 + OVA [1080p]", 2],
      ["[Group] Show Season 2 - 01 ~ 12 END [BD 1080p] [Batch]", 2],
      ["[Group] Show S2 - 01 - 12 + OVA [Batch]", 2],
      // A [Batch] tag makes a pack even when the text after the second number hides the range.
      ["[Group] Show S2 - 01 - 12 Complete Series [Batch]", 2],
      // An unspaced range end is never the start of an episode title, whatever follows it.
      ["Show S2 - 01-12 BD 1080p", 2],
      ["Show S02 - 01-12 WEB 1080p", 2],
      ["Show S2 - 01-12 WEB-DL 1080p", 2],
      ["[Group] Show S2 - 01-12 - Complete [1080p]", 2],
    ] as const) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: season, episodeNumbers: null, isFullSeason: true, releaseType: "seasonPack" });
      expect(releaseMatchesEpisode(p, season, 1), title).toBe(true);
      expect(releaseMatchesEpisode(p, season + 1, 1), title).toBe(false);
    }
  });

  it("reads a bracketed batch tag as a pack, never as its first episode", () => {
    const p = parseReleaseTitle("[Group] Show - 01 ~ 12 [Batch] [1080p]");
    expect(p).toMatchObject({ isFullSeason: true, absoluteEpisode: null, episodeNumbers: null });
    // "Batch" as a plain title word is no batch tag.
    expect(parseReleaseTitle("Star.Wars.The.Bad.Batch.S01E05.1080p.WEB-DL-GRP")).toMatchObject({ seasonNumber: 1, episodeNumbers: [5], isFullSeason: false });
  });

  it("reads an untagged season-less batch range as a pack, never as absolute episode 1", () => {
    for (const title of [
      "[Erai-raws] Show 2nd Season - 01 ~ 12 [1080p][Multiple Subtitle]",
      "[Group] Show - 01 ~ 12 [1080p]",
      "[Group] Show - 01 - 12 [1080p]",
      "[Group] Show - 01-12 WEB 1080p",
      "[Group] One Piece - 1000 ~ 1010 [1080p]",
    ]) {
      const p = parseReleaseTitle(title);
      expect(p, title).toMatchObject({ seasonNumber: null, episodeNumbers: null, isFullSeason: true, absoluteEpisode: null });
      expect(releaseMatchesEpisode(p, 1, 1, null, null, 1), title).toBe(false);
      expect(releaseMatchesEpisode(p, 1, 1, null, null, 1000), title).toBe(false);
    }
    expect(parseReleaseTitle("[Erai-raws] Show 2nd Season - 01 ~ 12 [1080p][Multiple Subtitle]").releaseGroup).toBe("Erai-raws");
    // A short range, an episode title and a span of years are no batch.
    expect(parseReleaseTitle("[Group] Show - 05 - 06 [1080p]")).toMatchObject({ isFullSeason: false, absoluteEpisode: 5 });
    expect(parseReleaseTitle("[Group] Show - 05 - 12 Angry Men [1080p]")).toMatchObject({ isFullSeason: false, absoluteEpisode: 5 });
    expect(parseReleaseTitle("[Artist] Discography - 1999-2005 [FLAC]").isFullSeason).toBe(false);
  });

  it("detects a full season pack via the word 'Complete'", () => {
    const p = parseReleaseTitle("Show.Name.Complete.Season.1080p-GROUP");
    expect(p.isFullSeason).toBe(true);
  });

  it("parses a movie release with year, quality, and no season/episode", () => {
    const p = parseReleaseTitle("Movie.Name.2023.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-GROUP");
    expect(p.seasonNumber).toBeNull();
    expect(p.episodeNumbers).toBeNull();
    expect(p.isFullSeason).toBe(false);
    expect(p.year).toBe(2023);
    expect(p.quality).toBe("Remux-2160p");
    expect(p.source).toBe("Remux");
    expect(p.resolution).toBe("2160p");
  });

  it("detects release flags (proper/repack/extended/etc)", () => {
    expect(parseReleaseTitle("Movie.2023.PROPER.1080p-GROUP").flags).toContain("proper");
    expect(parseReleaseTitle("Movie.2023.REPACK.1080p-GROUP").flags).toContain("repack");
    expect(parseReleaseTitle("Movie.2023.EXTENDED.1080p-GROUP").flags).toContain("extended");
    expect(parseReleaseTitle("Movie.2023.Directors.Cut.1080p-GROUP").flags).toContain("directorscut");
    expect(parseReleaseTitle("Movie.2023.IMAX.1080p-GROUP").flags).toContain("imax");
  });

  it("detects language tags", () => {
    const p = parseReleaseTitle("Movie.2023.MULTI.FRENCH.1080p-GROUP");
    expect(p.languages).toContain("multi");
    expect(p.languages).toContain("french");
  });

  it("parses an air-date-based daily release", () => {
    const p = parseReleaseTitle("Late.Show.2024.08.25.1080p.WEB.h264-GROUP");
    expect(p.airDate).toBe("2024-08-25");
  });

  it("rejects an implausible date (month/day out of range) as an air date", () => {
    const p = parseReleaseTitle("Some.Release.2024.99.99.1080p-GROUP");
    expect(p.airDate).toBeNull();
  });

  it("detects a bare anime-style absolute episode number only when no SxxExx matched", () => {
    const p = parseReleaseTitle("[SubsPlease] Some Anime - 145 (1080p) [ABCD1234].mkv");
    expect(p.seasonNumber).toBeNull();
    expect(p.episodeNumbers).toBeNull();
    expect(p.absoluteEpisode).toBe(145);
  });

  it("parses a long-running show's absolute episode even when it equals a common resolution number", () => {
    expect(parseReleaseTitle("[SubsPlease] One Piece - 1080 (1080p) [ABCD1234]").absoluteEpisode).toBe(1080);
    expect(parseReleaseTitle("[Group] Detective Conan - 720 [480p]").absoluteEpisode).toBe(720);
    // A resolution token itself never reads as an episode.
    expect(parseReleaseTitle("Some Release - 1080p [WEB-DL]").absoluteEpisode).toBeNull();
  });

  it("never sets absoluteEpisode when a real SxxExx pattern already matched", () => {
    const p = parseReleaseTitle("Show.Name.S01E05 - 145.1080p-GROUP");
    expect(p.seasonNumber).toBe(1);
    expect(p.absoluteEpisode).toBeNull();
  });

  it("returns Unknown quality for a title with no recognizable quality tag", () => {
    const p = parseReleaseTitle("Some.Random.File.Name");
    expect(p.quality).toBe("Unknown");
  });

  it("assumes WEB-DL when a resolution is present but no source tag is recognized at all", () => {
    // Documented fallback in detectQuality() — a resolution with no Remux/Bluray/WEBRip/HDTV/DVD
    // keyword anywhere in the title defaults to WEB-DL, the most common unlabeled case. Every
    // other quality-asserting test above happens to include an explicit source tag, so this exact
    // branch was previously only ever exercised incidentally (never asserted on).
    const p = parseReleaseTitle("Show.Name.S01E01.1080p.x264-GROUP");
    expect(p.source).toBeNull();
    expect(p.quality).toBe("WEBDL-1080p");
  });

  it("detects Bluray as its own source, distinct from — and not masked by — Remux", () => {
    // The only prior BluRay-tagged fixture in this file also contains "REMUX" in the same title,
    // so Remux (checked first in detectSource's if-chain) always wins there — that test can pass
    // whether or not Bluray-alone detection actually works. This title has no Remux tag at all.
    const p = parseReleaseTitle("Movie.Name.2023.1080p.BluRay.x264-GROUP");
    expect(p.source).toBe("Bluray");
    expect(p.quality).toBe("Bluray-1080p");
  });

  it("detects the bdrip spelling as a Bluray source too", () => {
    const p = parseReleaseTitle("Movie.Name.2023.720p.BDRip.x264-GROUP");
    expect(p.source).toBe("Bluray");
    expect(p.quality).toBe("Bluray-720p");
  });

  it("detects WEBRip as its own source, distinct from WEBDL", () => {
    const p = parseReleaseTitle("Show.Name.S01E01.720p.WEBRip.x264-GROUP");
    expect(p.source).toBe("WEBRip");
    expect(p.quality).toBe("WEBRip-720p");
  });

  it("detects a DVD release as its own bare 'DVD' quality when no resolution tag is present", () => {
    const p = parseReleaseTitle("Movie.Name.2023.DVDRip.XviD-GROUP");
    expect(p.resolution).toBeNull();
    expect(p.source).toBe("DVD");
    expect(p.quality).toBe("DVD");
  });

  it("dedupes languages by their canonical mapped tag, even when two different literal tokens both map to it", () => {
    // TrueFrench and French are different matched substrings but share the same canonical "french"
    // output value — the Set dedupes on that mapped value, not the raw regex match.
    const p = parseReleaseTitle("Movie.2023.TrueFrench.French.1080p-GROUP");
    expect(p.languages).toEqual(["french"]);
  });

  it("returns a null release group when the title has no trailing hyphenated tag", () => {
    const p = parseReleaseTitle("Movie.Name.2023.1080p.WEBDL");
    expect(p.releaseGroup).toBeNull();
  });

  it("doesn't mistake the end of a hyphenated source tag for a release group", () => {
    expect(parseReleaseTitle("Show.S01E01.720p.WEB-DL").releaseGroup).toBeNull();
    expect(parseReleaseTitle("Movie.2020.1080p.Blu-ray").releaseGroup).toBeNull();
    expect(parseReleaseTitle("Movie.2020.720p.BD-Rip").releaseGroup).toBeNull();
    expect(parseReleaseTitle("Show.S01E01.720p.WEB-DL-GRP").releaseGroup).toBe("GRP");
  });

  it("doesn't mistake a trailing episode range end or resolution for a release group", () => {
    expect(parseReleaseTitle("Show.S01E01-02").releaseGroup).toBeNull();
    expect(parseReleaseTitle("Show.S01E01-E02").releaseGroup).toBeNull();
    expect(parseReleaseTitle("[Group] Show S2 - 05-06").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[Group] Show S2 - 05-06v2").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[Group] Show S2 - 05-1080p").releaseGroup).toBe("Group");
    // A numeric scene group after a non-digit still counts.
    expect(parseReleaseTitle("Show.S01E01.1080p.WEB-DL-126811").releaseGroup).toBe("126811");
    expect(parseReleaseTitle("Show.S01E01-02.1080p.WEB-DL-GRP").releaseGroup).toBe("GRP");
    // A resolution after a letter is a quality too, never the group.
    expect(parseReleaseTitle("Show - S01E05 - Title-1080p").releaseGroup).toBeNull();
    expect(parseReleaseTitle("Movie 2020 1080p-2160p").releaseGroup).toBeNull();
  });

  it("keeps a season-less batch's and a WEB/WxH fansub release's leading group, and never reads '10bit' as a range end", () => {
    expect(parseReleaseTitle("[Group] Show - 01-04 [1080p]").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[DB] Show - 01-24 [Dual Audio 10bit BD1080p][HEVC-x265]").releaseGroup).toBe("DB");
    expect(parseReleaseTitle("[Group] Show - 05 [WEB][AAC]").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[Group] Show - 05 [1920x1080 AAC]").releaseGroup).toBe("Group");
    const tenBit = parseReleaseTitle("[Group] Show S2 - 05-10bit [1080p]");
    expect(tenBit.isFullSeason).toBe(false);
    expect(tenBit.episodeNumbers).toEqual([5]);
  });

  it("takes a fansub group from the leading brackets", () => {
    expect(parseReleaseTitle("[SubsPlease] Frieren - 05 (1080p) [ABCD1234]").releaseGroup).toBe("SubsPlease");
    expect(parseReleaseTitle("[Erai-raws] Show - 05 [1080p][Multiple Subtitle]").releaseGroup).toBe("Erai-raws");
    // A leading site or resolution tag isn't a group, and a trailing scene group still wins.
    expect(parseReleaseTitle("[www.example.org] Movie.2020.1080p.WEB-DL").releaseGroup).toBeNull();
    expect(parseReleaseTitle("[1080p] Show - 05").releaseGroup).toBeNull();
    expect(parseReleaseTitle("[TGx] Movie.2020.1080p.WEB-DL-GRP").releaseGroup).toBe("GRP");
  });

  it("never takes a leading year, number or format tag for a release group", () => {
    for (const title of [
      "[FLAC] Artist - Album (2020)",
      "[2020] Movie Title 1080p",
      "[MP3 320] Artist - Album",
      "[FLAC 24bit] Artist - Album",
      "[EPUB] Author - Book",
      "[WEB-DL] Show - 05",
      "[x265 HEVC] Movie Title",
    ]) {
      expect(parseReleaseTitle(title).releaseGroup, title).toBeNull();
    }
    expect(parseReleaseTitle("[SubsPlease] Show - 05 [1080p]").releaseGroup).toBe("SubsPlease");
    expect(parseReleaseTitle("[Erai-raws] Show S2 - 05 [1080p]").releaseGroup).toBe("Erai-raws");
  });

  it("takes a leading bracket as the group only on a fansub-shaped title, never a language or content tag", () => {
    for (const title of [
      "[ENG] Movie 1080p",
      "[MULTi] Movie 2020 1080p",
      "[Audiobook] Author - Title",
      "[Unabridged] Author - Title (2015)",
      "[Brandon Sanderson] Mistborn (epub)",
      "[Discography] Artist",
      "[NSW] Game Title",
      "[VOSTFR] Show - 05 [1080p]",
      "[Dual Audio] Show - 05 [1080p]",
      "[Hi-Res] Prince - 1999 (2019)",
    ]) {
      expect(parseReleaseTitle(title).releaseGroup, title).toBeNull();
    }
    expect(parseReleaseTitle("[Group] Movie Title (2020) [1080p] [ABCD1234]").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[Leopard-Raws] Show - 05 (1080p)").releaseGroup).toBe("Leopard-Raws");
  });

  it("never takes a leading artist or author for a release group on a music or book title", () => {
    for (const title of [
      "[Various Artists] Compilation - 2020 [FLAC]",
      "[Various Artists] Compilation - 1999",
      "[Artist Name] Album - 01 [FLAC]",
      "[Artist Name] Album - 01 [MP3 320]",
      "[Author] Book Series - 03 (epub)",
      "[Artist] Album - 01 [AAC 256]",
      "[Artist] Album - 01 [24bit 96kHz]",
      "[Artist] Album - 01 [Opus 160kbps]",
    ]) {
      expect(parseReleaseTitle(title).releaseGroup, title).toBeNull();
    }
    // A season-numbered episode, a CRC32 or a video tag marks a fansub release whatever its audio.
    for (const title of [
      "[Group] Show S2 - 01 ~ 12 [BD][FLAC]",
      "[Group] Show - 05 [BD][FLAC][ABCD1234]",
      "[Group] Show - 05 [Hi10P][FLAC]",
      "[Group] Show - 05 [10bit][FLAC]",
      "[Group] Show - 05 [BDRip][AAC]",
    ]) {
      expect(parseReleaseTitle(title).releaseGroup, title).toBe("Group");
    }
    // An audio tag on a video release doesn't hide its fansub group.
    expect(parseReleaseTitle("[SubsPlease] Show - 05 [1080p]").releaseGroup).toBe("SubsPlease");
    expect(parseReleaseTitle("[Group] Show - 05 [1080p] [FLAC]").releaseGroup).toBe("Group");
    expect(parseReleaseTitle("[Moozzi2] Show S2 - 01 ~ 12 (BD 1920x1080 x.264 Flac)").releaseGroup).toBe("Moozzi2");
    expect(parseReleaseTitle("[SubsPlease] One Piece - 1080 (1080p) [ABCD1234]").releaseGroup).toBe("SubsPlease");
    expect(parseReleaseTitle("[Group] One Piece - 1080 [720p]").releaseGroup).toBe("Group");
  });

  it("strips leading zeros on both sides of the 1x01 scene notation", () => {
    const p = parseReleaseTitle("Show Name 02x007 Some Title 720p");
    expect(p.seasonNumber).toBe(2);
    expect(p.episodeNumbers).toEqual([7]);
  });

  it("extracts an IMDb id embedded in the release title, lowercased", () => {
    const p = parseReleaseTitle("Movie.Name.2020.1080p.WEBRip.x264-GROUP[TT1234567]");
    expect(p.imdbId).toBe("tt1234567");
  });

  it("returns a null imdbId when the title carries none", () => {
    const p = parseReleaseTitle("Movie.Name.2020.1080p.WEBRip.x264-GROUP");
    expect(p.imdbId).toBeNull();
  });

  it("detects the movie-only low-quality theatrical-capture sources", () => {
    expect(parseReleaseTitle("Movie.Name.2023.CAM.x264-GROUP").source).toBe("Cam");
    expect(parseReleaseTitle("Movie.Name.2023.HDCAM.x264-GROUP").source).toBe("Cam");
    expect(parseReleaseTitle("Movie.Name.2023.TELESYNC.x264-GROUP").source).toBe("Telesync");
    expect(parseReleaseTitle("Movie.Name.2023.TELECINE.x264-GROUP").source).toBe("Telecine");
    expect(parseReleaseTitle("Movie.Name.2023.WORKPRINT.x264-GROUP").source).toBe("Workprint");
  });

  it("detects 480p/576p as their own resolutions", () => {
    expect(parseReleaseTitle("Show.Name.S01E01.480p.WEBRip.x264-GROUP").resolution).toBe("480p");
    expect(parseReleaseTitle("Show.Name.S01E01.576i.DVDRip.x264-GROUP").resolution).toBe("576p");
  });

  it("keeps grading a 480p/576p DVD rip as plain 'DVD' quality — there's no WEBDL-480p tier", () => {
    expect(parseReleaseTitle("Show.Name.S01E01.576i.DVDRip.x264-GROUP").quality).toBe("DVD");
    expect(parseReleaseTitle("Movie.2003.480p.DVDRip.x264-GROUP").quality).toBe("DVD");
  });

  it("grades any other sub-720p video release as the SD tier, so a profile allowing SD can grab it", () => {
    expect(parseReleaseTitle("Show.Name.S01E01.480p.WEBRip.x264-GROUP").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.480p.WEB-DL.x264-GRP").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.HDTV.x264-LOL").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.SDTV.x264-LOL").quality).toBe("SD");
    expect(parseReleaseTitle("Movie.2004.576p.BluRay.x264-GRP").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.WEB.h264-GRP").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.DSR.x264-GRP").quality).toBe("SD");
    expect(parseReleaseTitle("Show.S01E01.SATRip.XviD-GRP").quality).toBe("SD");
    expect(parseReleaseTitle("Movie.2004.BDRip.XviD-GRP").quality).toBe("SD");
    // A theatrical capture stays Unknown, and so does a title with no video tag at all.
    expect(parseReleaseTitle("Movie.Name.2023.CAM.x264-GROUP").quality).toBe("Unknown");
    expect(parseReleaseTitle("Author - Book (2010) [EPUB]").quality).toBe("Unknown");
    expect(parseReleaseTitle("Artist - Album (2020) [WEB FLAC]").quality).toBe("Unknown");
    // A resolution tag still decides the tier of a WEB release.
    expect(parseReleaseTitle("Show.S01E01.1080p.WEB.h264-GRP").quality).toBe("WEBDL-1080p");
  });

  it("never grades a resolution-less disc image, remux or plain BluRay as SD", () => {
    expect(parseReleaseTitle("Inception.2010.COMPLETE.BLURAY-SharpHD").quality).toBe("Unknown");
    expect(parseReleaseTitle("Movie.1999.BluRay.REMUX.AVC.DTS-HD.MA.5.1-GRP").quality).toBe("Unknown");
    expect(parseReleaseTitle("Movie.1999.BDMV.BD50-GRP").quality).toBe("Unknown");
    expect(parseReleaseTitle("Movie.1999.BluRay.x264-GRP").quality).toBe("Unknown");
  });

  it("grades a theatrical capture as Unknown quality, never as the WEBDL fallback for its resolution", () => {
    expect(parseReleaseTitle("Movie.Name.2023.1080p.HDCAM.x264-GROUP").quality).toBe("Unknown");
    expect(parseReleaseTitle("Movie.Name.2023.720p.TELESYNC.x264-GROUP").quality).toBe("Unknown");
  });

  it("detects a quality modifier", () => {
    expect(parseReleaseTitle("Movie.Name.2023.REGIONAL.1080p-GROUP").qualityModifier).toBe("regional");
    expect(parseReleaseTitle("Movie.Name.2023.SCREENER.1080p-GROUP").qualityModifier).toBe("screener");
    expect(parseReleaseTitle("Movie.Name.2023.RAWHD-GROUP").qualityModifier).toBe("rawhd");
    expect(parseReleaseTitle("Movie.Name.2023.BRDISK-GROUP").qualityModifier).toBe("brdisk");
  });

  it("returns a null qualityModifier when none is present", () => {
    const p = parseReleaseTitle("Movie.Name.2023.1080p.BluRay.x264-GROUP");
    expect(p.qualityModifier).toBeNull();
  });

  it("extracts a free-text edition phrase", () => {
    expect(parseReleaseTitle("Movie.Name.2023.Directors.Cut.1080p-GROUP").edition).toMatch(/directors? cut/i);
    expect(parseReleaseTitle("Movie.Name.2023.Criterion.Edition.1080p-GROUP").edition).toMatch(/criterion edition/i);
    expect(parseReleaseTitle("Movie.Name.2023.Extended.1080p-GROUP").edition).toMatch(/extended/i);
  });

  it("returns a null edition when the title has none", () => {
    const p = parseReleaseTitle("Movie.Name.2023.1080p.BluRay.x264-GROUP");
    expect(p.edition).toBeNull();
  });

  it("derives releaseType from the parsed season/episode shape", () => {
    expect(parseReleaseTitle("Show.Name.S02E05.1080p-GROUP").releaseType).toBe("single");
    expect(parseReleaseTitle("Show.Name.S01E01-E03.720p-GROUP").releaseType).toBe("multi");
    expect(parseReleaseTitle("Show.Name.S03.1080p-GROUP").releaseType).toBe("seasonPack");
    expect(parseReleaseTitle("Movie.Name.2023.1080p-GROUP").releaseType).toBeNull();
  });
});

describe("releaseMatchesEpisode", () => {
  it("matches an exact single-episode release", () => {
    const p = parseReleaseTitle("Show.Name.S02E05.1080p.WEB-DL-GROUP");
    expect(releaseMatchesEpisode(p, 2, 5)).toBe(true);
    expect(releaseMatchesEpisode(p, 2, 6)).toBe(false);
    expect(releaseMatchesEpisode(p, 3, 5)).toBe(false);
  });

  it("matches any episode covered by a full-season pack", () => {
    const p = parseReleaseTitle("Show.Name.S02.1080p.WEB-DL-GROUP");
    expect(releaseMatchesEpisode(p, 2, 1)).toBe(true);
    expect(releaseMatchesEpisode(p, 2, 20)).toBe(true);
    expect(releaseMatchesEpisode(p, 3, 1)).toBe(false);
  });

  it("does not match a release with neither an episode list nor a full-season flag", () => {
    const p = parseReleaseTitle("Movie.2023.1080p-GROUP");
    expect(releaseMatchesEpisode(p, 1, 1)).toBe(false);
  });

  it("falls back to scene numbering when the primary season/episode doesn't match", () => {
    const p = parseReleaseTitle("Show.Name.S05E01.1080p-GROUP");
    // Doesn't match the real S01E05 target directly...
    expect(releaseMatchesEpisode(p, 1, 5)).toBe(false);
    // ...but does when the scene-mapped numbering (S05E01) is supplied as an alternative.
    expect(releaseMatchesEpisode(p, 1, 5, 5, 1)).toBe(true);
  });

  it("never matches a fansub 'S2 - 05' single episode against another episode of that season", () => {
    const p = parseReleaseTitle("[SubsPlease] Mushoku Tensei S2 - 05 (1080p) [ABCD1234]");
    expect(releaseMatchesEpisode(p, 2, 5)).toBe(true);
    expect(releaseMatchesEpisode(p, 2, 3)).toBe(false);
  });

  it("falls back to absolute episode number as a last resort, anime-only usage", () => {
    const p = parseReleaseTitle("[Group] Some Anime - 145 [1080p]");
    expect(releaseMatchesEpisode(p, 7, 25)).toBe(false);
    expect(releaseMatchesEpisode(p, 7, 25, null, null, 145)).toBe(true);
  });

  it("prefers a real season/episode match over needing the absolute fallback", () => {
    const p = parseReleaseTitle("Show.Name.S02E05.1080p-GROUP");
    expect(releaseMatchesEpisode(p, 2, 5, null, null, 999)).toBe(true);
  });

  it("ignores scene numbering entirely when only one of season/episode is supplied, rather than partially matching", () => {
    const p = parseReleaseTitle("Show.Name.S05E01.1080p-GROUP");
    expect(releaseMatchesEpisode(p, 1, 5, 5, null)).toBe(false);
    expect(releaseMatchesEpisode(p, 1, 5, null, 1)).toBe(false);
  });
});

describe("releaseMatchesAirDate", () => {
  it("matches an exact air date", () => {
    const p = parseReleaseTitle("Late.Show.2024.08.25.1080p-GROUP");
    expect(releaseMatchesAirDate(p, "2024-08-25")).toBe(true);
    expect(releaseMatchesAirDate(p, "2024-08-26")).toBe(false);
  });

  it("never matches when the release has no parsed air date", () => {
    const p = parseReleaseTitle("Show.Name.S01E01.1080p-GROUP");
    expect(releaseMatchesAirDate(p, "2024-08-25")).toBe(false);
  });
});
