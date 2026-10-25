import { describe, it, expect } from "vitest";
import { categoriesFor, mediaTypesForCategories } from "../src/services/indexerCategories.js";

describe("categoriesFor", () => {
  it("is the type's own list when the indexer has none of its own", () => {
    expect(categoriesFor(null, "5000")).toBe("5000");
    expect(categoriesFor("  ", "5000")).toBe("5000");
  });

  it("uses the indexer's list for a type it covers, and keeps only the part of it that does", () => {
    expect(categoriesFor("5000,5040", "5000")).toBe("5000,5040");
    expect(categoriesFor("5000,5040,2000", "5000")).toBe("5000,5040");
    expect(categoriesFor("2000,2040,5070", "2000,5060")).toBe("2000,2040,5070");
  });

  it("uses the type's own list for a type the indexer's list does not cover", () => {
    expect(categoriesFor("2000,2040", "5000")).toBe("5000");
    expect(categoriesFor("5000", "7000")).toBe("7000");
  });

  it("keeps an indexer's custom ids with the standard ones, and uses a list of custom ids alone for every type", () => {
    expect(categoriesFor("5000,100001", "5000")).toBe("5000,100001");
    expect(categoriesFor("5000,100001", "7000")).toBe("7000");
    expect(categoriesFor("100001,100002", "7000")).toBe("100001,100002");
  });
});

describe("mediaTypesForCategories", () => {
  it("serves the types whose parent category the indexer lists", () => {
    expect(mediaTypesForCategories([5000, 5030, 5040, 5070])).toEqual(["ppv", "series", "anime", "sports", "course"]);
    expect(mediaTypesForCategories([2000, 2040, 2045])).toEqual(["movie", "ppv"]);
    expect(mediaTypesForCategories([3000, 3010, 3030])).toEqual(["artist", "audiobook"]);
    expect(mediaTypesForCategories([7000, 7020, 7030])).toEqual(["author", "comic", "manga"]);
    expect(mediaTypesForCategories([1000, 4050])).toEqual(["rom"]);
    expect(mediaTypesForCategories([6000, 6040])).toEqual(["adult"]);
  });

  it("is null for an indexer that lists nothing this app knows", () => {
    expect(mediaTypesForCategories([])).toBeNull();
    expect(mediaTypesForCategories([8000, 100001])).toBeNull();
  });
});
