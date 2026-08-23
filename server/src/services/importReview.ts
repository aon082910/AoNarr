import { db } from "../db/client.js";

/**
 * Records a title that a metadata search came up empty for, instead of the previous behavior of
 * just discarding it silently — the whole point being that "the program couldn't confidently
 * match this" and "nobody will ever know it existed" shouldn't be the same outcome. Deduped
 * against ANY existing row (any status) for the same (source, list, type, title, year) so a
 * dismissed item doesn't get silently re-queued the next time the same watchlist/import-list sync
 * runs across it again.
 */
export function queueForReview(params: { source: string; importListId: number | null; type: string; title: string; year: number | null }): void {
  const existing = db
    .prepare(
      `SELECT id FROM import_review_items
       WHERE source = ? AND (import_list_id IS ? ) AND type = ? AND title = ? AND (year IS ?)`
    )
    .get(params.source, params.importListId, params.type, params.title, params.year);
  if (existing) return;

  db.prepare(
    `INSERT INTO import_review_items (source, import_list_id, type, title, year) VALUES (?, ?, ?, ?, ?)`
  ).run(params.source, params.importListId, params.type, params.title, params.year);
}
