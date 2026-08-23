import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { qualityFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { invalidateQualityRankCache } from "../services/quality.js";

export const qualitiesRouter = Router();
qualitiesRouter.use(requireAdmin);

qualitiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT * FROM qualities ORDER BY rank").all();
    res.json(rows.map(qualityFromRow));
  })
);

qualitiesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.minSizeMb !== undefined) {
      sets.push("min_size_mb = ?");
      values.push(b.minSizeMb);
    }
    if (b.maxSizeMb !== undefined) {
      sets.push("max_size_mb = ?");
      values.push(b.maxSizeMb);
    }
    if (b.preferredSizeMb !== undefined) {
      sets.push("preferred_size_mb = ?");
      values.push(b.preferredSizeMb);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE qualities SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM qualities WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Quality not found");
    invalidateQualityRankCache();
    res.json(qualityFromRow(row));
  })
);

/** Rewrites rank for every quality to match the given order (worst to best). */
qualitiesRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const orderedIds = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new HttpError(400, "orderedIds (array) is required");
    }
    const existingIds = new Set(
      (db.prepare("SELECT id FROM qualities").all() as { id: number }[]).map((r) => r.id)
    );
    if (orderedIds.length !== existingIds.size || !orderedIds.every((id) => existingIds.has(id))) {
      throw new HttpError(400, "orderedIds must include every existing quality id exactly once");
    }

    // rank has a UNIQUE constraint, so writing final ranks directly can collide mid-transaction
    // with another row's not-yet-updated rank (e.g. swapping two adjacent ranks). Stage through
    // negative placeholders first so no intermediate write can collide with an existing value.
    const update = db.prepare("UPDATE qualities SET rank = ? WHERE id = ?");
    const updateMany = db.transaction((ids: number[]) => {
      ids.forEach((id, index) => update.run(-(index + 1), id));
      ids.forEach((id, rank) => update.run(rank, id));
    });
    updateMany(orderedIds);

    invalidateQualityRankCache();
    const rows = db.prepare("SELECT * FROM qualities ORDER BY rank").all();
    res.json(rows.map(qualityFromRow));
  })
);
