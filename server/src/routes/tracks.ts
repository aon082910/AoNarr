import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { trackFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchAlbumTracksFor } from "../services/metadata.js";

export const tracksRouter = Router();
tracksRouter.use(requireAdmin);

tracksRouter.get(
  "/subitems/:subItemId/tracks",
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number")
      .all(req.params.subItemId);
    res.json(rows.map(trackFromRow));
  })
);

/** Lazily fetches (and caches) the track list for an album from MusicBrainz. */
tracksRouter.post(
  "/subitems/:subItemId/tracks/fetch",
  asyncHandler(async (req, res) => {
    const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(req.params.subItemId)) as any;
    if (!subRow) throw new HttpError(404, "Sub-item not found");

    const existing = await db.prepare("SELECT id FROM tracks WHERE sub_item_id = ? LIMIT 1").get(subRow.id);
    if (existing) {
      const rows = await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(subRow.id);
      res.json(rows.map(trackFromRow));
      return;
    }

    if (!subRow.external_id || !subRow.external_provider) {
      throw new HttpError(400, "This album has no metadata provider id to fetch tracks from");
    }

    try {
      const tracks = await fetchAlbumTracksFor(subRow.external_provider, subRow.external_id);
      await db.transaction(async () => {
        for (const t of tracks) {
          await db
            .prepare(
              `INSERT INTO tracks (sub_item_id, track_number, title, duration_seconds) VALUES (?, ?, ?, ?)
               ON CONFLICT(sub_item_id, track_number) DO UPDATE SET title = excluded.title`
            )
            .run(subRow.id, t.trackNumber, t.title, t.durationSeconds);
        }
      });

      const rows = await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? ORDER BY track_number").all(subRow.id);
      res.json(rows.map(trackFromRow));
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  })
);
