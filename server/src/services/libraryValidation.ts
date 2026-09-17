import { db } from "../db/index.js";
import { fetchAllLibraryFiles } from "./mediaServer.js";
import { pathTail } from "./archival.js";
import { MEDIA_TYPES } from "./mediaTypes.js";

export interface LibraryMismatch {
  mediaItemId: number;
  type: string;
  label: string;
  path: string;
}

// Every "single"/"episodic" shape type, not just movie/series — a connected media server can just
// as easily be the source of truth for anime/sports/ppv/adult (all "single" or "episodic" under
// the hood), and this used to silently report zero mismatches for those libraries regardless of
// actual state.
const SINGLE_SHAPE_TYPES = Object.values(MEDIA_TYPES)
  .filter((t) => t.shape === "single")
  .map((t) => t.key);
const EPISODIC_SHAPE_TYPES = Object.values(MEDIA_TYPES)
  .filter((t) => t.shape === "episodic")
  .map((t) => t.key);

/**
 * Cross-references every AoNarr library entry that has a file against what the configured media
 * server's own library actually reports ("single"/"episodic" shapes only — Plex/Jellyfin/Emby have
 * no concept of AoNarr's other library shapes like books/comics/ROMs). Flags anything AoNarr thinks
 * exists that the media server doesn't see at all — a stale path, a permissions issue, or a file
 * moved/deleted outside AoNarr's own pipeline. Same tail-matching heuristic as auto-archival and
 * the webhook receiver, since the two apps often see the same file under different mount points.
 */
export async function findLibraryMismatches(): Promise<LibraryMismatch[]> {
  const serverFiles = await fetchAllLibraryFiles();
  if (serverFiles.length === 0) return [];
  const serverTails = new Set(serverFiles.map((f) => pathTail(f.path)));

  const mismatches: LibraryMismatch[] = [];

  const singlePlaceholders = SINGLE_SHAPE_TYPES.map(() => "?").join(",");
  const items = (await db
    .prepare(`SELECT id, title, path, type FROM media_items WHERE has_file = 1 AND type IN (${singlePlaceholders}) AND path IS NOT NULL`)
    .all(...SINGLE_SHAPE_TYPES)) as { id: number; title: string; path: string; type: string }[];
  for (const item of items) {
    if (!serverTails.has(pathTail(item.path))) {
      mismatches.push({ mediaItemId: item.id, type: item.type, label: item.title, path: item.path });
    }
  }

  const episodicPlaceholders = EPISODIC_SHAPE_TYPES.map(() => "?").join(",");
  const episodes = (await db
    .prepare(
      `SELECT e.id, e.file_path, e.season_number, e.episode_number, m.id AS media_item_id, m.title AS parent_title, m.type AS media_type
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND m.type IN (${episodicPlaceholders})`
    )
    .all(...EPISODIC_SHAPE_TYPES)) as {
    id: number;
    file_path: string;
    season_number: number;
    episode_number: number;
    media_item_id: number;
    parent_title: string;
    media_type: string;
  }[];
  for (const ep of episodes) {
    if (!serverTails.has(pathTail(ep.file_path))) {
      mismatches.push({
        mediaItemId: ep.media_item_id,
        type: ep.media_type,
        label: `${ep.parent_title} — S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`,
        path: ep.file_path,
      });
    }
  }

  return mismatches;
}
