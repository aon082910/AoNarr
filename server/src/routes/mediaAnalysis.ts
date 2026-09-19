import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { getLibraryAnalysis, runLibraryAnalysis, getAnalysisProgress } from "../services/mediaAnalysis.js";
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

/** Polled by the client while "Analyze Now" is running, to show a live progress bar instead of
 * the old fire-and-forget "check the Logs page later" experience. */
mediaAnalysisRouter.get(
  "/progress",
  asyncHandler(async (req, res) => {
    res.json(getAnalysisProgress());
  })
);

/**
 * Fire-and-forget re-probe of every file in a type (or every type) with the full HDR/Dolby-Vision/
 * multi-track audio+subtitle-aware ffprobe wrapper — same reasoning as Scan & Import's own
 * fire-and-forget route: probing every file can easily outrun an HTTP/gateway timeout for a large
 * library, so this starts the job and returns immediately. Progress is polled via GET /progress
 * above; a final summary is also logged (visible on the Logs page).
 */
mediaAnalysisRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type && !isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}"`);
    if (getAnalysisProgress().running) {
      res.json({ started: false, reason: "already-running" });
      return;
    }
    runLibraryAnalysis(type).catch((err) => log.warn(`[mediaAnalysis] run failed:`, (err as Error).message));
    res.json({ started: true });
  })
);

/** GET /api/media-analysis/export.csv — a flat CSV of every analyzed file (or one type), for
 * spreadsheet review outside the app. Registered before nothing needs to shadow it (no "/:id"
 * route on this router), unlike media.ts's export.csv. */
mediaAnalysisRouter.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type && !isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}"`);
    const { items } = await getLibraryAnalysis(type);

    const header = [
      "title",
      "type",
      "path",
      "videoCodec",
      "resolution",
      "hdr",
      "bitDepth",
      "audioCodecs",
      "audioLanguages",
      "subtitleLanguages",
      "compatibilityLevel",
      "compatibilityNotes",
    ];
    const lines = [header.join(",")];
    for (const item of items) {
      const info = item.mediaInfo;
      const row = [
        item.title,
        item.type,
        item.path,
        info.videoCodec ?? "",
        info.width && info.height ? `${info.width}x${info.height}` : "",
        info.hdrFormat ?? "",
        info.bitDepth ?? "",
        (info.audioStreams ?? []).map((a) => a.codec ?? "?").join("; "),
        (info.audioStreams ?? []).map((a) => a.language ?? "?").join("; "),
        (info.subtitleStreams ?? []).map((s) => s.language ?? s.codec ?? "?").join("; "),
        item.compatibilityNotes.some((n) => n.level === "incompatible")
          ? "incompatible"
          : item.compatibilityNotes.some((n) => n.level === "caution")
            ? "caution"
            : "ok",
        item.compatibilityNotes.map((n) => n.message).join(" | "),
      ];
      lines.push(row.map(csvEscape).join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="aonarr-media-analysis${type ? `-${type}` : ""}.csv"`);
    res.send(lines.join("\n"));
  })
);

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
