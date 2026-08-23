import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { placeFile } from "../services/importer.js";
import { parseReleaseTitle } from "../services/releaseParser.js";
import { parseNfo } from "../services/nfoParser.js";
import { scrapeCoursePage } from "../services/courseScraper.js";

export const importRouter = Router();
importRouter.use(requireAdmin);

const MEDIA_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v",
  ".mp3", ".flac", ".m4a", ".ogg", ".wav",
  ".epub", ".mobi", ".pdf", ".azw3", ".m4b",
]);

/** Resolves a user-supplied relative path against the downloads dir, refusing to escape it. */
function resolveInDownloads(relativePath: string): string {
  const resolved = path.resolve(config.downloadsDir, relativePath);
  const root = path.resolve(config.downloadsDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, "Path escapes the downloads directory");
  }
  return resolved;
}

/** GET /api/import/browse?path=sub/dir — lists the downloads directory (or a subdirectory) for manual import. */
importRouter.get(
  "/browse",
  asyncHandler(async (req, res) => {
    const relativePath = (req.query.path as string | undefined) ?? "";
    const target = resolveInDownloads(relativePath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      throw new HttpError(404, "Directory not found");
    }

    const listing = entries
      .map((entry) => {
        const entryRelative = path.join(relativePath, entry.name);
        const full = path.join(target, entry.name);
        const isMediaFile = entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
        const isNfoFile = entry.isFile() && path.extname(entry.name).toLowerCase() === ".nfo";
        return {
          name: entry.name,
          path: entryRelative,
          isDirectory: entry.isDirectory(),
          isMediaFile,
          isNfoFile,
          size: entry.isFile() ? fs.statSync(full).size : null,
        };
      })
      .filter((e) => e.isDirectory || e.isMediaFile || e.isNfoFile)
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

    res.json({ path: relativePath, entries: listing });
  })
);

/** GET /api/import/nfo?path=... — parses a Kodi/Jellyfin-style .nfo sidecar file for use as Add Media prefill. */
importRouter.get(
  "/nfo",
  asyncHandler(async (req, res) => {
    const relativePath = req.query.path as string | undefined;
    if (!relativePath) throw new HttpError(400, "path is required");

    const target = resolveInDownloads(relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new HttpError(404, "NFO file not found");
    }

    const xml = fs.readFileSync(target, "utf-8");
    try {
      const parsed = await parseNfo(xml);
      res.json(parsed);
    } catch {
      throw new HttpError(400, "Could not parse this file as NFO/XML");
    }
  })
);

/** POST /api/import/course-url — scrapes a Coursera/edX/Udemy (or any) course landing page's
 * title/description/thumbnail for use as an Add Media prefill, the same role /nfo plays for
 * file-based libraries. Body: { url }. */
importRouter.post(
  "/course-url",
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) throw new HttpError(400, "url is required");
    try {
      const scraped = await scrapeCoursePage(url);
      res.json(scraped);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/** POST /api/import/manual — assign a specific downloads-dir file to a media item/episode/sub-item. */
importRouter.post(
  "/manual",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.mediaItemId || !b.sourcePath) {
      throw new HttpError(400, "mediaItemId and sourcePath are required");
    }

    const sourceFile = resolveInDownloads(b.sourcePath);
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
      throw new HttpError(404, "Source file not found");
    }

    const quality = b.quality ?? parseReleaseTitle(path.basename(sourceFile)).quality;

    const result = await placeFile({
      itemId: b.mediaItemId,
      episodeId: b.episodeId ?? null,
      subItemId: b.subItemId ?? null,
      sourceFile,
      quality,
    });

    res.json(result);
  })
);
