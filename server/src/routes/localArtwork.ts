import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { streamFileWithRangeSupport } from "../services/rangeStream.js";

/**
 * Serves a local poster/backdrop file a sidecar resolved (see services/localArtwork.ts) — looked
 * up purely by its own opaque token, the same "capability URL" pattern /api/share/:token already
 * uses, and for the same reason: an <img src>/CSS background-image can't carry the X-Api-Key/
 * X-Session-Token headers the rest of the API requires, so this route is exempted from requireAuth
 * entirely (see middleware/auth.ts's path list) rather than accepting a query-param credential —
 * poster_url/backdrop_url already return this route's URL verbatim, with nothing further for the
 * frontend to do differently for a local image than a remote one.
 */
export const localArtworkRouter = Router();

localArtworkRouter.get(
  "/local-artwork/:token",
  asyncHandler(async (req, res) => {
    const row = (await db
      .prepare(
        `SELECT local_poster_path, local_poster_token, local_backdrop_path, local_backdrop_token
         FROM media_items WHERE local_poster_token = ? OR local_backdrop_token = ?`
      )
      .get(req.params.token, req.params.token)) as
      | { local_poster_path: string | null; local_poster_token: string | null; local_backdrop_path: string | null; local_backdrop_token: string | null }
      | undefined;
    if (!row) throw new HttpError(404, "No artwork found for this token");
    const filePath = row.local_poster_token === req.params.token ? row.local_poster_path : row.local_backdrop_path;
    if (!filePath) throw new HttpError(404, "No artwork found for this token");
    streamFileWithRangeSupport(req, res, filePath);
  })
);
