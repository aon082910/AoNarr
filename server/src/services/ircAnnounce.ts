import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "./releaseParser.js";
import { guessTitleFromText, titlesMatch } from "./libraryScan.js";
import { scoreRelease } from "./customFormatScoring.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { downloadClientFromRow, mediaItemFromRow, qualityProfileFromRow } from "../db/mappers.js";
import { grab, isAlreadyQueued, pickClientForProtocol, type ChosenResult } from "./scheduler.js";
import type { DownloadClient, SearchResult } from "../types/index.js";

export interface IrcFeedRow {
  id: number;
  name: string;
  announce_regex: string;
  protocol: "torrent" | "usenet";
}

async function rowsToDownloadClients(): Promise<DownloadClient[]> {
  return ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(downloadClientFromRow);
}

/**
 * Autobrr's core mechanic, but matched against AoNarr's own monitored-item model rather than a
 * blind "grab anything matching a filter" firehose: an announce line only ever results in a grab
 * if it matches something already monitored and missing, the same title/episode matching the
 * scheduled auto-search already uses, scored against that item's own quality profile and custom
 * formats. Nothing is grabbed just because a filter matched — the same "does anyone actually want
 * this" gate the scheduled search already enforces, just reacting within seconds instead of up to
 * searchIntervalMinutes later.
 */
export async function handleAnnounce(feed: IrcFeedRow, messageText: string): Promise<void> {
  let match: RegExpMatchArray | null;
  try {
    match = messageText.match(new RegExp(feed.announce_regex));
  } catch (err) {
    log.warn(`[irc:${feed.name}] announce_regex is invalid:`, (err as Error).message);
    return;
  }
  if (!match?.groups?.title || !match.groups.url) return;

  const releaseTitle = match.groups.title;
  const downloadUrl = match.groups.url;
  const parsed = parseReleaseTitle(releaseTitle);
  const baseTitle = guessTitleFromText(releaseTitle);
  if (!baseTitle) return;

  const clients = await rowsToDownloadClients();
  if (clients.length === 0) return;
  const targetClient = pickClientForProtocol(clients, feed.protocol);
  if (!targetClient) return;

  const singleItems = (await db.prepare("SELECT * FROM media_items WHERE monitored = 1 AND has_file = 0").all()) as any[];
  for (const row of singleItems) {
    const item = mediaItemFromRow(row);
    if (getMediaTypeConfig(item.type).shape !== "single") continue;
    if (!titlesMatch(baseTitle, item.title)) continue;
    if (await isAlreadyQueued(item.id, null, null)) continue;
    await tryGrabMatch(item, null, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
    return; // one announce maps to at most one grab
  }

  const episodes = (await db
    .prepare(
      `SELECT e.*, m.id AS parent_id, m.type AS parent_type, m.title AS parent_title, m.quality_profile_id AS parent_quality_profile_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.monitored = 1 AND e.has_file = 0 AND m.monitored = 1`
    )
    .all()) as any[];
  for (const ep of episodes) {
    if (!titlesMatch(baseTitle, ep.parent_title)) continue;
    if (parsed.seasonNumber === null || !parsed.episodeNumbers?.length) continue;
    if (!releaseMatchesEpisode(parsed, ep.season_number, ep.episode_number)) continue;
    if (await isAlreadyQueued(ep.parent_id, ep.id, null)) continue;
    const item = mediaItemFromRow({
      id: ep.parent_id,
      type: ep.parent_type,
      title: ep.parent_title,
      quality_profile_id: ep.parent_quality_profile_id,
    });
    await tryGrabMatch(item, ep.id, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
    return;
  }
}

async function tryGrabMatch(
  item: any,
  episodeId: number | null,
  subItemId: number | null,
  releaseTitle: string,
  downloadUrl: string,
  quality: string,
  feed: IrcFeedRow,
  targetClient: DownloadClient
): Promise<void> {
  const profileRow = item.qualityProfileId ? await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId) : null;
  const profile = profileRow ? qualityProfileFromRow(profileRow) : null;
  const allowedQualities = profile?.allowedQualities ?? [];
  if (allowedQualities.length > 0 && !allowedQualities.includes(quality)) return;

  const blocklisted = await getBlocklistedTitles(item.id);
  if (blocklisted.has(releaseTitle)) return;

  const { totalScore } = await scoreRelease(releaseTitle, null, item.qualityProfileId, item.type);
  if (totalScore < (profile?.minFormatScore ?? 0)) return;

  const result: SearchResult = {
    indexerId: null,
    indexerName: `irc:${feed.name}`,
    title: releaseTitle,
    size: 0,
    seeders: null,
    leechers: null,
    publishDate: new Date().toISOString(),
    downloadUrl,
    protocol: feed.protocol,
    category: null,
  };
  const chosen: ChosenResult = { result, quality };
  await grab(targetClient, item, episodeId, subItemId, chosen);
  log.info(`[irc:${feed.name}] instant-grabbed "${releaseTitle}" for "${item.title}"`);
}
