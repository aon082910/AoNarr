import { getSetting } from "./settingsStore.js";
import { normalizeForMatch } from "./titleMatch.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
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
  /** Compare a containment type's release title by equality like every other type. Set by callers
   * that grab unsolicited releases while the type's gate is not enforcing: "UFC.300.Prelims" must
   * not resolve to "UFC 300" just because it contains the title. */
  strictTitle?: boolean;
  /** Where the work was made, as ISO 3166 codes ("US", "GB"), when the provider said (TMDB's
   * origin_country, stored by the alternate-title lookup). A scene region tag is taken as this
   * item's only when it agrees with it. */
  originCountry?: string[] | null;
  /** Another item in the library has the same title once its "(US)"/"(2018)" qualifier is dropped
   * ("The Office" the UK show and "The Office" the US show, "Charmed" 1998 and "Charmed" 2018). */
  hasSameBaseSibling?: boolean;
  /** One of those siblings is older: scene names give the bare title to the earlier work, so a
   * release that names no year belongs to that one, not to this item. */
  hasEarlierSameTitle?: boolean;
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

/** Types the bare `strictReleaseIdentity` setting never takes past `log`. Empty since the owner chose
 * `enforce` for every type (2026-10-26): the containment types' corpus and anime's numbering (Round 12
 * models AniList seasons) are no longer held back. Add a type here to cap it again; an explicit
 * `strictReleaseIdentity.<type>` setting always wins. */
const LOG_CAPPED_TYPES = new Set<string>();

/** Match types from the strongest evidence to the weakest. Library-wide resolution keeps only the
 * best rank among the items a release names (Sonarr tries the exact clean title before any looser
 * lookup and never reaches the next one once a hit is found). */
export const IDENTITY_RANK: Record<IdentityMatchType, number> = {
  id: 0,
  title: 1,
  alias: 2,
  "title-noyear": 3,
  "title-region": 4,
  "title-main": 5,
  none: 6,
};

const MODES = new Set<string>(["off", "log", "enforce"]);
/** What a type with no setting does: `enforce` (the owner's choice, 2026-10-26). The environment variable
 * AONARR_STRICT_IDENTITY_DEFAULT (off|log|enforce) changes it without a settings row, and the test config sets
 * it to `log` so suites that hand the gate arbitrary release names are not refused. */
const defaultMode = (): IdentityMode => modeOrNull(process.env.AONARR_STRICT_IDENTITY_DEFAULT ?? null) ?? "enforce";

function modeOrNull(raw: string | null): IdentityMode | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return MODES.has(value) ? (value as IdentityMode) : null;
}

/** The gate's mode for a media type: settings key `strictReleaseIdentity.<type>`, else the bare
 * `strictReleaseIdentity` default for every type, else `enforce`. An empty or unrecognised value at
 * either level counts as unset (the settings API stores "" to clear a key). */
export function identityModeFor(type: string): IdentityMode {
  const perType = modeOrNull(getSetting(`strictReleaseIdentity.${type}`));
  if (perType) return perType;
  const global = modeOrNull(getSetting("strictReleaseIdentity")) ?? defaultMode();
  return global === "enforce" && LOG_CAPPED_TYPES.has(type) ? "log" : global;
}

// Roman numerals release names write as digits ("Rocky.2" for "Rocky II", "Episode.4" for
// "Episode IV").
const ROMAN: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20",
};
// "i", "v" and "x" alone are words and initials far more often ("Malcolm X", "X-Men", "I Am
// Legend"), so they are numerals only as the last word of a title or of its part before a subtitle
// ("Rocky V", "Star Wars: Episode V - The Empire Strikes Back"), and never as a title's only word.
const SINGLE_ROMAN: Record<string, string> = { i: "1", v: "5", x: "10" };
const SUBTITLE_SEPARATOR = /\s*[:：]\s*|\s+[-–—]\s+/;

/** Letters that are not accents on another letter and so survive normalizeForMatch ("ß", "ð", "þ"). */
function foldLetters(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[ðđ]/g, "d")
    .replace(/þ/g, "th")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l");
}

/** Keys are pure functions of a title and computed for the same few thousand titles on every IRC
 * announce (each wanted item and alias against the release), so they are remembered. */
const KEY_CACHE_LIMIT = 100_000;
const keyCache = new Map<string, string>();

function remembered(cacheKey: string, compute: () => string): string {
  const hit = keyCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const value = compute();
  if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear();
  keyCache.set(cacheKey, value);
  return value;
}

/** The comparison key: normalizeForMatch (lowercase, accents folded, punctuation to spaces) over a
 * title with its apostrophes dropped, "&" read as "and" and "%" as "percent", roman numerals as
 * digits. `singleRoman: false` leaves a lone I, V or X alone (see SINGLE_ROMAN). */
export function identityKey(title: string, singleRoman = true): string {
  return remembered(`${singleRoman ? "k" : "l"}\u0000${title}`, () => {
    const prepared = foldLetters(title.normalize("NFC")).replace(/['’`]/g, "").replace(/&/g, " and ").replace(/%/g, " percent ");
    const tokens: string[] = [];
    for (const segment of prepared.split(SUBTITLE_SEPARATOR)) {
      const words = normalizeForMatch(segment).split(" ").filter(Boolean).map((t) => ROMAN[t] ?? t);
      const last = words.length - 1;
      if (singleRoman && last >= 1 && SINGLE_ROMAN[words[last]]) words[last] = SINGLE_ROMAN[words[last]];
      tokens.push(...words);
    }
    return tokens.join(" ");
  });
}

/** The same key with German umlauts written the way scene names transliterate them ("Brücke" ->
 * "bruecke", "Göhte" -> "goehte"): "Die.Bruecke" names "Die Brücke", but "u" for "ü" does not
 * name it in the other direction, so both keys are compared. */
function transliteratedKey(title: string): string {
  return remembered(`t\u0000${title}`, () => identityKey(title.normalize("NFC").replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue")));
}

function equalKeys(x: string, y: string): boolean {
  return x === y || x.replace(/ /g, "") === y.replace(/ /g, "");
}

function sameTitle(a: string, b: string): boolean {
  const ka = identityKey(a);
  const kb = identityKey(b);
  if (!ka || !kb) return false;
  // "S.H.I.E.L.D." vs "SHIELD", "Spider-Man" vs "Spiderman": the same letters, spaced differently.
  if (equalKeys(ka, kb)) return true;
  // A release has no subtitle separator, so "Star.Wars.Episode.V.The.Empire.Strikes.Back" keeps its V
  // a letter while the metadata title's "Episode V" before the dash is read as 5: compare both ways.
  if (equalKeys(identityKey(a, false), identityKey(b, false))) return true;
  return equalKeys(transliteratedKey(a), transliteratedKey(b));
}

/** Whether a release writes the item's qualifier — "The Office US", "The Office (US)" for the item
 * "The Office (US)" — rather than only the bare title two shows share. */
function namesQualifier(candidates: string[], itemTitle: string): boolean {
  const { exact, base } = titleVariants(itemTitle);
  const qualified = exact.filter((t) => t !== base);
  return qualified.length > 0 && candidates.some((c) => qualified.some((t) => sameTitle(c, t)));
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
// A dual-title release names the same work twice ("The.Fall.Guy.AKA.Kaskader.2024", "Bosch: Legacy /
// Босх: Спадок" from the Cyrillic trackers).
const DUAL_TITLE = /\s+aka\s+|\s+[/|]\s+/i;
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

function idMatch(release: IdentityRelease, parsed: ParsedRelease, target: IdentityTarget): string | null {
  const ids = target.externalIds ?? {};
  const imdb = (release.imdbId ?? parsed.imdbId)?.toLowerCase();
  if (imdb && ids.imdb && imdb === ids.imdb.toLowerCase()) return `imdb ${imdb}`;
  if (release.tmdbId && ids.tmdb && String(release.tmdbId) === String(ids.tmdb)) return `tmdb ${release.tmdbId}`;
  if (release.tvdbId && ids.tvdb && String(release.tvdbId) === String(ids.tvdb)) return `tvdb ${release.tvdbId}`;
  return null;
}

const SINGLE_SHAPE = (type: string): boolean => MEDIA_TYPES[type]?.shape === "single";

/** The ISO country a scene region tag stands for. */
const REGION_COUNTRY: Record<string, string> = { us: "US", usa: "US", uk: "GB", au: "AU", ca: "CA", nz: "NZ" };

// A season named at the end of an anime title, in the spellings AniList, fansubs and scene names use.
const SEASON_TAILS: [RegExp, (m: RegExpMatchArray) => number][] = [
  [/\s*[:\-–]?\s*(\d{1,2})(?:st|nd|rd|th)\s+season$/i, (m) => Number(m[1])],
  [/\s*[:\-–]?\s*season\s+(\d{1,2})$/i, (m) => Number(m[1])],
  [/\s+s(\d{1,2})$/i, (m) => Number(m[1])],
  [/\s+(ii|iii|iv|vi|vii|viii|ix)$/i, (m) => Number(ROMAN[m[1].toLowerCase()])],
  [/\s+([2-9])$/, (m) => Number(m[1])],
];
// "The Final Season", "Part 2", "Cour 2": a part of the show no season number places.
const NAMED_SEASON_TAIL = /\s*[:\-–]?\s*(?:(?:the\s+)?final\s+season|part\s+\d+|cour\s+\d+)$/i;

/** An anime title split into the show's name and the season it names: "Mushoku Tensei 2nd Season"
 * -> { base: "Mushoku Tensei", season: 2 }, "Frieren" -> { base: "Frieren", season: null }. `named` is
 * set when the title names a part by a name only ("The Final Season"), which no number places. */
function splitSeason(title: string): { base: string; season: number | null; named: boolean } {
  let base = title.replace(TRAILING_QUALIFIER, "").trim();
  let named = false;
  const tail = base.match(NAMED_SEASON_TAIL);
  if (tail?.index !== undefined && tail.index > 0) {
    base = base.slice(0, tail.index).trim();
    named = true;
  }
  let season: number | null = null;
  for (const [pattern, read] of SEASON_TAILS) {
    const m = base.match(pattern);
    if (m?.index !== undefined && m.index > 0) {
      season = read(m);
      base = base.slice(0, m.index).trim();
      break;
    }
  }
  return { base: base || title, season, named };
}

/** How a release title (or one of its AKA halves) names the target, best match type first. */
function matchTitle(candidates: string[], target: IdentityTarget, parsed: ParsedRelease): IdentityMatchType {
  const { exact, base, qualifier } = titleVariants(target.title);
  const aliases = target.aliases ?? [];
  const some = (fn: (c: string) => boolean) => candidates.some(fn);

  if (CONTAINMENT_TYPES.has(target.type) && !target.strictTitle) {
    return some((c) => exact.some((t) => containsTitle(c, t))) ? "title" : "none";
  }
  if (some((c) => exact.some((t) => sameTitle(c, t)))) return "title";
  if (some((c) => aliases.some((a) => sameTitle(c, a)))) return "alias";
  // A film is often released under the part of its title before the subtitle ("Leon.1994" for "Léon:
  // The Professional"). A show is not: "Dexter" is not "Dexter: New Blood" and "FBI" is not "FBI: Most
  // Wanted" — Sonarr has no such fallback either — so a show needs an alias row for a shorter name.
  if (SINGLE_SHAPE(target.type)) {
    const main = mainTitleVariants(base);
    if (some((c) => main.some((t) => sameTitle(c, t)))) return "title-main";
  }

  // "Shameless US" for a metadata title "Shameless": the scene's region tag where the provider has
  // none. Not when the metadata title names another region ("Shameless (UK)"), and not for the other
  // country's show: TMDB titles both The Offices "The Office", so a tag counts only for the item
  // that is known to come from that country, or, with nothing known, one with no same-titled sibling.
  if (
    some((c) => {
      const region = c.match(REGION_SUFFIX);
      if (!region) return false;
      if (qualifier && !sameTitle(qualifier, region[1])) return false;
      if (!sameTitle(c.replace(REGION_SUFFIX, ""), base)) return false;
      if (qualifier) return true;
      const country = REGION_COUNTRY[region[1].toLowerCase()];
      if (target.originCountry?.length) return !!country && target.originCountry.includes(country);
      return !target.hasSameBaseSibling;
    })
  ) {
    return "title-region";
  }

  // "Flash.S01E01" for "The Flash"; "The.Office" for an item stored as "Office".
  const targetNoArticle = withoutLeadingArticle(base);
  if (targetNoArticle && some((c) => sameTitle(c, targetNoArticle))) return "title-main";
  if (!LEADING_ARTICLE.test(base) && some((c) => { const r = withoutLeadingArticle(c); return !!r && sameTitle(r, base); })) return "title-main";

  // Anime: "Jujutsu Kaisen S2 - 05" vs AniList's "JUJUTSU KAISEN Season 2", "Sousou no Frieren S2" vs
  // the alias "Sousou no Frieren 2nd Season" — the same show and season, written differently. Both
  // sides are read the same way, the item's title and its aliases alike, and a season only one side
  // names is season 1: "Mushoku Tensei - 05" is not the sequel's episode 5. A part named without a
  // number ("The Final Season") matches nothing here; that is an alias row's job.
  if (target.type === "anime" && (parsed.seasonNumber != null || parsed.absoluteEpisode != null)) {
    const releases = candidates.map((c) => {
      const split = splitSeason(c);
      return { ...split, season: parsed.seasonNumber ?? split.season };
    });
    const names = [{ title: target.title, alias: false }, ...aliases.map((a) => ({ title: a, alias: true }))];
    for (const name of names) {
      const item = splitSeason(name.title);
      if (item.named || !item.base) continue;
      if (releases.some((r) => !r.named && !!r.base && sameTitle(r.base, item.base) && (r.season ?? 1) === (item.season ?? 1))) {
        return name.alias ? "alias" : "title";
      }
    }
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
  // The title as the parser isolated it, the shorter titles it can also be read as (with a trailing
  // language or edition tag taken off), and each half of a dual title.
  const whole = [releaseTitle, ...(parsed.titleAlternates ?? [])];
  const candidates = Array.from(new Set(whole.flatMap((t) => [t, ...t.split(DUAL_TITLE).map((p) => p.trim()).filter(Boolean)])));

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
  // A show shares its title with a remake or the original far more often than a year slips by one
  // (Charmed 1998 and 2018, Queer as Folk 1999 and 2000): with such a sibling in the library the
  // year has to be the item's own, as Sonarr's title-and-year lookup has it.
  const yearSlack = !SINGLE_SHAPE(target.type) && target.hasSameBaseSibling ? 0 : 1;
  if (releaseYear != null) {
    if (itemYear == null) {
      return { ok: true, matchType: matchType === "title" ? "title-noyear" : matchType, reason: null, detail: `title matches; the item has no year to check ${releaseYear} against` };
    }
    if (Math.abs(releaseYear - itemYear) > yearSlack) {
      return {
        ok: false,
        matchType: "none",
        reason: "year",
        detail:
          yearSlack === 0
            ? `title matches but year ${releaseYear} isn't ${itemYear}, and another item has the same title`
            : `title matches but year ${releaseYear} isn't within a year of ${itemYear}`,
      };
    }
  } else if (
    !SINGLE_SHAPE(target.type) &&
    target.hasEarlierSameTitle &&
    (matchType === "title" || matchType === "title-main") &&
    !namesQualifier(candidates, target.title)
  ) {
    // Scene names give the bare title to the older of two shows that share it. A release that writes
    // the item's qualifier ("The Office US" for "The Office (US)") names this one, not the bare title.
    return { ok: false, matchType: "none", reason: "year", detail: `the release names no year, and the bare title "${releaseTitle}" belongs to an earlier show with the same title` };
  }
  return { ok: true, matchType, reason: null, detail: matchType === "title" ? "title matches" : `matched by ${matchType}` };
}

// ---------------------------------------------------------------------------
// A cheap test before the gate. An IRC announce is judged against every wanted item and each of their
// forty-odd alternate titles; a release can only name an item whose names share a word with it, so
// the many that share none need no full comparison.

const STOP_TOKENS = new Set(["the", "a", "an", "and", "or", "of"]);
// A wanted library with forty alternate titles an item is over a hundred thousand names.
const TOKEN_CACHE_LIMIT = 400_000;
const tokenCache = new Map<string, string[]>();

/** The words a title is known by, folded the way the gate's keys fold them (accents, ß, ð, "&", "%",
 * umlauts both as the bare letter and as ae/oe/ue), without articles, plus the title run together
 * ("S.H.I.E.L.D." -> "shield"). Looser than the gate and much cheaper: it only has to keep every
 * title the gate would accept. */
function nameTokens(title: string): string[] {
  const hit = tokenCache.get(title);
  if (hit) return hit;
  const nfc = title.normalize("NFC");
  const readings = [nfc];
  if (/[äöüÄÖÜ]/.test(nfc)) readings.push(nfc.replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue"));
  const tokens = new Set<string>();
  for (const reading of readings) {
    const words = normalizeForMatch(foldLetters(reading).replace(/['’`]/g, "").replace(/&/g, " and ").replace(/%/g, " percent ")).split(" ");
    for (const w of words) if (w && !STOP_TOKENS.has(w)) tokens.add(w);
    const joined = words.join("");
    if (joined) tokens.add(joined);
  }
  const list = Array.from(tokens);
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
  tokenCache.set(title, list);
  return list;
}

/** Every word the parsed release's title can be read as. Empty when the release has no title. */
export function releaseNameTokens(parsed: ParsedRelease): Set<string> {
  const tokens = new Set<string>();
  const titles = [parsed.title, ...(parsed.titleAlternates ?? [])];
  for (const t of titles) for (const part of [t, ...t.split(DUAL_TITLE)]) for (const token of nameTokens(part)) tokens.add(token);
  if (parsed.titleYear != null) for (const token of nameTokens(`${parsed.title} ${parsed.titleYear}`)) tokens.add(token);
  return tokens;
}

/** Whether an item could be the one a release names: some name of it shares a word with the release.
 * An item or release with no words to compare is not ruled out. */
export function couldNameItem(releaseTokens: Set<string>, title: string, aliases: string[]): boolean {
  if (releaseTokens.size === 0) return true;
  let hadTokens = false;
  for (const name of [title, ...aliases]) {
    const tokens = nameTokens(name);
    if (tokens.length > 0) hadTokens = true;
    for (const t of tokens) if (releaseTokens.has(t)) return true;
  }
  return !hadTokens;
}
