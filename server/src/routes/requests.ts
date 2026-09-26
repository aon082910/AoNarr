import fs from "node:fs";
import { Router } from "express";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { mediaItemFromRow, requestFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { logAuditEvent } from "../services/audit.js";
import { sendPush } from "../services/push.js";
import { autoSelectRootFolderId } from "../services/rootFolderSelect.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { withLibraryAddLock } from "../services/importLists.js";
import { defaultQualityProfileId } from "../services/mediaServerImport.js";
import { clampLimit, clampOffset } from "../services/mediaQuery.js";

export const requestsRouter = Router();

/** External-id keys whose value the server fetches as a URL rather than looking up as an id on a
 * fixed provider host: a podcast item's feed is re-fetched every feed check and every enclosure it
 * lists is grabbed. A household account supplying one could point the server at loopback/LAN/
 * metadata addresses (or a `data:` feed listing them), so requests never carry one — an admin
 * attaches the feed by rematching the approved item against the podcast search instead. */
const REQUEST_UNSAFE_EXTERNAL_ID_KEYS = new Set(["podcastFeed"]);

/** Normalizes a request's external ids (the submitted object, or the stored JSON text) to JSON
 * text without any REQUEST_UNSAFE_EXTERNAL_ID_KEYS, or null when nothing usable is left. */
function requestExternalIdsJson(raw: unknown): string | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kept = Object.entries(value as Record<string, unknown>).filter(([key]) => !REQUEST_UNSAFE_EXTERNAL_ID_KEYS.has(key));
  return kept.length > 0 ? JSON.stringify(Object.fromEntries(kept)) : null;
}

/** Image hosts the metadata searches hand posters out from. A request's poster becomes the library
 * item's poster_url, which the server itself fetches (bulk metadata export), and a household
 * account chooses it — so plain http, data: and any other host (LAN, cloud metadata endpoint) is
 * dropped instead of stored. A metadata refresh after approval fills in artwork for an item without. */
const REQUEST_POSTER_HOSTS = [
  "image.tmdb.org",
  "covers.openlibrary.org",
  "uploads.mangadex.org",
  "images.igdb.com",
  "comicvine.gamespot.com",
  "mzstatic.com",
];

function requestPosterUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return REQUEST_POSTER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url.href : null;
}

/** Shared by the admin approve endpoint and auto-approval on submit — creates the real library
 * entry from a request row exactly the way adding media manually does. Checks for an existing
 * library item first (the same check POST /api/media makes before creating one directly) — without
 * this, approving a request for something an admin already added straight to the library silently
 * created a second, independently-monitored duplicate.
 *
 * Must run inside db.transaction: the request is only marked approved if it is still pending, and
 * when it no longer is (rejected or cancelled meanwhile) the thrown 409 rolls the new item back. */
async function approveRequestRow(
  request: any,
  rootFolderIdOverride: number | null,
  qualityProfileId: number | null,
  confirmDuplicate: boolean
): Promise<{ mediaItemId: number } | { duplicates: Awaited<ReturnType<typeof findPossibleDuplicates>> }> {
  if (!confirmDuplicate) {
    const duplicates = await findPossibleDuplicates(request.type, request.title, request.year ?? null);
    if (duplicates.length > 0) return { duplicates };
  }

  const rootFolderId = rootFolderIdOverride ?? (await autoSelectRootFolderId(request.type));
  // No profile means the auto-search applies no allowed-quality gate or cutoff at all, so an
  // approval that doesn't name one (auto-approve, the Requests page) gets the default profile.
  const profileId = qualityProfileId ?? (await defaultQualityProfileId());
  const mediaResult = await db
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
      posterUrl: requestPosterUrl(request.poster_url),
      externalIds: requestExternalIdsJson(request.external_ids),
      rootFolderId,
      qualityProfileId: profileId,
    });

  const mediaItemId = Number(mediaResult.lastInsertRowid);
  const updated = await db
    .prepare(
      `UPDATE requests SET status = 'approved', media_item_id = ?, resolved_at = ${nowExpr(db)} WHERE id = ? AND status = 'pending'`
    )
    .run(mediaItemId, request.id);
  if (updated.changes === 0) throw new HttpError(409, "Request was resolved or cancelled meanwhile");
  return { mediaItemId };
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
 * consumption back to the household user whose approved request created it. Prefers each row's
 * stored `size_bytes` (populated at import time) over statting the path directly, since a
 * "collection" sub-item's file_path can be a whole folder (Music's one-file-per-track layout) —
 * fs.stat on a directory returns its own tiny metadata size, not a recursive sum of its contents. */
async function mediaItemStorageBytes(mediaItemId: number): Promise<number> {
  const item = (await db.prepare("SELECT path, size_bytes, has_file FROM media_items WHERE id = ?").get(mediaItemId)) as
    | { path: string | null; size_bytes: number | null; has_file: number }
    | undefined;
  // size_bytes outlives the file (archival, deleted-file and corrupt-file checks only clear
  // has_file/path), so an item with no file must not keep counting its old size.
  let total = item?.has_file ? Number(item.size_bytes ?? fileSize(item.path)) : 0;

  const episodes = (await db
    .prepare("SELECT file_path, size_bytes FROM episodes WHERE media_item_id = ? AND has_file = 1")
    .all(mediaItemId)) as { file_path: string | null; size_bytes: number | null }[];
  for (const e of episodes) total += e.size_bytes ?? fileSize(e.file_path);

  const subItems = (await db
    .prepare("SELECT file_path, size_bytes FROM sub_items WHERE media_item_id = ? AND has_file = 1")
    .all(mediaItemId)) as { file_path: string | null; size_bytes: number | null }[];
  for (const s of subItems) total += s.size_bytes ?? fileSize(s.file_path);

  return total;
}

/** Per-user request activity + storage attributable to their approved requests, for the admin
 * Users page. Storage is computed on demand by statting files (same files the library already
 * tracks paths for) rather than a maintained running total, so it never drifts out of sync. */
requestsRouter.get(
  "/stats",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const users = (await db.prepare("SELECT id, username FROM users WHERE role = 'user'").all()) as {
      id: number;
      username: string;
    }[];

    const stats = await Promise.all(
      users.map(async (user) => {
        const counts = (await db
          .prepare(`SELECT status, COUNT(*) AS c FROM requests WHERE user_id = ? GROUP BY status`)
          .all(user.id)) as { status: string; c: number }[];
        const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
        for (const row of counts) byStatus[row.status] = Number(row.c);
        const total = byStatus.pending + byStatus.approved + byStatus.rejected;
        const resolved = byStatus.approved + byStatus.rejected;

        const approvedMediaItemIds = (
          (await db
            .prepare("SELECT media_item_id AS id FROM requests WHERE user_id = ? AND status = 'approved' AND media_item_id IS NOT NULL")
            .all(user.id)) as { id: number }[]
        ).map((r) => r.id);
        let storageBytes = 0;
        for (const id of approvedMediaItemIds) storageBytes += await mediaItemStorageBytes(id);

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
      })
    );

    res.json(stats);
  })
);

/** A household user's own request totals/approval rate — the same counts `/stats` computes per
 * user for the admin Users page, but self-scoped and reachable by a non-admin, since the Requests
 * page shows this summary to the requester themselves, not just admins. */
requestsRouter.get(
  "/stats/me",
  asyncHandler(async (req, res) => {
    const user = req.auth?.user;
    if (!user) throw new HttpError(401, "Not authenticated");
    const counts = (await db
      .prepare(`SELECT status, COUNT(*) AS c FROM requests WHERE user_id = ? GROUP BY status`)
      .all(user.id)) as { status: string; c: number }[];
    const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const row of counts) byStatus[row.status] = Number(row.c);
    const total = byStatus.pending + byStatus.approved + byStatus.rejected;
    const resolved = byStatus.approved + byStatus.rejected;
    res.json({
      total,
      approvalRatePercent: resolved > 0 ? Math.round((byStatus.approved / resolved) * 100) : null,
    });
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
    const limit = clampLimit(req.query.limit, 100);
    const offset = clampOffset(req.query.offset);
    const isAdmin = !!req.auth?.isAdmin;

    const countRow = isAdmin
      ? ((await db.prepare("SELECT COUNT(*) AS c FROM requests").get()) as { c: number | string })
      : ((await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ?").get(req.auth?.user?.id)) as {
          c: number | string;
        });
    const rows = isAdmin
      ? ((await db
          .prepare("SELECT * FROM requests ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
          .all(limit, offset)) as any[])
      : ((await db
          .prepare("SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
          .all(req.auth?.user?.id, limit, offset)) as any[]);
    res.json({ items: rows.map(requestFromRow), total: Number(countRow.c) });
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
    // Same per-library gate every read path applies — the Requests form only hides disallowed
    // types client-side, and with auto-approve a request for one would add a monitored item to a
    // library this account can't even see, downloaded with no admin ever reviewing it.
    if (!(user.allowedTypes ?? []).includes(b.type)) throw new HttpError(403, "You don't have access to this library");

    // The duplicate check (across every account's requests), the pending quota and auto-approve's
    // library duplicate check are all check-then-insert. On Postgres each await is real I/O, so
    // parallel submissions, from one account or several, would all pass the checks before any of
    // them inserted. The library-add lock serializes them with each other and with every other
    // source that adds library items (import lists, Overseerr, Plex watchlist, admin approval).
    const outcome = await withLibraryAddLock(() => db.transaction(async () => {
      if (!b.confirmDuplicate) {
        const needle = String(b.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const existing = (await db
          .prepare(
            `SELECT r.title, r.year, u.username FROM requests r JOIN users u ON u.id = r.user_id
             WHERE r.type = ? AND r.status IN ('pending', 'approved')
             ${b.year ? "AND (r.year IS NULL OR r.year = ?)" : ""}`
          )
          .all(...(b.year ? [b.type, b.year] : [b.type]))) as { title: string; year: number | null; username: string }[];
        const duplicate = existing.find((r) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === needle);
        if (duplicate) return { duplicate };
      }

      if (user.maxPendingRequests !== null) {
        const pendingCount = Number(
          (
            (await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ? AND status = 'pending'").get(user.id)) as {
              c: number;
            }
          ).c
        );
        if (pendingCount >= user.maxPendingRequests) {
          throw new HttpError(
            400,
            `You already have ${pendingCount} pending request(s), the max allowed is ${user.maxPendingRequests}`
          );
        }
      }

      const result = await db
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
          posterUrl: requestPosterUrl(b.posterUrl),
          externalIds: requestExternalIdsJson(b.externalIds),
          note: b.note ?? null,
        });

      let row = (await db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid)) as any;
      let autoApproved: boolean | null = null;
      if (user.autoApprove) {
        const approval = await approveRequestRow(row, null, null, false);
        autoApproved = "mediaItemId" in approval;
        if (autoApproved) row = await db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid);
      }
      return { row, autoApproved };
    }));

    if ("duplicate" in outcome) {
      res.status(409).json({ duplicate: outcome.duplicate });
      return;
    }
    logAuditEvent(user.id, user.username, "request_submitted", b.title);
    if (outcome.autoApproved === true) {
      logAuditEvent(user.id, user.username, "request_auto_approved", b.title);
    } else if (outcome.autoApproved === false) {
      // Already in the library under a possible duplicate title/year — leave the request
      // pending instead of silently creating a second entry or auto-approving with none.
      logAuditEvent(user.id, user.username, "request_auto_approve_skipped_possible_duplicate", b.title);
    }
    res.status(201).json(requestFromRow(outcome.row));
  })
);

requestsRouter.post(
  "/:id/approve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    // Status check, duplicate check and INSERT under the same lock as submissions: a double-clicked
    // Approve (or an auto-approved submission of the same title) would otherwise add it twice.
    // Reject and cancel take the same lock, and the transaction undoes the item if the request
    // stopped being pending anyway.
    const outcome = await withLibraryAddLock(() =>
      db.transaction(async () => {
        const request = (await db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id)) as any;
        if (!request) throw new HttpError(404, "Request not found");
        if (request.status !== "pending") throw new HttpError(400, "Request has already been resolved");
        const approval = await approveRequestRow(request, b.rootFolderId ?? null, b.qualityProfileId ?? null, !!b.confirmDuplicate);
        if ("duplicates" in approval) return approval;
        const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(approval.mediaItemId);
        const requestRow = await db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
        return { request, mediaRow, requestRow };
      })
    );
    if ("duplicates" in outcome) {
      res.status(409).json({ duplicates: outcome.duplicates });
      return;
    }
    const { request } = outcome;
    logAuditEvent(null, "admin", "request_approved", request.title);
    sendPush("Request approved", request.title, request.user_id).catch(() => {});
    res.json({ ...requestFromRow(outcome.requestRow), mediaItem: mediaItemFromRow(outcome.mediaRow) });
  })
);

requestsRouter.post(
  "/:id/reject",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { request, row } = await withLibraryAddLock(async () => {
      const request = (await db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id)) as any;
      if (!request) throw new HttpError(404, "Request not found");
      // Conditional on still being pending, same as approve — a stale second tab (or another admin)
      // could otherwise flip an already-approved request, whose item was added, to "rejected" and
      // push the requester a false rejection.
      const result = await db
        .prepare(`UPDATE requests SET status = 'rejected', resolved_at = ${nowExpr(db)} WHERE id = ? AND status = 'pending'`)
        .run(req.params.id);
      if (result.changes === 0) throw new HttpError(400, "Only a pending request can be rejected");
      return { request, row: await db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id) };
    });
    logAuditEvent(null, "admin", "request_rejected", request.title);
    sendPush("Request rejected", request.title, request.user_id).catch(() => {});
    res.json(requestFromRow(row));
  })
);

requestsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const isAdmin = !!req.auth?.isAdmin;
    await withLibraryAddLock(async () => {
      const request = (await db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id)) as any;
      if (!request) throw new HttpError(404, "Request not found");
      if (!isAdmin && request.user_id !== req.auth?.user?.id) {
        throw new HttpError(403, "You can only cancel your own requests");
      }
      // A requester can only cancel a request that is still pending: once approved, its item is in
      // the library and the request is what attributes that item's storage to them.
      const result = await db
        .prepare(`DELETE FROM requests WHERE id = ?${isAdmin ? "" : " AND status = 'pending'"}`)
        .run(req.params.id);
      if (result.changes === 0) throw new HttpError(400, "Only a pending request can be cancelled");
    });
    res.status(204).send();
  })
);
