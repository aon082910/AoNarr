import { getSetting } from "./settingsStore.js";

/**
 * How the web UI shows dates and times (Starr's FirstDayOfWeek, ShortDateFormat, TimeFormat, TimeZone and
 * ShowRelativeDates). Every value is cosmetic and an empty one means "as the browser does it", which is what
 * the UI did before these settings existed. Any signed-in user needs them, so GET /api/display-preferences
 * serves them outside the admin-only settings routes.
 */

export const UI_WEEK_STARTS = ["sunday", "monday", "saturday"] as const;
/** web/src/utils/dateFormat.ts has the same list; tests/displayPreferences.test.ts fails when the two drift. */
export const UI_DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMM YYYY", "MMM D, YYYY"] as const;
export const UI_TIME_FORMATS = ["12h", "24h"] as const;

export interface DisplayPreferences {
  /** "" = the browser's locale decides. */
  weekStart: "" | (typeof UI_WEEK_STARTS)[number];
  /** "" = the browser's locale format. */
  dateFormat: "" | (typeof UI_DATE_FORMATS)[number];
  /** "" = the browser's locale decides between 12 and 24 hours. */
  timeFormat: "" | (typeof UI_TIME_FORMATS)[number];
  /** An IANA time zone name; "" = the browser's own. */
  timeZone: string;
  /** Today / Yesterday / Tomorrow instead of the date. Off, as the UI always showed plain dates. */
  relativeDates: boolean;
}

let knownZones: ReadonlySet<string> | null = null;

/** The IANA names this Node knows. "UTC" is left out of Intl.supportedValuesOf's list, yet is the name most people type for it. */
function timeZones(): ReadonlySet<string> {
  if (!knownZones) {
    const names = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    knownZones = new Set([...names, "UTC"]);
  }
  return knownZones;
}

/** Why the value is not a time zone name, or null. */
export function timeZoneProblem(value: string): string | null {
  return timeZones().has(value.trim()) ? null : `"uiTimeZone" must be an IANA time zone name such as Europe/Berlin or America/New_York (or UTC)`;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): "" | T {
  return allowed.find((candidate) => candidate === value) ?? "";
}

/** The preferences as stored; a value that is no longer valid (edited by hand, or from a newer version) counts as unset. */
export function displayPreferences(): DisplayPreferences {
  const zone = (getSetting("uiTimeZone") ?? "").trim();
  return {
    weekStart: oneOf(UI_WEEK_STARTS, getSetting("uiWeekStart")),
    dateFormat: oneOf(UI_DATE_FORMATS, getSetting("uiDateFormat")),
    timeFormat: oneOf(UI_TIME_FORMATS, getSetting("uiTimeFormat")),
    timeZone: zone !== "" && timeZones().has(zone) ? zone : "",
    relativeDates: getSetting("uiRelativeDates") === "1",
  };
}
