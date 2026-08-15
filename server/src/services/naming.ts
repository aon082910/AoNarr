import type { MediaShape } from "./mediaTypes.js";

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
  episodic: "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00}",
  collection: "{parentTitle}/{childTitle}",
};
