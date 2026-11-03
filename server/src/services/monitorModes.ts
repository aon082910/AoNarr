import { db } from "../db/index.js";
import { upcomingEpisodes } from "./metadata.js";

/**
 * The "Monitor" choice of the Add screens and the import lists, and the "Monitor New Items" choice an
 * item keeps. Sonarr offers the first for a series' episodes, Lidarr and Readarr for an artist's albums
 * and an author's books; the second says what a later refresh does with something new.
 */

/** Sonarr's "Monitor" dropdown for a series (all = every episode). */
export const SERIES_MONITOR_MODES = ["all", "future", "missing", "existing", "recent", "latestSeason", "firstSeason", "pilot", "none"] as const;
/** Lidarr's and Readarr's "Monitor" dropdown for the albums or books of an artist or author. */
export const COLLECTION_MONITOR_MODES = ["all", "future", "missing", "existing", "first", "latest", "none"] as const;
/** all: every new episode, album or book; none: none; new: only what is newer than what the item already has. */
export const NEW_ITEM_MODES = ["all", "none", "new"] as const;

export type NewItemMode = (typeof NEW_ITEM_MODES)[number];

export function isNewItemMode(value: unknown): value is NewItemMode {
  return typeof value === "string" && (NEW_ITEM_MODES as readonly string[]).includes(value);
}

/** True for a mode either list accepts, so an import list (which adds movies, series and artists) can store one value. */
export function isMonitorMode(value: unknown): boolean {
  return typeof value === "string" && ((SERIES_MONITOR_MODES as readonly string[]).includes(value) || (COLLECTION_MONITOR_MODES as readonly string[]).includes(value));
}

/**
 * Which of a series' episodes a Monitor choice keeps monitored (the rest are switched off). Since
 * this only ever runs against a brand new add (nothing downloaded yet), "existing" comes out as
 * "monitor nothing": there is nothing existing yet to monitor.
 */
export function episodesToMonitor(
  episodes: { seasonNumber: number; episodeNumber: number; airDate: string | null }[],
  strategy: string
): Set<string> {
  const key = (s: number, e: number) => `${s}:${e}`;
  const realSeasons = episodes.map((e) => e.seasonNumber).filter((s) => s > 0);
  const minSeason = realSeasons.length > 0 ? Math.min(...realSeasons) : 0;
  const maxSeason = realSeasons.length > 0 ? Math.max(...realSeasons) : 0;
  const today = new Date().toISOString().slice(0, 10);

  switch (strategy) {
    case "none":
    case "existing":
      return new Set();
    case "future":
      return new Set(upcomingEpisodes(episodes, today).map((e) => key(e.seasonNumber, e.episodeNumber)));
    case "recent":
    case "latestSeason":
    case "latest":
      return new Set(episodes.filter((e) => e.seasonNumber === maxSeason).map((e) => key(e.seasonNumber, e.episodeNumber)));
    case "firstSeason":
    case "first":
      return new Set(episodes.filter((e) => e.seasonNumber === minSeason).map((e) => key(e.seasonNumber, e.episodeNumber)));
    case "pilot":
      return new Set([key(minSeason, 1)]);
    case "missing":
    case "all":
    default:
      return new Set(episodes.map((e) => key(e.seasonNumber, e.episodeNumber)));
  }
}

/** Which of an artist's albums or an author's books a Monitor choice keeps, by key. A brand new add: "existing" keeps none. */
export function subItemsToMonitor(items: { key: string; releaseDate: string | null }[], mode: string): Set<string> {
  const today = new Date().toISOString().slice(0, 10);
  const dated = items.filter((i) => i.releaseDate).sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)));
  switch (mode) {
    case "none":
    case "existing":
      return new Set();
    case "future":
      return new Set(items.filter((i) => i.releaseDate && String(i.releaseDate).slice(0, 10) > today).map((i) => i.key));
    case "first":
      return new Set(dated.length > 0 ? [dated[0].key] : []);
    case "latest":
      return new Set(dated.length > 0 ? [dated[dated.length - 1].key] : []);
    case "missing":
    case "all":
    default:
      return new Set(items.map((i) => i.key));
  }
}

/** Applies a Monitor choice to the episodes a series has, switching off those it does not keep. */
export async function applyEpisodeMonitorMode(mediaItemId: number | bigint | null | undefined, mode: string): Promise<void> {
  if (mediaItemId == null || !mode || mode === "all") return;
  const rows = (await db.prepare("SELECT id, season_number, episode_number, air_date FROM episodes WHERE media_item_id = ?").all(Number(mediaItemId))) as {
    id: number;
    season_number: number;
    episode_number: number;
    air_date: string | null;
  }[];
  const keep = episodesToMonitor(
    rows.map((r) => ({ seasonNumber: Number(r.season_number), episodeNumber: Number(r.episode_number), airDate: r.air_date })),
    mode
  );
  await db.transaction(async () => {
    for (const r of rows) {
      if (!keep.has(`${Number(r.season_number)}:${Number(r.episode_number)}`)) await db.prepare("UPDATE episodes SET monitored = 0 WHERE id = ?").run(r.id);
    }
  });
}

/** Applies a Monitor choice to the albums or books an artist or author has, switching off those it does not keep. */
export async function applySubItemMonitorMode(mediaItemId: number | bigint | null | undefined, mode: string): Promise<void> {
  if (mediaItemId == null || !mode || mode === "all") return;
  const rows = (await db.prepare("SELECT id, release_date FROM sub_items WHERE media_item_id = ?").all(Number(mediaItemId))) as {
    id: number;
    release_date: string | null;
  }[];
  const keep = subItemsToMonitor(rows.map((r) => ({ key: String(r.id), releaseDate: r.release_date })), mode);
  await db.transaction(async () => {
    for (const r of rows) {
      if (!keep.has(String(r.id))) await db.prepare("UPDATE sub_items SET monitored = 0 WHERE id = ?").run(r.id);
    }
  });
}

/** The item's "Monitor New Items" choice; null (never set) keeps the behavior from before the choice existed. */
export async function monitorNewItemsOf(mediaItemId: number | bigint): Promise<NewItemMode | null> {
  const row = (await db.prepare("SELECT monitor_new_items FROM media_items WHERE id = ?").get(Number(mediaItemId))) as { monitor_new_items: string | null } | undefined;
  return isNewItemMode(row?.monitor_new_items) ? row!.monitor_new_items : null;
}

/**
 * Whether an album or book the provider lists after the first sync is monitored. `latestKnown` is the
 * latest release date among what the item already has. With no mode set it is monitored, as it was
 * before the choice existed.
 */
export function newSubItemMonitored(mode: NewItemMode | null, releaseDate: string | null, latestKnown: string | null): boolean {
  if (mode === "none") return false;
  if (mode !== "new") return true;
  if (!latestKnown) return true;
  if (!releaseDate) return false;
  return String(releaseDate).slice(0, 10) > String(latestKnown).slice(0, 10);
}
