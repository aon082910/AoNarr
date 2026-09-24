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
      // Quality names are a fixed vocabulary, not labels: the release parser emits exactly these
      // strings ("Bluray-1080p", ...), and profiles and every file's quality column reference them
      // by name. A renamed tier matched nothing ever again — its releases ranked below SD and its
      // existing files turned "cutoff unmet" — so renaming is refused rather than half-applied.
      const current = (await db.prepare("SELECT name FROM qualities WHERE id = ?").get(req.params.id)) as { name: string } | undefined;
      if (current && b.name !== current.name) throw new HttpError(400, "Quality names can't be changed — they must match what the release parser detects");
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
 * the name is dropped from its allowed list (replaced by the nearest-ranked remaining tier, lower
 * first, if that empties the list), and a cutoff that WAS this tier moves DOWN to the best allowed
 * tier ranked below it (else the lowest allowed one). Picking the top of the list instead — the
 * first version of this route — could turn a 1080p profile's cutoff into Remux-2160p and mark the
 * whole library "cutoff unmet". Files still recorded at the deleted tier become unranked, which
 * upgradeCandidates.ts deliberately never treats as below cutoff.
 */
qualitiesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const quality = (await db.prepare("SELECT * FROM qualities WHERE id = ?").get(req.params.id)) as any;
    if (!quality) throw new HttpError(404, "Quality not found");

    const { c: totalCount } = (await db.prepare("SELECT COUNT(*) as c FROM qualities").get()) as { c: number };
    if (Number(totalCount) <= 1) throw new HttpError(400, "Can't delete the last remaining quality");
    const deletedRank = Number(quality.rank);

    await db.transaction(async () => {
      await db.prepare("DELETE FROM qualities WHERE id = ?").run(req.params.id);

      const remaining = ((await db.prepare("SELECT name, rank FROM qualities ORDER BY rank DESC").all()) as { name: string; rank: number }[]).map(
        (r) => ({ name: r.name, rank: Number(r.rank) })
      );
      // Highest-ranked below the deleted tier, else the lowest-ranked above it.
      const nearest = remaining.find((r) => r.rank < deletedRank) ?? [...remaining].reverse().find((r) => r.rank > deletedRank) ?? remaining[0];
      const profiles = (await db.prepare("SELECT * FROM quality_profiles").all()) as any[];

      for (const profile of profiles) {
        const allowed: string[] = JSON.parse(profile.allowed_qualities);
        if (!allowed.includes(quality.name) && profile.cutoff !== quality.name) continue;

        let newAllowed = allowed.filter((name: string) => name !== quality.name);
        const emptied = newAllowed.length === 0;
        if (emptied) newAllowed = [nearest.name];
        let newCutoff = profile.cutoff;
        if (profile.cutoff === quality.name || emptied) {
          const allowedRanked = remaining.filter((r) => newAllowed.includes(r.name));
          newCutoff = (allowedRanked.find((r) => r.rank < deletedRank) ?? allowedRanked[allowedRanked.length - 1] ?? nearest).name;
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
