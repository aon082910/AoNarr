export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const gb = bytes / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${gb.toFixed(1)} GB`;
}

/** Renders a runtime in minutes as "2h 15m" (or just "45m" under an hour, "3h" for an exact hour) —
 * used by the Library table's Duration column. */
export function formatDuration(totalMinutes: number | null | undefined): string {
  if (!totalMinutes || totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
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
