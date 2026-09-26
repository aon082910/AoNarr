import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { placeFile } from "../services/importer.js";
import { effectiveShape, getMediaTypeConfig } from "../services/mediaTypes.js";
import { parseReleaseTitle } from "../services/releaseParser.js";
import { parseNfo } from "../services/nfoParser.js";
import { scrapeCoursePage } from "../services/courseScraper.js";
import { identifyMediaFile } from "../services/aiIdentify.js";

export const importRouter = Router();
importRouter.use(requireAdmin);

const MEDIA_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v",
  ".mp3", ".flac", ".m4a", ".ogg", ".wav",
  ".epub", ".mobi", ".pdf", ".azw3", ".m4b",
  ".cbz", ".cbr",
  ".zip", ".7z", ".nes", ".sfc", ".smc", ".gba", ".gbc", ".gb", ".n64", ".z64", ".nds", ".3ds", ".iso", ".chd",
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

/**
 * Resolves a manual-import source path for /manual and /manual-batch. An absolute path is trusted
 * outright — this route is admin-only, and browsing anywhere is already exactly what /browse's own
 * anyFolder mode (and system.ts's unrestricted /browse-directory, used for root-folder picking)
 * offers at the same trust level: nothing reachable here is more sensitive than what's already
 * mounted into the container. A relative path keeps the original downloads-dir-only behavior.
 */
function resolveImportSource(sourcePath: string): string {
  return path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : resolveInDownloads(sourcePath);
}

/**
 * GET /api/import/browse?path=sub/dir — lists the downloads directory (or a subdirectory) for
 * manual import. `anyFolder=1` switches to browsing an absolute filesystem path instead (`path` is
 * then that absolute path, defaulting to `/`) — Radarr/Sonarr's Manual Import isn't limited to one
 * configured folder either, and an admin already has this same level of filesystem access via the
 * root-folder picker's own unrestricted browse-directory endpoint.
 */
importRouter.get(
  "/browse",
  asyncHandler(async (req, res) => {
    const anyFolder = req.query.anyFolder === "1";
    const requestedPath = (req.query.path as string | undefined) ?? "";
    const target = anyFolder ? path.resolve(requestedPath || "/") : resolveInDownloads(requestedPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      throw new HttpError(404, "Directory not found");
    }

    // Relative to downloadsDir and always "/"-separated, whatever the host's own separator: the pages
    // split it on "/" to go up a level.
    const relativePath = anyFolder ? null : path.relative(path.resolve(config.downloadsDir), target).split(path.sep).join("/");

    const listing = entries
      .map((entry) => {
        // In anyFolder mode every entry's path is absolute (so it can be browsed/imported directly
        // with no separate root to remember); in the default mode it stays relative to downloadsDir.
        const entryPath = anyFolder ? path.join(target, entry.name) : relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const full = path.join(target, entry.name);
        const isMediaFile = entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
        const isNfoFile = entry.isFile() && path.extname(entry.name).toLowerCase() === ".nfo";
        return {
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
          isMediaFile,
          isNfoFile,
          size: entry.isFile() ? fs.statSync(full).size : null,
        };
      })
      .filter((e) => e.isDirectory || e.isMediaFile || e.isNfoFile)
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

    let parent: string | null;
    if (anyFolder) parent = path.dirname(target) === target ? null : path.dirname(target);
    else parent = relativePath ? (relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "") : null;
    res.json({ path: anyFolder ? target : relativePath, anyFolder, parent, entries: listing });
  })
);

/**
 * POST /api/import/ai-identify — best-effort AI-assisted identification for a file whose name
 * alone didn't match confidently (see services/aiIdentify.ts). Body: { sourcePath, mediaType,
 * providerId? }. Returns a text guess for a human to read and act on — never applies anything on
 * its own.
 */
importRouter.post(
  "/ai-identify",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.sourcePath) throw new HttpError(400, "sourcePath is required");
    const sourceFile = resolveImportSource(b.sourcePath);
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
      throw new HttpError(404, "Source file not found");
    }
    try {
      const result = await identifyMediaFile(sourceFile, b.mediaType ?? "movie", b.providerId ?? null);
      res.json(result);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
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

/** POST /api/import/manual — assign a specific file (downloads-dir-relative, or an absolute path
 * anywhere the container can see) to a media item/episode/sub-item. */
importRouter.post(
  "/manual",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.mediaItemId || !b.sourcePath) {
      throw new HttpError(400, "mediaItemId and sourcePath are required");
    }

    const sourceFile = resolveImportSource(b.sourcePath);
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

/**
 * POST /api/import/manual-batch — Sonarr-style "import several files at once," each mapped to
 * its own target episode/sub-item. Body: { mediaItemId, files: [{ sourcePath, episodeId?,
 * subItemId?, quality? }] }. Each file is placed independently (one bad file — already imported
 * elsewhere, unreadable, no matching episode — doesn't abort the rest of the batch); the response
 * reports per-file success/failure so the UI can show exactly which ones landed.
 */
importRouter.post(
  "/manual-batch",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.mediaItemId || !Array.isArray(b.files) || b.files.length === 0) {
      throw new HttpError(400, "mediaItemId and a non-empty files array are required");
    }

    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(b.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);
    const shape = effectiveShape(item);
    // An album or audiobook takes many files; every other target takes one.
    const manyFilesPerChild = shape === "collection" && !!getMediaTypeConfig(item.type).multiFilePerChild;
    const targetOf = (f: { episodeId?: unknown; subItemId?: unknown }): string | null => {
      if (shape === "single") return "item";
      if (f.episodeId) return `episode:${Number(f.episodeId)}`;
      if (f.subItemId && !manyFilesPerChild) return `sub:${Number(f.subItemId)}`;
      return null;
    };
    const mappedTargets = new Set<string>();
    // Shared by every file of this request, so the importer refuses a later file for a row an
    // earlier one already filled (a sample checked alongside its episode, two picks for one track).
    const batchClaims = new Set<string>();

    const results: { sourcePath: string; ok: boolean; destPath?: string; fileLabel?: string; error?: string }[] = [];
    for (const f of b.files) {
      const sourcePath = f?.sourcePath;
      if (!sourcePath) {
        results.push({ sourcePath: String(sourcePath ?? ""), ok: false, error: "sourcePath is required" });
        continue;
      }
      try {
        const sourceFile = resolveImportSource(sourcePath);
        if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
          throw new Error("Source file not found");
        }
        // Refused even when the earlier file then fails to import: its sample must not land in its place.
        const target = targetOf(f);
        if (target && mappedTargets.has(target)) throw new Error("Another file in this import is already mapped to that target");
        if (target) mappedTargets.add(target);
        const quality = f.quality ?? parseReleaseTitle(path.basename(sourceFile)).quality;
        const result = await placeFile({
          itemId: b.mediaItemId,
          episodeId: f.episodeId ?? null,
          subItemId: f.subItemId ?? null,
          sourceFile,
          quality,
          batchClaims,
        });
        results.push({ sourcePath, ok: true, ...result });
      } catch (err) {
        results.push({ sourcePath, ok: false, error: (err as Error).message });
      }
    }

    res.json({ results });
  })
);
