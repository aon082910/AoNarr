import { db } from "../db/client.js";
import { fetchAllLibraryFiles } from "./mediaServer.js";
import { pathTail } from "./archival.js";

export interface LibraryMismatch {
  mediaItemId: number;
  type: string;
  label: string;
  path: string;
}

/**
 * Cross-references every AoNarr library entry that has a file against what the configured media
 * server's own library actually reports (movies/episodes only — Plex/Jellyfin/Emby have no
 * concept of AoNarr's other library shapes like books/comics/ROMs). Flags anything AoNarr thinks
 * exists that the media server doesn't see at all — a stale path, a permissions issue, or a file
 * moved/deleted outside AoNarr's own pipeline. Same tail-matching heuristic as auto-archival and
 * the webhook receiver, since the two apps often see the same file under different mount points.
 */
export async function findLibraryMismatches(): Promise<LibraryMismatch[]> {
  const serverFiles = await fetchAllLibraryFiles();
  if (serverFiles.length === 0) return [];
  const serverTails = new Set(serverFiles.map((f) => pathTail(f.path)));

  const mismatches: LibraryMismatch[] = [];

  const items = db
    .prepare("SELECT id, title, path FROM media_items WHERE has_file = 1 AND type = 'movie'")
    .all() as { id: number; title: string; path: string }[];
  for (const item of items) {
    if (!serverTails.has(pathTail(item.path))) {
      mismatches.push({ mediaItemId: item.id, type: "movie", label: item.title, path: item.path });
    }
  }

  const episodes = db
    .prepare(
      `SELECT e.id, e.file_path, e.season_number, e.episode_number, m.id AS media_item_id, m.title AS parent_title
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND m.type = 'series'`
    )
    .all() as { id: number; file_path: string; season_number: number; episode_number: number; media_item_id: number; parent_title: string }[];
  for (const ep of episodes) {
    if (!serverTails.has(pathTail(ep.file_path))) {
      mismatches.push({
        mediaItemId: ep.media_item_id,
        type: "series",
        label: `${ep.parent_title} — S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`,
        path: ep.file_path,
      });
    }
  }

  return mismatches;
}
