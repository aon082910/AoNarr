import { getSetting, setSetting } from "../settingsStore.js";

/**
 * Throttlearr settings: the limits that decide when a held grab may be sent to its download client.
 * Stored as one JSON object under SETTINGS_KEY so it is versioned and validated in one place. Anything
 * missing, malformed or out of range falls back to the default, so a hand-edited or older value never
 * stops the scheduler.
 */

export const SETTINGS_KEY = "throttlearr";
export const SETTINGS_VERSION = 1;

/** A weekly window in the server's local time. `days` are 0 (Sunday) to 6; `from` and `to` are "HH:MM".
 * A window with `to` before `from` runs past midnight into the next day. */
export interface ThrottleWindow {
  days: number[];
  from: string;
  to: string;
}

export interface ClientLimits {
  /** Most jobs the client may hold at once (0 or null: no limit). */
  maxActive: number | null;
  /** Most bytes still to download across the client's jobs (null: no limit). */
  maxActiveBytes: number | null;
  /** Most adds in any rolling hour (null: no limit). TorBox allows 60 NZB adds per hour. */
  addsPerHour: number | null;
  /** The download path must have at least this much free space (null: no check). */
  minFreeBytes: number | null;
  /** Hours the client may be fed. Empty: any time. */
  windows: ThrottleWindow[];
}

export interface PrioritySettings {
  /** Added to gate_priority at hold time, per class of grab. Higher is released first. */
  movies: number;
  recentTv: number;
  backlog: number;
  /** Backlog (aired over a year ago) is released only inside the quiet-hours/night window. */
  backlogOnlyAtNight: boolean;
  /** The night, in the server's local time ("HH:MM"), for backlogOnlyAtNight. */
  nightFrom: string;
  nightTo: string;
}

/** Checks run before a release may take a slot (see preflight.ts). They run only while Throttlearr itself is on. */
export interface PreflightSettings {
  /** The master switch for the checks below. */
  enabled: boolean;
  /** Refuse samples, trailers, extras, .nfo files, incomplete and passworded names. */
  junkNames: boolean;
  /** Refuse a release far under the size its quality and runtime need. */
  sizeFloor: boolean;
  /** Read an NZB's file list when the client adapter fetches it: no video, a password, a program, too little video. */
  inspectNzb: boolean;
  /** Judge a release by its name only, ignoring the id an indexer reports for it. Indexers hand the wrong film's id to a
   * release, and an id that matches settles a release whose title does not; with this on, the title has to match too. A
   * release under a title AoNarr has no alias for (a foreign or regional title) is lost, so it is off by default. */
  strictIdentity: boolean;
}

export interface ThrottlearrSettings {
  version: number;
  /** The feature flag. Off: every grab goes to the client at once, as before Throttlearr existed. */
  enabled: boolean;
  /** Log what would be held, hold nothing. */
  dryRun: boolean;
  /** Hold every gated grab, whatever the room. */
  holdAll: boolean;
  /** A held grab older than this is dropped and its target searched again. */
  maxHeldAgeHours: number;
  /** Interactive (hand-picked) and forced grabs skip the hold. */
  bypassManual: boolean;
  /** Limits by download client id (as a string key). A client with no entry is not limited. */
  clients: Record<string, ClientLimits>;
  priority: PrioritySettings;
  /** Most jobs of one title (a series, a movie) a client holds at once, so one show cannot take every slot. null: no limit. */
  perTitleLimit: number | null;
  preflight: PreflightSettings;
}

export const DEFAULT_CLIENT_LIMITS: ClientLimits = {
  maxActive: null,
  maxActiveBytes: null,
  addsPerHour: null,
  minFreeBytes: null,
  windows: [],
};

export const DEFAULT_SETTINGS: ThrottlearrSettings = {
  version: SETTINGS_VERSION,
  enabled: false,
  dryRun: false,
  holdAll: false,
  maxHeldAgeHours: 72,
  bypassManual: true,
  clients: {},
  priority: { movies: 20, recentTv: 10, backlog: 0, backlogOnlyAtNight: false, nightFrom: "23:00", nightTo: "07:00" },
  perTitleLimit: 3,
  preflight: { enabled: true, junkNames: true, sizeFloor: true, inspectNzb: true, strictIdentity: false },
};

const MAX_HELD_AGE_HOURS = 24 * 30;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** A whole number from `min` up (finite), else the fallback. */
function int(v: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** A positive limit, or null for "no limit" (null, 0, negative or not a number). */
function limit(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(v));
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function windowOf(v: unknown): ThrottleWindow | null {
  const w = obj(v);
  if (typeof w.from !== "string" || typeof w.to !== "string" || !TIME.test(w.from) || !TIME.test(w.to)) return null;
  const days = Array.isArray(w.days)
    ? Array.from(new Set(w.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
    : [];
  // A window with no valid day is every day; one from 00:00 to 00:00 is the whole day (a no-op window), kept as given.
  return { days: days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6], from: w.from, to: w.to };
}

export function normalizeClientLimits(v: unknown): ClientLimits {
  const c = obj(v);
  const windows = Array.isArray(c.windows) ? c.windows.map(windowOf).filter((w): w is ThrottleWindow => w !== null) : [];
  return {
    maxActive: limit(c.maxActive),
    maxActiveBytes: limit(c.maxActiveBytes),
    addsPerHour: limit(c.addsPerHour),
    minFreeBytes: limit(c.minFreeBytes),
    windows,
  };
}

/** Turns whatever is stored (or posted) into valid settings. Never throws. */
export function normalizeSettings(raw: unknown): ThrottlearrSettings {
  const s = obj(raw);
  const d = DEFAULT_SETTINGS;
  const clients: Record<string, ClientLimits> = {};
  for (const [id, limits] of Object.entries(obj(s.clients))) {
    if (/^\d+$/.test(id)) clients[id] = normalizeClientLimits(limits);
  }
  const p = obj(s.priority);
  return {
    version: SETTINGS_VERSION,
    enabled: bool(s.enabled, d.enabled),
    dryRun: bool(s.dryRun, d.dryRun),
    holdAll: bool(s.holdAll, d.holdAll),
    maxHeldAgeHours: int(s.maxHeldAgeHours, d.maxHeldAgeHours, 1, MAX_HELD_AGE_HOURS),
    bypassManual: bool(s.bypassManual, d.bypassManual),
    clients,
    priority: {
      movies: int(p.movies, d.priority.movies, -1000, 1000),
      recentTv: int(p.recentTv, d.priority.recentTv, -1000, 1000),
      backlog: int(p.backlog, d.priority.backlog, -1000, 1000),
      backlogOnlyAtNight: bool(p.backlogOnlyAtNight, d.priority.backlogOnlyAtNight),
      nightFrom: typeof p.nightFrom === "string" && TIME.test(p.nightFrom) ? p.nightFrom : d.priority.nightFrom,
      nightTo: typeof p.nightTo === "string" && TIME.test(p.nightTo) ? p.nightTo : d.priority.nightTo,
    },
    // Absent keeps the default; 0, a negative or a non-number means no limit.
    perTitleLimit: "perTitleLimit" in s ? limit(s.perTitleLimit) : d.perTitleLimit,
    preflight: {
      enabled: bool(obj(s.preflight).enabled, d.preflight.enabled),
      junkNames: bool(obj(s.preflight).junkNames, d.preflight.junkNames),
      sizeFloor: bool(obj(s.preflight).sizeFloor, d.preflight.sizeFloor),
      inspectNzb: bool(obj(s.preflight).inspectNzb, d.preflight.inspectNzb),
      strictIdentity: bool(obj(s.preflight).strictIdentity, d.preflight.strictIdentity),
    },
  };
}

export function parseSettings(stored: string | null): ThrottlearrSettings {
  if (!stored) return normalizeSettings({});
  try {
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return normalizeSettings({});
  }
}

export function getThrottlearrSettings(): ThrottlearrSettings {
  return parseSettings(getSetting(SETTINGS_KEY));
}

/** Validates, stores and returns the settings. */
export function saveThrottlearrSettings(next: unknown): ThrottlearrSettings {
  const clean = normalizeSettings(next);
  setSetting(SETTINGS_KEY, JSON.stringify(clean));
  return clean;
}

/** The limits for one client; a client with no entry is not limited. */
export function limitsFor(settings: ThrottlearrSettings, clientId: number): ClientLimits {
  return settings.clients[String(clientId)] ?? DEFAULT_CLIENT_LIMITS;
}
