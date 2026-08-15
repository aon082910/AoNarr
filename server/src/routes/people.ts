import { Router } from "express";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { fetchPersonDetails } from "../services/metadata.js";

export const peopleRouter = Router();

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

    const libraryRows = db.prepare("SELECT id, type, external_ids FROM media_items WHERE type IN ('movie', 'series')").all() as {
      id: number;
      type: string;
      external_ids: string | null;
    }[];
    const byTmdbId = new Map<string, number>();
    for (const row of libraryRows) {
      if (!row.external_ids) continue;
      try {
        const parsed = JSON.parse(row.external_ids);
        if (parsed.tmdb) byTmdbId.set(`${row.type === "movie" ? "movie" : "series"}-${parsed.tmdb}`, row.id);
      } catch {
        // malformed external_ids on an old row — skip rather than crash the whole lookup
      }
    }

    const credits = details.credits.map((c) => ({
      ...c,
      libraryMediaItemId: byTmdbId.get(`${c.mediaType}-${c.tmdbId}`) ?? null,
    }));

    res.json({ ...details, credits });
  })
);
