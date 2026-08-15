export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const gb = bytes / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${gb.toFixed(1)} GB`;
}

interface MediaInfoLike {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  audioChannels: number | null;
}

/** Renders ffprobe-derived file info as a compact string, e.g. "1920x1080 · h264 · 5200 kbps · aac 6ch". */
export function formatMediaInfo(info: MediaInfoLike | null | undefined): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
  if (info.videoCodec) parts.push(info.videoCodec);
  if (info.bitrateKbps) parts.push(`${info.bitrateKbps} kbps`);
  if (info.audioCodec) parts.push(`${info.audioCodec}${info.audioChannels ? ` ${info.audioChannels}ch` : ""}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
