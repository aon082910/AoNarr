import { describe, it, expect } from "vitest";
import { translateTrashFormat, type TrashCustomFormat } from "../src/services/trashFormats.js";

describe("translateTrashFormat", () => {
  it("returns empty groups and skipped for a format with no specifications", () => {
    const result = translateTrashFormat({ name: "Empty" });
    expect(result).toEqual({ groups: [], skipped: [] });
  });

  it("maps a ReleaseTitleSpecification to a title group, preserving negate", () => {
    const trash: TrashCustomFormat = {
      name: "Title Test",
      specifications: [{ implementation: "ReleaseTitleSpecification", negate: true, fields: { value: "PROPER" } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([{ type: "title", patterns: ["PROPER"], negate: true }]);
    expect(result.skipped).toEqual([]);
  });

  it("maps a ReleaseGroupSpecification to a releaseGroup group, defaulting negate to false", () => {
    const trash: TrashCustomFormat = {
      name: "Group Test",
      specifications: [{ implementation: "ReleaseGroupSpecification", fields: { value: "FLUX" } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([{ type: "releaseGroup", patterns: ["FLUX"], negate: false }]);
  });

  it("maps a SizeSpecification, converting min/max from GB to MB", () => {
    const trash: TrashCustomFormat = {
      name: "Size Test",
      specifications: [{ implementation: "SizeSpecification", fields: { min: 1, max: 10 } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([{ type: "size", minMb: 1000, maxMb: 10000, negate: false }]);
  });

  it("maps a SizeSpecification with only a max (min omitted) to a null minMb", () => {
    const trash: TrashCustomFormat = {
      name: "Size Max Only",
      specifications: [{ implementation: "SizeSpecification", fields: { max: 5 } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([{ type: "size", minMb: null, maxMb: 5000, negate: false }]);
  });

  it("maps a ResolutionSpecification for a known resolution value", () => {
    const trash: TrashCustomFormat = {
      name: "Resolution Test",
      specifications: [{ implementation: "ResolutionSpecification", fields: { value: 1080 } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([{ type: "resolution", resolutions: ["1080p"], negate: false }]);
  });

  it("skips a ResolutionSpecification for an unmapped resolution value instead of guessing", () => {
    const trash: TrashCustomFormat = {
      name: "Unknown Resolution",
      specifications: [{ implementation: "ResolutionSpecification", fields: { value: 480 } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([]);
    expect(result.skipped).toEqual(["ResolutionSpecification"]);
  });

  it("skips a ReleaseTitleSpecification whose value isn't a string", () => {
    const trash: TrashCustomFormat = {
      name: "Bad Title Value",
      specifications: [{ implementation: "ReleaseTitleSpecification", fields: { value: 123 as any } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([]);
    expect(result.skipped).toEqual(["ReleaseTitleSpecification"]);
  });

  it("reports an internal-only implementation (e.g. QualityModifierSpecification) as skipped", () => {
    const trash: TrashCustomFormat = {
      name: "Internal Only",
      specifications: [{ implementation: "QualityModifierSpecification", fields: { value: "REMUX" } }],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([]);
    expect(result.skipped).toEqual(["QualityModifierSpecification"]);
  });

  it("processes multiple specifications independently, preserving order in both lists", () => {
    const trash: TrashCustomFormat = {
      name: "Mixed",
      specifications: [
        { implementation: "ReleaseGroupSpecification", fields: { value: "FLUX" } },
        { implementation: "LanguageSpecification", fields: { value: 1 } },
        { implementation: "ReleaseTitleSpecification", fields: { value: "REPACK" } },
        { implementation: "IndexerFlagSpecification", fields: { value: 2 } },
      ],
    };
    const result = translateTrashFormat(trash);
    expect(result.groups).toEqual([
      { type: "releaseGroup", patterns: ["FLUX"], negate: false },
      { type: "title", patterns: ["REPACK"], negate: false },
    ]);
    expect(result.skipped).toEqual(["LanguageSpecification", "IndexerFlagSpecification"]);
  });
});
