import { Router } from "express";
import { db } from "../db/index.js";
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

/**
 * have/missing/total media_items nested under each group of a media type, rolled up through
 * arbitrarily many levels of parent_group_id (e.g. a System's count includes every Game under
 * every Company under it, not just items directly attached to the System itself) — one recursive
 * CTE walks every (ancestor, descendant) group pair, then joins media_items on the descendant.
 */
async function groupCounts(mediaType: string): Promise<Map<number, { total: number; have: number }>> {
  const rows = (await db
    .prepare(
      `WITH RECURSIVE anc(id, desc_id) AS (
         SELECT id, id FROM library_groups WHERE media_type = ?
         UNION ALL
         SELECT anc.id, lg.id FROM anc JOIN library_groups lg ON lg.parent_group_id = anc.desc_id
       )
       SELECT anc.id AS group_id, COUNT(mi.id) AS total, COALESCE(SUM(mi.has_file), 0) AS have
       FROM anc
       LEFT JOIN media_items mi ON mi.group_id = anc.desc_id
       GROUP BY anc.id`
    )
    .all(mediaType)) as { group_id: number; total: number; have: number }[];
  return new Map(rows.map((r) => [r.group_id, { total: Number(r.total), have: Number(r.have) }]));
}

/** Lists groups for a type, optionally scoped to one parent (omit parentId for top-level groups). */
libraryGroupsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { mediaType, parentId } = req.query as { mediaType?: string; parentId?: string };
    if (!mediaType || !isValidMediaType(mediaType)) throw new HttpError(400, "mediaType is required");

    const rows = parentId
      ? await db.prepare("SELECT * FROM library_groups WHERE media_type = ? AND parent_group_id = ? ORDER BY sort_name").all(mediaType, parentId)
      : await db.prepare("SELECT * FROM library_groups WHERE media_type = ? AND parent_group_id IS NULL ORDER BY sort_name").all(mediaType);

    const counts = await groupCounts(mediaType);
    res.json(
      (rows as any[]).map((row) => {
        const c = counts.get(row.id) ?? { total: 0, have: 0 };
        return { ...libraryGroupFromRow(row), itemCount: c.total, haveCount: c.have, missingCount: c.total - c.have };
      })
    );
  })
);

/** One group plus its full breadcrumb (root-first) and immediate child groups (if this isn't the
 * deepest level) or item count (if it is). */
libraryGroupsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Group not found");

    const breadcrumb: ReturnType<typeof libraryGroupFromRow>[] = [];
    let cur = row;
    while (cur) {
      breadcrumb.unshift(libraryGroupFromRow(cur));
      cur = cur.parent_group_id ? await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(cur.parent_group_id) : null;
    }

    const levels = getMediaTypeConfig(row.media_type).groupLevels ?? [];
    const depth = levelIndex(row.media_type, row.kind);
    const isDeepest = depth === levels.length - 1;
    const counts = (await groupCounts(row.media_type)).get(row.id) ?? { total: 0, have: 0 };

    res.json({
      group: { ...libraryGroupFromRow(row), itemCount: counts.total, haveCount: counts.have, missingCount: counts.total - counts.have },
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
      const parent = (await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(parentGroupId)) as any;
      if (!parent || parent.media_type !== mediaType) throw new HttpError(400, "parentGroupId is invalid for this media type");
      if (levelIndex(mediaType, parent.kind) !== depth - 1) {
        throw new HttpError(400, `parentGroupId must be a "${getMediaTypeConfig(mediaType).groupLevels![depth - 1]}" group`);
      }
    }

    const result = await db
      .prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, parent_group_id) VALUES (?, ?, ?, ?, ?)")
      .run(mediaType, kind, name.trim(), sortName(name), parentGroupId ?? null);
    const row = await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(libraryGroupFromRow(row));
  })
);

libraryGroupsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "Group not found");
    const { name, overview } = req.body ?? {};
    if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
    await db
      .prepare("UPDATE library_groups SET name = ?, sort_name = ?, overview = ? WHERE id = ?")
      .run(name.trim(), sortName(name), overview !== undefined ? overview || null : (existing as any).overview, req.params.id);
    res.json(libraryGroupFromRow(await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(req.params.id)));
  })
);

/** Deleting a group cascades to child groups (FK ON DELETE CASCADE) and orphans any media_items
 * directly under it (FK ON DELETE SET NULL) back to ungrouped rather than deleting them. */
libraryGroupsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM library_groups WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Group not found");
    res.status(204).send();
  })
);
