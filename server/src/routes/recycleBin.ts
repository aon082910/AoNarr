import { Router } from "express";
import { db } from "../db/client.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { purgeRecycleBinEntry, restoreFromRecycleBin } from "../services/recycleBin.js";

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
      }))
    );
  })
);

recycleBinRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    try {
      restoreFromRecycleBin(Number(req.params.id));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    res.status(204).send();
  })
);

recycleBinRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    purgeRecycleBinEntry(Number(req.params.id));
    res.status(204).send();
  })
);
