import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getMediaTypeConfig, MEDIA_TYPE_KEYS } from "./mediaTypes.js";
import { recycleFile } from "./recycleBin.js";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface PossibleDuplicate {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

/**
 * Catches likely duplicates *before* they're created, rather than only after the fact via the
 * "repeated imports" health check — normalized-title match within the same library type, plus a
 * year match when both sides have one (so "Dune" 1984 and "Dune" 2021 aren't flagged against
 * each other, but two "Dune (2021)" adds would be).
 */
export async function findPossibleDuplicates(type: string, title: string, year: number | null): Promise<PossibleDuplicate[]> {
  const needle = normalizeTitle(title);
  if (!needle) return [];

  const candidates = (await db.prepare("SELECT id, title, year, poster_url FROM media_items WHERE type = ?").all(type)) as {
    id: number;
    title: string;
    year: number | null;
    poster_url: string | null;
  }[];

  return candidates
    .filter((c) => {
      const candidateNormalized = normalizeTitle(c.title);
      if (candidateNormalized !== needle) return false;
      if (year != null && c.year != null && year !== c.year) return false;
      return true;
    })
    .map((c) => ({ id: c.id, title: c.title, year: c.year, posterUrl: c.poster_url }));
}

export interface DuplicateGroupItem {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  hasFile: boolean;
  path: string | null;
  monitored: boolean;
  addedAt: string | null;
  childCount: number;
  suggestedKeeper: boolean;
}

export interface DuplicateGroup {
  type: string;
  title: string;
  year: number | null;
  items: DuplicateGroupItem[];
}

/**
 * Whole-library sweep for existing media_items rows that are almost certainly the same title —
 * distinct from findPossibleDuplicates above, which only checks one candidate title *before* it's
 * created. Grouped by exact (normalized title, year) rather than the looser "either side missing a
 * year" match findPossibleDuplicates uses: a title-only match risks lumping together two genuinely
 * different items that just happen to share a name, which is a much worse outcome for a merge tool
 * (irreversible without the recycle bin) than for a pre-add warning (which the admin can just
 * dismiss). Real duplicates from the movie-import bug this was built for always share an exact
 * (title, year) pair, since both came from the same filename-parsing logic.
 */
export async function findDuplicateGroups(type?: string): Promise<DuplicateGroup[]> {
  const types = type ? [type] : MEDIA_TYPE_KEYS;
  const groups: DuplicateGroup[] = [];

  for (const t of types) {
    const shape = getMediaTypeConfig(t).shape;
    const rows = (await db.prepare("SELECT * FROM media_items WHERE type = ?").all(t)) as any[];

    const byKey = new Map<string, any[]>();
    for (const row of rows) {
      const normalized = normalizeTitle(row.title);
      if (!normalized) continue;
      const key = `${normalized}::${row.year ?? "?"}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(row);
    }

    for (const rowsInGroup of byKey.values()) {
      if (rowsInGroup.length < 2) continue;

      const items: DuplicateGroupItem[] = [];
      for (const row of rowsInGroup) {
        const childCount =
          shape === "episodic"
            ? Number(((await db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ?").get(row.id)) as { c: number }).c)
            : shape === "collection"
              ? Number(((await db.prepare("SELECT COUNT(*) AS c FROM sub_items WHERE media_item_id = ?").get(row.id)) as { c: number }).c)
              : 0;
        items.push({
          id: row.id,
          title: row.title,
          year: row.year,
          posterUrl: row.poster_url,
          hasFile: !!row.has_file,
          path: row.path,
          monitored: !!row.monitored,
          addedAt: row.added_at,
          childCount,
          suggestedKeeper: false,
        });
      }

      // Suggested keeper: has a file/children over one that doesn't, then the most children, then
      // the earliest-added (most likely the "real" original entry, not a re-scan artifact) — purely
      // a UI hint, the admin picks the actual keeper explicitly.
      const best = [...items].sort((a, b) => {
        if (a.hasFile !== b.hasFile) return a.hasFile ? -1 : 1;
        if (a.childCount !== b.childCount) return b.childCount - a.childCount;
        return (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
      })[0];
      best.suggestedKeeper = true;

      groups.push({ type: t, title: rowsInGroup[0].title, year: rowsInGroup[0].year, items });
    }
  }

  return groups;
}

/** Tables that reference media_items.id and should follow the item to the keeper on merge rather
 * than being silently cascade-deleted with the loser — history, active downloads, blocklist
 * entries, watch status, share links, and household requests are all real user data a merge
 * shouldn't quietly discard. episodes/sub_items are handled separately below since a straight
 * reassign risks colliding with a row the keeper already has. */
const REASSIGN_TABLES = ["queue", "history", "corrupt_media_review", "share_links", "requests", "blocklist", "watch_events"];

/**
 * Merges one or more "loser" media_items into a "keeper", moving over anything useful (a missing
 * file, metadata the keeper doesn't have yet, episodes/sub_items/tags/collection membership/history)
 * before deleting the losers. Built for the movie-import duplicate bug (see DATABASE_MIGRATION.md/
 * CHANGELOG Round 106) but works for any shape:
 * - "single" (movie/rom/adult): keeper adopts the first loser's file if it doesn't have one of its
 *   own; any other loser file is left on disk (deleteFiles: true recycles it) rather than guessing
 *   which file is "better" and silently overwriting.
 * - "episodic"/"collection": a loser's episode/sub-item moves to the keeper unless the keeper
 *   already has one at that season+episode / that title — a colliding loser child is left alone
 *   (and its file, if deleteFiles) rather than picked between automatically.
 */
export async function mergeMediaItems(keeperId: number, loserIds: number[], deleteFiles: boolean): Promise<{ merged: number }> {
  const ids = [...new Set(loserIds)].filter((id) => id !== keeperId);
  if (ids.length === 0) return { merged: 0 };

  let keeper = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(keeperId)) as any;
  if (!keeper) throw new Error("Keeper item not found");
  const shape = getMediaTypeConfig(keeper.type).shape;

  const upsertIgnore = (table: string, cols: string, values: string) =>
    db.dialect === "postgres"
      ? `INSERT INTO ${table} (${cols}) ${values} ON CONFLICT DO NOTHING`
      : `INSERT OR IGNORE INTO ${table} (${cols}) ${values}`;

  let merged = 0;
  await db.transaction(async () => {
    for (const loserId of ids) {
      const loser = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(loserId)) as any;
      if (!loser || loser.type !== keeper.type) continue;

      if (shape === "episodic") {
        const loserEpisodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(loserId)) as any[];
        for (const ep of loserEpisodes) {
          const collision = await db
            .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
            .get(keeperId, ep.season_number, ep.episode_number);
          if (!collision) {
            await db.prepare("UPDATE episodes SET media_item_id = ? WHERE id = ?").run(keeperId, ep.id);
          } else if (deleteFiles && ep.file_path) {
            await recycleFile(ep.file_path, keeper.type, `${loser.title} S${ep.season_number}E${ep.episode_number}`, loserId).catch(() => {});
          }
        }
      } else if (shape === "collection") {
        const keeperSubs = (await db.prepare("SELECT id, title FROM sub_items WHERE media_item_id = ?").all(keeperId)) as any[];
        const loserSubs = (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ?").all(loserId)) as any[];
        for (const sub of loserSubs) {
          const collision = keeperSubs.find((k) => normalizeTitle(k.title) === normalizeTitle(sub.title));
          if (!collision) {
            await db.prepare("UPDATE sub_items SET media_item_id = ? WHERE id = ?").run(keeperId, sub.id);
          } else if (deleteFiles && sub.file_path) {
            await recycleFile(sub.file_path, keeper.type, `${loser.title} — ${sub.title}`, loserId).catch(() => {});
          }
        }
      } else if (!keeper.has_file && loser.has_file) {
        await db
          .prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?")
          .run(loser.path, loser.quality, loser.media_info, keeperId);
        keeper = { ...keeper, has_file: 1, path: loser.path, quality: loser.quality, media_info: loser.media_info };
      } else if (keeper.has_file && loser.has_file && loser.path && loser.path !== keeper.path && deleteFiles) {
        await recycleFile(loser.path, loser.type, loser.title, loserId).catch(() => {});
      }

      // Fill in metadata the keeper is missing from whichever loser has it — helps when the
      // "wrong" (first-created) duplicate has thinner metadata than a later, better-matched one.
      await db
        .prepare(
          `UPDATE media_items SET
             overview = COALESCE(overview, ?), poster_url = COALESCE(poster_url, ?),
             external_ids = COALESCE(NULLIF(external_ids, '{}'), ?), year = COALESCE(year, ?)
           WHERE id = ?`
        )
        .run(loser.overview, loser.poster_url, loser.external_ids, loser.year, keeperId);

      await db
        .prepare(upsertIgnore("media_item_tags", "media_item_id, tag_id", "SELECT ?, tag_id FROM media_item_tags WHERE media_item_id = ?"))
        .run(keeperId, loserId);
      await db
        .prepare(
          upsertIgnore(
            "collection_items",
            "collection_id, media_item_id, position",
            "SELECT collection_id, ?, position FROM collection_items WHERE media_item_id = ?"
          )
        )
        .run(keeperId, loserId);

      for (const table of REASSIGN_TABLES) {
        await db.prepare(`UPDATE ${table} SET media_item_id = ? WHERE media_item_id = ?`).run(keeperId, loserId);
      }

      await db.prepare("DELETE FROM media_items WHERE id = ?").run(loserId);
      merged++;
    }

    if (shape === "episodic") {
      await db
        .prepare(
          `UPDATE media_items SET has_file = 1 WHERE id = ? AND has_file = 0 AND EXISTS (SELECT 1 FROM episodes WHERE media_item_id = ? AND has_file = 1)`
        )
        .run(keeperId, keeperId);
    } else if (shape === "collection") {
      await db
        .prepare(
          `UPDATE media_items SET has_file = 1 WHERE id = ? AND has_file = 0 AND EXISTS (SELECT 1 FROM sub_items WHERE media_item_id = ? AND has_file = 1)`
        )
        .run(keeperId, keeperId);
    }
  });

  log.info(`[duplicateCheck] merged ${merged} duplicate(s) of "${keeper.title}" into item ${keeperId}`);
  return { merged };
}
