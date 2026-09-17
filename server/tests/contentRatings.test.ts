import { describe, it, expect } from "vitest";
import { contentRatingRank, isRatingBlocked, CONTENT_RATING_ORDER } from "../src/services/contentRatings.js";

describe("contentRatingRank", () => {
  it("ranks movie and TV ratings on one combined scale", () => {
    expect(contentRatingRank("G")).toBeLessThan(contentRatingRank("PG-13")!);
    expect(contentRatingRank("PG-13")).toBeLessThan(contentRatingRank("R")!);
    expect(contentRatingRank("TV-Y")).toBeLessThan(contentRatingRank("TV-MA")!);
  });

  it("returns null for an unrated or unrecognized rating", () => {
    expect(contentRatingRank(null)).toBeNull();
    expect(contentRatingRank("")).toBeNull();
    expect(contentRatingRank("NOT-A-REAL-RATING")).toBeNull();
  });

  it("covers every rating exactly once, worst last", () => {
    expect(new Set(CONTENT_RATING_ORDER).size).toBe(CONTENT_RATING_ORDER.length);
    expect(CONTENT_RATING_ORDER[CONTENT_RATING_ORDER.length - 1]).toBe("NC-17");
  });
});

describe("isRatingBlocked", () => {
  it("blocks a rating stricter than the max", () => {
    expect(isRatingBlocked("R", "PG-13")).toBe(true);
    expect(isRatingBlocked("NC-17", "TV-14")).toBe(true);
  });

  it("allows a rating at or below the max", () => {
    expect(isRatingBlocked("PG-13", "PG-13")).toBe(false);
    expect(isRatingBlocked("G", "PG-13")).toBe(false);
  });

  it("never blocks when there's no restriction (maxRating null)", () => {
    expect(isRatingBlocked("NC-17", null)).toBe(false);
  });

  it("never blocks unrated content, even under a restriction — no reliable signal to block on", () => {
    expect(isRatingBlocked(null, "G")).toBe(false);
  });

  it("never blocks a rating the ordering doesn't recognize, rather than failing closed or open unpredictably", () => {
    expect(isRatingBlocked("UNKNOWN-RATING", "G")).toBe(false);
  });
});
