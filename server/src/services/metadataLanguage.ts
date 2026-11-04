import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

/**
 * The language metadata providers describe a title in (Starr's PreferredMetadataLanguage). Only the descriptive
 * text and artwork follow it: a stored title, original title, sort title or alias stays what the provider calls
 * the title by default, because matching, duplicate detection and the importer compare those against release and
 * folder names (Rounds 355 and 357 were bugs where a provider's title replaced the one the item was found by).
 */

/** An ISO 639-1 language with an optional ISO 3166-1 region: de, pt-BR, zh-CN. */
const LANGUAGE_SHAPE = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i;

/** The code in its usual spelling ("de", "pt-BR"); "en" for an empty value; null when it is not a language code. */
export function normalizeMetadataLanguage(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text === "") return "en";
  const match = LANGUAGE_SHAPE.exec(text);
  if (!match) return null;
  const language = match[1].toLowerCase();
  return match[2] ? `${language}-${match[2].toUpperCase()}` : language;
}

/** Why the value is not a language code, or null. An empty value is accepted: it means English. */
export function metadataLanguageProblem(value: string): string | null {
  return normalizeMetadataLanguage(value) === null
    ? `"metadataLanguage" must be a language code such as en, de, fr, pt-BR or zh-CN`
    : null;
}

/** English is every provider's own default, so asking for it changes nothing and costs no extra request. */
export function isEnglishLanguage(code: string): boolean {
  return code === "en" || code.startsWith("en-");
}

/** The configured metadata language, "en" when unset or unusable. */
export function metadataLanguage(): string {
  return normalizeMetadataLanguage(getSetting("metadataLanguage")) ?? "en";
}

/** The language to request from TMDB (`language=`), or null when TMDB's default (English) already is the one wanted. */
export function tmdbLanguage(): string | null {
  const code = metadataLanguage();
  return isEnglishLanguage(code) ? null : code;
}

/**
 * TMDB answers `language=de` with a German `title` as well, and a title is what a library item is found, matched
 * and de-duplicated by. So every TMDB request keeps going out exactly as it does for English, and the descriptive
 * fields (overview, poster and backdrop, episode overviews) come from a second request that asks for the language;
 * a translation TMDB does not have leaves the English text in place. English is TMDB's own default, so for it there
 * is no second request at all.
 */

/** How long the language request may take. It runs beside the default-language one, so a hung one would hold up a call that had already finished. */
export const LOCALIZED_REQUEST_TIMEOUT_MS = 10_000;
/** After a 429 the request is tried once more, waiting what Retry-After says up to this long (one second when it says nothing). */
export const LOCALIZED_RETRY_MAX_WAIT_MS = 5_000;
const LOCALIZED_RETRY_DEFAULT_WAIT_MS = 1_000;

/** What fetchTmdbLocalized() answers when TMDB did not give the language's text because the request FAILED (not because it has
 * no translation, which is an ordinary answer with empty fields). It has none of TMDB's fields, so every `localized?.x` reader
 * falls back to the default language as before; a caller that stores the text asks localizationFailed(). */
export const LOCALIZATION_FAILED = Object.freeze({ localizationFailed: true as const });

export function localizationFailed(localized: unknown): boolean {
  return typeof localized === "object" && localized !== null && (localized as { localizationFailed?: unknown }).localizationFailed === true;
}

/** A Retry-After header (seconds, or an HTTP date) as a wait, never longer than the cap. */
function retryWaitMs(header: string | null | undefined): number {
  if (!header) return LOCALIZED_RETRY_DEFAULT_WAIT_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return LOCALIZED_RETRY_DEFAULT_WAIT_MS;
  return Math.min(Math.max(ms, 0), LOCALIZED_RETRY_MAX_WAIT_MS);
}

/**
 * The same TMDB request in the metadata language, or null for English. When the request fails (a timeout, a network or
 * HTTP error, a 429 that a retry did not clear) the answer is LOCALIZATION_FAILED: the default-language data stands,
 * and a refresh that would store the text knows not to write it over what the language put there earlier.
 */
export async function fetchTmdbLocalized(url: URL): Promise<any | null> {
  const language = tmdbLanguage();
  if (!language) return null;
  const localizedUrl = new URL(url.toString());
  localizedUrl.searchParams.set("language", language);
  const target = localizedUrl.toString();
  try {
    let res = await fetch(target, { signal: AbortSignal.timeout(LOCALIZED_REQUEST_TIMEOUT_MS) });
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, retryWaitMs(res.headers?.get?.("retry-after"))));
      res = await fetch(target, { signal: AbortSignal.timeout(LOCALIZED_REQUEST_TIMEOUT_MS) });
    }
    if (res.ok) return await res.json();
    // The path only: the query holds the API key.
    log.debug(`[metadata] TMDB ${language} request for ${localizedUrl.pathname} answered HTTP ${res.status}; the default-language text stands`);
  } catch (err) {
    log.debug(`[metadata] TMDB ${language} request for ${localizedUrl.pathname} failed (${(err as Error).name}); the default-language text stands`);
  }
  return LOCALIZATION_FAILED;
}

/** A TMDB list (search, trending, recommendations) as English rows, with each row's overview, poster and backdrop taken from the language's row for the same id. */
export function overlayTmdbRows(english: any[], localized: any[] | null | undefined): any[] {
  if (!localized || localized.length === 0) return english;
  const byId = new Map<number, any>(localized.map((row) => [row.id, row]));
  return english.map((row) => {
    const other = byId.get(row.id);
    if (!other) return row;
    return {
      ...row,
      overview: preferLocalized(row.overview, other.overview) ?? row.overview,
      poster_path: other.poster_path || row.poster_path,
      backdrop_path: other.backdrop_path || row.backdrop_path,
    };
  });
}

/** The two-letter language, region dropped: de-DE -> de. */
export function baseLanguage(code: string): string {
  return code.slice(0, 2).toLowerCase();
}

/** TheTVDB names its languages with three letters (ISO 639-2/T), and lists Brazilian Portuguese and Traditional Chinese as their own. */
const TVDB_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  ar: "ara", bg: "bul", ca: "cat", cs: "ces", da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", et: "est",
  fa: "fas", fi: "fin", fr: "fra", he: "heb", hi: "hin", hr: "hrv", hu: "hun", id: "ind", is: "isl", it: "ita",
  ja: "jpn", ko: "kor", lt: "lit", lv: "lav", nl: "nld", no: "nor", nb: "nor", pl: "pol", pt: "por", ro: "ron",
  ru: "rus", sk: "slk", sl: "slv", sr: "srp", sv: "swe", th: "tha", tr: "tur", uk: "ukr", vi: "vie", zh: "zho",
};

/** The TheTVDB language to request, or null for English or a language TheTVDB has no code for here. */
export function tvdbLanguage(): string | null {
  const code = metadataLanguage();
  if (isEnglishLanguage(code)) return null;
  if (code === "pt-BR") return "pt";
  if (code === "zh-TW") return "zhtw";
  return TVDB_LANGUAGE_CODES[baseLanguage(code)] ?? null;
}

/** The language to request from Trakt's translation endpoints (two letters), or null for English. */
export function traktLanguage(): string | null {
  const code = metadataLanguage();
  return isEnglishLanguage(code) ? null : baseLanguage(code);
}

/** The localized text when the provider has any, else the text already in hand: a missing translation never blanks a field. */
export function preferLocalized(english: string | null | undefined, localized: string | null | undefined): string | null {
  const wanted = typeof localized === "string" ? localized.trim() : "";
  if (wanted !== "") return localized as string;
  return english === undefined || english === "" ? null : english;
}
