import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { getLibraryAnalysis, runLibraryAnalysis } from "../services/mediaAnalysis.js";
import { log } from "../services/logger.js";

export const mediaAnalysisRouter = Router();
mediaAnalysisRouter.use(requireAdmin);

/** Instant — reads whatever media_info is already stored, doesn't probe anything. */
mediaAnalysisRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type && !isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}"`);
    res.json(await getLibraryAnalysis(type));
  })
);

/**
 * Fire-and-forget re-probe of every file in a type (or every type) with the full HDR/Dolby-Vision/
 * multi-track audio+subtitle-aware ffprobe wrapper — same reasoning as Scan & Import's own
 * fire-and-forget route: probing every file can easily outrun an HTTP/gateway timeout for a large
 * library, so this starts the job and returns immediately; the result is logged (visible on the
 * Logs page) rather than returned in the response.
 */
mediaAnalysisRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type && !isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}"`);
    runLibraryAnalysis(type).catch((err) => log.warn(`[mediaAnalysis] run failed:`, (err as Error).message));
    res.json({ started: true });
  })
);
