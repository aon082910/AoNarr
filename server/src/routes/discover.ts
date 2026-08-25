import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchTrendingMovies, fetchTrendingSeries } from "../services/metadata.js";

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

      const libraryRows = (await db.prepare("SELECT type, external_ids FROM media_items WHERE type IN ('movie','series')").all()) as {
        type: string;
        external_ids: string | null;
      }[];
      const inLibrary = new Set<string>();
      for (const r of libraryRows) {
        const ids = r.external_ids ? JSON.parse(r.external_ids) : {};
        if (ids.tmdb) inLibrary.add(`${r.type}:${ids.tmdb}`);
      }

      const annotate = (type: "movie" | "series", results: typeof movies) =>
        results.map((r) => ({ ...r, type, inLibrary: inLibrary.has(`${type}:${r.externalIds.tmdb}`) }));

      res.json({ movies: annotate("movie", movies), series: annotate("series", series) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);
