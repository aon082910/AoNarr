import { SETTING_KEY_LIST } from "./settingKeyList.js";
import { hostPatternProblem, parseBypassFilter, proxyUrlProblem } from "./networkAddress.js";
import { MULTI_EPISODE_STYLES, namingTemplateProblem } from "./naming.js";
import { metadataLanguageProblem } from "./metadataLanguage.js";
import { UI_DATE_FORMATS, UI_TIME_FORMATS, UI_WEEK_STARTS, timeZoneProblem } from "./displayPreferences.js";
import { importScriptPathProblem } from "./importScript.js";

/**
 * What PUT /api/settings/:key accepts. Before this, any key and any value was stored and answered 200,
 * so a typo ("recycleBinRetentionDay") or a stale script wrote a setting nothing read.
 */

const KNOWN_KEYS: ReadonlySet<string> = new Set(SETTING_KEY_LIST);

/** Keys the server builds at run time, by pattern. */
const KEY_PATTERNS: readonly RegExp[] = [
  /^naming[A-Z][A-Za-z]*Template$/, // naming<Type>Template
  /^namingEnabled[A-Z][A-Za-z]*$/, // namingEnabled<Type>
  /^[a-z][A-Za-z]*Events$/, // <provider>Events: which notification events a provider sends
  /^notifyTemplate[A-Z][A-Za-z]*$/, // notifyTemplate<Event>
  /^strictReleaseIdentity(\.[a-z]+)?$/, // strictReleaseIdentity.<type>
  /^jobSchedule_[A-Za-z0-9_]+$/, // jobSchedule_<job>
  /^jobEnabled_[A-Za-z0-9_]+$/, // jobEnabled_<job>: "0" = switched off
  /^default[A-Z][A-Za-z]*Provider$/, // default<Type>Provider
];

export function isKnownSettingKey(key: string): boolean {
  return KNOWN_KEYS.has(key) || KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** The registered key a mistyped one is closest to, for the error message; null when nothing is close. */
export function suggestSettingKey(key: string): string | null {
  let best: string | null = null;
  let bestDistance = 4;
  const lower = key.toLowerCase();
  for (const known of KNOWN_KEYS) {
    if (Math.abs(known.length - key.length) > 3) continue;
    const distance = editDistance(lower, known.toLowerCase(), bestDistance);
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance, giving up (returning `limit`) once it cannot come in under it. */
function editDistance(a: string, b: string, limit: number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin >= limit) return limit;
    previous = row;
  }
  return previous[b.length];
}

type Rule = { oneOf: readonly string[] } | { wholeNumber: true; min: number };

/**
 * Value rules for the settings whose allowed values are fixed. Only the ones whose readers were
 * checked are listed; every other key takes any text, as before. An empty value is always accepted,
 * because that is how the Settings page resets a field to its default.
 */
const RULES: Readonly<Record<string, Rule>> = {
  authRequired: { oneOf: ["1", "0", "local"] },
  importStrategy: { oneOf: ["move", "copy", "hardlink", "symlink", "auto"] },
  redownloadFailedInteractive: { oneOf: ["1", "0"] },
  debridCleanup: { oneOf: ["1", "0"] },
  discographyGrabs: { oneOf: ["1", "0"] },
  defaultMetadataProfileId: { wholeNumber: true, min: 1 },
  sizeLimitMode: { oneOf: ["absolute", "perMinute"] },
  tlsRejectUnauthorized: { oneOf: ["1", "0", "local"] },
  proxyBypassLocal: { oneOf: ["1", "0"] },
  defaultMinimumAvailability: { oneOf: ["announced", "inCinemas", "released"] },
  housekeepingVacuum: { oneOf: ["1", "0"] },
  housekeepingHistoryDays: { wholeNumber: true, min: 0 },
  housekeepingWatchEventDays: { wholeNumber: true, min: 0 },
  housekeepingAuditDays: { wholeNumber: true, min: 0 },
  backupKeepCount: { wholeNumber: true, min: 1 },
  backupIntervalHours: { wholeNumber: true, min: 1 },
  // 0 turns the automatic purge off (Sonarr's meaning).
  recycleBinRetentionDays: { wholeNumber: true, min: 0 },
  usenetRetentionDays: { wholeNumber: true, min: 0 },
  usenetMinimumAgeMinutes: { wholeNumber: true, min: 0 },
  // The scheduler reads 0 as "the default", so 0 is not offered.
  stalledDownloadHours: { wholeNumber: true, min: 1 },
  blackholeTimeoutHours: { wholeNumber: true, min: 1 },
  maxAutoRetries: { wholeNumber: true, min: 0 },
  namingMultiEpisodeStyle: { oneOf: MULTI_EPISODE_STYLES },
  namingColonReplacement: { oneOf: ["delete", "dash", "spaceDash", "spaceDashSpace", "smart"] },
  namingReplaceIllegalChars: { oneOf: ["1", "0"] },
  scanOnAdd: { oneOf: ["1", "0"] },
  fileDate: { oneOf: ["none", "localAirDate", "utcAirDate"] },
  importExtraFiles: { oneOf: ["1", "0"] },
  importProbeChecks: { oneOf: ["1", "0"] },
  enableMediaInfo: { oneOf: ["1", "0"] },
  useScriptImport: { oneOf: ["1", "0"] },
  episodeTitleRequired: { oneOf: ["always", "bulkSeasonReleases", "never"] },
  rejectDangerousFiles: { oneOf: ["1", "0"] },
  removeFolderOnDelete: { oneOf: ["1", "0"] },
  // Metadata files (metadataFileOptions.ts); unset follows writeNfoOnImport for the shows, is off for the rest.
  nfoTvEnabled: { oneOf: ["1", "0"] },
  nfoMusicEnabled: { oneOf: ["1", "0"] },
  writeImagesOnImport: { oneOf: ["1", "0"] },
  imagesPosterFanart: { oneOf: ["1", "0"] },
  imagesSeasonPosters: { oneOf: ["1", "0"] },
  imagesEpisodeThumbs: { oneOf: ["1", "0"] },
  imagesMusicCover: { oneOf: ["1", "0"] },
  overwriteMetadataFiles: { oneOf: ["1", "0"] },
  deleteEmptyFolders: { oneOf: ["1", "0"] },
  // Display preferences (displayPreferences.ts); an empty value is the browser's own way.
  uiWeekStart: { oneOf: UI_WEEK_STARTS },
  uiDateFormat: { oneOf: UI_DATE_FORMATS },
  uiTimeFormat: { oneOf: UI_TIME_FORMATS },
  uiRelativeDates: { oneOf: ["1", "0"] },
  // Writing tags into music and audiobook files (audioTagCommon.ts, audioRetag.ts).
  writeAudioTagsMode: { oneOf: ["none", "new", "all", "sync"] },
  scrubAudioTags: { oneOf: ["1", "0"] },
  embedAudioCover: { oneOf: ["1", "0"] },
};

/** Why the value is not acceptable for the key, or null. */
export function settingValueProblem(key: string, value: string): string | null {
  if (value.trim() === "") return null;
  if (key === "metadataLanguage") return metadataLanguageProblem(value);
  if (key === "uiTimeZone") return timeZoneProblem(value);
  if (key === "socks5ProxyUrl") {
    const problem = proxyUrlProblem(value);
    return problem ? `"${key}" ${problem}` : null;
  }
  if (key === "localNetworks") {
    // Addresses and ranges only (a.b.c.d, a.b.c.d/n, IPv6 and its ranges): a host name cannot say where a request came from.
    const dropped: string[] = [];
    const entries = parseBypassFilter(value, (item) => dropped.push(item));
    const names = entries.some((entry) => entry.kind === "name");
    if (dropped.length > 0) return `"${key}" has entries that are not addresses or ranges: ${dropped.join(", ")}`;
    if (names) return `"${key}" takes IP addresses and ranges such as 192.168.1.0/24 or fd00::/8, not host names`;
    // A range this wide is almost always a typo, and it would make most of the internet "local".
    const wide = entries.some((entry) => (entry.kind === "net" ? entry.end - entry.start + 1 > 2 ** 24 : entry.kind === "net6" && entry.end - entry.start + 1n > 2n ** 121n));
    if (wide) return `"${key}" has a range that is too wide (larger than a /8 for IPv4 or a /7 for IPv6): list your own network, such as 192.168.1.0/24`;
    return null;
  }
  if (key === "allowedHosts") {
    const bad = value.split(/[,;\s]+/).filter((item) => item && !/^[A-Za-z0-9._*-]+(:\d+)?$|^\[[0-9a-fA-F:.]+\](:\d+)?$/.test(item));
    if (bad.length > 0) return `"${key}" takes host names such as aonarr.example.com (a port is allowed): ${bad.join(", ")}`;
    for (const item of value.split(/[,;\s]+/)) {
      const problem = item ? hostPatternProblem(item.replace(/:\d+$/, "")) : null;
      if (problem) return `"${key}" entry "${item}" ${problem}`;
    }
    return null;
  }
  if (key === "scriptImportPath") {
    // The script is run by the server, so it is looked for where the server runs: the container, not the host.
    const problem = importScriptPathProblem(value);
    return problem ? `"${key}": ${problem}` : null;
  }
  const template = /^naming([A-Z][A-Za-z]*)Template$/.exec(key);
  if (template) {
    const problem = namingTemplateProblem(template[1][0].toLowerCase() + template[1].slice(1), value);
    return problem ? `"${key}": ${problem}` : null;
  }
  const rule = RULES[key];
  if (!rule) return null;
  if ("oneOf" in rule) {
    return rule.oneOf.includes(value) ? null : `"${key}" must be one of: ${rule.oneOf.join(", ")}`;
  }
  // Digits only: the readers use parseInt, which reads "1e1" as 1 and "0x10" as 0, where Number() says 10 and 16.
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= rule.min ? null : `"${key}" must be a whole number of at least ${rule.min}`;
}
