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

  it("does not treat a common resolution number as an absolute episode", () => {
    // "- 1080 " matches the same "hyphen then bare number" shape the absolute-episode detector
    // looks for, but 1080 is a resolution, not a plausible episode count.
    const p = parseReleaseTitle("Some Release - 1080 [WEB-DL]");
    expect(p.absoluteEpisode).toBeNull();
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

  it("falls back to absolute episode number as a last resort, anime-only usage", () => {
    const p = parseReleaseTitle("[Group] Some Anime - 145 [1080p]");
    expect(releaseMatchesEpisode(p, 7, 25)).toBe(false);
    expect(releaseMatchesEpisode(p, 7, 25, null, null, 145)).toBe(true);
  });

  it("prefers a real season/episode match over needing the absolute fallback", () => {
    const p = parseReleaseTitle("Show.Name.S02E05.1080p-GROUP");
    expect(releaseMatchesEpisode(p, 2, 5, null, null, 999)).toBe(true);
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
