import { db } from "../db/index.js";
import { pathTail } from "./archival.js";
import { fetchWatchedFiles, resolvePlexFilePath } from "./mediaServer.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { log } from "./logger.js";

export interface WebhookWatchSignal {
  filePath: string;
}

/**
 * Plex's webhook is a multipart form with a "payload" field containing this JSON shape. Only
 * `media.scrobble` (fired once a stream crosses Plex's watched threshold, ~90%) is treated as a
 * genuine "watched" signal — `media.play`/`media.pause`/`media.resume` fire on every play/pause
 * and would massively over-report. See https://support.plex.tv/articles/115002267687-webhooks/.
 *
 * Plex's webhook Metadata object does NOT include a file path (no Media/Part/file — that's only
 * in the real API's response shape, never the webhook body), only a `ratingKey`. Resolving it
 * requires a follow-up call to Plex's own API using the configured server URL/token.
 */
export async function parsePlexPayload(payload: any): Promise<WebhookWatchSignal | null> {
  if (payload?.event !== "media.scrobble") return null;
  const ratingKey = payload?.Metadata?.ratingKey;
  if (!ratingKey) return null;
  const file = await resolvePlexFilePath(String(ratingKey));
  return file ? { filePath: file } : null;
}

/**
 * Jellyfin's "Webhook" plugin and Emby's "Webhooks" plugin both send configurable JSON — this
 * reads the field names their default templates use (`NotificationType`/`Path` for Jellyfin's
 * plugin, `Item.Path` as a fallback for templates that nest it). Treated as "watched" only on a
 * playback-stop notification, since a bare "PlaybackProgress" fires continuously during a stream.
 */
export function parseJellyfinEmbyPayload(body: any): WebhookWatchSignal | null {
  const notificationType = body?.NotificationType ?? body?.Event;
  if (notificationType && !/stop|finish|watched/i.test(String(notificationType))) return null;

  const file = body?.Path ?? body?.Item?.Path;
  return typeof file === "string" && file ? { filePath: file } : null;
}

/** Records a watch event and returns which library entity it matched, or null if nothing in the
 * library resolves to this file path (same tail-matching heuristic auto-archival uses, since the
 * media server and AoNarr often see the same file under different mount points). */
export async function recordWatchEvent(
  signal: WebhookWatchSignal
): Promise<{ mediaItemId: number; episodeId: number | null; subItemId: number | null } | null> {
  const tail = pathTail(signal.filePath);

  const items = (await db.prepare("SELECT id, path FROM media_items WHERE path IS NOT NULL").all()) as { id: number; path: string }[];
  const item = items.find((r) => pathTail(r.path) === tail);
  if (item) {
    await db.prepare("INSERT INTO watch_events (media_item_id) VALUES (?)").run(item.id);
    return { mediaItemId: item.id, episodeId: null, subItemId: null };
  }

  const episodes = (await db
    .prepare("SELECT id, media_item_id, file_path FROM episodes WHERE file_path IS NOT NULL")
    .all()) as { id: number; media_item_id: number; file_path: string }[];
  const episode = episodes.find((r) => pathTail(r.file_path) === tail);
  if (episode) {
    await db.prepare("INSERT INTO watch_events (media_item_id, episode_id) VALUES (?, ?)").run(episode.media_item_id, episode.id);
    return { mediaItemId: episode.media_item_id, episodeId: episode.id, subItemId: null };
  }

  const subItems = (await db
    .prepare("SELECT id, media_item_id, file_path FROM sub_items WHERE file_path IS NOT NULL")
    .all()) as { id: number; media_item_id: number; file_path: string }[];
  const subItem = subItems.find((r) => pathTail(r.file_path) === tail);
  if (subItem) {
    await db.prepare("INSERT INTO watch_events (media_item_id, sub_item_id) VALUES (?, ?)").run(subItem.media_item_id, subItem.id);
    return { mediaItemId: subItem.media_item_id, episodeId: null, subItemId: subItem.id };
  }

  return null;
}

/**
 * Scheduled watch-status polling — previously the only way watch status got refreshed on any kind
 * of recurring schedule was as a side effect of the auto-archival job (`runAutoArchival`, gated by
 * `archiveEnabled`), so an admin who wanted AoNarr to just *know* what's been watched (for the
 * dashboard, or any future feature that reads it) without also wanting files auto-deleted/moved had
 * no way to get periodic updates — only the on-demand dashboard fetch or webhook events. Gated by
 * its own `watchStatusSyncEnabled` setting, entirely independent of `archiveEnabled`.
 *
 * Unlike `recordWatchEvent` (built for one webhook event at a time, so a fresh 3-table fetch per
 * call is fine), this fetches media_items/episodes/sub_items ONCE and matches every watched file
 * from the media server against them in memory — a naive per-file `recordWatchEvent` call in a
 * loop here would mean 3 full table scans per file for a media server with hundreds of watched
 * titles. A `watchStatusSyncLastRunAt` setting acts as a cursor so already-recorded watches (whose
 * `lastPlayedAt` predates the last successful sync) aren't reinserted into `watch_events` on every
 * run — polling would otherwise "rediscover" the same watch every single cycle forever.
 */
export async function syncWatchStatusFromMediaServer(): Promise<{ recorded: number }> {
  const lastSyncRaw = getSetting("watchStatusSyncLastRunAt");
  const lastSync = lastSyncRaw ? new Date(lastSyncRaw) : new Date(0);

  const watched = await fetchWatchedFiles();
  const newlyWatched = watched.filter((f) => f.lastPlayedAt > lastSync);
  if (newlyWatched.length === 0) return { recorded: 0 };

  const [items, episodes, subItems] = await Promise.all([
    db.prepare("SELECT id, path FROM media_items WHERE path IS NOT NULL").all() as Promise<{ id: number; path: string }[]>,
    db
      .prepare("SELECT id, media_item_id, file_path FROM episodes WHERE file_path IS NOT NULL")
      .all() as Promise<{ id: number; media_item_id: number; file_path: string }[]>,
    db
      .prepare("SELECT id, media_item_id, file_path FROM sub_items WHERE file_path IS NOT NULL")
      .all() as Promise<{ id: number; media_item_id: number; file_path: string }[]>,
  ]);
  const itemsByTail = new Map(items.map((r) => [pathTail(r.path), r]));
  const episodesByTail = new Map(episodes.map((r) => [pathTail(r.file_path), r]));
  const subItemsByTail = new Map(subItems.map((r) => [pathTail(r.file_path), r]));

  let recorded = 0;
  let maxSeen = lastSync;
  for (const file of newlyWatched) {
    const tail = pathTail(file.path);
    const item = itemsByTail.get(tail);
    const episode = !item ? episodesByTail.get(tail) : undefined;
    const subItem = !item && !episode ? subItemsByTail.get(tail) : undefined;

    if (item) {
      await db.prepare("INSERT INTO watch_events (media_item_id) VALUES (?)").run(item.id);
      recorded++;
    } else if (episode) {
      await db.prepare("INSERT INTO watch_events (media_item_id, episode_id) VALUES (?, ?)").run(episode.media_item_id, episode.id);
      recorded++;
    } else if (subItem) {
      await db.prepare("INSERT INTO watch_events (media_item_id, sub_item_id) VALUES (?, ?)").run(subItem.media_item_id, subItem.id);
      recorded++;
    }
    if (file.lastPlayedAt > maxSeen) maxSeen = file.lastPlayedAt;
  }

  setSetting("watchStatusSyncLastRunAt", maxSeen.toISOString());
  if (recorded > 0) log.info(`[mediaServerWebhook] watch-status sync recorded ${recorded} new watch event(s)`);
  return { recorded };
}
