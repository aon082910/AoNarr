import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { config } from "../config.js";

export const updateCheckRouter = Router();
updateCheckRouter.use(requireAdmin);

const DOCKER_HUB_REPO = "allornothing/aonarr";

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

    const hubRes = await fetch(`https://hub.docker.com/v2/repositories/${DOCKER_HUB_REPO}/tags/${config.imageTag}`);
    if (!hubRes.ok) {
      res.json({ supported: true, checked: false, reason: `Docker Hub lookup failed: HTTP ${hubRes.status}` });
      return;
    }
    const body = (await hubRes.json()) as { tag_last_pushed?: string; last_updated?: string };
    const latestPushedAt = body.tag_last_pushed ?? body.last_updated ?? null;

    const updateAvailable =
      !!latestPushedAt && !!config.buildTime && new Date(latestPushedAt).getTime() > new Date(config.buildTime).getTime();

    res.json({
      supported: true,
      checked: true,
      imageTag: config.imageTag,
      currentBuildTime: config.buildTime,
      latestPushedAt,
      updateAvailable,
    });
  })
);
