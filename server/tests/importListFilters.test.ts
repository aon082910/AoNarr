import { describe, it, expect } from "vitest";
import { passesListFilters } from "../src/services/importLists.js";

describe("passesListFilters (pure, no DB)", () => {
  it("allows everything when the list has no filters configured", () => {
    const list = { min_rating: null, min_votes: null, exclude_genres: null };
    expect(passesListFilters(list, { rating: 1, votes: 1, genres: ["horror"] })).toBe(true);
    expect(passesListFilters(list, {})).toBe(true);
  });

  it("rejects a rating below the configured minimum", () => {
    const list = { min_rating: 7, min_votes: null, exclude_genres: null };
    expect(passesListFilters(list, { rating: 6.9 })).toBe(false);
    expect(passesListFilters(list, { rating: 7 })).toBe(true);
    expect(passesListFilters(list, { rating: 8 })).toBe(true);
  });

  it("never rejects on rating when the entry's rating is unknown", () => {
    const list = { min_rating: 9, min_votes: null, exclude_genres: null };
    expect(passesListFilters(list, { rating: null })).toBe(true);
    expect(passesListFilters(list, {})).toBe(true);
  });

  it("rejects a vote count below the configured minimum", () => {
    const list = { min_rating: null, min_votes: 1000, exclude_genres: null };
    expect(passesListFilters(list, { votes: 999 })).toBe(false);
    expect(passesListFilters(list, { votes: 1000 })).toBe(true);
  });

  it("rejects an entry matching an excluded genre, case-insensitively", () => {
    const list = { min_rating: null, min_votes: null, exclude_genres: JSON.stringify(["horror", "documentary"]) };
    expect(passesListFilters(list, { genres: ["Horror", "Comedy"] })).toBe(false);
    expect(passesListFilters(list, { genres: ["Comedy", "Drama"] })).toBe(true);
  });

  it("never rejects on genre when the entry has no genre data", () => {
    const list = { min_rating: null, min_votes: null, exclude_genres: JSON.stringify(["horror"]) };
    expect(passesListFilters(list, { genres: null })).toBe(true);
    expect(passesListFilters(list, { genres: [] })).toBe(true);
  });

  it("combines all three filters (must pass every configured one)", () => {
    const list = { min_rating: 7, min_votes: 500, exclude_genres: JSON.stringify(["horror"]) };
    expect(passesListFilters(list, { rating: 8, votes: 1000, genres: ["comedy"] })).toBe(true);
    expect(passesListFilters(list, { rating: 8, votes: 1000, genres: ["horror"] })).toBe(false);
    expect(passesListFilters(list, { rating: 6, votes: 1000, genres: ["comedy"] })).toBe(false);
    expect(passesListFilters(list, { rating: 8, votes: 100, genres: ["comedy"] })).toBe(false);
  });
});
