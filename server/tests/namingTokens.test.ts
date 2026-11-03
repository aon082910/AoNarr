import { describe, it, expect } from "vitest";
import { renderTemplate, episodeLabel, multiEpisodeStyleOf, releaseVars, titleVars, namingTemplateProblem } from "../src/services/naming.js";

describe("Starr's token names are aliases of AoNarr's (MM15)", () => {
  it("renders {Series Title}, {Quality Full} and {Release Group} beside AoNarr's own tokens in one template", () => {
    const vars = { parentTitle: "Show", season: 1, episode: 2, episodeTitle: "Pilot", qualityFull: "WEBDL-1080p Proper", releaseGroup: "GRP", quality: "WEBDL-1080p" };
    expect(renderTemplate("{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]-{Release Group}", vars)).toBe(
      "Show - S01E02 - Pilot [WEBDL-1080p Proper]-GRP"
    );
  });

  it("reads a token without regard to case, spaces, dots and dashes", () => {
    expect(renderTemplate("{PARENT TITLE} {air-date} {Absolute:000}", { parentTitle: "Show", airDate: "2020-01-02", absoluteEpisode: 7 })).toBe("Show 2020-01-02 007");
  });

  it("reads the movie, artist, album, author and book names", () => {
    expect(renderTemplate("{Movie Title} ({Release Year})", { title: "Movie", year: 2020 })).toBe("Movie (2020)");
    expect(renderTemplate("{Artist Name}/{Album Title}", { parentTitle: "Artist", childTitle: "Album" })).toBe("Artist/Album");
    expect(renderTemplate("{Author Name}/{Book Title}", { parentTitle: "Author", childTitle: "Book" })).toBe("Author/Book");
  });

  it("still renders an unknown token as nothing", () => {
    expect(renderTemplate("{title}{nothingHere}", { title: "T" })).toBe("T");
  });
});

describe("episodeLabel (MM15, MM25)", () => {
  it("is a plain number for one episode, so {episode:00} still pads it", () => {
    expect(episodeLabel([5])).toBe(5);
  });

  it("writes the multi-episode styles", () => {
    expect(episodeLabel([1, 2, 3], "range")).toBe("01-03");
    expect(episodeLabel([1, 2, 3], "prefixedRange")).toBe("01-E03");
    expect(episodeLabel([1, 2, 3], "extend")).toBe("01-02-03");
    expect(episodeLabel([1, 2, 3], "repeat")).toBe("01E02E03");
    expect(episodeLabel([1, 2], "range")).toBe("01-02");
  });

  it("does not write a range across a gap", () => {
    expect(episodeLabel([1, 3])).toBe("01E03");
    expect(episodeLabel([1, 2, 4])).toBe("01E02E04");
    expect(episodeLabel([3, 1, 2, 2])).toBe("01-03");
  });

  it("falls back to range for an unknown setting", () => {
    expect(multiEpisodeStyleOf("prefixedRange")).toBe("prefixedRange");
    expect(multiEpisodeStyleOf("nonsense")).toBe("range");
    expect(multiEpisodeStyleOf(null)).toBe("range");
  });
});

describe("tokens read from the release and the title (MM15)", () => {
  it("takes group, resolution, codec, edition and the full quality from the release name", () => {
    const vars = releaseVars("Movie.2020.Directors.Cut.1080p.BluRay.x264-GRP", "Bluray-1080p");
    expect(vars).toMatchObject({ releaseGroup: "GRP", resolution: "1080p", videoCodec: "x264", qualityFull: "Bluray-1080p" });
    expect(vars.edition).toMatch(/director/i);
  });

  it("adds Proper or Repack to the full quality", () => {
    expect(releaseVars("Show.S01E01.PROPER.1080p.WEB-DL-GRP", "WEBDL-1080p").qualityFull).toBe("WEBDL-1080p Proper");
    expect(releaseVars("Show.S01E01.REPACK.1080p.WEB-DL-GRP", "WEBDL-1080p").qualityFull).toBe("WEBDL-1080p Repack");
  });

  it("leaves them empty for a file with no release", () => {
    expect(releaseVars(null, "WEBDL-1080p")).toMatchObject({ releaseGroup: "", resolution: "", videoCodec: "", qualityFull: "WEBDL-1080p" });
  });

  it("does not repeat a year the title already ends in", () => {
    expect(titleVars("", "Blade Runner 2049", 2017).titleYear).toBe("Blade Runner 2049 (2017)");
    expect(titleVars("", "Movie (2020)", 2020).titleYear).toBe("Movie (2020)");
    expect(titleVars("parent", "The Wire", 2002)).toMatchObject({ parentTitleThe: "Wire, The", parentTitleYear: "The Wire (2002)" });
    expect(titleVars("", "Who? Me: Yes!", null).cleanTitle).toBe("Who Me Yes");
  });
});

describe("namingTemplateProblem (MM15)", () => {
  it("accepts the default templates and an empty one", () => {
    expect(namingTemplateProblem("series", "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00} - {episodeTitle}")).toBeNull();
    expect(namingTemplateProblem("movie", "{title} ({year})/{title} ({year})")).toBeNull();
    expect(namingTemplateProblem("artist", "{parentTitle}/{childTitle}")).toBeNull();
    expect(namingTemplateProblem("series", "")).toBeNull();
  });

  it("accepts Starr's tokens and provider id tokens", () => {
    expect(namingTemplateProblem("series", "{Series TitleYear} {tvdbId}/Season {season:00}/{Series Title} - S{season:00}E{episode:00}-{Release Group}")).toBeNull();
    expect(namingTemplateProblem("movie", "{Movie Title} ({Release Year}) [imdb-{imdbId}]")).toBeNull();
  });

  it("refuses an episodic file name with no episode token", () => {
    expect(namingTemplateProblem("series", "{parentTitle}/Season {season:00}/{parentTitle}")).toMatch(/needs \{episode\}/);
    expect(namingTemplateProblem("anime", "{parentTitle}/{parentTitle} - {absoluteEpisode:000}")).toBeNull();
  });

  it("refuses a movie file name with no title and a collection with no child title", () => {
    expect(namingTemplateProblem("movie", "{year}")).toMatch(/needs \{title\}/);
    expect(namingTemplateProblem("artist", "{parentTitle}/Album")).toMatch(/childTitle/);
  });

  it("refuses a leading slash, dot-dot, a backslash, a stray colon and an unknown token", () => {
    expect(namingTemplateProblem("movie", "/{title}")).toMatch(/no leading slash/);
    expect(namingTemplateProblem("movie", "../{title}")).toMatch(/no leading slash/);
    expect(namingTemplateProblem("movie", "{title}\\{title}")).toMatch(/not \\/);
    expect(namingTemplateProblem("movie", "{title}: {year}")).toMatch(/character a file name can't hold/);
    expect(namingTemplateProblem("movie", "{title} {yeer}")).toMatch(/Unknown token \{yeer\}/);
  });
});

describe("namingTemplateProblem, after the review", () => {
  it("refuses a brace group that is not a plain token, which would be written out literally", () => {
    expect(namingTemplateProblem("series", "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00} {[Quality Full]}")).toMatch(/not a token/);
    expect(namingTemplateProblem("series", "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00}{-Release Group}")).toMatch(/not a token/);
  });

  it("takes the episode title as the token that tells lectures apart", () => {
    expect(namingTemplateProblem("course", "{parentTitle}/{episodeTitle}")).toBeNull();
  });

  it("writes episodes with a gap as a plain list the app reads back", () => {
    expect(episodeLabel([1, 2, 5])).toBe("01E02E05");
  });
});
