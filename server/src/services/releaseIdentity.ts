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

export type IdentityMatchType = "id" | "title" | "alias" | "title-main" | "title-region" | "title-noyear" | "none";
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

/** Types the bare `strictReleaseIdentity` setting never takes past `log`: anime releases are named
 * by fansub synonyms the alias rows of Round 3 will carry, and the containment types' corpus is
 * still being gathered. An explicit `strictReleaseIdentity.<type>` still enforces. */
const LOG_CAPPED_TYPES = new Set(["anime", ...CONTAINMENT_TYPES]);

const DEFAULT_MODE: IdentityMode = "log";
const MODES = new Set<string>(["off", "log", "enforce"]);

function modeOrNull(raw: string | null): IdentityMode | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return MODES.has(value) ? (value as IdentityMode) : null;
}

/** The gate's mode for a media type: settings key `strictReleaseIdentity.<type>`, else the bare
 * `strictReleaseIdentity` default for every type, else `log`. An empty or unrecognised value at
 * either level counts as unset (the settings API stores "" to clear a key). */
export function identityModeFor(type: string): IdentityMode {
  const perType = modeOrNull(getSetting(`strictReleaseIdentity.${type}`));
  if (perType) return perType;
  const global = modeOrNull(getSetting("strictReleaseIdentity")) ?? DEFAULT_MODE;
  return global === "enforce" && LOG_CAPPED_TYPES.has(type) ? "log" : global;
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
// A country/region token scene names append ("Shameless.US", "The.Office.UK") where the metadata
// title carries none or writes it in brackets.
const REGION_SUFFIX = /\s+(us|uk|au|ca|nz|usa)$/i;
const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;
// A dual-title release names the same film twice ("The.Fall.Guy.AKA.Kaskader.2024").
const AKA = /\s+aka\s+/i;
// Anime season/part qualifiers: AniList titles its seasons ("JUJUTSU KAISEN Season 2"), fansubs and
// scene names write "S2"/"2nd Season"/"Part 2", and both drop it as often as not.
const SEASON_QUALIFIER = /\s+(?:(?:\d+(?:st|nd|rd|th)\s+)?season(?:\s+\d+)?|(?:the\s+)?final\s+season|part\s+\d+|cour\s+\d+|[2-9]|ii|iii|iv|vi{0,3}|ix)$/i;
// What the parser strips from the end of a cut title (releaseParser's TRAILING_ARTICLE), so a
// target compared the other way round is trimmed the same way.
const TRAILING_ARTICLE = /\s+(?:the|a|an|and|of)$/i;

/** A metadata title's variants a release may be named by: the title itself, the title without its
 * trailing "(US)"/"(2018)" qualifier, and the qualifier written without brackets ("The Office US").
 * A year qualifier is identity for the year check, not a title word. */
function titleVariants(title: string): { exact: string[]; base: string; qualifier: string | null; qualifierYear: number | null } {
  const exact = [title];
  let qualifierYear: number | null = null;
  let qualifier: string | null = null;
  let base = title;
  const m = title.match(TRAILING_QUALIFIER);
  if (m) {
    base = title.slice(0, m.index).trim() || title;
    const q = m[1].trim();
    if (base !== title) exact.push(base);
    if (YEAR_SHAPED.test(q)) qualifierYear = Number(q);
    else if (q) {
      qualifier = q;
      if (base !== title) exact.push(`${base} ${q}`);
    }
  }
  return { exact, base, qualifier, qualifierYear };
}

/** The leading parts of a title split at its subtitle separators ("Léon: The Professional" ->
 * "Léon"; "Star Wars: Episode IV - A New Hope" -> "Star Wars", "Star Wars Episode IV"): releases
 * routinely drop a subtitle, never the start of a title. */
function mainTitleVariants(base: string): string[] {
  const parts = base.split(/\s*:\s*|\s+[-–—]\s+/).filter(Boolean);
  const variants: string[] = [];
  for (let k = 1; k < parts.length; k++) variants.push(parts.slice(0, k).join(" "));
  return variants;
}

/** "The Flash" without its article, when what remains is still a title ("Flash"), not a bare
 * number ("The 100" -> "100"). */
function withoutLeadingArticle(title: string): string | null {
  if (!LEADING_ARTICLE.test(title)) return null;
  const rest = title.replace(LEADING_ARTICLE, "").trim();
  return rest.length >= 3 && /\p{L}/u.test(rest) ? rest : null;
}

function stripSeasonQualifier(title: string): string {
  return title.replace(TRAILING_QUALIFIER, "").replace(SEASON_QUALIFIER, "").trim();
}

function idMatch(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): string | null {
  const ids = target.externalIds ?? {};
  const imdb = (release.imdbId ?? parsed.imdbId)?.toLowerCase();
  if (imdb && ids.imdb && imdb === ids.imdb.toLowerCase()) return `imdb ${imdb}`;
  if (release.tmdbId && ids.tmdb && String(release.tmdbId) === String(ids.tmdb)) return `tmdb ${release.tmdbId}`;
  if (release.tvdbId && ids.tvdb && String(release.tvdbId) === String(ids.tvdb)) return `tvdb ${release.tvdbId}`;
  return null;
}

/** How a release title (or one of its AKA halves) names the target, best match type first. */
function matchTitle(candidates: string[], target: IdentityTarget, parsed: ParsedRelease): IdentityMatchType {
  const { exact, base, qualifier } = titleVariants(target.title);
  const aliases = target.aliases ?? [];
  const some = (fn: (c: string) => boolean) => candidates.some(fn);

  if (CONTAINMENT_TYPES.has(target.type)) {
    return some((c) => exact.some((t) => containsTitle(c, t))) ? "title" : "none";
  }
  if (some((c) => exact.some((t) => sameTitle(c, t)))) return "title";
  if (some((c) => aliases.some((a) => sameTitle(c, a)))) return "alias";
  const main = mainTitleVariants(base);
  if (some((c) => main.some((t) => sameTitle(c, t)))) return "title-main";

  // "Shameless US" for a metadata title "Shameless": the scene's region tag where the provider has
  // none. Not when the metadata title names another region ("Shameless (UK)").
  if (
    some((c) => {
      const region = c.match(REGION_SUFFIX);
      if (!region) return false;
      if (qualifier && !sameTitle(qualifier, region[1])) return false;
      return sameTitle(c.replace(REGION_SUFFIX, ""), base);
    })
  ) {
    return "title-region";
  }

  // "Flash.S01E01" for "The Flash"; "The.Office" for an item stored as "Office".
  const targetNoArticle = withoutLeadingArticle(base);
  if (targetNoArticle && some((c) => sameTitle(c, targetNoArticle))) return "title-main";
  if (!LEADING_ARTICLE.test(base) && some((c) => { const r = withoutLeadingArticle(c); return !!r && sameTitle(r, base); })) return "title-main";

  // Anime: "Jujutsu Kaisen S2 - 05" vs AniList's "JUJUTSU KAISEN Season 2", "Mushoku Tensei 2nd
  // Season" vs "Mushoku Tensei: Jobless Reincarnation Season 2" — same show, season named differently.
  if (target.type === "anime" && (parsed.seasonNumber != null || parsed.absoluteEpisode != null)) {
    const targetBase = stripSeasonQualifier(base);
    const targetMain = [targetBase, ...mainTitleVariants(targetBase)];
    if (targetBase && some((c) => { const r = stripSeasonQualifier(c); return !!r && targetMain.some((t) => sameTitle(r, t)); })) return "title-main";
  }
  return "none";
}

/**
 * Whether `release` names `target`. Order: an indexer-reported or title-embedded id equal to the
 * item's settles it (`id`); otherwise the parsed title must be the item's title, its title without
 * a "(US)"/"(2018)" qualifier, an alias, or (ranked lower) the part of the title before its
 * subtitle, the title with a scene region tag, or without a leading article; then, when the
 * release carries a title year and the item's year is known, the two must be within a year of
 * each other (a regional premiere, an indexer's mis-scraped year). A release named by air date
 * never has a title year, so daily shows skip the year check by construction. For
 * CONTAINMENT_TYPES the item title only has to appear inside the release title.
 */
export function releaseIdentifiesTarget(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): IdentityVerdict {
  // An id that matches settles a release whose title doesn't; a release whose title does is a title
  // match (so `id` means "by id ONLY", which the import side holds for review).
  const byId = idMatch(release, parsed, target);
  const verdict = titleVerdict(release, parsed, target);
  if (verdict.ok) return byId ? { ...verdict, detail: `${verdict.detail}; indexer id matches too (${byId})` } : verdict;
  if (byId) return { ok: true, matchType: "id", reason: null, detail: `indexer id matches the item's (${byId}) though the title doesn't: ${verdict.detail}` };
  return verdict;
}

function titleVerdict(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): IdentityVerdict {
  const releaseTitle = parsed.title;
  if (!releaseTitle) {
    return { ok: false, matchType: "none", reason: "title", detail: `no title could be read from "${release.title}"` };
  }
  const candidates = Array.from(new Set([releaseTitle, ...releaseTitle.split(AKA).map((s) => s.trim()).filter(Boolean)]));

  let matchType = matchTitle(candidates, target, parsed);
  // titleYear never comes from an air date, so a daily show's release has none and skips the year
  // check by construction; one that names the show's year too ("Show.Name.2018.2024.08.25") is checked.
  let releaseYear = parsed.titleYear;

  // A title that ends in a year-shaped number ("Blade Runner 2049", "Death Race 2000", "Class of
  // 1984") loses it to the title year when the release carries no production year. Read it back
  // as a title word, both ways round: release + year against the title, and the title less its
  // trailing number (and the article the parser would have dropped) against the release.
  if (matchType === "none" && releaseYear != null) {
    const year = String(releaseYear);
    const withYear = candidates.map((c) => `${c} ${year}`);
    const yearAsTitle =
      matchTitle(withYear, target, parsed) !== "none" ||
      [target.title, ...(target.aliases ?? [])].some((t) => {
        const key = identityKey(titleVariants(t).base);
        if (!key.endsWith(` ${year}`)) return false;
        const trimmed = key.slice(0, -year.length - 1).replace(TRAILING_ARTICLE, "").trim();
        return !!trimmed && candidates.some((c) => sameTitle(c, trimmed));
      });
    if (yearAsTitle) {
      matchType = "title";
      releaseYear = null;
    }
  }
  if (matchType === "none") {
    return { ok: false, matchType, reason: "title", detail: `title "${releaseTitle}" doesn't name "${target.title}"` };
  }

  const itemYear = target.year ?? titleVariants(target.title).qualifierYear;
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
