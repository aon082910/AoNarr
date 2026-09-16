import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { syncImportList, type ImportListRow } from "../services/importLists.js";

export const importListsRouter = Router();
importListsRouter.use(requireAdmin);

importListsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await db.prepare("SELECT * FROM import_lists ORDER BY name").all());
  })
);

/** Comma/newline-separated genre names as typed in the UI → a normalized JSON array (lowercased,
 * trimmed, empties dropped), or null when nothing was entered — matches how every source's own
 * genre list gets normalized before comparison in services/importLists.ts's passesListFilters. */
function normalizeGenresInput(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const genres = value
    .split(/[,\n]/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  return genres.length > 0 ? JSON.stringify(genres) : null;
}

importListsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, type, url, qualityProfileId, enabled, requireReview, minRating, minVotes, excludeGenres } = req.body ?? {};
    if (!name || !url) throw new HttpError(400, "name and url are required");
    if (!["trakt", "imdb", "lastfm", "tmdb"].includes(type)) {
      throw new HttpError(400, "type must be 'trakt', 'imdb', 'lastfm' or 'tmdb'");
    }

    const result = await db
      .prepare(
        `INSERT INTO import_lists (name, type, url, enabled, quality_profile_id, require_review, min_rating, min_votes, exclude_genres)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        type,
        url,
        enabled === false ? 0 : 1,
        qualityProfileId ?? null,
        requireReview ? 1 : 0,
        minRating === undefined || minRating === null || minRating === "" ? null : Number(minRating),
        minVotes === undefined || minVotes === null || minVotes === "" ? null : Number(minVotes),
        normalizeGenresInput(excludeGenres)
      );
    const row = await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(row);
  })
);

importListsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Import list not found");

    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.url !== undefined) {
      sets.push("url = ?");
      values.push(b.url);
    }
    if (b.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(b.enabled ? 1 : 0);
    }
    if (b.qualityProfileId !== undefined) {
      sets.push("quality_profile_id = ?");
      values.push(b.qualityProfileId);
    }
    if (b.requireReview !== undefined) {
      sets.push("require_review = ?");
      values.push(b.requireReview ? 1 : 0);
    }
    // minRating/minVotes explicitly allow null (clearing the filter), unlike the COALESCE-based
    // fields above which never distinguished "not sent" from "clear it" — this route is being
    // rewritten to explicit per-field sets rather than COALESCE specifically to support that.
    if (b.minRating !== undefined) {
      sets.push("min_rating = ?");
      values.push(b.minRating === null || b.minRating === "" ? null : Number(b.minRating));
    }
    if (b.minVotes !== undefined) {
      sets.push("min_votes = ?");
      values.push(b.minVotes === null || b.minVotes === "" ? null : Number(b.minVotes));
    }
    if (b.excludeGenres !== undefined) {
      sets.push("exclude_genres = ?");
      values.push(normalizeGenresInput(b.excludeGenres));
    }

    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE import_lists SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    res.json(await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(req.params.id));
  })
);

importListsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM import_lists WHERE id = ?").run(req.params.id);
    res.status(204).send();
  })
);

importListsRouter.post(
  "/:id/sync",
  asyncHandler(async (req, res) => {
    const list = (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(req.params.id)) as ImportListRow | undefined;
    if (!list) throw new HttpError(404, "Import list not found");
    const result = await syncImportList(list);
    res.json(result);
  })
);
