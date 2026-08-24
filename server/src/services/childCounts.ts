import { db } from "../db/index.js";
import { getMediaTypeConfig } from "./mediaTypes.js";

/**
 * Sonarr/Radarr-style per-item download progress: for "episodic" (series/anime) and "collection"
 * (music/books/comics/...) shapes, a single item's own `has_file` only means "at least one child
 * has a file" (see libraryScan.ts's rollup) — it says nothing about how many of its episodes/albums
 * are actually present. This attaches `childCount`/`childHaveCount` (total/downloaded children) to
 * each item of those shapes, mutating the mapped items in place. "single"-shape items (movies, ROMs,
 * adult) have no children and are left untouched — their own hasFile is already the full picture.
 */
export async function attachChildCounts(items: { id: number | bigint; type: string }[]): Promise<void> {
  const episodicIds = items.filter((i) => getMediaTypeConfig(i.type).shape === "episodic").map((i) => i.id);
  const collectionIds = items.filter((i) => getMediaTypeConfig(i.type).shape === "collection").map((i) => i.id);

  const [episodeCounts, subItemCounts] = await Promise.all([
    countChildren("episodes", episodicIds),
    countChildren("sub_items", collectionIds),
  ]);

  for (const item of items as any[]) {
    const counts = episodeCounts.get(item.id) ?? subItemCounts.get(item.id);
    if (counts) {
      item.childCount = counts.total;
      item.childHaveCount = counts.have;
    }
  }
}

const CHUNK_SIZE = 500;

async function countChildren(
  table: "episodes" | "sub_items",
  mediaItemIds: (number | bigint)[]
): Promise<Map<number | bigint, { total: number; have: number }>> {
  const result = new Map<number | bigint, { total: number; have: number }>();
  if (mediaItemIds.length === 0) return result;

  for (let i = 0; i < mediaItemIds.length; i += CHUNK_SIZE) {
    const chunk = mediaItemIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await db
      .prepare(
        `SELECT media_item_id, COUNT(*) AS total, SUM(has_file) AS have
         FROM ${table} WHERE media_item_id IN (${placeholders})
         GROUP BY media_item_id`
      )
      .all(...chunk)) as { media_item_id: number | bigint; total: number; have: number }[];
    for (const row of rows) {
      result.set(row.media_item_id, { total: Number(row.total), have: Number(row.have) });
    }
  }
  return result;
}
