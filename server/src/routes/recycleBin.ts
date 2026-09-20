import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  purgeAllRecycleBinEntries,
  purgeRecycleBinEntry,
  restoreAllFromRecycleBin,
  startRestoreFromRecycleBin,
} from "../services/recycleBin.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const recycleBinRouter = Router();
recycleBinRouter.use(requireAdmin);

/** Grouped by media_type so the UI can mirror each library's own folder structure. */
recycleBinRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = (await db.prepare("SELECT * FROM recycle_bin ORDER BY deleted_at DESC").all()) as any[];
    res.json(
      rows.map((r) => ({
        id: r.id,
        mediaItemId: r.media_item_id,
        mediaType: r.media_type,
        title: r.title,
        originalPath: r.original_path,
        sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
        deletedAt: r.deleted_at,
        restoring: !!r.restoring,
        restoreError: r.restore_error,
      }))
    );
  })
);

/** Restores every not-already-restoring entry, optionally scoped to one media type — the Recycle
 * Bin page's per-section "Restore All". Registered ahead of the parameterized `/:id/restore` and
 * `/:id` routes below so "restore-all"/"purge-all" can't be captured as an `:id`. */
recycleBinRouter.post(
  "/restore-all",
  asyncHandler(async (req, res) => {
    const mediaType = typeof req.query.mediaType === "string" ? req.query.mediaType : undefined;
    const result = await restoreAllFromRecycleBin(mediaType);
    if (result.started > 0) {
      const actor = auditActor(req);
      logAuditEvent(actor.userId, actor.username, "recycle_bin_restore_all", `${result.started} item(s)${mediaType ? ` (${mediaType})` : ""}`);
    }
    res.json(result);
  })
);

recycleBinRouter.delete(
  "/purge-all",
  asyncHandler(async (req, res) => {
    const mediaType = typeof req.query.mediaType === "string" ? req.query.mediaType : undefined;
    const result = await purgeAllRecycleBinEntries(mediaType);
    if (result.purged > 0) {
      const actor = auditActor(req);
      logAuditEvent(actor.userId, actor.username, "recycle_bin_purge_all", `${result.purged} item(s)${mediaType ? ` (${mediaType})` : ""}`);
    }
    res.json(result);
  })
);

/** Fire-and-forget, same reasoning as every other slow background job in this app: moving a large
 * file back out of the recycle bin (especially across a Docker volume boundary, where it's a full
 * copy rather than a rename) can take a while, and holding the HTTP request open for that used to
 * mean the whole server sat blocked on a synchronous copy for the duration — see recycleBin.ts's
 * startRestoreFromRecycleBin for the actual fix. Validation errors ("no such entry", "already
 * restoring") reject before any of the actual file move starts, so they still 400 normally here;
 * everything past that point is reflected in the row's restoring/restoreError fields on the next
 * GET /. */
recycleBinRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    try {
      await startRestoreFromRecycleBin(Number(req.params.id));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    res.json({ started: true });
  })
);

recycleBinRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await purgeRecycleBinEntry(Number(req.params.id));
    res.status(204).send();
  })
);
