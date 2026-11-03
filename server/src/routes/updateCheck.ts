import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { config } from "../config.js";
import { checkForUpdate } from "../services/updateCheck.js";

export const updateCheckRouter = Router();
updateCheckRouter.use(requireAdmin);

// Same checker as the System page and the daily notifier (services/updateCheck.ts), so the three
// can no longer give different answers.
updateCheckRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    if (!config.imageTag) {
      res.json({
        supported: false,
        reason: "This image wasn't built with version info baked in (likely a local/dev build).",
      });
      return;
    }

    let result;
    try {
      result = await checkForUpdate();
    } catch (err) {
      res.json({ supported: true, checked: false, reason: (err as Error).message });
      return;
    }

    res.json({
      supported: true,
      checked: true,
      imageTag: result.imageTag,
      currentBuildTime: result.currentBuildTime,
      latestPushedAt: result.latestPushedAt,
      updateAvailable: result.updateAvailable,
    });
  })
);
