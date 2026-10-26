import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { getSetting } from "./settingsStore.js";

/**
 * How often an automatic search looks again for a target it keeps finding nothing for. Searching
 * every missing episode of every show every half hour, forever, costs hundreds of requests per
 * indexer per cycle for releases that mostly are not there; once the RSS sync (rssSync.ts) reads
 * what is new on the indexers, a search is only needed for what the feeds cannot show — the back
 * catalogue — and that can be looked for daily, then every few days, then weekly. Sonarr works the
 * same way: RSS for the new, a search when the user or a schedule asks.
 *
 * A target's count of searches in a row that grabbed nothing (`auto_search_misses`) steps through
 * LEAF_STEPS. It starts over when something is grabbed for it, when the admin edits it or the
 * indexers or profiles, and when the RSS sync sees a release that names it. A target that aired or
 * came out in the last two weeks is always searched: that is when its releases appear.
 *
 * The `searchBackoff` setting "0" turns all of this off.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** [misses below, wait before the next search]: three searches in a row are free, then a day, three days, a week. */
export const LEAF_STEPS: [number, number][] = [
  [3, 0],
  [6, DAY_MS],
  [12, 3 * DAY_MS],
  [Infinity, 7 * DAY_MS],
];
/** A season pack is looked for twice, then daily, every three days, weekly. */
export const SEASON_STEPS: [number, number][] = [
  [2, 0],
  [6, DAY_MS],
  [12, 3 * DAY_MS],
  [Infinity, 7 * DAY_MS],
];

const FRESH_WINDOW_MS = 14 * DAY_MS;

export function searchBackoffEnabled(): boolean {
  return getSetting("searchBackoff") !== "0";
}

export function waitAfter(misses: number, steps: [number, number][] = LEAF_STEPS): number {
  for (const [below, wait] of steps) if (misses < below) return wait;
  return steps[steps.length - 1][1];
}

/** A timestamp as the database stores one ("YYYY-MM-DD HH:MM:SS", UTC) or as an ISO string. */
export function parseStoredTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/**
 * Whether a target is to be searched now. `reference` is the date it aired or came out
 * (YYYY-MM-DD...): within two weeks of it the target is always searched.
 */
export function leafDue(
  target: { auto_search_misses?: number | null; last_auto_searched_at?: string | null },
  reference: string | null | undefined,
  now = Date.now()
): boolean {
  if (!searchBackoffEnabled()) return true;
  const misses = Number(target.auto_search_misses ?? 0);
  const wait = waitAfter(misses);
  if (wait === 0) return true;
  const referenceAt = parseStoredTime(reference?.slice(0, 10));
  if (referenceAt != null && referenceAt <= now && now - referenceAt < FRESH_WINDOW_MS) return true;
  const last = parseStoredTime(target.last_auto_searched_at);
  return last == null || now - last >= wait;
}

export type LeafTable = "media_items" | "episodes" | "sub_items";

/** A search of the target ended: its count of misses starts over after a grab and goes up after none. */
export async function recordLeafOutcome(table: LeafTable, id: number, grabbed: boolean): Promise<void> {
  await db
    .prepare(`UPDATE ${table} SET auto_search_misses = ${grabbed ? "0" : "auto_search_misses + 1"} WHERE id = ?`)
    .run(id);
}

export async function seasonSearchDue(mediaItemId: number, seasonNumber: number, now = Date.now()): Promise<boolean> {
  if (!searchBackoffEnabled()) return true;
  const row = (await db.prepare("SELECT misses, last_searched_at FROM season_searches WHERE media_item_id = ? AND season_number = ?").get(mediaItemId, seasonNumber)) as
    | { misses: number; last_searched_at: string | null }
    | undefined;
  if (!row) return true;
  const wait = waitAfter(Number(row.misses), SEASON_STEPS);
  const last = parseStoredTime(row.last_searched_at);
  return wait === 0 || last == null || now - last >= wait;
}

export async function recordSeasonSearch(mediaItemId: number, seasonNumber: number, grabbed: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO season_searches (media_item_id, season_number, misses, last_searched_at) VALUES (?, ?, ?, ${nowExpr(db)})
       ON CONFLICT (media_item_id, season_number) DO UPDATE SET misses = ${grabbed ? "0" : "season_searches.misses + 1"}, last_searched_at = ${nowExpr(db)}`
    )
    .run(mediaItemId, seasonNumber, grabbed ? 0 : 1);
}

/**
 * Starts the backoff over: for one item (and its episodes and sub-items) when the admin edits it,
 * or for everything when something that decides what can be grabbed changed (an indexer added or
 * enabled, a quality or release profile edited).
 */
export async function resetSearchBackoff(mediaItemIds?: number | number[]): Promise<void> {
  const ids = mediaItemIds == null ? null : (Array.isArray(mediaItemIds) ? mediaItemIds : [mediaItemIds]).map(Number).filter(Number.isFinite);
  if (ids && ids.length === 0) return;
  const marks = ids ? ids.map(() => "?").join(",") : "";
  // Only the rows that are backed off are written: a library of a hundred thousand episodes has a handful.
  const children = ids ? ` WHERE media_item_id IN (${marks}) AND auto_search_misses <> 0` : " WHERE auto_search_misses <> 0";
  await db.prepare(`UPDATE episodes SET auto_search_misses = 0${children}`).run(...(ids ?? []));
  await db.prepare(`UPDATE sub_items SET auto_search_misses = 0${children}`).run(...(ids ?? []));
  await db
    .prepare(`UPDATE media_items SET auto_search_misses = 0 WHERE auto_search_misses <> 0${ids ? ` AND id IN (${marks})` : ""}`)
    .run(...(ids ?? []));
  await db.prepare(`DELETE FROM season_searches${ids ? ` WHERE media_item_id IN (${marks})` : ""}`).run(...(ids ?? []));
}

/** One target the RSS sync saw a release for: searched on the next cycle whatever it had missed. */
export async function wakeLeaf(table: LeafTable, id: number): Promise<void> {
  await db.prepare(`UPDATE ${table} SET auto_search_misses = 0 WHERE id = ?`).run(id);
}

/** The RSS sync saw a pack for the season: it is searched for on the next cycle whatever it had missed. */
export async function wakeSeason(mediaItemId: number, seasonNumber: number): Promise<void> {
  await db.prepare("DELETE FROM season_searches WHERE media_item_id = ? AND season_number = ?").run(mediaItemId, seasonNumber);
}
