import { Router } from "express";
import { db } from "../db/client.js";
import { collectionFromRow, mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";

export const collectionsRouter = Router();

interface SmartFilter {
  type?: string;
  monitored?: 0 | 1;
  hasFile?: 0 | 1;
  tagId?: number;
  addedAfterDays?: number;
}

/** Runs a smart collection's saved filter live against media_items — re-evaluated on every view,
 * unlike a normal collection's fixed collection_items membership. Kept to the same handful of
 * fields the Library page's own filters already support, so it stays predictable rather than
 * growing into a full query language. */
function queryMediaItemsForFilter(filter: SmartFilter): any[] {
  const clauses: string[] = [];
  const params: any[] = [];
  let joinTags = "";

  if (filter.type) {
    clauses.push("m.type = ?");
    params.push(filter.type);
  }
  if (filter.monitored !== undefined) {
    clauses.push("m.monitored = ?");
    params.push(filter.monitored);
  }
  if (filter.hasFile !== undefined) {
    clauses.push("m.has_file = ?");
    params.push(filter.hasFile);
  }
  if (filter.tagId !== undefined) {
    joinTags = "JOIN media_item_tags mit ON mit.media_item_id = m.id";
    clauses.push("mit.tag_id = ?");
    params.push(filter.tagId);
  }
  if (filter.addedAfterDays !== undefined) {
    clauses.push("m.added_at >= datetime('now', ?)");
    params.push(`-${filter.addedAfterDays} days`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT m.* FROM media_items m ${joinTags} ${where} ORDER BY m.sort_title`).all(...params);
}

collectionsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT c.*, COUNT(ci.media_item_id) AS itemCount
         FROM collections c
         LEFT JOIN collection_items ci ON ci.collection_id = c.id
         GROUP BY c.id
         ORDER BY c.name`
      )
      .all() as any[];
    res.json(
      rows.map((r) => {
        const collection = collectionFromRow(r);
        const itemCount = collection.smartFilter ? queryMediaItemsForFilter(collection.smartFilter).length : r.itemCount;
        return { ...collection, itemCount };
      })
    );
  })
);

collectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const result = db
      .prepare("INSERT INTO collections (name, description, smart_filter) VALUES (?, ?, ?)")
      .run(b.name, b.description ?? null, b.smartFilter ? JSON.stringify(b.smartFilter) : null);
    const row = db.prepare("SELECT * FROM collections WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(collectionFromRow(row));
  })
);

collectionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id) as any;
    if (!row) throw new HttpError(404, "Collection not found");
    const collection = collectionFromRow(row);

    const items = (
      collection.smartFilter
        ? queryMediaItemsForFilter(collection.smartFilter)
        : (db
            .prepare(
              `SELECT m.* FROM media_items m
               JOIN collection_items ci ON ci.media_item_id = m.id
               WHERE ci.collection_id = ?
               ORDER BY ci.position, m.sort_title`
            )
            .all(req.params.id) as any[])
    ).map(mediaItemFromRow);

    res.json({ ...collection, items });
  })
);

collectionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.description !== undefined) {
      sets.push("description = ?");
      values.push(b.description);
    }
    if (b.retentionDays !== undefined) {
      sets.push("retention_days = ?");
      values.push(b.retentionDays === null ? null : Number(b.retentionDays));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Collection not found");
    res.json(collectionFromRow(row));
  })
);

collectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM collections WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Collection not found");
    res.status(204).send();
  })
);

function assertNotSmart(row: any): void {
  if (row?.smart_filter) {
    throw new HttpError(400, "This is a smart collection — its membership is computed from its filter, not manually editable");
  }
}

collectionsRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const mediaItemId = req.body?.mediaItemId;
    if (!mediaItemId) throw new HttpError(400, "mediaItemId is required");
    const collection = db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id) as any;
    if (!collection) throw new HttpError(404, "Collection not found");
    assertNotSmart(collection);
    const maxPosition = (
      db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM collection_items WHERE collection_id = ?").get(
        req.params.id
      ) as { m: number }
    ).m;
    db.prepare(
      "INSERT OR IGNORE INTO collection_items (collection_id, media_item_id, position) VALUES (?, ?, ?)"
    ).run(req.params.id, mediaItemId, maxPosition + 1);
    res.status(201).send();
  })
);

collectionsRouter.delete(
  "/:id/items/:mediaItemId",
  asyncHandler(async (req, res) => {
    db.prepare("DELETE FROM collection_items WHERE collection_id = ? AND media_item_id = ?").run(
      req.params.id,
      req.params.mediaItemId
    );
    res.status(204).send();
  })
);

/** Reorders a collection's items — body: { orderedIds: number[] } of media item ids in the
 * desired order (must be exactly the collection's current membership). */
collectionsRouter.put(
  "/:id/items/order",
  asyncHandler(async (req, res) => {
    const collectionRow = db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id) as any;
    if (!collectionRow) throw new HttpError(404, "Collection not found");
    assertNotSmart(collectionRow);

    const orderedIds: number[] = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new HttpError(400, "orderedIds is required");
    }
    const update = db.prepare("UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_item_id = ?");
    const reorder = db.transaction((ids: number[]) => {
      ids.forEach((mediaItemId, index) => update.run(index, req.params.id, mediaItemId));
    });
    reorder(orderedIds);
    res.status(204).send();
  })
);

const M3U_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".wav", ".ogg", ".mp4", ".mkv", ".avi", ".mov", ".webm"]);

/**
 * Exports a collection as an ordered list — `?format=m3u` for a playable audio/video playlist
 * (only items with a resolved on-disk file; items without one, or without a playable extension,
 * are silently skipped and counted separately) or `?format=json` (default) for a plain
 * ordered watch-list of every item regardless of file availability.
 */
collectionsRouter.get(
  "/:id/export",
  asyncHandler(async (req, res) => {
    const collectionRow = db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id) as any;
    if (!collectionRow) throw new HttpError(404, "Collection not found");
    const collection = collectionFromRow(collectionRow);

    const items = (
      collection.smartFilter
        ? queryMediaItemsForFilter(collection.smartFilter)
        : (db
            .prepare(
              `SELECT m.* FROM media_items m
               JOIN collection_items ci ON ci.media_item_id = m.id
               WHERE ci.collection_id = ?
               ORDER BY ci.position, m.sort_title`
            )
            .all(req.params.id) as any[])
    ).map(mediaItemFromRow);

    if (req.query.format === "m3u") {
      const lines = ["#EXTM3U"];
      let skipped = 0;
      for (const item of items) {
        const ext = item.path ? item.path.slice(item.path.lastIndexOf(".")).toLowerCase() : "";
        if (!item.path || !M3U_EXTENSIONS.has(ext)) {
          skipped++;
          continue;
        }
        lines.push(`#EXTINF:-1,${item.title}${item.year ? ` (${item.year})` : ""}`);
        lines.push(item.path);
      }
      if (skipped > 0) lines.splice(1, 0, `# ${skipped} item(s) skipped — no downloaded file on disk`);

      res.set("Content-Type", "audio/x-mpegurl");
      res.set("Content-Disposition", `attachment; filename="${collection.name.replace(/[^\w.-]/g, "_")}.m3u"`);
      res.send(lines.join("\n"));
      return;
    }

    res.json({
      name: collection.name,
      items: items.map((item, index) => ({ order: index + 1, title: item.title, year: item.year, type: item.type })),
    });
  })
);
