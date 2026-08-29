import { db } from "../db/index.js";
import { fetchMovieByTmdbId, fetchSeriesByTmdbId, fetchSeriesEpisodesFor } from "./metadata.js";
import { autoSelectRootFolderId } from "./rootFolderSelect.js";
import { log } from "./logger.js";

/**
 * Overseerr/Jellyseerr send the same webhook payload shape — this app already lets a household
 * request through AoNarr's own built-in Requests page, but plenty of setups run Overseerr/
 * Jellyseerr as the family-facing request UI already (nicer browse/discover UX) and want it to
 * feed a real backend on approval, the same way it'd point at Radarr/Sonarr — except AoNarr isn't
 * API-compatible with either, so this is a webhook receiver rather than a Radarr/Sonarr-shaped
 * connection. Only acts on MEDIA_APPROVED/MEDIA_AUTO_APPROVED; every other notification type
 * (test, media available, issue reported, etc.) is acknowledged and ignored.
 */
async function existingTmdbItem(type: string, tmdbId: string): Promise<boolean> {
  const rows = (await db.prepare("SELECT external_ids FROM media_items WHERE type = ?").all(type)) as {
    external_ids: string | null;
  }[];
  for (const row of rows) {
    if (!row.external_ids) continue;
    try {
      if (JSON.parse(row.external_ids).tmdb === tmdbId) return true;
    } catch {
      // malformed external_ids on an old row — skip rather than crash the whole check
    }
  }
  return false;
}

export async function handleOverseerrWebhook(payload: any): Promise<{ added: boolean; reason?: string }> {
  const notificationType = payload?.notification_type;
  if (notificationType !== "MEDIA_APPROVED" && notificationType !== "MEDIA_AUTO_APPROVED") {
    return { added: false, reason: `Ignored notification type "${notificationType}"` };
  }

  const mediaType = payload?.media?.media_type;
  const type = mediaType === "movie" ? "movie" : mediaType === "tv" ? "series" : null;
  if (!type) return { added: false, reason: `Unrecognized media_type "${mediaType}"` };

  const tmdbId = payload?.media?.tmdbId ? String(payload.media.tmdbId) : null;
  if (!tmdbId) return { added: false, reason: "No tmdbId in webhook payload" };

  if (await existingTmdbItem(type, tmdbId)) return { added: false, reason: "Already in the library" };

  const rootFolderId = await autoSelectRootFolderId(type);
  const qualityProfileId =
    ((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined)?.id ?? null;

  const meta = type === "movie" ? await fetchMovieByTmdbId(tmdbId) : await fetchSeriesByTmdbId(tmdbId);
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, release_date, root_folder_id, quality_profile_id, monitored, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
    )
    .run(
      type,
      meta.title,
      meta.title.toLowerCase(),
      meta.year,
      meta.overview,
      meta.posterUrl,
      JSON.stringify(meta.externalIds),
      meta.releaseDate ?? null,
      rootFolderId,
      qualityProfileId
    );

  if (type === "series") {
    const episodes = await fetchSeriesEpisodesFor(meta.externalIds).catch(() => []);
    for (const ep of episodes) {
      await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .run(result.lastInsertRowid, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
    }
  }

  log.info(`[overseerrWebhook] added "${meta.title}" (${type}) from an approved Overseerr/Jellyseerr request`);
  return { added: true };
}
