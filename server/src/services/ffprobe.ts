import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface AudioStreamInfo {
  codec: string | null;
  /** ffprobe's own codec_name is the bare family name (e.g. "dts" for core DTS, DTS-HD HRA, and
   * DTS-HD MA alike) — this is the more specific variant ffprobe reports separately (e.g.
   * "DTS-HD MA"), needed to actually distinguish them. */
  profile: string | null;
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
      profile: s.profile ?? null,
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
/** A "moov atom not found"/similar container-parse failure on a file that plays back fine
 * elsewhere usually isn't the file being corrupt — it's ffprobe catching a network-mounted file
 * (NFS/SMB share, a cache-to-array move still settling) mid-flux, seeing a truncated or
 * inconsistent view that a later read wouldn't. A single short-delayed retry absorbs that without
 * masking a genuinely corrupt file (which fails identically both times). */
const RETRYABLE_FFPROBE_PATTERNS = [/moov atom not found/i, /invalid data found/i, /could not find codec parameters/i];

async function runFfprobe(filePath: string, timeoutMs = 30_000): Promise<{ stdout: string }> {
  return execFileAsync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** `timeoutMs` set: a probe that has its own short deadline (a best-effort look at a file's tags) is not retried. */
async function probeJson(filePath: string, timeoutMs?: number): Promise<any> {
  // "-v error" (not "quiet") — quiet suppresses ffprobe's own explanation of *why* it failed
  // along with the routine info it's actually meant to silence, so a real failure came back with
  // empty stderr and nothing to log beyond "the command failed." error-level still says nothing
  // for a file that probes fine, but keeps the actual reason for one that doesn't.
  let result;
  try {
    result = await runFfprobe(filePath, timeoutMs);
  } catch (err) {
    const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
    if (timeoutMs === undefined && RETRYABLE_FFPROBE_PATTERNS.some((p) => p.test(stderr))) {
      await new Promise((r) => setTimeout(r, 2000));
      result = await runFfprobe(filePath);
    } else {
      throw err;
    }
  }
  return JSON.parse(result.stdout);
}

function logProbeFailure(filePath: string, err: unknown): void {
  // execFile's promisified error carries the real reason on .stderr — the .message alone is
  // just "Command failed: ffprobe <args>", which repeats the command back without saying why it
  // failed (unsupported/corrupt codec, DRM, a genuinely broken file, etc).
  const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.trim();
  log.warn(`[ffprobe] could not probe "${filePath}":`, stderr || (err as Error).message);
}

export async function probeMediaInfo(filePath: string): Promise<MediaInfo | null> {
  try {
    const data = await probeJson(filePath);
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
    logProbeFailure(filePath, err);
    return null;
  }
}

export interface AudioFileTags {
  artist: string | null;
  albumArtist: string | null;
  author: string | null;
  album: string | null;
  title: string | null;
  /** The release date as the file writes it ("1974-03-08", "1974"): the original date when it has one, else its date or year tag. */
  date?: string | null;
  /** The disc this track is on and how many discs the release has ("1/2", "2 of 2", or a separate total tag). */
  disc?: number | null;
  discTotal?: number | null;
}

function wholeNumber(text: string | null | undefined): number | null {
  const m = /^\s*(\d{1,3})\s*$/.exec(text ?? "");
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** "2" and "2/3" are disc 2; "2/3" and a separate total tag say there are 3 discs. */
function discNumbers(value: string | null, total: string | null): { disc: number | null; discTotal: number | null } {
  const pair = /^\s*(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\s*$/i.exec(value ?? "");
  if (pair) return { disc: wholeNumber(pair[1]), discTotal: wholeNumber(pair[2]) ?? wholeNumber(total) };
  return { disc: wholeNumber(value), discTotal: wholeNumber(total) };
}

/** An audio file's own tags (ID3/MP4/Vorbis) — container-level tags first, then the first audio
 * stream's (where Ogg keeps its Vorbis comments). Tag-name case varies by muxer ("ARTIST" vs
 * "artist"), so names are compared lowercased. Returns null (never throws), like probeMediaInfo.
 * `timeoutMs`: a look that gives up after that long and is not tried twice; `quiet`: a failure is not logged
 * (the caller reads many files and says once that it could not). */
export async function probeAudioTags(filePath: string, options: { timeoutMs?: number; quiet?: boolean } = {}): Promise<AudioFileTags | null> {
  try {
    const data = await probeJson(filePath, options.timeoutMs);
    const tags = new Map<string, string>();
    const audioStream = (data.streams ?? []).find((s: any) => s.codec_type === "audio");
    for (const source of [data.format?.tags, audioStream?.tags]) {
      for (const [key, value] of Object.entries(source ?? {})) {
        const text = typeof value === "string" ? value.trim() : "";
        if (text && !tags.has(key.toLowerCase())) tags.set(key.toLowerCase(), text);
      }
    }
    const tag = (name: string) => tags.get(name) ?? null;
    const first = (...names: string[]) => names.map(tag).find((value) => value !== null) ?? null;
    const discs = discNumbers(first("disc", "discnumber"), first("disctotal", "totaldiscs"));
    return {
      artist: tag("artist"),
      albumArtist: tag("album_artist"),
      author: tag("author"),
      album: tag("album"),
      title: tag("title"),
      // An album is dated by its first release (what the library holds), so a reissue's original date comes before its own.
      date: first("originaldate", "originalyear", "date", "year"),
      ...discs,
    };
  } catch (err) {
    if (!options.quiet) logProbeFailure(filePath, err);
    return null;
  }
}

/** The container duration in seconds, unrounded. probeMediaInfo's durationSeconds is rounded to
 * whole seconds, which is fine for display but drifts by up to half a second per file when summed
 * into chapter offsets. Returns null (never throws), like probeMediaInfo. */
export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const duration = Number((await probeJson(filePath)).format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (err) {
    logProbeFailure(filePath, err);
    return null;
  }
}
