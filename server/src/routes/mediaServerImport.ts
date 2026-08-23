import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getMediaServerConfig } from "../services/mediaServer.js";
import { importMoviesFromMediaServer, importSeriesFromMediaServer } from "../services/mediaServerImport.js";
import { log } from "../services/logger.js";

export const mediaServerImportRouter = Router();
mediaServerImportRouter.use(requireAdmin);

/**
 * Fire-and-forget, same reasoning as Scan & Import's own route: fetching and matching an entire
 * media-server library can easily outrun an HTTP/gateway timeout, so this starts the job and
 * returns immediately; the result is logged (visible on the Logs page) rather than returned in
 * the response.
 */
mediaServerImportRouter.post(
  "/movies",
  asyncHandler(async (req, res) => {
    if (!getMediaServerConfig()) throw new HttpError(400, "No media server configured — set one up in Settings first");
    const rootFolderId = Number(req.body?.rootFolderId);
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importMoviesFromMediaServer(rootFolderId).catch((err) => log.warn("[mediaServerImport] movies import failed:", (err as Error).message));
    res.json({ started: true });
  })
);

mediaServerImportRouter.post(
  "/series",
  asyncHandler(async (req, res) => {
    if (!getMediaServerConfig()) throw new HttpError(400, "No media server configured — set one up in Settings first");
    const rootFolderId = Number(req.body?.rootFolderId);
    const type = req.body?.type === "anime" ? "anime" : "series";
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importSeriesFromMediaServer(type, rootFolderId).catch((err) =>
      log.warn(`[mediaServerImport] ${type} import failed:`, (err as Error).message)
    );
    res.json({ started: true });
  })
);
