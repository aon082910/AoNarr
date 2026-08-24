import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isValidMediaType } from "../services/mediaTypes.js";

export const importExclusionsRouter = Router();
importExclusionsRouter.use(requireAdmin);

importExclusionsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .prepare(
        `SELECT id, type, title, year, external_id AS "externalId", external_provider AS "externalProvider",
                reason, created_at AS "createdAt"
         FROM import_exclusions ORDER BY created_at DESC`
      )
      .all();
    res.json(rows);
  })
);

importExclusionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) throw new HttpError(400, "type and title are required");
    if (!isValidMediaType(b.type)) throw new HttpError(400, `Unknown media type "${b.type}"`);
    const result = await db
      .prepare(
        `INSERT INTO import_exclusions (type, title, year, external_id, external_provider, reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(b.type, b.title, b.year ?? null, b.externalId ?? null, b.externalProvider ?? null, b.reason ?? null);
    res.status(201).json({ id: result.lastInsertRowid });
  })
);

importExclusionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM import_exclusions WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Exclusion not found");
    res.status(204).send();
  })
);
