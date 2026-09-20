import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { MEDIA_TYPES } from "../services/mediaTypes.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { clampLimit, clampOffset } from "../services/mediaQuery.js";

export const wantedRouter = Router();
wantedRouter.use(requireAdmin);

const SINGLE_SHAPE_TYPES = Object.values(MEDIA_TYPES)
  .filter((t) => t.shape === "single")
  .map((t) => t.key);

/** Everything monitored across the library that doesn't have a file yet. */
wantedRouter.get(
  "/missing",
  asyncHandler(async (_req, res) => {
    const placeholders = SINGLE_SHAPE_TYPES.map(() => "?").join(",");
    // `legacy_shape = 'single'` picks up a not-yet-converted adult item, which no longer appears in
    // SINGLE_SHAPE_TYPES by type (adult is "episodic" now) but still has its file directly on the
    // item itself — see media_items.legacy_shape.
    const movies = await db
      .prepare(
        `SELECT id AS "mediaItemId", title AS "mediaTitle", type, NULL AS "episodeId", NULL AS "subItemId",
                title AS label, year AS "sortKey"
         FROM media_items WHERE (type IN (${placeholders}) OR legacy_shape = 'single') AND monitored = 1 AND has_file = 0`
      )
      .all(...SINGLE_SHAPE_TYPES);

    const episodes = await db
      .prepare(
        `SELECT m.id AS "mediaItemId", m.title AS "mediaTitle", m.type, e.id AS "episodeId", NULL AS "subItemId",
                ('S' || (CASE WHEN e.season_number < 10 THEN '0' || CAST(e.season_number AS TEXT) ELSE CAST(e.season_number AS TEXT) END) || 'E' || (CASE WHEN e.episode_number < 10 THEN '0' || CAST(e.episode_number AS TEXT) ELSE CAST(e.episode_number AS TEXT) END)) AS label,
                e.air_date AS "sortKey"
         FROM episodes e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.monitored = 1 AND e.has_file = 0 AND m.monitored = 1
         ORDER BY e.air_date IS NULL, e.air_date`
      )
      .all();

    const subItems = await db
      .prepare(
        `SELECT m.id AS "mediaItemId", m.title AS "mediaTitle", m.type, NULL AS "episodeId", s.id AS "subItemId",
                s.title AS label, s.release_date AS "sortKey"
         FROM sub_items s
         JOIN media_items m ON m.id = s.media_item_id
         WHERE s.monitored = 1 AND s.has_file = 0 AND m.monitored = 1
         ORDER BY s.release_date IS NULL, s.release_date`
      )
      .all();

    res.json({ movies, episodes, subItems });
  })
);

/** Upcoming episodes (by air date), movies/other single-shape items (by their own release date),
 * albums/books (by release date), and admin-added custom events, in a date range — the same
 * per-type date source Sonarr (episode air date), Radarr (movie release date), and Lidarr/Readarr
 * (album/book release date) each use for their own calendars. */
wantedRouter.get(
  "/calendar",
  asyncHandler(async (req, res) => {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    if (!start || !end) throw new HttpError(400, "start and end query params are required (YYYY-MM-DD)");

    const episodes = await db
      .prepare(
        `SELECT m.id AS "mediaItemId", m.title AS "mediaTitle", m.type AS type, e.id AS "episodeId", NULL AS "subItemId",
                ('S' || (CASE WHEN e.season_number < 10 THEN '0' || CAST(e.season_number AS TEXT) ELSE CAST(e.season_number AS TEXT) END) || 'E' || (CASE WHEN e.episode_number < 10 THEN '0' || CAST(e.episode_number AS TEXT) ELSE CAST(e.episode_number AS TEXT) END) ||
                 CASE WHEN e.title IS NOT NULL THEN ' - ' || e.title ELSE '' END) AS label,
                e.air_date AS date, e.has_file AS "hasFile", 'media' AS kind
         FROM episodes e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.air_date BETWEEN ? AND ?
         ORDER BY e.air_date`
      )
      .all(start, end);

    const subItems = await db
      .prepare(
        `SELECT m.id AS "mediaItemId", m.title AS "mediaTitle", m.type AS type, NULL AS "episodeId", s.id AS "subItemId",
                s.title AS label, s.release_date AS date, s.has_file AS "hasFile", 'media' AS kind
         FROM sub_items s
         JOIN media_items m ON m.id = s.media_item_id
         WHERE s.release_date BETWEEN ? AND ?
         ORDER BY s.release_date`
      )
      .all(start, end);

    const singleShapePlaceholders = SINGLE_SHAPE_TYPES.map(() => "?").join(",");
    const singleShapeItems = await db
      .prepare(
        `SELECT id AS "mediaItemId", title AS "mediaTitle", type AS type, NULL AS "episodeId", NULL AS "subItemId",
                title AS label, release_date AS date, has_file AS "hasFile", 'media' AS kind
         FROM media_items
         WHERE release_date BETWEEN ? AND ? AND (type IN (${singleShapePlaceholders}) OR legacy_shape = 'single')`
      )
      .all(start, end, ...SINGLE_SHAPE_TYPES);

    const customEvents = await db
      .prepare(
        `SELECT id AS "mediaItemId", title AS "mediaTitle", 'custom' AS type, NULL AS "episodeId", NULL AS "subItemId",
                COALESCE(note, '') AS label, date AS date, 1 AS "hasFile", 'event' AS kind
         FROM custom_calendar_events
         WHERE date BETWEEN ? AND ?`
      )
      .all(start, end);

    const combined = [...episodes, ...subItems, ...singleShapeItems, ...customEvents].sort((a: any, b: any) => (a.date > b.date ? 1 : -1));
    res.json(combined);
  })
);

/** Radarr/Sonarr-style "Cutoff Unmet" list — everything downloaded whose current quality ranks
 * below its own quality profile's cutoff, so it's still eligible for an automatic upgrade search.
 * Same underlying comparison as the Library page's "Cutoff unmet" status filter
 * (services/mediaQuery.ts), just presented as its own page here with per-row/bulk re-search,
 * mirroring how /missing is presented for items with no file at all.
 *
 * findUpgradeCandidates() has no server-side filter/sort of its own to push a LIMIT/OFFSET into,
 * so pagination is applied to the resolved candidate array in JS: the full array's length is the
 * total count, and only the current page's slice of ids gets resolved against media_items. */
wantedRouter.get(
  "/cutoff-unmet",
  asyncHandler(async (req, res) => {
    const pageSize = clampLimit(req.query.pageSize, 60, 500);
    const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
    const offset = clampOffset((page - 1) * pageSize);

    const candidates = await findUpgradeCandidates();
    const total = candidates.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageCandidates = candidates.slice(offset, offset + pageSize);

    if (pageCandidates.length === 0) {
      res.json({ rows: [], total, page, pageSize, totalPages });
      return;
    }
    const mediaItemIds = Array.from(new Set(pageCandidates.map((c) => c.mediaItemId)));
    const placeholders = mediaItemIds.map(() => "?").join(",");
    const rows = (await db
      .prepare(`SELECT id, title, type FROM media_items WHERE id IN (${placeholders})`)
      .all(...mediaItemIds)) as { id: number; title: string; type: string }[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    res.json({
      rows: pageCandidates.map((c) => ({
        mediaItemId: c.mediaItemId,
        mediaTitle: byId.get(c.mediaItemId)?.title ?? c.target,
        type: byId.get(c.mediaItemId)?.type ?? null,
        episodeId: c.episodeId ?? null,
        subItemId: c.subItemId ?? null,
        label: c.target,
        currentQuality: c.currentQuality,
        cutoff: c.cutoff,
        profileName: c.profileName,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  })
);
