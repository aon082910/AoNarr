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

/** Upcoming episodes (by air date) and albums/books (by release date) in a date range. */
wantedRouter.get(
  "/calendar",
  asyncHandler(async (req, res) => {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    if (!start || !end) throw new HttpError(400, "start and end query params are required (YYYY-MM-DD)");

    const episodes = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type AS type, e.id AS episodeId,
                ('S' || substr('00' || e.season_number, -2) || 'E' || substr('00' || e.episode_number, -2) ||
                 CASE WHEN e.title IS NOT NULL THEN ' - ' || e.title ELSE '' END) AS label,
                e.air_date AS date, e.has_file AS hasFile
         FROM episodes e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.air_date BETWEEN ? AND ?
         ORDER BY e.air_date`
      )
      .all(start, end);

    const subItems = db
      .prepare(
        `SELECT m.id AS mediaItemId, m.title AS mediaTitle, m.type AS type, s.id AS subItemId,
                s.title AS label, s.release_date AS date, s.has_file AS hasFile
         FROM sub_items s
         JOIN media_items m ON m.id = s.media_item_id
         WHERE s.release_date BETWEEN ? AND ?
         ORDER BY s.release_date`
      )
      .all(start, end);

    const combined = [...episodes, ...subItems].sort((a: any, b: any) => (a.date > b.date ? 1 : -1));
    res.json(combined);
  })
);
