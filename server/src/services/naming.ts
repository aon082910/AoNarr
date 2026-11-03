import { getMediaTypeConfig, isValidMediaType, type MediaShape } from "./mediaTypes.js";
import { parseReleaseTitle } from "./releaseParser.js";
import { getSetting } from "./settingsStore.js";

/** A token name compared without case, spaces, dots, dashes and underscores: `{Series Title}`, `{series_title}` and `{seriesTitle}` are one. */
function tokenKey(name: string): string {
  return name.toLowerCase().replace(/[\s._-]+/g, "");
}

/**
 * Sonarr's, Radarr's, Lidarr's and Readarr's token names, read as the AoNarr token they stand for, so a template
 * pasted from one of them works beside AoNarr's own. Keys are tokenKey()s.
 */
const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  seriestitle: "parentTitle",
  seriestitleyear: "parentTitleYear",
  seriescleantitle: "parentCleanTitle",
  seriescleantitleyear: "parentCleanTitleYear",
  seriestitlethe: "parentTitleThe",
  movietitle: "title",
  movietitleyear: "titleYear",
  moviecleantitle: "cleanTitle",
  moviecleantitleyear: "cleanTitleYear",
  movietitlethe: "titleThe",
  releaseyear: "year",
  absolute: "absoluteEpisode",
  qualitytitle: "quality",
  mediainfovideocodec: "videoCodec",
  mediainfovideo: "videoCodec",
  editiontags: "edition",
  artistname: "parentTitle",
  artistcleanname: "parentCleanTitle",
  albumtitle: "childTitle",
  albumcleantitle: "childCleanTitle",
  authorname: "parentTitle",
  authorcleanname: "parentCleanTitle",
  booktitle: "childTitle",
  bookcleantitle: "childCleanTitle",
  track: "trackNumber",
};

/** Renders `{token}` / `{token:00}` (zero-padded) placeholders in a naming template. A token is matched
 * without regard to case, spaces and dashes, and Starr's names are accepted as aliases (TOKEN_ALIASES). */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  let byKey: Map<string, string | number> | null = null;
  return template.replace(/\{([A-Za-z][\w .-]*?)(?::(0+))?\}/g, (_match, name: string, pad: string | undefined) => {
    let value: string | number | undefined = vars[name];
    if (value === undefined || value === null) {
      byKey ??= new Map(Object.entries(vars).map(([k, v]) => [tokenKey(k), v]));
      const key = tokenKey(name);
      value = byKey.get(key) ?? byKey.get(tokenKey(TOKEN_ALIASES[key] ?? ""));
    }
    if (value === undefined || value === null) return "";
    if (pad && typeof value === "number") return String(value).padStart(pad.length, "0");
    return String(value);
  });
}

export type MultiEpisodeStyle = "range" | "prefixedRange" | "extend" | "repeat";

export const MULTI_EPISODE_STYLES: readonly MultiEpisodeStyle[] = ["range", "prefixedRange", "extend", "repeat"];

/** The `multiEpisodeStyle` setting; "range" (01-02), which AoNarr always used, when it is unset or unknown. */
export function multiEpisodeStyleOf(value: string | null | undefined): MultiEpisodeStyle {
  return (MULTI_EPISODE_STYLES as readonly string[]).includes(value ?? "") ? (value as MultiEpisodeStyle) : "range";
}

/**
 * What `{episode}` renders for the episodes one file covers. One episode stays a number (so `{episode:00}` pads it).
 * Several are written in Sonarr's multi-episode styles: range "01-03", prefixedRange "01-E03", extend "01-02-03",
 * repeat "01E02E03". Episodes that do not follow each other are written as separate runs ("01-02E05"), not as one range
 * across the gap.
 */
export function episodeLabel(numbers: number[], style: MultiEpisodeStyle = "range"): string | number {
  const sorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pad = (n: number) => String(n).padStart(2, "0");
  const runs: number[][] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[last.length - 1] + 1) last.push(n);
    else runs.push([n]);
  }
  // Episodes that do not follow each other are all written out: "01E02E05" is read back as three episodes, "01-02E05" as one.
  if (runs.length > 1) return sorted.map(pad).join("E");
  return runs
    .map((run) => {
      if (run.length === 1) return pad(run[0]);
      const first = run[0];
      const end = run[run.length - 1];
      if (style === "prefixedRange") return `${pad(first)}-E${pad(end)}`;
      if (style === "extend") return run.map(pad).join("-");
      if (style === "repeat") return run.map(pad).join("E");
      return `${pad(first)}-${pad(end)}`;
    })
    .join("E");
}

const SMALL_WORDS_THE = /^(?:the|a|an)\s+/i;

/** `Wire, The` for "The Wire": Starr's {Series TitleThe}. */
function titleThe(title: string): string {
  const m = SMALL_WORDS_THE.exec(title);
  return m ? `${title.slice(m[0].length)}, ${m[0].trim()}` : title;
}

/** The title without punctuation that a file system or a media server trips over ({Series CleanTitle}). */
function cleanTitle(title: string): string {
  return title.replace(/[:;,!?'"`]/g, "").replace(/\s+/g, " ").trim();
}

/** The title with " (year)" added, unless the title already ends in its year. */
function withYear(title: string, year: number | string | null | undefined): string {
  if (!year) return title;
  return new RegExp(`\\(?${year}\\)?\\s*$`).test(title) ? title : `${title} (${year})`;
}

/** Tokens that come from a title: with its year, cleaned, and with the article last. */
export function titleVars(prefix: "" | "parent", title: string, year: number | string | null | undefined): Record<string, string> {
  const key = (name: string) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  return {
    [key("titleYear")]: withYear(title, year),
    [key("cleanTitle")]: cleanTitle(title),
    [key("cleanTitleYear")]: withYear(cleanTitle(title), year),
    [key("titleThe")]: titleThe(title),
  };
}

const VIDEO_CODEC = /\b(av1|x\.?265|h\.?265|hevc|x\.?264|h\.?264|avc|xvid|divx|vp9|mpeg-?2)\b/i;

/**
 * Tokens that come from the release a file was downloaded as: its group, the full quality (with PROPER or REPACK),
 * the resolution, the video codec and the edition. All read from the release title, since the file is named before it
 * is probed. They are empty for a file with no release (a manual import, a file found by the scan), and an empty token
 * is cleaned out of the name.
 */
export function releaseVars(releaseTitle: string | null | undefined, quality: string | null | undefined): Record<string, string> {
  const parsed = releaseTitle ? parseReleaseTitle(releaseTitle) : null;
  const revision = parsed?.revision;
  const suffix = revision?.isRepack ? " Repack" : revision && (revision.version > 1 || revision.real > 0) ? " Proper" : "";
  const codec = releaseTitle ? VIDEO_CODEC.exec(releaseTitle)?.[1] : null;
  return {
    releaseGroup: parsed?.releaseGroup ?? "",
    qualityFull: quality ? `${quality}${suffix}` : "",
    resolution: parsed?.resolution ?? "",
    videoCodec: codec ? codec.toUpperCase().replace(/\./g, "").replace(/^X(26[45])$/, "x$1").replace(/^H(26[45])$/, "H$1") : "",
    edition: parsed?.edition ?? "",
  };
}

/** Tokens that hold a value of one episode or one child (an album, a book): a folder with one is not the title's own. */
const LEAF_TOKENS: ReadonlySet<string> = new Set(
  ["season", "episode", "absoluteEpisode", "airDate", "episodeTitle", "seasonFolder", "childTitle", "childCleanTitle", "trackNumber", "trackTitle"].map(tokenKey)
);

function templateParts(template: string): string[] {
  return template.split("/").filter((part) => part.trim() !== "");
}

/** The folders of a template: all its parts, or all but the last (the file name) when `fileNameLast`. */
export function templateFolderLevels(template: string, fileNameLast = true): number {
  const parts = templateParts(template);
  return fileNameLast ? Math.max(0, parts.length - 1) : parts.length;
}

/**
 * How many leading folders of a template belong to the title itself, before the first folder that holds a value of one
 * episode or one child ("Season {season:00}", "{childTitle}"). 0 when there is none: a flat template, or one whose
 * first folder already varies by episode, has no stable folder of the title's own.
 */
export function ownFolderDepth(template: string, fileNameLast = true): number {
  const parts = templateParts(template);
  const folders = fileNameLast ? parts.slice(0, -1) : parts;
  let depth = 0;
  for (const part of folders) {
    const leaf = tokensIn(part).some((t) => LEAF_TOKENS.has(TOKEN_ALIASES[t.key] ? tokenKey(TOKEN_ALIASES[t.key]) : t.key));
    if (leaf) break;
    depth++;
  }
  return depth;
}

/** Every token a template of any shape may use, as tokenKeys, for the check on save. */
const KNOWN_TOKENS: ReadonlySet<string> = new Set(
  [
    "title", "year", "quality", "parentTitle", "childTitle", "season", "episode", "absoluteEpisode", "airDate", "episodeTitle", "trackNumber", "trackTitle",
    "titleYear", "cleanTitle", "cleanTitleYear", "titleThe", "parentTitleYear", "parentCleanTitle", "parentCleanTitleYear", "parentTitleThe", "childCleanTitle",
    "releaseGroup", "qualityFull", "resolution", "videoCodec", "edition", "seasonFolder", "providerId", "providerKey",
  ].map(tokenKey)
);

/** A token that stands for a provider id: {tmdbId}, {musicbrainzId}, ... */
function isProviderIdToken(name: string): boolean {
  return /^[a-z]+Id$/i.test(name.replace(/[\s._-]+/g, ""));
}

function tokensIn(template: string): { name: string; key: string }[] {
  return Array.from(template.matchAll(/\{([A-Za-z][\w .-]*?)(?::(0+))?\}/g), (m) => ({ name: m[1], key: tokenKey(m[1]) }));
}

/**
 * Why a naming template cannot be saved, or null. Checked on save because a bad template only failed later: a
 * template with no episode token gives every episode the same name, and the second import of a season was refused.
 */
export function namingTemplateProblem(mediaType: string, template: string): string | null {
  if (template.trim() === "") return null;
  if (!isValidMediaType(mediaType)) return null;
  if (template.trim().startsWith("/") || template.split("/").some((part) => part.trim() === "..")) {
    return "The template must be a path below the root folder: no leading slash and no ..";
  }
  if (/\\/.test(template)) return "Use / between folders, not \\";
  // A brace group that is not a plain token ("{[Quality Full]}", "{-Release Group}", Starr's optional segments) would be
  // written out literally.
  for (const group of template.match(/\{[^}]*\}/g) ?? []) {
    if (!/^\{[A-Za-z][\w .-]*?(?::0+)?\}$/.test(group)) return `${group} is not a token AoNarr supports; use plain tokens such as {Quality Full}`;
  }
  const bare = template.replace(/\{[^}]*\}/g, "");
  if (/[:*?"<>|]/.test(bare)) return "The template has a character a file name can't hold (: * ? \" < > |); the title's own colons are handled by the colon setting";
  const tokens = tokensIn(template);
  for (const t of tokens) {
    if (KNOWN_TOKENS.has(t.key) || t.key in TOKEN_ALIASES || isProviderIdToken(t.name)) continue;
    return `Unknown token {${t.name}}`;
  }
  const parts = template.split("/").filter((p) => p.trim() !== "");
  const lastTokens = new Set(tokensIn(parts[parts.length - 1] ?? "").map((t) => TOKEN_ALIASES[t.key] ? tokenKey(TOKEN_ALIASES[t.key]) : t.key));
  const shape = getMediaTypeConfig(mediaType).shape;
  if (shape === "episodic" && !["episode", "absoluteepisode", "airdate", "episodetitle"].some((k) => lastTokens.has(k))) {
    return "The file name needs {episode}, {absoluteEpisode} or {airDate}; without one every episode gets the same name";
  }
  if (shape === "single" && !["title", "titleyear", "cleantitle", "cleantitleyear", "thetitle", "titlethe"].some((k) => lastTokens.has(k))) {
    return "The file name needs {title}";
  }
  if (shape === "collection" && !lastTokens.has("childtitle") && !lastTokens.has("childcleantitle")) {
    return "The last part of the template needs {childTitle}";
  }
  return null;
}

/**
 * One default template per shape, generic enough to cover every library type built on that
 * shape. Per-type overrides (e.g. a different template just for Comics) are stored in settings
 * as `naming<Type>Template` and take precedence — see importer.ts's `getNamingTemplate()`.
 *
 * - single: one file per item (Movies, ROMs, Adult).
 * - episodic: season/episode children (TV Shows, Anime). Folder-only for the season component;
 *   the episode line renders the filename too.
 * - collection: {parentTitle}/{childTitle} — folder-only for Music (tracks keep their original
 *   filenames inside it, like Lidarr); filename-including for everything else (Books, Comics,
 *   Online Videos, Courses), where a child is a single file.
 */
export const DEFAULT_SHAPE_TEMPLATES: Record<MediaShape, string> = {
  single: "{title} ({year})/{title} ({year})",
  episodic: "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00} - {episodeTitle}",
  collection: "{parentTitle}/{childTitle}",
};

/** Music's per-track filename template (settings key `namingArtistTrackTemplate`) — a track
 * whose position within the album is known (matched to a `tracks` row) gets this rendered as its
 * filename instead of being kept as-downloaded; tokens: {trackNumber}, {trackTitle},
 * {parentTitle} (artist), {childTitle} (album). Same enable/disable toggle as the album-folder
 * template (`namingEnabledArtist`) — there's no separate on/off switch for this. */
export const DEFAULT_TRACK_TEMPLATE = "{trackNumber:00} - {trackTitle}";

/**
 * Naming-template vars for whichever metadata provider(s) an item is matched to — lets a template
 * embed the matched id, e.g. `{title} ({year}) [tmdb-{tmdbId}]` or `{title} ({year}) [{providerKey}-{providerId}]`.
 * Two flavors, both derived from the same `externalIds` blob, so nothing new has to be fetched or
 * stored — every naming call site already has the item's `externalIds` on hand:
 * - One `{<provider>Id}` token per id actually present (`{tmdbId}`, `{tvdbId}`, `{imdbId}`,
 *   `{musicbrainzId}`, ...) — for a template that wants a *specific* provider regardless of which
 *   one this particular item happened to match through.
 * - A generic `{providerId}`/`{providerKey}` pair for the item's PRIMARY provider — its type's
 *   `defaultProvider` if that id is populated, else the first populated id in the type's declared
 *   `metadataProviders` order, else whatever's there — for a template that just wants "however
 *   this one got matched" without hardcoding a provider name that won't apply to every item of
 *   that type (e.g. Anime matches primarily via AniList but sometimes only has a TVDB id).
 */
export function providerIdVars(item: { type: string; externalIds: string | null }): Record<string, string> {
  let ids: Record<string, string> = {};
  if (item.externalIds) {
    try {
      ids = JSON.parse(item.externalIds);
    } catch {
      ids = {};
    }
  }
  const vars: Record<string, string> = {};
  for (const [provider, id] of Object.entries(ids)) {
    if (id) vars[`${provider}Id`] = id;
  }
  const config = getMediaTypeConfig(item.type);
  const preferenceOrder = [config.defaultProvider, ...config.metadataProviders].filter((p): p is string => !!p);
  const primary = preferenceOrder.find((p) => ids[p]) ?? Object.keys(ids).find((p) => ids[p]);
  if (primary) {
    vars.providerId = ids[primary];
    vars.providerKey = primary;
  }
  return vars;
}

/** The naming template in force for a media type: its own setting, else the default of its shape. */
export function namingTemplateOfType(type: string): string {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  return getSetting(`naming${capitalized}Template`) || DEFAULT_SHAPE_TEMPLATES[getMediaTypeConfig(type).shape];
}
