import fs from "node:fs";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { rootFolderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";

export const rootFoldersRouter = Router();
rootFoldersRouter.use(requireAdmin);

rootFoldersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT * FROM root_folders").all();
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
    const result = db
      .prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)")
      .run(b.path, b.mediaType);
    const row = db.prepare("SELECT * FROM root_folders WHERE id = ?").get(result.lastInsertRowid);
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
      db.prepare(`UPDATE root_folders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM root_folders WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Root folder not found");
    res.json(rootFolderFromRow(row));
  })
);

rootFoldersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM root_folders WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Root folder not found");
    res.status(204).send();
  })
);
