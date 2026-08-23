import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { MEDIA_TYPES } from "../services/mediaTypes.js";

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
    const movies = db
      .prepare(
        `SELECT id AS mediaItemId, title AS mediaTitle, type, NULL AS episodeId, NULL AS subItemId,
                title AS label, year AS sortKey
         FROM media_items WHERE type IN (${placeholders}) AND monitored = 1 AND has_file = 0`
      )
      .all(...SINGLE_SHAPE_TYPES);

    const episodes = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type, e.id AS episodeId, NULL AS subItemId,
                ('S' || substr('00' || e.season_number, -2) || 'E' || substr('00' || e.episode_number, -2)) AS label,
                e.air_date AS sortKey
         FROM episodes e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.monitored = 1 AND e.has_file = 0 AND m.monitored = 1
         ORDER BY e.air_date IS NULL, e.air_date`
      )
      .all();

    const subItems = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type, NULL AS episodeId, s.id AS subItemId,
                s.title AS label, s.release_date AS sortKey
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

    const episodes = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type AS type, e.id AS episodeId, NULL AS subItemId,
                ('S' || substr('00' || e.season_number, -2) || 'E' || substr('00' || e.episode_number, -2) ||
                 CASE WHEN e.title IS NOT NULL THEN ' - ' || e.title ELSE '' END) AS label,
                e.air_date AS date, e.has_file AS hasFile, 'media' AS kind
         FROM episodes e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.air_date BETWEEN ? AND ?
         ORDER BY e.air_date`
      )
      .all(start, end);

    const subItems = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type AS type, NULL AS episodeId, s.id AS subItemId,
                s.title AS label, s.release_date AS date, s.has_file AS hasFile, 'media' AS kind
         FROM sub_items s
         JOIN media_items m ON m.id = s.media_item_id
         WHERE s.release_date BETWEEN ? AND ?
         ORDER BY s.release_date`
      )
      .all(start, end);

    const singleShapePlaceholders = SINGLE_SHAPE_TYPES.map(() => "?").join(",");
    const singleShapeItems = db
      .prepare(
        `SELECT id AS mediaItemId, title AS mediaTitle, type AS type, NULL AS episodeId, NULL AS subItemId,
                title AS label, release_date AS date, has_file AS hasFile, 'media' AS kind
         FROM media_items
         WHERE release_date BETWEEN ? AND ? AND type IN (${singleShapePlaceholders})`
      )
      .all(start, end, ...SINGLE_SHAPE_TYPES);

    const customEvents = db
      .prepare(
        `SELECT id AS mediaItemId, title AS mediaTitle, 'custom' AS type, NULL AS episodeId, NULL AS subItemId,
                COALESCE(note, '') AS label, date AS date, 1 AS hasFile, 'event' AS kind
         FROM custom_calendar_events
         WHERE date BETWEEN ? AND ?`
      )
      .all(start, end);

    const combined = [...episodes, ...subItems, ...singleShapeItems, ...customEvents].sort((a: any, b: any) => (a.date > b.date ? 1 : -1));
    res.json(combined);
  })
);
