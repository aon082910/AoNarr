import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { CONTENT_RATING_ORDER, contentRatingRank } from "../services/contentRatings.js";

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

    // A household account's library/rating restriction is part of the query itself (same
    // predicates buildMediaQuery uses) so it applies before any row is dropped or capped.
    const restrictions: string[] = [];
    const restrictionParams: unknown[] = [];
    if (!req.auth?.isAdmin) {
      const allowedTypes = req.auth?.user?.allowedTypes ?? [];
      if (allowedTypes.length === 0) {
        res.json([]);
        return;
      }
      restrictions.push(`m.type IN (${allowedTypes.map(() => "?").join(",")})`);
      restrictionParams.push(...allowedTypes);
      const maxRank = contentRatingRank(req.auth?.user?.maxContentRating ?? null);
      const blocked = maxRank === null ? [] : CONTENT_RATING_ORDER.filter((_, idx) => idx > maxRank);
      if (blocked.length > 0) {
        restrictions.push(`(m.content_rating IS NULL OR m.content_rating NOT IN (${blocked.map(() => "?").join(",")}))`);
        restrictionParams.push(...blocked);
      }
    }
    const andRestrictions = restrictions.map((r) => ` AND ${r}`).join("");

    let rows: any[];
    if (db.dialect === "postgres") {
      const like = `%${q}%`;
      rows = (await db
        .prepare(
          `SELECT m.id AS "mediaItemId", m.type, m.title, m.year, m.poster_url AS "posterUrl", m.content_rating AS "contentRating", 'title' AS "matchedOn", NULL AS "matchDetail"
           FROM media_items m WHERE m.title ILIKE ?${andRestrictions}
           UNION ALL
           SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'episode', e.title
           FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.title ILIKE ?${andRestrictions}
           UNION ALL
           SELECT m.id, m.type, m.title, m.year, m.poster_url, m.content_rating, 'child', s.title
           FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.title ILIKE ?${andRestrictions}`
        )
        .all(like, ...restrictionParams, like, ...restrictionParams, like, ...restrictionParams)) as any[];
    } else {
      const ftsQuery = toFts5Query(q);
      // One row per media item, picked in SQL: the FTS table holds a row per item, episode and
      // child, and FTS5 yields them oldest-first, so capping or deduping the raw hits afterwards
      // let a large old series crowd every other item (and every item a household can see) out.
      rows = ftsQuery
        ? ((await db
            .prepare(
              `SELECT m.id AS "mediaItemId", m.type, m.title, m.year, m.poster_url AS "posterUrl", m.content_rating AS "contentRating",
                      h.match_type AS "matchedOn", h.match_detail AS "matchDetail"
               FROM (
                 SELECT f.media_item_id, f.match_type, f.match_detail,
                        ROW_NUMBER() OVER (
                          PARTITION BY f.media_item_id
                          ORDER BY CASE WHEN f.match_type = 'title' THEN 0 ELSE 1 END, f.rowid
                        ) AS pick
                 FROM library_search_fts f
                 WHERE f.title MATCH ?
               ) h
               JOIN media_items m ON m.id = h.media_item_id
               WHERE h.pick = 1${andRestrictions}`
            )
            .all(ftsQuery, ...restrictionParams)) as any[])
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

    const results = Array.from(byId.values()).sort((a, b) => a.title.localeCompare(b.title));
    res.json(results.slice(0, 100));
  })
);
