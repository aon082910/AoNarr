import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

beforeAll(async () => {
  await setupTestDb();
});

describe("titlesMatch", () => {
  it("matches identical titles regardless of case/punctuation", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("Dune: Part Two", "dune part two")).toBe(true);
  });

  it("is substring-tolerant in either direction — the fuzziness titleAndYearMatch relies on", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("The Office", "The Office (US)")).toBe(true);
    expect(titlesMatch("The Office (US)", "The Office")).toBe(true);
  });

  it("rejects unrelated titles", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("Dune", "Totally Unrelated Movie")).toBe(false);
  });

  it("never matches when either side normalizes to empty", async () => {
    const { titlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(titlesMatch("", "Anything")).toBe(false);
    expect(titlesMatch("!!!", "Anything")).toBe(false);
  });
});

// Regression coverage for a real bug: starrImport.ts's artist/author matching used the
// substring-tolerant titlesMatch above with no year to gate it (artists/authors have no year field
// at all) — the exact class of cross-item-merge bug libraryScan.ts's own titlesMatch was made
// exact-only to fix (e.g. "Extraction" swallowing "Extraction 2"), reintroduced here for
// Lidarr/Readarr imports. exactTitlesMatch exists specifically so that call site can't do this.
describe("exactTitlesMatch", () => {
  it("matches identical titles regardless of case/punctuation, same as titlesMatch", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("Dune: Part Two", "dune part two")).toBe(true);
  });

  it("does NOT match a title that is merely a substring of the other, unlike titlesMatch", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("Extraction", "Extraction 2")).toBe(false);
    expect(exactTitlesMatch("The Office", "The Office UK")).toBe(false);
  });

  it("never matches when either side normalizes to empty", async () => {
    const { exactTitlesMatch } = await import("../src/services/mediaServerImport.js");
    expect(exactTitlesMatch("", "")).toBe(false);
  });
});

describe("titleAndYearMatch", () => {
  it("uses substring-tolerant matching when both years are known and agree", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    expect(titleAndYearMatch("The Office", 2005, "The Office (US)", 2005)).toBe(true);
  });

  it("never matches when both years are known but disagree, even if titles are identical", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    expect(titleAndYearMatch("Extraction", 2020, "Extraction", 2023)).toBe(false);
  });

  it("falls back to an EXACT title match (no substring tolerance) when either year is unknown", async () => {
    const { titleAndYearMatch } = await import("../src/services/mediaServerImport.js");
    // Two unknown years must not trivially match each other via substring tolerance — this is the
    // exact scenario titleAndYearMatch's own doc comment warns "Extraction 2" folding into
    // "Extraction" under.
    expect(titleAndYearMatch("Extraction", null, "Extraction 2", null)).toBe(false);
    expect(titleAndYearMatch("Dune", null, "Dune", null)).toBe(true);
    expect(titleAndYearMatch("Dune", 2021, "Dune", null)).toBe(false);
    expect(titleAndYearMatch("Dune", null, "Dune", 2021)).toBe(false);
  });
});

describe("externalIdsOverlap", () => {
  it("matches when any one provider's id agrees", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ tmdb: "123", imdb: "tt999" }, { tmdb: "123" })).toBe(true);
  });

  it("does not match when the same provider has a different id", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ tmdb: "123" }, { tmdb: "456" })).toBe(false);
  });

  it("does not match when there's no shared provider at all", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap({ imdb: "tt999" }, { tmdb: "123" })).toBe(false);
  });

  it("treats a null/missing existing-ids map as no overlap rather than throwing", async () => {
    const { externalIdsOverlap } = await import("../src/services/mediaServerImport.js");
    expect(externalIdsOverlap(null, { tmdb: "123" })).toBe(false);
  });
});
