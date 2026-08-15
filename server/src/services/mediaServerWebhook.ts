import { db } from "../db/client.js";
import { pathTail } from "./archival.js";

export interface WebhookWatchSignal {
  filePath: string;
}

/**
 * Plex's webhook is a multipart form with a "payload" field containing this JSON shape. Only
 * `media.scrobble` (fired once a stream crosses Plex's watched threshold, ~90%) is treated as a
 * genuine "watched" signal — `media.play`/`media.pause`/`media.resume` fire on every play/pause
 * and would massively over-report. See https://support.plex.tv/articles/115002267687-webhooks/.
 */
export function parsePlexPayload(payload: any): WebhookWatchSignal | null {
  if (payload?.event !== "media.scrobble") return null;
  const file = payload?.Metadata?.Media?.[0]?.Part?.[0]?.file;
  return typeof file === "string" && file ? { filePath: file } : null;
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
export function recordWatchEvent(signal: WebhookWatchSignal): { mediaItemId: number; episodeId: number | null; subItemId: number | null } | null {
  const tail = pathTail(signal.filePath);

  const item = db.prepare("SELECT id, path FROM media_items WHERE path IS NOT NULL").all().find((r: any) => pathTail(r.path) === tail) as
    | { id: number }
    | undefined;
  if (item) {
    db.prepare("INSERT INTO watch_events (media_item_id) VALUES (?)").run(item.id);
    return { mediaItemId: item.id, episodeId: null, subItemId: null };
  }

  const episode = db
    .prepare("SELECT id, media_item_id, file_path FROM episodes WHERE file_path IS NOT NULL")
    .all()
    .find((r: any) => pathTail(r.file_path) === tail) as { id: number; media_item_id: number } | undefined;
  if (episode) {
    db.prepare("INSERT INTO watch_events (media_item_id, episode_id) VALUES (?, ?)").run(episode.media_item_id, episode.id);
    return { mediaItemId: episode.media_item_id, episodeId: episode.id, subItemId: null };
  }

  const subItem = db
    .prepare("SELECT id, media_item_id, file_path FROM sub_items WHERE file_path IS NOT NULL")
    .all()
    .find((r: any) => pathTail(r.file_path) === tail) as { id: number; media_item_id: number } | undefined;
  if (subItem) {
    db.prepare("INSERT INTO watch_events (media_item_id, sub_item_id) VALUES (?, ?)").run(subItem.media_item_id, subItem.id);
    return { mediaItemId: subItem.media_item_id, episodeId: null, subItemId: subItem.id };
  }

  return null;
}
