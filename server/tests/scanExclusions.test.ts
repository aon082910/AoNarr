import { describe, it, expect } from "vitest";
import path from "node:path";
import { scanFilterFor, isExcludedFolder, isExcludedFile } from "../src/services/scanExclusions.js";

describe("scanExclusions", () => {
  const movies = scanFilterFor("movie");

  it("skips NAS, media-server and trash folders for every type", () => {
    for (const type of ["movie", "series", "artist", "author", "rom", "course", "adult"]) {
      const filter = scanFilterFor(type);
      for (const name of ["@eaDir", ".@__thumb", "#recycle", "@Recycle", "$RECYCLE.BIN", "lost+found", "Plex Versions", ".recycle", ".hidden"]) {
        expect(isExcludedFolder(name, path.join("/lib", name), filter), `${type}: ${name}`).toBe(true);
      }
    }
  });

  it("skips a movie's or show's extras folders, whatever their case", () => {
    for (const name of ["Extras", "featurettes", "Behind The Scenes", "Deleted Scenes", "Interviews", "Scenes", "Shorts", "Trailers", "Samples", "Theme Music", "Backdrops"]) {
      expect(isExcludedFolder(name, path.join("/lib", name), movies), name).toBe(true);
    }
  });

  it("keeps a Specials or Season folder, and a folder named like an extras folder in a library where it is content", () => {
    expect(isExcludedFolder("Specials", "/lib/Show/Specials", movies)).toBe(false);
    expect(isExcludedFolder("Season 01", "/lib/Show/Season 01", movies)).toBe(false);
    expect(isExcludedFolder("Shorts", "/lib/Channel/Shorts", scanFilterFor("video"))).toBe(false);
    expect(isExcludedFolder("Scenes", "/lib/Studio/Scenes", scanFilterFor("adult"))).toBe(false);
  });

  it("skips a folder named in excludedPaths (the recycle bin inside a root)", () => {
    const filter = scanFilterFor("movie", ["/lib/bin"]);
    expect(isExcludedFolder("bin", path.join("/lib", "bin"), filter)).toBe(true);
    expect(isExcludedFolder("other", path.join("/lib", "other"), filter)).toBe(false);
  });

  it("skips trailers, featurettes and samples named beside a movie, not a movie that merely contains the word", () => {
    for (const name of ["Inception (2010)-trailer.mp4", "Movie-featurette.mkv", "Movie-behindthescenes.mkv", "Movie-deleted.mkv", "Movie-interview.mkv", "Movie-scene.mkv", "Movie-short.mkv", "Movie-other.mkv", "inception-sample.mkv", "sample.mkv", "Movie.sample.mkv"]) {
      expect(isExcludedFile(name, movies), name).toBe(true);
    }
    for (const name of ["Trailer Park Boys (2001).mkv", "The Sample Size (2020).mkv", "Short Circuit (1986).mkv", "Movie (2010).mkv"]) {
      expect(isExcludedFile(name, movies), name).toBe(false);
    }
  });

  it("keeps an episode or film whose title ends in one of those words, and a release whose group is called OTHER or SCENE", () => {
    for (const name of [
      "Law & Order - S01E04 - Crime Scene.mkv",
      "Show - S02E05 - Cut Short.mkv",
      "Show - S03E01 - Job Interview.mkv",
      "Show - S01E02 - The Other.mkv",
      "The Interview.mkv",
      "Show.S01E02.720p.HDTV.x264-OTHER.mkv",
      "Show.S01E02.720p.HDTV.x264-SCENE.mkv",
      "Movie.2010.1080p.BluRay.x264-SHORT.mkv",
      "Movie.2010.1080p.WEB-DL-INTERVIEW.mkv",
    ]) {
      expect(isExcludedFile(name, movies), name).toBe(false);
    }
  });

  it("skips an extras folder only inside a title's own folder, never a movie or show that is called that", () => {
    expect(isExcludedFolder("Extras", "/lib/Extras", movies, 0)).toBe(false);
    expect(isExcludedFolder("Shorts", "/lib/Shorts", movies, 0)).toBe(false);
    expect(isExcludedFolder("Extras", "/lib/Show/Extras", movies, 1)).toBe(true);
    // Junk folders are skipped at any depth.
    expect(isExcludedFolder("@eaDir", "/lib/@eaDir", movies, 0)).toBe(true);
  });

  it("applies the suffix rule to movies and shows only", () => {
    expect(isExcludedFile("clip-short.mp4", scanFilterFor("video"))).toBe(false);
    expect(isExcludedFile("clip-trailer.mp4", scanFilterFor("adult"))).toBe(false);
    expect(isExcludedFile("Show-trailer.mkv", scanFilterFor("series"))).toBe(true);
    expect(isExcludedFile("Show-trailer.mkv", scanFilterFor("anime"))).toBe(true);
  });

  it("always skips AoNarr's own import temporaries", () => {
    expect(isExcludedFile(".aonarr-tmp-0123abcd-9f8e7d6c5b4a", scanFilterFor("rom"))).toBe(true);
    expect(isExcludedFile(".aonarr-old-feedbeef.mkv", scanFilterFor("movie"))).toBe(true);
  });
});
