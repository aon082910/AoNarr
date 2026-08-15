import fs from "node:fs";
import crypto from "node:crypto";
import { db } from "../db/client.js";

export interface UnmonitoredNoFileItem {
  id: number;
  type: string;
  title: string;
  year: number | null;
  addedAt: string;
}

/** Library items nobody's watching for and that never got a file — safe to delete outright
 * (nothing on disk references them), unlike anything with `has_file = 1`. */
export function findUnmonitoredNoFile(): UnmonitoredNoFileItem[] {
  const rows = db
    .prepare(
      `SELECT id, type, title, year, added_at AS addedAt
       FROM media_items WHERE monitored = 0 AND has_file = 0
       ORDER BY added_at`
    )
    .all() as UnmonitoredNoFileItem[];
  return rows;
}

interface FileRef {
  path: string;
  label: string;
  mediaItemId: number;
}

const SAMPLE_BYTES = 65536; // 64KB from each end — cheap even for multi-GB files

/** Reads a fixed-size sample from the start and end of a file (plus its total size) and hashes
 * that combination — a fast heuristic for "these are almost certainly the same file" without
 * hashing the entire (potentially many-GB) file. False positives are possible in theory but
 * exceedingly unlikely for real media files; this is explicitly a *suggestion* for a human to
 * confirm before deleting anything, never an automatic action. */
function partialHash(filePath: string, size: number): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
      fs.readSync(fd, head, 0, head.length, 0);
      const hash = crypto.createHash("sha1");
      hash.update(head);
      if (size > SAMPLE_BYTES) {
        const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
        fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
        hash.update(tail);
      }
      hash.update(String(size));
      return hash.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function collectFileRefs(): FileRef[] {
  const refs: FileRef[] = [];

  const items = db.prepare("SELECT id, title, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all() as {
    id: number;
    title: string;
    path: string;
  }[];
  for (const item of items) refs.push({ path: item.path, label: item.title, mediaItemId: item.id });

  const episodes = db
    .prepare(
      `SELECT e.file_path AS path, m.title AS parentTitle, e.season_number AS s, e.episode_number AS ep, e.media_item_id AS mediaItemId
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND e.file_path IS NOT NULL`
    )
    .all() as { path: string; parentTitle: string; s: number; ep: number; mediaItemId: number }[];
  for (const e of episodes) {
    refs.push({
      path: e.path,
      label: `${e.parentTitle} — S${String(e.s).padStart(2, "0")}E${String(e.ep).padStart(2, "0")}`,
      mediaItemId: e.mediaItemId,
    });
  }

  const subItems = db
    .prepare(
      `SELECT s.file_path AS path, m.title AS parentTitle, s.title AS childTitle, s.media_item_id AS mediaItemId
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
       WHERE s.has_file = 1 AND s.file_path IS NOT NULL`
    )
    .all() as { path: string; parentTitle: string; childTitle: string; mediaItemId: number }[];
  for (const s of subItems) {
    refs.push({ path: s.path, label: `${s.parentTitle} — ${s.childTitle}`, mediaItemId: s.mediaItemId });
  }

  return refs;
}

export interface DuplicateFileGroup {
  sizeBytes: number;
  files: { path: string; label: string; mediaItemId: number }[];
}

/** Groups library files that are very likely byte-identical (same size + matching partial hash)
 * but live at different paths — usually a re-import that landed in a new location without the old
 * one being cleaned up (e.g. after a naming template change). On-demand only, like the orphaned-
 * file scan; not run automatically. */
export function findDuplicateFiles(): DuplicateFileGroup[] {
  const refs = collectFileRefs();
  const bySize = new Map<number, FileRef[]>();

  for (const ref of refs) {
    let size: number;
    try {
      size = fs.statSync(ref.path).size;
    } catch {
      continue; // file went missing since the DB row was last touched — not this scan's job to fix
    }
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size)!.push(ref);
  }

  const groups: DuplicateFileGroup[] = [];
  for (const [size, sameSize] of bySize) {
    if (sameSize.length < 2) continue;
    const byHash = new Map<string, FileRef[]>();
    for (const ref of sameSize) {
      const hash = partialHash(ref.path, size);
      if (!hash) continue;
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash)!.push(ref);
    }
    for (const matched of byHash.values()) {
      if (matched.length < 2) continue;
      groups.push({ sizeBytes: size, files: matched.map((m) => ({ path: m.path, label: m.label, mediaItemId: m.mediaItemId })) });
    }
  }

  return groups;
}
