import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  importArtistsFromLidarr,
  importAuthorsFromReadarr,
  importMoviesFromRadarr,
  importSeriesFromSonarr,
  importAdultFromWhisparr,
  previewStarrCustomFormats,
  importStarrCustomFormats,
  previewStarrQualityProfiles,
  importStarrQualityProfiles,
  type StarrFormatApp,
} from "../services/starrImport.js";
import { log } from "../services/logger.js";

const FORMAT_APPS = new Set<StarrFormatApp>(["radarr", "sonarr", "whisparr"]);
function requireFormatApp(req: import("express").Request): StarrFormatApp {
  const app = String(req.body?.app ?? "");
  if (!FORMAT_APPS.has(app as StarrFormatApp)) throw new HttpError(400, `app must be one of: ${[...FORMAT_APPS].join(", ")}`);
  return app as StarrFormatApp;
}

export const starrImportRouter = Router();
starrImportRouter.use(requireAdmin);

function requireUrlAndKey(req: import("express").Request): { url: string; apiKey: string } {
  const url = String(req.body?.url ?? "").trim();
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!url || !apiKey) throw new HttpError(400, "URL and API key are both required");
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

starrImportRouter.post(
  "/artists",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const rootFolderId = Number(req.body?.rootFolderId);
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importArtistsFromLidarr(url, apiKey, rootFolderId).catch((err) => log.warn("[starrImport] Lidarr import failed:", (err as Error).message));
    res.json({ started: true });
  })
);

starrImportRouter.post(
  "/authors",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const rootFolderId = Number(req.body?.rootFolderId);
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importAuthorsFromReadarr(url, apiKey, rootFolderId).catch((err) => log.warn("[starrImport] Readarr import failed:", (err as Error).message));
    res.json({ started: true });
  })
);

starrImportRouter.post(
  "/adult",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const rootFolderId = Number(req.body?.rootFolderId);
    if (!rootFolderId) throw new HttpError(400, "rootFolderId is required");

    importAdultFromWhisparr(url, apiKey, rootFolderId).catch((err) => log.warn("[starrImport] Whisparr import failed:", (err as Error).message));
    res.json({ started: true });
  })
);

/** Custom Format/Quality Profile import is synchronous (unlike the library-import routes above) —
 * a single instance's own formats/profiles are a handful to a few dozen, nothing like the
 * 100+-file GitHub fetch the TRaSH-Guides sync has to be fire-and-forget for. */
starrImportRouter.post(
  "/custom-formats/preview",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const app = requireFormatApp(req);
    try {
      res.json(await previewStarrCustomFormats(url, apiKey, app));
    } catch (err) {
      throw new HttpError(400, `Couldn't reach ${app}: ${(err as Error).message}`);
    }
  })
);

starrImportRouter.post(
  "/custom-formats",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const app = requireFormatApp(req);
    const sourceIds = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds.map(Number) : [];
    if (sourceIds.length === 0) throw new HttpError(400, "sourceIds (a non-empty array) is required");
    res.json(await importStarrCustomFormats(url, apiKey, app, sourceIds));
  })
);

starrImportRouter.post(
  "/quality-profiles/preview",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const app = requireFormatApp(req);
    try {
      res.json(await previewStarrQualityProfiles(url, apiKey, app));
    } catch (err) {
      throw new HttpError(400, `Couldn't reach ${app}: ${(err as Error).message}`);
    }
  })
);

starrImportRouter.post(
  "/quality-profiles",
  asyncHandler(async (req, res) => {
    const { url, apiKey } = requireUrlAndKey(req);
    const app = requireFormatApp(req);
    const sourceIds = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds.map(Number) : [];
    if (sourceIds.length === 0) throw new HttpError(400, "sourceIds (a non-empty array) is required");
    res.json(await importStarrQualityProfiles(url, apiKey, app, sourceIds));
  })
);
