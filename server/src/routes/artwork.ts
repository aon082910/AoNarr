import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchArtworkFor } from "../services/metadata.js";

export const artworkRouter = Router();
artworkRouter.use(requireAdmin);

artworkRouter.get(
  "/:id/artwork",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
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
    const { posterUrl, backdropUrl } = req.body ?? {};
    if (!posterUrl && !backdropUrl) throw new HttpError(400, "posterUrl or backdropUrl is required");

    // An admin manually picking a different (live) poster/backdrop here means whichever of these
    // is being replaced is no longer local art — clears its local_*_path/token (see
    // services/localArtwork.ts) rather than leaving them pointing at a file the UI no longer
    // references at all.
    const result = await db
      .prepare(
        `UPDATE media_items SET
           poster_url = COALESCE(?, poster_url),
           local_poster_path = CASE WHEN ? IS NOT NULL THEN NULL ELSE local_poster_path END,
           local_poster_token = CASE WHEN ? IS NOT NULL THEN NULL ELSE local_poster_token END,
           backdrop_url = COALESCE(?, backdrop_url),
           local_backdrop_path = CASE WHEN ? IS NOT NULL THEN NULL ELSE local_backdrop_path END,
           local_backdrop_token = CASE WHEN ? IS NOT NULL THEN NULL ELSE local_backdrop_token END
         WHERE id = ?`
      )
      .run(posterUrl ?? null, posterUrl ?? null, posterUrl ?? null, backdropUrl ?? null, backdropUrl ?? null, backdropUrl ?? null, req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Media item not found");

    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(row));
  })
);
