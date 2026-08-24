import { db } from "../db/index.js";

/**
 * Records a title that a metadata search came up empty for, instead of the previous behavior of
 * just discarding it silently — the whole point being that "the program couldn't confidently
 * match this" and "nobody will ever know it existed" shouldn't be the same outcome. Deduped
 * against ANY existing row (any status) for the same (source, list, type, title, year) so a
 * dismissed item doesn't get silently re-queued the next time the same watchlist/import-list sync
 * runs across it again.
 */
export async function queueForReview(params: {
  source: string;
  importListId: number | null;
  type: string;
  title: string;
  year: number | null;
}): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT id FROM import_review_items
       WHERE source = ? AND (import_list_id IS NOT DISTINCT FROM ?) AND type = ? AND title = ? AND (year IS NOT DISTINCT FROM ?)`
    )
    .get(params.source, params.importListId, params.type, params.title, params.year);
  if (existing) return;

  await db
    .prepare(`INSERT INTO import_review_items (source, import_list_id, type, title, year) VALUES (?, ?, ?, ?, ?)`)
    .run(params.source, params.importListId, params.type, params.title, params.year);
}
