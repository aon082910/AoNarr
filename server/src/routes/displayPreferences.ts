import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { displayPreferences } from "../services/displayPreferences.js";

/** Open to every signed-in user (mounted behind requireAuth only): the UI formats every date with these, and they hold nothing private. */
export const displayPreferencesRouter = Router();

displayPreferencesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(displayPreferences());
  })
);
