import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { recycleAndMarkMissing } from "../services/corruptMediaCheck.js";
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

/** Admin confirms the file really is bad — runs the exact same recycle-and-mark-missing logic the
 * automatic path uses when review is off, then drops the queue entry. */
corruptMediaReviewRouter.post(
  "/:id/recycle",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM corrupt_media_review WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Review entry not found");

    await recycleAndMarkMissing(row.table_name, row.row_id, row.file_path, row.media_type, row.title, row.media_item_id);
    await db.prepare("DELETE FROM corrupt_media_review WHERE id = ?").run(req.params.id);

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
