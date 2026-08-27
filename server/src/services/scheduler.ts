import { log } from "./logger.js";
import { db } from "../db/index.js";
import { nowExpr, nowOffsetHoursExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { searchAllIndexers } from "./indexerClient.js";
import { getDownloadClientAdapter } from "./downloadClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import { pickBestAllowedQuality, preferredSizeDistance, sizeWithinQualityBounds } from "./quality.js";
import { scoreRelease } from "./customFormatScoring.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import {
  downloadClientFromRow,
  indexerFromRow,
  mediaItemFromRow,
  qualityProfileFromRow,
  queueItemFromRow,
} from "../db/mappers.js";
import { importQueueItem, ImportSkippedError } from "./importer.js";
import { notifyFailed, notifyGrabbed } from "./notifications.js";
import { notifyQueueChanged } from "./realtime.js";
import { runAutoArchival } from "./archival.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { runTraktSync } from "./traktSync.js";
import { runPlexWatchlistSync } from "./plexWatchlistSync.js";
import { runAllImportLists } from "./importLists.js";
import { recordDiskUsageSamples } from "./storageForecast.js";
import { runScheduledBackup } from "./scheduledBackup.js";
import { purgeExpiredRecycleBinEntries } from "./recycleBin.js";
import { syncFromProwlarr } from "./prowlarrSync.js";
import { syncFromJackett } from "./jackettSync.js";
import { checkForCorruptMedia } from "./corruptMediaCheck.js";
import { runScheduledDuplicateCheck } from "./duplicateCheck.js";
import { getGroupReputation, recordGroupFailure } from "./releaseGroupStats.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
import { findUpgradeCandidates } from "./upgradeCandidates.js";
import { fetchCollectionChildrenFor } from "./metadata.js";
import { scanAndImportAllLibraries, refreshAllLibraries } from "./libraryScan.js";
import { getSetting } from "./settingsStore.js";
import { getMediaServerConfig, triggerFullMediaServerScan } from "./mediaServer.js";
import { syncWatchStatusFromMediaServer } from "./mediaServerWebhook.js";
import { registerJob, startAllJobs } from "./jobRegistry.js";
import type { DownloadClient, Indexer, MediaItem, QueueItem, SearchResult } from "../types/index.js";

async function rowsToIndexers(): Promise<Indexer[]> {
  return ((await db.prepare("SELECT * FROM indexers").all()) as any[]).map(indexerFromRow);
}

/**
 * Radarr-style "minimum availability" gate for "single"-shape items (movies, ROMs, adult — Movies
 * is the real driving case): "announced"/null searches as soon as the item's added, same as
 * always. "inCinemas" waits until releaseDate has passed. "released" waits releaseDate plus a
 * configurable delay (default 90 days), an approximation of a digital/home-release window since
 * AoNarr only stores one release date per item, not TMDB's separate theatrical/digital/physical
 * dates the way Radarr's own four-tier version does. An item with no releaseDate at all is never
 * gated — there's nothing to wait on, so it behaves like "announced".
 */
function isReleaseAvailableForSearch(item: MediaItem): boolean {
  const availability = item.minimumAvailability;
  if (!availability || availability === "announced") return true;
  if (!item.releaseDate) return true;
  const releaseDate = new Date(item.releaseDate);
  if (isNaN(releaseDate.getTime())) return true;

  const threshold = new Date(releaseDate);
  if (availability === "released") {
    const delayDays = Math.max(0, parseInt(getSetting("minimumAvailabilityReleasedDelayDays") ?? "90", 10) || 90);
    threshold.setDate(threshold.getDate() + delayDays);
  }
  return threshold.getTime() <= Date.now();
}

async function rowsToDownloadClients(): Promise<DownloadClient[]> {
  return ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(
    downloadClientFromRow
  );
}

async function getQualityProfile(id: number | null) {
  if (!id) return null;
  const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(id);
  return row ? qualityProfileFromRow(row) : null;
}

interface DelayProfile {
  enableUsenet: boolean;
  enableTorrent: boolean;
  usenetDelayMinutes: number;
  torrentDelayMinutes: number;
  bypassIfHighestQuality: boolean;
}

/** Every configured delay profile, tag-scoped ones first in their saved order, the untagged
 * default (if any) last — so `pickDelayProfile` can just take the first match. Fetched once per
 * search cycle rather than per item; the table is tiny and rarely changes mid-cycle. */
async function loadDelayProfiles(): Promise<{ tagId: number | null; profile: DelayProfile }[]> {
  const rows = (await db.prepare("SELECT * FROM delay_profiles ORDER BY (tag_id IS NULL), order_index, id").all()) as any[];
  return rows.map((row) => ({
    tagId: row.tag_id,
    profile: {
      enableUsenet: !!row.enable_usenet,
      enableTorrent: !!row.enable_torrent,
      usenetDelayMinutes: row.usenet_delay_minutes,
      torrentDelayMinutes: row.torrent_delay_minutes,
      bypassIfHighestQuality: !!row.bypass_if_highest_quality,
    },
  }));
}

/** First tag-matching profile wins; falls back to the untagged default profile, then to no delay
 * at all (every release eligible immediately) if nothing's configured — same "absent means off"
 * default every other opt-in gate in this file uses (isReleaseAvailableForSearch, quiet hours, ...). */
function pickDelayProfile(profiles: { tagId: number | null; profile: DelayProfile }[], itemTagIds: number[]): DelayProfile | null {
  for (const p of profiles) {
    if (p.tagId !== null && itemTagIds.includes(p.tagId)) return p.profile;
  }
  return profiles.find((p) => p.tagId === null)?.profile ?? null;
}

async function tagIdsForMediaItem(mediaItemId: number): Promise<number[]> {
  const rows = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(mediaItemId)) as {
    tag_id: number;
  }[];
  return rows.map((r) => r.tag_id);
}

/** Gates an automatic (never manual — see the search.ts route's own direct grab) candidate on its
 * configured delay profile: a release younger than its protocol's delay isn't eligible yet, unless
 * that protocol is disabled outright for the profile (never eligible), or bypassIfHighestQuality
 * lets an already-cutoff-quality release through immediately. A release with no publishDate (some
 * indexers omit it) can't have its age judged, so it's let through rather than blocked forever. */
function isEligibleForDelay(quality: string, cutoff: string, result: SearchResult, profile: DelayProfile | null): boolean {
  if (!profile) return true;
  const protocol = result.protocol;
  if (protocol !== "torrent" && protocol !== "usenet") return true; // http/slskd aren't protocol-gated
  if (protocol === "torrent" && !profile.enableTorrent) return false;
  if (protocol === "usenet" && !profile.enableUsenet) return false;
  const delayMinutes = protocol === "torrent" ? profile.torrentDelayMinutes : profile.usenetDelayMinutes;
  if (delayMinutes <= 0) return true;
  if (profile.bypassIfHighestQuality && cutoff && quality === cutoff) return true;
  if (!result.publishDate) return true;
  const publishedAt = new Date(result.publishDate).getTime();
  if (isNaN(publishedAt)) return true;
  return (Date.now() - publishedAt) / 60_000 >= delayMinutes;
}

async function isAlreadyQueued(mediaItemId: number, episodeId: number | null, subItemId: number | null): Promise<boolean> {
  if (episodeId) {
    return !!(await db
      .prepare("SELECT id FROM queue WHERE episode_id = ? AND status NOT IN ('failed')")
      .get(episodeId));
  }
  if (subItemId) {
    return !!(await db
      .prepare("SELECT id FROM queue WHERE sub_item_id = ? AND status NOT IN ('failed')")
      .get(subItemId));
  }
  return !!(await db
    .prepare(
      "SELECT id FROM queue WHERE media_item_id = ? AND episode_id IS NULL AND sub_item_id IS NULL AND status NOT IN ('failed')"
    )
    .get(mediaItemId));
}

interface ChosenResult {
  result: SearchResult;
  quality: string;
}

/**
 * Picks the best result for a target: filters to allowed qualities, prefers matching
 * episode/season, ranks by quality first, then by custom-format score, then seeders. Releases
 * scoring below the profile's minimum custom format score are rejected outright, mirroring
 * Sonarr/Radarr's "minimum custom format score" gate.
 */
async function chooseBestResult(
  results: SearchResult[],
  allowedQualities: string[],
  cutoff: string,
  qualityProfileId: number | null,
  minFormatScore: number,
  target: { season: number; episode: number } | { airDate: string } | null,
  blocklisted: Set<string>,
  mediaType: string,
  delayProfile: DelayProfile | null = null
): Promise<ChosenResult | null> {
  const notBlocklisted = results.filter((r) => !blocklisted.has(r.title));
  const withParsed = notBlocklisted
    .map((r) => ({ result: r, parsed: parseReleaseTitle(r.title) }))
    .filter(({ result, parsed }) => isEligibleForDelay(parsed.quality, cutoff, result, delayProfile));

  const episodeFiltered = !target
    ? withParsed
    : "airDate" in target
    ? withParsed.filter(({ parsed }) => releaseMatchesAirDate(parsed, target.airDate))
    : withParsed.filter(({ parsed }) => releaseMatchesEpisode(parsed, target.season, target.episode));

  // Drop releases whose size doesn't fit their claimed quality's configured size range — usually
  // a mislabeled or fake release (e.g. a 200MB file claiming to be 1080p).
  const relevant = episodeFiltered.filter(({ result, parsed }) =>
    sizeWithinQualityBounds(parsed.quality, result.size ?? null)
  );
  if (relevant.length === 0) return null;

  const qualities = relevant.map(({ parsed }) => parsed.quality);
  const best = allowedQualities.length > 0 ? pickBestAllowedQuality(qualities, allowedQualities, cutoff) : qualities[0];
  if (!best) return null;

  const candidates = (
    await Promise.all(
      relevant
        .filter(({ parsed }) => parsed.quality === best)
        .map(async ({ result }) => ({ result, ...(await scoreRelease(result.title, result.size ?? null, qualityProfileId, mediaType)) }))
    )
  ).filter((c) => c.totalScore >= minFormatScore);
  if (candidates.length === 0) return null;

  // getGroupReputation is now async (DB-backed) — a .sort() comparator can't await, so reputation
  // for every distinct release group in play is precomputed into a plain Map first, and the
  // comparator does a synchronous lookup against it.
  const releaseGroups = new Set(candidates.map((c) => parseReleaseTitle(c.result.title).releaseGroup));
  const reputationByGroup = new Map<string | null, number>(
    await Promise.all(Array.from(releaseGroups).map(async (g) => [g, await getGroupReputation(g)] as const))
  );

  candidates.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      (b.result.seeders ?? 0) - (a.result.seeders ?? 0) ||
      (reputationByGroup.get(parseReleaseTitle(b.result.title).releaseGroup) ?? 0.5) -
        (reputationByGroup.get(parseReleaseTitle(a.result.title).releaseGroup) ?? 0.5) ||
      preferredSizeDistance(best, a.result.size ?? null) - preferredSizeDistance(best, b.result.size ?? null)
  );
  const winner = candidates[0]?.result;
  return winner ? { result: winner, quality: best } : null;
}

async function grab(
  client: DownloadClient,
  mediaItem: MediaItem,
  episodeId: number | null,
  subItemId: number | null,
  chosen: ChosenResult,
  retryCount = 0
): Promise<void> {
  const { result: best, quality } = chosen;
  const adapter = getDownloadClientAdapter(client.type);
  const grabResult = await adapter.addDownload(client, best.downloadUrl, client.category, best.title);

  await db
    .prepare(
      `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
    )
    .run(
      mediaItem.id,
      episodeId,
      subItemId,
      best.title,
      best.indexerId,
      client.id,
      grabResult.downloadId,
      best.size,
      quality,
      retryCount
    );

  await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
    mediaItem.id,
    JSON.stringify(best)
  );

  await notifyGrabbed(mediaItem.title, best.title);
  notifyQueueChanged();
  log.info(`[scheduler] grabbed "${best.title}" for "${mediaItem.title}"`);
}

/** A grabbed release only works with a download client that speaks its protocol — picking
 * `clients[0]` blindly (the old behavior) breaks the moment more than one client type is
 * configured, which is now common since http/ytdlp clients coexist with qBittorrent/SABnzbd. */
function pickClientForProtocol(clients: DownloadClient[], protocol: SearchResult["protocol"]): DownloadClient | null {
  const typesForProtocol: Record<string, string[]> = {
    torrent: ["qbittorrent", "realdebrid", "alldebrid", "blackhole"],
    usenet: ["sabnzbd", "blackhole"],
    http: ["http"],
  };
  const preferred = typesForProtocol[protocol] ?? [];
  return clients.find((c) => preferred.includes(c.type)) ?? null;
}

/** Parses "HH:MM" into minutes-since-midnight and checks whether the current local time falls
 * inside [start, end) — handles the common overnight case (e.g. 22:00–06:00) by treating
 * start > end as wrapping past midnight. Returns null (caller decides the fallback) if the window
 * is unparseable or zero-width. */
function isWithinTimeWindow(start: string, end: string): boolean | null {
  const toMinutes = (hhmm: string): number | null => {
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  if (startMin === null || endMin === null || startMin === endMin) return null;

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // wraps past midnight
}

function isWithinQuietHours(): boolean {
  if (getSetting("quietHoursEnabled") !== "1") return false;
  const start = getSetting("quietHoursStart");
  const end = getSetting("quietHoursEnd");
  if (!start || !end) return false;
  return isWithinTimeWindow(start, end) ?? false;
}

/** Beyond quiet hours (which just pauses inside a window), this restricts auto-search to running
 * only inside a configured daily window — e.g. "only between 2am and 6am" — instead of every
 * `searchIntervalMinutes` around the clock. Independent of quiet hours; both can be configured
 * together (though doing so is redundant, whichever is more restrictive wins). */
function isOutsideSearchWindow(): boolean {
  if (getSetting("searchWindowEnabled") !== "1") return false;
  const start = getSetting("searchWindowStart");
  const end = getSetting("searchWindowEnd");
  if (!start || !end) return false;
  const within = isWithinTimeWindow(start, end);
  return within === null ? false : !within;
}

/** For each monitored, fileless target (movie / episode / album / book), search and grab the best release. */
async function runAutoSearch(signal?: AbortSignal) {
  if (isWithinQuietHours()) {
    log.info("[scheduler] skipping auto-search: within configured quiet hours");
    return;
  }
  if (isOutsideSearchWindow()) {
    log.info("[scheduler] skipping auto-search: outside the configured search window");
    return;
  }

  // Not gated on indexers.length: a yt-dlp-only setup (Online Videos, no torrent/usenet indexer
  // at all) is valid, and each searchAllIndexers() call below already no-ops cleanly on an empty
  // indexer list.
  const indexers = await rowsToIndexers();

  const clients = await rowsToDownloadClients();
  if (clients.length === 0) {
    log.info("[scheduler] skipping auto-search: no enabled download clients configured");
    return;
  }

  const delayProfiles = await loadDelayProfiles();

  const monitoredItems = (
    (await db.prepare("SELECT * FROM media_items WHERE monitored = 1").all()) as any[]
  ).map(mediaItemFromRow) as MediaItem[];

  for (const item of monitoredItems) {
    if (signal?.aborted) {
      log.info("[scheduler] auto-search cancelled");
      return;
    }
    if (await isRootFolderOverQuota(item.rootFolderId)) {
      log.info(`[scheduler] skipping "${item.title}": its root folder is at/over its configured quota`);
      continue;
    }

    const profile = await getQualityProfile(item.qualityProfileId);
    const allowedQualities = profile?.allowedQualities ?? [];
    const cutoff = profile?.cutoff ?? "";
    const minFormatScore = profile?.minFormatScore ?? 0;
    const delayProfile = pickDelayProfile(delayProfiles, await tagIdsForMediaItem(item.id));

    try {
      const shape = getMediaTypeConfig(item.type).shape;
      const blocklisted = await getBlocklistedTitles(item.id);

      if (shape === "single") {
        if (item.hasFile || (await isAlreadyQueued(item.id, null, null))) continue;
        if (!isReleaseAvailableForSearch(item)) {
          log.info(`[scheduler] skipping "${item.title}": not yet available per its minimum-availability setting`);
          continue;
        }
        const query = item.year ? `${item.title} ${item.year}` : item.title;
        const results = await searchAllIndexers(indexers, query, item.type);
        const best = await chooseBestResult(
          results,
          allowedQualities,
          cutoff,
          item.qualityProfileId,
          minFormatScore,
          null,
          blocklisted,
          item.type,
          delayProfile
        );
        if (best) {
          const targetClient = pickClientForProtocol(clients, best.result.protocol);
          if (targetClient) await grab(targetClient, item, null, null, best);
          else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
        }
      } else if (shape === "episodic") {
        const episodes = (await db
          .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
          .all(item.id)) as any[];

        const isDaily = item.seriesType === "daily";
        for (const ep of episodes) {
          if (await isAlreadyQueued(item.id, ep.id, null)) continue;
          if (isDaily && !ep.air_date) continue; // nothing to search by yet (air date not known)
          const query = isDaily
            ? `${item.title} ${ep.air_date}`
            : `${item.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
          const results = await searchAllIndexers(indexers, query, item.type);
          const best = await chooseBestResult(
            results,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            isDaily ? { airDate: ep.air_date } : { season: ep.season_number, episode: ep.episode_number },
            blocklisted,
            item.type,
            delayProfile
          );
          if (best) {
            const targetClient = pickClientForProtocol(clients, best.result.protocol);
            if (targetClient) await grab(targetClient, item, ep.id, null, best);
            else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
          }
        }
      } else {
        // collection shape: albums / books / comic issues / videos / lessons
        const subItems = (await db
          .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
          .all(item.id)) as any[];

        for (const sub of subItems) {
          if (await isAlreadyQueued(item.id, null, sub.id)) continue;

          // Online Videos aren't on Torznab/Newznab indexers at all — a YouTube-sourced video is
          // grabbed directly via yt-dlp using the video id already stored at import time.
          if (item.type === "video" && sub.external_provider === "youtube" && sub.external_id) {
            const ytClient = clients.find((c) => c.type === "ytdlp");
            if (!ytClient) {
              log.warn(`[scheduler] no yt-dlp download client configured, skipping "${sub.title}"`);
              continue;
            }
            await grab(ytClient, item, null, sub.id, {
              result: {
                indexerId: null,
                indexerName: "yt-dlp",
                title: sub.title,
                size: 0,
                seeders: null,
                leechers: null,
                publishDate: null,
                downloadUrl: `https://www.youtube.com/watch?v=${sub.external_id}`,
                protocol: "http",
                category: null,
              },
              quality: "",
            });
            continue;
          }

          const query = `${item.title} ${sub.title}`;
          const results = await searchAllIndexers(indexers, query, item.type);
          const best = await chooseBestResult(
            results,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            null,
            blocklisted,
            item.type,
            delayProfile
          );
          if (best) {
            const targetClient = pickClientForProtocol(clients, best.result.protocol);
            if (targetClient) await grab(targetClient, item, null, sub.id, best);
            else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
          }
        }
      }
    } catch (err) {
      log.warn(`[scheduler] auto-search failed for "${item.title}":`, (err as Error).message);
    }
  }
}

export interface BulkSearchTarget {
  mediaItemId: number;
  episodeId?: number | null;
  subItemId?: number | null;
}

export interface BulkSearchResult extends BulkSearchTarget {
  grabbed: boolean;
  error?: string;
}

/** Same search-and-grab logic as the scheduler's own auto-search, but scoped to an explicit list
 * of targets and run on demand — backs the Library/Missing pages' "bulk search" action. Ignores
 * `monitored`/`hasFile` (the caller already chose specifically what to search for). */
export async function searchAndGrabTargets(targets: BulkSearchTarget[]): Promise<BulkSearchResult[]> {
  const indexers = await rowsToIndexers();
  const clients = await rowsToDownloadClients();
  const delayProfiles = await loadDelayProfiles();
  const results: BulkSearchResult[] = [];

  for (const t of targets) {
    try {
      const itemRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(t.mediaItemId)) as any;
      if (!itemRow) {
        results.push({ ...t, grabbed: false, error: "Media item not found" });
        continue;
      }
      const item = mediaItemFromRow(itemRow) as MediaItem;
      const profile = await getQualityProfile(item.qualityProfileId);
      const allowedQualities = profile?.allowedQualities ?? [];
      const cutoff = profile?.cutoff ?? "";
      const minFormatScore = profile?.minFormatScore ?? 0;
      const blocklisted = await getBlocklistedTitles(item.id);
      const delayProfile = pickDelayProfile(delayProfiles, await tagIdsForMediaItem(item.id));

      let query: string;
      let episodeTarget: { season: number; episode: number } | null = null;
      if (t.episodeId) {
        const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(t.episodeId)) as any;
        if (!ep) {
          results.push({ ...t, grabbed: false, error: "Episode not found" });
          continue;
        }
        episodeTarget = { season: ep.season_number, episode: ep.episode_number };
        query = `${item.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
      } else if (t.subItemId) {
        const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(t.subItemId)) as any;
        if (!sub) {
          results.push({ ...t, grabbed: false, error: "Sub-item not found" });
          continue;
        }
        query = `${item.title} ${sub.title}`;
      } else {
        query = item.year ? `${item.title} ${item.year}` : item.title;
      }

      const searchResults = await searchAllIndexers(indexers, query, item.type);
      const best = await chooseBestResult(
        searchResults,
        allowedQualities,
        cutoff,
        item.qualityProfileId,
        minFormatScore,
        episodeTarget,
        blocklisted,
        item.type,
        delayProfile
      );
      if (!best) {
        results.push({ ...t, grabbed: false, error: "No matching results" });
        continue;
      }
      const targetClient = pickClientForProtocol(clients, best.result.protocol);
      if (!targetClient) {
        results.push({ ...t, grabbed: false, error: `No "${best.result.protocol}" download client configured` });
        continue;
      }
      await grab(targetClient, item, t.episodeId ?? null, t.subItemId ?? null, best);
      results.push({ ...t, grabbed: true });
    } catch (err) {
      results.push({ ...t, grabbed: false, error: (err as Error).message });
    }
  }

  return results;
}

/**
 * Downloaded files never get revisited automatically once imported (see upgradeCandidates.ts) —
 * this job closes that gap for admins who opt in: on its own schedule, it finds everything
 * currently below its quality profile's cutoff and runs it through the same search-and-grab
 * pipeline as a manual bulk search, so a raised cutoff actually gets enforced over time instead
 * of just being a "surface it in a report" affordance. Off by default (`autoUpgradeEnabled`
 * setting) since it consumes indexer/download-client capacity same as any other search.
 */
async function runAutoUpgrade(): Promise<void> {
  if (getSetting("autoUpgradeEnabled") !== "1") return;
  const candidates = await findUpgradeCandidates();
  if (candidates.length === 0) return;

  const targets: BulkSearchTarget[] = candidates.map((c) => ({
    mediaItemId: c.mediaItemId,
    episodeId: c.episodeId ?? null,
    subItemId: c.subItemId ?? null,
  }));
  const results = await searchAndGrabTargets(targets);
  const grabbed = results.filter((r) => r.grabbed).length;
  if (grabbed > 0) log.info(`[scheduler] auto-upgrade: grabbed ${grabbed} of ${candidates.length} upgrade candidate(s)`);
}

/**
 * Online Videos channels only ever get their video list populated once, at add time — there's no
 * Sonarr-style "new episode appeared" concept for them since a channel keeps posting indefinitely.
 * This re-lists every monitored channel's current uploads, inserts any video not already known as
 * a new sub-item, and — if a yt-dlp download client is configured — immediately grabs it, the same
 * way the manual per-video "Download" button does. Un-monitoring a channel (the same flag used
 * everywhere else in the app) is how an admin opts a channel out of this.
 */
async function checkVideoChannels(): Promise<void> {
  const channels = (await db.prepare("SELECT * FROM media_items WHERE type = 'video' AND monitored = 1").all()) as any[];
  if (channels.length === 0) return;

  const ytClientRow = (await db.prepare("SELECT * FROM download_clients WHERE type = 'ytdlp' AND enabled = 1 LIMIT 1").get()) as any;

  let newVideos = 0;
  for (const channel of channels) {
    let externalIds: Record<string, string> = {};
    try {
      externalIds = JSON.parse(channel.external_ids || "{}");
    } catch {
      continue;
    }
    if (!externalIds.youtube) continue;

    let children;
    try {
      children = (await fetchCollectionChildrenFor(externalIds)).children;
    } catch (err) {
      log.warn(`[scheduler] video channel check failed for "${channel.title}":`, (err as Error).message);
      continue;
    }

    const existingIds = new Set(
      ((await db.prepare("SELECT external_id FROM sub_items WHERE media_item_id = ?").all(channel.id)) as { external_id: string | null }[])
        .map((r) => r.external_id)
        .filter((id): id is string => !!id)
    );

    for (const child of children) {
      if (!child.externalId || existingIds.has(child.externalId)) continue;
      const insertResult = await db
        .prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
           VALUES (?, ?, ?, ?, 'youtube', 1)`
        )
        .run(channel.id, child.title, child.releaseDate, child.externalId);
      newVideos++;

      if (ytClientRow) {
        try {
          const sourceUrl = `https://www.youtube.com/watch?v=${child.externalId}`;
          const adapter = getDownloadClientAdapter(ytClientRow.type);
          const grab = await adapter.addDownload(ytClientRow, sourceUrl, ytClientRow.category, child.title);
          await db
            .prepare(
              `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
             VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
            )
            .run(channel.id, insertResult.lastInsertRowid, child.title, ytClientRow.id, grab.downloadId);
          await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
            channel.id,
            JSON.stringify({ title: child.title, source: sourceUrl })
          );
          notifyGrabbed(channel.title, child.title).catch(() => {});
          notifyQueueChanged();
        } catch (err) {
          log.warn(`[scheduler] failed to auto-download new video "${child.title}":`, (err as Error).message);
        }
      }
    }
  }
  if (newVideos > 0) log.info(`[scheduler] video channel check: found ${newVideos} new video(s)`);
}

const MAX_AUTO_RETRIES = 2;

/**
 * A failed grab (either the download client reported failure, or the file couldn't be imported
 * afterward) blocklists the release that failed and tries the next-best result for the same
 * target, up to MAX_AUTO_RETRIES times, before giving up and notifying like before. This mirrors
 * what an admin would do by hand — a single bad release (fake, corrupt, wrong language) shouldn't
 * need a person to notice and manually re-search.
 */
async function retryFailedGrab(match: QueueItem, reason: string): Promise<void> {
  const mediaRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(match.mediaItemId)) as any;
  const mediaTitle = mediaRow?.title ?? match.title;

  await db.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)").run(
    match.mediaItemId,
    match.title,
    match.indexerId,
    reason
  );
  await recordGroupFailure(parseReleaseTitle(match.title).releaseGroup);

  if (!mediaRow || match.retryCount >= MAX_AUTO_RETRIES) {
    await notifyFailed(mediaTitle, reason);
    return;
  }

  try {
    const item = mediaItemFromRow(mediaRow) as MediaItem;
    const profile = await getQualityProfile(item.qualityProfileId);
    const blocklisted = await getBlocklistedTitles(item.id);

    let episodeTarget: { season: number; episode: number } | null = null;
    let query: string;
    if (match.episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(match.episodeId)) as any;
      if (!ep) throw new Error("episode no longer exists");
      episodeTarget = { season: ep.season_number, episode: ep.episode_number };
      query = `${item.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
    } else if (match.subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(match.subItemId)) as any;
      if (!sub) throw new Error("sub-item no longer exists");
      query = `${item.title} ${sub.title}`;
    } else {
      query = item.year ? `${item.title} ${item.year}` : item.title;
    }

    const indexers = await rowsToIndexers();
    const results = await searchAllIndexers(indexers, query, item.type);
    const best = await chooseBestResult(
      results,
      profile?.allowedQualities ?? [],
      profile?.cutoff ?? "",
      item.qualityProfileId,
      profile?.minFormatScore ?? 0,
      episodeTarget,
      blocklisted,
      item.type
    );
    if (!best) {
      log.info(`[scheduler] retry exhausted search results for "${mediaTitle}" — notifying instead`);
      await notifyFailed(mediaTitle, `${reason} (retried, no other releases found)`);
      return;
    }

    const clients = await rowsToDownloadClients();
    const targetClient = pickClientForProtocol(clients, best.result.protocol);
    if (!targetClient) {
      await notifyFailed(mediaTitle, `${reason} (retried, but no "${best.result.protocol}" download client configured)`);
      return;
    }

    await grab(targetClient, item, match.episodeId, match.subItemId, best, match.retryCount + 1);
    log.info(`[scheduler] retried failed grab for "${mediaTitle}" with "${best.result.title}"`);
  } catch (err) {
    log.warn(`[scheduler] retry failed for "${mediaTitle}":`, (err as Error).message);
    await notifyFailed(mediaTitle, reason);
  }
}

/** Poll download clients for progress on active queue items, and import completed ones. */
async function pollQueue() {
  const clients = await rowsToDownloadClients();
  const active = (
    (await db.prepare("SELECT * FROM queue WHERE status IN ('queued','downloading')").all()) as any[]
  ).map(queueItemFromRow) as QueueItem[];
  if (active.length === 0) return;

  for (const client of clients) {
    const adapter = getDownloadClientAdapter(client.type);
    const relevant = active.filter((q) => q.downloadClientId === client.id);
    if (relevant.length === 0) continue;

    try {
      const statuses = await adapter.getStatus(
        client,
        relevant.map((q) => q.downloadId!).filter(Boolean)
      );
      for (const status of statuses) {
        const match = relevant.find((q) => q.downloadId === status.downloadId);
        if (!match) continue;
        // last_progress_at only moves forward when progress actually changed — that's the signal
        // stalled-download cleanup uses to tell "still downloading, just slow" apart from "stuck".
        if (status.progress !== match.progress) {
          await db
            .prepare(
              `UPDATE queue SET progress = ?, status = ?, updated_at = ${nowExpr(db)}, last_progress_at = ${nowExpr(db)} WHERE id = ?`
            )
            .run(status.progress, status.status, match.id);
        } else {
          await db.prepare(`UPDATE queue SET status = ?, updated_at = ${nowExpr(db)} WHERE id = ?`).run(
            status.status,
            match.id
          );
        }
        notifyQueueChanged();

        if (status.status === "completed") {
          try {
            await importQueueItem(match.id);
          } catch (err) {
            if (err instanceof ImportSkippedError) {
              log.info(`[scheduler] import skipped for "${match.title}": ${err.message}`);
            } else {
              log.warn(`[scheduler] import failed for "${match.title}":`, (err as Error).message);
              await db.prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ?`).run(
                match.id
              );
              notifyQueueChanged();
              await retryFailedGrab(match, (err as Error).message);
            }
          }
        } else if (status.status === "failed") {
          await retryFailedGrab(match, "Download failed at the download client");
        }
      }
    } catch (err) {
      log.warn(`[scheduler] queue poll failed for client "${client.name}":`, (err as Error).message);
    }
  }
}

/** Removes/retries queue items whose progress hasn't moved in longer than the configured
 * threshold — a download stuck at the client (dead peers, a paused torrent, a stalled usenet
 * connection) would otherwise sit in the queue forever since pollQueue only acts on status
 * changes the client itself reports. */
async function cleanupStalledDownloads(): Promise<void> {
  const thresholdHours = Math.max(1, parseInt(getSetting("stalledDownloadHours") ?? "6", 10) || 6);
  const stalled = (
    (await db
      .prepare(
        `SELECT * FROM queue WHERE status = 'downloading'
         AND last_progress_at IS NOT NULL AND last_progress_at <= ${nowOffsetHoursExpr(db, -thresholdHours)}`
      )
      .all()) as any[]
  ).map(queueItemFromRow) as QueueItem[];

  for (const item of stalled) {
    // Not every download-client adapter exposes a way to cancel a specific download at the
    // client itself (no such method in the shared adapter interface) — this drops it from
    // AoNarr's own queue and retries the search; the stale entry may need manual cleanup at the
    // download client's own UI.
    await db.prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ?`).run(item.id);
    notifyQueueChanged();
    await retryFailedGrab(item, `Stalled: no progress for over ${thresholdHours}h`);
    log.info(`[scheduler] cleaned up stalled download "${item.title}"`);
  }
}

let started = false;

export function startScheduler() {
  if (started) return;
  started = true;

  registerJob({
    key: "autoSearch",
    name: "Auto Search",
    scheduleType: "cron",
    defaultSchedule: `*/${Math.max(1, config.searchIntervalMinutes)} * * * *`,
    run: (signal) => runAutoSearch(signal),
  });

  registerJob({
    key: "queuePoll",
    name: "Queue Poll",
    scheduleType: "interval",
    defaultSchedule: String(Math.max(5, config.queuePollIntervalSeconds)),
    run: () => pollQueue(),
  });

  registerJob({
    key: "autoArchival",
    name: "Watch-status Auto-Archival",
    scheduleType: "cron",
    defaultSchedule: "0 */6 * * *",
    run: () => runAutoArchival(),
  });

  // Previously watch status only ever got refreshed on a schedule as a side effect of the archival
  // job above — an admin who wanted AoNarr to just track what's been watched (for the dashboard,
  // say) without wanting files auto-archived had no recurring sync at all, only the on-demand
  // dashboard fetch or webhook events. Independent `watchStatusSyncEnabled` setting; runs more
  // often than archival since "what's been watched" benefits from staying fresher than "what to
  // clean up," which doesn't need to react within minutes.
  registerJob({
    key: "watchStatusSync",
    name: "Media Server Watch-status Sync",
    scheduleType: "cron",
    defaultSchedule: "*/30 * * * *",
    run: async () => {
      if (getSetting("watchStatusSyncEnabled") !== "1" || !getMediaServerConfig()) return;
      const r = await syncWatchStatusFromMediaServer();
      if (r.recorded > 0) log.info(`[scheduler] watch-status sync recorded ${r.recorded} new watch event(s)`);
    },
  });

  // The other "more sync options" half of the same ask — a periodic full media-server library
  // scan, independent of (and in addition to) the existing per-import targeted refresh
  // (refreshMediaServerLibrary, still fired on every import regardless of this setting).
  registerJob({
    key: "mediaServerScanSync",
    name: "Media Server Library Scan",
    scheduleType: "cron",
    defaultSchedule: "0 */6 * * *",
    run: async () => {
      if (getSetting("mediaServerScanSyncEnabled") !== "1" || !getMediaServerConfig()) return;
      await triggerFullMediaServerScan();
      log.info("[scheduler] triggered a full media server library scan");
    },
  });

  registerJob({
    key: "traktSync",
    name: "Trakt List Sync",
    scheduleType: "cron",
    defaultSchedule: "0 */12 * * *",
    run: async () => {
      const r = await runTraktSync();
      if (r.added > 0) log.info(`[scheduler] Trakt sync added ${r.added} item(s)`);
    },
  });

  registerJob({
    key: "plexWatchlistSync",
    name: "Plex Watchlist Sync",
    scheduleType: "cron",
    defaultSchedule: "0 */12 * * *",
    run: async () => {
      const r = await runPlexWatchlistSync();
      if (r.added > 0) log.info(`[scheduler] Plex watchlist sync added ${r.added} item(s)`);
    },
  });

  registerJob({
    key: "importLists",
    name: "Import Lists",
    scheduleType: "cron",
    defaultSchedule: "0 */12 * * *",
    run: (signal) => runAllImportLists(signal),
  });

  registerJob({
    key: "diskUsageSampling",
    name: "Disk Usage Sampling",
    scheduleType: "cron",
    defaultSchedule: "0 0 * * *",
    run: async () => recordDiskUsageSamples(),
  });

  registerJob({
    key: "stalledDownloadCleanup",
    name: "Stalled Download Cleanup",
    scheduleType: "cron",
    defaultSchedule: "0 * * * *",
    run: () => cleanupStalledDownloads(),
  });

  registerJob({
    key: "prowlarrSync",
    name: "Prowlarr Indexer Sync",
    scheduleType: "cron",
    defaultSchedule: "0 */6 * * *",
    run: async () => {
      const r = await syncFromProwlarr();
      if (r.error) log.warn(`[scheduler] Prowlarr sync: ${r.error}`);
      else if (r.synced > 0) log.info(`[scheduler] Prowlarr sync: ${r.synced} indexer(s)`);
    },
  });

  registerJob({
    key: "jackettSync",
    name: "Jackett Indexer Sync",
    scheduleType: "cron",
    defaultSchedule: "0 */6 * * *",
    run: async () => {
      const r = await syncFromJackett();
      if (r.error) log.warn(`[scheduler] Jackett sync: ${r.error}`);
      else if (r.synced > 0) log.info(`[scheduler] Jackett sync: ${r.synced} indexer(s)`);
    },
  });

  registerJob({
    key: "corruptMediaCheck",
    name: "Corrupt Media Check",
    scheduleType: "cron",
    defaultSchedule: "0 4 * * 0",
    run: async (signal) => {
      const r = await checkForCorruptMedia(signal);
      if (r.corrupt > 0) log.info(`[scheduler] corrupt media check: ${r.corrupt} of ${r.checked} file(s) failed validation`);
    },
  });

  registerJob({
    key: "duplicateCheck",
    name: "Duplicate Check",
    scheduleType: "cron",
    // Daily rather than corruptMediaCheck's weekly cadence — this only queries media_items, no
    // file I/O, so it's cheap enough to run far more often than a job that opens every file.
    defaultSchedule: "0 5 * * *",
    run: async () => {
      const r = await runScheduledDuplicateCheck();
      if (r.newGroups > 0) log.info(`[scheduler] duplicate check: ${r.newGroups} new duplicate group(s) found`);
    },
  });

  registerJob({
    key: "recycleBinCleanup",
    name: "Recycle Bin Cleanup",
    scheduleType: "cron",
    defaultSchedule: "0 3 * * *",
    run: () => purgeExpiredRecycleBinEntries(),
  });

  registerJob({
    key: "autoUpgrade",
    name: "Auto Upgrade",
    scheduleType: "cron",
    defaultSchedule: "0 */6 * * *",
    run: () => runAutoUpgrade(),
  });

  registerJob({
    key: "videoChannelCheck",
    name: "Video Channel Check",
    scheduleType: "cron",
    defaultSchedule: "0 */4 * * *",
    run: () => checkVideoChannels(),
  });

  registerJob({
    key: "libraryScan",
    name: "Library Scan & Import",
    scheduleType: "cron",
    defaultSchedule: "0 5 * * *",
    run: (signal) => scanAndImportAllLibraries(signal),
  });

  registerJob({
    key: "libraryRefresh",
    name: "Library Refresh",
    scheduleType: "cron",
    defaultSchedule: "0 6 * * 0",
    run: (signal) => refreshAllLibraries(signal),
  });

  registerJob({
    key: "scheduledBackup",
    name: "Scheduled Backup",
    scheduleType: "cron",
    defaultSchedule: "0 * * * *",
    run: () => runScheduledBackup(),
  });

  startAllJobs();

  log.info(
    `[scheduler] started: auto-search every ${config.searchIntervalMinutes}m, queue poll every ${config.queuePollIntervalSeconds}s`
  );
}
