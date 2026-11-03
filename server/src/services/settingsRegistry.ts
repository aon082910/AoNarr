import { SETTING_KEY_LIST } from "./settingKeyList.js";
import { proxyUrlProblem } from "./networkAddress.js";
import { MULTI_EPISODE_STYLES, namingTemplateProblem } from "./naming.js";

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
  maxAutoRetries: { wholeNumber: true, min: 0 },
  namingMultiEpisodeStyle: { oneOf: MULTI_EPISODE_STYLES },
  namingColonReplacement: { oneOf: ["delete", "dash", "spaceDash", "spaceDashSpace", "smart"] },
  namingReplaceIllegalChars: { oneOf: ["1", "0"] },
  scanOnAdd: { oneOf: ["1", "0"] },
  fileDate: { oneOf: ["none", "localAirDate", "utcAirDate"] },
  importExtraFiles: { oneOf: ["1", "0"] },
  importProbeChecks: { oneOf: ["1", "0"] },
  rejectDangerousFiles: { oneOf: ["1", "0"] },
  removeFolderOnDelete: { oneOf: ["1", "0"] },
  deleteEmptyFolders: { oneOf: ["1", "0"] },
};

/** Why the value is not acceptable for the key, or null. */
export function settingValueProblem(key: string, value: string): string | null {
  if (value.trim() === "") return null;
  if (key === "socks5ProxyUrl") {
    const problem = proxyUrlProblem(value);
    return problem ? `"${key}" ${problem}` : null;
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
