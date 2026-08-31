import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { rootFolderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { deleteMediaItemCascade } from "./media.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { renameOneMediaItem, removeEmptyParents } from "../services/importer.js";
import { log } from "../services/logger.js";

export const rootFoldersRouter = Router();
rootFoldersRouter.use(requireAdmin);

rootFoldersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM root_folders").all();
    res.json(
      rows.map((row) => {
        const folder = rootFolderFromRow(row);
        try {
          const stat = fs.statfsSync(folder.path);
          const freeBytes = stat.bfree * stat.bsize;
          const totalBytes = stat.blocks * stat.bsize;
          const percentUsed = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : null;
          return { ...folder, freeBytes, totalBytes, percentUsed };
        } catch {
          return { ...folder, freeBytes: null, totalBytes: null, percentUsed: null };
        }
      })
    );
  })
);

rootFoldersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.path || !b.mediaType) throw new HttpError(400, "path and mediaType are required");
    if (!isValidMediaType(b.mediaType)) throw new HttpError(400, `Unknown media type "${b.mediaType}"`);
    const result = await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(b.path, b.mediaType);
    const row = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(rootFolderFromRow(row));
  })
);

rootFoldersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.quotaPercent !== undefined) {
      sets.push("quota_percent = ?");
      values.push(b.quotaPercent === null ? null : Number(b.quotaPercent));
    }
    if (b.pauseGrabsAtQuota !== undefined) {
      sets.push("pause_grabs_at_quota = ?");
      values.push(b.pauseGrabsAtQuota ? 1 : 0);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE root_folders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Root folder not found");
    res.json(rootFolderFromRow(row));
  })
);

/**
 * Default behavior is unchanged: the folder row goes, and every media item that pointed at it
 * (`root_folder_id ON DELETE SET NULL`) is silently orphaned — still fully in the library, just
 * no longer tied to any folder. `?deleteMedia=1` opts into actually removing those items too
 * (same untrack-only-by-default / `?deleteFiles=1`-also-recycles-files behavior the single-item
 * delete route already has), for the case where the folder's being removed because everything in
 * it is gone/being replaced, not just reorganized.
 */
/**
 * Sonarr/Radarr's real "move root folder" action: physically relocates every media item
 * currently in this folder to a different one (must be the same media type — moving Movies into
 * a Books folder makes no sense), rather than the PATCH route's plain DB-pointer repoint, which
 * would silently desync `root_folder_id` from where the file actually lives on disk.
 * Fire-and-forget (like every other whole-library operation here) — moving potentially thousands
 * of files can easily outrun an HTTP/gateway timeout. Reuses renameOneMediaItem() for the actual
 * per-item move: it already recomputes an item's destination from its *current* `root_folder_id`
 * and physically relocates the file if that destination differs from where it is now, so
 * updating `root_folder_id` first and then calling it is the entire "move" operation — no new
 * file-moving logic needed.
 */
rootFoldersRouter.post(
  "/:id/move-to/:destinationId",
  asyncHandler(async (req, res) => {
    const source = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id)) as any;
    if (!source) throw new HttpError(404, "Source root folder not found");
    const destination = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.destinationId)) as any;
    if (!destination) throw new HttpError(404, "Destination root folder not found");
    if (source.media_type !== destination.media_type) {
      throw new HttpError(400, `Can't move ${source.media_type} items into a ${destination.media_type} folder`);
    }
    if (source.id === destination.id) throw new HttpError(400, "Source and destination are the same folder");

    const items = (await db.prepare("SELECT id, title FROM media_items WHERE root_folder_id = ?").all(source.id)) as {
      id: number;
      title: string;
    }[];
    if (items.length === 0) {
      res.json({ started: true, itemCount: 0 });
      return;
    }

    (async () => {
      let moved = 0;
      for (const item of items) {
        try {
          // Every file path this item currently owns, captured *before* renameOneMediaItem moves
          // anything — its own empty-parent cleanup is scoped to the item's (now-updated)
          // root_folder_id, so it can only ever clean up under the *destination* folder; the
          // source folder's now-empty leftover directories need their own cleanup pass below.
          const oldPaths = (
            (
              await db
                .prepare(
                  `SELECT path FROM media_items WHERE id = ? AND path IS NOT NULL
                   UNION ALL SELECT file_path FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL
                   UNION ALL SELECT file_path FROM sub_items WHERE media_item_id = ? AND file_path IS NOT NULL`
                )
                .all(item.id, item.id, item.id)
            ) as { path: string }[]
          ).map((r) => r.path);

          await db.prepare("UPDATE media_items SET root_folder_id = ? WHERE id = ?").run(destination.id, item.id);
          await renameOneMediaItem(item.id);

          for (const oldPath of oldPaths) {
            try {
              removeEmptyParents(path.dirname(oldPath), source.path);
            } catch {
              // best-effort cleanup only — a leftover empty directory in the old folder is cosmetic
            }
          }
          moved++;
        } catch (err) {
          log.warn(`[rootFolders] failed to move "${item.title}" to "${destination.path}":`, (err as Error).message);
        }
      }
      log.info(`[rootFolders] moved ${moved}/${items.length} item(s) from "${source.path}" to "${destination.path}"`);
      const actor = auditActor(req);
      logAuditEvent(actor.userId, actor.username, "root_folder_moved", `${source.path} → ${destination.path} (${moved} item(s))`);
    })().catch((err) => log.warn("[rootFolders] move-to background task failed:", err.message));

    res.json({ started: true, itemCount: items.length });
  })
);

rootFoldersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const folder = (await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id)) as any;
    if (!folder) throw new HttpError(404, "Root folder not found");

    let removedCount = 0;
    if (req.query.deleteMedia === "1") {
      const items = (await db.prepare("SELECT * FROM media_items WHERE root_folder_id = ?").all(req.params.id)) as any[];
      for (const item of items) {
        await deleteMediaItemCascade(item, req.query.deleteFiles === "1");
        removedCount++;
      }
    }

    await db.prepare("DELETE FROM root_folders WHERE id = ?").run(req.params.id);
    const actor = auditActor(req);
    logAuditEvent(
      actor.userId,
      actor.username,
      "root_folder_removed",
      `${folder.path}${removedCount > 0 ? ` — ${removedCount} media item(s) removed${req.query.deleteFiles === "1" ? " (files recycled)" : ""}` : ""}`
    );
    res.status(204).send();
  })
);
