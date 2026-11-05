import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { ReleasePushInvalid, pushRelease } from "../services/releasePush.js";
import { releaseResources } from "../starr/releasePush.js";

/**
 * POST /api/releases/push: the native form of Starr's `POST /release/push`. A program that found a release hands it over;
 * AoNarr matches it to what the library wants, judges it as it judges a release of a feed and grabs it when it passes.
 * Body: { title, downloadUrl | magnetUrl, protocol: "Torrent" | "Usenet", publishDate, indexer?, indexerId?, size?, seeders?, leechers? }.
 * The answer is the list of release resources the Starr route gives (approved, rejected, temporarilyRejected, rejections).
 */
export const releasePushRouter = Router();
releasePushRouter.use(requireAdmin);

releasePushRouter.post(
  "/push",
  asyncHandler(async (req, res) => {
    try {
      res.json(await releaseResources(await pushRelease(req.body)));
    } catch (err) {
      if (err instanceof ReleasePushInvalid) throw new HttpError(400, err.message);
      throw err;
    }
  })
);
