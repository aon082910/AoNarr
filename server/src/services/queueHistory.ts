import type { QueueItem } from "../types/index.js";
import { parseReleaseTitle } from "./releaseParser.js";

/**
 * What a history row says about the download it belongs to (Sonarr keys every grabbed, imported and failed row by the
 * download id): the release as named, the id the client knows it by, the client and indexer, the size, where it was
 * downloaded and the group. Kept inside the row's JSON `data`, so it needs no migration. A page can link a history row,
 * a blocklist entry and a queue row back to one download with it.
 */
export function queueHistoryFields(queueItem: Pick<QueueItem, "title" | "downloadId" | "downloadClientId" | "indexerId" | "size" | "downloadPath">): Record<string, unknown> {
  const group = parseReleaseTitle(queueItem.title).releaseGroup;
  return {
    releaseTitle: queueItem.title,
    downloadId: queueItem.downloadId ?? null,
    clientId: queueItem.downloadClientId ?? null,
    indexerId: queueItem.indexerId ?? null,
    size: queueItem.size ?? null,
    sourcePath: queueItem.downloadPath ?? null,
    ...(group ? { releaseGroup: group } : {}),
  };
}
