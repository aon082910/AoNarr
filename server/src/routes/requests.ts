import fs from "node:fs";
import { Router } from "express";
import { db } from "../db/client.js";
import { mediaItemFromRow, requestFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { logAuditEvent } from "../services/audit.js";
import { sendPush } from "../services/push.js";

export const requestsRouter = Router();

/** Shared by the admin approve endpoint and auto-approval on submit — creates the real library
 * entry from a request row exactly the way adding media manually does. */
function approveRequestRow(request: any, rootFolderId: number | null, qualityProfileId: number | null): number {
  const mediaResult = db
    .prepare(
      `INSERT INTO media_items
       (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
       VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @rootFolderId, @qualityProfileId, 1, 'missing')`
    )
    .run({
      type: request.type,
      title: request.title,
      sortTitle: request.title.toLowerCase(),
      year: request.year,
      overview: request.overview,
      posterUrl: request.poster_url,
      externalIds: request.external_ids,
      rootFolderId,
      qualityProfileId,
    });

  const mediaItemId = Number(mediaResult.lastInsertRowid);
  db.prepare(
    "UPDATE requests SET status = 'approved', media_item_id = ?, resolved_at = datetime('now') WHERE id = ?"
  ).run(mediaItemId, request.id);
  return mediaItemId;
}

function fileSize(filePath: string | null): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Sums the on-disk size of everything under one media item (its own file for "single" shape, or
 * every downloaded episode/sub-item for "episodic"/"collection") — used to attribute storage
 * consumption back to the household user whose approved request created it. */
function mediaItemStorageBytes(mediaItemId: number): number {
  const item = db.prepare("SELECT path FROM media_items WHERE id = ?").get(mediaItemId) as { path: string | null } | undefined;
  let total = fileSize(item?.path ?? null);

  const episodes = db.prepare("SELECT file_path FROM episodes WHERE media_item_id = ? AND has_file = 1").all(mediaItemId) as {
    file_path: string | null;
  }[];
  for (const e of episodes) total += fileSize(e.file_path);

  const subItems = db
    .prepare("SELECT file_path FROM sub_items WHERE media_item_id = ? AND has_file = 1")
    .all(mediaItemId) as { file_path: string | null }[];
  for (const s of subItems) total += fileSize(s.file_path);

  return total;
}

/** Per-user request activity + storage attributable to their approved requests, for the admin
 * Users page. Storage is computed on demand by statting files (same files the library already
 * tracks paths for) rather than a maintained running total, so it never drifts out of sync. */
requestsRouter.get(
  "/stats",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const users = db.prepare("SELECT id, username FROM users WHERE role = 'user'").all() as {
      id: number;
      username: string;
    }[];

    const stats = users.map((user) => {
      const counts = db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM requests WHERE user_id = ? GROUP BY status`
        )
        .all(user.id) as { status: string; c: number }[];
      const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
      for (const row of counts) byStatus[row.status] = row.c;
      const total = byStatus.pending + byStatus.approved + byStatus.rejected;
      const resolved = byStatus.approved + byStatus.rejected;

      const approvedMediaItemIds = (
        db
          .prepare("SELECT media_item_id AS id FROM requests WHERE user_id = ? AND status = 'approved' AND media_item_id IS NOT NULL")
          .all(user.id) as { id: number }[]
      ).map((r) => r.id);
      const storageBytes = approvedMediaItemIds.reduce((sum, id) => sum + mediaItemStorageBytes(id), 0);

      return {
        userId: user.id,
        username: user.username,
        totalRequests: total,
        pending: byStatus.pending,
        approved: byStatus.approved,
        rejected: byStatus.rejected,
        approvalRatePercent: resolved > 0 ? Math.round((byStatus.approved / resolved) * 100) : null,
        storageBytes,
      };
    });

    res.json(stats);
  })
);

/**
 * Restricted users submit requests for media they don't have access to add directly; an admin
 * reviews the queue and approves (creating the real library entry) or rejects — unless the user
 * has auto-approve enabled, in which case submitting immediately creates the library entry.
 */
requestsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = req.auth?.isAdmin
      ? (db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all() as any[])
      : (db
          .prepare("SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC")
          .all(req.auth?.user?.id) as any[]);
    res.json(rows.map(requestFromRow));
  })
);

requestsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (req.auth?.isAdmin) throw new HttpError(400, "Admins add media directly instead of requesting it");
    const user = req.auth?.user;
    if (!user) throw new HttpError(401, "Not authenticated");
    const b = req.body ?? {};
    if (!b.type || !b.title) throw new HttpError(400, "type and title are required");
    if (!isValidMediaType(b.type)) throw new HttpError(400, `Unknown media type "${b.type}"`);

    if (!b.confirmDuplicate) {
      const needle = String(b.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const existing = db
        .prepare(
          `SELECT r.title, r.year, u.username FROM requests r JOIN users u ON u.id = r.user_id
           WHERE r.type = ? AND r.status IN ('pending', 'approved')
           ${b.year ? "AND (r.year IS NULL OR r.year = ?)" : ""}`
        )
        .all(...(b.year ? [b.type, b.year] : [b.type])) as { title: string; year: number | null; username: string }[];
      const duplicate = existing.find((r) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === needle);
      if (duplicate) {
        res.status(409).json({ duplicate });
        return;
      }
    }

    if (user.maxPendingRequests !== null) {
      const pendingCount = (
        db.prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ? AND status = 'pending'").get(user.id) as {
          c: number;
        }
      ).c;
      if (pendingCount >= user.maxPendingRequests) {
        throw new HttpError(
          400,
          `You already have ${pendingCount} pending request(s), the max allowed is ${user.maxPendingRequests}`
        );
      }
    }

    const result = db
      .prepare(
        `INSERT INTO requests (user_id, type, title, year, overview, poster_url, external_ids, note)
         VALUES (@userId, @type, @title, @year, @overview, @posterUrl, @externalIds, @note)`
      )
      .run({
        userId: user.id,
        type: b.type,
        title: b.title,
        year: b.year ?? null,
        overview: b.overview ?? null,
        posterUrl: b.posterUrl ?? null,
        externalIds: b.externalIds ? JSON.stringify(b.externalIds) : null,
        note: b.note ?? null,
      });

    let row = db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid) as any;
    logAuditEvent(user.id, user.username, "request_submitted", b.title);
    if (user.autoApprove) {
      approveRequestRow(row, null, null);
      row = db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid);
      logAuditEvent(user.id, user.username, "request_auto_approved", b.title);
    }
    res.status(201).json(requestFromRow(row));
  })
);

requestsRouter.post(
  "/:id/approve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id) as any;
    if (!request) throw new HttpError(404, "Request not found");
    if (request.status !== "pending") throw new HttpError(400, "Request has already been resolved");

    const b = req.body ?? {};
    const mediaItemId = approveRequestRow(request, b.rootFolderId ?? null, b.qualityProfileId ?? null);
    logAuditEvent(null, "admin", "request_approved", request.title);
    sendPush("Request approved", request.title, request.user_id).catch(() => {});

    const mediaRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
    const requestRow = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
    res.json({ ...requestFromRow(requestRow), mediaItem: mediaItemFromRow(mediaRow) });
  })
);

requestsRouter.post(
  "/:id/reject",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
    if (!request) throw new HttpError(404, "Request not found");
    db.prepare("UPDATE requests SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(
      req.params.id
    );
    logAuditEvent(null, "admin", "request_rejected", (request as any).title);
    sendPush("Request rejected", (request as any).title, (request as any).user_id).catch(() => {});
    const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
    res.json(requestFromRow(row));
  })
);

requestsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id) as any;
    if (!request) throw new HttpError(404, "Request not found");
    if (!req.auth?.isAdmin && request.user_id !== req.auth?.user?.id) {
      throw new HttpError(403, "You can only cancel your own requests");
    }
    db.prepare("DELETE FROM requests WHERE id = ?").run(req.params.id);
    res.status(204).send();
  })
);
