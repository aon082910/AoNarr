import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { qualityProfileFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { resetSearchBackoff } from "../services/searchBackoff.js";

export const qualityProfilesRouter = Router();
qualityProfilesRouter.use(requireAdmin);

/** A profile's allowed qualities must be a list of names, and its cutoff one of them: a cutoff outside
 * the list can never be met, so the quality picker and every upgrade check read it wrongly. */
function validateProfile(allowedQualities: unknown, cutoff: unknown): void {
  if (!Array.isArray(allowedQualities) || allowedQualities.some((q) => typeof q !== "string" || q === "")) {
    throw new HttpError(400, "allowedQualities must be a list of quality names");
  }
  if (typeof cutoff !== "string" || cutoff === "") throw new HttpError(400, "cutoff is required");
  if (allowedQualities.length > 0 && !allowedQualities.includes(cutoff)) {
    throw new HttpError(400, `The cutoff "${cutoff}" must be one of the allowed qualities`);
  }
}

function formatScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new HttpError(400, "minFormatScore must be a whole number");
  return n;
}

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
    validateProfile(b.allowedQualities, b.cutoff);
    const maxSizeGb = b.maxSizeGb === undefined || b.maxSizeGb === null || b.maxSizeGb === "" ? null : Number(b.maxSizeGb);
    const result = await db
      .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, max_size_gb, min_format_score, prefer_cutoff_quality) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        b.name,
        JSON.stringify(b.allowedQualities),
        b.cutoff,
        maxSizeGb,
        b.minFormatScore === undefined || b.minFormatScore === null ? 0 : formatScore(b.minFormatScore),
        b.preferCutoffQuality === false ? 0 : 1
      );
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
    if (b.allowedQualities !== undefined || b.cutoff !== undefined) {
      // Judged as the profile will read after the change.
      const existing = (await db.prepare("SELECT allowed_qualities, cutoff FROM quality_profiles WHERE id = ?").get(req.params.id)) as
        | { allowed_qualities: string; cutoff: string }
        | undefined;
      if (!existing) throw new HttpError(404, "Quality profile not found");
      const before = JSON.parse(existing.allowed_qualities) as string[];
      const wasValid = before.length === 0 || before.includes(existing.cutoff);
      // A profile saved before the cutoff was checked may already name one outside its list: editing the
      // list alone must still be possible, so it is judged only when the request sets the cutoff or the
      // profile was valid until now.
      if (b.cutoff !== undefined || wasValid) validateProfile(b.allowedQualities ?? before, b.cutoff ?? existing.cutoff);
      else if (!Array.isArray(b.allowedQualities) || b.allowedQualities.some((q: unknown) => typeof q !== "string" || q === "")) throw new HttpError(400, "allowedQualities must be a list of quality names");
    }
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
      values.push(formatScore(b.minFormatScore));
    }
    if (b.preferCutoffQuality !== undefined) {
      sets.push("prefer_cutoff_quality = ?");
      values.push(b.preferCutoffQuality ? 1 : 0);
    }
    if (b.maxSizeGb !== undefined) {
      sets.push("max_size_gb = ?");
      values.push(b.maxSizeGb === null || b.maxSizeGb === "" ? null : Number(b.maxSizeGb));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE quality_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      // What can be grabbed has changed: targets the searches kept finding nothing for are searched again.
      await resetSearchBackoff();
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
