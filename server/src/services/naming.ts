import { getMediaTypeConfig, type MediaShape } from "./mediaTypes.js";

/** Renders `{token}` / `{token:00}` (zero-padded) placeholders in a naming template. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)(?::(0+))?\}/g, (_match, key: string, pad: string | undefined) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    if (pad && typeof value === "number") return String(value).padStart(pad.length, "0");
    return String(value);
  });
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
