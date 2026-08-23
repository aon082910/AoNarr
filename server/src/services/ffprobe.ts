import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface AudioStreamInfo {
  codec: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  bitrateKbps: number | null;
  default: boolean;
}

export interface SubtitleStreamInfo {
  codec: string | null;
  language: string | null;
  forced: boolean;
  default: boolean;
}

/** "none" for a plain SDR file — colorTransfer/colorPrimaries only get populated at all when
 * ffprobe reports them, which plain H.264 SDR sources very often don't bother tagging. */
export type HdrFormat = "none" | "hdr10" | "hdr10plus" | "hlg" | "dolby-vision" | "dolby-vision-hdr10" | "unknown";

export interface MediaInfo {
  videoCodec: string | null;
  audioCodec: string | null; // primary (first) audio track's codec — kept for backward-compat callers
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  audioChannels: number | null; // primary (first) audio track's channel count — same reasoning
  durationSeconds: number | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;
  bitDepth: number | null;
  hdrFormat: HdrFormat;
  frameRate: number | null;
  audioStreams: AudioStreamInfo[];
  subtitleStreams: SubtitleStreamInfo[];
}

/** Dolby Vision is signaled two ways ffprobe surfaces: a "DOVI configuration record" entry in the
 * video stream's side_data_list (most reliable, present whenever ffmpeg recognizes the config box),
 * or a codec_tag_string starting with dvhe/dvh1 (HEVC) / dvav/dva1 (AVC) — the tag scheme Dolby's
 * spec itself uses, kept as a fallback for older ffmpeg builds that don't parse the config record. */
function detectHdrFormat(videoStream: any): HdrFormat {
  const sideData: any[] = videoStream?.side_data_list ?? [];
  const hasDoviConfig = sideData.some((s) => typeof s.side_data_type === "string" && s.side_data_type.includes("DOVI"));
  const tag = String(videoStream?.codec_tag_string ?? "").toLowerCase();
  const hasDoviTag = /^(dvhe|dvh1|dvav|dva1)/.test(tag);
  const isDolbyVision = hasDoviConfig || hasDoviTag;

  const transfer = String(videoStream?.color_transfer ?? "").toLowerCase();
  const isPq = transfer === "smpte2084";
  const isHlg = transfer === "arib-std-b67";
  const hasHdr10Plus = sideData.some((s) => typeof s.side_data_type === "string" && s.side_data_type.toLowerCase().includes("hdr10+"));

  if (isDolbyVision && isPq) return "dolby-vision-hdr10"; // dual-layer / DV profile 8 with an HDR10-compatible base layer
  if (isDolbyVision) return "dolby-vision";
  if (hasHdr10Plus) return "hdr10plus";
  if (isPq) return "hdr10";
  if (isHlg) return "hlg";
  if (!transfer || transfer === "bt709" || transfer === "unknown") return videoStream ? "none" : "unknown";
  return "unknown";
}

function extractAudioStreams(streams: any[]): AudioStreamInfo[] {
  return streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({
      codec: s.codec_name ?? null,
      channels: s.channels ?? null,
      channelLayout: s.channel_layout ?? null,
      language: s.tags?.language ?? null,
      bitrateKbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : null,
      default: s.disposition?.default === 1,
    }));
}

function extractSubtitleStreams(streams: any[]): SubtitleStreamInfo[] {
  return streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => ({
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
      forced: s.disposition?.forced === 1,
      default: s.disposition?.default === 1,
    }));
}

/**
 * Probes an actual media file with ffprobe for its real codec/resolution/bitrate/HDR-and-Dolby-
 * Vision signaling/every audio+subtitle track — the release title's parsed "quality" (e.g.
 * "WEBDL-1080p") is a guess based on naming convention, while this reads the file itself, catching
 * mislabeled or fake releases after the fact. Returns null (never throws) if ffprobe isn't
 * available or the file can't be probed — this is a best-effort enrichment, not something that
 * should ever block an import.
 */
export async function probeMediaInfo(filePath: string): Promise<MediaInfo | null> {
  try {
    // "-v error" (not "quiet") — quiet suppresses ffprobe's own explanation of *why* it failed
    // along with the routine info it's actually meant to silence, so a real failure came back with
    // empty stderr and nothing to log beyond "the command failed." error-level still says nothing
    // for a file that probes fine, but keeps the actual reason for one that doesn't.
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const streams: any[] = data.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStreams = extractAudioStreams(streams);
    const formatBitrate = data.format?.bit_rate ? Number(data.format.bit_rate) : null;
    const frameRateRaw = videoStream?.avg_frame_rate as string | undefined;
    let frameRate: number | null = null;
    if (frameRateRaw && frameRateRaw !== "0/0") {
      const [num, den] = frameRateRaw.split("/").map(Number);
      if (den) frameRate = Math.round((num / den) * 100) / 100;
    }

    return {
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStreams[0]?.codec ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      bitrateKbps: formatBitrate ? Math.round(formatBitrate / 1000) : null,
      audioChannels: audioStreams[0]?.channels ?? null,
      durationSeconds: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
      colorTransfer: videoStream?.color_transfer ?? null,
      colorPrimaries: videoStream?.color_primaries ?? null,
      colorSpace: videoStream?.color_space ?? null,
      bitDepth: videoStream?.bits_per_raw_sample ? Number(videoStream.bits_per_raw_sample) : null,
      hdrFormat: detectHdrFormat(videoStream),
      frameRate,
      audioStreams,
      subtitleStreams: extractSubtitleStreams(streams),
    };
  } catch (err) {
    // execFile's promisified error carries the real reason on .stderr — the .message alone is
    // just "Command failed: ffprobe <args>", which repeats the command back without saying why it
    // failed (unsupported/corrupt codec, DRM, a genuinely broken file, etc).
    const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.trim();
    log.warn(`[ffprobe] could not probe "${filePath}":`, stderr || (err as Error).message);
    return null;
  }
}
