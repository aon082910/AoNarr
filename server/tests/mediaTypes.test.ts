import { describe, it, expect } from "vitest";
import { MEDIA_TYPES, MEDIA_TYPE_KEYS, isValidMediaType, getMediaTypeConfig, isProbeableFile } from "../src/services/mediaTypes.js";

describe("MEDIA_TYPE_KEYS / isValidMediaType", () => {
  it("every config's own key matches the object key it's stored under", () => {
    for (const [key, config] of Object.entries(MEDIA_TYPES)) {
      expect(config.key).toBe(key);
    }
  });

  it("recognizes every real media type and rejects an unknown one", () => {
    for (const key of MEDIA_TYPE_KEYS) {
      expect(isValidMediaType(key)).toBe(true);
    }
    expect(isValidMediaType("not-a-real-type")).toBe(false);
    expect(isValidMediaType("")).toBe(false);
  });

  it("includes the core Servarr-equivalent types", () => {
    expect(MEDIA_TYPE_KEYS).toEqual(expect.arrayContaining(["movie", "series", "artist", "author"]));
  });
});

describe("getMediaTypeConfig", () => {
  it("returns the config for a known type", () => {
    expect(getMediaTypeConfig("movie").shape).toBe("single");
    expect(getMediaTypeConfig("series").shape).toBe("episodic");
    expect(getMediaTypeConfig("artist").shape).toBe("collection");
  });

  it("throws for an unknown type rather than returning undefined", () => {
    expect(() => getMediaTypeConfig("not-a-real-type")).toThrow();
  });

  it("multiFilePerChild is only set on collection-shape types where a child's download is normally many files (Music albums, Audiobook chapters)", () => {
    const multiFileTypes = MEDIA_TYPE_KEYS.filter((k) => getMediaTypeConfig(k).multiFilePerChild);
    expect(multiFileTypes.sort()).toEqual(["artist", "audiobook"]);
    for (const key of multiFileTypes) {
      expect(getMediaTypeConfig(key).shape).toBe("collection");
    }
  });
});

describe("isProbeableFile", () => {
  it("recognizes common video/audio extensions", () => {
    expect(isProbeableFile("/x/Movie.mkv")).toBe(true);
    expect(isProbeableFile("/x/Song.mp3")).toBe(true);
  });

  it("rejects a non-media extension and a file with no extension at all", () => {
    expect(isProbeableFile("/x/readme.txt")).toBe(false);
    expect(isProbeableFile("/x/noextension")).toBe(false);
  });
});
