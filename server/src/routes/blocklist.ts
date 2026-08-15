import { Router } from "express";
import { db } from "../db/client.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const blocklistRouter = Router();
blocklistRouter.use(requireAdmin);

blocklistRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.media_item_id AS mediaItemId, b.release_title AS releaseTitle, b.reason,
                b.created_at AS createdAt, m.title AS mediaTitle
         FROM blocklist b JOIN media_items m ON m.id = b.media_item_id
         ORDER BY b.created_at DESC`
      )
      .all();
    res.json(rows);
  })
);

blocklistRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.mediaItemId || !b.releaseTitle) throw new HttpError(400, "mediaItemId and releaseTitle are required");
    const mediaItem = db.prepare("SELECT id FROM media_items WHERE id = ?").get(b.mediaItemId);
    if (!mediaItem) throw new HttpError(404, "Media item not found");
    const result = db
      .prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)")
      .run(b.mediaItemId, b.releaseTitle, b.indexerId ?? null, b.reason ?? null);
    res.status(201).json({ id: result.lastInsertRowid });
  })
);

blocklistRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM blocklist WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Blocklist entry not found");
    res.status(204).send();
  })
);
