import { Router } from "express";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchPersonDetails } from "../services/metadata.js";
import { isRatingBlocked } from "../services/contentRatings.js";
import { getTmdbLibraryIndex } from "../services/mediaQuery.js";

export const peopleRouter = Router();

function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

/**
 * A TMDB person's bio + combined credits, cross-referenced against the local library (by TMDB id)
 * so each credit can show "in your library" and link straight to it, instead of just a flat list
 * of titles the admin would have to search for again.
 */
peopleRouter.get(
  "/:tmdbId",
  asyncHandler(async (req, res) => {
    let details;
    try {
      details = await fetchPersonDetails(req.params.tmdbId);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    const allowedTypes = allowedTypesFor(req);
    const maxContentRating = req.auth?.user?.maxContentRating ?? null;
    const tmdbIndex = await getTmdbLibraryIndex();
    const byTmdbId = new Map<string, number>();
    for (const [key, entry] of tmdbIndex) {
      // Same library-visibility gate every other route applies — without it, a restricted user
      // (no access to movies/series at all, or blocked from this item's content rating) still
      // learned "this is in your library" for a title they can't actually open.
      if (allowedTypes && !allowedTypes.includes(entry.type)) continue;
      if (maxContentRating && isRatingBlocked(entry.contentRating, maxContentRating)) continue;
      byTmdbId.set(key, entry.mediaItemId);
    }

    const credits = details.credits.map((c) => ({
      ...c,
      libraryMediaItemId: byTmdbId.get(`${c.mediaType}:${c.tmdbId}`) ?? null,
    }));

    res.json({ ...details, credits });
  })
);
