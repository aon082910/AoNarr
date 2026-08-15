import { db } from "../db/client.js";

interface ImportedEvent {
  itemId: number;
  episodeId?: number | null;
  subItemId?: number | null;
  sourceFile?: string;
  quality?: string | null;
}

export interface RepeatedImport {
  mediaItemId: number;
  mediaTitle: string;
  target: string;
  importCount: number;
  qualities: (string | null)[];
}

/**
 * A media item/episode/sub-item imported more than once is either a genuine quality upgrade
 * (worth confirming the old file was actually replaced, not left behind) or a wasted duplicate
 * grab. AoNarr only ever keeps one `path`/`file_path` per row, so this can't detect files
 * literally sitting side by side on disk — it reconstructs the pattern from the import history
 * instead, which is what actually indicates the behavior worth reviewing.
 */
export function findRepeatedImports(): RepeatedImport[] {
  const rows = db
    .prepare("SELECT media_item_id, data, created_at FROM history WHERE event_type = 'imported' ORDER BY created_at ASC")
    .all() as { media_item_id: number; data: string | null; created_at: string }[];

  const groups = new Map<string, { mediaItemId: number; episodeId?: number | null; subItemId?: number | null; qualities: (string | null)[] }>();

  for (const row of rows) {
    if (!row.data) continue;
    let event: ImportedEvent;
    try {
      event = JSON.parse(row.data);
    } catch {
      continue;
    }
    const key = `${row.media_item_id}:${event.episodeId ?? ""}:${event.subItemId ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.qualities.push(event.quality ?? null);
    } else {
      groups.set(key, {
        mediaItemId: row.media_item_id,
        episodeId: event.episodeId,
        subItemId: event.subItemId,
        qualities: [event.quality ?? null],
      });
    }
  }

  const out: RepeatedImport[] = [];
  for (const group of groups.values()) {
    if (group.qualities.length < 2) continue;
    const mediaRow = db.prepare("SELECT title FROM media_items WHERE id = ?").get(group.mediaItemId) as
      | { title: string }
      | undefined;
    if (!mediaRow) continue;

    let target = mediaRow.title;
    if (group.episodeId) {
      const ep = db.prepare("SELECT season_number, episode_number FROM episodes WHERE id = ?").get(group.episodeId) as
        | { season_number: number; episode_number: number }
        | undefined;
      if (ep) {
        target = `${mediaRow.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
      }
    } else if (group.subItemId) {
      const sub = db.prepare("SELECT title FROM sub_items WHERE id = ?").get(group.subItemId) as
        | { title: string }
        | undefined;
      if (sub) target = `${mediaRow.title} - ${sub.title}`;
    }

    out.push({
      mediaItemId: group.mediaItemId,
      mediaTitle: mediaRow.title,
      target,
      importCount: group.qualities.length,
      qualities: group.qualities,
    });
  }

  return out.sort((a, b) => b.importCount - a.importCount);
}
