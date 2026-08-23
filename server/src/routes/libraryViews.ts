import { Router } from "express";
import { db } from "../db/index.js";
import { savedLibraryViewFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { isValidMediaType } from "../services/mediaTypes.js";

export const libraryViewsRouter = Router();

/** Saved sort/filter/column combinations for a library page — shared instance-wide (same model
 * as quality profiles/custom formats) rather than per-user, so a household agrees on and reuses
 * the same named views instead of everyone keeping their own private set. */
libraryViewsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const mediaType = req.query.mediaType as string | undefined;
    if (!mediaType || !isValidMediaType(mediaType)) throw new HttpError(400, "A valid mediaType is required");
    const rows = await db.prepare("SELECT * FROM saved_library_views WHERE media_type = ? ORDER BY name").all(mediaType);
    res.json(rows.map(savedLibraryViewFromRow));
  })
);

libraryViewsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.mediaType || !isValidMediaType(b.mediaType)) throw new HttpError(400, "A valid mediaType is required");
    if (!b.name || typeof b.name !== "string") throw new HttpError(400, "name is required");
    if (!b.config || typeof b.config !== "object") throw new HttpError(400, "config is required");

    let result;
    try {
      result = await db
        .prepare("INSERT INTO saved_library_views (media_type, name, config) VALUES (?, ?, ?)")
        .run(b.mediaType, b.name.trim(), JSON.stringify(b.config));
    } catch {
      throw new HttpError(409, `A saved view named "${b.name.trim()}" already exists for this library`);
    }
    const row = await db.prepare("SELECT * FROM saved_library_views WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(savedLibraryViewFromRow(row));
  })
);

libraryViewsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM saved_library_views WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Saved view not found");
    res.status(204).send();
  })
);
