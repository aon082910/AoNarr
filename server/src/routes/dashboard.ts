import { Router } from "express";
import fs from "node:fs";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { fetchWatchedFiles, getMediaServerConfig } from "../services/mediaServer.js";
import { findWatchedMatch } from "../services/archival.js";
import { isRatingBlocked } from "../services/contentRatings.js";
import { log } from "../services/logger.js";

export const dashboardRouter = Router();

function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

/** Same gate GET /media/:id applies — a household account's max content rating hides an item
 * here too, not just when it's opened directly. */
function ratingBlockedFor(req: import("express").Request): (contentRating: string | null) => boolean {
  const max = req.auth?.isAdmin ? null : req.auth?.user?.maxContentRating ?? null;
  if (!max) return () => false;
  return (rating) => isRatingBlocked(rating, max);
}

/** Most recently added library items, for the home dashboard's "Recently Added" widget. */
dashboardRouter.get(
  "/recently-added",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    const blocked = ratingBlockedFor(req);
    // Over-fetch for restricted accounts so filtering out other libraries' rows still leaves a
    // full widget when enough of their own exist.
    const limit = allowedTypes ? 300 : 50;
    let rows = (await db.prepare(`SELECT * FROM media_items ORDER BY added_at DESC LIMIT ${limit}`).all()) as any[];
    if (allowedTypes) rows = rows.filter((r) => allowedTypes.includes(r.type) && !blocked(r.content_rating ?? null));
    res.json(rows.slice(0, 12).map(mediaItemFromRow));
  })
);

/**
 * Most recent library-content changes (grabbed/imported/archived/subtitle events from `history`),
 * for the home dashboard's "Recently Changed" widget — a smaller, unauthenticated-safe sibling of
 * activity.ts's admin-only `/timeline` (which also merges in Requests and isn't capped as tightly).
 */
dashboardRouter.get(
  "/recent",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    const blocked = ratingBlockedFor(req);
    const rows = (await db
      .prepare(
        `SELECT h.event_type AS "eventType", h.data, h.created_at AS "createdAt",
                m.id AS "mediaItemId", m.title AS "mediaTitle", m.type AS "mediaType", m.content_rating AS "contentRating"
         FROM history h JOIN media_items m ON m.id = h.media_item_id
         ORDER BY h.created_at DESC LIMIT 100`
      )
      .all()) as { eventType: string; data: string | null; createdAt: string; mediaItemId: number; mediaTitle: string; mediaType: string; contentRating: string | null }[];

    let entries = rows.map((row) => {
      let detail: string | null = null;
      try {
        const parsed = row.data ? JSON.parse(row.data) : null;
        detail = parsed?.title ?? parsed?.fileName ?? parsed?.reason ?? null;
      } catch {
        detail = null;
      }
      return {
        timestamp: row.createdAt,
        eventType: row.eventType,
        mediaItemId: row.mediaItemId,
        title: row.mediaTitle,
        type: row.mediaType,
        detail,
        contentRating: row.contentRating,
      };
    });
    if (allowedTypes) entries = entries.filter((e) => allowedTypes.includes(e.type) && !blocked(e.contentRating));
    entries = entries.map(({ contentRating: _cr, ...rest }) => rest) as typeof entries;
    res.json(entries.slice(0, 15));
  })
);

/** Per-type item counts, for the Library landing page's per-type cards — same access rules as
 * everything else here (household accounts only see counts for their allowed types). */
dashboardRouter.get(
  "/library-counts",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    const blocked = ratingBlockedFor(req);
    // Counted in JS rather than SQL COUNT()/GROUP BY — rating-blocking isn't a simple equality
    // filter (it walks CONTENT_RATING_ORDER), so it can't be pushed into the aggregate query.
    // Otherwise a restricted user's per-type count on the Library landing page included
    // rating-blocked items they can't actually open — the same gate every other route here applies.
    const rows = (await db.prepare("SELECT type, content_rating FROM media_items").all()) as {
      type: string;
      content_rating: string | null;
    }[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (allowedTypes && !allowedTypes.includes(r.type)) continue;
      if (blocked(r.content_rating ?? null)) continue;
      counts[r.type] = (counts[r.type] ?? 0) + 1;
    }
    res.json(counts);
  })
);

/** Actual on-disk file sizes, grouped by library type — sums media_items.path plus every
 * episode/sub_item/track file_path, statting each file directly rather than trusting the stored
 * `size_bytes` column (populated at import time, but can drift if a file is replaced/edited on
 * disk outside AoNarr afterward). Cached for 10 minutes since this stats every file in the
 * library on a cache miss. */
let sizeCache: { at: number; sizes: Record<string, number> } | null = null;
const SIZE_CACHE_TTL_MS = 10 * 60 * 1000;

function addSize(sizes: Record<string, number>, type: string, filePath: string | null, folderSizeBytes: number | null = null) {
  if (!filePath) return;
  try {
    const stat = fs.statSync(filePath);
    // A folder's own stat size is only its directory entry (~4 KB), not its contents — an album's
    // or audiobook's files are counted through their own `tracks` rows instead, or through the
    // size recorded at import when no track row holds them.
    const bytes = stat.isFile() ? stat.size : folderSizeBytes;
    if (bytes) sizes[type] = (sizes[type] ?? 0) + bytes;
  } catch {
    // file listed in the DB but missing on disk — skip rather than crash the whole computation
  }
}

// Keyed by "typecontentRating" rather than just type — lets /library-sizes filter out
// rating-blocked content for a restricted user at request time without re-statting the whole
// library (which only happens once per cache TTL) just because who's asking changed.
function sizeKey(type: string, contentRating: string | null): string {
  return `${type}${contentRating ?? ""}`;
}

async function computeLibrarySizes(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const row of (await db.prepare("SELECT type, path, content_rating FROM media_items WHERE has_file = 1").all()) as any[]) {
    addSize(sizes, sizeKey(row.type, row.content_rating), row.path);
  }
  for (const row of (await db
    .prepare(
      `SELECT m.type, e.file_path, m.content_rating FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.has_file = 1`
    )
    .all()) as any[]) {
    addSize(sizes, sizeKey(row.type, row.content_rating), row.file_path);
  }
  // Multi-file sub-items (a Music album, an Audiobook) keep the album folder in file_path and each
  // real file in `tracks` — sum those, and don't also count the sub-item's own path for them.
  const subItemsWithTracks = new Set<number>();
  for (const row of (await db
    .prepare(
      `SELECT t.sub_item_id, t.file_path, m.type, m.content_rating FROM tracks t
       JOIN sub_items s ON s.id = t.sub_item_id JOIN media_items m ON m.id = s.media_item_id
       WHERE t.has_file = 1 AND t.file_path IS NOT NULL`
    )
    .all()) as any[]) {
    subItemsWithTracks.add(Number(row.sub_item_id));
    addSize(sizes, sizeKey(row.type, row.content_rating), row.file_path);
  }
  for (const row of (await db
    .prepare(
      `SELECT s.id, m.type, s.file_path, s.size_bytes, m.content_rating FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.has_file = 1`
    )
    .all()) as any[]) {
    if (subItemsWithTracks.has(Number(row.id))) continue;
    addSize(sizes, sizeKey(row.type, row.content_rating), row.file_path, row.size_bytes == null ? null : Number(row.size_bytes));
  }
  return sizes;
}

dashboardRouter.get(
  "/library-sizes",
  asyncHandler(async (req, res) => {
    if (!sizeCache || Date.now() - sizeCache.at > SIZE_CACHE_TTL_MS) {
      sizeCache = { at: Date.now(), sizes: await computeLibrarySizes() };
    }
    const allowedTypes = allowedTypesFor(req);
    const blocked = ratingBlockedFor(req);
    const sizes: Record<string, number> = {};
    for (const [key, bytes] of Object.entries(sizeCache.sizes)) {
      const [type, contentRating] = key.split("");
      if (allowedTypes && !allowedTypes.includes(type)) continue;
      if (blocked(contentRating || null)) continue;
      sizes[type] = (sizes[type] ?? 0) + bytes;
    }
    res.json(sizes);
  })
);

/** watch_events.watched_at is 'YYYY-MM-DD HH:MM:SS' UTC text while poll matches are toISOString()
 * — mixed, the string compare/sort below ranked any same-day poll entry above a newer webhook one
 * (' ' < 'T'), and the client read the zone-less form as local time. */
function isoFromSqlTimestamp(value: string): string {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

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
    const blocked = ratingBlockedFor(req);
    const webhookEvents = (await db
      .prepare(
        `SELECT we.media_item_id, we.episode_id, we.sub_item_id, we.watched_at, m.title AS parent_title, m.type AS parent_type,
                m.content_rating AS parent_rating, e.season_number, e.episode_number, s.title AS sub_title
         FROM watch_events we
         JOIN media_items m ON m.id = we.media_item_id
         LEFT JOIN episodes e ON e.id = we.episode_id
         LEFT JOIN sub_items s ON s.id = we.sub_item_id
         ORDER BY we.watched_at DESC
         LIMIT 50`
      )
      .all()) as any[];

    const keyed = new Map<string, { mediaItemId: number; type: string; label: string; watchedAt: string }>();
    for (const ev of webhookEvents) {
      if (allowedTypes && (!allowedTypes.includes(ev.parent_type) || blocked(ev.parent_rating ?? null))) continue;
      const label = ev.episode_id
        ? `${ev.parent_title} — S${String(ev.season_number).padStart(2, "0")}E${String(ev.episode_number).padStart(2, "0")}`
        : ev.sub_item_id
        ? `${ev.parent_title} — ${ev.sub_title}`
        : ev.parent_title;
      const key = `${ev.media_item_id}-${ev.episode_id ?? ""}-${ev.sub_item_id ?? ""}`;
      // Rows arrive newest first — keep that one rather than letting an older watch of the same
      // item overwrite it.
      if (keyed.has(key)) continue;
      keyed.set(key, { mediaItemId: ev.media_item_id, type: ev.parent_type, label, watchedAt: isoFromSqlTimestamp(ev.watched_at) });
    }

    if (!getMediaServerConfig()) {
      const results = Array.from(keyed.values()).sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
      res.json(results.slice(0, 12));
      return;
    }
    let watched: Awaited<ReturnType<typeof fetchWatchedFiles>>;
    try {
      watched = await fetchWatchedFiles();
    } catch (err) {
      // An unreachable media server must only cost this widget its poll results — a 500 here fails
      // the whole dashboard page, which loads every widget in one batch.
      log.warn("[dashboard] recently-watched: media server request failed, showing webhook-recorded watches only:", (err as Error).message);
      watched = [];
    }
    if (watched.length === 0) {
      const results = Array.from(keyed.values()).sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
      res.json(results.slice(0, 12));
      return;
    }

    const items = (await db.prepare("SELECT * FROM media_items WHERE has_file = 1").all()) as any[];
    const episodes = (await db
      .prepare("SELECT e.*, m.title AS parent_title, m.type AS parent_type, m.content_rating AS parent_rating FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.has_file = 1")
      .all()) as any[];
    const subItems = (await db
      .prepare("SELECT s.*, m.title AS parent_title, m.type AS parent_type, m.content_rating AS parent_rating FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.has_file = 1")
      .all()) as any[];

    function upsert(key: string, entry: { mediaItemId: number; type: string; label: string; watchedAt: string }) {
      const existing = keyed.get(key);
      if (!existing || entry.watchedAt > existing.watchedAt) keyed.set(key, entry);
    }

    for (const item of items) {
      if (allowedTypes && (!allowedTypes.includes(item.type) || blocked(item.content_rating ?? null))) continue;
      const match = findWatchedMatch(item.path, watched);
      if (match) upsert(`${item.id}--`, { mediaItemId: item.id, type: item.type, label: item.title, watchedAt: match.lastPlayedAt.toISOString() });
    }
    for (const ep of episodes) {
      if (allowedTypes && (!allowedTypes.includes(ep.parent_type) || blocked(ep.parent_rating ?? null))) continue;
      const match = findWatchedMatch(ep.file_path, watched);
      if (match) {
        const label = `${ep.parent_title} — S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
        upsert(`${ep.media_item_id}-${ep.id}-`, { mediaItemId: ep.media_item_id, type: ep.parent_type, label, watchedAt: match.lastPlayedAt.toISOString() });
      }
    }
    for (const sub of subItems) {
      if (allowedTypes && (!allowedTypes.includes(sub.parent_type) || blocked(sub.parent_rating ?? null))) continue;
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
