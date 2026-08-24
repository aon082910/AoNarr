import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isRatingBlocked } from "../services/contentRatings.js";

export const librarySearchRouter = Router();

/**
 * Global search: one query fans out across every library's media items plus their
 * episodes/albums/issues/etc, and returns merged, deduped results. Something a single Starr app
 * can never offer since each only knows about its own media type.
 */
librarySearchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) throw new HttpError(400, "q query param is required");
    const like = `%${q}%`;
    // SQLite's LIKE is case-insensitive for ASCII by default; Postgres's is case-sensitive —
    // ILIKE is the Postgres-only equivalent that keeps this global search case-insensitive there too.
    const likeOp = db.dialect === "postgres" ? "ILIKE" : "LIKE";

    const rows = (await db
      .prepare(
        `SELECT id AS "mediaItemId", type, title, year, poster_url AS "posterUrl", content_rating AS "contentRating", 'title' AS "matchedOn", NULL AS "matchDetail"
         FROM media_items WHERE title ${likeOp} ?
         UNION ALL
         SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'episode', e.title
         FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.title ${likeOp} ?
         UNION ALL
         SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'child', s.title
         FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.title ${likeOp} ?`
      )
      .all(like, like, like)) as any[];

    const byId = new Map<number, any>();
    for (const row of rows) {
      const existing = byId.get(row.mediaItemId);
      // Prefer a direct title match over a child match if both exist for the same item.
      if (!existing || (existing.matchedOn !== "title" && row.matchedOn === "title")) {
        byId.set(row.mediaItemId, row);
      }
    }

    let results = Array.from(byId.values()).sort((a, b) => a.title.localeCompare(b.title));

    if (!req.auth?.isAdmin) {
      const allowedTypes = req.auth?.user?.allowedTypes ?? [];
      results = results.filter((r) => allowedTypes.includes(r.type));
      const maxRating = req.auth?.user?.maxContentRating;
      if (maxRating) results = results.filter((r) => !isRatingBlocked(r.contentRating, maxRating));
    }

    res.json(results.slice(0, 100));
  })
);
