import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { auditActor, logAuditEvent } from "../services/audit.js";
import { notifyQueueChanged } from "../services/realtime.js";
import { getThrottlearrSettings, saveThrottlearrSettings } from "../services/throttlearr/settings.js";
import { releaseHeldGrabsSafely } from "../services/throttlearr/release.js";
import { throttlearrStatus } from "../services/throttlearr/actions.js";

/**
 * Throttlearr's settings and its status for the Download Clients page. The held grabs themselves are a queue row
 * like any other (Activity), with the actions in routes/activity.ts.
 */
export const throttlearrRouter = Router();
throttlearrRouter.use(requireAdmin);

throttlearrRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(getThrottlearrSettings());
  })
);

/** The keys of the settings object, so a body with none of them (an empty object, the wrong content type) is refused. */
const KNOWN_KEYS = ["enabled", "dryRun", "holdAll", "maxHeldAgeHours", "bypassManual", "clients", "priority", "perTitleLimit", "preflight"];

/**
 * Takes the settings object (as GET returns it). A key left out keeps its current value, so a partial body changes only
 * what it names; an invalid value falls back to its default. A body with no known key at all is a mistake, not a reset.
 */
throttlearrRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "The settings must be an object");
    const body = req.body as Record<string, unknown>;
    if (!KNOWN_KEYS.some((key) => key in body)) throw new HttpError(400, `The settings need at least one of: ${KNOWN_KEYS.join(", ")}`);
    const before = getThrottlearrSettings();
    const merged: Record<string, unknown> = { ...before, ...body };
    // The two groups merge key by key as well, so { preflight: { strictIdentity: true } } does not switch the other checks off.
    for (const group of ["priority", "preflight"] as const) {
      const given = body[group];
      if (given && typeof given === "object" && !Array.isArray(given)) merged[group] = { ...before[group], ...(given as object) };
    }
    const saved = saveThrottlearrSettings(merged);
    const { userId, username } = auditActor(req);
    logAuditEvent(userId, username, "throttlearr.settings", `${saved.enabled ? (saved.dryRun ? "dry run" : "on") : "off"}${saved.holdAll ? ", hold everything" : ""}`);
    // Switching it off, or loosening a limit, frees grabs now instead of at the next minute.
    if (before.enabled !== saved.enabled || JSON.stringify(before.clients) !== JSON.stringify(saved.clients) || before.holdAll !== saved.holdAll) {
      void releaseHeldGrabsSafely().then(() => notifyQueueChanged());
    }
    res.json(saved);
  })
);

throttlearrRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await throttlearrStatus());
  })
);
