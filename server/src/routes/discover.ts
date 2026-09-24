import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchTrendingMovies, fetchTrendingSeries } from "../services/metadata.js";
import { isRatingBlocked } from "../services/contentRatings.js";

export const discoverRouter = Router();

/** Restricted users only see the library types an admin has granted them; admins see everything —
 * same convention as media.ts's allowedTypesFor. */
function allowedTypesFor(req: import("express").Request): string[] | null {
  if (req.auth?.isAdmin) return null;
  return req.auth?.user?.allowedTypes ?? [];
}

/**
 * Trending movies/TV for a browse-and-request page (Overseerr/Jellyseerr-style "Discover"),
 * instead of only search-then-request. Cross-references each result against the library by TMDB
 * id so the page can show "already in library" instead of offering to add/request a duplicate.
 */
discoverRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const allowedTypes = allowedTypesFor(req);
    const wantMovies = !allowedTypes || allowedTypes.includes("movie");
    const wantSeries = !allowedTypes || allowedTypes.includes("series");
    if (!wantMovies && !wantSeries) {
      res.json({ movies: [], series: [] });
      return;
    }

    try {
      const [movies, series] = await Promise.all([
        wantMovies ? fetchTrendingMovies() : Promise.resolve([]),
        wantSeries ? fetchTrendingSeries() : Promise.resolve([]),
      ]);

      const libraryRows = (await db
        .prepare("SELECT id, type, external_ids, content_rating FROM media_items WHERE type IN ('movie','series')")
        .all()) as {
        id: number;
        type: string;
        external_ids: string | null;
        content_rating: string | null;
      }[];
      // Maps to the item's real id (not just a membership flag) so the client can link a result
      // that's already in the library straight to its detail page instead of just labeling it.
      // A title above the viewer's content-rating cap is left out, same as people.ts — otherwise
      // its "In library" badge and link reveal an item that user can't open.
      const maxContentRating = req.auth?.user?.maxContentRating ?? null;
      const idByExternalId = new Map<string, number>();
      for (const r of libraryRows) {
        if (!r.external_ids) continue;
        if (maxContentRating && isRatingBlocked(r.content_rating, maxContentRating)) continue;
        try {
          const ids = JSON.parse(r.external_ids);
          if (ids?.tmdb) idByExternalId.set(`${r.type}:${ids.tmdb}`, r.id);
        } catch {
          // malformed external_ids on an old row — skip it rather than fail the whole page
        }
      }

      const annotate = (type: "movie" | "series", results: typeof movies) =>
        results.map((r) => {
          const mediaItemId = idByExternalId.get(`${type}:${r.externalIds.tmdb}`) ?? null;
          return { ...r, type, inLibrary: mediaItemId !== null, mediaItemId };
        });

      res.json({ movies: annotate("movie", movies), series: annotate("series", series) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);
