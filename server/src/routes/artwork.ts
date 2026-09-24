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
    // The SET list is built here rather than with `CASE WHEN ? IS NOT NULL ...` — Postgres can't
    // infer a type for a parameter used only in an IS NULL test and rejected that statement
    // outright ("could not determine data type of parameter $2"), so no pick ever saved there.
    const sets: string[] = [];
    const values: unknown[] = [];
    if (posterUrl) {
      sets.push("poster_url = ?", "local_poster_path = NULL", "local_poster_token = NULL");
      values.push(posterUrl);
    }
    if (backdropUrl) {
      sets.push("backdrop_url = ?", "local_backdrop_path = NULL", "local_backdrop_token = NULL");
      values.push(backdropUrl);
    }
    const result = await db.prepare(`UPDATE media_items SET ${sets.join(", ")} WHERE id = ?`).run(...values, req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Media item not found");

    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(row));
  })
);
