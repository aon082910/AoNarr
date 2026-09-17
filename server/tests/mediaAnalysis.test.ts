import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { MediaInfo, AudioStreamInfo, SubtitleStreamInfo } from "../src/services/ffprobe.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
// mediaAnalysis.ts imports db/index.js transitively, so — like every DB-touching module in this
// suite — it must be loaded dynamically, after setupTestDb() has set the env vars db/index.js
// reads at first import, never as a static top-level import.
let analyzeCompatibility: (typeof import("../src/services/mediaAnalysis.js"))["analyzeCompatibility"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ analyzeCompatibility } = await import("../src/services/mediaAnalysis.js"));
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
    expect(summary.byResolution["1920x1080"]).toBeGreaterThanOrEqual(1);
    expect(summary.spokenLanguages.eng).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i.title === "Aggregate Test Movie")).toBe(true);
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
