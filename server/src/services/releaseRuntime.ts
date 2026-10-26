import { db } from "../db/index.js";
import type { ParsedRelease } from "./releaseParser.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { getSetting } from "./settingsStore.js";

/**
 * How long the video in a release runs, for size limits that are written per minute (Sonarr's and
 * Radarr's AcceptableSizeSpecification): a limit in MB per minute times the runtime of what the
 * release covers is the size it may have. A 1.5 GB episode and a 15 GB ten-episode pack are the same
 * size per minute, where an absolute limit accepts one and rejects the other.
 *
 * The mode is the setting `sizeLimitMode`: "absolute" (the default, and what the Quality screen's
 * numbers have always meant: megabytes) or "perMinute" (the same three numbers, read as MB per
 * minute). Switching the mode rewrites nothing; switch back and the numbers mean MB again.
 */

export const DEFAULT_MOVIE_RUNTIME_MINUTES = 110;
export const DEFAULT_EPISODE_RUNTIME_MINUTES = 45;
/** A pack of a season whose episode count is unknown. */
const DEFAULT_SEASON_EPISODES = 10;

export type SizeLimitMode = "absolute" | "perMinute";

export function sizeLimitMode(): SizeLimitMode {
  return getSetting("sizeLimitMode") === "perMinute" ? "perMinute" : "absolute";
}

export interface RuntimeContext {
  /** The item's own runtime: a film's, or one episode's (media_items.runtime_minutes). */
  runtimeMinutes: number | null;
  /** The item is a series or anime, whose releases cover one or more episodes. */
  episodic: boolean;
  /** How many episodes the item has in a season, when known. */
  seasonEpisodeCount?: (season: number | null) => number | null;
}

/** The runtime facts of one media item, for releaseRuntimeMinutes. Null when sizes are not judged per minute. */
export async function runtimeContextFor(mediaItemId: number | null, mediaType: string): Promise<RuntimeContext | null> {
  if (sizeLimitMode() !== "perMinute") return null;
  const episodic = getMediaTypeConfig(mediaType).shape === "episodic";
  if (mediaItemId == null) return { runtimeMinutes: null, episodic };
  const row = (await db.prepare("SELECT runtime_minutes FROM media_items WHERE id = ?").get(mediaItemId)) as { runtime_minutes: number | null } | undefined;
  const counts = new Map<number, number>();
  if (episodic) {
    const rows = (await db
      .prepare("SELECT season_number, COUNT(*) AS c FROM episodes WHERE media_item_id = ? GROUP BY season_number")
      .all(mediaItemId)) as { season_number: number; c: number | string }[];
    for (const r of rows) counts.set(Number(r.season_number), Number(r.c));
  }
  return {
    runtimeMinutes: row?.runtime_minutes == null ? null : Number(row.runtime_minutes),
    episodic,
    seasonEpisodeCount: (season) => (season == null ? null : counts.get(season) ?? null),
  };
}

type Coverage = Pick<ParsedRelease, "isFullSeason" | "seasonNumber" | "episodeNumbers" | "episodeRange">;

/** The minutes of video a release holds, with Sonarr's and Radarr's defaults for an unknown runtime. */
export function releaseRuntimeMinutes(parsed: Coverage, ctx: RuntimeContext): number {
  const known = ctx.runtimeMinutes != null && ctx.runtimeMinutes > 0 ? ctx.runtimeMinutes : null;
  if (!ctx.episodic) return known ?? DEFAULT_MOVIE_RUNTIME_MINUTES;
  const perEpisode = known ?? DEFAULT_EPISODE_RUNTIME_MINUTES;
  let episodes = 1;
  if (parsed.isFullSeason) {
    episodes = parsed.episodeRange
      ? parsed.episodeRange[1] - parsed.episodeRange[0] + 1
      : ctx.seasonEpisodeCount?.(parsed.seasonNumber) ?? DEFAULT_SEASON_EPISODES;
  } else if (parsed.episodeNumbers && parsed.episodeNumbers.length > 1) {
    episodes = parsed.episodeNumbers.length;
  }
  return perEpisode * Math.max(1, episodes);
}
