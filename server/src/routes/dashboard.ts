import { Router } from "express";
import { db } from "../db/client.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { fetchWatchedFiles, getMediaServerConfig } from "../services/mediaServer.js";
import { findWatchedMatch } from "../services/archival.js";

export const dashboardRouter = Router();

function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

/** Most recently added library items, for the home dashboard's "Recently Added" widget. */
dashboardRouter.get(
  "/recently-added",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    let rows = db.prepare("SELECT * FROM media_items ORDER BY added_at DESC LIMIT 50").all() as any[];
    if (allowedTypes) rows = rows.filter((r) => allowedTypes.includes(r.type));
    res.json(rows.slice(0, 12).map(mediaItemFromRow));
  })
);

/**
 * Cross-references the configured media server's "watched" list (same source as auto-archival)
 * against library items/episodes/sub-items with a file, ordered by most recently played. Also
 * merges in anything recorded instantly by the media-server webhook (services/mediaServerWebhook.ts)
 * so a just-finished episode shows up immediately rather than waiting for the next poll — the
 * more recent timestamp wins when both sources have the same item. Returns an empty list (not an
 * error) when nothing is configured, so the widget can just hide.
 */
dashboardRouter.get(
  "/recently-watched",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    const webhookEvents = db
      .prepare(
        `SELECT we.media_item_id, we.episode_id, we.sub_item_id, we.watched_at, m.title AS parent_title, m.type AS parent_type,
                e.season_number, e.episode_number, s.title AS sub_title
         FROM watch_events we
         JOIN media_items m ON m.id = we.media_item_id
         LEFT JOIN episodes e ON e.id = we.episode_id
         LEFT JOIN sub_items s ON s.id = we.sub_item_id
         ORDER BY we.watched_at DESC
         LIMIT 50`
      )
      .all() as any[];

    const keyed = new Map<string, { mediaItemId: number; type: string; label: string; watchedAt: string }>();
    for (const ev of webhookEvents) {
      if (allowedTypes && !allowedTypes.includes(ev.parent_type)) continue;
      const label = ev.episode_id
        ? `${ev.parent_title} — S${String(ev.season_number).padStart(2, "0")}E${String(ev.episode_number).padStart(2, "0")}`
        : ev.sub_item_id
        ? `${ev.parent_title} — ${ev.sub_title}`
        : ev.parent_title;
      const key = `${ev.media_item_id}-${ev.episode_id ?? ""}-${ev.sub_item_id ?? ""}`;
      keyed.set(key, { mediaItemId: ev.media_item_id, type: ev.parent_type, label, watchedAt: ev.watched_at });
    }

    if (!getMediaServerConfig()) {
      const results = Array.from(keyed.values()).sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
      res.json(results.slice(0, 12));
      return;
    }
    const watched = await fetchWatchedFiles();
    if (watched.length === 0) {
      const results = Array.from(keyed.values()).sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
      res.json(results.slice(0, 12));
      return;
    }

    const items = db.prepare("SELECT * FROM media_items WHERE has_file = 1").all() as any[];
    const episodes = db
      .prepare("SELECT e.*, m.title AS parent_title, m.type AS parent_type FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.has_file = 1")
      .all() as any[];
    const subItems = db
      .prepare("SELECT s.*, m.title AS parent_title, m.type AS parent_type FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.has_file = 1")
      .all() as any[];

    function upsert(key: string, entry: { mediaItemId: number; type: string; label: string; watchedAt: string }) {
      const existing = keyed.get(key);
      if (!existing || entry.watchedAt > existing.watchedAt) keyed.set(key, entry);
    }

    for (const item of items) {
      if (allowedTypes && !allowedTypes.includes(item.type)) continue;
      const match = findWatchedMatch(item.path, watched);
      if (match) upsert(`${item.id}--`, { mediaItemId: item.id, type: item.type, label: item.title, watchedAt: match.lastPlayedAt.toISOString() });
    }
    for (const ep of episodes) {
      if (allowedTypes && !allowedTypes.includes(ep.parent_type)) continue;
      const match = findWatchedMatch(ep.file_path, watched);
      if (match) {
        const label = `${ep.parent_title} — S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
        upsert(`${ep.media_item_id}-${ep.id}-`, { mediaItemId: ep.media_item_id, type: ep.parent_type, label, watchedAt: match.lastPlayedAt.toISOString() });
      }
    }
    for (const sub of subItems) {
      if (allowedTypes && !allowedTypes.includes(sub.parent_type)) continue;
      const match = findWatchedMatch(sub.file_path, watched);
      if (match) {
        upsert(`${sub.media_item_id}--${sub.id}`, {
          mediaItemId: sub.media_item_id,
          type: sub.parent_type,
          label: `${sub.parent_title} — ${sub.title}`,
          watchedAt: match.lastPlayedAt.toISOString(),
        });
      }
    }

    const results = Array.from(keyed.values()).sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
    res.json(results.slice(0, 12));
  })
);
