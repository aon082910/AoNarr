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

importListsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, type, url, qualityProfileId, enabled } = req.body ?? {};
    if (!name || !url) throw new HttpError(400, "name and url are required");
    if (type !== "trakt" && type !== "imdb" && type !== "lastfm") throw new HttpError(400, "type must be 'trakt', 'imdb' or 'lastfm'");

    const result = await db
      .prepare("INSERT INTO import_lists (name, type, url, enabled, quality_profile_id) VALUES (?, ?, ?, ?, ?)")
      .run(name, type, url, enabled === false ? 0 : 1, qualityProfileId ?? null);
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
    await db
      .prepare(
        `UPDATE import_lists SET
         name = COALESCE(?, name),
         url = COALESCE(?, url),
         enabled = COALESCE(?, enabled),
         quality_profile_id = COALESCE(?, quality_profile_id)
       WHERE id = ?`
      )
      .run(b.name ?? null, b.url ?? null, b.enabled === undefined ? null : b.enabled ? 1 : 0, b.qualityProfileId ?? null, req.params.id);

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
