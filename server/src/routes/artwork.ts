import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchArtworkFor } from "../services/metadata.js";

export const artworkRouter = Router();
artworkRouter.use(requireAdmin);

artworkRouter.get(
  "/:id/artwork",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(row);
    const externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};

    try {
      const options = await fetchArtworkFor(item.type, externalIds);
      res.json(options);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

artworkRouter.post(
  "/:id/artwork/select",
  asyncHandler(async (req, res) => {
    const posterUrl = req.body?.posterUrl;
    if (!posterUrl) throw new HttpError(400, "posterUrl is required");

    const result = db.prepare("UPDATE media_items SET poster_url = ? WHERE id = ?").run(posterUrl, req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Media item not found");

    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(row));
  })
);
