import { db } from "../db/index.js";
import { log } from "./logger.js";
import { replaceXemAliases, type XemAlias } from "./releaseAliases.js";

/**
 * TheXEM's scene names for a show (thexem.info/map/names): the titles scene groups call it, some for the whole
 * show ("all") and some for one season ("Shingeki no Kyojin: The Final Season" is season 4). Stored as 'xem_alias'
 * rows carrying their season, so a release that names a cour by its own title and numbers its episodes from 1 is
 * read as that season's episode (releaseAliases.ts applyAliasSeason), the work Round 4 left for later.
 */

const MAX_NAMES = 40;

/** The names out of a `map/names` answer: { "<season>" | "all": { "<language>": [names] } }. */
export function parseXemNames(body: unknown): XemAlias[] {
  const data = (body as any)?.data;
  if ((body as any)?.result !== "success" || !data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: XemAlias[] = [];
  for (const [key, byLanguage] of Object.entries(data as Record<string, unknown>)) {
    const season = key === "all" ? null : Number(key);
    if (season !== null && (!Number.isInteger(season) || season < 0)) continue;
    if (!byLanguage || typeof byLanguage !== "object") continue;
    for (const names of Object.values(byLanguage as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) if (typeof name === "string" && name.trim()) out.push({ title: name.trim(), season });
    }
  }
  return out.slice(0, MAX_NAMES);
}

/** Fetches and stores the show's XEM names. Best effort: a show TheXEM does not know has none, and a failed
 * request leaves the names the show had. */
export async function syncXemNames(mediaItemId: number, tvdbId: string): Promise<number> {
  let body: unknown;
  try {
    const res = await fetch(`https://thexem.info/map/names?origin=tvdb&id=${encodeURIComponent(tvdbId)}`);
    if (!res.ok) return 0;
    body = await res.json();
  } catch (err) {
    log.info(`[xemNames] item ${mediaItemId}: TheXEM names request failed (${(err as Error).message})`);
    return 0;
  }
  const names = parseXemNames(body);
  if ((body as any)?.result !== "success") return 0;
  const stored = await replaceXemAliases(mediaItemId, names);
  if (stored > 0) log.info(`[xemNames] item ${mediaItemId}: ${stored} TheXEM name(s)`);
  return stored;
}

/** How many of a show's alias rows came from TheXEM (for the tests and the admin's own look). */
export async function xemNameCount(mediaItemId: number): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM media_item_titles WHERE media_item_id = ? AND source = 'xem_alias'").get(mediaItemId)) as { c: number | string };
  return Number(row.c);
}
