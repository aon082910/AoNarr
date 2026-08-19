import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { getSetting } from "../services/settingsStore.js";

/** Fully public (no auth) — this is how the login screen and the main app both pick up an
 * admin-configured custom theme, via a plain <link rel="stylesheet"> in index.html. CSS isn't
 * sensitive, so there's no reason to gate it behind a session. */
export const themeRouter = Router();

themeRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const css = getSetting("customThemeCss") ?? "";
    res.setHeader("Content-Type", "text/css");
    res.setHeader("Cache-Control", "no-cache");
    res.send(css);
  })
);
