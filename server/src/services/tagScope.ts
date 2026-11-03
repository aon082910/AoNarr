import { db } from "../db/index.js";

/**
 * Tags as a scope. Indexers, download clients and import lists keep their tag ids as a JSON list in
 * a `tag_ids` column. Sonarr and Radarr read it the same way everywhere: an empty list means "no
 * restriction", and a list means the thing is used only for an item that carries at least one of
 * the tags.
 */

/** The ids in a stored `tag_ids` value; anything that is not a list of whole numbers reads as no scope. */
export function parseTagIds(raw: unknown): number[] {
  let value = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const ids = value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/** What to store for a `tagIds` request field: null for none, the JSON list otherwise. Throws a message for a bad value. */
export function tagIdsColumn(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value)) throw new Error("tagIds must be a list of tag ids");
  const ids = value.map((v) => Number(v));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error("tagIds must be a list of tag ids");
  const unique = [...new Set(ids)];
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

/** `tagIdsColumn` that also checks every tag exists. undefined = not sent. Throws an Error with the message to show. */
export async function checkedTagIdsColumn(value: unknown): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  const column = tagIdsColumn(value);
  for (const id of column ? (JSON.parse(column) as number[]) : []) {
    if (!(await db.prepare("SELECT 1 AS ok FROM tags WHERE id = ?").get(id))) throw new Error(`Tag ${id} doesn't exist`);
  }
  return column;
}

/** Whether something scoped to `scope` may be used for an item with `itemTags`. */
export function scopeAllows(scope: number[] | null | undefined, itemTags: number[]): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.some((id) => itemTags.includes(id));
}

export async function tagIdsOfItem(itemId: number | bigint | null | undefined): Promise<number[]> {
  if (itemId == null) return [];
  const rows = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(Number(itemId))) as { tag_id: number }[];
  return rows.map((r) => Number(r.tag_id));
}

/** Gives an item the tags (those that still exist), keeping any it has. */
export async function addTagsToItem(itemId: number | bigint | null | undefined, tagIds: number[]): Promise<void> {
  if (itemId == null) return;
  for (const tagId of tagIds) {
    const exists = await db.prepare("SELECT 1 AS ok FROM tags WHERE id = ?").get(tagId);
    if (!exists) continue;
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(Number(itemId), tagId);
  }
}
