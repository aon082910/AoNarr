import { Router } from "express";
import { db } from "../db/client.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { purgeRecycleBinEntry, startRestoreFromRecycleBin } from "../services/recycleBin.js";

export const recycleBinRouter = Router();
recycleBinRouter.use(requireAdmin);

/** Grouped by media_type so the UI can mirror each library's own folder structure. */
recycleBinRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT * FROM recycle_bin ORDER BY deleted_at DESC").all() as any[];
    res.json(
      rows.map((r) => ({
        id: r.id,
        mediaItemId: r.media_item_id,
        mediaType: r.media_type,
        title: r.title,
        originalPath: r.original_path,
        sizeBytes: r.size_bytes,
        deletedAt: r.deleted_at,
        restoring: !!r.restoring,
        restoreError: r.restore_error,
      }))
    );
  })
);

/** Fire-and-forget, same reasoning as every other slow background job in this app: moving a large
 * file back out of the recycle bin (especially across a Docker volume boundary, where it's a full
 * copy rather than a rename) can take a while, and holding the HTTP request open for that used to
 * mean the whole server sat blocked on a synchronous copy for the duration — see recycleBin.ts's
 * startRestoreFromRecycleBin for the actual fix. Validation errors ("no such entry", "already
 * restoring") still throw synchronously here and 400 normally; everything past that point is
 * reflected in the row's restoring/restoreError fields on the next GET /. */
recycleBinRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    try {
      startRestoreFromRecycleBin(Number(req.params.id));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    res.json({ started: true });
  })
);

recycleBinRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    purgeRecycleBinEntry(Number(req.params.id));
    res.status(204).send();
  })
);
