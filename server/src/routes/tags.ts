import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { tagFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const tagsRouter = Router();
tagsRouter.use(requireAdmin);

tagsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM tags ORDER BY name").all();
    res.json(rows.map(tagFromRow));
  })
);

tagsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = (req.body?.name ?? "").trim();
    if (!name) throw new HttpError(400, "name is required");
    await db.prepare(`INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name`).run(name);
    const row = await db.prepare("SELECT * FROM tags WHERE name = ?").get(name);
    res.status(201).json(tagFromRow(row));
  })
);

tagsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const retentionDays = req.body?.retentionDays;
    await db
      .prepare("UPDATE tags SET retention_days = ? WHERE id = ?")
      .run(retentionDays === null || retentionDays === undefined ? null : Number(retentionDays), req.params.id);
    const row = await db.prepare("SELECT * FROM tags WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Tag not found");
    res.json(tagFromRow(row));
  })
);

tagsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM tags WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Tag not found");
    res.status(204).send();
  })
);
