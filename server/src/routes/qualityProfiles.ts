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
    const maxSizeGb = b.maxSizeGb === undefined || b.maxSizeGb === null || b.maxSizeGb === "" ? null : Number(b.maxSizeGb);
    const result = await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, max_size_gb) VALUES (?, ?, ?, ?)")
      .run(b.name, JSON.stringify(b.allowedQualities), b.cutoff, maxSizeGb);
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
    if (b.maxSizeGb !== undefined) {
      sets.push("max_size_gb = ?");
      values.push(b.maxSizeGb === null || b.maxSizeGb === "" ? null : Number(b.maxSizeGb));
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
    const profile = (await db.prepare("SELECT id, name FROM quality_profiles WHERE id = ?").get(req.params.id)) as
      | { id: number; name: string }
      | undefined;
    if (!profile) throw new HttpError(404, "Quality profile not found");

    // Both references are ON DELETE SET NULL, and an item with no profile is auto-searched with no
    // quality restriction at all (first result wins), so an in-use profile is never deleted.
    const usage = (await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM media_items WHERE quality_profile_id = ?) AS items,
                (SELECT COUNT(*) FROM import_lists WHERE quality_profile_id = ?) AS lists`
      )
      .get(profile.id, profile.id)) as { items: number | string; lists: number | string };
    const items = Number(usage.items);
    const lists = Number(usage.lists);
    if (items > 0 || lists > 0) {
      const users = [
        items > 0 ? `${items} media item${items === 1 ? "" : "s"}` : null,
        lists > 0 ? `${lists} import list${lists === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      throw new HttpError(
        409,
        `Quality profile "${profile.name}" is still used by ${users.join(" and ")}. Move them to another profile before deleting it.`
      );
    }

    await db.prepare("DELETE FROM quality_profiles WHERE id = ?").run(profile.id);
    res.status(204).send();
  })
);
