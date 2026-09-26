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

/** A calendar date ("2024-03-15", e.g. a release date — or just "2024-03" or "1999" from some
 * providers). `new Date()` reads those forms as UTC midnight, which is the previous day (or Dec 31
 * of the year before) for every viewer west of UTC — this builds them as local dates instead, a
 * partial one as the first of its month/year. A value that carries a time after the date
 * ("2024-03-15T00:00:00Z") still means that calendar day, so only its date part is used. An
 * impossible date ("2024-02-30") comes back as an Invalid Date rather than rolling over. */
export function parseCalendarDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value) ?? /^(\d{4})(?:-(\d{2}))?$/.exec(value);
  if (!m) return new Date(value);
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : new Date(NaN);
}

/** parseCalendarDate(...).toLocaleDateString(), for the common display case. A bare year shows as
 * just that year and a year-month as month and year, rather than with a day the value never had.
 * Empty for a value that isn't a usable date. */
export function formatCalendarDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "";
  if (/^\d{4}$/.test(value)) return value;
  const date = parseCalendarDate(value);
  if (isNaN(date.getTime())) return "";
  if (/^\d{4}-\d{2}$/.test(value)) {
    return date.toLocaleDateString(undefined, { year: options?.year ?? "numeric", month: options?.month ?? "short" });
  }
  return date.toLocaleDateString(undefined, options);
}
