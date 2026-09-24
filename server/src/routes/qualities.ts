import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { qualityFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { invalidateQualityRankCache } from "../services/quality.js";

export const qualitiesRouter = Router();
qualitiesRouter.use(requireAdmin);

qualitiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM qualities ORDER BY rank").all();
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
      await db.prepare(`UPDATE qualities SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM qualities WHERE id = ?").get(req.params.id);
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
    const existingIds = new Set(((await db.prepare("SELECT id FROM qualities").all()) as { id: number }[]).map((r) => r.id));
    if (orderedIds.length !== existingIds.size || !orderedIds.every((id) => existingIds.has(id))) {
      throw new HttpError(400, "orderedIds must include every existing quality id exactly once");
    }

    // rank has a UNIQUE constraint, so writing final ranks directly can collide mid-transaction
    // with another row's not-yet-updated rank (e.g. swapping two adjacent ranks). Stage through
    // negative placeholders first so no intermediate write can collide with an existing value.
    await db.transaction(async () => {
      for (let index = 0; index < orderedIds.length; index++) {
        await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(-(index + 1), orderedIds[index]);
      }
      for (let rank = 0; rank < orderedIds.length; rank++) {
        await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(rank, orderedIds[rank]);
      }
    });

    invalidateQualityRankCache();
    const rows = await db.prepare("SELECT * FROM qualities ORDER BY rank").all();
    res.json(rows.map(qualityFromRow));
  })
);

/**
 * Deletes one of the seeded/custom quality tiers (e.g. "Remux-2160p"). allowed_qualities and
 * cutoff on quality_profiles reference qualities by NAME, not a foreign key, so nothing cascades
 * automatically — every profile that allowed or cut off at this quality is patched here instead:
 * the name is dropped from its allowed list (falling back to the single highest-ranked remaining
 * quality if that empties the list entirely), and its cutoff is moved down to the highest-ranked
 * quality still in that list whenever the old cutoff no longer is.
 */
qualitiesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const quality = (await db.prepare("SELECT * FROM qualities WHERE id = ?").get(req.params.id)) as any;
    if (!quality) throw new HttpError(404, "Quality not found");

    const { c: totalCount } = (await db.prepare("SELECT COUNT(*) as c FROM qualities").get()) as { c: number };
    if (totalCount <= 1) throw new HttpError(400, "Can't delete the last remaining quality");

    await db.transaction(async () => {
      await db.prepare("DELETE FROM qualities WHERE id = ?").run(req.params.id);

      const remaining = (await db.prepare("SELECT name FROM qualities ORDER BY rank DESC").all()) as { name: string }[];
      const highestOverall = remaining[0].name;
      const profiles = (await db.prepare("SELECT * FROM quality_profiles").all()) as any[];

      for (const profile of profiles) {
        const allowed: string[] = JSON.parse(profile.allowed_qualities);
        if (!allowed.includes(quality.name) && profile.cutoff !== quality.name) continue;

        let newAllowed = allowed.filter((name: string) => name !== quality.name);
        if (newAllowed.length === 0) newAllowed = [highestOverall];
        let newCutoff = profile.cutoff;
        if (!newAllowed.includes(newCutoff)) {
          newCutoff = remaining.find((r) => newAllowed.includes(r.name))?.name ?? highestOverall;
        }

        await db
          .prepare("UPDATE quality_profiles SET allowed_qualities = ?, cutoff = ? WHERE id = ?")
          .run(JSON.stringify(newAllowed), newCutoff, profile.id);
      }
    });

    invalidateQualityRankCache();
    res.status(204).send();
  })
);
