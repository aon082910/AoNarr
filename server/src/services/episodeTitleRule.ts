import { getSetting } from "./settingsStore.js";

/**
 * Sonarr's `EpisodeTitleRequired` (EpisodeTitleSpecification): when the naming format has the episode's title in it, a
 * recent episode that does not have one yet is not imported under a placeholder name ("... - S02E05 - TBA.mkv"). The
 * import waits, and goes ahead once the title is known or the episode is more than 48 hours old.
 *
 * `episodeTitleRequired`:
 * - "never" (the default here; Sonarr's own is "always"): every import goes ahead, as AoNarr always did.
 * - "always": the file waits for every recent episode it covers.
 * - "bulkSeasonReleases": only a bulk release waits, that is four or more episodes of the season dated the same day as
 *   the file's first episode (a whole season dropped at once), whose titles a provider fills in late.
 */

export type EpisodeTitleRequired = "always" | "bulkSeasonReleases" | "never";

export function episodeTitleRequiredMode(): EpisodeTitleRequired {
  const raw = getSetting("episodeTitleRequired");
  return raw === "always" || raw === "bulkSeasonReleases" ? raw : "never";
}

/** How long after an episode aired it is imported without a title (Sonarr: 48 hours). */
export const EPISODE_TITLE_GRACE_MS = 48 * 60 * 60 * 1000;

/** What an import that waits for a title says, and what the Activity page and the retry in the scheduler recognise it by. */
export const EPISODE_TITLE_HOLD_PREFIX = "Waiting for the episode title";

/** What a provider lists before an episode is named: TheTVDB's and TVmaze's "TBA", TMDB's "Episode 5". */
const PLACEHOLDER_TITLE = /^(?:Episode \d+|TBA|TBD|TBC|To Be Announced)$/i;

export function hasRealEpisodeTitle(title: string | null | undefined): boolean {
  const text = (title ?? "").trim();
  return text !== "" && !PLACEHOLDER_TITLE.test(text);
}

export interface TitleRuleEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  /** The air date as stored: "2026-11-02", or a full timestamp. */
  airDate: string | null;
}

/** The moment an air date stands for. A bare date is the end of that day (UTC): the time of day is not known, and the
 * wait should not end before the 48 hours have passed. */
function airedAtMs(airDate: string | null | undefined): number | null {
  const text = (airDate ?? "").trim();
  if (!text) return null;
  const when = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T23:59:59.999Z`) : Date.parse(text);
  return Number.isNaN(when) ? null : when;
}

function airDay(episode: TitleRuleEpisode): string | null {
  const text = (episode.airDate ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function codeOf(episode: TitleRuleEpisode): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)}`;
}

/**
 * Why the import of a file covering `episodes` must wait for a title, or null when it may go ahead. `requiresTitle`: the
 * naming format in force has the episode title in it (and naming is on); without it there is no name to spoil.
 * `seasonEpisodes`: every episode of the season, for the bulk-release test. A port of Sonarr's specification, with its
 * air date taken as the end of the stored day.
 */
export function episodeTitleHoldReason(params: {
  mode: EpisodeTitleRequired;
  requiresTitle: boolean;
  episodes: TitleRuleEpisode[];
  seasonEpisodes: TitleRuleEpisode[];
  now?: number;
}): string | null {
  const { mode, requiresTitle, seasonEpisodes } = params;
  const now = params.now ?? Date.now();
  if (mode === "never" || !requiresTitle || params.episodes.length === 0) return null;
  const episodes = [...params.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);

  if (mode === "bulkSeasonReleases") {
    const firstDay = airDay(episodes[0]);
    const allOnTheSameDay = firstDay !== null && episodes.every((e) => airDay(e) === null || airDay(e) === firstDay);
    // Four or more episodes of the season on the first one's day (or with no day at all) make it a bulk release.
    const sharingTheDay = seasonEpisodes.filter((e) => airDay(e) === null || airDay(e) === firstDay).length;
    if (allOnTheSameDay && sharingTheDay < 4) return null;
  }

  for (const episode of episodes) {
    const aired = airedAtMs(episode.airDate);
    // More than 48 hours old: a title that has not come by now is not coming soon, and the file is imported as it is.
    if (aired !== null && aired < now - EPISODE_TITLE_GRACE_MS) continue;
    if (hasRealEpisodeTitle(episode.title)) continue;
    const what = (episode.title ?? "").trim() === "" ? "has no title yet" : `is still named "${episode.title!.trim()}"`;
    const until = aired === null ? "; it has no air date, so it waits for the title" : "; it is imported when the title arrives or two days after it aired";
    return `${EPISODE_TITLE_HOLD_PREFIX}: ${codeOf(episode)} ${what} and the naming format uses it${until}`;
  }
  return null;
}
