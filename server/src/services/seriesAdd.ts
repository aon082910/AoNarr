import { db } from "../db/index.js";
import { log } from "./logger.js";
import { isEpisodeMonitoredByDefault, type MetadataEpisode } from "./metadata.js";
import { syncSceneNumbering } from "./sceneNumbering.js";

/**
 * Adds episodes a series does not have yet, monitored (a request asked for their season). One the
 * series already has is left as it is, so this is safe beside a refresh or a second request.
 */
export async function insertMissingSeriesEpisodes(mediaItemId: number | bigint, episodes: MetadataEpisode[]): Promise<number> {
  if (episodes.length === 0) return 0;
  const have = (await db.prepare("SELECT season_number, episode_number FROM episodes WHERE media_item_id = ?").all(mediaItemId)) as {
    season_number: number;
    episode_number: number;
  }[];
  const known = new Set(have.map((e) => `${e.season_number}:${e.episode_number}`));
  const fresh = episodes.filter((e) => !known.has(`${e.seasonNumber}:${e.episodeNumber}`));
  await db.transaction(async () => {
    for (const ep of fresh) {
      await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored, thumb_url)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview, ep.thumbUrl ?? null);
    }
  });
  return fresh.length;
}

/**
 * Stores the episodes of a series that was just added, the way the Add Media screen does: each
 * episode gets its absolute number (a running count over the seasons after 0, which is what a
 * fansub release called "Show - 145" is matched on), and a series with a TVDB id asks TheXEM for its
 * scene numbering afterwards.
 *
 * `onlySeasons` is for a request that named seasons (Overseerr's "Requested Seasons"): every episode
 * is still stored, but only the named seasons are monitored.
 */
export async function insertNewSeriesEpisodes(
  mediaItemId: number | bigint,
  episodes: MetadataEpisode[],
  options: { onlySeasons?: number[] | null } = {}
): Promise<number> {
  const only = options.onlySeasons && options.onlySeasons.length > 0 ? new Set(options.onlySeasons) : null;

  const absoluteByKey = new Map<string, number>();
  [...episodes]
    .filter((e) => e.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
    .forEach((e, index) => absoluteByKey.set(`${e.seasonNumber}:${e.episodeNumber}`, index + 1));

  await db.transaction(async () => {
    for (const ep of episodes) {
      const monitored = only ? only.has(ep.seasonNumber) : isEpisodeMonitoredByDefault(ep);
      await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored, absolute_episode_number, thumb_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          mediaItemId,
          ep.seasonNumber,
          ep.episodeNumber,
          ep.title,
          ep.airDate,
          ep.overview,
          monitored ? 1 : 0,
          absoluteByKey.get(`${ep.seasonNumber}:${ep.episodeNumber}`) ?? null,
          ep.thumbUrl ?? null
        );
    }
  });

  // Best effort, and not waited for: a slow or unreachable thexem.info must not hold up the add.
  syncSceneNumbering(Number(mediaItemId)).catch((err) =>
    log.warn(`[seriesAdd] scene numbering sync failed for item ${mediaItemId}:`, (err as Error).message)
  );
  return episodes.length;
}
