import { db } from "../db/client.js";
import { pathTail } from "./archival.js";
import { fetchMediaServerMovies } from "./mediaServer.js";
import { log } from "./logger.js";

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function externalIdsOverlap(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (!a) return false;
  return Object.entries(b).some(([provider, id]) => a[provider] === id);
}

function defaultQualityProfileId(): number | null {
  const row = db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

export interface MediaServerImportResult {
  matched: number;
  created: number;
  skipped: number;
}

/**
 * Imports an already-organized Plex/Jellyfin/Emby movie library into AoNarr — for a library that
 * predates AoNarr and was never Scan & Import'd (which only guesses from filenames, no title/year/
 * poster/external-id metadata) or manually Add Media'd one at a time. Each media-server item is
 * matched against an existing AoNarr item first (by path, then external id, then title+year),
 * falling back to creating a brand new entry with the media server's own metadata — so items that
 * genuinely aren't in AoNarr yet still get imported, not just files that happen to match something
 * already there. Movies only — TV would additionally need per-episode season/episode numbers and
 * parent-show matching, a larger job left for later.
 */
export async function importMoviesFromMediaServer(rootFolderId: number, signal?: AbortSignal): Promise<MediaServerImportResult> {
  const items = await fetchMediaServerMovies();
  const result: MediaServerImportResult = { matched: 0, created: 0, skipped: 0 };

  const knownTails = new Set(
    (db.prepare("SELECT path FROM media_items WHERE type = 'movie' AND path IS NOT NULL").all() as { path: string }[]).map((r) =>
      pathTail(r.path)
    )
  );
  const missingItems = db.prepare("SELECT * FROM media_items WHERE type = 'movie' AND has_file = 0").all() as any[];
  const qualityProfileId = defaultQualityProfileId();

  for (const item of items) {
    if (signal?.aborted) break;
    if (!item.title) {
      result.skipped++;
      continue;
    }
    if (knownTails.has(pathTail(item.path))) {
      result.skipped++;
      continue;
    }

    let externalIds: Record<string, string> = {};
    const match = missingItems.find((m) => {
      try {
        externalIds = m.external_ids ? JSON.parse(m.external_ids) : {};
      } catch {
        externalIds = {};
      }
      return externalIdsOverlap(externalIds, item.externalIds) || (titlesMatch(m.title, item.title) && m.year === item.year);
    });

    if (match) {
      db.prepare(
        `UPDATE media_items SET has_file = 1, path = ?, poster_url = COALESCE(poster_url, ?),
         overview = COALESCE(overview, ?), external_ids = COALESCE(NULLIF(external_ids, '{}'), ?)
         WHERE id = ?`
      ).run(item.path, item.posterUrl, item.overview, JSON.stringify(item.externalIds), match.id);
      match.has_file = 1;
      result.matched++;
    } else {
      db.prepare(
        `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, path, root_folder_id, quality_profile_id, monitored, has_file, status)
         VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'unknown')`
      ).run(
        item.title,
        item.title.toLowerCase(),
        item.year,
        item.overview,
        item.posterUrl,
        JSON.stringify(item.externalIds),
        item.path,
        rootFolderId,
        qualityProfileId
      );
      result.created++;
    }
  }

  log.info(`[mediaServerImport] movies: matched ${result.matched}, created ${result.created}, skipped ${result.skipped}`);
  return result;
}
