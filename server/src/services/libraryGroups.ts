import { db } from "../db/index.js";
import { libraryGroupFromRow } from "../db/mappers.js";

function sortName(name: string): string {
  return name.toLowerCase();
}

/**
 * Server-side find-or-create for a `library_groups` row, scoped to (media_type, kind,
 * parent_group_id) with a case-insensitive name match — the same lookup-then-create shape
 * `AddPreview.tsx`'s frontend-only `findOrCreateGroup()` already composes out of `GET`/`POST
 * /library-groups` for the guided Add Media flow. This is the backend equivalent, for callers that
 * need the same "find it, or make it" behavior from server-side code (see
 * refreshOneItem's ROM system/maker auto-assignment) rather than a browser round-trip. Returns the
 * group's id either way.
 */
export async function findOrCreateLibraryGroup(
  mediaType: string,
  kind: string,
  name: string,
  parentGroupId: number | null,
  logoUrl?: string | null
): Promise<number> {
  const trimmed = name.trim();
  // Portable null-safe parent match across both SQLite and Postgres: `col IS ?` isn't valid
  // Postgres syntax for a non-null parameter (IS there only accepts NULL/TRUE/FALSE/DISTINCT FROM
  // literals), so this branches in JS instead, the same way mediaQuery.ts's groupId filter does.
  const parentClause = parentGroupId === null ? "parent_group_id IS NULL" : "parent_group_id = ?";
  const params = parentGroupId === null ? [mediaType, kind, sortName(trimmed)] : [mediaType, kind, sortName(trimmed), parentGroupId];
  const existing = (await db
    .prepare(`SELECT id FROM library_groups WHERE media_type = ? AND kind = ? AND sort_name = ? AND ${parentClause}`)
    .get(...params)) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = await db
    .prepare("INSERT INTO library_groups (media_type, kind, name, sort_name, parent_group_id, logo_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run(mediaType, kind, trimmed, sortName(trimmed), parentGroupId, logoUrl ?? null);
  return Number(result.lastInsertRowid);
}

export { libraryGroupFromRow };
