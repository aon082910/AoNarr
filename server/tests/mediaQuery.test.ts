import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { buildMediaQuery, toFts5Query, clampLimit, clampOffset } from "../src/services/mediaQuery.js";

beforeAll(async () => {
  await setupTestDb();
});

describe("toFts5Query", () => {
  it("phrase-quotes each token and suffixes it for prefix matching", () => {
    expect(toFts5Query("aveng")).toBe(`"aveng"*`);
    expect(toFts5Query("the matrix")).toBe(`"the"* "matrix"*`);
  });

  it("escapes a literal double quote in the input rather than breaking the FTS5 syntax", () => {
    expect(toFts5Query('the "matrix"')).toBe(`"the"* """matrix"""*`);
  });

  it("neutralizes FTS5 operator-like words (AND/OR/NOT/-) by quoting them as literal terms", () => {
    expect(toFts5Query("rocky -2")).toContain(`"-2"*`);
  });
});

describe("clampLimit / clampOffset", () => {
  it("clampLimit falls back to the default for missing/invalid/non-positive input", () => {
    expect(clampLimit(undefined, 60)).toBe(60);
    expect(clampLimit("not a number", 60)).toBe(60);
    expect(clampLimit(0, 60)).toBe(60);
    expect(clampLimit(-5, 60)).toBe(60);
  });

  it("clampLimit caps at the max rather than trusting an arbitrarily large request", () => {
    expect(clampLimit(10_000, 60, 500)).toBe(500);
  });

  it("clampLimit accepts a valid value within bounds", () => {
    expect(clampLimit(25, 60)).toBe(25);
  });

  it("clampOffset floors at zero and falls back for invalid input", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-10)).toBe(0);
    expect(clampOffset("garbage")).toBe(0);
    expect(clampOffset(40)).toBe(40);
  });
});

describe("buildMediaQuery", () => {
  it("short-circuits to an unsatisfiable query for a restricted user with an empty allowedTypes list", async () => {
    const result = await buildMediaQuery({ allowedTypes: [] });
    expect(result.where).toBeNull();
  });

  it("scopes to the requesting user's allowed types when no explicit type filter is given", async () => {
    const result = await buildMediaQuery({ allowedTypes: ["movie", "series"] });
    expect(result.where).toContain("m.type IN (?,?)");
    expect(result.params).toEqual(["movie", "series"]);
  });

  it("an explicit type filter is trusted as already validated against allowedTypes by the caller", async () => {
    // No allowedTypes restriction condition should be added when `type` is already given — the
    // route itself is responsible for rejecting a type outside the user's allowedTypes up front.
    const result = await buildMediaQuery({ type: "movie", allowedTypes: ["movie"] });
    expect(result.where).toBe("m.type = ?");
    expect(result.params).toEqual(["movie"]);
  });

  it("excludes every content rating above the requesting user's maxContentRating", async () => {
    const result = await buildMediaQuery({ allowedTypes: null, maxContentRating: "PG-13" });
    expect(result.where).toContain("m.content_rating IS NULL OR m.content_rating NOT IN");
    // Every rating stricter than PG-13 should be in the exclusion list, and nothing at or below it.
    expect(result.params).toEqual(expect.arrayContaining(["R", "NC-17"]));
    expect(result.params).not.toContain("PG-13");
    expect(result.params).not.toContain("G");
  });

  it("applies no content-rating restriction at all for an admin (maxContentRating null)", async () => {
    const result = await buildMediaQuery({ allowedTypes: null, maxContentRating: null });
    expect(result.where).toBe("1=1");
  });

  it("joins media_item_tags only when filtering by tag", async () => {
    const withTag = await buildMediaQuery({ tagId: "3", allowedTypes: null });
    expect(withTag.fromClause).toContain("JOIN media_item_tags");
    const withoutTag = await buildMediaQuery({ allowedTypes: null });
    expect(withoutTag.fromClause).not.toContain("JOIN");
  });

  it("groupId 'none' combined with a type filters to that type with no group assigned", async () => {
    const result = await buildMediaQuery({ type: "movie", groupId: "none", allowedTypes: ["movie"] });
    expect(result.where).toBe("m.type = ? AND m.group_id IS NULL");
  });

  it("maps each status filter to its own condition", async () => {
    expect((await buildMediaQuery({ status: "monitored", allowedTypes: null })).where).toBe("m.monitored = 1");
    expect((await buildMediaQuery({ status: "unmonitored", allowedTypes: null })).where).toBe("m.monitored = 0");
    expect((await buildMediaQuery({ status: "missing", allowedTypes: null })).where).toBe("m.has_file = 0");
    expect((await buildMediaQuery({ status: "downloaded", allowedTypes: null })).where).toBe("m.has_file = 1");
  });
});
