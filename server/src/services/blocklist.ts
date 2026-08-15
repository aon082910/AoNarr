import { db } from "../db/client.js";

/** Blocklist matches by exact release title within a media item — release titles are specific
 * enough (group, quality, source) that a normalized/fuzzy match would risk blocking siblings. */
export function isBlocklisted(mediaItemId: number, releaseTitle: string): boolean {
  return !!db
    .prepare("SELECT id FROM blocklist WHERE media_item_id = ? AND release_title = ?")
    .get(mediaItemId, releaseTitle);
}

export function getBlocklistedTitles(mediaItemId: number): Set<string> {
  const rows = db.prepare("SELECT release_title FROM blocklist WHERE media_item_id = ?").all(mediaItemId) as {
    release_title: string;
  }[];
  return new Set(rows.map((r) => r.release_title));
}
