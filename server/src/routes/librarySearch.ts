import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { isRatingBlocked } from "../services/contentRatings.js";

import { toFts5Query } from "../services/mediaQuery.js";

export const librarySearchRouter = Router();

/**
 * Global search: one query fans out across every library's media items plus their
 * episodes/albums/issues/etc, and returns merged, deduped results. Something a single Starr app
 * can never offer since each only knows about its own media type. SQLite installs hit the FTS5
 * index (library_search_fts, see schema.sql) instead of a three-table leading-wildcard LIKE scan;
 * Postgres has no FTS5, so it keeps the original LIKE/ILIKE UNION ALL query.
 */
librarySearchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) throw new HttpError(400, "q query param is required");

    let rows: any[];
    if (db.dialect === "postgres") {
      const like = `%${q}%`;
      rows = (await db
        .prepare(
          `SELECT id AS "mediaItemId", type, title, year, poster_url AS "posterUrl", content_rating AS "contentRating", 'title' AS "matchedOn", NULL AS "matchDetail"
           FROM media_items WHERE title ILIKE ?
           UNION ALL
           SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'episode', e.title
           FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.title ILIKE ?
           UNION ALL
           SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'child', s.title
           FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.title ILIKE ?`
        )
        .all(like, like, like)) as any[];
    } else {
      const ftsQuery = toFts5Query(q);
      rows = ftsQuery
        ? ((await db
            .prepare(
              `SELECT m.id AS "mediaItemId", m.type, m.title, m.year, m.poster_url AS "posterUrl", m.content_rating AS "contentRating",
                      f.match_type AS "matchedOn", f.match_detail AS "matchDetail"
               FROM library_search_fts f
               JOIN media_items m ON m.id = f.media_item_id
               WHERE f.title MATCH ?
               LIMIT 300`
            )
            .all(ftsQuery)) as any[])
        : [];
    }

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
