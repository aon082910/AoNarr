import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { log } from "../services/logger.js";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { episodeFromRow, mediaItemFromRow, queueItemFromRow, subItemFromRow, tagFromRow, trackFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { getMediaTypeConfig, isProbeableFile, isValidMediaType } from "../services/mediaTypes.js";
import { attachChildCounts } from "../services/childCounts.js";
import { notifyQueueChanged } from "../services/realtime.js";
import { buildMediaQuery, clampLimit, clampOffset, MEDIA_SORT_COLUMNS } from "../services/mediaQuery.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { autoSelectRootFolderId } from "../services/rootFolderSelect.js";
import { CONTENT_RATING_ORDER, isRatingBlocked } from "../services/contentRatings.js";
import { fetchCastFor, fetchTmdbCollectionFor, fetchTrailerFor, searchMetadata } from "../services/metadata.js";
import { pushWatchState } from "../services/mediaServer.js";
import {
  scanAndImportLibrary,
  scanAndImportOneMediaItem,
  refreshLibraryMetadata,
  refreshOneMediaItem,
  logScanResult,
} from "../services/libraryScan.js";
import { notifyGrabbed } from "../services/notifications.js";
import { recycleFile } from "../services/recycleBin.js";
import {
  buildCalibreOpf,
  buildJson,
  buildNfo,
  buildPlexMatch,
  fetchPosterBuffer,
  safeFileName,
  writeNfoSidecar,
  type ExportableItem,
} from "../services/metadataExport.js";
import { probeMediaInfo } from "../services/ffprobe.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { getSetting } from "../services/settingsStore.js";
import { renameLibraryFiles, renameOneMediaItem } from "../services/importer.js";
import { extractIsbnFromBookFile, fetchBookByIsbn } from "../services/bookIsbnScan.js";
import { sendEmailWithAttachment } from "../services/smtp.js";
import { convertSubItemToM4b } from "../services/audiobookConvert.js";
import { CONTENT_TYPES } from "../services/rangeStream.js";
import AdmZip from "adm-zip";
import type { MediaType } from "../types/index.js";

export const mediaRouter = Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Restricted users only see the library types an admin has granted them; admins see everything. */
function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

async function getTagsForMediaItem(mediaItemId: number) {
  const rows = (await db
    .prepare(
      `SELECT t.* FROM tags t
       JOIN media_item_tags mit ON mit.tag_id = t.id
       WHERE mit.media_item_id = ?
       ORDER BY t.name`
    )
    .all(mediaItemId)) as any[];
  return rows.map(tagFromRow);
}

mediaRouter.post(
  "/bulk/monitor",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { mediaItemIds, monitored } = req.body ?? {};
    if (!Array.isArray(mediaItemIds) || mediaItemIds.length === 0) {
      throw new HttpError(400, "mediaItemIds is required");
    }
    await db.transaction(async () => {
      const update = db.prepare("UPDATE media_items SET monitored = ? WHERE id = ?");
      for (const id of mediaItemIds) await update.run(monitored ? 1 : 0, id);
    });
    res.json({ updated: mediaItemIds.length });
  })
);

mediaRouter.post(
  "/bulk/tag",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { mediaItemIds, tagId } = req.body ?? {};
    if (!Array.isArray(mediaItemIds) || mediaItemIds.length === 0 || !tagId) {
      throw new HttpError(400, "mediaItemIds and tagId are required");
    }
    const insertSql =
      db.dialect === "postgres"
        ? "INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        : "INSERT OR IGNORE INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)";
    await db.transaction(async () => {
      const insert = db.prepare(insertSql);
      for (const id of mediaItemIds) await insert.run(id, tagId);
    });
    res.json({ tagged: mediaItemIds.length });
  })
);

/** Bulk remove — the multi-select toolbar's "Remove" action. Same untrack-only-by-default /
 * ?deleteFiles=1-to-also-recycle-files behavior as the single-item DELETE /:id route below, just
 * looped over a whole selection; a missing/already-deleted id is skipped rather than failing the
 * whole batch, since a stale selection (another admin deleted it moments earlier) shouldn't block
 * removing the rest. */
mediaRouter.post(
  "/bulk/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { mediaItemIds, deleteFiles } = req.body ?? {};
    if (!Array.isArray(mediaItemIds) || mediaItemIds.length === 0) {
      throw new HttpError(400, "mediaItemIds is required");
    }

    let deleted = 0;
    for (const id of mediaItemIds) {
      const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;
      if (!row) continue;

      if (deleteFiles) {
        if (row.path) await recycleFile(row.path, row.type, row.title, row.id);
        const children = (
          (await db.prepare("SELECT file_path FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL").all(row.id)) as any[]
        ).concat(
          (await db.prepare("SELECT file_path FROM sub_items WHERE media_item_id = ? AND file_path IS NOT NULL").all(row.id)) as any[]
        );
        for (const child of children) await recycleFile(child.file_path, row.type, row.title, row.id);
      }

      await db.prepare("DELETE FROM media_items WHERE id = ?").run(id);
      deleted++;
    }

    if (deleted > 0) {
      const actor = auditActor(req);
      logAuditEvent(actor.userId, actor.username, "media_deleted", `${deleted} item(s) via bulk remove${deleteFiles ? " — files recycled" : ""}`);
    }
    res.json({ deleted, skipped: mediaItemIds.length - deleted });
  })
);

/**
 * Server-side paginated/sorted/filtered list — the main Library page fetch. Returns
 * `{ items, total }` rather than a bare array so the page can show real pagination controls and
 * accurate counts without ever pulling a whole (possibly thousands-of-items) library type into the
 * browser just to filter/sort/paginate it client-side.
 */
mediaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, tagId, groupId, sort, status, contentRating } = req.query as {
      type?: MediaType;
      tagId?: string;
      groupId?: string;
      sort?: string;
      status?: string;
      contentRating?: string;
    };
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && type && !allowedTypes.includes(type)) {
      res.json({ items: [], total: 0 });
      return;
    }

    const { where, params, fromClause } = buildMediaQuery({
      type,
      tagId,
      groupId,
      status,
      contentRating,
      allowedTypes,
      maxContentRating: req.auth?.user?.maxContentRating,
    });
    if (where === null) {
      res.json({ items: [], total: 0 });
      return;
    }

    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const orderBy = MEDIA_SORT_COLUMNS[sort ?? "added"] ?? MEDIA_SORT_COLUMNS.added;

    const countRow = (await db.prepare(`SELECT COUNT(*) AS total FROM ${fromClause} WHERE ${where}`).get(...params)) as {
      total: number | string;
    };
    const rows = (await db
      .prepare(`SELECT m.* FROM ${fromClause} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)) as any[];

    const items = rows.map(mediaItemFromRow);
    await attachChildCounts(items);
    res.json({ items, total: Number(countRow.total) });
  })
);

/**
 * Structural-scope aggregate stats (total/have/missing item counts, child-level episode/album
 * download totals, and the set of content ratings present) for the Library page's header badges —
 * independent of the current page/sort/status-filter so they stay correct no matter which page of
 * a paginated library the user is looking at. Deliberately NOT scoped by `status`/`contentRating`
 * (those are per-view filters) to match the pre-pagination behavior, where the header always
 * summed the type's full unfiltered item set. Registered before "/:id" for the same reason
 * export.csv/export-bulk.zip are.
 */
mediaRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const { type, tagId, groupId } = req.query as { type?: MediaType; tagId?: string; groupId?: string };
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && type && !allowedTypes.includes(type)) {
      res.json({ total: 0, haveCount: 0, missingCount: 0, childCount: 0, childHaveCount: 0, contentRatings: [] });
      return;
    }

    const { where, params, fromClause } = buildMediaQuery({
      type,
      tagId,
      groupId,
      allowedTypes,
      maxContentRating: req.auth?.user?.maxContentRating,
    });
    if (where === null) {
      res.json({ total: 0, haveCount: 0, missingCount: 0, childCount: 0, childHaveCount: 0, contentRatings: [] });
      return;
    }

    const totalsRow = (await db
      .prepare(`SELECT COUNT(*) AS total, SUM(m.has_file) AS have FROM ${fromClause} WHERE ${where}`)
      .get(...params)) as { total: number | string; have: number | string | null };
    const ratingRows = (await db
      .prepare(`SELECT DISTINCT m.content_rating AS rating FROM ${fromClause} WHERE ${where} AND m.content_rating IS NOT NULL ORDER BY m.content_rating`)
      .all(...params)) as { rating: string }[];

    let childCount = 0;
    let childHaveCount = 0;
    if (type) {
      const shape = getMediaTypeConfig(type).shape;
      if (shape === "episodic" || shape === "collection") {
        const table = shape === "episodic" ? "episodes" : "sub_items";
        const childRow = (await db
          .prepare(
            `SELECT COUNT(*) AS total, SUM(c.has_file) AS have FROM ${table} c
             WHERE c.media_item_id IN (SELECT m.id FROM ${fromClause} WHERE ${where})`
          )
          .get(...params)) as { total: number | string; have: number | string | null };
        childCount = Number(childRow?.total ?? 0);
        childHaveCount = Number(childRow?.have ?? 0);
      }
    }

    res.json({
      total: Number(totalsRow.total),
      haveCount: Number(totalsRow.have ?? 0),
      missingCount: Number(totalsRow.total) - Number(totalsRow.have ?? 0),
      childCount,
      childHaveCount,
      contentRatings: ratingRows.map((r) => r.rating),
    });
  })
);

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped `""`, embedded commas/newlines) — no
 * external dependency needed for the handful of columns this bulk-edit endpoint round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** GET /api/media/export.csv — a flat CSV of the whole library (or one type), for spreadsheet
 * tracking/archival outside the app. Registered before "/:id" so it isn't shadowed by that route. */
mediaRouter.get(
  "/export.csv",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { type } = req.query as { type?: MediaType };
    const rows = type
      ? ((await db.prepare("SELECT * FROM media_items WHERE type = ? ORDER BY sort_title").all(type)) as any[])
      : ((await db.prepare("SELECT * FROM media_items ORDER BY type, sort_title").all()) as any[]);
    const items = rows.map(mediaItemFromRow);

    const header = ["id", "type", "title", "year", "monitored", "qualityProfileId", "hasFile", "quality", "status", "path"];
    const lines = [header.join(",")];
    for (const item of items) {
      lines.push(
        header
          .map((key) => csvEscape((item as any)[key]))
          .join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="aonarr-library${type ? `-${type}` : ""}.csv"`);
    res.send(lines.join("\n"));
  })
);

/**
 * POST /api/media/bulk-import.csv — the inverse of export.csv: upload an edited version of that
 * same file to bulk-update `monitored`/`qualityProfileId` across many items at once by `id`.
 * Every other column is ignored (title/type/etc. aren't editable this way, only the two fields
 * that make sense to batch-edit from a spreadsheet). Registered before "/:id" for the same reason
 * export.csv is. Rows with an unrecognized `id` are skipped and counted, not treated as an error
 * for the whole upload.
 */
mediaRouter.post(
  "/bulk-import.csv",
  requireAdmin,
  csvUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "file is required (multipart form field \"file\")");
    const rows = parseCsv(req.file.buffer.toString("utf-8"));
    if (rows.length === 0) throw new HttpError(400, "CSV file is empty");

    const header = rows[0].map((h) => h.trim());
    const idIdx = header.indexOf("id");
    const monitoredIdx = header.indexOf("monitored");
    const qualityProfileIdx = header.indexOf("qualityProfileId");
    if (idIdx === -1) throw new HttpError(400, 'CSV must have an "id" column');

    let updated = 0;
    let skipped = 0;
    const update = db.prepare("UPDATE media_items SET monitored = COALESCE(?, monitored), quality_profile_id = COALESCE(?, quality_profile_id) WHERE id = ?");

    for (const row of rows.slice(1)) {
      const id = Number(row[idIdx]);
      if (!id || !(await db.prepare("SELECT id FROM media_items WHERE id = ?").get(id))) {
        skipped++;
        continue;
      }
      const monitored = monitoredIdx !== -1 && row[monitoredIdx] !== "" ? Number(row[monitoredIdx]) : null;
      const qualityProfileId = qualityProfileIdx !== -1 && row[qualityProfileIdx] !== "" ? Number(row[qualityProfileIdx]) : null;
      await update.run(monitored, qualityProfileId, id);
      updated++;
    }

    res.json({ updated, skipped });
  })
);

/**
 * Scans a library type's root folder(s) for files not already tracked and imports them — matches
 * an existing "missing" item by filename-guessed title where possible, else creates a new item
 * outright. Same underlying function the scheduled "Library Scan & Import" job runs for every
 * type; this is the per-library, on-demand version for the button on each Library page.
 *
 * Fire-and-forget rather than awaited: this probes every matched/created file with ffprobe (up to
 * a 30s timeout each — see services/ffprobe.ts), so a library with even a handful of slow or
 * unreadable files can easily take the whole request past any reasonable HTTP/gateway timeout,
 * surfacing as a 504 to the browser even though the scan itself is still working fine in the
 * background. Same pattern services/jobRegistry.ts's runJobNow already uses for exactly this
 * reason — the result is logged (visible on the Logs page) rather than returned in the response.
 */
mediaRouter.post(
  "/scan-import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (!type || !isValidMediaType(type)) throw new HttpError(400, "A valid type is required");
    scanAndImportLibrary(type)
      .then((result) => {
        if (result.unsupported) {
          log.info(`[scan-import] "${type}": ${result.unsupported}`);
        } else {
          logScanResult(type, result);
        }
      })
      .catch((err) => log.warn(`[scan-import] "${type}" failed:`, (err as Error).message));
    res.json({ started: true });
  })
);

/** Re-pulls overview/poster/year for every item of a type from its metadata provider. Same
 * underlying function the scheduled "Library Refresh" job runs for every type; this is the
 * per-library, on-demand version for the button on each Library page. Fire-and-forget for the
 * same reason as scan-import above — one metadata-provider request per item adds up. */
mediaRouter.post(
  "/refresh",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (!type || !isValidMediaType(type)) throw new HttpError(400, "A valid type is required");
    refreshLibraryMetadata(type)
      .then((result) =>
        log.info(`[refresh] "${type}": updated ${result.updated}, failed ${result.failed}, episodes/children added ${result.childrenAdded}`)
      )
      .catch((err) => log.warn(`[refresh] "${type}" failed:`, (err as Error).message));
    res.json({ started: true });
  })
);

/** Per-item versions of the two buttons above — scoped to just this media item's own folder/title
 * instead of the whole library, same as Radarr/Sonarr's own per-item "Search"/"Refresh" actions.
 * Awaited rather than fire-and-forget: a single item is fast enough not to risk a gateway timeout,
 * and the caller (the media page) wants to know the actual result to show/refresh immediately. */
mediaRouter.post(
  "/:id/scan-import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const result = await scanAndImportOneMediaItem(Number(req.params.id));
    res.json(result);
  })
);

mediaRouter.post(
  "/:id/refresh",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const result = await refreshOneMediaItem(Number(req.params.id));
    res.json(result);
  })
);

/** Bulk metadata export: a .zip of one file per item, scoped by ?type=. Registered before the
 * "/:id" route below so "export-bulk.zip" isn't swallowed as an :id value. */
mediaRouter.get(
  "/export-bulk.zip",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { type, format } = req.query as { type?: string; format?: string };
    if (!type) throw new HttpError(400, "type is required");
    const fmt = format === "json" ? "json" : format === "plexmatch" ? "plexmatch" : "nfo";

    const rows = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
    const zip = new AdmZip();
    for (const row of rows) {
      const item = toExportable(row);
      if (fmt === "plexmatch") {
        // Must be named exactly ".plexmatch" inside the item's own folder — never per-title-named
        // like .nfo/.json, since that's not a filename Plex looks for.
        zip.addFile(`${safeFileName(item.title)}/.plexmatch`, Buffer.from(buildPlexMatch(item), "utf-8"));
        const poster = await fetchPosterBuffer(item.posterUrl);
        if (poster) zip.addFile(`${safeFileName(item.title)}/poster.jpg`, poster);
      } else {
        const body = fmt === "json" ? buildJson(item) : buildNfo(item);
        zip.addFile(`${safeFileName(item.title)}.${fmt}`, Buffer.from(body, "utf-8"));
        const poster = await fetchPosterBuffer(item.posterUrl);
        if (poster) zip.addFile(`${safeFileName(item.title)}-poster.jpg`, poster);
      }
    }
    res.setHeader("Content-Disposition", `attachment; filename="aonarr-${type}-metadata.zip"`);
    res.setHeader("Content-Type", "application/zip");
    res.send(zip.toBuffer());
  })
);

/** Calibre-compatible bulk export (.opf per item) — for the book-shaped libraries. Same
 * before-":id" registration note as above. */
mediaRouter.get(
  "/export-calibre.zip",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { type } = req.query as { type?: string };
    if (!type) throw new HttpError(400, "type is required");

    const rows = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(type)) as any[];
    const zip = new AdmZip();
    for (const row of rows) {
      const item = toExportable(row);
      zip.addFile(`${safeFileName(item.title)}/metadata.opf`, Buffer.from(buildCalibreOpf(item), "utf-8"));
      const cover = await fetchPosterBuffer(item.posterUrl);
      if (cover) zip.addFile(`${safeFileName(item.title)}/cover.jpg`, cover);
    }
    res.setHeader("Content-Disposition", `attachment; filename="aonarr-${type}-calibre.zip"`);
    res.setHeader("Content-Type", "application/zip");
    res.send(zip.toBuffer());
  })
);

mediaRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");

    const item = mediaItemFromRow(row);
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && !allowedTypes.includes(item.type)) {
      throw new HttpError(403, "You don't have access to this library");
    }
    if (req.auth?.user?.maxContentRating && isRatingBlocked(item.contentRating, req.auth.user.maxContentRating)) {
      throw new HttpError(403, "You don't have access to this item");
    }
    const shape = getMediaTypeConfig(item.type).shape;
    let children: unknown[] = [];
    if (shape === "episodic") {
      children = ((await db
        .prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
        .all(item.id)) as any[]).map(episodeFromRow);
    } else if (shape === "collection") {
      children = ((await db
        .prepare("SELECT * FROM sub_items WHERE media_item_id = ? ORDER BY release_date")
        .all(item.id)) as any[]).map(subItemFromRow);
    }

    res.json({ ...item, children, tags: await getTagsForMediaItem(item.id) });
  })
);

function toExportable(row: any): ExportableItem {
  let externalIds: Record<string, string> = {};
  try {
    externalIds = row.external_ids ? JSON.parse(row.external_ids) : {};
  } catch {
    // malformed external_ids on an old row — export without ids rather than fail the whole export
  }
  return {
    type: row.type,
    title: row.title,
    year: row.year,
    overview: row.overview,
    posterUrl: row.poster_url,
    externalIds,
  };
}

/** Individual metadata export — ?format=nfo (default, Kodi/Jellyfin/Emby-compatible sidecar,
 * round-trips through Add Media's "Load NFO"), ?format=json, or ?format=plexmatch (Plex's own
 * match-override file; unlike the other two, it must be renamed to exactly ".plexmatch" and
 * placed directly in the item's own folder for Plex to pick it up — the download itself is still
 * a single file since there's no other way to hand back one file over HTTP). */
mediaRouter.get(
  "/:id/export",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = toExportable(row);
    const format = req.query.format === "json" ? "json" : req.query.format === "plexmatch" ? "plexmatch" : "nfo";
    const body = format === "json" ? buildJson(item) : format === "plexmatch" ? buildPlexMatch(item) : buildNfo(item);
    const filename = format === "plexmatch" ? ".plexmatch" : `${safeFileName(item.title)}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", format === "json" ? "application/json" : "text/plain");
    res.send(body);
  })
);

/** Cast list (movies/series only, needs a TMDB id) for the media detail page's Cast section. */
mediaRouter.get(
  "/:id/cast",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(row);
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && !allowedTypes.includes(item.type)) {
      throw new HttpError(403, "You don't have access to this library");
    }

    const externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
    try {
      const cast = await fetchCastFor(item.type, externalIds);
      res.json(cast);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/**
 * A movie's TMDB franchise/collection (e.g. "The Lord of the Rings Collection"), if it belongs to
 * one, with each part cross-referenced against the library by TMDB id so the detail page can show
 * "already have it" vs offer a one-click add — the same add path Recommendations already uses.
 */
mediaRouter.get(
  "/:id/collection",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(row);
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && !allowedTypes.includes(item.type)) {
      throw new HttpError(403, "You don't have access to this library");
    }
    if (item.type !== "movie") throw new HttpError(400, "Collections are only available for movies");

    const externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
    let collection;
    try {
      collection = await fetchTmdbCollectionFor(externalIds);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (!collection) {
      res.json(null);
      return;
    }

    const libraryRows = (await db.prepare("SELECT id, title, external_ids FROM media_items WHERE type = 'movie'").all()) as any[];
    const byTmdbId = new Map<string, { id: number; title: string }>();
    for (const r of libraryRows) {
      const ids = r.external_ids ? JSON.parse(r.external_ids) : {};
      if (ids.tmdb) byTmdbId.set(String(ids.tmdb), { id: r.id, title: r.title });
    }

    res.json({
      ...collection,
      parts: collection.parts.map((p) => ({
        ...p,
        libraryItemId: byTmdbId.get(String(p.tmdbId))?.id ?? null,
      })),
    });
  })
);

/** Trailer link (movies/series/anime, needs a TMDB id and API key configured) for the media
 * detail page. Returns { url: null } rather than 404 when unavailable, since "no trailer" is a
 * normal outcome, not an error. */
mediaRouter.get(
  "/:id/trailer",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(row);
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && !allowedTypes.includes(item.type)) {
      throw new HttpError(403, "You don't have access to this library");
    }

    const externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
    const url = await fetchTrailerFor(item.type, externalIds).catch(() => null);
    res.json({ url });
  })
);

/**
 * Pulls a second (or third...) opinion from another configured metadata provider for this item's
 * type, without touching the item's primary title/overview/poster — stored separately in
 * extra_metadata keyed by provider so the admin can compare sources before deciding (via the
 * ordinary PATCH endpoint) whether to promote one's overview/poster to primary. Matches by title
 * search rather than a shared external id, since providers rarely share id schemes.
 */
/** On-demand corrupt-file check for a "single" shape item (movie/rom/adult) — the full library
 * scan lives in the scheduled Corrupt Media Check job; this is for checking just this one item
 * right now instead of waiting for the next scheduled run. */
mediaRouter.post(
  "/:id/check-corrupt",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Media item not found");
    if (!row.has_file || !row.path) {
      res.json({ corrupt: false, checked: false, reason: "No file on record for this item" });
      return;
    }

    if (!isProbeableFile(row.path)) {
      res.json({ corrupt: false, checked: false, reason: "This file type isn't something ffprobe can validate" });
      return;
    }

    const info = await probeMediaInfo(row.path);
    const looksLikeVideo = ["movie", "series", "anime", "video", "course", "adult"].includes(row.type);
    const corrupt = !info || (looksLikeVideo && !info.videoCodec);

    if (corrupt) {
      await recycleFile(row.path, row.type, `${row.title} (corrupt)`, row.id);
      await db.prepare("UPDATE media_items SET has_file = 0, path = NULL, quality = NULL WHERE id = ?").run(row.id);
    }
    res.json({ corrupt, checked: true });
  })
);

mediaRouter.post(
  "/:id/metadata/fetch",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(row);

    const provider = req.body?.provider;
    if (!provider) throw new HttpError(400, "provider is required");
    if (!getMediaTypeConfig(item.type).metadataProviders.includes(provider)) {
      throw new HttpError(400, `"${provider}" is not a metadata provider for "${item.type}"`);
    }

    const query = item.year ? `${item.title} ${item.year}` : item.title;
    const results = await searchMetadata(item.type, query, provider);
    const best = results[0];
    if (!best) throw new HttpError(404, `No "${provider}" result found for "${item.title}"`);

    const extra = { ...item.extraMetadata, [provider]: best };
    await db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify(extra), req.params.id);

    const updated = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(updated));
  })
);

mediaRouter.post(
  "/:id/tags",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tagId = req.body?.tagId;
    if (!tagId) throw new HttpError(400, "tagId is required");
    const insertSql =
      db.dialect === "postgres"
        ? "INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        : "INSERT OR IGNORE INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)";
    await db.prepare(insertSql).run(req.params.id, tagId);
    res.status(201).json(await getTagsForMediaItem(Number(req.params.id)));
  })
);

mediaRouter.delete(
  "/:id/tags/:tagId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM media_item_tags WHERE media_item_id = ? AND tag_id = ?").run(
      req.params.id,
      req.params.tagId
    );
    res.status(204).send();
  })
);

mediaRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) throw new HttpError(400, "type and title are required");
    if (!isValidMediaType(b.type)) throw new HttpError(400, `Unknown media type "${b.type}"`);

    if (!b.confirmDuplicate) {
      const duplicates = await findPossibleDuplicates(b.type, b.title, b.year ?? null);
      if (duplicates.length > 0) {
        res.status(409).json({ duplicates });
        return;
      }
    }

    const rootFolderId = b.rootFolderId ?? (await autoSelectRootFolderId(b.type));
    const result = await db
      .prepare(
        `INSERT INTO media_items
         (type, title, sort_title, year, overview, poster_url, external_ids, path, root_folder_id, quality_profile_id, monitored, status, group_id, release_date, minimum_availability, series_type)
         VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @path, @rootFolderId, @qualityProfileId, @monitored, @status, @groupId, @releaseDate, @minimumAvailability, @seriesType)`
      )
      .run({
        type: b.type,
        title: b.title,
        sortTitle: (b.sortTitle ?? b.title).toLowerCase(),
        year: b.year ?? null,
        overview: b.overview ?? null,
        posterUrl: b.posterUrl ?? null,
        externalIds: b.externalIds ? JSON.stringify(b.externalIds) : null,
        path: b.path ?? null,
        rootFolderId,
        qualityProfileId: b.qualityProfileId ?? null,
        monitored: b.monitored ?? 1,
        status: b.status ?? "unknown",
        groupId: b.groupId ?? null,
        releaseDate: b.releaseDate ?? null,
        minimumAvailability: b.minimumAvailability ?? getSetting("defaultMinimumAvailability") ?? "announced",
        seriesType: b.seriesType ?? null,
      });

    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(result.lastInsertRowid);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "media_added", `${b.title} (${b.type})`);
    res.status(201).json(mediaItemFromRow(row));
  })
);

/**
 * Bulk "Rename Files" — retroactively re-renames every already-imported file whose naming
 * template has changed since it was imported, across the whole library or one type at a time.
 * Optional `?type=` scopes it; omitting it runs across everything.
 */
mediaRouter.post(
  "/rename-files",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const type = typeof req.query.type === "string" ? (req.query.type as MediaType) : undefined;
    if (type && !isValidMediaType(type)) throw new HttpError(400, `Unknown media type "${type}"`);
    const result = await renameLibraryFiles(type);
    res.json(result);
  })
);

/** Per-item version of the bulk rename above, for the "Organize & Rename" button on a single
 * media page — scoped to just this item's own file(s) instead of a whole library. */
mediaRouter.post(
  "/:id/rename-files",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT id FROM media_items WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Media item not found");
    const result = await renameOneMediaItem(Number(req.params.id));
    res.json(result);
  })
);

mediaRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Media item not found");

    const b = req.body ?? {};
    if (b.contentRating !== undefined && b.contentRating !== null && !CONTENT_RATING_ORDER.includes(b.contentRating)) {
      throw new HttpError(400, `Unknown content rating "${b.contentRating}"`);
    }
    const fields: Record<string, unknown> = {
      title: b.title,
      year: b.year,
      overview: b.overview,
      poster_url: b.posterUrl,
      monitored: b.monitored,
      protected: b.protected,
      quality_profile_id: b.qualityProfileId,
      root_folder_id: b.rootFolderId,
      path: b.path,
      status: b.status,
      content_rating: b.contentRating,
      group_id: b.groupId,
      minimum_availability: b.minimumAvailability,
      series_type: b.seriesType,
      // Lets the "Apply merge" button (MediaDetail.tsx) clear the supplemental-provider scratch
      // data (usually to {}) once it's been folded into the item's own fields, so the merge table
      // doesn't keep showing stale fetched data forever after being applied.
      extra_metadata: b.extraMetadata !== undefined ? JSON.stringify(b.extraMetadata) : undefined,
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        values.push(val);
      }
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE media_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id)) as any;
    // Keeps a synced .nfo sidecar current when the actual metadata (not just monitored/protected/
    // etc.) changed and this is a single-file item with somewhere to put it — episodic/collection
    // parents don't have a `path` of their own (only their children do), so there's no single
    // sidecar location to write for those from here.
    const metadataFieldsChanged = ["title", "year", "overview", "posterUrl"].some((k) => b[k] !== undefined);
    if (metadataFieldsChanged && row.path) {
      let externalIds: Record<string, string> = {};
      try {
        externalIds = row.external_ids ? JSON.parse(row.external_ids) : {};
      } catch {
        // malformed external_ids on an old row — write the sidecar without unique ids rather than fail the edit
      }
      writeNfoSidecar(row.path, { type: row.type, title: row.title, year: row.year, overview: row.overview, posterUrl: row.poster_url, externalIds });
    }
    res.json(mediaItemFromRow(row));
  })
);

/**
 * Re-points an existing item at a different metadata match — Radarr/Sonarr-style "interactive
 * search," for when the original title guess (typically from a Scan & Import, or an old import
 * before a parser bug was fixed) was close enough to create the item but wrong enough that further
 * metadata lookups (the "Fetch from X" buttons, Library Refresh) can't find anything under it.
 * Overwrites title/year/overview/poster/externalIds with the chosen search result; deliberately
 * leaves episodes/sub-items alone rather than trying to reconcile them against the new match's own
 * season/episode list, since that's real data (file paths, has_file flags) that shouldn't be
 * silently discarded on a title fix.
 */
mediaRouter.post(
  "/:id/rematch",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Media item not found");

    const b = req.body ?? {};
    if (!b.title) throw new HttpError(400, "title is required");

    await db
      .prepare(
        "UPDATE media_items SET title = ?, sort_title = ?, year = ?, overview = ?, poster_url = ?, external_ids = ?, release_date = ? WHERE id = ?"
      )
      .run(
        b.title,
        b.title.toLowerCase(),
        b.year ?? null,
        b.overview ?? null,
        b.posterUrl ?? null,
        b.externalIds ? JSON.stringify(b.externalIds) : null,
        b.releaseDate ?? null,
        req.params.id
      );

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id)) as any;
    if (row.path) {
      writeNfoSidecar(row.path, {
        type: row.type,
        title: row.title,
        year: row.year,
        overview: row.overview,
        posterUrl: row.poster_url,
        externalIds: b.externalIds ?? {},
      });
    }
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "media_rematched", `"${(existing as any).title}" → "${b.title}"`);
    res.json(mediaItemFromRow(row));
  })
);

/**
 * Manual "mark watched"/"mark unwatched" — watch state normally only ever flows in from the
 * configured media server (the webhook, or the periodic fetchWatchedFiles poll behind
 * auto-archival); this is the other direction, for setting it from AoNarr itself and having it
 * reflected back on the media server too. The media-server push is best-effort: no media server
 * configured, or a path that doesn't resolve to anything there, still leaves AoNarr's own
 * watch_events row in place — that failure is reported in the response but doesn't roll it back.
 */
mediaRouter.get(
  "/:id/watch-state",
  asyncHandler(async (req, res) => {
    const row = (await db
      .prepare(
        "SELECT watched_at FROM watch_events WHERE media_item_id = ? AND episode_id IS NULL AND sub_item_id IS NULL ORDER BY watched_at DESC LIMIT 1"
      )
      .get(req.params.id)) as { watched_at: string } | undefined;
    res.json({ watched: !!row, watchedAt: row?.watched_at ?? null });
  })
);

mediaRouter.patch(
  "/:id/watch-state",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Media item not found");
    const watched = !!req.body?.watched;

    if (watched) {
      await db.prepare(`INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ${nowExpr(db)})`).run(row.id);
    } else {
      await db.prepare("DELETE FROM watch_events WHERE media_item_id = ? AND episode_id IS NULL AND sub_item_id IS NULL").run(row.id);
    }

    let mediaServerError: string | null = null;
    if (row.path) {
      try {
        await pushWatchState(row.path, watched);
      } catch (err) {
        mediaServerError = (err as Error).message;
      }
    }

    res.json({ watched, mediaServerError });
  })
);

/** Shared by the single-item DELETE route below and the root-folder cascade-delete option
 * (routes/rootFolders.ts) — same "untrack only by default, ?deleteFiles=1 also recycles the
 * file(s)" behavior either way. */
export async function deleteMediaItemCascade(row: any, deleteFiles: boolean): Promise<void> {
  if (deleteFiles) {
    if (row.path) await recycleFile(row.path, row.type, row.title, row.id);
    const children = (
      (await db.prepare("SELECT file_path FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL").all(row.id)) as any[]
    ).concat(
      (await db.prepare("SELECT file_path FROM sub_items WHERE media_item_id = ? AND file_path IS NOT NULL").all(row.id)) as any[]
    );
    for (const child of children) await recycleFile(child.file_path, row.type, row.title, row.id);
  }
  await db.prepare("DELETE FROM media_items WHERE id = ?").run(row.id);
}

mediaRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Media item not found");

    // Default behavior stays "untrack only, leave files on disk" — opt in with ?deleteFiles=1 to
    // also recycle the item's file(s) (CASCADE drops episodes/sub_items too, so their
    // file_paths need collecting before the row goes).
    await deleteMediaItemCascade(row, req.query.deleteFiles === "1");
    const actor = auditActor(req);
    logAuditEvent(
      actor.userId,
      actor.username,
      "media_deleted",
      `${row.title} (${row.type})${req.query.deleteFiles === "1" ? " — files recycled" : ""}`
    );
    res.status(204).send();
  })
);

// Episodes (series)
mediaRouter.post(
  "/:id/episodes",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const result = await db
      .prepare(
        `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(req.params.id, b.seasonNumber, b.episodeNumber, b.title ?? null, b.airDate ?? null, b.monitored ?? 1);
    const row = await db.prepare("SELECT * FROM episodes WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(episodeFromRow(row));
  })
);

/** Single episode's full data plus its parent show's title/type, for the episode detail page. */
mediaRouter.get(
  "/:id/episodes/:episodeId",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT * FROM episodes WHERE id = ? AND media_item_id = ?")
      .get(req.params.episodeId, req.params.id);
    if (!row) throw new HttpError(404, "Episode not found");
    const parentRow = (await db.prepare("SELECT id, title, type FROM media_items WHERE id = ?").get(req.params.id)) as any;
    res.json({ ...episodeFromRow(row), parent: parentRow ? { id: parentRow.id, title: parentRow.title, type: parentRow.type } : null });
  })
);

mediaRouter.patch(
  "/:id/episodes/:episodeId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.monitored !== undefined) {
      sets.push("monitored = ?");
      values.push(b.monitored);
    }
    if (b.hasFile !== undefined) {
      sets.push("has_file = ?");
      values.push(b.hasFile);
    }
    if (b.filePath !== undefined) {
      sets.push("file_path = ?");
      values.push(b.filePath);
    }
    if (b.quality !== undefined) {
      sets.push("quality = ?");
      values.push(b.quality);
    }
    if (sets.length > 0) {
      values.push(req.params.episodeId);
      await db.prepare(`UPDATE episodes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM episodes WHERE id = ?").get(req.params.episodeId);
    if (!row) throw new HttpError(404, "Episode not found");
    res.json(episodeFromRow(row));
  })
);

/** Monitor/unmonitor every episode in one season at once, instead of clicking through each one. */
mediaRouter.patch(
  "/:id/season/:seasonNumber/monitor",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const monitored = req.body?.monitored ? 1 : 0;
    const result = await db
      .prepare("UPDATE episodes SET monitored = ? WHERE media_item_id = ? AND season_number = ?")
      .run(monitored, req.params.id, req.params.seasonNumber);
    if (result.changes === 0) throw new HttpError(404, "No episodes found for that season");
    const rows = await db
      .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ? ORDER BY episode_number")
      .all(req.params.id, req.params.seasonNumber);
    res.json(rows.map(episodeFromRow));
  })
);

/** Single sub-item's full data plus its parent's title/type, for the album/book/issue detail page.
 * Also resolves "series" siblings — other sub_items tagged with the same series_name (admin-set,
 * no provider populates this today), regardless of which media_item/author they belong to, so a
 * series can span one author's own bibliography (the common case) or a shared-universe anthology
 * across different authors. The equivalent of Movies' TMDB Collection widget, one level down. */
mediaRouter.get(
  "/:id/subitems/:subItemId",
  asyncHandler(async (req, res) => {
    const row = (await db
      .prepare("SELECT * FROM sub_items WHERE id = ? AND media_item_id = ?")
      .get(req.params.subItemId, req.params.id)) as any;
    if (!row) throw new HttpError(404, "Sub-item not found");
    const parentRow = (await db.prepare("SELECT id, title, type FROM media_items WHERE id = ?").get(req.params.id)) as any;

    let series: any[] = [];
    if (row.series_name) {
      const siblingRows = (await db
        .prepare(
          `SELECT s.id, s.media_item_id, s.title, s.series_position, s.poster_url, s.has_file, m.title AS parent_title
           FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
           WHERE LOWER(s.series_name) = LOWER(?) AND s.id != ?
           ORDER BY s.series_position ASC, s.title ASC`
        )
        .all(row.series_name, row.id)) as any[];
      series = siblingRows.map((s) => ({
        id: s.id,
        mediaItemId: s.media_item_id,
        title: s.title,
        seriesPosition: s.series_position,
        posterUrl: s.poster_url,
        hasFile: s.has_file,
        parentTitle: s.parent_title,
      }));
    }

    let byNarrator: any[] = [];
    if (row.narrator) {
      const narratorRows = (await db
        .prepare(
          `SELECT s.id, s.media_item_id, s.title, s.poster_url, s.has_file, m.title AS parent_title
           FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
           WHERE LOWER(s.narrator) = LOWER(?) AND s.id != ?
           ORDER BY s.title ASC`
        )
        .all(row.narrator, row.id)) as any[];
      byNarrator = narratorRows.map((s) => ({
        id: s.id,
        mediaItemId: s.media_item_id,
        title: s.title,
        posterUrl: s.poster_url,
        hasFile: s.has_file,
        parentTitle: s.parent_title,
      }));
    }

    res.json({
      ...subItemFromRow(row),
      parent: parentRow ? { id: parentRow.id, title: parentRow.title, type: parentRow.type } : null,
      series,
      byNarrator,
    });
  })
);

/**
 * Merges every downloaded track of an audiobook sub-item into one chapterized M4B via ffmpeg (see
 * services/audiobookConvert.ts) — replaces the individual track files/rows with a single merged
 * file + track row on success.
 */
mediaRouter.post(
  "/:id/subitems/:subItemId/convert-to-m4b",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ? AND media_item_id = ?").get(req.params.subItemId, req.params.id)) as any;
    if (!sub) throw new HttpError(404, "Sub-item not found");
    try {
      const result = await convertSubItemToM4b(Number(req.params.subItemId));
      res.json({ converted: true, path: result.path });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/** Single track's full data plus its parent album's and artist's title, for the track detail page. */
mediaRouter.get(
  "/:id/subitems/:subItemId/tracks/:trackId",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT * FROM tracks WHERE id = ? AND sub_item_id = ?")
      .get(req.params.trackId, req.params.subItemId);
    if (!row) throw new HttpError(404, "Track not found");
    const subItemRow = (await db
      .prepare("SELECT id, title FROM sub_items WHERE id = ? AND media_item_id = ?")
      .get(req.params.subItemId, req.params.id)) as any;
    if (!subItemRow) throw new HttpError(404, "Sub-item not found");
    const parentRow = (await db.prepare("SELECT id, title, type FROM media_items WHERE id = ?").get(req.params.id)) as any;
    res.json({
      ...trackFromRow(row),
      subItem: { id: subItemRow.id, title: subItemRow.title },
      parent: parentRow ? { id: parentRow.id, title: parentRow.title, type: parentRow.type } : null,
    });
  })
);

// Sub-items (albums / books)
mediaRouter.post(
  "/:id/subitems",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title) throw new HttpError(400, "title is required");
    const result = await db
      .prepare(
        `INSERT INTO sub_items (media_item_id, title, release_date, monitored)
         VALUES (?, ?, ?, ?)`
      )
      .run(req.params.id, b.title, b.releaseDate ?? null, b.monitored ?? 1);
    const row = await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(subItemFromRow(row));
  })
);

/**
 * Direct download for an Online Videos sub-item (e.g. a YouTube upload) — bypasses indexer
 * search entirely since these aren't found on Torznab/Newznab, and grabs straight from the
 * source URL via a configured "ytdlp" download client, going through the same queue/import
 * pipeline as any other grab.
 */
mediaRouter.post(
  "/subitems/:subItemId/download",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(req.params.subItemId)) as any;
    if (!sub) throw new HttpError(404, "Sub-item not found");
    if (!sub.external_id) throw new HttpError(400, "This item has no source video id to download from");

    const mediaItem = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(sub.media_item_id)) as any;
    if (!mediaItem) throw new HttpError(404, "Media item not found");

    const clientRow = await db.prepare("SELECT * FROM download_clients WHERE type = 'ytdlp' AND enabled = 1 LIMIT 1").get();
    if (!clientRow) throw new HttpError(400, "No enabled yt-dlp download client configured — add one in Download Clients");
    const client = clientRow as any;

    const sourceUrl =
      sub.external_provider === "youtube"
        ? `https://www.youtube.com/watch?v=${sub.external_id}`
        : sub.external_id;

    const adapter = getDownloadClientAdapter(client.type);
    const grab = await adapter.addDownload(client, sourceUrl, client.category, sub.title);

    const result = await db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
         VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
      )
      .run(sub.media_item_id, sub.id, sub.title, client.id, grab.downloadId);

    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      sub.media_item_id,
      JSON.stringify({ title: sub.title, source: sourceUrl })
    );
    notifyGrabbed(mediaItem.title, sub.title).catch((err) => log.warn("[media] notification failed:", err.message));
    notifyQueueChanged();

    const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(queueItemFromRow(queueRow));
  })
);

mediaRouter.patch(
  "/:id/subitems/:subItemId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.monitored !== undefined) {
      sets.push("monitored = ?");
      values.push(b.monitored);
    }
    if (b.hasFile !== undefined) {
      sets.push("has_file = ?");
      values.push(b.hasFile);
    }
    if (b.filePath !== undefined) {
      sets.push("file_path = ?");
      values.push(b.filePath);
    }
    if (b.quality !== undefined) {
      sets.push("quality = ?");
      values.push(b.quality);
    }
    if (b.posterUrl !== undefined) {
      sets.push("poster_url = ?");
      values.push(b.posterUrl);
    }
    if (b.seriesName !== undefined) {
      sets.push("series_name = ?");
      values.push(b.seriesName || null);
    }
    if (b.seriesPosition !== undefined) {
      sets.push("series_position = ?");
      values.push(b.seriesPosition === null || b.seriesPosition === "" ? null : Number(b.seriesPosition));
    }
    if (b.narrator !== undefined) {
      sets.push("narrator = ?");
      values.push(b.narrator || null);
    }
    if (sets.length > 0) {
      values.push(req.params.subItemId);
      await db.prepare(`UPDATE sub_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(req.params.subItemId);
    if (!row) throw new HttpError(404, "Sub-item not found");
    res.json(subItemFromRow(row));
  })
);

/**
 * Scans a downloaded book's own file for an ISBN (its first/last 15 pages for a PDF, its OPF
 * metadata for an EPUB — see bookIsbnScan.ts) and, if found, looks it up directly via Open
 * Library's ISBN endpoint and applies the match (title/release date/poster/external id) without a
 * separate confirmation step, the same trust level a subtitle's exact moviehash match gets — a
 * checksum-valid ISBN resolved through a direct key lookup isn't a fuzzy guess.
 */
mediaRouter.post(
  "/:id/subitems/:subItemId/scan-isbn",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ? AND media_item_id = ?").get(req.params.subItemId, req.params.id)) as any;
    if (!sub) throw new HttpError(404, "Sub-item not found");
    if (!sub.file_path) throw new HttpError(400, "This book has no downloaded file to scan yet");

    const isbn = await extractIsbnFromBookFile(sub.file_path);
    if (!isbn) {
      res.json({ found: false });
      return;
    }

    let match;
    try {
      match = await fetchBookByIsbn(isbn);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    if (!match) {
      res.json({ found: true, isbn, matched: false });
      return;
    }

    await db
      .prepare("UPDATE sub_items SET title = ?, release_date = ?, poster_url = ?, external_id = ?, external_provider = ? WHERE id = ?")
      .run(match.title, match.releaseDate, match.posterUrl, match.externalId, match.externalProvider, sub.id);

    const row = await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(sub.id);
    res.json({ found: true, isbn, matched: true, subItem: subItemFromRow(row) });
  })
);

// Amazon's own Send-to-Kindle attachment cap — reject up front rather than let the SMTP send fail
// partway through (or silently be dropped by the receiving side) on an oversized file.
const KINDLE_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Emails a sub-item's downloaded file to the configured Kindle "Send to Kindle" address as an
 * attachment, reusing the same SMTP settings the notification providers use (Settings →
 * Notifications) with `to` overridden to the Kindle address instead of `smtpTo`.
 */
mediaRouter.post(
  "/:id/subitems/:subItemId/send-to-kindle",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ? AND media_item_id = ?").get(req.params.subItemId, req.params.id)) as any;
    if (!sub) throw new HttpError(404, "Sub-item not found");
    if (!sub.file_path) throw new HttpError(400, "This item has no downloaded file to send yet");

    const kindleAddress = getSetting("kindleEmailAddress");
    if (!kindleAddress) throw new HttpError(400, "No Kindle email address set — add one in Settings → General");

    const smtpHost = getSetting("smtpHost");
    const smtpFrom = getSetting("smtpFrom");
    if (!smtpHost || !smtpFrom) throw new HttpError(400, "SMTP isn't configured — set it up in Settings → Notifications first");

    let stat: fs.Stats;
    try {
      stat = fs.statSync(sub.file_path);
    } catch {
      throw new HttpError(404, "File not found on disk");
    }
    if (stat.size > KINDLE_MAX_ATTACHMENT_BYTES) {
      throw new HttpError(400, `File is too large to email (${(stat.size / 1024 / 1024).toFixed(1)} MB, Kindle's limit is 50 MB)`);
    }

    const ext = path.extname(sub.file_path).toLowerCase();
    const filename = `${sub.title}${ext}`.replace(/[/\\]/g, "_");

    await sendEmailWithAttachment(
      {
        host: smtpHost,
        port: Number(getSetting("smtpPort") || 587),
        secure: getSetting("smtpSecure") === "1",
        username: getSetting("smtpUsername") || undefined,
        password: getSetting("smtpPassword") || undefined,
        from: smtpFrom,
        to: kindleAddress,
      },
      sub.title,
      `Sent from AoNarr: ${sub.title}`,
      { filename, content: fs.readFileSync(sub.file_path), contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" }
    );

    res.json({ sent: true });
  })
);
