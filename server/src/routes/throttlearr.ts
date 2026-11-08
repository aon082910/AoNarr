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

/** Takes the whole settings object (as GET returns it); anything missing or invalid falls back to its default. */
throttlearrRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "The settings must be an object");
    const before = getThrottlearrSettings();
    const saved = saveThrottlearrSettings(req.body);
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
