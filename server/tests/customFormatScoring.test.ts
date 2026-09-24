import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// One setupTestDb() call for the whole file, shared by both describe blocks below — calling it
// more than once per file isn't safe for the Postgres CI job (the second call's schema
// drop+recreate races against the already-cached db/app modules from the first call within the
// same process, which don't re-run schema setup a second time).
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let qualityProfileId: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  const profile = (await db.prepare("SELECT id FROM quality_profiles LIMIT 1").get()) as { id: number };
  qualityProfileId = profile.id;
});

describe("formatMatches (pure condition-group evaluation)", () => {

  it("matches a single title condition group (OR within patterns)", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "title" as const, patterns: ["REMUX", "BluRay"], negate: false }];
    expect(formatMatches(groups, "Movie.2023.BluRay.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.WEB-DL.1080p-GROUP", null)).toBe(false);
  });

  it("ANDs multiple condition groups together", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [
      { type: "title" as const, patterns: ["BluRay"], negate: false },
      { type: "title" as const, patterns: ["REMUX"], negate: false },
    ];
    // Must contain BOTH "BluRay" and "REMUX" — neither alone is enough.
    expect(formatMatches(groups, "Movie.2023.BluRay.REMUX.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.BluRay.1080p-GROUP", null)).toBe(false);
  });

  it("negates a condition group (must NOT contain)", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "title" as const, patterns: ["x265", "HEVC"], negate: true }];
    expect(formatMatches(groups, "Movie.2023.x264.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.x265.1080p-GROUP", null)).toBe(false);
  });

  it("matches a size condition group within bounds", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "size" as const, minMb: 4000, maxMb: 15000, negate: false }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", 8_000 * 1_000_000)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", 500 * 1_000_000)).toBe(false);
  });

  it("never matches a size condition when no size is known", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "size" as const, minMb: 0, maxMb: 15000, negate: false }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(false);
  });

  // Regression test for a real bug: every other condition type inverts under negate even when its
  // underlying signal is unknown (title/language/releaseGroup all fall through to "return negate ?
  // true : false"), but "size" used to hardcode `false` regardless of negate — reachable from IRC
  // auto-grab (which never knows size upfront) and the Custom Format tester with size left blank.
  it("DOES match a negated size condition when no size is known, same as every other condition type", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "size" as const, minMb: 0, maxMb: 15000, negate: true }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(true);
  });

  it("matches a language condition group", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "language" as const, languages: ["french", "multi"], negate: false }];
    expect(formatMatches(groups, "Movie.2023.MULTI.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.ENGLISH.1080p-GROUP", null)).toBe(false);
  });

  it("matches a releaseGroup condition against the parsed trailing group tag", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "releaseGroup" as const, patterns: ["RARBG"], negate: false }];
    expect(formatMatches(groups, "Movie.2023.1080p-RARBG", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-OTHERGROUP", null)).toBe(false);
  });

  it("matches source and resolution condition groups", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    expect(
      formatMatches([{ type: "source" as const, sources: ["Remux"], negate: false }], "Movie.2023.REMUX.2160p-GROUP", null)
    ).toBe(true);
    expect(
      formatMatches([{ type: "resolution" as const, resolutions: ["2160p"], negate: false }], "Movie.2023.REMUX.2160p-GROUP", null)
    ).toBe(true);
    expect(
      formatMatches([{ type: "resolution" as const, resolutions: ["720p"], negate: false }], "Movie.2023.REMUX.2160p-GROUP", null)
    ).toBe(false);
  });

  it("matches a year range condition group", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "year" as const, minYear: 2020, maxYear: 2025, negate: false }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2010.1080p-GROUP", null)).toBe(false);
  });

  it("matches a releaseFlags condition group", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "releaseFlags" as const, flags: ["proper" as const, "repack" as const], negate: false }];
    expect(formatMatches(groups, "Movie.2023.PROPER.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(false);
  });

  it("matches an indexerFlag condition group against downloadVolumeFactor", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "indexerFlag" as const, indexerFlags: ["freeleech" as const], negate: false }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null, 0)).toBe(true); // 0 = freeleech
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null, 1)).toBe(false); // 1 = normal
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null, null)).toBe(false); // unknown never matches
  });

  it("negated indexerFlag matches when unknown (negate flips 'never matches' too)", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "indexerFlag" as const, indexerFlags: ["freeleech" as const], negate: true }];
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null, null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null, 0)).toBe(false);
  });

  it("returns false for an empty condition-group list", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    expect(formatMatches([], "Movie.2023.1080p-GROUP", null)).toBe(false);
  });

  it("matches an edition condition group against the parsed free-text edition phrase", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "edition" as const, patterns: ["criterion"], negate: false }];
    expect(formatMatches(groups, "Movie.2023.Criterion.Edition.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(false);
  });

  it("matches a qualityModifier condition group", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "qualityModifier" as const, qualityModifiers: ["screener" as const], negate: false }];
    expect(formatMatches(groups, "Movie.2023.SCREENER.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Movie.2023.1080p-GROUP", null)).toBe(false);
  });

  it("matches a releaseType condition group", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    const groups = [{ type: "releaseType" as const, releaseTypes: ["seasonPack" as const], negate: false }];
    expect(formatMatches(groups, "Show.Name.S03.1080p-GROUP", null)).toBe(true);
    expect(formatMatches(groups, "Show.Name.S02E05.1080p-GROUP", null)).toBe(false);
  });

  it("matches the extended source/resolution vocabulary (Cam/Telesync/etc, 480p/576p)", async () => {
    const { formatMatches } = await import("../src/services/customFormatScoring.js");
    expect(formatMatches([{ type: "source" as const, sources: ["Cam"], negate: false }], "Movie.2023.CAM-GROUP", null)).toBe(true);
    expect(
      formatMatches([{ type: "resolution" as const, resolutions: ["480p"], negate: false }], "Movie.2023.480p-GROUP", null)
    ).toBe(true);
  });
});

describe("scoreRelease (DB-backed custom formats + release profiles)", () => {
  it("sums scores of every matching custom format for the given quality profile", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");

    const remux = await db
      .prepare("INSERT INTO custom_formats (name, patterns) VALUES ('Remux', ?)")
      .run(JSON.stringify([{ type: "title", patterns: ["REMUX"], negate: false }]));
    const x265 = await db
      .prepare("INSERT INTO custom_formats (name, patterns) VALUES ('x265', ?)")
      .run(JSON.stringify([{ type: "title", patterns: ["x265"], negate: false }]));

    await db
      .prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, ?)")
      .run(qualityProfileId, Number(remux.lastInsertRowid), 100);
    await db
      .prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, ?)")
      .run(qualityProfileId, Number(x265.lastInsertRowid), -50);

    const result = await scoreRelease("Movie.2023.REMUX.x265.2160p-GROUP", null, qualityProfileId, "movie");
    expect(result.totalScore).toBe(50); // +100 (Remux) - 50 (x265)
    expect(result.matches.map((m) => m.name).sort()).toEqual(["Remux", "x265"]);
    expect(result.rejected).toBe(false);
  });

  it("scores 0 for a format with no per-profile score row", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("INSERT INTO custom_formats (name, patterns) VALUES ('Unscored', ?)").run(
      JSON.stringify([{ type: "title", patterns: ["UNSCOREDTAG"], negate: false }])
    );
    const result = await scoreRelease("Movie.2023.UNSCOREDTAG-GROUP", null, qualityProfileId, "movie");
    const match = result.matches.find((m) => m.name === "Unscored");
    expect(match?.score).toBe(0);
  });

  it("skips a format restricted to media types that don't include this release's type", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db
      .prepare("INSERT INTO custom_formats (name, patterns, media_types) VALUES ('SeriesOnly', ?, ?)")
      .run(JSON.stringify([{ type: "title", patterns: ["SERIESONLYTAG"], negate: false }]), JSON.stringify(["series"]));

    const forMovie = await scoreRelease("Movie.2023.SERIESONLYTAG-GROUP", null, qualityProfileId, "movie");
    expect(forMovie.matches.find((m) => m.name === "SeriesOnly")).toBeUndefined();

    const forSeries = await scoreRelease("Show.S01E01.SERIESONLYTAG-GROUP", null, qualityProfileId, "series");
    expect(forSeries.matches.find((m) => m.name === "SeriesOnly")).toBeDefined();
  });

  // Release profiles are AND'd together, and evaluateReleaseProfiles returns as soon as any one
  // of them rejects — so a profile left over from an earlier test would silently reject releases
  // in a later test too. Each test below clears the table first for true isolation.
  it("rejects a release matching an enabled release profile's must-not-contain term", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db
      .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred) VALUES (?, 1, '[]', ?, '[]')")
      .run("No CAM", JSON.stringify(["cam", "telesync"]));

    const result = await scoreRelease("Movie.2023.CAM.1080p-GROUP", null, qualityProfileId, "movie");
    expect(result.rejected).toBe(true);
    expect(result.rejectReason).toContain("No CAM");
  });

  it("rejects a release missing every must-contain term of an enabled release profile", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db
      .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred) VALUES (?, 1, ?, '[]', '[]')")
      .run("Must be HDR", JSON.stringify(["hdr", "dolby vision"]));

    const rejected = await scoreRelease("Movie.2023.SDR.1080p-GROUP", null, qualityProfileId, "movie");
    expect(rejected.rejected).toBe(true);

    const accepted = await scoreRelease("Movie.2023.HDR.1080p-GROUP", null, qualityProfileId, "movie");
    expect(accepted.rejected).toBe(false);
  });

  it("adds preferred-term scores from an enabled release profile on top of custom-format scores", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db
      .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred) VALUES (?, 1, '[]', '[]', ?)")
      .run("Prefer Atmos", JSON.stringify([{ term: "atmos", score: 25 }]));

    const withAtmos = await scoreRelease("Movie.2023.ATMOS.1080p-NOMATCHINGTAG", null, qualityProfileId, "movie");
    const withoutAtmos = await scoreRelease("Movie.2023.1080p-NOMATCHINGTAG", null, qualityProfileId, "movie");
    expect(withAtmos.rejected).toBe(false);
    expect(withAtmos.totalScore - withoutAtmos.totalScore).toBe(25);
  });

  it("ignores a disabled release profile entirely", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db
      .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred) VALUES (?, 0, '[]', ?, '[]')")
      .run("Disabled Reject Rule", JSON.stringify(["shouldnotreject"]));

    const result = await scoreRelease("Movie.2023.SHOULDNOTREJECT.1080p-GROUP", null, qualityProfileId, "movie");
    expect(result.rejected).toBe(false);
  });

  it("rejects a release over the quality profile's configured maximum size", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db.prepare("UPDATE quality_profiles SET max_size_gb = 5 WHERE id = ?").run(qualityProfileId);
    try {
      const tooBig = await scoreRelease("Movie.2023.2160p.REMUX-GROUP", 6_000_000_000, qualityProfileId, "movie");
      expect(tooBig.rejected).toBe(true);
      expect(tooBig.rejectReason).toMatch(/maximum size/i);

      const withinLimit = await scoreRelease("Movie.2023.1080p.WEB-DL-GROUP", 4_000_000_000, qualityProfileId, "movie");
      expect(withinLimit.rejected).toBe(false);
    } finally {
      await db.prepare("UPDATE quality_profiles SET max_size_gb = NULL WHERE id = ?").run(qualityProfileId);
    }
  });

  it("never rejects on size when the profile has no maximum size configured", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db.prepare("UPDATE quality_profiles SET max_size_gb = NULL WHERE id = ?").run(qualityProfileId);
    const result = await scoreRelease("Movie.2023.2160p.REMUX-GROUP", 80_000_000_000, qualityProfileId, "movie");
    expect(result.rejected).toBe(false);
  });

  it("never rejects on size when the release's size is unknown", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db.prepare("UPDATE quality_profiles SET max_size_gb = 1 WHERE id = ?").run(qualityProfileId);
    try {
      const result = await scoreRelease("Movie.2023.2160p.REMUX-GROUP", null, qualityProfileId, "movie");
      expect(result.rejected).toBe(false);
    } finally {
      await db.prepare("UPDATE quality_profiles SET max_size_gb = NULL WHERE id = ?").run(qualityProfileId);
    }
  });

  it("supports a regex release-profile term wrapped as /pattern/flags", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    await db
      .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred) VALUES (?, 1, '[]', ?, '[]')")
      .run("No x26x codecs", JSON.stringify(["/x26[45]/"]));

    const rejected = await scoreRelease("Movie.2023.x265.1080p-GROUP", null, qualityProfileId, "movie");
    expect(rejected.rejected).toBe(true);
    const accepted = await scoreRelease("Movie.2023.AV1.1080p-GROUP", null, qualityProfileId, "movie");
    expect(accepted.rejected).toBe(false);
  });

  it("scopes a release profile to specific indexers", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    const indexer = await db
      .prepare("INSERT INTO indexers (name, protocol, url) VALUES (?, 'torznab', 'http://example.test')")
      .run("Test Indexer");
    const indexerId = Number(indexer.lastInsertRowid);
    await db
      .prepare(
        "INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred, indexer_ids) VALUES (?, 1, '[]', ?, '[]', ?)"
      )
      .run("Indexer-scoped reject", JSON.stringify(["blockme"]), JSON.stringify([indexerId]));

    const fromThatIndexer = await scoreRelease("Movie.2023.BLOCKME.1080p-GROUP", null, qualityProfileId, "movie", null, null, indexerId);
    expect(fromThatIndexer.rejected).toBe(true);

    const fromOtherIndexer = await scoreRelease(
      "Movie.2023.BLOCKME.1080p-GROUP",
      null,
      qualityProfileId,
      "movie",
      null,
      null,
      indexerId + 1
    );
    expect(fromOtherIndexer.rejected).toBe(false);

    const fromUnknownIndexer = await scoreRelease("Movie.2023.BLOCKME.1080p-GROUP", null, qualityProfileId, "movie");
    expect(fromUnknownIndexer.rejected).toBe(false);
  });

  it("scopes a release profile to specific tags on the media item", async () => {
    const { scoreRelease } = await import("../src/services/customFormatScoring.js");
    await db.prepare("DELETE FROM release_profiles").run();
    const tag = await db.prepare("INSERT INTO tags (name) VALUES (?)").run("anime-only-rule");
    const tagId = Number(tag.lastInsertRowid);
    const item = await db
      .prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Tagged Movie', 'tagged movie')")
      .run();
    const mediaItemId = Number(item.lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(mediaItemId, tagId);

    await db
      .prepare(
        "INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred, tag_ids) VALUES (?, 1, '[]', ?, '[]', ?)"
      )
      .run("Tag-scoped reject", JSON.stringify(["blockme"]), JSON.stringify([tagId]));

    const forTaggedItem = await scoreRelease("Movie.2023.BLOCKME.1080p-GROUP", null, qualityProfileId, "movie", null, mediaItemId);
    expect(forTaggedItem.rejected).toBe(true);

    const untaggedItem = await db
      .prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Untagged Movie', 'untagged movie')")
      .run();
    const forUntaggedItem = await scoreRelease(
      "Movie.2023.BLOCKME.1080p-GROUP",
      null,
      qualityProfileId,
      "movie",
      null,
      Number(untaggedItem.lastInsertRowid)
    );
    expect(forUntaggedItem.rejected).toBe(false);

    const forNoItem = await scoreRelease("Movie.2023.BLOCKME.1080p-GROUP", null, qualityProfileId, "movie");
    expect(forNoItem.rejected).toBe(false);
  });
});
