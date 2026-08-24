import { log } from "./logger.js";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { searchAllIndexers } from "./indexerClient.js";
import { getDownloadClientAdapter } from "./downloadClient.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "./releaseParser.js";
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
import { runAutoArchival } from "./archival.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { runTraktSync } from "./traktSync.js";
import { runAllImportLists } from "./importLists.js";
import { recordDiskUsageSamples } from "./storageForecast.js";
import { runScheduledBackup } from "./scheduledBackup.js";
import { purgeExpiredRecycleBinEntries } from "./recycleBin.js";
import { syncFromProwlarr } from "./prowlarrSync.js";
import { checkForCorruptMedia } from "./corruptMediaCheck.js";
import { getGroupReputation, recordGroupFailure } from "./releaseGroupStats.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
import { findUpgradeCandidates } from "./upgradeCandidates.js";
import { fetchCollectionChildrenFor } from "./metadata.js";
import { scanAndImportAllLibraries, refreshAllLibraries } from "./libraryScan.js";
import { getSetting } from "./settingsStore.js";
import { registerJob, startAllJobs } from "./jobRegistry.js";
import type { DownloadClient, Indexer, MediaItem, QueueItem, SearchResult } from "../types/index.js";

function rowsToIndexers(): Indexer[] {
  return (db.prepare("SELECT * FROM indexers").all() as any[]).map(indexerFromRow);
}

function rowsToDownloadClients(): DownloadClient[] {
  return (db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all() as any[]).map(
    downloadClientFromRow
  );
}

function getQualityProfile(id: number | null) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(id);
  return row ? qualityProfileFromRow(row) : null;
}

function isAlreadyQueued(mediaItemId: number, episodeId: number | null, subItemId: number | null): boolean {
  if (episodeId) {
    return !!db
      .prepare("SELECT id FROM queue WHERE episode_id = ? AND status NOT IN ('failed')")
      .get(episodeId);
  }
  if (subItemId) {
    return !!db
      .prepare("SELECT id FROM queue WHERE sub_item_id = ? AND status NOT IN ('failed')")
      .get(subItemId);
  }
  return !!db
    .prepare(
      "SELECT id FROM queue WHERE media_item_id = ? AND episode_id IS NULL AND sub_item_id IS NULL AND status NOT IN ('failed')"
    )
    .get(mediaItemId);
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
  target: { season: number; episode: number } | null,
  blocklisted: Set<string>,
  mediaType: string
): Promise<ChosenResult | null> {
  const notBlocklisted = results.filter((r) => !blocklisted.has(r.title));
  const withParsed = notBlocklisted.map((r) => ({ result: r, parsed: parseReleaseTitle(r.title) }));

  const episodeFiltered = target
    ? withParsed.filter(({ parsed }) => releaseMatchesEpisode(parsed, target.season, target.episode))
    : withParsed;

  // Drop releases whose size doesn't fit their claimed quality's configured size range — usually
  // a mislabeled or fake release (e.g. a 200MB file claiming to be 1080p).
  const relevant = episodeFiltered.filter(({ result, parsed }) =>
    sizeWithinQualityBounds(parsed.quality, result.size ?? null)
  );
  if (relevant.length === 0) return null;

  const qualities = relevant.map(({ parsed }) => parsed.quality);
  const best = allowedQualities.length > 0 ? pickBestAllowedQuality(qualities, allowedQualities, cutoff) : qualities[0];
  if (!best) return null;

  const candidates = relevant
    .filter(({ parsed }) => parsed.quality === best)
    .map(({ result }) => ({ result, ...scoreRelease(result.title, result.size ?? null, qualityProfileId, mediaType) }))
    .filter((c) => c.totalScore >= minFormatScore);
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

  db.prepare(
    `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).run(
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

  db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
    mediaItem.id,
    JSON.stringify(best)
  );

  await notifyGrabbed(mediaItem.title, best.title);
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
  const indexers = rowsToIndexers();

  const clients = rowsToDownloadClients();
  if (clients.length === 0) {
    log.info("[scheduler] skipping auto-search: no enabled download clients configured");
    return;
  }

  const monitoredItems = (
    db.prepare("SELECT * FROM media_items WHERE monitored = 1").all() as any[]
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

    const profile = getQualityProfile(item.qualityProfileId);
    const allowedQualities = profile?.allowedQualities ?? [];
    const cutoff = profile?.cutoff ?? "";
    const minFormatScore = profile?.minFormatScore ?? 0;

    try {
      const shape = getMediaTypeConfig(item.type).shape;
      const blocklisted = await getBlocklistedTitles(item.id);

      if (shape === "single") {
        if (item.hasFile || isAlreadyQueued(item.id, null, null)) continue;
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
          item.type
        );
        if (best) {
          const targetClient = pickClientForProtocol(clients, best.result.protocol);
          if (targetClient) await grab(targetClient, item, null, null, best);
          else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
        }
      } else if (shape === "episodic") {
        const episodes = db
          .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
          .all(item.id) as any[];

        for (const ep of episodes) {
          if (isAlreadyQueued(item.id, ep.id, null)) continue;
          const season = String(ep.season_number).padStart(2, "0");
          const episode = String(ep.episode_number).padStart(2, "0");
          const query = `${item.title} S${season}E${episode}`;
          const results = await searchAllIndexers(indexers, query, item.type);
          const best = await chooseBestResult(
            results,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            { season: ep.season_number, episode: ep.episode_number },
            blocklisted,
            item.type
          );
          if (best) {
            const targetClient = pickClientForProtocol(clients, best.result.protocol);
            if (targetClient) await grab(targetClient, item, ep.id, null, best);
            else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
          }
        }
      } else {
        // collection shape: albums / books / comic issues / videos / lessons
        const subItems = db
          .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
          .all(item.id) as any[];

        for (const sub of subItems) {
          if (isAlreadyQueued(item.id, null, sub.id)) continue;

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
            item.type
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
  const indexers = rowsToIndexers();
  const clients = rowsToDownloadClients();
  const results: BulkSearchResult[] = [];

  for (const t of targets) {
    try {
      const itemRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(t.mediaItemId) as any;
      if (!itemRow) {
        results.push({ ...t, grabbed: false, error: "Media item not found" });
        continue;
      }
      const item = mediaItemFromRow(itemRow) as MediaItem;
      const profile = getQualityProfile(item.qualityProfileId);
      const allowedQualities = profile?.allowedQualities ?? [];
      const cutoff = profile?.cutoff ?? "";
      const minFormatScore = profile?.minFormatScore ?? 0;
      const blocklisted = await getBlocklistedTitles(item.id);

      let query: string;
      let episodeTarget: { season: number; episode: number } | null = null;
      if (t.episodeId) {
        const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(t.episodeId) as any;
        if (!ep) {
          results.push({ ...t, grabbed: false, error: "Episode not found" });
          continue;
        }
        episodeTarget = { season: ep.season_number, episode: ep.episode_number };
        query = `${item.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
      } else if (t.subItemId) {
        const sub = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(t.subItemId) as any;
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
        item.type
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
  const candidates = findUpgradeCandidates();
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
  const channels = db.prepare("SELECT * FROM media_items WHERE type = 'video' AND monitored = 1").all() as any[];
  if (channels.length === 0) return;

  const ytClientRow = db.prepare("SELECT * FROM download_clients WHERE type = 'ytdlp' AND enabled = 1 LIMIT 1").get() as any;

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
      (db.prepare("SELECT external_id FROM sub_items WHERE media_item_id = ?").all(channel.id) as { external_id: string | null }[])
        .map((r) => r.external_id)
        .filter((id): id is string => !!id)
    );

    for (const child of children) {
      if (!child.externalId || existingIds.has(child.externalId)) continue;
      const insertResult = db
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
          db.prepare(
            `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
             VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
          ).run(channel.id, insertResult.lastInsertRowid, child.title, ytClientRow.id, grab.downloadId);
          db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
            channel.id,
            JSON.stringify({ title: child.title, source: sourceUrl })
          );
          notifyGrabbed(channel.title, child.title).catch(() => {});
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
  const mediaRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(match.mediaItemId) as any;
  const mediaTitle = mediaRow?.title ?? match.title;

  db.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)").run(
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
    const profile = getQualityProfile(item.qualityProfileId);
    const blocklisted = await getBlocklistedTitles(item.id);

    let episodeTarget: { season: number; episode: number } | null = null;
    let query: string;
    if (match.episodeId) {
      const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(match.episodeId) as any;
      if (!ep) throw new Error("episode no longer exists");
      episodeTarget = { season: ep.season_number, episode: ep.episode_number };
      query = `${item.title} S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
    } else if (match.subItemId) {
      const sub = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(match.subItemId) as any;
      if (!sub) throw new Error("sub-item no longer exists");
      query = `${item.title} ${sub.title}`;
    } else {
      query = item.year ? `${item.title} ${item.year}` : item.title;
    }

    const indexers = rowsToIndexers();
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

    const clients = rowsToDownloadClients();
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
  const clients = rowsToDownloadClients();
  const active = (
    db.prepare("SELECT * FROM queue WHERE status IN ('queued','downloading')").all() as any[]
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
          db.prepare(
            `UPDATE queue SET progress = ?, status = ?, updated_at = datetime('now'), last_progress_at = datetime('now') WHERE id = ?`
          ).run(status.progress, status.status, match.id);
        } else {
          db.prepare(`UPDATE queue SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
            status.status,
            match.id
          );
        }

        if (status.status === "completed") {
          try {
            await importQueueItem(match.id);
          } catch (err) {
            if (err instanceof ImportSkippedError) {
              log.info(`[scheduler] import skipped for "${match.title}": ${err.message}`);
            } else {
              log.warn(`[scheduler] import failed for "${match.title}":`, (err as Error).message);
              db.prepare("UPDATE queue SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(
                match.id
              );
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
    db
      .prepare(
        `SELECT * FROM queue WHERE status = 'downloading'
         AND last_progress_at IS NOT NULL AND last_progress_at <= datetime('now', ?)`
      )
      .all(`-${thresholdHours} hours`) as any[]
  ).map(queueItemFromRow) as QueueItem[];

  for (const item of stalled) {
    // Not every download-client adapter exposes a way to cancel a specific download at the
    // client itself (no such method in the shared adapter interface) — this drops it from
    // AoNarr's own queue and retries the search; the stale entry may need manual cleanup at the
    // download client's own UI.
    db.prepare("UPDATE queue SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(item.id);
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
