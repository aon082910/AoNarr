import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { CONTENT_RATING_ORDER } from "../services/contentRatings.js";

export const contentRatingsRouter = Router();

contentRatingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(CONTENT_RATING_ORDER);
  })
);
