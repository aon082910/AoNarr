import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface MediaInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  audioChannels: number | null;
  durationSeconds: number | null;
}

/**
 * Probes an actual media file with ffprobe for its real codec/resolution/bitrate — the release
 * title's parsed "quality" (e.g. "WEBDL-1080p") is a guess based on naming convention, while this
 * reads the file itself, catching mislabeled or fake releases after the fact. Returns null
 * (never throws) if ffprobe isn't available or the file can't be probed — this is a best-effort
 * enrichment, not something that should ever block an import.
 */
export async function probeMediaInfo(filePath: string): Promise<MediaInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const streams: any[] = data.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");
    const formatBitrate = data.format?.bit_rate ? Number(data.format.bit_rate) : null;

    return {
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      bitrateKbps: formatBitrate ? Math.round(formatBitrate / 1000) : null,
      audioChannels: audioStream?.channels ?? null,
      durationSeconds: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
    };
  } catch (err) {
    log.warn(`[ffprobe] could not probe "${filePath}":`, (err as Error).message);
    return null;
  }
}
