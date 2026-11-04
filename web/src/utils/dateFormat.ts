/**
 * Every date and time the UI shows goes through here, so the display preferences (Settings -> General:
 * first day of the week, date format, time format, time zone, relative dates) apply in one place. With
 * nothing set each function gives what the page showed before the preferences existed: the browser's own
 * formatting, or the stored text where the page printed that.
 *
 * No browser globals are used: server/tests/displayPreferences.test.ts imports this file to test it.
 */

/** The same lists as server/src/services/displayPreferences.ts; a test fails when they drift. */
export const UI_WEEK_STARTS = ["sunday", "monday", "saturday"] as const;
export const UI_DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMM YYYY", "MMM D, YYYY"] as const;
export const UI_TIME_FORMATS = ["12h", "24h"] as const;

export interface DisplayPreferences {
  /** "" = Sunday, the week the Calendar has always started on. */
  weekStart: "" | (typeof UI_WEEK_STARTS)[number];
  /** "" = the browser's locale format. */
  dateFormat: "" | (typeof UI_DATE_FORMATS)[number];
  /** "" = the browser's locale decides between 12 and 24 hours. */
  timeFormat: "" | (typeof UI_TIME_FORMATS)[number];
  /** An IANA time zone name; "" = the browser's own. */
  timeZone: string;
  /** Today / Yesterday / Tomorrow in place of a date. */
  relativeDates: boolean;
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = { weekStart: "", dateFormat: "", timeFormat: "", timeZone: "", relativeDates: false };

let current: DisplayPreferences = DEFAULT_DISPLAY_PREFERENCES;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): "" | T {
  return allowed.find((candidate) => candidate === value) ?? "";
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Takes what GET /api/display-preferences returned (or nothing, for an older server); a value this version does not know counts as unset. */
export function setDisplayPreferences(next: Partial<Record<keyof DisplayPreferences, unknown>> | null | undefined): void {
  const zone = typeof next?.timeZone === "string" ? next.timeZone.trim() : "";
  current = {
    weekStart: oneOf(UI_WEEK_STARTS, next?.weekStart),
    dateFormat: oneOf(UI_DATE_FORMATS, next?.dateFormat),
    timeFormat: oneOf(UI_TIME_FORMATS, next?.timeFormat),
    timeZone: zone !== "" && isTimeZone(zone) ? zone : "",
    relativeDates: next?.relativeDates === true,
  };
}

export function getDisplayPreferences(): DisplayPreferences {
  return current;
}

/** The IANA zone names this browser knows, for the Settings picker; empty on a browser without Intl.supportedValuesOf. */
export function supportedTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return typeof supported === "function" ? supported("timeZone") : [];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Server timestamps are UTC text with no zone marker ("2026-09-24 16:00:00" — SQLite's
 * datetime('now'), and the same format on Postgres via asyncDb's nowExpr). `new Date()` reads
 * that space-separated form as LOCAL time (Safari may not parse it at all), shifting every
 * displayed time by the viewer's UTC offset — this parses it as the UTC it actually is. Anything
 * already carrying a "T"/zone (an ISO string) passes through unchanged. */
export function parseServerTimestamp(value: string): Date {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? new Date(`${value.replace(" ", "T")}Z`) : new Date(value);
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

/** A value that names a day and nothing else ("2024-03-15", "2024-03", "1999"): it has no time zone to convert. */
function isCalendarDateOnly(value: string): boolean {
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value);
}

function toInstant(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : typeof value === "number" ? new Date(value) : parseServerTimestamp(value);
  return isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

interface DayParts {
  year: number;
  month: number;
  day: number;
}

/** The calendar day an instant falls on in the chosen time zone (the browser's when none is chosen). */
function dayOf(instant: Date, timeZone: string): DayParts {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(instant);
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return { year: part("year"), month: part("month"), day: part("day") };
  }
  return { year: instant.getFullYear(), month: instant.getMonth() + 1, day: instant.getDate() };
}

function dayNumber(day: DayParts): number {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function shortMonthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleDateString(undefined, { month: "short" });
}

/** A day written in one of the fixed date formats. */
function inPattern(pattern: string, day: DayParts): string {
  switch (pattern) {
    case "YYYY-MM-DD":
      return `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
    case "DD/MM/YYYY":
      return `${pad2(day.day)}/${pad2(day.month)}/${day.year}`;
    case "MM/DD/YYYY":
      return `${pad2(day.month)}/${pad2(day.day)}/${day.year}`;
    case "D MMM YYYY":
      return `${day.day} ${shortMonthName(day.month)} ${day.year}`;
    case "MMM D, YYYY":
      return `${shortMonthName(day.month)} ${day.day}, ${day.year}`;
    default:
      return `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
  }
}

/** "Today", "Yesterday" or "Tomorrow" in the browser's language when the day is that close to `today`, else null. */
function relativeDayLabel(day: DayParts, today: DayParts): string | null {
  const offset = dayNumber(day) - dayNumber(today);
  if (offset < -1 || offset > 1) return null;
  const label = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(offset, "day");
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

/** A day as text: Today/Yesterday/Tomorrow when relative dates are on, else the chosen date format, else `plain()`. */
function dayText(day: DayParts, now: Date, plain: () => string): string {
  const prefs = current;
  if (prefs.relativeDates) {
    const label = relativeDayLabel(day, dayOf(now, prefs.timeZone));
    if (label) return label;
  }
  return prefs.dateFormat ? inPattern(prefs.dateFormat, day) : plain();
}

function timeOptions(): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = {};
  if (current.timeFormat) options.hourCycle = current.timeFormat === "12h" ? "h12" : "h23";
  if (current.timeZone) options.timeZone = current.timeZone;
  return options;
}

function hasTimePreference(): boolean {
  return current.timeFormat !== "" || current.timeZone !== "";
}

function hasAnyPreference(): boolean {
  return hasTimePreference() || current.dateFormat !== "" || current.relativeDates;
}

// ---------------------------------------------------------------------------
// What the pages call
// ---------------------------------------------------------------------------

/** The date of a calendar day ("2024-03-15", a partial "2024-03" or "1999") or of a timestamp. A calendar day is never
 * moved by the time zone preference: a release date is that day everywhere. A bare year shows as just that year and a
 * year-month as month and year, rather than with a day the value never had. Empty for a value that is not a usable date. */
export function formatDate(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (typeof value === "string" && isCalendarDateOnly(value)) return formatCalendarDate(value, undefined, now);
  const instant = toInstant(value);
  if (!instant) return "";
  const prefs = current;
  return dayText(dayOf(instant, prefs.timeZone), now, () => instant.toLocaleDateString(undefined, prefs.timeZone ? { timeZone: prefs.timeZone } : undefined));
}

/** A calendar date with the Intl `options` the page wants when no date format is chosen (a release date as "Mar 15, 2024"). */
export function formatCalendarDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions, now: Date = new Date()): string {
  if (!value) return "";
  if (/^\d{4}$/.test(value)) return value;
  const date = parseCalendarDate(value);
  if (isNaN(date.getTime())) return "";
  if (/^\d{4}-\d{2}$/.test(value)) {
    return date.toLocaleDateString(undefined, { year: options?.year ?? "numeric", month: options?.month ?? "short" });
  }
  const day: DayParts = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  return dayText(day, now, () => date.toLocaleDateString(undefined, options));
}

/** A calendar day written out with its weekday ("Monday, March 3, 2026"), for the heading of a day page. */
export function formatLongDate(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = parseCalendarDate(value);
  if (isNaN(date.getTime())) return "";
  const prefs = current;
  const day: DayParts = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  if (prefs.relativeDates) {
    const label = relativeDayLabel(day, dayOf(now, prefs.timeZone));
    if (label) return `${label}, ${weekday}`;
  }
  if (prefs.dateFormat) return `${weekday}, ${inPattern(prefs.dateFormat, day)}`;
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** The time of day of a timestamp, in the chosen time zone and 12/24-hour clock. */
export function formatTime(value: string | number | Date | null | undefined): string {
  const instant = toInstant(value);
  if (!instant) return "";
  return hasTimePreference() ? instant.toLocaleTimeString(undefined, timeOptions()) : instant.toLocaleTimeString();
}

/** Date and time of a timestamp (a server timestamp, an ISO string, a Date or epoch milliseconds). */
export function formatDateTime(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const instant = toInstant(value);
  if (!instant) return "";
  const prefs = current;
  if (!hasAnyPreference()) return instant.toLocaleString();
  // Only the clock and zone are chosen: the browser keeps writing the date and joining it to the time its own way.
  if (!prefs.dateFormat && !prefs.relativeDates) return instant.toLocaleString(undefined, timeOptions());
  const date = dayText(dayOf(instant, prefs.timeZone), now, () => instant.toLocaleDateString(undefined, prefs.timeZone ? { timeZone: prefs.timeZone } : undefined));
  return `${date}, ${formatTime(instant)}`;
}

/** A day as the page printed it before there were preferences: the stored YYYY-MM-DD text, until a date format or relative dates is chosen. */
export function formatIsoDate(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  if (!current.dateFormat && !current.relativeDates) return value;
  return formatCalendarDate(value, undefined, now) || value;
}

/** A timestamp as the page printed it before there were preferences: the stored text, until any date or time preference is chosen. */
export function formatIsoDateTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  if (!hasAnyPreference()) return value;
  return formatDateTime(value, now) || value;
}

/** "5 minutes ago" / "in 2 hours" in the browser's language, for a timestamp. */
export function formatRelative(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const instant = toInstant(value);
  if (!instant) return "";
  const seconds = Math.trunc((instant.getTime() - now.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return formatter.format(seconds, "second");
  if (abs < 3600) return formatter.format(Math.trunc(seconds / 60), "minute");
  if (abs < 86_400) return formatter.format(Math.trunc(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return formatter.format(Math.trunc(seconds / 86_400), "day");
  if (abs < 365 * 86_400) return formatter.format(Math.trunc(seconds / (30 * 86_400)), "month");
  return formatter.format(Math.trunc(seconds / (365 * 86_400)), "year");
}

/** The first day of the Calendar's week: 0 = Sunday, 1 = Monday, 6 = Saturday (the Date.getDay() numbering). */
export function weekStartsOn(): 0 | 1 | 6 {
  switch (current.weekStart) {
    case "monday":
      return 1;
    case "saturday":
      return 6;
    default:
      return 0;
  }
}
