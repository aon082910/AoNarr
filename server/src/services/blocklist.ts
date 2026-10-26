import { db } from "../db/index.js";
import { Blocklist, entryBlocksResult, type BlocklistEntry } from "./blocklistMatch.js";
import type { SearchResult } from "../types/index.js";

/** What a blocklist row is told about its release; everything but the title is optional, and a row
 * that knows less blocks more loosely (see blocklistMatch.ts). */
export interface NewBlocklistEntry {
  mediaItemId: number;
  releaseTitle: string;
  indexerId?: number | null;
  reason?: string | null;
  protocol?: string | null;
  size?: number | null;
  publishDate?: string | null;
  infoHash?: string | null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** BIGINT-safe: a fractional or non-numeric size is dropped rather than failing the insert. */
function wholeSize(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export async function addToBlocklist(entry: NewBlocklistEntry): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason, protocol, size, publish_date, info_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.mediaItemId,
      entry.releaseTitle,
      entry.indexerId ?? null,
      entry.reason ?? null,
      nullableText(entry.protocol),
      wholeSize(entry.size),
      nullableText(entry.publishDate),
      nullableText(entry.infoHash)
    );
  return Number(result.lastInsertRowid);
}

function entryFromRow(row: any): BlocklistEntry {
  return {
    releaseTitle: row.release_title,
    protocol: row.protocol ?? null,
    indexerId: row.indexer_id ?? null,
    size: row.size == null ? null : Number(row.size),
    publishDate: row.publish_date ?? null,
    infoHash: row.info_hash ?? null,
  };
}

/** Whether a release is blocklisted for the media item: the same release (see blocklistMatch.ts),
 * not merely one with the same name. */
export async function isBlocklisted(
  mediaItemId: number,
  releaseOrTitle: string | (Pick<SearchResult, "title"> & Partial<Pick<SearchResult, "protocol" | "indexerId" | "size" | "publishDate" | "infoHash">>)
): Promise<boolean> {
  const release = typeof releaseOrTitle === "string" ? { title: releaseOrTitle } : releaseOrTitle;
  const rows = (await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").all(mediaItemId)) as any[];
  return rows.some((row) =>
    entryBlocksResult(entryFromRow(row), {
      title: release.title,
      // A caller that knows nothing of the release's protocol is asking about its name only.
      protocol: release.protocol ?? ((entryFromRow(row).protocol ?? "torrent") as SearchResult["protocol"]),
      indexerId: release.indexerId ?? null,
      size: release.size ?? 0,
      publishDate: release.publishDate ?? null,
      infoHash: release.infoHash ?? null,
    })
  );
}

/** The media item's blocklist. A Set of the blocked titles too, for callers that only ask by name. */
export async function getBlocklistedTitles(mediaItemId: number): Promise<Blocklist> {
  const rows = (await db.prepare("SELECT * FROM blocklist WHERE media_item_id = ?").all(mediaItemId)) as any[];
  return new Blocklist(rows.map(entryFromRow));
}
