import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { IMPORT_LIST_MEDIA_TYPES, syncImportList, type ImportListRow } from "../services/importLists.js";

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

/** The largest value a Postgres INTEGER column holds. */
const MAX_INTEGER_COLUMN = 2_147_483_647;

/** A list's own root folder from the request body: null or '' leaves the choice to auto-select;
 * anything else has to be an existing folder of a media type the list adds. */
async function rootFolderIdInput(value: unknown, listType: ImportListRow["type"]): Promise<number | null> {
  if (value === undefined || value === null || value === "") return null;
  const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(id) || id < 1 || id > MAX_INTEGER_COLUMN) {
    throw new HttpError(400, "rootFolderId must be a root folder's id, or null to pick one automatically");
  }
  const folder = (await db.prepare("SELECT media_type FROM root_folders WHERE id = ?").get(id)) as { media_type: string } | undefined;
  if (!folder) throw new HttpError(400, `Root folder ${id} doesn't exist`);
  const addable = IMPORT_LIST_MEDIA_TYPES[listType];
  if (!addable.includes(folder.media_type)) {
    throw new HttpError(400, `This list adds ${addable.join(" and ")} items, so it can't use a ${folder.media_type} root folder`);
  }
  return id;
}

importListsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, type, url, qualityProfileId, enabled, requireReview, minRating, minVotes, excludeGenres, rootFolderId } = req.body ?? {};
    if (!name || !url) throw new HttpError(400, "name and url are required");
    if (!Object.hasOwn(IMPORT_LIST_MEDIA_TYPES, type)) {
      throw new HttpError(400, "type must be 'trakt', 'imdb', 'lastfm' or 'tmdb'");
    }
    const listRootFolderId = await rootFolderIdInput(rootFolderId, type);

    const result = await db
      .prepare(
        `INSERT INTO import_lists (name, type, url, enabled, quality_profile_id, require_review, min_rating, min_votes, exclude_genres, root_folder_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        normalizeGenresInput(excludeGenres),
        listRootFolderId
      );
    const row = await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(row);
  })
);

importListsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(req.params.id)) as ImportListRow | undefined;
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
    // minRating/minVotes explicitly allow null (clearing the filter) via the same `!== undefined`
    // pattern already used for every field above.
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
    if (b.rootFolderId !== undefined) {
      sets.push("root_folder_id = ?");
      values.push(await rootFolderIdInput(b.rootFolderId, existing.type));
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
