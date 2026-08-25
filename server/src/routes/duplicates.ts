import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { dismissDuplicateGroup, findDuplicateGroups, mergeMediaItems } from "../services/duplicateCheck.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const duplicatesRouter = Router();
duplicatesRouter.use(requireAdmin);

/** GET /api/duplicates?type= — whole-library sweep for likely-duplicate media_items, grouped by
 * exact (normalized title, year). See services/duplicateCheck.ts for why this is exact-match
 * rather than the looser either-side-missing-a-year rule findPossibleDuplicates uses for pre-add
 * warnings — a merge is a lot harder to walk back than dismissing a warning. */
duplicatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    res.json(await findDuplicateGroups(type));
  })
);

/** POST /api/duplicates/merge — folds one or more loser items into a keeper: adopts a missing
 * file/metadata, reassigns episodes/sub-items/tags/collection-membership/history/etc. that don't
 * collide with something the keeper already has, then deletes the losers. `deleteFiles` recycles
 * any loser file that wasn't adopted (a second copy, a colliding episode/sub-item's file) instead
 * of leaving it on disk untracked. */
duplicatesRouter.post(
  "/merge",
  asyncHandler(async (req, res) => {
    const { keeperId, loserIds, deleteFiles } = req.body ?? {};
    if (!keeperId || !Array.isArray(loserIds) || loserIds.length === 0) {
      throw new HttpError(400, "keeperId and a non-empty loserIds array are required");
    }
    const result = await mergeMediaItems(Number(keeperId), loserIds.map(Number), !!deleteFiles);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "media_duplicates_merged", `merged ${result.merged} duplicate(s) into item ${keeperId}`);
    res.json(result);
  })
);

/** POST /api/duplicates/dismiss — "not a duplicate" / "remove from list, keep both": marks a
 * group's identity as dismissed so it stops appearing here (and stops triggering the scheduled
 * notification job) without touching either item — unlike /merge, nothing is deleted. */
duplicatesRouter.post(
  "/dismiss",
  asyncHandler(async (req, res) => {
    const { key } = req.body ?? {};
    if (!key || typeof key !== "string") throw new HttpError(400, "key is required");
    await dismissDuplicateGroup(key);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "media_duplicates_dismissed", `dismissed duplicate group "${key}"`);
    res.status(204).send();
  })
);
