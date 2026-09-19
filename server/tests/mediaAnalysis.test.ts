import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { MediaInfo, AudioStreamInfo, SubtitleStreamInfo } from "../src/services/ffprobe.js";

const probeMediaInfo = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
// mediaAnalysis.ts imports db/index.js transitively, so — like every DB-touching module in this
// suite — it must be loaded dynamically, after setupTestDb() has set the env vars db/index.js
// reads at first import, never as a static top-level import.
let analyzeCompatibility: (typeof import("../src/services/mediaAnalysis.js"))["analyzeCompatibility"];
let runLibraryAnalysis: (typeof import("../src/services/mediaAnalysis.js"))["runLibraryAnalysis"];
let normalizeLanguage: (typeof import("../src/services/mediaAnalysis.js"))["normalizeLanguage"];
let resolutionTier: (typeof import("../src/services/mediaAnalysis.js"))["resolutionTier"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ analyzeCompatibility, runLibraryAnalysis, normalizeLanguage, resolutionTier } = await import("../src/services/mediaAnalysis.js"));
});

function audio(overrides: Partial<AudioStreamInfo> = {}): AudioStreamInfo {
  return { codec: "aac", channels: 2, channelLayout: "stereo", language: null, bitrateKbps: null, default: true, ...overrides };
}

function subtitle(overrides: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo {
  return { codec: "subrip", language: null, forced: false, default: false, ...overrides };
}

function mediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    bitrateKbps: 8000,
    audioChannels: 2,
    durationSeconds: 3600,
    colorTransfer: null,
    colorPrimaries: null,
    colorSpace: null,
    bitDepth: 8,
    hdrFormat: "none",
    frameRate: 23.976,
    audioStreams: [audio()],
    subtitleStreams: [],
    ...overrides,
  };
}

describe("analyzeCompatibility", () => {
  it("reports h264/aac (the common case) as fully ok, with no HDR/bit-depth notes", () => {
    const notes = analyzeCompatibility(mediaInfo());
    expect(notes.every((n) => n.level === "ok")).toBe(true);
    expect(notes.some((n) => n.message.toLowerCase().includes("h.264"))).toBe(true);
  });

  it("flags an uncommon video codec with a generic caution naming the codec", () => {
    const notes = analyzeCompatibility(mediaInfo({ videoCodec: "theora" }));
    const note = notes.find((n) => n.message.includes("theora"));
    expect(note?.level).toBe("caution");
  });

  it("flags single-layer Dolby Vision as caution (no HDR10 fallback)", () => {
    const notes = analyzeCompatibility(mediaInfo({ hdrFormat: "dolby-vision" }));
    expect(notes.find((n) => n.message.includes("no HDR10 fallback"))?.level).toBe("caution");
  });

  it("treats dual-layer Dolby Vision (with HDR10 base layer) as ok", () => {
    const notes = analyzeCompatibility(mediaInfo({ hdrFormat: "dolby-vision-hdr10" }));
    expect(notes.find((n) => n.message.includes("Dual-layer Dolby Vision"))?.level).toBe("ok");
  });

  it("flags HDR10+ as caution (needs a compatible display for dynamic metadata)", () => {
    const notes = analyzeCompatibility(mediaInfo({ hdrFormat: "hdr10plus" }));
    expect(notes.find((n) => n.message.startsWith("HDR10+"))?.level).toBe("caution");
  });

  it("treats plain HDR10 and HLG as ok", () => {
    expect(analyzeCompatibility(mediaInfo({ hdrFormat: "hdr10" })).find((n) => n.message.startsWith("HDR10 —"))?.level).toBe("ok");
    expect(analyzeCompatibility(mediaInfo({ hdrFormat: "hlg" })).find((n) => n.message.startsWith("HLG"))?.level).toBe("ok");
  });

  it("adds no HDR-related note at all for SDR content", () => {
    const notes = analyzeCompatibility(mediaInfo({ hdrFormat: "none" }));
    expect(notes.some((n) => n.message.toLowerCase().includes("hdr") || n.message.toLowerCase().includes("dolby"))).toBe(false);
  });

  it("flags 10-bit color as caution but says nothing about bit depth for 8-bit", () => {
    expect(analyzeCompatibility(mediaInfo({ bitDepth: 10 })).some((n) => n.message.includes("10-bit"))).toBe(true);
    expect(analyzeCompatibility(mediaInfo({ bitDepth: 8 })).some((n) => n.message.includes("bit color"))).toBe(false);
  });

  it("adds a caution note per uncommon audio codec, deduplicating identical repeats", () => {
    const notes = analyzeCompatibility(
      mediaInfo({ audioStreams: [audio({ codec: "truehd" }), audio({ codec: "truehd" }), audio({ codec: "some-made-up-codec" })] })
    );
    const trueHdNotes = notes.filter((n) => n.message.includes("TrueHD"));
    expect(trueHdNotes).toHaveLength(1);
    expect(notes.some((n) => n.message.includes("some-made-up-codec"))).toBe(true);
  });

  it("flags image-based subtitles (PGS/VobSub/DVB) but not text-based ones", () => {
    const withImageSubs = analyzeCompatibility(mediaInfo({ subtitleStreams: [subtitle({ codec: "hdmv_pgs_subtitle" })] }));
    expect(withImageSubs.some((n) => n.message.includes("Image-based subtitles"))).toBe(true);

    const withTextSubs = analyzeCompatibility(mediaInfo({ subtitleStreams: [subtitle({ codec: "subrip" })] }));
    expect(withTextSubs.some((n) => n.message.includes("Image-based subtitles"))).toBe(false);
  });
});

describe("normalizeLanguage", () => {
  it("resolves 2-letter and 3-letter forms of the same language to one canonical name", () => {
    expect(normalizeLanguage("en")).toBe("English");
    expect(normalizeLanguage("eng")).toBe("English");
  });

  it("resolves both the bibliographic and terminology ISO 639-2 forms to the same name", () => {
    // Muxers aren't consistent about which they write — "ger"/"deu" (German), "fre"/"fra" (French),
    // and "chi"/"zho" (Chinese) are the most common real-world mismatches this fixes.
    expect(normalizeLanguage("ger")).toBe(normalizeLanguage("deu"));
    expect(normalizeLanguage("fre")).toBe(normalizeLanguage("fra"));
    expect(normalizeLanguage("chi")).toBe(normalizeLanguage("zho"));
  });

  it("is case-insensitive", () => {
    expect(normalizeLanguage("ENG")).toBe("English");
    expect(normalizeLanguage("Eng")).toBe("English");
  });

  it("treats missing, empty, and 'und' (undetermined) as Unknown rather than three different buckets", () => {
    expect(normalizeLanguage(null)).toBe("Unknown");
    expect(normalizeLanguage(undefined)).toBe("Unknown");
    expect(normalizeLanguage("")).toBe("Unknown");
    expect(normalizeLanguage("und")).toBe("Unknown");
  });

  it("falls back to the raw uppercased code for something it can't resolve, instead of crashing", () => {
    expect(normalizeLanguage("zzz")).toBe("ZZZ");
  });
});

describe("resolutionTier", () => {
  it("classifies standard landscape dimensions into the app's existing named tiers", () => {
    expect(resolutionTier(3840, 2160)).toBe("2160p (4K)");
    expect(resolutionTier(1920, 1080)).toBe("1080p");
    expect(resolutionTier(1280, 720)).toBe("720p");
    expect(resolutionTier(720, 576)).toBe("576p");
    expect(resolutionTier(720, 480)).toBe("480p");
  });

  it("classifies a cinematically-cropped 1080p master by its stable width, not its shrunk height", () => {
    // A 2.4:1 crop of a 1080p master is commonly 1920x804 — using height alone would misclassify
    // this as 720p even though it's really a 1080p source.
    expect(resolutionTier(1920, 804)).toBe("1080p");
  });

  it("returns Unknown when either dimension is missing", () => {
    expect(resolutionTier(null, 1080)).toBe("Unknown");
    expect(resolutionTier(1920, null)).toBe("Unknown");
    expect(resolutionTier(undefined, undefined)).toBe("Unknown");
  });
});

describe("getLibraryAnalysis", () => {
  async function insertMovie(title: string, mediaInfoValue: string | null): Promise<void> {
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path, media_info)
         VALUES ('movie', ?, ?, 1, 1, 'unknown', ?, ?)`
      )
      .run(title, title.toLowerCase(), `/fake/${title}.mkv`, mediaInfoValue);
  }

  it("aggregates codec/resolution/language counts from stored media_info across analyzable files", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie(
      "Aggregate Test Movie",
      JSON.stringify(mediaInfo({ videoCodec: "hevc", audioStreams: [audio({ codec: "eac3", language: "eng" })] }))
    );

    const { summary, items } = await getLibraryAnalysis("movie");
    expect(summary.byVideoCodec.hevc).toBeGreaterThanOrEqual(1);
    expect(summary.byResolution["1080p"]).toBeGreaterThanOrEqual(1);
    expect(summary.spokenLanguages.English).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i.title === "Aggregate Test Movie")).toBe(true);
  });

  // Regression test: raw language tags used to be the grouping key directly, so "en"/"eng"/"ENG"
  // (and letterboxed vs. unletterboxed dimensions of the same resolution) showed up as separate
  // rows in the summary tables instead of one combined count.
  it("collapses differently-tagged forms of the same language/resolution into one summary bucket", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie(
      "Dedup Movie One",
      JSON.stringify(mediaInfo({ width: 1920, height: 1080, audioStreams: [audio({ language: "en" })], subtitleStreams: [subtitle({ language: "eng" })] }))
    );
    await insertMovie(
      "Dedup Movie Two",
      // Letterboxed crop of the same 1080p source, and the bibliographic ISO 639-2 form of the
      // same language tag — both should land in the exact same buckets as the file above.
      JSON.stringify(mediaInfo({ width: 1920, height: 804, audioStreams: [audio({ language: "eng" })], subtitleStreams: [subtitle({ language: "en" })] }))
    );

    const { summary } = await getLibraryAnalysis("movie");
    expect(summary.byResolution["1080p"]).toBeGreaterThanOrEqual(2);
    expect(summary.byResolution["1920x1080"]).toBeUndefined();
    expect(summary.spokenLanguages.English).toBeGreaterThanOrEqual(2);
    expect(summary.subtitleLanguages.English).toBeGreaterThanOrEqual(2);
    expect(summary.spokenLanguages.en).toBeUndefined();
    expect(summary.spokenLanguages.eng).toBeUndefined();
  });

  it("buckets an audio/subtitle track with no language tag as Unknown instead of omitting it entirely", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie(
      "No Language Tag Movie",
      JSON.stringify(mediaInfo({ audioStreams: [audio({ language: null })], subtitleStreams: [subtitle({ language: null })] }))
    );

    const { summary } = await getLibraryAnalysis("movie");
    expect(summary.spokenLanguages.Unknown).toBeGreaterThanOrEqual(1);
    expect(summary.subtitleLanguages.Unknown).toBeGreaterThanOrEqual(1);
  });

  it("counts a file with no media_info at all as filesWithoutMediaInfo, excluded from items", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie("No MediaInfo Movie", null);

    const { summary, items } = await getLibraryAnalysis("movie");
    expect(items.some((i) => i.title === "No MediaInfo Movie")).toBe(false);
    expect(summary.filesWithoutMediaInfo).toBeGreaterThanOrEqual(1);
  });

  it("treats malformed JSON in media_info the same as missing, instead of throwing", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie("Malformed Json Movie", "{ not valid json");

    await expect(getLibraryAnalysis("movie")).resolves.not.toThrow();
    const { items } = await getLibraryAnalysis("movie");
    expect(items.some((i) => i.title === "Malformed Json Movie")).toBe(false);
  });

  it("treats the pre-Round-60 narrow MediaInfo shape (no audioStreams/hdrFormat) as not-yet-analyzed", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie("Legacy Shape Movie", JSON.stringify({ videoCodec: "h264", width: 1920, height: 1080 }));

    const { items } = await getLibraryAnalysis("movie");
    expect(items.some((i) => i.title === "Legacy Shape Movie")).toBe(false);
  });

  it("includes compatibility notes computed per item", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie("Compat Notes Movie", JSON.stringify(mediaInfo({ hdrFormat: "dolby-vision" })));

    const { items } = await getLibraryAnalysis("movie");
    const item = items.find((i) => i.title === "Compat Notes Movie");
    expect(item?.compatibilityNotes.some((n) => n.message.includes("no HDR10 fallback"))).toBe(true);
  });

  it("scopes results to the requested type, excluding other types", async () => {
    const { getLibraryAnalysis } = await import("../src/services/mediaAnalysis.js");
    await insertMovie("Type Scoped Movie", JSON.stringify(mediaInfo()));
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path, media_info)
         VALUES ('ppv', 'Type Scoped PPV', 'type scoped ppv', 1, 1, 'unknown', '/fake/ppv.mkv', ?)`
      )
      .run(JSON.stringify(mediaInfo()));

    const { items } = await getLibraryAnalysis("movie");
    expect(items.some((i) => i.title === "Type Scoped Movie")).toBe(true);
    expect(items.some((i) => i.title === "Type Scoped PPV")).toBe(false);
  });
});

describe("runLibraryAnalysis", () => {
  // Every call re-probes literally every has_file/path row of the given type across three tables,
  // with no per-test isolation in this file otherwise — give each test its own never-reused type
  // string so results can never pick up another test's leftover rows, same technique as
  // jobRegistry.test.ts's per-test job keys.
  let typeCounter = 0;
  function uniqueType(): string {
    return `analysis-test-${++typeCounter}`;
  }

  async function insertMediaItem(type: string, title: string, filePath: string | null, hasFile = 1): Promise<number> {
    const result = await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path)
         VALUES (?, ?, ?, 1, ?, 'unknown', ?)`
      )
      .run(type, title, title.toLowerCase(), hasFile, filePath);
    return Number(result.lastInsertRowid);
  }

  async function insertEpisode(mediaItemId: number, filePath: string | null): Promise<number> {
    const result = await db
      .prepare(
        `INSERT INTO episodes (media_item_id, season_number, episode_number, has_file, file_path)
         VALUES (?, 1, 1, 1, ?)`
      )
      .run(mediaItemId, filePath);
    return Number(result.lastInsertRowid);
  }

  async function insertSubItem(mediaItemId: number, title: string, filePath: string | null): Promise<number> {
    const result = await db
      .prepare(`INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, ?, 1, ?)`)
      .run(mediaItemId, title, filePath);
    return Number(result.lastInsertRowid);
  }

  beforeEach(() => {
    probeMediaInfo.mockReset();
  });

  it("probes a media_items file with a probeable extension, stores the result, and counts it as probed", async () => {
    const type = uniqueType();
    const id = await insertMediaItem(type, "Probeable Movie", "/fake/movie.mkv");
    probeMediaInfo.mockResolvedValue(mediaInfo({ videoCodec: "hevc" }));

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 1, failed: 0 });

    const row = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(id)) as { media_info: string };
    expect(JSON.parse(row.media_info).videoCodec).toBe("hevc");
  });

  it("skips a file whose extension isn't probeable, without calling probeMediaInfo or touching media_info", async () => {
    const type = uniqueType();
    const id = await insertMediaItem(type, "Poster Only", "/fake/poster.jpg");
    probeMediaInfo.mockResolvedValue(mediaInfo());

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 0, failed: 0 });
    expect(probeMediaInfo).not.toHaveBeenCalled();

    const row = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(id)) as { media_info: string | null };
    expect(row.media_info).toBeNull();
  });

  it("counts a failed probe (null result) as failed rather than probed, and leaves media_info untouched", async () => {
    const type = uniqueType();
    const id = await insertMediaItem(type, "Broken File", "/fake/broken.mkv");
    probeMediaInfo.mockResolvedValue(null);

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 0, failed: 1 });

    const row = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(id)) as { media_info: string | null };
    expect(row.media_info).toBeNull();
  });

  it("re-probes an episode's own file and updates the episodes table, not its parent media_items row", async () => {
    const type = uniqueType();
    const parentId = await insertMediaItem(type, "Some Series", null, 0);
    const epId = await insertEpisode(parentId, "/fake/s01e01.mkv");
    probeMediaInfo.mockResolvedValue(mediaInfo({ videoCodec: "av1" }));

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 1, failed: 0 });

    const epRow = (await db.prepare("SELECT media_info FROM episodes WHERE id = ?").get(epId)) as { media_info: string };
    expect(JSON.parse(epRow.media_info).videoCodec).toBe("av1");
    const parentRow = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(parentId)) as { media_info: string | null };
    expect(parentRow.media_info).toBeNull();
  });

  it("re-probes a sub_item's own file (e.g. an audiobook) and updates the sub_items table", async () => {
    const type = uniqueType();
    const parentId = await insertMediaItem(type, "Some Author", null, 0);
    const subId = await insertSubItem(parentId, "Some Book", "/fake/book.m4b");
    probeMediaInfo.mockResolvedValue(mediaInfo({ audioCodec: "aac" }));

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 1, failed: 0 });

    const subRow = (await db.prepare("SELECT media_info FROM sub_items WHERE id = ?").get(subId)) as { media_info: string };
    expect(JSON.parse(subRow.media_info).audioCodec).toBe("aac");
  });

  it("aggregates probed/failed counts across media_items, episodes, and sub_items in a single call", async () => {
    const type = uniqueType();
    await insertMediaItem(type, "Movie Half", "/fake/movie.mkv");
    const seriesId = await insertMediaItem(type, "Series Half", null, 0);
    await insertEpisode(seriesId, "/fake/ep.mkv");
    const authorId = await insertMediaItem(type, "Author Half", null, 0);
    await insertSubItem(authorId, "Book Half", "/fake/book.m4b");

    probeMediaInfo.mockImplementation(async (filePath: string) => (filePath.includes("book") ? null : mediaInfo()));

    const result = await runLibraryAnalysis(type);
    expect(result).toEqual({ probed: 2, failed: 1 });
  });

  it("returns immediately without probing anything when the signal is already aborted", async () => {
    const type = uniqueType();
    const parentId = await insertMediaItem(type, "Never Probed", "/fake/movie.mkv");
    await insertEpisode(parentId, "/fake/ep.mkv");
    const controller = new AbortController();
    controller.abort();
    probeMediaInfo.mockResolvedValue(mediaInfo());

    const result = await runLibraryAnalysis(type, controller.signal);
    expect(result).toEqual({ probed: 0, failed: 0 });
    expect(probeMediaInfo).not.toHaveBeenCalled();

    const row = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(parentId)) as { media_info: string | null };
    expect(row.media_info).toBeNull();
  });

  it("stops mid-scan once the signal aborts between rows, leaving the remaining row unprobed", async () => {
    const type = uniqueType();
    const firstId = await insertMediaItem(type, "Probed Before Abort", "/fake/first.mkv");
    const secondId = await insertMediaItem(type, "Never Reached", "/fake/second.mkv");
    const controller = new AbortController();
    probeMediaInfo.mockImplementationOnce(async () => {
      controller.abort();
      return mediaInfo();
    });

    const result = await runLibraryAnalysis(type, controller.signal);
    expect(result).toEqual({ probed: 1, failed: 0 });
    expect(probeMediaInfo).toHaveBeenCalledTimes(1);

    const firstRow = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(firstId)) as { media_info: string | null };
    expect(firstRow.media_info).not.toBeNull();
    const secondRow = (await db.prepare("SELECT media_info FROM media_items WHERE id = ?").get(secondId)) as { media_info: string | null };
    expect(secondRow.media_info).toBeNull();
  });
});
