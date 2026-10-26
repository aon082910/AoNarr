import type { SearchResult } from "../types/index.js";

/**
 * What the blocklist knows about a release it blocks, and whether a search result is that release,
 * after Sonarr/Radarr's BlocklistService.Blocklisted:
 *
 * - a torrent is matched by info hash when both sides have one, and otherwise by title (ignoring
 *   case) on the same indexer;
 * - a usenet post (or any other result) is matched by title (ignoring case), and then by publish
 *   date (within two minutes), or by size (within 2 MB) where a side has no date;
 * - a row that recorded a protocol never blocks a result of another one: a failed torrent from a
 *   stalled tracker does not block the healthy NZB of the same name.
 *
 * A row from before these details were kept has only a title (and often an indexer): it blocks a
 * result of the same name on any protocol and any indexer, as it always has.
 */

export interface BlocklistEntry {
  releaseTitle: string;
  protocol: string | null;
  indexerId: number | null;
  size: number | null;
  publishDate: string | null;
  infoHash: string | null;
}

const SAME_POST_SECONDS = 120;
const SAME_POST_BYTES = 2 * 1024 * 1024;

/** The same post to the minute or two: indexers round or shift a usenet post's date. */
function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= SAME_POST_SECONDS * 1000 : a === b;
}

/** Whether the blocklist entry is this search result. */
export function entryBlocksResult(entry: BlocklistEntry, result: Pick<SearchResult, "title" | "protocol" | "indexerId" | "size" | "publishDate" | "infoHash">): boolean {
  if (entry.protocol && entry.protocol !== result.protocol) return false;

  if (result.protocol === "torrent") {
    if (entry.infoHash && result.infoHash) return entry.infoHash.toLowerCase() === result.infoHash.toLowerCase();
    if (entry.releaseTitle.toLowerCase() !== result.title.toLowerCase()) return false;
    // A row that knows its protocol is a recent one: its torrent is the one on its own indexer. An older row
    // knows only the name and keeps blocking that name everywhere.
    if (!entry.protocol) return true;
    return entry.indexerId == null || result.indexerId == null || entry.indexerId === result.indexerId;
  }

  if (entry.releaseTitle.toLowerCase() !== result.title.toLowerCase()) return false;
  if (entry.publishDate && result.publishDate) return sameInstant(entry.publishDate, result.publishDate);
  if (entry.size && result.size) return Math.abs(entry.size - result.size) <= SAME_POST_BYTES;
  return true;
}

/**
 * The blocked releases of one media item. It is a Set of their exact titles too, so a caller that
 * only asks `has(title)` keeps working; chooseBestResult asks `blocks(result)`.
 */
export class Blocklist extends Set<string> {
  constructor(readonly rows: BlocklistEntry[] = []) {
    super(rows.map((e) => e.releaseTitle));
  }

  blocks(result: Pick<SearchResult, "title" | "protocol" | "indexerId" | "size" | "publishDate" | "infoHash">): boolean {
    return this.rows.some((entry) => entryBlocksResult(entry, result));
  }
}

/** Whether a result is blocklisted: by the full match when the set came from the blocklist, by its
 * exact title for a plain set of titles. */
export function isBlockedRelease(blocklisted: Set<string>, result: SearchResult): boolean {
  return blocklisted instanceof Blocklist ? blocklisted.blocks(result) : blocklisted.has(result.title);
}
