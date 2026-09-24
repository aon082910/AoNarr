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

  it("maps ResolutionSpecification 480 and 576 to 480p/576p", () => {
    for (const [value, expected] of [
      [480, "480p"],
      [576, "576p"],
    ] as const) {
      const result = translateTrashFormat({ name: `SD ${value}`, specifications: [{ implementation: "ResolutionSpecification", fields: { value } }] });
      expect(result).toEqual({ groups: [{ type: "resolution", resolutions: [expected], negate: false }], skipped: [] });
    }
  });

  it("skips a ResolutionSpecification for an unmapped resolution value instead of guessing", () => {
    const trash: TrashCustomFormat = {
      name: "Unknown Resolution",
      specifications: [{ implementation: "ResolutionSpecification", fields: { value: 540 } }],
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

  it("accepts the live Starr API's array-of-{name, value} fields shape as well as a plain object", () => {
    const result = translateTrashFormat({
      name: "Live API Shape",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: [{ name: "value", value: "\\bHDR10\\b" }] },
        { implementation: "SizeSpecification", fields: [{ name: "min", value: 2 }, { name: "max", value: 8 }] },
      ],
    });
    expect(result).toEqual({
      groups: [
        { type: "title", patterns: ["\\bHDR10\\b"], negate: false },
        { type: "size", minMb: 2000, maxMb: 8000, negate: false },
      ],
      skipped: [],
    });
  });

  it("merges the non-required specs of one implementation into ONE OR'd group (a tier list of release groups), not an AND of each", () => {
    const result = translateTrashFormat({
      name: "WEB Tier 01",
      specifications: [
        { implementation: "ReleaseGroupSpecification", fields: { value: "^(FLUX)$" } },
        { implementation: "ReleaseGroupSpecification", fields: { value: "^(NTb)$" } },
        { implementation: "ReleaseGroupSpecification", fields: { value: "^(CMRG)$" } },
      ],
    });
    expect(result).toEqual({ groups: [{ type: "releaseGroup", patterns: ["^(FLUX)$", "^(NTb)$", "^(CMRG)$"], negate: false }], skipped: [] });
  });

  it("merges non-required ResolutionSpecifications into one de-duplicated resolution group", () => {
    const result = translateTrashFormat({
      name: "HD Or UHD",
      specifications: [
        { implementation: "ResolutionSpecification", fields: { value: 1080 } },
        { implementation: "ResolutionSpecification", fields: { value: 2160 } },
        { implementation: "ResolutionSpecification", fields: { value: 1080 } },
      ],
    });
    expect(result).toEqual({ groups: [{ type: "resolution", resolutions: ["1080p", "2160p"], negate: false }], skipped: [] });
  });

  it("reports an OR it can't express as one group (a negated member, or a non-list type like size) as skipped instead of AND'ing it", () => {
    const negatedMember = translateTrashFormat({
      name: "Negated OR",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: { value: "x265" } },
        { implementation: "ReleaseTitleSpecification", negate: true, fields: { value: "HEVC" } },
      ],
    });
    expect(negatedMember).toEqual({ groups: [], skipped: ["ReleaseTitleSpecification"] });

    const sizeOr = translateTrashFormat({
      name: "Size OR",
      specifications: [
        { implementation: "SizeSpecification", fields: { max: 1 } },
        { implementation: "SizeSpecification", fields: { min: 50 } },
      ],
    });
    expect(sizeOr).toEqual({ groups: [], skipped: ["SizeSpecification"] });
  });

  it("turns each required spec into its own AND'd group, and ignores the non-required specs of that same implementation", () => {
    const result = translateTrashFormat({
      name: "Required Mix",
      specifications: [
        { implementation: "ReleaseTitleSpecification", required: true, fields: { value: "\\bREMUX\\b" } },
        { implementation: "ReleaseTitleSpecification", required: true, fields: { value: "\\bBluRay\\b" } },
        { implementation: "ReleaseTitleSpecification", fields: { value: "\\bWEB\\b" } },
        { implementation: "ReleaseGroupSpecification", fields: { value: "^(FLUX)$" } },
      ],
    });
    expect(result).toEqual({
      groups: [
        { type: "title", patterns: ["\\bREMUX\\b"], negate: false },
        { type: "title", patterns: ["\\bBluRay\\b"], negate: false },
        { type: "releaseGroup", patterns: ["^(FLUX)$"], negate: false },
      ],
      skipped: [],
    });
  });

  it("skips a SizeSpecification with neither a min nor a max, rather than producing an always-matching size group", () => {
    expect(translateTrashFormat({ name: "Unbounded", specifications: [{ implementation: "SizeSpecification", fields: {} }] })).toEqual({
      groups: [],
      skipped: ["SizeSpecification"],
    });
    expect(
      translateTrashFormat({
        name: "Unbounded Live Shape",
        specifications: [{ implementation: "SizeSpecification", fields: [{ name: "min", value: null }, { name: "max", value: "" }] }],
      })
    ).toEqual({ groups: [], skipped: ["SizeSpecification"] });
  });

  it("maps an EditionSpecification to an edition group, and ORs several non-required ones into one", () => {
    expect(
      translateTrashFormat({ name: "Not IMAX", specifications: [{ implementation: "EditionSpecification", negate: true, fields: { value: "\\bIMAX\\b" } }] })
    ).toEqual({ groups: [{ type: "edition", patterns: ["\\bIMAX\\b"], negate: true }], skipped: [] });

    expect(
      translateTrashFormat({
        name: "Special Editions",
        specifications: [
          { implementation: "EditionSpecification", fields: { value: "\\bCriterion\\b" } },
          { implementation: "EditionSpecification", fields: { value: "\\bDirector'?s\\b" } },
        ],
      })
    ).toEqual({ groups: [{ type: "edition", patterns: ["\\bCriterion\\b", "\\bDirector'?s\\b"], negate: false }], skipped: [] });
  });
});
