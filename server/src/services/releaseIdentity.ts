import { getSetting } from "./settingsStore.js";
import { normalizeForMatch } from "./titleMatch.js";
import type { ParsedRelease } from "./releaseParser.js";

/**
 * The release identity gate (MATCHING_ACCURACY_PLAN.md, Round 1): does a release name the item it
 * was found for? Sonarr/Radarr answer this before any quality decision and reject with a named
 * reason; AoNarr's quality-tiered types (movies, series, anime, ...) had no such step — a release
 * only had to pass quality, size and, for an episode, the SxxEyy number — which is how a search for
 * one title grabbed another title's release whenever the indexer returned it.
 *
 * Pure per-item comparison: the target is already known (an automatic or manual search for THIS
 * item, an import for THIS queue row), so the release is compared against that item's titles
 * only. A library-wide lookup ("which item does this announce belong to?", with two-hits-is-
 * ambiguous) is a later round's `resolveReleaseItem`.
 */

export type IdentityMatchType = "id" | "title" | "alias" | "title-main" | "title-noyear" | "none";
export type IdentityReason = "title" | "year";
/** Per media type: `off` skips the gate, `log` computes and logs the verdict but never rejects,
 * `enforce` rejects. */
export type IdentityMode = "off" | "log" | "enforce";

export interface IdentityVerdict {
  ok: boolean;
  matchType: IdentityMatchType;
  reason: IdentityReason | null;
  /** One line for the scheduler's rejection log. */
  detail: string;
}

export interface IdentityTarget {
  type: string;
  title: string;
  year: number | null;
  /** The item's external ids as stored on media_items.external_ids: { imdb, tmdb, tvdb, ... }. */
  externalIds: Record<string, string>;
  /** Alternate titles the release may use instead (Round 3 stores them; callers may pass known
   * ones already). */
  aliases?: string[];
}

export interface IdentityRelease {
  title: string;
  /** Ids the indexer itself reported for the release (Torznab attrs), when it did. */
  imdbId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
}

/** Types whose item titles are rarely written verbatim in a release ("UFC 300" vs
 * "UFC.300.Pereira.vs.Hill.PPV", a course's full name, a site rip): the item title only has to
 * appear, as whole words, inside the release's title. Every other type needs the title itself. */
const CONTAINMENT_TYPES = new Set(["sports", "ppv", "course", "adult", "video"]);

const DEFAULT_MODE: IdentityMode = "log";
const MODES = new Set<string>(["off", "log", "enforce"]);

/** The gate's mode for a media type: settings key `strictReleaseIdentity.<type>`, else the bare
 * `strictReleaseIdentity` default for every type, else `log`. */
export function identityModeFor(type: string): IdentityMode {
  const raw = getSetting(`strictReleaseIdentity.${type}`) ?? getSetting("strictReleaseIdentity") ?? DEFAULT_MODE;
  return MODES.has(raw) ? (raw as IdentityMode) : DEFAULT_MODE;
}

// Roman numerals release names write as digits ("Rocky.2" for "Rocky II", "Episode.4" for
// "Episode IV"). "i", "v" and "x" alone are left out: they are words and initials far more often.
const ROMAN: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20",
};

/** The comparison key: normalizeForMatch (lowercase, accents folded, punctuation to spaces) over a
 * title with its apostrophes dropped and "&" read as "and", roman numerals as digits. */
export function identityKey(title: string): string {
  return normalizeForMatch(title.replace(/['’`]/g, "").replace(/&/g, " and "))
    .split(" ")
    .filter(Boolean)
    .map((t) => ROMAN[t] ?? t)
    .join(" ");
}

function sameTitle(a: string, b: string): boolean {
  const ka = identityKey(a);
  const kb = identityKey(b);
  if (!ka || !kb) return false;
  // "S.H.I.E.L.D." vs "SHIELD", "Spider-Man" vs "Spiderman": the same letters, spaced differently.
  return ka === kb || ka.replace(/ /g, "") === kb.replace(/ /g, "");
}

function containsTitle(release: string, item: string): boolean {
  const kr = identityKey(release);
  const ki = identityKey(item);
  if (!kr || !ki) return false;
  return kr === ki || ` ${kr} `.includes(` ${ki} `);
}

const TRAILING_QUALIFIER = /\s*\(([^()]*)\)\s*$/;
const YEAR_SHAPED = /^(?:19|20)\d{2}$/;

/** A metadata title's variants a release may be named by: the title itself, the title without its
 * trailing "(US)"/"(2018)" qualifier, and the qualifier written without brackets ("The Office US").
 * A year qualifier is identity for the year check, not a title word. */
function titleVariants(title: string): { exact: string[]; qualifierYear: number | null } {
  const exact = [title];
  let qualifierYear: number | null = null;
  const m = title.match(TRAILING_QUALIFIER);
  if (m) {
    const base = title.slice(0, m.index).trim();
    const qualifier = m[1].trim();
    if (base) exact.push(base);
    if (YEAR_SHAPED.test(qualifier)) qualifierYear = Number(qualifier);
    else if (base && qualifier) exact.push(`${base} ${qualifier}`);
  }
  return { exact, qualifierYear };
}

/** The leading parts of a title split at its subtitle separators ("Léon: The Professional" ->
 * "Léon"; "Star Wars: Episode IV - A New Hope" -> "Star Wars", "Star Wars Episode IV"): releases
 * routinely drop a subtitle, never the start of a title. */
function mainTitleVariants(title: string): string[] {
  const base = title.replace(TRAILING_QUALIFIER, "").trim();
  const parts = base.split(/\s*:\s*|\s+[-–—]\s+/).filter(Boolean);
  const variants: string[] = [];
  for (let k = 1; k < parts.length; k++) variants.push(parts.slice(0, k).join(" "));
  return variants;
}

function idMatch(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): string | null {
  const ids = target.externalIds ?? {};
  const imdb = (release.imdbId ?? parsed.imdbId)?.toLowerCase();
  if (imdb && ids.imdb && imdb === ids.imdb.toLowerCase()) return `imdb ${imdb}`;
  if (release.tmdbId && ids.tmdb && String(release.tmdbId) === String(ids.tmdb)) return `tmdb ${release.tmdbId}`;
  if (release.tvdbId && ids.tvdb && String(release.tvdbId) === String(ids.tvdb)) return `tvdb ${release.tvdbId}`;
  return null;
}

/**
 * Whether `release` names `target`. Order: an indexer-reported or title-embedded id equal to the
 * item's settles it (`id`); otherwise the parsed title must be the item's title, its title without
 * a "(US)"/"(2018)" qualifier, an alias, or (ranked lower) the part of the title before its
 * subtitle; then, when the release carries a title year and the item's year is known, the two must
 * be within a year of each other (a regional premiere, an indexer's mis-scraped year). A release
 * named by air date never has a title year, so daily shows skip the year check by construction.
 * For CONTAINMENT_TYPES the item title only has to appear inside the release title.
 */
export function releaseIdentifiesTarget(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): IdentityVerdict {
  const byId = idMatch(release, parsed, target);
  if (byId) return { ok: true, matchType: "id", reason: null, detail: `indexer id matches the item's (${byId})` };

  const releaseTitle = parsed.title;
  const { exact, qualifierYear } = titleVariants(target.title);
  if (!releaseTitle) {
    return { ok: false, matchType: "none", reason: "title", detail: `no title could be read from "${release.title}"` };
  }

  let matchType: IdentityMatchType = "none";
  if (CONTAINMENT_TYPES.has(target.type)) {
    if (exact.some((t) => containsTitle(releaseTitle, t))) matchType = "title";
  } else if (exact.some((t) => sameTitle(releaseTitle, t))) {
    matchType = "title";
  } else if ((target.aliases ?? []).some((a) => sameTitle(releaseTitle, a))) {
    matchType = "alias";
  } else if (mainTitleVariants(target.title).some((t) => sameTitle(releaseTitle, t))) {
    matchType = "title-main";
  }
  if (matchType === "none") {
    return { ok: false, matchType, reason: "title", detail: `title "${releaseTitle}" doesn't name "${target.title}"` };
  }

  const itemYear = target.year ?? qualifierYear;
  const releaseYear = parsed.airDate ? null : parsed.titleYear;
  if (releaseYear != null) {
    if (itemYear == null) {
      return { ok: true, matchType: matchType === "title" ? "title-noyear" : matchType, reason: null, detail: `title matches; the item has no year to check ${releaseYear} against` };
    }
    if (Math.abs(releaseYear - itemYear) > 1) {
      return { ok: false, matchType: "none", reason: "year", detail: `title matches but year ${releaseYear} isn't within a year of ${itemYear}` };
    }
  }
  return { ok: true, matchType, reason: null, detail: matchType === "title" ? "title matches" : `matched by ${matchType}` };
}
