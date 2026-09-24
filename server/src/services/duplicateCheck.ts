import { db } from "../db/index.js";
import { log } from "./logger.js";
import { effectiveShape, getMediaTypeConfig, MEDIA_TYPE_KEYS } from "./mediaTypes.js";
import { recycleFile } from "./recycleBin.js";
import { notifyDuplicatesFound } from "./notifications.js";
import { attachChildCounts } from "./childCounts.js";

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
 * each other, but two "Dune (2021)" adds would be) — OR a shared external provider id
 * (`externalIds`, when the caller has one in hand from a metadata search result), since title/year
 * matching alone misses two adds of the same show that landed on different metadata providers
 * disagreeing on year (a regional premiere vs. a US air date) or title spelling. Still just a
 * warning either way — the caller can bypass it with `confirmDuplicate`, same as before this was
 * added; a real external-id match is just a far more reliable signal than title/year ever was.
 */
export async function findPossibleDuplicates(
  type: string,
  title: string,
  year: number | null,
  externalIds?: Record<string, string>
): Promise<PossibleDuplicate[]> {
  const needle = normalizeTitle(title);
  const idEntries = externalIds ? Object.entries(externalIds).filter(([, v]) => v) : [];
  if (!needle && idEntries.length === 0) return [];

  const candidates = (await db.prepare("SELECT id, title, year, poster_url, external_ids FROM media_items WHERE type = ?").all(type)) as {
    id: number;
    title: string;
    year: number | null;
    poster_url: string | null;
    external_ids: string | null;
  }[];

  return candidates
    .filter((c) => {
      if (needle) {
        const candidateNormalized = normalizeTitle(c.title);
        if (candidateNormalized === needle && (year == null || c.year == null || year === c.year)) return true;
      }
      if (idEntries.length > 0 && c.external_ids) {
        let candidateIds: Record<string, string> = {};
        try {
          candidateIds = JSON.parse(c.external_ids);
        } catch {
          return false;
        }
        return idEntries.some(([provider, id]) => candidateIds[provider] === id);
      }
      return false;
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
  quality: string | null;
  contentRating: string | null;
  /** Which metadata providers (tmdb, tvdb, musicbrainz, ...) this item is actually matched to —
   * the admin's clearest signal for telling a genuine duplicate ("both matched the same tmdb id")
   * apart from two different works that just happen to share a title/year (matched to different
   * ids, or one/both entirely unmatched). */
  matchedProviders: string[];
}

export interface DuplicateGroup {
  type: string;
  title: string;
  year: number | null;
  items: DuplicateGroupItem[];
  /** Stable identity for this group — (type, normalized title, year) — used to gate scheduled
   * re-notification (see runScheduledDuplicateCheck below) rather than re-notifying about the same
   * still-unmerged group on every scan. */
  key: string;
}

function matchedProvidersFor(row: any): string[] {
  try {
    return row.external_ids ? Object.keys(JSON.parse(row.external_ids)) : [];
  } catch {
    return [];
  }
}

/** Shapes a group of raw media_items rows into the DuplicateGroupItem[] + suggested-keeper the
 * Duplicates page renders — shared by both grouping passes in findDuplicateGroups below so they
 * can't drift into computing "suggested keeper" differently from each other. */
function buildGroupItems(rowsInGroup: any[]): DuplicateGroupItem[] {
  const items: DuplicateGroupItem[] = rowsInGroup.map((row) => ({
    id: row.id,
    title: row.title,
    year: row.year,
    posterUrl: row.poster_url,
    hasFile: !!row.has_file,
    path: row.path,
    monitored: !!row.monitored,
    addedAt: row.added_at,
    childCount: row.childCount ?? 0,
    suggestedKeeper: false,
    quality: row.quality,
    contentRating: row.content_rating,
    matchedProviders: matchedProvidersFor(row),
  }));

  // Suggested keeper: has a file/children over one that doesn't, then the most children, then the
  // earliest-added (most likely the "real" original entry, not a re-scan artifact) — purely a UI
  // hint, the admin picks the actual keeper explicitly.
  const best = [...items].sort((a, b) => {
    if (a.hasFile !== b.hasFile) return a.hasFile ? -1 : 1;
    if (a.childCount !== b.childCount) return b.childCount - a.childCount;
    return (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
  })[0];
  best.suggestedKeeper = true;
  return items;
}

/**
 * Whole-library sweep for existing media_items rows that are almost certainly the same title —
 * distinct from findPossibleDuplicates above, which only checks one candidate title *before* it's
 * created. Two independent grouping passes over the same rows:
 * 1. Exact (normalized title, year) — a title-only match risks lumping together two genuinely
 *    different items that just happen to share a name, which is a much worse outcome for a merge
 *    tool (irreversible without the recycle bin) than for a pre-add warning (which the admin can
 *    just dismiss). Real duplicates from the movie-import bug this was originally built for always
 *    share an exact (title, year) pair, since both came from the same filename-parsing logic.
 * 2. Shared external provider id — catches the case (1) can't: the same show added twice via two
 *    different metadata providers that disagree on year or title spelling (see
 *    services/libraryScan.ts's matchAdditionalProviders doc comment for the full story). Emitted
 *    as its own group only when its member set isn't already identical to a group (1) already
 *    found, so agreeing signals don't produce two redundant entries on the Duplicates page.
 */
export async function findDuplicateGroups(type?: string): Promise<DuplicateGroup[]> {
  const types = type ? [type] : MEDIA_TYPE_KEYS;
  const groups: DuplicateGroup[] = [];

  // normalized_key already stores the full `${type}::${normalizedTitle}::${year}` (or
  // `${type}::ext::${provider}:${id}`) composite (see runScheduledDuplicateCheck's insert, which
  // writes g.key there directly) — not just the title/year portion — so this compares directly
  // against it rather than re-prefixing with type.
  const dismissedRows = (await db.prepare("SELECT normalized_key FROM duplicate_group_seen WHERE dismissed = 1").all()) as {
    normalized_key: string;
  }[];
  const dismissedKeys = new Set(dismissedRows.map((r) => r.normalized_key));

  for (const t of types) {
    const shape = getMediaTypeConfig(t).shape;
    // attachChildCounts reads camelCase legacyShape — without it a not-yet-converted course item is
    // counted from the (empty) episodes table instead of its sub_items.
    const rows = ((await db.prepare("SELECT * FROM media_items WHERE type = ?").all(t)) as any[]).map((r) => ({
      ...r,
      legacyShape: r.legacy_shape,
    }));
    // One batched grouped query for every row of this type up front, instead of a per-row
    // COUNT(*) issued only for the (hopefully rare) rows that turn out to be duplicates — same
    // pattern as the Library page's own child-count attachment.
    if (shape === "episodic" || shape === "collection") await attachChildCounts(rows);

    const byTitleKey = new Map<string, any[]>();
    for (const row of rows) {
      const normalized = normalizeTitle(row.title);
      if (!normalized) continue;
      const key = `${normalized}::${row.year ?? "?"}`;
      if (!byTitleKey.has(key)) byTitleKey.set(key, []);
      byTitleKey.get(key)!.push(row);
    }

    const emittedMemberSets: Set<string> = new Set();
    for (const [groupKey, rowsInGroup] of byTitleKey.entries()) {
      if (rowsInGroup.length < 2) continue;
      if (dismissedKeys.has(`${t}::${groupKey}`)) continue;
      emittedMemberSets.add(rowsInGroup.map((r) => r.id).sort().join(","));
      groups.push({ type: t, title: rowsInGroup[0].title, year: rowsInGroup[0].year, items: buildGroupItems(rowsInGroup), key: `${t}::${groupKey}` });
    }

    const byExternalId = new Map<string, any[]>();
    for (const row of rows) {
      for (const [provider, id] of Object.entries(
        (() => {
          try {
            return row.external_ids ? (JSON.parse(row.external_ids) as Record<string, string>) : {};
          } catch {
            return {};
          }
        })()
      )) {
        const key = `${provider}:${id}`;
        if (!byExternalId.has(key)) byExternalId.set(key, []);
        byExternalId.get(key)!.push(row);
      }
    }

    for (const [extKey, rowsInGroup] of byExternalId.entries()) {
      if (rowsInGroup.length < 2) continue;
      const groupKey = `ext::${extKey}`;
      if (dismissedKeys.has(`${t}::${groupKey}`)) continue;
      if (emittedMemberSets.has(rowsInGroup.map((r) => r.id).sort().join(","))) continue;
      groups.push({ type: t, title: rowsInGroup[0].title, year: rowsInGroup[0].year, items: buildGroupItems(rowsInGroup), key: `${t}::${groupKey}` });
    }
  }

  return groups;
}

/**
 * "Not a duplicate" / "remove from list, keep both" — marks a group's identity as dismissed so
 * `findDuplicateGroups()` stops returning it (both items stay in the library untouched, unlike
 * `mergeMediaItems`) and the scheduled notification job (Round 118) also stops flagging it. Upserts
 * rather than a plain UPDATE since a group the scheduled job has never run across yet (dismissed
 * directly from the Duplicates page before its next daily scan) has no existing row to update.
 */
export async function dismissDuplicateGroup(groupKey: string): Promise<void> {
  // ON CONFLICT ... DO UPDATE is valid standard syntax on both SQLite and Postgres — no dialect
  // branch needed here (unlike the plain OR IGNORE/DO NOTHING upserts elsewhere in this file,
  // which do need one since SQLite's "OR IGNORE" isn't Postgres syntax).
  const type = groupKey.split("::")[0];
  await db
    .prepare(
      `INSERT INTO duplicate_group_seen (type, normalized_key, dismissed) VALUES (?, ?, 1)
       ON CONFLICT (type, normalized_key) DO UPDATE SET dismissed = 1`
    )
    .run(type, groupKey);
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
 *   already has one at that season+episode / that title — a colliding loser child's file is left
 *   on disk untouched (recycled instead if deleteFiles) rather than picked between automatically.
 *   Its own row is not spared, though: once the loser's media_items row is deleted below, the
 *   collided episode/sub_item row goes with it via ON DELETE CASCADE, so AoNarr stops tracking
 *   that file even when its bytes were deliberately left alone.
 * A loser whose effective shape differs from the keeper's (a not-yet-converted legacy_shape item
 * next to a converted one) is left untouched and its id returned in `skippedShapeMismatch`.
 */
export async function mergeMediaItems(
  keeperId: number,
  loserIds: number[],
  deleteFiles: boolean
): Promise<{ merged: number; skippedShapeMismatch: number[] }> {
  const ids = [...new Set(loserIds)].filter((id) => id !== keeperId);
  if (ids.length === 0) return { merged: 0, skippedShapeMismatch: [] };

  let keeper = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(keeperId)) as any;
  if (!keeper) throw new Error("Keeper item not found");
  const shape = effectiveShape({ type: keeper.type, legacyShape: keeper.legacy_shape });

  const upsertIgnore = (table: string, cols: string, values: string) =>
    db.dialect === "postgres"
      ? `INSERT INTO ${table} (${cols}) ${values} ON CONFLICT DO NOTHING`
      : `INSERT OR IGNORE INTO ${table} (${cols}) ${values}`;

  // Recycling moves files (a cross-device move is a full copy), so it runs only after the
  // transaction commits: awaiting it inside would hold the shared connection mid-transaction, and a
  // rollback would leave the file moved with no recycle_bin row pointing at it.
  const toRecycle: { path: string; type: string; title: string }[] = [];
  let merged = 0;
  const skippedShapeMismatch: number[] = [];
  await db.transaction(async () => {
    for (const loserId of ids) {
      const loser = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(loserId)) as any;
      if (!loser || loser.type !== keeper.type) continue;
      // A not-yet-converted (legacy_shape) item keeps its files in a different table than a
      // converted one, so neither merge path could carry the loser's files/children over.
      if (effectiveShape({ type: loser.type, legacyShape: loser.legacy_shape }) !== shape) {
        skippedShapeMismatch.push(loserId);
        continue;
      }

      if (shape === "episodic") {
        const loserEpisodes = (await db.prepare("SELECT * FROM episodes WHERE media_item_id = ?").all(loserId)) as any[];
        for (const ep of loserEpisodes) {
          const collision = await db
            .prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
            .get(keeperId, ep.season_number, ep.episode_number);
          if (!collision) {
            await db.prepare("UPDATE episodes SET media_item_id = ? WHERE id = ?").run(keeperId, ep.id);
          } else if (deleteFiles && ep.file_path) {
            toRecycle.push({ path: ep.file_path, type: keeper.type, title: `${loser.title} S${ep.season_number}E${ep.episode_number}` });
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
            toRecycle.push({ path: sub.file_path, type: keeper.type, title: `${loser.title} — ${sub.title}` });
          }
        }
      } else if (!keeper.has_file && loser.has_file) {
        await db
          .prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ? WHERE id = ?")
          .run(loser.path, loser.quality, loser.media_info, keeperId);
        keeper = { ...keeper, has_file: 1, path: loser.path, quality: loser.quality, media_info: loser.media_info };
      } else if (keeper.has_file && loser.has_file && loser.path && loser.path !== keeper.path && deleteFiles) {
        toRecycle.push({ path: loser.path, type: loser.type, title: loser.title });
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

  // The loser rows are deleted by now, so their recycle_bin entries can't reference them.
  for (const r of toRecycle) {
    await recycleFile(r.path, r.type, r.title, null).catch(() => {});
  }

  log.info(`[duplicateCheck] merged ${merged} duplicate(s) of "${keeper.title}" into item ${keeperId}`);
  return { merged, skippedShapeMismatch };
}

/**
 * Scheduled counterpart to the Duplicates page's on-demand `findDuplicateGroups()` sweep — runs
 * the same detection, but only notifies about groups not already recorded in
 * `duplicate_group_seen`, so a still-unmerged group found last week doesn't notify again every
 * time this job runs. A group's identity survives new items joining it (same normalized
 * title+year), so merging away the duplication is what actually stops it from being "new" again —
 * simply ignoring the notification does not, which is the intended behavior (a real unresolved
 * duplicate should keep being visible on the Duplicates page even after its one-time notification).
 */
export async function runScheduledDuplicateCheck(): Promise<{ newGroups: number }> {
  const groups = await findDuplicateGroups();
  const newTitles: string[] = [];

  for (const g of groups) {
    const existing = await db.prepare("SELECT id FROM duplicate_group_seen WHERE type = ? AND normalized_key = ?").get(g.type, g.key);
    if (existing) continue;

    const insertIgnore =
      db.dialect === "postgres"
        ? "INSERT INTO duplicate_group_seen (type, normalized_key) VALUES (?, ?) ON CONFLICT DO NOTHING"
        : "INSERT OR IGNORE INTO duplicate_group_seen (type, normalized_key) VALUES (?, ?)";
    await db.prepare(insertIgnore).run(g.type, g.key);
    newTitles.push(`${g.title}${g.year ? ` (${g.year})` : ""}`);
  }

  if (newTitles.length > 0) {
    log.info(`[duplicateCheck] scheduled scan found ${newTitles.length} new duplicate group(s)`);
    await notifyDuplicatesFound(newTitles.length, newTitles.slice(0, 5)).catch((err) =>
      log.warn("[duplicateCheck] failed to send duplicates-found notification:", err.message)
    );
  }

  return { newGroups: newTitles.length };
}
