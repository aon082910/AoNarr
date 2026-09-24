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

/** Server timestamps are UTC text with no zone marker ("2026-09-24 16:00:00" — SQLite's
 * datetime('now'), and the same format on Postgres via asyncDb's nowExpr). `new Date()` reads
 * that space-separated form as LOCAL time (Safari may not parse it at all), shifting every
 * displayed time by the viewer's UTC offset — this parses it as the UTC it actually is. Anything
 * already carrying a "T"/zone (an ISO string) passes through unchanged. */
export function parseServerTimestamp(value: string): Date {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? new Date(`${value.replace(" ", "T")}Z`) : new Date(value);
}

/** parseServerTimestamp(...).toLocaleString(), for the common display case. */
export function formatServerTimestamp(value: string | null | undefined): string {
  return value ? parseServerTimestamp(value).toLocaleString() : "";
}
