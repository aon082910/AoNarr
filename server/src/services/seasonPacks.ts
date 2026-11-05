import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";
import { groupedRank, rankingOf, type ProfileRanking } from "./quality.js";
import { airedFrontierOf, episodeNotAired } from "./searchPlan.js";
import type { ParsedRelease } from "./releaseParser.js";
import type { MediaItem } from "../types/index.js";
import { cutoffNotMet, judgeUpgrade, type PropersMode, type UpgradeProfile } from "./upgradeRules.js";

/**
 * Whether a season pack is a good grab for what is wanted of its season. AoNarr grabs a pack found
 * by an episode search so that one download covers the season, but Sonarr's guards apply to it:
 * every episode the pack covers has aired (FullSeasonSpecification), every one is monitored
 * (MonitoredEpisodeSpecification), and the pack fills or upgrades enough of them
 * (UpgradeDiskSpecification with its season pack threshold). Without them a 20 GB pack is grabbed to
 * fill one missing episode of ten, or a still-airing season's "S03" pack to fill what has aired, or
 * a pack that carries the episodes the admin unmonitored.
 *
 * Two settings (no UI, like the reject settings): `seasonPackGuards` ("0" turns all of this off)
 * and `seasonPackShare`, the least percentage of the covered episodes the pack must fill or
 * upgrade (default 50, "0" for none).
 */

/** An episode of the item, as the pack verdict needs it. */
export interface PackEpisode {
  seasonNumber: number;
  episodeNumber: number;
  sceneSeason: number | null;
  sceneEpisode: number | null;
  monitored: boolean;
  hasFile: boolean;
  quality: string | null;
  airDate: string | null;
  /** The release the episode's file came from and the custom-format score it had when imported (null: unknown). */
  releaseTitle?: string | null;
  formatScore?: number | null;
}

export type PackVerdict = { ok: true; covered: number; wanted: number } | { ok: false; reason: string };

export const DEFAULT_PACK_SHARE_PERCENT = 50;

export interface PackSettings {
  guards: boolean;
  sharePercent: number;
}

export function packSettings(): PackSettings {
  const raw = getSetting("seasonPackShare");
  const share = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return { guards: getSetting("seasonPackGuards") !== "0", sharePercent: share >= 0 && share <= 100 ? share : DEFAULT_PACK_SHARE_PERCENT };
}

/** The item's episodes, for a pack verdict. */
export async function loadPackEpisodes(mediaItemId: number): Promise<PackEpisode[]> {
  const rows = (await db
    .prepare(
      "SELECT season_number, episode_number, scene_season_number, scene_episode_number, monitored, has_file, quality, air_date, file_release_title, file_format_score FROM episodes WHERE media_item_id = ?"
    )
    .all(mediaItemId)) as {
    season_number: number;
    episode_number: number;
    scene_season_number: number | null;
    scene_episode_number: number | null;
    monitored: number | boolean;
    has_file: number | boolean;
    quality: string | null;
    air_date: string | null;
    file_release_title: string | null;
    file_format_score: number | string | null;
  }[];
  return rows.map((r) => ({
    seasonNumber: Number(r.season_number),
    episodeNumber: Number(r.episode_number),
    sceneSeason: r.scene_season_number == null ? null : Number(r.scene_season_number),
    sceneEpisode: r.scene_episode_number == null ? null : Number(r.scene_episode_number),
    monitored: !!Number(r.monitored),
    hasFile: !!Number(r.has_file),
    quality: r.quality,
    airDate: r.air_date,
    releaseTitle: r.file_release_title ?? null,
    formatScore: r.file_format_score == null ? null : Number(r.file_format_score),
  }));
}

/** The episodes of `season` (the numbering a release uses: the scene's where the show has one) a
 * pack of `parsed` covers: the whole season, or the range of a batch ("S02 13-24"). */
export function episodesCoveredBy(parsed: Pick<ParsedRelease, "episodeRange">, season: number, episodes: PackEpisode[]): PackEpisode[] {
  const inSeason = episodes.filter((e) => (e.sceneSeason ?? e.seasonNumber) === season);
  const range = parsed.episodeRange;
  return range ? inSeason.filter((e) => (e.sceneEpisode ?? e.episodeNumber) >= range[0] && (e.sceneEpisode ?? e.episodeNumber) <= range[1]) : inSeason;
}

/** Whether a file of `quality` is one a pack of `packQuality` would be an upgrade for: below the
 * profile's cutoff (any quality is, with no cutoff set) and below the pack. */
function upgradableBy(quality: string | null, packQuality: string, cutoff: string, ranking?: ProfileRanking | null): boolean {
  const rank = groupedRank(quality, ranking);
  const cutoffRank = groupedRank(cutoff, ranking);
  return rank >= 0 && (cutoffRank < 0 || rank < cutoffRank) && rank < groupedRank(packQuality, ranking);
}

export function judgeSeasonPack(args: {
  parsed: Pick<ParsedRelease, "episodeRange">;
  /** The season the pack is for in a release's numbering. */
  season: number;
  episodes: PackEpisode[];
  item: Pick<MediaItem, "type" | "seriesType">;
  packQuality: string;
  cutoff: string;
  /** How the profile ranks the ladder (its groups and its order). */
  ranking?: ProfileRanking | null;
  settings?: PackSettings;
  today?: string;
  /**
   * With it, an episode that has a file counts as upgraded by the pack when the profile's upgrade rules say so:
   * a better quality below the cutoff, a later revision of its own release (PROPER, REPACK, v2) or a
   * custom-format score gain (Sonarr's UpgradeDiskSpecification for a full-season release). Without it only a better
   * quality below the cutoff counts.
   */
  upgrade?: { profile: UpgradeProfile; mode: PropersMode; packTitle: string; packScore?: number };
  /**
   * For the check made before any pack is known (is a search for one worth the requests): an episode with a file
   * counts as upgradable when some pack could replace it, that is when the profile's cutoff is not met for it.
   */
  couldUpgrade?: UpgradeProfile;
}): PackVerdict {
  const settings = args.settings ?? packSettings();
  const covered = episodesCoveredBy(args.parsed, args.season, args.episodes);
  if (covered.length === 0) return { ok: false, reason: `it covers no episode of season ${args.season} that is known` };
  const upgrade = args.upgrade;
  const upgradedByPack = (e: PackEpisode): boolean => {
    const file = { quality: e.quality, releaseTitle: e.releaseTitle ?? null, formatScore: e.formatScore ?? null };
    if (args.couldUpgrade) return cutoffNotMet(args.couldUpgrade, file);
    // A file of unknown quality is not one a pack is known to improve (a single release over it is judged alone).
    if (upgrade && groupedRank(e.quality, rankingOf(upgrade.profile)) >= 0) {
      return judgeUpgrade(upgrade.profile, upgrade.mode, file, { quality: args.packQuality, title: upgrade.packTitle, score: upgrade.packScore }) === "yes";
    }
    return upgradableBy(e.quality, args.packQuality, args.cutoff, args.ranking);
  };
  const wanted = covered.filter((e) => !e.hasFile || upgradedByPack(e)).length;
  // Whatever the guards say, a pack that fills or upgrades nothing is a download for nothing.
  if (wanted === 0) return { ok: false, reason: `it would fill or upgrade none of the ${covered.length} episodes it covers` };
  if (!settings.guards) return { ok: true, covered: covered.length, wanted };

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const frontier = airedFrontierOf(
    args.episodes.map((e) => ({ season_number: e.seasonNumber, episode_number: e.episodeNumber, air_date: e.airDate })),
    today
  );
  const unaired = covered.filter((e) =>
    episodeNotAired(args.item, { air_date: e.airDate, season_number: e.seasonNumber, episode_number: e.episodeNumber }, today, frontier)
  );
  if (unaired.length > 0) return { ok: false, reason: `${unaired.length} of the ${covered.length} episodes it covers have not aired` };
  const unmonitored = covered.filter((e) => !e.monitored);
  if (unmonitored.length > 0) return { ok: false, reason: `it covers ${unmonitored.length} episode(s) that are not monitored` };
  if (covered.length > 0 && (wanted * 100) / covered.length < settings.sharePercent) {
    return { ok: false, reason: `it would fill or upgrade only ${wanted} of the ${covered.length} episodes it covers (less than ${settings.sharePercent}%)` };
  }
  return { ok: true, covered: covered.length, wanted };
}
