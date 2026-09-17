import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

type ExecFileCallback = (err: (Error & { stderr?: string }) | null, result?: { stdout: string; stderr: string }) => void;
let mockResponses: ({ stdout: string } | { error: string; stderr?: string })[] = [];
let execFileCallCount = 0;

vi.mock("node:child_process", () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    execFileCallCount++;
    const next = mockResponses.shift();
    if (!next) {
      callback(Object.assign(new Error("no mock response queued"), { stderr: "" }));
      return;
    }
    if ("error" in next) {
      callback(Object.assign(new Error(next.error), { stderr: next.stderr ?? "" }));
    } else {
      callback(null, { stdout: next.stdout, stderr: "" });
    }
  },
}));

let probeMediaInfo: (typeof import("../src/services/ffprobe.js"))["probeMediaInfo"];

beforeAll(async () => {
  // ffprobe.ts imports logger.js, which touches config.js/db/index.js transitively.
  await setupTestDb();
  ({ probeMediaInfo } = await import("../src/services/ffprobe.js"));
});

afterEach(() => {
  mockResponses = [];
  execFileCallCount = 0;
});

function queueSuccess(data: unknown): void {
  mockResponses.push({ stdout: JSON.stringify(data) });
}

function queueFailure(message: string, stderr = ""): void {
  mockResponses.push({ error: message, stderr });
}

function videoStream(overrides: Record<string, unknown> = {}) {
  return {
    codec_type: "video",
    codec_name: "h264",
    width: 1920,
    height: 1080,
    avg_frame_rate: "24000/1001",
    bits_per_raw_sample: "8",
    color_transfer: "bt709",
    ...overrides,
  };
}

function audioStream(overrides: Record<string, unknown> = {}) {
  return {
    codec_type: "audio",
    codec_name: "aac",
    channels: 2,
    channel_layout: "stereo",
    bit_rate: "128000",
    tags: { language: "eng" },
    disposition: { default: 1 },
    ...overrides,
  };
}

describe("probeMediaInfo — basic fields", () => {
  it("extracts video/audio codec, resolution, duration, and bitrate", async () => {
    queueSuccess({
      format: { duration: "3600.5", bit_rate: "8000000" },
      streams: [videoStream(), audioStream()],
    });

    const info = await probeMediaInfo("/fake/movie.mkv");

    expect(info).not.toBeNull();
    expect(info!.videoCodec).toBe("h264");
    expect(info!.audioCodec).toBe("aac");
    expect(info!.width).toBe(1920);
    expect(info!.height).toBe(1080);
    expect(info!.durationSeconds).toBe(3601); // rounded
    expect(info!.bitrateKbps).toBe(8000);
    expect(info!.bitDepth).toBe(8);
  });

  it("parses a fractional frame rate into a decimal", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ avg_frame_rate: "24000/1001" })] });

    const info = await probeMediaInfo("/fake/movie.mkv");

    expect(info!.frameRate).toBe(23.98);
  });

  it("treats a 0/0 frame rate as unknown rather than dividing by zero", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ avg_frame_rate: "0/0" })] });

    const info = await probeMediaInfo("/fake/movie.mkv");

    expect(info!.frameRate).toBeNull();
  });

  it("returns null fields gracefully when there's no video stream at all (audio-only file)", async () => {
    queueSuccess({ format: { duration: "180" }, streams: [audioStream()] });

    const info = await probeMediaInfo("/fake/track.mp3");

    expect(info!.videoCodec).toBeNull();
    expect(info!.width).toBeNull();
    expect(info!.hdrFormat).toBe("unknown");
  });
});

describe("probeMediaInfo — audio/subtitle stream extraction", () => {
  it("extracts multiple audio streams with language, bitrate, and default flag", async () => {
    queueSuccess({
      format: {},
      streams: [
        videoStream(),
        audioStream({ tags: { language: "eng" }, disposition: { default: 1 } }),
        audioStream({ codec_name: "ac3", channels: 6, channel_layout: "5.1", tags: { language: "fra" }, disposition: { default: 0 }, bit_rate: "640000" }),
      ],
    });

    const info = await probeMediaInfo("/fake/movie.mkv");

    expect(info!.audioStreams).toHaveLength(2);
    expect(info!.audioStreams[0]).toMatchObject({ codec: "aac", language: "eng", default: true, bitrateKbps: 128 });
    expect(info!.audioStreams[1]).toMatchObject({ codec: "ac3", channels: 6, language: "fra", default: false, bitrateKbps: 640 });
  });

  it("extracts subtitle streams with forced/default flags", async () => {
    queueSuccess({
      format: {},
      streams: [
        videoStream(),
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" }, disposition: { forced: 1, default: 0 } },
        { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "spa" }, disposition: { forced: 0, default: 1 } },
      ],
    });

    const info = await probeMediaInfo("/fake/movie.mkv");

    expect(info!.subtitleStreams).toEqual([
      { codec: "subrip", language: "eng", forced: true, default: false },
      { codec: "hdmv_pgs_subtitle", language: "spa", forced: false, default: true },
    ]);
  });
});

describe("probeMediaInfo — HDR/Dolby Vision detection", () => {
  it("detects plain HDR10 from the PQ (smpte2084) transfer function", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: "smpte2084" })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("hdr10");
  });

  it("detects HLG from the arib-std-b67 transfer function", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: "arib-std-b67" })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("hlg");
  });

  it("detects HDR10+ from a side_data_list entry", async () => {
    queueSuccess({
      format: {},
      streams: [videoStream({ color_transfer: "smpte2084", side_data_list: [{ side_data_type: "HDR10+ Dynamic Metadata" }] })],
    });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("hdr10plus");
  });

  it("detects single-layer Dolby Vision from a DOVI config record", async () => {
    queueSuccess({
      format: {},
      streams: [videoStream({ color_transfer: "unknown", side_data_list: [{ side_data_type: "DOVI configuration record" }] })],
    });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("dolby-vision");
  });

  it("detects single-layer Dolby Vision from a dvhe/dvh1/etc codec tag as a fallback", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: "unknown", codec_tag_string: "dvhe" })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("dolby-vision");
  });

  it("detects dual-layer Dolby Vision (with an HDR10 base layer) when DV and PQ both apply", async () => {
    queueSuccess({
      format: {},
      streams: [videoStream({ color_transfer: "smpte2084", side_data_list: [{ side_data_type: "DOVI configuration record" }] })],
    });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("dolby-vision-hdr10");
  });

  it("reports 'none' for plain SDR content (bt709 transfer)", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: "bt709" })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("none");
  });

  it("reports 'none' when no color_transfer is present at all", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: undefined })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("none");
  });

  it("reports 'unknown' for an unrecognized transfer function", async () => {
    queueSuccess({ format: {}, streams: [videoStream({ color_transfer: "some-exotic-transfer" })] });
    expect((await probeMediaInfo("/fake/x.mkv"))!.hdrFormat).toBe("unknown");
  });
});

describe("probeMediaInfo — retry and failure handling", () => {
  it("retries once on a moov-atom-style transient error and succeeds on the second attempt", async () => {
    queueFailure("Command failed", "moov atom not found");
    queueSuccess({ format: { duration: "60" }, streams: [videoStream()] });

    const info = await probeMediaInfo("/fake/still-settling.mkv");

    expect(info).not.toBeNull();
    expect(info!.durationSeconds).toBe(60);
    expect(execFileCallCount).toBe(2); // proves the retry actually fired, not just that the end result looks right
  }, 10000);

  it("returns null (never throws) when the retry also fails", async () => {
    queueFailure("Command failed", "moov atom not found");
    queueFailure("Command failed", "moov atom not found");

    await expect(probeMediaInfo("/fake/genuinely-corrupt.mkv")).resolves.toBeNull();
    expect(execFileCallCount).toBe(2); // exactly one retry, not a retry loop
  }, 10000);

  it("does not retry a non-transient failure, and returns null", async () => {
    queueFailure("spawn ffprobe ENOENT");

    const info = await probeMediaInfo("/fake/x.mkv");

    expect(info).toBeNull();
    // A queue-length check alone can't prove this: shift() on an empty queue is a silent no-op,
    // so an erroneous second call would leave the queue looking identically empty. Count calls directly.
    expect(execFileCallCount).toBe(1);
  });

  it("returns null instead of throwing on unparseable JSON output", async () => {
    mockResponses.push({ stdout: "this is not json" });

    await expect(probeMediaInfo("/fake/x.mkv")).resolves.toBeNull();
  });
});
