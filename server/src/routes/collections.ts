import { Router } from "express";
import { db } from "../db/index.js";
import { nowOffsetExpr } from "../db/asyncDb.js";
import { collectionFromRow, mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { isRatingBlocked } from "../services/contentRatings.js";

export const collectionsRouter = Router();

interface SmartFilter {
  type?: string;
  monitored?: 0 | 1;
  hasFile?: 0 | 1;
  tagId?: number;
  addedAfterDays?: number;
}

/** Household accounts can browse collections, but only ever see the member items their own
 * library/content-rating restrictions would let them open directly — same rules as GET /media/:id. */
function visibleTo(req: import("express").Request): (item: { type: string; contentRating: string | null }) => boolean {
  if (req.auth?.isAdmin) return () => true;
  const allowedTypes = req.auth?.user?.allowedTypes ?? [];
  const maxRating = req.auth?.user?.maxContentRating ?? null;
  return (item) => allowedTypes.includes(item.type) && !isRatingBlocked(item.contentRating, maxRating);
}

function sanitizeSmartFilter(raw: any): SmartFilter | null {
  if (!raw || typeof raw !== "object") return null;
  const out: SmartFilter = {};
  if (typeof raw.type === "string" && raw.type) out.type = raw.type;
  if (raw.monitored === 0 || raw.monitored === 1) out.monitored = raw.monitored;
  if (raw.hasFile === 0 || raw.hasFile === 1) out.hasFile = raw.hasFile;
  if (Number.isInteger(Number(raw.tagId)) && raw.tagId !== "" && raw.tagId !== null) out.tagId = Number(raw.tagId);
  const days = Number(raw.addedAfterDays);
  if (raw.addedAfterDays !== undefined && raw.addedAfterDays !== null && raw.addedAfterDays !== "" && Number.isFinite(days) && days >= 0) {
    out.addedAfterDays = Math.floor(days);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Runs a smart collection's saved filter live against media_items — re-evaluated on every view,
 * unlike a normal collection's fixed collection_items membership. Kept to the same handful of
 * fields the Library page's own filters already support, so it stays predictable rather than
 * growing into a full query language. */
async function queryMediaItemsForFilter(filter: SmartFilter): Promise<any[]> {
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
    clauses.push(`m.added_at >= ${nowOffsetExpr(db, -filter.addedAfterDays)}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT m.* FROM media_items m ${joinTags} ${where} ORDER BY m.sort_title`).all(...params);
}

collectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const visible = visibleTo(req);
    const rows = (await db
      .prepare(
        `SELECT c.*, COUNT(ci.media_item_id) AS "itemCount"
         FROM collections c
         LEFT JOIN collection_items ci ON ci.collection_id = c.id
         GROUP BY c.id
         ORDER BY c.name`
      )
      .all()) as any[];
    res.json(
      await Promise.all(
        rows.map(async (r) => {
          const collection = collectionFromRow(r);
          // Up to 4 member posters for the poster-grid card on the Collections page — a fixed
          // collection's own ordering (collection_items.position), a smart one's live filter
          // results (already sorted by title). Small N+1 here is fine: this only runs for the
          // admin-facing collections list, never per-page-load at library scale.
          let itemCount: number;
          let posterUrls: string[];
          if (collection.smartFilter) {
            const matches = (await queryMediaItemsForFilter(collection.smartFilter)).map(mediaItemFromRow).filter(visible);
            itemCount = matches.length;
            posterUrls = matches
              .filter((m) => !!m.posterUrl)
              .slice(0, 4)
              .map((m) => m.posterUrl as string);
          } else if (req.auth?.isAdmin) {
            itemCount = Number(r.itemCount);
            const posterRows = (await db
              .prepare(
                `SELECT m.poster_url FROM collection_items ci
                 JOIN media_items m ON m.id = ci.media_item_id
                 WHERE ci.collection_id = ? AND m.poster_url IS NOT NULL
                 ORDER BY ci.position LIMIT 4`
              )
              .all(collection.id)) as { poster_url: string }[];
            posterUrls = posterRows.map((p) => p.poster_url);
          } else {
            const members = ((await db
              .prepare(
                `SELECT m.* FROM collection_items ci JOIN media_items m ON m.id = ci.media_item_id
                 WHERE ci.collection_id = ? ORDER BY ci.position`
              )
              .all(collection.id)) as any[]).map(mediaItemFromRow).filter(visible);
            itemCount = members.length;
            posterUrls = members
              .filter((m) => !!m.posterUrl)
              .slice(0, 4)
              .map((m) => m.posterUrl as string);
          }
          return { ...collection, itemCount, posterUrls };
        })
      )
    );
  })
);

collectionsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, "name is required");
    const smartFilter = sanitizeSmartFilter(b.smartFilter);
    const result = await db
      .prepare("INSERT INTO collections (name, description, smart_filter) VALUES (?, ?, ?)")
      .run(b.name, b.description ?? null, smartFilter ? JSON.stringify(smartFilter) : null);
    const row = await db.prepare("SELECT * FROM collections WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(collectionFromRow(row));
  })
);

collectionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Collection not found");
    const collection = collectionFromRow(row);

    const items = (
      collection.smartFilter
        ? await queryMediaItemsForFilter(collection.smartFilter)
        : ((await db
            .prepare(
              `SELECT m.* FROM media_items m
               JOIN collection_items ci ON ci.media_item_id = m.id
               WHERE ci.collection_id = ?
               ORDER BY ci.position, m.sort_title`
            )
            .all(req.params.id)) as any[])
    )
      .map(mediaItemFromRow)
      .filter(visibleTo(req));

    res.json({ ...collection, items });
  })
);

collectionsRouter.patch(
  "/:id",
  requireAdmin,
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
      await db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Collection not found");
    res.json(collectionFromRow(row));
  })
);

collectionsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM collections WHERE id = ?").run(req.params.id);
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mediaItemId = req.body?.mediaItemId;
    if (!mediaItemId) throw new HttpError(400, "mediaItemId is required");
    const collection = (await db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id)) as any;
    if (!collection) throw new HttpError(404, "Collection not found");
    assertNotSmart(collection);
    const maxPosition = (
      (await db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM collection_items WHERE collection_id = ?").get(
        req.params.id
      )) as { m: number }
    ).m;
    const insertIgnoreSql =
      db.dialect === "postgres"
        ? "INSERT INTO collection_items (collection_id, media_item_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
        : "INSERT OR IGNORE INTO collection_items (collection_id, media_item_id, position) VALUES (?, ?, ?)";
    await db.prepare(insertIgnoreSql).run(req.params.id, mediaItemId, maxPosition + 1);
    res.status(201).send();
  })
);

collectionsRouter.delete(
  "/:id/items/:mediaItemId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await db
      .prepare("DELETE FROM collection_items WHERE collection_id = ? AND media_item_id = ?")
      .run(req.params.id, req.params.mediaItemId);
    res.status(204).send();
  })
);

/** Reorders a collection's items — body: { orderedIds: number[] } of media item ids in the
 * desired order (must be exactly the collection's current membership). */
collectionsRouter.put(
  "/:id/items/order",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const collectionRow = (await db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id)) as any;
    if (!collectionRow) throw new HttpError(404, "Collection not found");
    assertNotSmart(collectionRow);

    const orderedIds: number[] = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new HttpError(400, "orderedIds is required");
    }
    await db.transaction(async () => {
      for (let index = 0; index < orderedIds.length; index++) {
        await db
          .prepare("UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_item_id = ?")
          .run(index, req.params.id, orderedIds[index]);
      }
    });
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const collectionRow = (await db.prepare("SELECT * FROM collections WHERE id = ?").get(req.params.id)) as any;
    if (!collectionRow) throw new HttpError(404, "Collection not found");
    const collection = collectionFromRow(collectionRow);

    const items = (
      collection.smartFilter
        ? await queryMediaItemsForFilter(collection.smartFilter)
        : ((await db
            .prepare(
              `SELECT m.* FROM media_items m
               JOIN collection_items ci ON ci.media_item_id = m.id
               WHERE ci.collection_id = ?
               ORDER BY ci.position, m.sort_title`
            )
            .all(req.params.id)) as any[])
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
