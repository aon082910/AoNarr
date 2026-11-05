import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import {
  AutoTagInputError,
  autoTagMeta,
  createAutoTagRule,
  deleteAutoTagRule,
  getAutoTagRule,
  lastApplyOf,
  listAutoTagRules,
  previewAutoTagRule,
  startAutoTagApply,
  updateAutoTagRule,
  type AutoTagRule,
} from "../services/autoTag.js";

/**
 * Auto tagging rules (Sonarr's and Radarr's "Auto Tagging"): a rule gives the titles that meet its conditions (library type,
 * genre, import list) its tags. Admin only, like the tags themselves. See services/autoTag.ts for what a rule does and
 * what it leaves alone.
 */
export const autoTagRulesRouter = Router();
autoTagRulesRouter.use(requireAdmin);

/** A request the caller got wrong is a 400 (a name that is taken, a 409) with the message, not a 500. */
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AutoTagInputError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

function ruleId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, "Auto tagging rule not found");
  return id;
}

async function requireRule(raw: string): Promise<AutoTagRule> {
  const rule = await getAutoTagRule(ruleId(raw));
  if (!rule) throw new HttpError(404, "Auto tagging rule not found");
  return rule;
}

const withLastApply = (rule: AutoTagRule) => ({ ...rule, lastApply: lastApplyOf(rule.id) });

/** The library types, the genres in the library and the import lists, for the rule form. */
autoTagRulesRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    res.json(await autoTagMeta());
  })
);

autoTagRulesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json((await listAutoTagRules()).map(withLastApply));
  })
);

autoTagRulesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const created = await checked(() => createAutoTagRule(req.body ?? {}));
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "auto_tag_rule_added", created.name);
    res.status(201).json(withLastApply(created));
  })
);

autoTagRulesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = ruleId(req.params.id);
    const updated = await checked(() => updateAutoTagRule(id, req.body ?? {}));
    if (!updated) throw new HttpError(404, "Auto tagging rule not found");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "auto_tag_rule_updated", updated.name);
    res.json(withLastApply(updated));
  })
);

autoTagRulesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const rule = await requireRule(req.params.id);
    if (!(await deleteAutoTagRule(rule.id))) throw new HttpError(404, "Auto tagging rule not found");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "auto_tag_rule_removed", rule.name);
    res.status(204).send();
  })
);

/** What the rule would change in the library right now: counts and up to 20 example titles. Writes nothing. */
autoTagRulesRouter.post(
  "/:id/preview",
  asyncHandler(async (req, res) => {
    res.json(await previewAutoTagRule(await requireRule(req.params.id)));
  })
);

/**
 * Applies the rule to the titles already in the library, as a background job (progress in the Background Jobs widget, the
 * counts in the rule's `lastApply`). A switched-off rule is refused: it would write tags nothing else would keep in step.
 */
autoTagRulesRouter.post(
  "/:id/apply",
  asyncHandler(async (req, res) => {
    const rule = await requireRule(req.params.id);
    if (!rule.enabled) throw new HttpError(409, "Switch the rule on before applying it to the library");
    const outcome = await startAutoTagApply(rule);
    if (outcome.started) {
      const actor = auditActor(req);
      logAuditEvent(actor.userId, actor.username, "auto_tag_rule_applied", rule.name);
    }
    res.json(outcome);
  })
);
