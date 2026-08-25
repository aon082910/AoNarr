import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { customColumnFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const customColumnsRouter = Router();
customColumnsRouter.use(requireAdmin);

customColumnsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM custom_columns ORDER BY position ASC, id ASC").all();
    res.json(rows.map(customColumnFromRow));
  })
);

customColumnsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.label || !b.path) throw new HttpError(400, "label and path are required");
    const result = await db
      .prepare(`INSERT INTO custom_columns (media_type, label, path, position) VALUES (?, ?, ?, ?)`)
      .run(b.mediaType || null, b.label, b.path, b.position ?? 0);
    const row = await db.prepare("SELECT * FROM custom_columns WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(customColumnFromRow(row));
  })
);

customColumnsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const map: Record<string, string> = { mediaType: "media_type", label: "label", path: "path", position: "position" };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(key === "mediaType" ? b[key] || null : b[key]);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE custom_columns SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM custom_columns WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Custom column not found");
    res.json(customColumnFromRow(row));
  })
);

customColumnsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM custom_columns WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Custom column not found");
    res.status(204).send();
  })
);
