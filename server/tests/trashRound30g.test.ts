import { describe, it, expect } from "vitest";
import { translateTrashFormat } from "../src/services/trashFormats.js";
import { translateTrashProfile, type TrashProfileFile } from "../src/services/trashProfiles.js";

const title = (value: string, extra: Record<string, unknown> = {}) => ({ implementation: "ReleaseTitleSpecification", fields: { value }, ...extra });

describe("TRaSH patterns that .NET and JS read differently (round 30g, Recyclarr spike)", () => {
  it("drops a leading inline (?i), which is the flag AoNarr always sets", () => {
    const result = translateTrashFormat({ name: "German", specifications: [title("(?i)\\bgerman\\b", { required: true })] }, "radarr");
    expect(result.skipped).toEqual([]);
    expect(result.groups).toEqual([{ type: "title", patterns: ["\\bgerman\\b"], negate: false }]);
  });

  it("the translated pattern matches a release name, case-insensitively", () => {
    const [group] = translateTrashFormat({ name: "German", specifications: [title("(?i)\\bgerman\\b")] }, "radarr").groups;
    const pattern = new RegExp(group.patterns[0], "i");
    expect(pattern.test("Movie.2019.GERMAN.1080p.BluRay-GRP")).toBe(true);
    expect(pattern.test("Movie.2019.1080p.BluRay-GRP")).toBe(false);
  });

  it("reports a pattern JS cannot compile as skipped instead of storing one that never matches", () => {
    // .NET reads the first ] in [])] as a literal member of the class; JS ends the class there.
    const result = translateTrashFormat({ name: "Dubs Only", specifications: [title("[])]dubs?\\b", { required: true })] }, "radarr");
    expect(result.groups).toEqual([]);
    expect(result.skipped).toEqual(["ReleaseTitleSpecification"]);
  });

  it("keeps the other specs of a format whose one pattern cannot be used, and says which implementation was skipped", () => {
    const result = translateTrashFormat(
      {
        name: "Mixed",
        specifications: [title("[])]x", { required: true }), { implementation: "ResolutionSpecification", required: true, fields: { value: 1080 } }],
      },
      "radarr"
    );
    expect(result.groups.map((g) => g.type)).toEqual(["resolution"]);
    expect(result.skipped).toEqual(["ReleaseTitleSpecification"]);
  });

  it("applies the same check to release group and edition patterns", () => {
    for (const implementation of ["ReleaseGroupSpecification", "EditionSpecification"]) {
      const bad = translateTrashFormat({ name: "x", specifications: [{ implementation, required: true, fields: { value: "(unclosed" } }] }, "radarr");
      expect(bad.groups, implementation).toEqual([]);
      expect(bad.skipped, implementation).toEqual([implementation]);
    }
  });

  it("a plain pattern is unchanged", () => {
    const result = translateTrashFormat({ name: "Plain", specifications: [title("^(?!.*\\bx265\\b).*$", { required: true })] }, "radarr");
    expect(result.groups).toEqual([{ type: "title", patterns: ["^(?!.*\\bx265\\b).*$"], negate: false }]);
  });
});

describe("YearSpecification (round 30g)", () => {
  const year = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ implementation: "YearSpecification", required: true, fields, ...extra });

  it("maps min and max to a year condition for Radarr", () => {
    const result = translateTrashFormat({ name: "Old", specifications: [year({ min: 1900, max: 1979 })] }, "radarr");
    expect(result.groups).toEqual([{ type: "year", minYear: 1900, maxYear: 1979, negate: false }]);
    expect(result.skipped).toEqual([]);
  });

  it("accepts one bound and keeps negate", () => {
    const result = translateTrashFormat({ name: "Not old", specifications: [year({ min: 1980 }, { negate: true })] }, "radarr");
    expect(result.groups).toEqual([{ type: "year", minYear: 1980, maxYear: null, negate: true }]);
  });

  it("skips a year spec with no bound at all, and one from Sonarr", () => {
    expect(translateTrashFormat({ name: "x", specifications: [year({})] }, "radarr")).toEqual({ groups: [], skipped: ["YearSpecification"] });
    expect(translateTrashFormat({ name: "x", specifications: [year({ min: 2000 })] }, "sonarr")).toEqual({ groups: [], skipped: ["YearSpecification"] });
    expect(translateTrashFormat({ name: "x", specifications: [year({ min: 2000 })] })).toEqual({ groups: [], skipped: ["YearSpecification"] });
  });
});

describe("Sonarr's remux quality names (round 30g)", () => {
  const ranks = new Map(["SD", "HDTV-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-1080p", "WEBDL-2160p", "Bluray-2160p", "Remux-2160p"].map((n, i) => [n, i]));
  const profile: TrashProfileFile = {
    name: "WEB-1080p (Sonarr)",
    upgradeAllowed: true,
    cutoff: "Bluray-1080p Remux",
    items: [
      { name: "Bluray-2160p Remux", allowed: true },
      { name: "Bluray-1080p Remux", allowed: true },
      { name: "Bluray-1080p", allowed: true },
      { name: "WEB 1080p", allowed: true, items: ["WEBDL-1080p"] },
    ],
  };

  it("maps both names to the ladder's remux tiers instead of dropping them as unmapped", () => {
    const t = translateTrashProfile(profile, ranks, new Map());
    expect(t.unmappedQualities).toEqual([]);
    expect(t.allowedQualities.sort()).toEqual(["Bluray-1080p", "Remux-1080p", "Remux-2160p", "WEBDL-1080p"].sort());
    expect(t.cutoff).toBe("Remux-1080p");
  });

  it("still drops them when the install has no remux tier", () => {
    const withoutRemux = new Map([...ranks].filter(([name]) => !name.startsWith("Remux")));
    const t = translateTrashProfile(profile, withoutRemux, new Map());
    expect(t.unmappedQualities.sort()).toEqual(["Bluray-1080p Remux", "Bluray-2160p Remux"]);
    expect(t.allowedQualities).not.toContain("Remux-1080p");
  });
});
