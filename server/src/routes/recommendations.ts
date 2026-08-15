import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { getRecommendations } from "../services/recommendations.js";

export const recommendationsRouter = Router();
recommendationsRouter.use(requireAdmin);

recommendationsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await getRecommendations());
  })
);
