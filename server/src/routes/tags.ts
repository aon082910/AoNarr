import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { tagFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const tagsRouter = Router();
tagsRouter.use(requireAdmin);

tagsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM tags ORDER BY name").all();
    res.json(rows.map(tagFromRow));
  })
);

tagsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = (req.body?.name ?? "").trim();
    if (!name) throw new HttpError(400, "name is required");
    await db.prepare(`INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name`).run(name);
    const row = await db.prepare("SELECT * FROM tags WHERE name = ?").get(name);
    res.status(201).json(tagFromRow(row));
  })
);

tagsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const retentionDays = req.body?.retentionDays;
    await db
      .prepare("UPDATE tags SET retention_days = ? WHERE id = ?")
      .run(retentionDays === null || retentionDays === undefined ? null : Number(retentionDays), req.params.id);
    const row = await db.prepare("SELECT * FROM tags WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Tag not found");
    res.json(tagFromRow(row));
  })
);

/**
 * release_profiles.tag_ids/indexer_ids are JSON arrays with no foreign key. A profile scoped only
 * to a deleted tag/indexer would otherwise match nothing ever again while the Settings UI (which
 * only lists ids that still exist) shows it as unrestricted — drop the id, and clear the scope to
 * NULL ("every tag/indexer", matching what the UI shows) once nothing is left.
 */
export async function removeReleaseProfileScopeId(column: "tag_ids" | "indexer_ids", id: number): Promise<void> {
  const profiles = (await db.prepare(`SELECT id, ${column} AS ids FROM release_profiles WHERE ${column} IS NOT NULL`).all()) as {
    id: number;
    ids: string;
  }[];
  for (const p of profiles) {
    let ids: unknown;
    try {
      ids = JSON.parse(p.ids);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    const remaining = ids.filter((x) => Number(x) !== id);
    if (remaining.length === ids.length) continue;
    await db
      .prepare(`UPDATE release_profiles SET ${column} = ? WHERE id = ?`)
      .run(remaining.length > 0 ? JSON.stringify(remaining) : null, p.id);
  }
}

tagsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    let deleted = false;
    await db.transaction(async () => {
      const result = await db.prepare("DELETE FROM tags WHERE id = ?").run(req.params.id);
      deleted = result.changes > 0;
      if (deleted) await removeReleaseProfileScopeId("tag_ids", Number(req.params.id));
    });
    if (!deleted) throw new HttpError(404, "Tag not found");
    res.status(204).send();
  })
);
