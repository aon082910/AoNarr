import { db } from "../db/index.js";
import { fetchMovieByTmdbId, fetchSeriesByTmdbId, fetchSeriesEpisodesFor, type MetadataEpisode } from "./metadata.js";
import { autoSelectRootFolderId } from "./rootFolderSelect.js";
import { findLibraryItemIdByTmdbId, libraryHasTmdbId, withLibraryAddLock } from "./importLists.js";
import { finishWantedAdd } from "./addDefaults.js";
import { insertMissingSeriesEpisodes, insertNewSeriesEpisodes } from "./seriesAdd.js";
import { log } from "./logger.js";

type WebhookResult = { added: boolean; reason?: string };

/**
 * The seasons a TV request named. Overseerr puts them in the payload's `extra` list as
 * `{ name: "Requested Seasons", value: "1, 2" }`; null when the payload names none.
 */
function requestedSeasons(payload: any): number[] | null {
  const extra: unknown[] = Array.isArray(payload?.extra) ? payload.extra : [];
  const entry = extra.find((e: any) => /requested\s+seasons?/i.test(String(e?.name ?? ""))) as { value?: unknown } | undefined;
  if (!entry) return null;
  const seasons = String(entry.value ?? "")
    .split(/[,\s]+/)
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  return seasons.length > 0 ? [...new Set(seasons)] : null;
}

/** The TVDB id Overseerr sends with a TV request; TMDB's own lookup never returns one. */
function payloadTvdbId(payload: any): string | null {
  const raw = payload?.media?.tvdbId;
  const text = raw == null ? "" : String(raw).trim();
  return /^[1-9]\d*$/.test(text) ? text : null;
}

/**
 * A request for a title the library already has. Without named seasons there is nothing to do. With
 * them, the seasons are monitored, and an episode the library does not have yet (TMDB listed the season
 * after the show was added) is added first. Returns null when the library does not have the title.
 */
async function handleExistingTitle(type: string, tmdbId: string, seasons: number[] | null): Promise<WebhookResult | null> {
  const itemId = await findLibraryItemIdByTmdbId(type, tmdbId);
  if (itemId == null) return null;
  if (type !== "series" || !seasons) return { added: false, reason: "Already in the library" };

  // The lookup is a network call, so it is made before the library-add lock is taken.
  const stored = (await db.prepare("SELECT DISTINCT season_number FROM episodes WHERE media_item_id = ?").all(itemId)) as { season_number: number }[];
  const have = new Set(stored.map((r) => Number(r.season_number)));
  const lacking = seasons.filter((s) => !have.has(s));
  let fetched: MetadataEpisode[] = [];
  if (lacking.length > 0) {
    const row = (await db.prepare("SELECT external_ids FROM media_items WHERE id = ?").get(itemId)) as { external_ids: string | null };
    let ids: Record<string, string> = {};
    try {
      ids = row?.external_ids ? JSON.parse(row.external_ids) : {};
    } catch {
      // unreadable ids: nothing to look the seasons up with
    }
    fetched = await fetchSeriesEpisodesFor(ids).catch(() => []);
  }

  // Under the lock that also covers adding a title and its episodes, so a request that arrives while
  // the first one is still adding the episodes waits for them.
  return withLibraryAddLock(async () => {
    await insertMissingSeriesEpisodes(itemId, fetched.filter((e) => lacking.includes(e.seasonNumber)));
    const placeholders = seasons.map(() => "?").join(", ");
    await db.prepare(`UPDATE episodes SET monitored = 1 WHERE media_item_id = ? AND season_number IN (${placeholders})`).run(itemId, ...seasons);
    await db.prepare("UPDATE media_items SET monitored = 1 WHERE id = ?").run(itemId);
    const counted = (await db
      .prepare(`SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number IN (${placeholders})`)
      .get(itemId, ...seasons)) as { c: number | string };
    const count = Number(counted.c);
    const list = seasons.join(", ");
    log.info(`[overseerrWebhook] monitored ${count} episode(s) of season(s) ${list} of tmdb ${tmdbId} (already in the library)`);
    return {
      added: false,
      reason:
        count > 0
          ? `Already in the library; monitored ${count} episode(s) of season(s) ${list}`
          : `Already in the library; no episodes found for season(s) ${list}`,
    };
  });
}

/**
 * Overseerr/Jellyseerr send the same webhook payload shape — this app already lets a household
 * request through AoNarr's own built-in Requests page, but plenty of setups run Overseerr/
 * Jellyseerr as the family-facing request UI already (nicer browse/discover UX) and want it to
 * feed a real backend on approval, the same way it'd point at Radarr/Sonarr — except AoNarr isn't
 * API-compatible with either, so this is a webhook receiver rather than a Radarr/Sonarr-shaped
 * connection. Only acts on MEDIA_APPROVED/MEDIA_AUTO_APPROVED; every other notification type
 * (test, media available, issue reported, etc.) is acknowledged and ignored.
 *
 * A webhook body carries no quality profile or root folder (those need a Radarr/Sonarr-shaped
 * connection), so the first profile and the auto-selected root folder apply. It does carry the
 * seasons a TV request asked for, and only those are monitored.
 */
export async function handleOverseerrWebhook(payload: any): Promise<WebhookResult> {
  const notificationType = payload?.notification_type;
  if (notificationType !== "MEDIA_APPROVED" && notificationType !== "MEDIA_AUTO_APPROVED") {
    return { added: false, reason: `Ignored notification type "${notificationType}"` };
  }

  const mediaType = payload?.media?.media_type;
  const type = mediaType === "movie" ? "movie" : mediaType === "tv" ? "series" : null;
  if (!type) return { added: false, reason: `Unrecognized media_type "${mediaType}"` };

  const tmdbId = payload?.media?.tmdbId ? String(payload.media.tmdbId) : null;
  if (!tmdbId) return { added: false, reason: "No tmdbId in webhook payload" };

  const seasons = type === "series" ? requestedSeasons(payload) : null;

  const existing = await handleExistingTitle(type, tmdbId, seasons);
  if (existing) return existing;

  // Without a root folder the importer refuses the finished download and the queue row is never
  // retried, so an approval that can't be placed anywhere is declined instead of added.
  const rootFolderId = await autoSelectRootFolderId(type);
  if (rootFolderId == null) {
    const reason = `No root folder is configured for ${type}`;
    log.warn(`[overseerrWebhook] not adding tmdb ${tmdbId}: ${reason}`);
    return { added: false, reason };
  }
  const qualityProfileId =
    ((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined)?.id ?? null;

  const meta = type === "movie" ? await fetchMovieByTmdbId(tmdbId) : await fetchSeriesByTmdbId(tmdbId);
  const tvdbId = type === "series" ? payloadTvdbId(payload) : null;
  const externalIds = tvdbId && !meta.externalIds?.tvdb ? { ...meta.externalIds, tvdb: tvdbId } : meta.externalIds;
  // Fetched before the lock is taken: the title and its episodes go in together, under it.
  const episodes = type === "series" ? await fetchSeriesEpisodesFor(externalIds).catch(() => []) : [];

  // Checked again under the library-add lock: two approvals for the same title (two users' season
  // requests, or a 4K and a standard request) arrive back to back and both pass the check above
  // while the metadata is being fetched. The title and its episodes are added inside one lock, so a
  // second request that waits for it finds the episodes and can monitor its own seasons.
  const insertedId = await withLibraryAddLock(async () => {
    if (await libraryHasTmdbId(type, tmdbId)) return null;
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
        JSON.stringify(externalIds),
        meta.releaseDate ?? null,
        rootFolderId,
        qualityProfileId
      );
    if (result.lastInsertRowid == null) return null;
    if (type === "series") await insertNewSeriesEpisodes(result.lastInsertRowid, episodes, { onlySeasons: seasons });
    return result.lastInsertRowid;
  });
  if (insertedId == null) {
    // Another approval added it while this one was fetching: still honour the seasons asked for here.
    return (await handleExistingTitle(type, tmdbId, seasons)) ?? { added: false, reason: "Already in the library" };
  }

  await finishWantedAdd(insertedId, { releaseDate: meta.releaseDate ?? null });

  log.info(`[overseerrWebhook] added "${meta.title}" (${type}) from an approved Overseerr/Jellyseerr request`);
  return { added: true };
}
