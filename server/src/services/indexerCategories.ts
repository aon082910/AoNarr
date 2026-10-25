/**
 * Torznab/Newznab category ids. The first digit group is the parent: 1xxx Console, 2xxx Movies,
 * 3xxx Audio, 4xxx PC, 5xxx TV, 6xxx XXX, 7xxx Books, 8xxx Other. Ids from 100000 up are an
 * indexer's own custom categories (Jackett numbers a private tracker's that way).
 */

const CUSTOM_CATEGORY_FLOOR = 100_000;

function parentOf(id: number): number {
  return Math.floor(id / 1000);
}

function idsIn(list: string): number[] {
  return list
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The categories one search of a media type sends. An indexer's own `categories` setting is the
 * admin's list for that indexer, but it is one list for every type: a TV tracker set to "5000,5040"
 * would otherwise be asked for books and albums in the TV categories. So the setting is used for the
 * types it covers (an id under one of the type's parent groups, with the indexer's custom ids) and
 * the type's default otherwise. A list of custom ids alone, which cannot be told apart by type, is
 * used for every type, as the admin wrote it.
 */
export function categoriesFor(override: string | null | undefined, defaults: string): string {
  const configured = idsIn((override ?? "").trim());
  if (configured.length === 0) return defaults;
  const standard = configured.filter((id) => id < CUSTOM_CATEGORY_FLOOR);
  if (standard.length === 0) return configured.join(",");
  const groups = new Set(idsIn(defaults).map(parentOf));
  const covered = standard.filter((id) => groups.has(parentOf(id)));
  if (covered.length === 0) return defaults;
  return [...covered, ...configured.filter((id) => id >= CUSTOM_CATEGORY_FLOOR)].join(",");
}

/** The parent groups each media type is searched in (mediaTypes.ts indexerCategory). */
const TYPE_GROUPS: Record<string, number[]> = {
  movie: [2],
  ppv: [2, 5],
  series: [5],
  anime: [5],
  sports: [5],
  course: [5],
  adult: [6],
  artist: [3],
  audiobook: [3],
  author: [7],
  comic: [7],
  manga: [7],
  rom: [1, 4],
};

/**
 * The media types an indexer that lists these categories can serve, from the parent group of each:
 * a movie-only tracker is not asked for books, albums or ROMs on every cycle. Null when the list
 * names no category this app knows (an indexer that reports none), which leaves its media types as
 * they are.
 */
export function mediaTypesForCategories(ids: number[]): string[] | null {
  const groups = new Set(ids.filter((id) => Number.isInteger(id) && id > 0 && id < CUSTOM_CATEGORY_FLOOR).map(parentOf));
  const types = Object.entries(TYPE_GROUPS)
    .filter(([, wanted]) => wanted.some((group) => groups.has(group)))
    .map(([type]) => type);
  return types.length > 0 ? types : null;
}
