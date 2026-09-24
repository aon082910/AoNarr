import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { streamFileWithRangeSupport } from "../services/rangeStream.js";
import { isLocalArtworkExtension } from "../services/localArtwork.js";
import { fetchMediaServerArtwork, isMediaServerArtworkRef } from "../services/mediaServer.js";
import { Readable } from "node:stream";

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
    // A media server's own artwork (see mediaServer.ts's MEDIA_SERVER_ARTWORK_PREFIX) is proxied
    // with the server's credential sent as a header — never handed to the browser in a URL.
    if (isMediaServerArtworkRef(filePath)) {
      const upstream = await fetchMediaServerArtwork(filePath).catch(() => null);
      if (!upstream?.body) throw new HttpError(404, "No artwork found for this token");
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      Readable.fromWeb(upstream.body as any).pipe(res);
      return;
    }
    // Re-checked here too, not just at resolve time: this route is unauthenticated, and a row
    // written before resolveLocalArtwork gained its containment/extension check could still hold
    // a traversal path like "../../config/aonarr.db".
    if (!filePath || !isLocalArtworkExtension(filePath)) throw new HttpError(404, "No artwork found for this token");
    streamFileWithRangeSupport(req, res, filePath);
  })
);
