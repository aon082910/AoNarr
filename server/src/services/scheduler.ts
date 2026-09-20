import { log } from "./logger.js";
import { db } from "../db/index.js";
import { nowExpr, nowOffsetHoursExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { searchAllIndexers } from "./indexerClient.js";
import { getDownloadClientAdapter, removeQueueItemDownload, applyRemotePathMapping } from "./downloadClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import { pickBestAllowedQuality, preferredSizeDistance, qualityRank, sizeWithinQualityBounds } from "./quality.js";
import { scoreRelease } from "./customFormatScoring.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import {
  downloadClientFromRow,
  indexerFromRow,
  mediaItemFromRow,
  qualityProfileFromRow,
  queueItemFromRow,
} from "../db/mappers.js";
import { importQueueItem, ImportSkippedError, computeAbsoluteEpisodeNumber } from "./importer.js";
import { notifyFailed, notifyGrabbed, notifyHealthIssue, notifyManualInteractionRequired, notifyUpdateAvailable } from "./notifications.js";
import { checkForUpdate } from "./updateCheck.js";
import { checkIndexerHealth } from "./indexerClient.js";
import { syncAllSceneNumbering } from "./sceneNumbering.js";
import { checkForDeletedFiles } from "./deletedFileCheck.js";

/** Radarr/Sonarr-style seed-goal cleanup — removes a torrent from every enabled download client
 * that supports it (qBittorrent) once it's met a configured ratio and/or seed-time goal. Both
 * settings default unset (feature off); a goal of "0" is treated as unset too, since a ratio/time
 * goal of literally zero would remove a torrent the instant it finished, which nobody wants. */
export async function runSeedGoalCleanup(): Promise<void> {
  const ratioGoal = parseFloat(getSetting("torrentSeedRatioGoal") ?? "") || null;
  const seedTimeGoalHours = parseFloat(getSetting("torrentSeedTimeGoalHours") ?? "") || null;
  if (ratioGoal === null && seedTimeGoalHours === null) return;

  const clients = await rowsToDownloadClients();
  let totalRemoved = 0;
  for (const client of clients) {
    const adapter = getDownloadClientAdapter(client.type);
    if (!adapter.removeSeededTorrents) continue;
    try {
      const removed = await adapter.removeSeededTorrents(client, ratioGoal, seedTimeGoalHours !== null ? seedTimeGoalHours * 60 : null);
      totalRemoved += removed;
    } catch (err) {
      log.warn(`[scheduler] seed-goal cleanup failed for client "${client.name}":`, (err as Error).message);
    }
  }
  if (totalRemoved > 0) log.info(`[scheduler] seed-goal cleanup: removed ${totalRemoved} torrent(s) that met their seed goal`);
}
import { setSetting } from "./settingsStore.js";
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
import { rescanMissingSubtitles } from "./subtitleRescan.js";
import { runAutoRequestFromWatchHistory } from "./recommendations.js";
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

/** Runs `fn` over `items` with at most `concurrency` in flight at once — plain `Promise.all` would
 * fire every item simultaneously (for a show with dozens of missing episodes, that's dozens of
 * simultaneous full-indexer-fanout searches at once, working against the per-indexer query-limit
 * throttle and backoff this app already has); a strict sequential loop (the previous behavior)
 * is correct but slow for a show with many missing episodes. A small fixed batch size is a
 * reasonable middle ground — real speedup without bursting past what a configured query limit
 * expects "one show's worth of search activity" to look like. */
async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

async function rowsToIndexers(): Promise<Indexer[]> {
  return ((await db.prepare("SELECT * FROM indexers").all()) as any[]).map(indexerFromRow);
}

/**
 * Radarr-style "minimum availability" gate for "single"-shape items (movies, ROMs, adult — Movies
 * is the real driving case): "announced"/null searches as soon as the item's added, same as
 * always. "inCinemas" waits until releaseDate has passed. "released" prefers TMDB's own real
 * Digital/Physical dates (whichever comes first) when it has recorded either — matching Radarr's
 * own multi-date minimumAvailability semantics — falling back to releaseDate plus a configurable
 * delay (default 90 days) only for a movie TMDB hasn't recorded either date for yet. An item with
 * no releaseDate at all is never gated — there's nothing to wait on, so it behaves like "announced".
 */
export function isReleaseAvailableForSearch(item: MediaItem): boolean {
  const availability = item.minimumAvailability;
  if (!availability || availability === "announced") return true;
  if (!item.releaseDate) return true;
  const releaseDate = new Date(item.releaseDate);
  if (isNaN(releaseDate.getTime())) return true;

  if (availability !== "released") return releaseDate.getTime() <= Date.now();

  const realDates = [item.digitalReleaseDate, item.physicalReleaseDate]
    .map((d) => (d ? new Date(d) : null))
    .filter((d): d is Date => !!d && !isNaN(d.getTime()));
  if (realDates.length > 0) {
    return Math.min(...realDates.map((d) => d.getTime())) <= Date.now();
  }

  const threshold = new Date(releaseDate);
  const delayDays = Math.max(0, parseInt(getSetting("minimumAvailabilityReleasedDelayDays") ?? "90", 10) || 90);
  threshold.setDate(threshold.getDate() + delayDays);
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

export async function isAlreadyQueued(mediaItemId: number, episodeId: number | null, subItemId: number | null): Promise<boolean> {
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

export interface ChosenResult {
  result: SearchResult;
  quality: string;
}

/** A single-shape target's own identity (year + external provider ids) — passed to
 * chooseBestResult so it can prefer a release confirmed to actually be this item over an
 * unconfirmed one, without ever excluding the unconfirmed one outright (see matchTierFor). Not
 * meaningful for episodic/collection targets, which already confirm identity via season/episode/
 * air-date matching (releaseMatchesEpisode/releaseMatchesAirDate) — those callers pass `null`. */
export interface TargetIdentity {
  year: number | null;
  externalIds: Record<string, string>;
}

/**
 * 2 = the release's own reported or title-embedded external id matches the target's; 1 = the
 * release's parsed year matches the target's; 0 = neither, or no identity was given at all
 * (episodic/collection searches, which confirm identity a different way). Used purely as an
 * additional sort key in chooseBestResult below, never to exclude a candidate — a title/year
 * mismatch is common even for the objectively correct release (a regional premiere date, an
 * indexer that mis-scraped the year), so this is a tiebreaker among already-viable candidates,
 * not a filter.
 */
export function matchTierFor(result: SearchResult, identity: TargetIdentity | null): number {
  if (!identity) return 0;
  const parsed = parseReleaseTitle(result.title);
  const candidateImdb = (result.imdbId ?? parsed.imdbId)?.toLowerCase();
  if (candidateImdb && identity.externalIds.imdb && candidateImdb === identity.externalIds.imdb.toLowerCase()) return 2;
  if (result.tmdbId && identity.externalIds.tmdb && result.tmdbId === identity.externalIds.tmdb) return 2;
  if (parsed.year != null && identity.year != null && parsed.year === identity.year) return 1;
  return 0;
}

/**
 * Picks the best result for a target: filters to allowed qualities, prefers matching
 * episode/season, ranks by quality first, then by custom-format score, then seeders. Releases
 * scoring below the profile's minimum custom format score are rejected outright, mirroring
 * Sonarr/Radarr's "minimum custom format score" gate.
 */
export async function chooseBestResult(
  results: SearchResult[],
  allowedQualities: string[],
  cutoff: string,
  qualityProfileId: number | null,
  minFormatScore: number,
  target:
    | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null }
    | { airDate: string }
    | null,
  blocklisted: Set<string>,
  mediaType: string,
  delayProfile: DelayProfile | null = null,
  identity: TargetIdentity | null = null
): Promise<ChosenResult | null> {
  const notBlocklisted = results.filter((r) => !blocklisted.has(r.title));
  const withParsed = notBlocklisted
    .map((r) => ({ result: r, parsed: parseReleaseTitle(r.title) }))
    .filter(({ result, parsed }) => isEligibleForDelay(parsed.quality, cutoff, result, delayProfile));

  const episodeFiltered = !target
    ? withParsed
    : "airDate" in target
    ? withParsed.filter(({ parsed }) => releaseMatchesAirDate(parsed, target.airDate))
    : withParsed.filter(({ parsed }) =>
        releaseMatchesEpisode(parsed, target.season, target.episode, target.sceneSeason, target.sceneEpisode, target.absoluteEpisode)
      );

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
        .map(async ({ result }) => ({
          result,
          matchTier: matchTierFor(result, identity),
          ...(await scoreRelease(result.title, result.size ?? null, qualityProfileId, mediaType, result.downloadVolumeFactor ?? null)),
        }))
    )
  ).filter((c) => c.totalScore >= minFormatScore && !c.rejected);
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
      b.matchTier - a.matchTier ||
      (b.result.seeders ?? 0) - (a.result.seeders ?? 0) ||
      (reputationByGroup.get(parseReleaseTitle(b.result.title).releaseGroup) ?? 0.5) -
        (reputationByGroup.get(parseReleaseTitle(a.result.title).releaseGroup) ?? 0.5) ||
      preferredSizeDistance(best, a.result.size ?? null) - preferredSizeDistance(best, b.result.size ?? null)
  );
  const winner = candidates[0]?.result;
  return winner ? { result: winner, quality: best } : null;
}

export async function grab(
  client: DownloadClient,
  mediaItem: MediaItem,
  episodeId: number | null,
  subItemId: number | null,
  chosen: ChosenResult,
  retryCount = 0
): Promise<void> {
  const { result: best, quality } = chosen;
  const adapter = getDownloadClientAdapter(client.type);
  const grabResult = await adapter.addDownload(client, best.downloadUrl, client.category, best.title, best.protocol);

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

/** Debrid client types whose provider can genuinely handle more than one release protocol — right
 * now just TorBox, which caches both torrents and Usenet (Real-Debrid/AllDebrid only ever do
 * torrents, so they're never worth gating on their own downloadTypes). */
const MULTI_PROTOCOL_DEBRID_TYPES = new Set(["torbox"]);

/** A grabbed release only works with a download client that speaks its protocol — picking
 * `clients[0]` blindly (the old behavior) breaks the moment more than one client type is
 * configured, which is now common since http/ytdlp clients coexist with qBittorrent/SABnzbd.
 * A client whose provider handles more than one protocol (see MULTI_PROTOCOL_DEBRID_TYPES) is only
 * considered a match when its own `downloadTypes` setting includes this protocol — unconfigured
 * (null) keeps the historical torrent-only default so existing setups are unaffected until an
 * admin opts a client into Usenet from Settings -> Download Clients. */
export function pickClientForProtocol(clients: DownloadClient[], protocol: SearchResult["protocol"]): DownloadClient | null {
  const typesForProtocol: Record<string, string[]> = {
    torrent: ["qbittorrent", "realdebrid", "alldebrid", "torbox", "blackhole"],
    usenet: ["sabnzbd", "torbox", "blackhole"],
    http: ["http"],
    slskd: ["slskd"],
  };
  const preferred = typesForProtocol[protocol] ?? [];
  return (
    clients.find((c) => {
      if (!preferred.includes(c.type)) return false;
      if (MULTI_PROTOCOL_DEBRID_TYPES.has(c.type)) return (c.downloadTypes ?? ["torrent"]).includes(protocol);
      return true;
    }) ?? null
  );
}

/** Parses "HH:MM" into minutes-since-midnight and checks whether the current local time falls
 * inside [start, end) — handles the common overnight case (e.g. 22:00–06:00) by treating
 * start > end as wrapping past midnight. Returns null (caller decides the fallback) if the window
 * is unparseable or zero-width. */
export function isWithinTimeWindow(start: string, end: string): boolean | null {
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
export async function runAutoSearch(signal?: AbortSignal) {
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
        const identity: TargetIdentity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
        const results = await searchAllIndexers(indexers, query, item.type, false, identity.externalIds);
        const best = await chooseBestResult(
          results,
          allowedQualities,
          cutoff,
          item.qualityProfileId,
          minFormatScore,
          null,
          blocklisted,
          item.type,
          delayProfile,
          identity
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
        await mapWithConcurrency(episodes, 3, async (ep) => {
          if (await isAlreadyQueued(item.id, ep.id, null)) return;
          if (isDaily && !ep.air_date) return; // nothing to search by yet (air date not known)
          // A future-dated episode has no real release to find yet — searching for one anyway
          // just returns noise (unrelated titles that happen to match the query) and risks a
          // false-positive grab. Only compare the date portion (not time-of-day) since an air
          // date is stored as a bare date with no timezone/time — "today" should still search.
          if (ep.air_date && ep.air_date.slice(0, 10) > new Date().toISOString().slice(0, 10)) return;
          // Scene-numbered (TheXEM) season/episode wins the search QUERY when known — that's the
          // numbering a scene-mapped show's releases actually use — while matching still accepts
          // either numbering (see releaseMatchesEpisode's OR), since not every release for such a
          // show necessarily follows the scene convention.
          const searchSeason = ep.scene_season_number ?? ep.season_number;
          const searchEpisode = ep.scene_episode_number ?? ep.episode_number;
          const query = isDaily
            ? `${item.title} ${ep.air_date}`
            : `${item.title} S${String(searchSeason).padStart(2, "0")}E${String(searchEpisode).padStart(2, "0")}`;
          const results = await searchAllIndexers(indexers, query, item.type);
          const best = await chooseBestResult(
            results,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            isDaily
              ? { airDate: ep.air_date }
              : {
                  season: ep.season_number,
                  episode: ep.episode_number,
                  sceneSeason: ep.scene_season_number,
                  sceneEpisode: ep.scene_episode_number,
                  absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null,
                },
            blocklisted,
            item.type,
            delayProfile
          );
          if (best) {
            const targetClient = pickClientForProtocol(clients, best.result.protocol);
            if (targetClient) await grab(targetClient, item, ep.id, null, best);
            else log.warn(`[scheduler] no "${best.result.protocol}" download client configured, skipping "${best.result.title}"`);
          }
        });
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

          // Podcast episodes aren't indexer-searched either — the RSS enclosure URL stored at
          // discovery time (checkPodcastFeeds) is already a direct, downloadable file.
          if (item.type === "podcast" && sub.external_provider === "rss" && sub.external_id) {
            const httpClient = clients.find((c) => c.type === "http");
            if (!httpClient) {
              log.warn(`[scheduler] no "http" download client configured, skipping "${sub.title}"`);
              continue;
            }
            await grab(httpClient, item, null, sub.id, {
              result: {
                indexerId: null,
                indexerName: "rss",
                title: sub.title,
                size: 0,
                seeders: null,
                leechers: null,
                publishDate: null,
                downloadUrl: sub.external_id,
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
  /** When set (auto-upgrade), only a release strictly better than this quality is grabbed. */
  upgradeFromQuality?: string | null;
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
      let episodeTarget:
        | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null }
        | null = null;
      let identity: TargetIdentity | null = null;
      if (t.episodeId) {
        const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(t.episodeId)) as any;
        if (!ep) {
          results.push({ ...t, grabbed: false, error: "Episode not found" });
          continue;
        }
        episodeTarget = {
          season: ep.season_number,
          episode: ep.episode_number,
          sceneSeason: ep.scene_season_number,
          sceneEpisode: ep.scene_episode_number,
          absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null,
        };
        const searchSeason = ep.scene_season_number ?? ep.season_number;
        const searchEpisode = ep.scene_episode_number ?? ep.episode_number;
        query = `${item.title} S${String(searchSeason).padStart(2, "0")}E${String(searchEpisode).padStart(2, "0")}`;
      } else if (t.subItemId) {
        const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(t.subItemId)) as any;
        if (!sub) {
          results.push({ ...t, grabbed: false, error: "Sub-item not found" });
          continue;
        }
        query = `${item.title} ${sub.title}`;
      } else {
        query = item.year ? `${item.title} ${item.year}` : item.title;
        identity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
      }

      const searchResults = await searchAllIndexers(indexers, query, item.type, false, identity?.externalIds);
      const best = await chooseBestResult(
        searchResults,
        allowedQualities,
        cutoff,
        item.qualityProfileId,
        minFormatScore,
        episodeTarget,
        blocklisted,
        item.type,
        delayProfile,
        identity
      );
      if (!best) {
        results.push({ ...t, grabbed: false, error: "No matching results" });
        continue;
      }
      if (t.upgradeFromQuality && qualityRank(best.quality) <= qualityRank(t.upgradeFromQuality)) {
        results.push({ ...t, grabbed: false, error: `Best available (${best.quality}) isn't an upgrade over ${t.upgradeFromQuality}` });
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
export async function runAutoUpgrade(): Promise<void> {
  if (getSetting("autoUpgradeEnabled") !== "1") return;
  const candidates = await findUpgradeCandidates();
  if (candidates.length === 0) return;

  // Skip anything with an upgrade already in flight — the candidate's on-disk quality doesn't
  // change until that import lands, so it would otherwise be re-grabbed every run. The
  // upgradeFromQuality gate below stops an equal-or-worse release from replacing the existing file.
  const targets: BulkSearchTarget[] = [];
  for (const c of candidates) {
    if (await isAlreadyQueued(c.mediaItemId, c.episodeId ?? null, c.subItemId ?? null)) continue;
    targets.push({
      mediaItemId: c.mediaItemId,
      episodeId: c.episodeId ?? null,
      subItemId: c.subItemId ?? null,
      upgradeFromQuality: c.currentQuality,
    });
  }
  if (targets.length === 0) return;
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
export async function checkVideoChannels(): Promise<void> {
  const channels = (await db.prepare("SELECT * FROM media_items WHERE type = 'video' AND monitored = 1").all()) as any[];
  if (channels.length === 0) return;

  // Mapped like grab() does — the raw snake_case row would hand the adapter `audio_only`
  // where it reads `audioOnly`, so scheduled channel downloads ignored the audio-only setting.
  const ytClientRow = (await db.prepare("SELECT * FROM download_clients WHERE type = 'ytdlp' AND enabled = 1 LIMIT 1").get()) as any;
  const ytClient = ytClientRow ? downloadClientFromRow(ytClientRow) : null;

  let newVideos = 0;
  for (const channel of channels) {
    let externalIds: Record<string, string> = {};
    try {
      externalIds = JSON.parse(channel.external_ids || "{}");
    } catch {
      continue;
    }
    if (!externalIds.youtube && !externalIds.youtubePlaylist) continue;

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

      if (ytClient) {
        try {
          const sourceUrl = `https://www.youtube.com/watch?v=${child.externalId}`;
          const adapter = getDownloadClientAdapter(ytClient.type);
          const grab = await adapter.addDownload(ytClient, sourceUrl, ytClient.category, child.title);
          await db
            .prepare(
              `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
             VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
            )
            .run(channel.id, insertResult.lastInsertRowid, child.title, ytClient.id, grab.downloadId);
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

/**
 * Podcasts' equivalent of checkVideoChannels — a podcast keeps posting indefinitely, so there's
 * no Sonarr-style "new episode appeared" concept to react to, just "re-check the feed and see
 * what's new." Every monitored podcast's RSS feed is re-fetched, any `<enclosure>` not already
 * known as a sub-item is inserted, and — if an "http" download client is configured — grabbed
 * immediately via that enclosure's URL directly (no yt-dlp-style resolution step needed, since an
 * RSS enclosure is already a direct file URL). Un-monitoring a podcast opts it out.
 */
export async function checkPodcastFeeds(): Promise<void> {
  const podcasts = (await db.prepare("SELECT * FROM media_items WHERE type = 'podcast' AND monitored = 1").all()) as any[];
  if (podcasts.length === 0) return;

  const httpClientRow = (await db.prepare("SELECT * FROM download_clients WHERE type = 'http' AND enabled = 1 LIMIT 1").get()) as any;
  const httpClient = httpClientRow ? downloadClientFromRow(httpClientRow) : null;

  let newEpisodes = 0;
  for (const podcast of podcasts) {
    let externalIds: Record<string, string> = {};
    try {
      externalIds = JSON.parse(podcast.external_ids || "{}");
    } catch {
      continue;
    }
    if (!externalIds.podcastFeed) continue;

    let children;
    try {
      children = (await fetchCollectionChildrenFor(externalIds)).children;
    } catch (err) {
      log.warn(`[scheduler] podcast feed check failed for "${podcast.title}":`, (err as Error).message);
      continue;
    }

    const existingIds = new Set(
      ((await db.prepare("SELECT external_id FROM sub_items WHERE media_item_id = ?").all(podcast.id)) as { external_id: string | null }[])
        .map((r) => r.external_id)
        .filter((id): id is string => !!id)
    );

    for (const child of children) {
      if (!child.externalId || existingIds.has(child.externalId)) continue;
      const insertResult = await db
        .prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
           VALUES (?, ?, ?, ?, 'rss', 1)`
        )
        .run(podcast.id, child.title, child.releaseDate, child.externalId);
      newEpisodes++;

      if (httpClient) {
        try {
          const adapter = getDownloadClientAdapter(httpClient.type);
          const grab = await adapter.addDownload(httpClient, child.externalId, httpClient.category, child.title);
          await db
            .prepare(
              `INSERT INTO queue (media_item_id, episode_id, sub_item_id, title, indexer_id, download_client_id, download_id, size, quality, status)
             VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, NULL, 'queued')`
            )
            .run(podcast.id, insertResult.lastInsertRowid, child.title, httpClient.id, grab.downloadId);
          await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
            podcast.id,
            JSON.stringify({ title: child.title, source: child.externalId })
          );
          notifyGrabbed(podcast.title, child.title).catch(() => {});
          notifyQueueChanged();
        } catch (err) {
          log.warn(`[scheduler] failed to auto-download new podcast episode "${child.title}":`, (err as Error).message);
        }
      }
    }
  }
  if (newEpisodes > 0) log.info(`[scheduler] podcast feed check: found ${newEpisodes} new episode(s)`);
}

const DEFAULT_MAX_AUTO_RETRIES = 2;

/** Radarr/Sonarr's "Redownload failed" setting — "blocklistAndSearch" (default) tries the
 * next-best release automatically, up to a configurable retry cap; "blocklistOnly" just
 * blocklists and notifies, leaving the re-search to a person or the next scheduled auto-search
 * pass instead of the immediate automatic retry. */
function maxAutoRetries(): number {
  const configured = parseInt(getSetting("maxAutoRetries") ?? "", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_AUTO_RETRIES;
}

/**
 * A failed grab (either the download client reported failure, or the file couldn't be imported
 * afterward) blocklists the release that failed and, unless "Redownload failed" is set to
 * blocklist-only, tries the next-best result for the same target — up to a configurable retry cap
 * — before giving up and notifying like before. This mirrors what an admin would do by hand — a
 * single bad release (fake, corrupt, wrong language) shouldn't need a person to notice and
 * manually re-search.
 */
export async function retryFailedGrab(match: QueueItem, reason: string): Promise<void> {
  const mediaRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(match.mediaItemId)) as any;
  const mediaTitle = mediaRow?.title ?? match.title;

  await db.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)").run(
    match.mediaItemId,
    match.title,
    match.indexerId,
    reason
  );
  await db.prepare("INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'failed', ?)").run(
    match.mediaItemId,
    JSON.stringify({ title: match.title, reason })
  );
  await recordGroupFailure(parseReleaseTitle(match.title).releaseGroup);

  if (!mediaRow || getSetting("failedDownloadBehavior") === "blocklistOnly" || match.retryCount >= maxAutoRetries()) {
    await notifyFailed(mediaTitle, reason);
    return;
  }

  try {
    const item = mediaItemFromRow(mediaRow) as MediaItem;
    const profile = await getQualityProfile(item.qualityProfileId);
    const blocklisted = await getBlocklistedTitles(item.id);

    let episodeTarget:
      | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null }
      | null = null;
    let identity: TargetIdentity | null = null;
    let query: string;
    if (match.episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(match.episodeId)) as any;
      if (!ep) throw new Error("episode no longer exists");
      episodeTarget = {
        season: ep.season_number,
        episode: ep.episode_number,
        sceneSeason: ep.scene_season_number,
        sceneEpisode: ep.scene_episode_number,
        absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null,
      };
      const searchSeason = ep.scene_season_number ?? ep.season_number;
      const searchEpisode = ep.scene_episode_number ?? ep.episode_number;
      query = `${item.title} S${String(searchSeason).padStart(2, "0")}E${String(searchEpisode).padStart(2, "0")}`;
    } else if (match.subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(match.subItemId)) as any;
      if (!sub) throw new Error("sub-item no longer exists");
      query = `${item.title} ${sub.title}`;
    } else {
      query = item.year ? `${item.title} ${item.year}` : item.title;
      identity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
    }

    const indexers = await rowsToIndexers();
    const results = await searchAllIndexers(indexers, query, item.type, false, identity?.externalIds);
    const delayProfiles = await loadDelayProfiles();
    const delayProfile = pickDelayProfile(delayProfiles, await tagIdsForMediaItem(item.id));
    const best = await chooseBestResult(
      results,
      profile?.allowedQualities ?? [],
      profile?.cutoff ?? "",
      item.qualityProfileId,
      profile?.minFormatScore ?? 0,
      episodeTarget,
      blocklisted,
      item.type,
      delayProfile,
      identity
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
    // grab() just inserted a brand-new queue row for the replacement release — this old row (still
    // sitting at status='failed', its own download already dealt with by the caller above) is now
    // superseded and would otherwise linger in the queue forever alongside the active retry, which
    // was the other half of the queue-never-clears-out bug this fixes.
    await db.prepare("DELETE FROM queue WHERE id = ?").run(match.id);
    notifyQueueChanged();
    log.info(`[scheduler] retried failed grab for "${mediaTitle}" with "${best.result.title}"`);
  } catch (err) {
    log.warn(`[scheduler] retry failed for "${mediaTitle}":`, (err as Error).message);
    await notifyFailed(mediaTitle, reason);
  }
}

/** Poll download clients for progress on active queue items, and import completed ones. */
export async function pollQueue() {
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
        // Translated through any configured remote path mapping before it's ever stored, so
        // nothing downstream (importer.ts included) has to know or care whether one applies —
        // undefined (the common case: no mapping configured, or this adapter doesn't report a
        // path at all) leaves the column untouched rather than clobbering it with null.
        const downloadPath = status.remotePath
          ? await applyRemotePathMapping(client.id, status.remotePath)
          : undefined;

        // last_progress_at only moves forward when progress actually changed — that's the signal
        // stalled-download cleanup uses to tell "still downloading, just slow" apart from "stuck".
        if (status.progress !== match.progress) {
          await db
            .prepare(
              `UPDATE queue SET progress = ?, status = ?, updated_at = ${nowExpr(db)}, last_progress_at = ${nowExpr(db)}${downloadPath !== undefined ? ", download_path = ?" : ""} WHERE id = ?`
            )
            .run(...(downloadPath !== undefined ? [status.progress, status.status, downloadPath, match.id] : [status.progress, status.status, match.id]));
        } else {
          await db
            .prepare(
              `UPDATE queue SET status = ?, updated_at = ${nowExpr(db)}${downloadPath !== undefined ? ", download_path = ?" : ""} WHERE id = ?`
            )
            .run(...(downloadPath !== undefined ? [status.status, downloadPath, match.id] : [status.status, match.id]));
        }
        notifyQueueChanged();

        if (status.status === "completed") {
          try {
            await importQueueItem(match.id);
          } catch (err) {
            if (err instanceof ImportSkippedError) {
              log.info(`[scheduler] import skipped for "${match.title}": ${err.message}`);
              const mediaRow = (await db.prepare("SELECT title FROM media_items WHERE id = ?").get(match.mediaItemId)) as
                | { title: string }
                | undefined;
              notifyManualInteractionRequired(mediaRow?.title ?? match.title, err.message).catch((e) =>
                log.warn("[scheduler] notification failed:", e.message)
              );
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
          // A client-level failure (the download itself died — a bad torrent, a failed usenet
          // repair) means there's no completed data worth keeping around, unlike an import-level
          // failure (handled above), where the file did finish downloading and the "Manual
          // import..." picker needs it to still be there. Removed before retrying, not after, so
          // it happens whether or not a replacement release is found.
          if (getSetting("removeFailedDownloads") !== "0") {
            await removeQueueItemDownload(match, true);
          }
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
export async function cleanupStalledDownloads(): Promise<void> {
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
    await db.prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ?`).run(item.id);
    notifyQueueChanged();
    // Not every download-client adapter can cancel a specific download at the client itself
    // (optional on the adapter interface — see downloadClient.ts) — where it can (qBittorrent,
    // SABnzbd), a stalled download is dead weight worth clearing out rather than leaving it stuck
    // at the client's own UI too; where it can't, this is still a no-op, same as before.
    if (getSetting("removeFailedDownloads") !== "0") {
      await removeQueueItemDownload(item, true);
    }
    await retryFailedGrab(item, `Stalled: no progress for over ${thresholdHours}h`);
    log.info(`[scheduler] cleaned up stalled download "${item.title}"`);
  }
}

/** A queue row at status='failed' stays visible on purpose — Retry import / Manual import... /
 * Remove all need something to act on — but if nobody ever does, it would otherwise sit there
 * forever, right back to the same "queue never clears out" problem this whole cleanup pass exists
 * to fix. Prunes any 'failed' row untouched for over a week; its own 'failed' history entry (see
 * retryFailedGrab) already recorded the permanent record, so nothing is lost by dropping the row. */
export async function pruneOldFailedQueueItems(): Promise<void> {
  const stale = (await db
    .prepare(`SELECT id FROM queue WHERE status = 'failed' AND updated_at <= ${nowOffsetHoursExpr(db, -24 * 7)}`)
    .all()) as { id: number }[];
  if (stale.length === 0) return;
  await db.prepare(`DELETE FROM queue WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale.map((s) => s.id));
  notifyQueueChanged();
  log.info(`[scheduler] pruned ${stale.length} week-old failed queue item(s) nobody acted on`);
}

/**
 * Radarr/Sonarr-style "On Health Issue" notification — the System page's health check
 * (routes/system.ts) is only ever computed on demand when someone loads it, so an admin who isn't
 * looking never finds out an indexer died or a root folder is nearly full. This runs the same
 * kind of checks (indexer reachability, download client reachability, low disk space) on a
 * schedule and fires one combined notification, deduped against the last-notified summary (stored
 * in the `lastHealthIssueSummary` setting) so a still-broken indexer doesn't re-notify every run —
 * only a *change* in what's wrong (new issue, resolved issue, or recovery) fires again.
 */
export async function checkHealthAndNotify(): Promise<void> {
  const issues: string[] = [];

  const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(indexerFromRow);
  for (const idx of indexers as any[]) {
    try {
      const result = await checkIndexerHealth(idx);
      if (!result.ok) issues.push(`Indexer "${idx.name}" is unreachable`);
    } catch {
      issues.push(`Indexer "${idx.name}" is unreachable`);
    }
  }

  const clients = await rowsToDownloadClients();
  for (const client of clients) {
    try {
      await getDownloadClientAdapter(client.type).getStatus(client, []);
    } catch {
      issues.push(`Download client "${client.name}" is unreachable`);
    }
  }

  const DISK_WARN_PERCENT_FREE = 10;
  const rootFolders = (await db.prepare("SELECT id, path, min_free_space_gb FROM root_folders").all()) as {
    id: number;
    path: string;
    min_free_space_gb: number | null;
  }[];
  for (const folder of rootFolders) {
    const latest = (await db
      .prepare("SELECT free_bytes, total_bytes FROM disk_usage_samples WHERE root_folder_id = ? ORDER BY sampled_at DESC LIMIT 1")
      .get(folder.id)) as { free_bytes: number; total_bytes: number } | undefined;
    if (!latest || !Number(latest.total_bytes)) continue;
    const percentFree = (Number(latest.free_bytes) / Number(latest.total_bytes)) * 100;
    const freeGb = Number(latest.free_bytes) / 1e9;
    if (percentFree < DISK_WARN_PERCENT_FREE) {
      issues.push(`"${folder.path}" is low on disk space (${Math.round(percentFree)}% free)`);
    } else if (folder.min_free_space_gb != null && freeGb < folder.min_free_space_gb) {
      issues.push(`"${folder.path}" is below its configured minimum free space (${Math.round(freeGb)}GB free, minimum ${folder.min_free_space_gb}GB)`);
    }
  }

  const summary = issues.join("; ");
  const lastSummary = getSetting("lastHealthIssueSummary") ?? "";
  if (summary === lastSummary) return; // nothing changed since the last notification
  setSetting("lastHealthIssueSummary", summary);
  if (summary) await notifyHealthIssue(summary);
}

/** Pushes an "Update Available" notification once per newly-seen round, instead of the System
 * page's existing on-demand check — deduped against `lastNotifiedUpdateRound` (a setting) so an
 * admin who's simply behind for a while doesn't get renotified every single day. */
async function checkAndNotifyUpdate(): Promise<void> {
  let result;
  try {
    result = await checkForUpdate();
  } catch (err) {
    log.warn("[scheduler] update check failed:", (err as Error).message);
    return;
  }
  if (!result.updateAvailable || result.latestRound == null) return;

  const lastNotified = parseInt(getSetting("lastNotifiedUpdateRound") ?? "", 10);
  if (lastNotified === result.latestRound) return;

  setSetting("lastNotifiedUpdateRound", String(result.latestRound));
  await notifyUpdateAvailable(`Round ${result.latestRound} — ${result.latestTitle ?? "see CHANGELOG.md"}`);
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
    run: async () => {
      await cleanupStalledDownloads();
      await pruneOldFailedQueueItems();
    },
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
    key: "autoRequestFromWatchHistory",
    name: "Auto-Request from Watch History",
    scheduleType: "cron",
    defaultSchedule: "0 5 * * *",
    run: () => runAutoRequestFromWatchHistory(),
  });

  registerJob({
    key: "subtitleRescan",
    name: "Subtitle Rescan",
    scheduleType: "cron",
    defaultSchedule: "0 4 * * *",
    run: () => rescanMissingSubtitles(),
  });

  registerJob({
    key: "podcastFeedCheck",
    name: "Podcast Feed Check",
    scheduleType: "cron",
    defaultSchedule: "0 */2 * * *",
    run: () => checkPodcastFeeds(),
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
    key: "updateCheckNotify",
    name: "Update Check Notify",
    scheduleType: "cron",
    defaultSchedule: "0 8 * * *",
    run: () => checkAndNotifyUpdate(),
  });

  registerJob({
    key: "seedGoalCleanup",
    name: "Seed Goal Cleanup",
    scheduleType: "cron",
    defaultSchedule: "0 * * * *",
    run: () => runSeedGoalCleanup(),
  });

  registerJob({
    key: "deletedFileCheck",
    name: "Deleted File Check",
    scheduleType: "cron",
    defaultSchedule: "0 3 * * *",
    run: async () => {
      await checkForDeletedFiles();
    },
  });

  registerJob({
    key: "sceneNumberingSync",
    name: "Scene Numbering Sync (TheXEM)",
    scheduleType: "cron",
    defaultSchedule: "0 2 * * 0",
    run: () => syncAllSceneNumbering(),
  });

  registerJob({
    key: "healthCheckNotify",
    name: "Health Check Notify",
    scheduleType: "cron",
    defaultSchedule: "*/30 * * * *",
    run: () => checkHealthAndNotify(),
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
