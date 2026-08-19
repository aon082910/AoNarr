import { Router } from "express";
import multer from "multer";
import { db } from "../db/client.js";
import { episodeFromRow, mediaItemFromRow, queueItemFromRow, subItemFromRow, tagFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { getMediaTypeConfig, isValidMediaType } from "../services/mediaTypes.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { autoSelectRootFolderId } from "../services/rootFolderSelect.js";
import { CONTENT_RATING_ORDER, isRatingBlocked } from "../services/contentRatings.js";
import { fetchCastFor, searchMetadata } from "../services/metadata.js";
import { notifyGrabbed } from "../services/notifications.js";
import type { MediaType } from "../types/index.js";

export const mediaRouter = Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Restricted users only see the library types an admin has granted them; admins see everything. */
function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

function getTagsForMediaItem(mediaItemId: number) {
  const rows = db
    .prepare(
      `SELECT t.* FROM tags t
       JOIN media_item_tags mit ON mit.tag_id = t.id
       WHERE mit.media_item_id = ?
       ORDER BY t.name`
    )
    .all(mediaItemId) as any[];
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
    const update = db.prepare("UPDATE media_items SET monitored = ? WHERE id = ?");
    const run = db.transaction((ids: number[]) => {
      for (const id of ids) update.run(monitored ? 1 : 0, id);
    });
    run(mediaItemIds);
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
    const insert = db.prepare("INSERT OR IGNORE INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)");
    const run = db.transaction((ids: number[]) => {
      for (const id of ids) insert.run(id, tagId);
    });
    run(mediaItemIds);
    res.json({ tagged: mediaItemIds.length });
  })
);

mediaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, tagId, groupId } = req.query as { type?: MediaType; tagId?: string; groupId?: string };
    const allowedTypes = allowedTypesFor(req);
    if (allowedTypes && type && !allowedTypes.includes(type)) {
      res.json([]);
      return;
    }

    let rows: any[];
    if (tagId) {
      rows = db
        .prepare(
          `SELECT m.* FROM media_items m
           JOIN media_item_tags mit ON mit.media_item_id = m.id
           WHERE mit.tag_id = ? ${type ? "AND m.type = ?" : ""}
           ORDER BY m.sort_title`
        )
        .all(...(type ? [tagId, type] : [tagId]));
    } else if (groupId === "none" && type) {
      rows = db.prepare("SELECT * FROM media_items WHERE type = ? AND group_id IS NULL ORDER BY sort_title").all(type);
    } else if (groupId) {
      rows = db.prepare("SELECT * FROM media_items WHERE group_id = ? ORDER BY sort_title").all(groupId);
    } else if (type) {
      rows = db.prepare("SELECT * FROM media_items WHERE type = ? ORDER BY sort_title").all(type);
    } else {
      rows = db.prepare("SELECT * FROM media_items ORDER BY sort_title").all();
    }

    if (allowedTypes) {
      rows = rows.filter((r) => allowedTypes.includes(r.type));
    }
    if (req.auth?.user?.maxContentRating) {
      rows = rows.filter((r) => !isRatingBlocked(r.content_rating, req.auth!.user!.maxContentRating));
    }

    res.json(rows.map(mediaItemFromRow));
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
      ? (db.prepare("SELECT * FROM media_items WHERE type = ? ORDER BY sort_title").all(type) as any[])
      : (db.prepare("SELECT * FROM media_items ORDER BY type, sort_title").all() as any[]);
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
      if (!id || !db.prepare("SELECT id FROM media_items WHERE id = ?").get(id)) {
        skipped++;
        continue;
      }
      const monitored = monitoredIdx !== -1 && row[monitoredIdx] !== "" ? Number(row[monitoredIdx]) : null;
      const qualityProfileId = qualityProfileIdx !== -1 && row[qualityProfileIdx] !== "" ? Number(row[qualityProfileIdx]) : null;
      update.run(monitored, qualityProfileId, id);
      updated++;
    }

    res.json({ updated, skipped });
  })
);

mediaRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
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
      children = (db
        .prepare("SELECT * FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
        .all(item.id) as any[]).map(episodeFromRow);
    } else if (shape === "collection") {
      children = (db
        .prepare("SELECT * FROM sub_items WHERE media_item_id = ? ORDER BY release_date")
        .all(item.id) as any[]).map(subItemFromRow);
    }

    res.json({ ...item, children, tags: getTagsForMediaItem(item.id) });
  })
);

/** Cast list (movies/series only, needs a TMDB id) for the media detail page's Cast section. */
mediaRouter.get(
  "/:id/cast",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
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
 * Pulls a second (or third...) opinion from another configured metadata provider for this item's
 * type, without touching the item's primary title/overview/poster — stored separately in
 * extra_metadata keyed by provider so the admin can compare sources before deciding (via the
 * ordinary PATCH endpoint) whether to promote one's overview/poster to primary. Matches by title
 * search rather than a shared external id, since providers rarely share id schemes.
 */
mediaRouter.post(
  "/:id/metadata/fetch",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
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
    db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify(extra), req.params.id);

    const updated = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(updated));
  })
);

mediaRouter.post(
  "/:id/tags",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tagId = req.body?.tagId;
    if (!tagId) throw new HttpError(400, "tagId is required");
    db.prepare("INSERT OR IGNORE INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(
      req.params.id,
      tagId
    );
    res.status(201).json(getTagsForMediaItem(Number(req.params.id)));
  })
);

mediaRouter.delete(
  "/:id/tags/:tagId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    db.prepare("DELETE FROM media_item_tags WHERE media_item_id = ? AND tag_id = ?").run(
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
      const duplicates = findPossibleDuplicates(b.type, b.title, b.year ?? null);
      if (duplicates.length > 0) {
        res.status(409).json({ duplicates });
        return;
      }
    }

    const result = db
      .prepare(
        `INSERT INTO media_items
         (type, title, sort_title, year, overview, poster_url, external_ids, path, root_folder_id, quality_profile_id, monitored, status, group_id)
         VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @path, @rootFolderId, @qualityProfileId, @monitored, @status, @groupId)`
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
        rootFolderId: b.rootFolderId ?? autoSelectRootFolderId(b.type),
        qualityProfileId: b.qualityProfileId ?? null,
        monitored: b.monitored ?? 1,
        status: b.status ?? "unknown",
        groupId: b.groupId ?? null,
      });

    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(mediaItemFromRow(row));
  })
);

mediaRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Media item not found");

    const b = req.body ?? {};
    if (b.contentRating !== undefined && b.contentRating !== null && !CONTENT_RATING_ORDER.includes(b.contentRating)) {
      throw new HttpError(400, `Unknown content rating "${b.contentRating}"`);
    }
    const fields: Record<string, unknown> = {
      title: b.title,
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
      db.prepare(`UPDATE media_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
    res.json(mediaItemFromRow(row));
  })
);

mediaRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM media_items WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Media item not found");
    res.status(204).send();
  })
);

// Episodes (series)
mediaRouter.post(
  "/:id/episodes",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const result = db
      .prepare(
        `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(req.params.id, b.seasonNumber, b.episodeNumber, b.title ?? null, b.airDate ?? null, b.monitored ?? 1);
    const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(episodeFromRow(row));
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
    if (sets.length > 0) {
      values.push(req.params.episodeId);
      db.prepare(`UPDATE episodes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(req.params.episodeId);
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
    const result = db
      .prepare("UPDATE episodes SET monitored = ? WHERE media_item_id = ? AND season_number = ?")
      .run(monitored, req.params.id, req.params.seasonNumber);
    if (result.changes === 0) throw new HttpError(404, "No episodes found for that season");
    const rows = db
      .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ? ORDER BY episode_number")
      .all(req.params.id, req.params.seasonNumber);
    res.json(rows.map(episodeFromRow));
  })
);

// Sub-items (albums / books)
mediaRouter.post(
  "/:id/subitems",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title) throw new HttpError(400, "title is required");
    const result = db
      .prepare(
        `INSERT INTO sub_items (media_item_id, title, release_date, monitored)
         VALUES (?, ?, ?, ?)`
      )
      .run(req.params.id, b.title, b.releaseDate ?? null, b.monitored ?? 1);
    const row = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(result.lastInsertRowid);
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
    const sub = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(req.params.subItemId) as any;
    if (!sub) throw new HttpError(404, "Sub-item not found");
    if (!sub.external_id) throw new HttpError(400, "This item has no source video id to download from");

    const mediaItem = db.prepare("SELECT * FROM media_items WHERE id = ?").get(sub.media_item_id) as any;
    if (!mediaItem) throw new HttpError(404, "Media item not found");

    const clientRow = db.prepare("SELECT * FROM download_clients WHERE type = 'ytdlp' AND enabled = 1 LIMIT 1").get();
    if (!clientRow) throw new HttpError(400, "No enabled yt-dlp download client configured — add one in Download Clients");
    const client = clientRow as any;

    const sourceUrl =
      sub.external_provider === "youtube"
        ? `https://www.youtube.com/watch?v=${sub.external_id}`
        : sub.external_id;

    const adapter = getDownloadClientAdapter(client.type);
    const grab = await adapter.addDownload(client, sourceUrl, client.category, sub.title);

    const result = db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
         VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
      )
      .run(sub.media_item_id, sub.id, sub.title, client.id, grab.downloadId);

    db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      sub.media_item_id,
      JSON.stringify({ title: sub.title, source: sourceUrl })
    );
    notifyGrabbed(mediaItem.title, sub.title).catch((err) => console.warn("[media] notification failed:", err.message));

    const queueRow = db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid);
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
    if (sets.length > 0) {
      values.push(req.params.subItemId);
      db.prepare(`UPDATE sub_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(req.params.subItemId);
    if (!row) throw new HttpError(404, "Sub-item not found");
    res.json(subItemFromRow(row));
  })
);
