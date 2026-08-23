import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { importReviewItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const importReviewRouter = Router();
importReviewRouter.use(requireAdmin);

/**
 * Titles Watchlist Import or a recurring Import List couldn't confidently match to a metadata
 * result. Resolving one is a two-step client flow, deliberately not done in one call here: the
 * client first adds the media item the normal way (POST /metadata/import, same as Add Media, so
 * it gets exactly the same child-fetch/audit-log behavior everything else added that way gets),
 * then calls this route's /resolve just to clear the review queue entry — keeping this router thin
 * and avoiding a second, subtly-different copy of "how to create a media item."
 */
importReviewRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || "pending";
    const importListId = req.query.importListId as string | undefined;
    const rows = importListId
      ? db
          .prepare("SELECT * FROM import_review_items WHERE status = ? AND import_list_id = ? ORDER BY created_at DESC")
          .all(status, importListId)
      : db.prepare("SELECT * FROM import_review_items WHERE status = ? ORDER BY created_at DESC").all(status);
    res.json((rows as any[]).map(importReviewItemFromRow));
  })
);

/** Pending-review count per import list, for a lightweight indicator on the Import Lists page
 * without that page needing to fetch every review item's full details. */
importReviewRouter.get(
  "/counts",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare("SELECT import_list_id AS importListId, COUNT(*) AS count FROM import_review_items WHERE status = 'pending' AND import_list_id IS NOT NULL GROUP BY import_list_id")
      .all();
    res.json(rows);
  })
);

importReviewRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const result = db
      .prepare("UPDATE import_review_items SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Review item not found");
    res.status(204).send();
  })
);

importReviewRouter.post(
  "/:id/dismiss",
  asyncHandler(async (req, res) => {
    const result = db
      .prepare("UPDATE import_review_items SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Review item not found");
    res.status(204).send();
  })
);
