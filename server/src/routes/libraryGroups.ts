import { Router } from "express";
import { db } from "../db/client.js";
import { libraryGroupFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { getMediaTypeConfig, isValidMediaType } from "../services/mediaTypes.js";

export const libraryGroupsRouter = Router();

function sortName(name: string): string {
  return name.toLowerCase();
}

/** Depth (0-indexed) a group sits at within its type's groupLevels, from its `kind`. */
function levelIndex(mediaType: string, kind: string): number {
  const levels = getMediaTypeConfig(mediaType).groupLevels ?? [];
  const idx = levels.indexOf(kind);
  if (idx === -1) throw new HttpError(400, `"${kind}" is not a group level for media type "${mediaType}"`);
  return idx;
}

/** Lists groups for a type, optionally scoped to one parent (omit parentId for top-level groups). */
libraryGroupsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { mediaType, parentId } = req.query as { mediaType?: string; parentId?: string };
    if (!mediaType || !isValidMediaType(mediaType)) throw new HttpError(400, "mediaType is required");

    const rows = parentId
      ? db.prepare("SELECT * FROM library_groups WHERE media_type = ? AND parent_group_id = ? ORDER BY sort_name").all(mediaType, parentId)
      : db.prepare("SELECT * FROM library_groups WHERE media_type = ? AND parent_group_id IS NULL ORDER BY sort_name").all(mediaType);

    res.json((rows as any[]).map(libraryGroupFromRow));
  })
);

/** One group plus its full breadcrumb (root-first) and immediate child groups (if this isn't the
 * deepest level) or item count (if it is). */
libraryGroupsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id) as any;
    if (!row) throw new HttpError(404, "Group not found");

    const breadcrumb: ReturnType<typeof libraryGroupFromRow>[] = [];
    let cur = row;
    while (cur) {
      breadcrumb.unshift(libraryGroupFromRow(cur));
      cur = cur.parent_group_id ? db.prepare("SELECT * FROM library_groups WHERE id = ?").get(cur.parent_group_id) : null;
    }

    const levels = getMediaTypeConfig(row.media_type).groupLevels ?? [];
    const depth = levelIndex(row.media_type, row.kind);
    const isDeepest = depth === levels.length - 1;

    res.json({
      group: libraryGroupFromRow(row),
      breadcrumb,
      isDeepestLevel: isDeepest,
      nextKind: isDeepest ? null : levels[depth + 1],
    });
  })
);

libraryGroupsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { mediaType, kind, name, parentGroupId } = req.body ?? {};
    if (!mediaType || !isValidMediaType(mediaType)) throw new HttpError(400, "mediaType is required");
    if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
    const depth = levelIndex(mediaType, kind);

    if (depth === 0 && parentGroupId) throw new HttpError(400, "Top-level groups can't have a parent");
    if (depth > 0) {
      if (!parentGroupId) throw new HttpError(400, `A "${kind}" group needs a parentGroupId`);
      const parent = db.prepare("SELECT * FROM library_groups WHERE id = ?").get(parentGroupId) as any;
      if (!parent || parent.media_type !== mediaType) throw new HttpError(400, "parentGroupId is invalid for this media type");
      if (levelIndex(mediaType, parent.kind) !== depth - 1) {
        throw new HttpError(400, `parentGroupId must be a "${getMediaTypeConfig(mediaType).groupLevels![depth - 1]}" group`);
      }
    }

    const result = db
      .prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, parent_group_id) VALUES (?, ?, ?, ?, ?)")
      .run(mediaType, kind, name.trim(), sortName(name), parentGroupId ?? null);
    const row = db.prepare("SELECT * FROM library_groups WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(libraryGroupFromRow(row));
  })
);

libraryGroupsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Group not found");
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
    db.prepare("UPDATE library_groups SET name = ?, sort_name = ? WHERE id = ?").run(name.trim(), sortName(name), req.params.id);
    res.json(libraryGroupFromRow(db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id)));
  })
);

/** Deleting a group cascades to child groups (FK ON DELETE CASCADE) and orphans any media_items
 * directly under it (FK ON DELETE SET NULL) back to ungrouped rather than deleting them. */
libraryGroupsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM library_groups WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Group not found");
    res.status(204).send();
  })
);
