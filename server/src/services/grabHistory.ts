import { db } from "../db/index.js";
import type { SearchResult } from "../types/index.js";

/**
 * The history row of a grab. Besides the release as the indexer gave it, the row says how it came to be
 * grabbed (an automatic search, the RSS sync, the admin picking it by hand and whether over a rejection),
 * the quality it was graded, and the client it went to. The target is kept in columns of its own
 * (episode, sub-item, season), because the queue row that held them is removed once the download is done.
 */
export interface GrabHistoryExtras {
  /** "auto", "rss", "irc", "interactive", ... : the queue's grab_source. */
  source: string;
  quality: string | null;
  client: { id: number; name: string } | null;
  /** The admin grabbed a release the list rejected, by choosing "grab anyway". */
  forced?: boolean;
  formatScore?: number | null;
  releaseGroup?: string | null;
  /** The id the client knows the download by, so the history row can be linked back to it. */
  downloadId?: string | null;
  /** Throttlearr held this grab back before sending it: the seconds it waited. */
  heldForSeconds?: number | null;
  /** Throttlearr's reason for holding the grab (a `held` row). */
  heldReason?: string | null;
}

export function grabHistoryData(best: SearchResult, extras: GrabHistoryExtras): string {
  return JSON.stringify({
    ...best,
    grabSource: extras.source,
    quality: extras.quality,
    clientId: extras.client?.id ?? null,
    clientName: extras.client?.name ?? null,
    ...(extras.downloadId ? { downloadId: extras.downloadId } : {}),
    ...(extras.heldForSeconds != null ? { heldForSeconds: Math.max(0, Math.round(extras.heldForSeconds)) } : {}),
    ...(extras.heldReason ? { reason: extras.heldReason } : {}),
    ...(extras.forced ? { forced: true } : {}),
    ...(extras.formatScore != null ? { formatScore: extras.formatScore } : {}),
    ...(extras.releaseGroup ? { releaseGroup: extras.releaseGroup } : {}),
  });
}

export async function recordGrabbed(
  mediaItemId: number,
  target: { episodeId: number | null; subItemId: number | null; seasonNumber: number | null },
  best: SearchResult,
  extras: GrabHistoryExtras
): Promise<void> {
  await db
    .prepare(`INSERT INTO history (media_item_id, event_type, data, episode_id, sub_item_id, season_number) VALUES (?, 'grabbed', ?, ?, ?, ?)`)
    .run(mediaItemId, grabHistoryData(best, extras), target.episodeId, target.subItemId, target.seasonNumber);
}

/**
 * Throttlearr kept a grab back until its download client has room. One row per grab, written when it is held, so a
 * title's history says what happened and why before the `grabbed` row that follows once the grab is sent. A failure
 * to send (a refused release, a hold that ran out) is the ordinary `failed` row.
 */
export async function recordHeld(
  mediaItemId: number,
  target: { episodeId: number | null; subItemId: number | null; seasonNumber: number | null },
  best: SearchResult,
  extras: GrabHistoryExtras & { heldReason: string }
): Promise<void> {
  await db
    .prepare(`INSERT INTO history (media_item_id, event_type, data, episode_id, sub_item_id, season_number) VALUES (?, 'held', ?, ?, ?, ?)`)
    .run(mediaItemId, grabHistoryData(best, extras), target.episodeId, target.subItemId, target.seasonNumber);
}
