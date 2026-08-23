import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { importMoviesFromRadarr, importSeriesFromSonarr } from "../services/starrImport.js";
import { log } from "../services/logger.js";

export const starrImportRouter = Router();
starrImportRouter.use(requireAdmin);

function requireUrlAndKey(req: import("express").Request): { url: string; apiKey: string } {
  const url = String(req.body?.url ?? "").trim();
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!url || !apiKey) throw new HttpError(400, "Radarr/Sonarr URL and API key are both required");
  return { url, apiKey };
}

/** Same fire-and-forget reasoning as media-server-import's own routes: fetching and matching an
 * entire Radarr/Sonarr library can easily outrun an HTTP/gateway timeout. */
starrImportRouter.post(
  "/movies",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const rootFolderId = Number(req.body?.rootFolderId);
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importMoviesFromRadarr(url, apiKey, rootFolderId).catch((err) => log.warn("[starrImport] Radarr import failed:", (err as Error).message));
    res.json({ started: true });
  })
);

starrImportRouter.post(
  "/series",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const rootFolderId = Number(req.body?.rootFolderId);
    const type = req.body?.type === "anime" ? "anime" : "series";
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importSeriesFromSonarr(url, apiKey, type, rootFolderId).catch((err) => log.warn("[starrImport] Sonarr import failed:", (err as Error).message));
    res.json({ started: true });
  })
);
