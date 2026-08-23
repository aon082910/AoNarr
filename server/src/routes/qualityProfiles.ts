import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { qualityProfileFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const qualityProfilesRouter = Router();
qualityProfilesRouter.use(requireAdmin);

qualityProfilesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM quality_profiles").all();
    res.json(rows.map(qualityProfileFromRow));
  })
);

qualityProfilesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !Array.isArray(b.allowedQualities) || !b.cutoff) {
      throw new HttpError(400, "name, allowedQualities (array) and cutoff are required");
    }
    const result = await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
      .run(b.name, JSON.stringify(b.allowedQualities), b.cutoff);
    const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(qualityProfileFromRow(row));
  })
);

qualityProfilesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.allowedQualities !== undefined) {
      sets.push("allowed_qualities = ?");
      values.push(JSON.stringify(b.allowedQualities));
    }
    if (b.cutoff !== undefined) {
      sets.push("cutoff = ?");
      values.push(b.cutoff);
    }
    if (b.minFormatScore !== undefined) {
      sets.push("min_format_score = ?");
      values.push(b.minFormatScore);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE quality_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Quality profile not found");
    res.json(qualityProfileFromRow(row));
  })
);

qualityProfilesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM quality_profiles WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Quality profile not found");
    res.status(204).send();
  })
);
