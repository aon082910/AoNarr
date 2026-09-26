import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { corruptReason, recycleAndMarkMissing, type CorruptAction, type CorruptTable } from "../services/corruptMediaCheck.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const corruptMediaReviewRouter = Router();
corruptMediaReviewRouter.use(requireAdmin);

corruptMediaReviewRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = (await db.prepare("SELECT * FROM corrupt_media_review ORDER BY detected_at DESC").all()) as any[];
    res.json(
      rows.map((r) => ({
        id: r.id,
        mediaItemId: r.media_item_id,
        mediaType: r.media_type,
        title: r.title,
        filePath: r.file_path,
        reason: r.reason,
        detectedAt: r.detected_at,
      }))
    );
  })
);

const REVIEW_TABLES = new Set<string>(["media_items", "episodes", "sub_items"]);

/** Admin confirms the file really is bad — runs the exact same recycle-and-mark-missing logic the
 * automatic path uses when review is off, then drops the queue entry.
 *
 * An entry can be days old. If the row no longer has that file (an upgrade or rename gave it a new
 * one, a merge deleted it) or the file at that path now passes validation (a replacement imported
 * onto the same templated path), the entry is dropped as stale and nothing is recycled; recycling
 * blindly moved the new, good file to the bin and marked the item missing. */
corruptMediaReviewRouter.post(
  "/:id/recycle",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM corrupt_media_review WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Review entry not found");

    let action: CorruptAction = "stale";
    if (REVIEW_TABLES.has(row.table_name) && (await corruptReason(row.file_path, row.media_type, { confirm: false }))) {
      action = await recycleAndMarkMissing(row.table_name as CorruptTable, row.row_id, row.file_path, row.media_type, row.title, row.media_item_id);
    }
    if (action === "unavailable") {
      throw new HttpError(409, "The storage holding this file is offline right now — try again once it's back");
    }
    if (action === "failed") throw new HttpError(500, "Couldn't move this file to the recycle bin — check the logs");

    await db.prepare("DELETE FROM corrupt_media_review WHERE id = ?").run(req.params.id);
    if (action === "stale") {
      res.json({ recycled: false, stale: true, message: "This file has changed since it was flagged, so nothing was recycled" });
      return;
    }

    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "corrupt_media_recycled", row.title);
    res.status(204).send();
  })
);

/** Admin says it's actually fine (a false positive) — drops the queue entry and leaves the file
 * and DB row exactly as they were; has_file was never touched while it sat in review, so there's
 * nothing to restore. */
corruptMediaReviewRouter.post(
  "/:id/dismiss",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM corrupt_media_review WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Review entry not found");

    await db.prepare("DELETE FROM corrupt_media_review WHERE id = ?").run(req.params.id);

    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "corrupt_media_dismissed", row.title);
    res.status(204).send();
  })
);
