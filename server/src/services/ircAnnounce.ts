import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "./releaseParser.js";
import { guessTitleFromText, titlesMatch } from "./libraryScan.js";
import { scoreRelease } from "./customFormatScoring.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { downloadClientFromRow, mediaItemFromRow, qualityProfileFromRow } from "../db/mappers.js";
import { grab, isAlreadyQueued, pickClientForProtocol, type ChosenResult } from "./scheduler.js";
import { computeAbsoluteEpisodeNumber } from "./importer.js";
import { usesQualityTiers } from "./quality.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
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

// Announces are handled without waiting for each other, and a grab only records its queue row after
// the download client has accepted the release (seconds, for a .torrent URL). Two announces for one
// target in that window (a group's 720p and 1080p posted together) would both pass isAlreadyQueued
// and both be grabbed, so each target's check-and-grab runs one announce at a time.
const targetChains = new Map<string, Promise<unknown>>();

function serializeForTarget<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (targetChains.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  targetChains.set(key, settled);
  void settled.then(() => {
    if (targetChains.get(key) === settled) targetChains.delete(key);
  });
  return run;
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
    // baseTitle has the year stripped, so without this a same-title remake (or the original) from
    // another year would be grabbed for this item. One year of slack, as libraryScan's matching allows.
    if (parsed.year != null && item.year != null && Math.abs(parsed.year - item.year) > 1) continue;
    const attempted = await serializeForTarget(`item:${item.id}`, async () => {
      if (await isAlreadyQueued(item.id, null, null)) return false;
      await tryGrabMatch(item, null, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
      return true;
    });
    if (attempted) return; // one announce maps to at most one grab
  }

  const episodes = (await db
    .prepare(
      `SELECT e.*, m.id AS parent_id, m.type AS parent_type, m.title AS parent_title, m.year AS parent_year,
              m.quality_profile_id AS parent_quality_profile_id, m.root_folder_id AS parent_root_folder_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.monitored = 1 AND e.has_file = 0 AND m.monitored = 1`
    )
    .all()) as any[];
  for (const ep of episodes) {
    if (!titlesMatch(baseTitle, ep.parent_title)) continue;
    // Same year guard as above: "Charmed.2018.S01E01" is the reboot, not an episode of the 1998 show.
    if (parsed.year != null && ep.parent_year != null && Math.abs(parsed.year - ep.parent_year) > 1) continue;
    if (parsed.seasonNumber === null || !parsed.episodeNumbers?.length) continue;
    const absoluteEpisode = ep.parent_type === "anime" ? await computeAbsoluteEpisodeNumber(ep.parent_id, ep.season_number, ep.episode_number) : null;
    if (!releaseMatchesEpisode(parsed, ep.season_number, ep.episode_number, ep.scene_season_number, ep.scene_episode_number, absoluteEpisode)) continue;
    const item = mediaItemFromRow({
      id: ep.parent_id,
      type: ep.parent_type,
      title: ep.parent_title,
      year: ep.parent_year,
      quality_profile_id: ep.parent_quality_profile_id,
      root_folder_id: ep.parent_root_folder_id,
    });
    const attempted = await serializeForTarget(`episode:${ep.id}`, async () => {
      if (await isAlreadyQueued(ep.parent_id, ep.id, null)) return false;
      await tryGrabMatch(item, ep.id, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
      return true;
    });
    if (attempted) return;
  }
}

/** The item's delay profile, picked the way the scheduled search picks it: the first tag-scoped
 * profile matching one of its tags (in saved order), else the untagged default. An announce is
 * seconds old, so any positive delay holds it back (the scheduled search grabs the release once it
 * has aged past the delay) unless the profile lets a cutoff-quality release bypass the delay. */
async function delayProfileHoldsBack(
  mediaItemId: number,
  protocol: IrcFeedRow["protocol"],
  quality: string,
  cutoff: string | null
): Promise<boolean> {
  const profile = (await db
    .prepare(
      `SELECT enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality
       FROM delay_profiles
       WHERE tag_id IS NULL OR tag_id IN (SELECT tag_id FROM media_item_tags WHERE media_item_id = ?)
       ORDER BY (tag_id IS NULL), order_index, id
       LIMIT 1`
    )
    .get(mediaItemId)) as
    | {
        enable_usenet: number;
        enable_torrent: number;
        usenet_delay_minutes: number;
        torrent_delay_minutes: number;
        bypass_if_highest_quality: number;
      }
    | undefined;
  if (!profile) return false;
  if (protocol === "torrent" ? !profile.enable_torrent : !profile.enable_usenet) return true;
  const delayMinutes = Number(protocol === "torrent" ? profile.torrent_delay_minutes : profile.usenet_delay_minutes) || 0;
  if (delayMinutes <= 0) return false;
  return !(profile.bypass_if_highest_quality && cutoff && quality === cutoff);
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
  // Types without quality tiers (books, ROMs...) still carry a video-tier profile that no announce
  // for them could match; the scheduled search ignores it for them too.
  const tiered = usesQualityTiers(item.type);
  const allowedQualities = tiered ? profile?.allowedQualities ?? [] : [];
  if (allowedQualities.length > 0 && !allowedQualities.includes(quality)) return;

  const blocklisted = await getBlocklistedTitles(item.id);
  if (blocklisted.has(releaseTitle)) return;

  if (await isRootFolderOverQuota(item.rootFolderId)) {
    log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}" for "${item.title}": its root folder is at/over its configured quota`);
    return;
  }

  if (await delayProfileHoldsBack(item.id, feed.protocol, quality, tiered ? profile?.cutoff ?? null : null)) {
    log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}" for "${item.title}": held back by its delay profile`);
    return;
  }

  const { totalScore, rejected } = await scoreRelease(releaseTitle, null, item.qualityProfileId, item.type, null, item.id);
  if (rejected || totalScore < (profile?.minFormatScore ?? 0)) return;

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
  if (await grab(targetClient, item, episodeId, subItemId, chosen)) {
    log.info(`[irc:${feed.name}] instant-grabbed "${releaseTitle}" for "${item.title}"`);
  }
}
