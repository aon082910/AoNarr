/**
 * The wanted language of a quality profile (Radarr's "Language" on a profile). A release is rejected when
 * its name says it is in another language. A name with no language tag is taken as English, as Radarr
 * does; a "multi" release counts as having the wanted language; a subtitled-original tag (vostfr) is no
 * claim about the audio, so it is read as no tag.
 */

/** The languages a profile can ask for: the ones a release name can say (see LANGUAGE_TAGS in releaseParser). */
export const PROFILE_LANGUAGES = [
  "english",
  "french",
  "german",
  "italian",
  "spanish",
  "dutch",
  "russian",
  "korean",
  "japanese",
  "danish",
  "swedish",
  "norwegian",
  "polish",
  "portuguese",
  "hindi",
  "chinese",
] as const;

/** The tag a release name uses, as the language it means. */
function languageOfTag(tag: string): string | null {
  const t = tag.toLowerCase();
  if (t === "vff" || t === "vfq") return "french";
  // "Nordic" is usually subtitles on the original audio, and vostfr is subtitled original: neither says what the audio is.
  if (t === "vostfr" || t === "multi" || t === "nordic") return null;
  return t;
}

/** A profile's `language` as stored: a known language name, or null for "any". */
export function normalizeProfileLanguage(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "any") return null;
  const language = String(value).trim().toLowerCase();
  return (PROFILE_LANGUAGES as readonly string[]).includes(language) ? language : null;
}

/** Why a release in `detected` languages (the parser's tags) is not in the wanted language, or null when it is acceptable. */
export function languageRejection(wanted: string | null | undefined, detected: readonly string[]): string | null {
  if (!wanted) return null;
  if (detected.some((tag) => tag.toLowerCase() === "multi")) return null;
  const languages = detected.map(languageOfTag).filter((l): l is string => !!l);
  const spoken = languages.length > 0 ? languages : ["english"];
  if (spoken.includes(wanted)) return null;
  return `Its language (${spoken.join(", ")}) is not the profile's wanted language (${wanted})`;
}
