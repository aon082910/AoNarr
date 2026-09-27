import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import { db } from "../db/index.js";
import { nowExpr, nowOffsetHoursExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { searchAllIndexers } from "./indexerClient.js";
import {
  getDownloadClientAdapter,
  removeQueueItemDownload,
  applyRemotePathMapping,
  DOWNLOAD_INTERRUPTED_REASON,
  withQueueImportLock,
} from "./downloadClient.js";
import type { QueueStatusUpdate } from "./downloadClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import {
  knownReleaseSize,
  pickBestAllowedQuality,
  preferredSizeDistance,
  qualityRank,
  sizeWithinQualityBounds,
  usesQualityTiers,
} from "./quality.js";
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
import { findUpgradeCandidates, isDirectSource } from "./upgradeCandidates.js";
import { fetchCollectionChildrenFor } from "./metadata.js";
import { scanAndImportAllLibraries, refreshAllLibraries, childListProviderIds } from "./libraryScan.js";
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

/**
 * Like mapWithConcurrency, but never runs two DIFFERENT media items' candidates concurrently with
 * each other: `candidates` is walked in exactly the order given (runAutoSearch's fair
 * oldest-searched-first sort), and only a run of up to `concurrency` consecutive-in-order
 * candidates that all belong to the SAME media item is ever awaited together. That restores the
 * cross-item-sequential guarantee some shared, only-safe-sequentially state depends on — notably
 * the `unavailable` download-client map (populated only once a grab against a client has actually
 * failed; two different items' candidates racing to read it before either failure registers would
 * both send a real grab to a client already known to be dead) — while still letting one item's own
 * leaf candidates (its episodes, its sub-items) run with concurrency up to `concurrency` among
 * themselves, same as grab()'s own documented invariant just below ("Grabs for one media item run
 * one at a time. Episode searches run concurrently").
 */
async function forEachCandidateAcrossItemsSequentially(
  candidates: AutoSearchCandidate[],
  concurrency: number,
  fn: (candidate: AutoSearchCandidate) => Promise<void>
): Promise<void> {
  let i = 0;
  while (i < candidates.length) {
    const itemId = candidates[i].item.id;
    let j = i + 1;
    while (j < candidates.length && j - i < concurrency && candidates[j].item.id === itemId) j++;
    await mapWithConcurrency(candidates.slice(i, j), concurrency, fn);
    i = j;
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
  // 0 is a valid delay ("search from the release date"); `|| 90` read it as unset.
  const configuredDelay = parseInt(getSetting("minimumAvailabilityReleasedDelayDays") ?? "", 10);
  const delayDays = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 90;
  threshold.setDate(threshold.getDate() + delayDays);
  return threshold.getTime() <= Date.now();
}

async function rowsToDownloadClients(): Promise<DownloadClient[]> {
  return ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1 ORDER BY id").all()) as any[]).map(
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
    if (await db.prepare("SELECT id FROM queue WHERE episode_id = ? AND status NOT IN ('failed')").get(episodeId)) return true;
    const ep = (await db
      .prepare("SELECT media_item_id, season_number, episode_number, scene_season_number, scene_episode_number, air_date FROM episodes WHERE id = ?")
      .get(episodeId)) as
      | {
          media_item_id: number;
          season_number: number;
          episode_number: number;
          scene_season_number: number | null;
          scene_episode_number: number | null;
          air_date: string | null;
        }
      | undefined;
    if (!ep) return false;
    // Another in-flight grab for this season covers this episode only when its release does: a
    // pack of this very season (from a season search, or grabbed for a sibling episode), or one
    // naming this episode. A season search can grab a single-episode release — or another season's
    // pack — too, which must not hold up the rest of the season.
    const sameSeason = (await db
      .prepare("SELECT title FROM queue WHERE media_item_id = ? AND season_number = ? AND status NOT IN ('failed')")
      .all(ep.media_item_id, ep.season_number)) as { title: string }[];
    return sameSeason.some(({ title }) => {
      const parsed = parseReleaseTitle(title);
      // A ranged batch ("S2 - 13-24") covers only its own episodes; releaseMatchesEpisode enforces the range.
      if (parsed.isFullSeason && !parsed.episodeRange) return parsed.seasonNumber == null || parsed.seasonNumber === ep.season_number;
      return (
        releaseMatchesEpisode(parsed, ep.season_number, ep.episode_number, ep.scene_season_number, ep.scene_episode_number) ||
        (!!ep.air_date && releaseMatchesAirDate(parsed, ep.air_date))
      );
    });
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

/** An automatic failure entry only holds a direct (yt-dlp/RSS) grab back for `hours` — the failure
 * is often transient (a yt-dlp that needs updating, a CDN error) and there's no other release to
 * fall back to. An admin's own blocklisting (no reason, from Interactive Search, or "Remove and
 * Blocklist" in Activity) stays permanent. */
async function titlesBlocklistedWithinHours(mediaItemId: number, hours: number): Promise<Set<string>> {
  const rows = (await db
    .prepare(
      `SELECT release_title FROM blocklist WHERE media_item_id = ?
       AND (reason IS NULL OR reason = 'Removed from queue by admin' OR created_at >= ${nowOffsetHoursExpr(db, -hours)})`
    )
    .all(mediaItemId)) as { release_title: string }[];
  return new Set(rows.map((r) => r.release_title));
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

type ReleaseTarget =
  | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null }
  | { airDate: string };

/** The indexer query and release-match target for one episode row. A daily series' releases are
 * named by air date ("Show.2024.08.25..."), which never parse to a season/episode, so an SxxEyy
 * target would reject every one of them. */
async function episodeSearchFor(item: MediaItem, ep: any): Promise<{ query: string; target: ReleaseTarget }> {
  if (item.seriesType === "daily" && ep.air_date) {
    return { query: `${item.title} ${ep.air_date}`, target: { airDate: ep.air_date } };
  }
  const searchSeason = ep.scene_season_number ?? ep.season_number;
  const searchEpisode = ep.scene_episode_number ?? ep.episode_number;
  return {
    query: `${item.title} S${String(searchSeason).padStart(2, "0")}E${String(searchEpisode).padStart(2, "0")}`,
    target: {
      season: ep.season_number,
      episode: ep.episode_number,
      sceneSeason: ep.scene_season_number,
      sceneEpisode: ep.scene_episode_number,
      absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null,
    },
  };
}

/** What a target is called: a whole item's own title, or an album/book/issue's title under its
 * artist/author/series (`parentTitle`). */
export interface TargetName {
  title: string;
  parentTitle?: string | null;
}

export interface ChooseOptions {
  /** The enabled download clients: a release whose protocol none of them takes is never chosen, so
   * an NZB with no usenet client can't beat a grabbable torrent. Omitted = no protocol filter. */
  clients?: DownloadClient[];
  /** Rank of the file the target already has (-1 when its quality is unknown): only a strictly
   * higher quality is considered. Omitted/null = the target has no file. */
  upgradeFromRank?: number | null;
  /** For a type with no quality tiers, only a release naming this target is considered. */
  name?: TargetName | null;
  /** Indexer priorities (lower is preferred), a ranking key for types with no quality tiers. */
  indexers?: Pick<Indexer, "id" | "priority">[];
  /** Human-readable "media title" (plus episode/season where relevant) for this call's log lines
   * only — has no effect on matching/scoring. Omitted = log lines drop the "for ..." suffix. */
  label?: string | null;
}

/** indexers.priority's column default. */
const DEFAULT_INDEXER_PRIORITY = 25;

const TITLE_STOPWORDS = new Set(["a", "an", "the", "and", "of", "to", "in", "on", "at", "for", "by", "with"]);
// A pack names the one album/book it was found for as only one entry of many.
const MULTI_RELEASE_PACK = /\b(discography|discografia|anthology|box[ ._-]?set|trilogy|omnibus|collection|complete[ ._-]+(?:series|works|discography))\b/i;
// Comic issues ("#12 - Name") and manga chapters ("Chapter 5 — Name") as metadata titles them.
const NUMBERED_CHILD = /^\s*(?:#|issue\s*#?\s*|chapter\s*|ch\.?\s*)(\d+(?:\.\d+)?)/i;
const SEQUEL_NUMERALS = new Set(["ii", "iii", "iv", "vi", "vii", "viii", "ix"]);
const VOLUME_WORDS = new Set(["vol", "volume", "pt", "part"]);

/** Whether the wanted title is directly followed by a later volume's marker ("Greatest Hits II",
 * "Greatest Hits Vol. 2"): that's the next volume, not the one wanted. */
function namesLaterVolume(releaseTokens: string[], wanted: string[]): boolean {
  for (let i = 0; i + wanted.length < releaseTokens.length; i++) {
    if (!wanted.every((t, j) => releaseTokens[i + j] === t)) continue;
    const next = releaseTokens[i + wanted.length];
    const after = releaseTokens[i + wanted.length + 1] ?? "";
    if (SEQUEL_NUMERALS.has(next)) return true;
    if (VOLUME_WORDS.has(next) && (SEQUEL_NUMERALS.has(after) || (/^\d{1,2}$/.test(after) && after !== "1"))) return true;
  }
  return false;
}

// Letters NFKD leaves whole, spelled the way release names write them ("Ænima" -> "Aenima").
const FOLDED_LETTERS: Record<string, string> = { æ: "ae", ø: "o", ß: "ss", œ: "oe" };

function titleTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[æøßœ]/g, (c) => FOLDED_LETTERS[c])
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t));
}

/** Types whose metadata titles carry a subtitle their releases usually leave off (Goodreads, iTunes
 * and Open Library book titles). A game's "Series: Subtitle" or an album's "Composer: Work" names
 * the one release apart from the rest of its series, so those always need the whole title. */
const SUBTITLE_OPTIONAL_TYPES = new Set(["author", "audiobook"]);

/**
 * How a release names this target rather than another release of the same artist, author or
 * series: by its whole title, only by the part before a book's subtitle, or not at all (null). A
 * type with no quality tiers is searched by free text ("Artist Album") with nothing like a
 * season/episode to match on, so the query's other hits — another album, a discography, a
 * trilogy — would otherwise be grabbed and imported as this one.
 */
function releaseNameMatch(releaseTitle: string, name: TargetName, mediaType: string): "whole" | "main" | null {
  return releaseNamesTarget(releaseTitle, name)
    ? "whole"
    : SUBTITLE_OPTIONAL_TYPES.has(mediaType) &&
      !NUMBERED_CHILD.test(name.title) &&
      !(MULTI_RELEASE_PACK.test(releaseTitle) && !MULTI_RELEASE_PACK.test(`${name.parentTitle ?? ""} ${name.title}`)) &&
      namesMainTitle(releaseTitle, name)
    ? "main"
    : null;
}

function releaseNamesTarget(releaseTitle: string, name: TargetName): boolean {
  if (MULTI_RELEASE_PACK.test(releaseTitle) && !MULTI_RELEASE_PACK.test(`${name.parentTitle ?? ""} ${name.title}`)) return false;
  const releaseTokens = titleTokens(releaseTitle);
  const counts = new Map<string, number>();
  for (const t of releaseTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const parent = name.parentTitle ? significantTitleTokens(name.parentTitle) : [];
  const numbered = name.title.match(NUMBERED_CHILD);
  // An issue or chapter release carries the series and the number, rarely the issue's own name.
  const wanted = numbered ? [...parent, ...titleTokens(numbered[1])] : significantTitleTokens(name.title);
  // A title of symbols alone ("÷") has no words to look for: the release has to carry the symbols
  // themselves, or any other release of the artist's ("+", "x") would do.
  if (wanted.length === 0) return namesSymbolTitle(releaseTitle, name.title, parent) && parent.every((t) => counts.has(t));
  // A self-titled album ("Metallica - Metallica") names the artist and then the album.
  const selfTitled = !numbered && parent.length > 0 && wanted.every((t) => parent.includes(t));
  const needed = new Map<string, number>();
  for (const t of selfTitled ? [...wanted, ...parent] : wanted) needed.set(t, (needed.get(t) ?? 0) + 1);
  if (!Array.from(needed).every(([t, n]) => (counts.get(t) ?? 0) >= n)) return false;
  return !!numbered || !namesLaterVolume(releaseTokens.filter((t) => !TITLE_STOPWORDS.has(t)), wanted);
}

/**
 * Whether the release names a title of symbols alone ("÷", "+", "-"), standing on their own either
 * first or right after the artist and its separator ("Ed Sheeran - - (Subtract)"). Anywhere else the
 * same characters may be that separator ("Ed Sheeran - ÷") or part of a tag ("[FLAC+CUE]").
 */
// NFKC keeps typographic lookalikes apart; a metadata source may spell "x" as "×" or "-" as "−".
const SYMBOL_LOOKALIKES: Record<string, string> = { "×": "x", "−": "-", "–": "-", "—": "-", "‐": "-", "‑": "-" };
function foldSymbols(text: string): string {
  return text.normalize("NFKC").replace(/[×−–—‐‑]/g, (c) => SYMBOL_LOOKALIKES[c] ?? c);
}

function namesSymbolTitle(releaseTitle: string, title: string, parent: string[]): boolean {
  const symbols = foldSymbols(title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").trim() || title.trim()).replace(/\s+/g, " ").toLowerCase();
  if (!symbols) return false;
  const standsFirst = (text: string) => text.startsWith(symbols) && /^(?:$|[\s()[\]{}])/.test(text.slice(symbols.length));
  const whole = foldSymbols(releaseTitle).toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (standsFirst(whole)) return true;
  // "[FLAC] Ed Sheeran - ÷": tags ahead of the name.
  const release = whole.replace(/^(?:[[(][^\])]*[\])]\s*)+/, "");
  if (standsFirst(release)) return true;
  if (parent.length === 0) return false;
  let named = 0;
  let artistEnd = 0;
  for (const word of release.matchAll(/\S+/g)) {
    if (named === parent.length) break;
    const tokens = titleTokens(word[0]).filter((t) => !TITLE_STOPWORDS.has(t));
    // A stopword the artist's name is written with ("The Beatles") may come first too.
    if (tokens.length === 0 ? !/[\p{L}\p{N}]/u.test(word[0]) : !tokens.every((t, j) => parent[named + j] === t)) break;
    named += tokens.length;
    artistEnd = (word.index ?? 0) + word[0].length;
  }
  return named === parent.length && standsFirst(release.slice(artistEnd).replace(/^\s*(?:[-–—:]\s+)?/, ""));
}

/** A title's words, less stopwords and bracketed annotations ("(Deluxe Edition)", "(Mistborn, #1)",
 * "(2012)"), which vary from release to release. */
function significantTitleTokens(text: string): string[] {
  return titleTokens(text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").trim() || text).filter((t) => !TITLE_STOPWORDS.has(t));
}

const RELEASE_BRACKET = "(";
const RELEASE_YEAR = /^(?:1[89]|20)\d\d$/;
const RELEASE_FORMAT_TAGS = ["epub", "mobi", "azw3", "azw", "pdf", "cbz", "cbr", "flac", "alac", "mp3", "m4b", "m4a", "aac", "ogg", "opus"].map((tag) =>
  titleTokens(tag).filter((t) => !TITLE_STOPWORDS.has(t))
);

/** A name's initials run together, the way release names often write them: "jrr" of "J.R.R.
 * Tolkien", "rf" of "R.F. Kuang". */
function joinedInitials(text: string): string[] {
  const joined: string[] = [];
  let run = "";
  for (const t of [...titleTokens(text), ""]) {
    if (t.length === 1 && /\p{L}/u.test(t)) {
      run += t;
      continue;
    }
    if (run.length > 1) joined.push(run);
    run = "";
  }
  return joined;
}

/**
 * Whether the release names the part of a book's title before its subtitle ("Sapiens" of "Sapiens: A
 * Brief History of Humankind"), which book releases usually leave off. Only when nothing but the
 * author, a year, a bracket or a format tag stands on either side of it: "Mistborn - The Well of
 * Ascension" names another subtitle, and "The Annotated Hobbit" or "Secret History of Mistborn"
 * another book, not the one wanted.
 */
function namesMainTitle(releaseTitle: string, name: TargetName): boolean {
  const parts = name.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/\s*:\s*|\s+[-–—]\s+/);
  if (parts.length < 2) return false;
  const main = significantTitleTokens(parts[0]);
  if (main.length === 0) return false;
  const author = name.parentTitle ? [...significantTitleTokens(name.parentTitle), ...joinedInitials(name.parentTitle)] : [];
  const tokens = releaseTitle
    .split(/[()[\]{}]/)
    .flatMap((segment, i) => (i === 0 ? titleTokens(segment) : [RELEASE_BRACKET, ...titleTokens(segment)]))
    .filter((t) => !TITLE_STOPWORDS.has(t));
  const startsWith = (at: number, seq: string[]) => seq.every((t, j) => tokens[at + j] === t);
  /** How many tokens at `at` are the author, a year, a bracket or a format tag (0 for none). */
  const besideTitle = (at: number): number => {
    const t = tokens[at];
    if (t === RELEASE_BRACKET || RELEASE_YEAR.test(t) || author.includes(t)) return 1;
    return RELEASE_FORMAT_TAGS.find((tag) => startsWith(at, tag))?.length ?? 0;
  };
  for (let i = 0; i + main.length <= tokens.length; i++) {
    if (!startsWith(i, main)) continue;
    // "James Clear - Atomic Habits", "Harari, Yuval Noah - Sapiens", "Tolkien, JRR - The Hobbit",
    // "Yuval Noah Harari - 2015 - Sapiens", "[Tolkien] The Hobbit".
    let before = 0;
    for (let n = besideTitle(0); before < i && n > 0 && before + n <= i; n = besideTitle(before)) before += n;
    if (before !== i) continue;
    // "Atomic Habits - James Clear", "Atomic Habits by James Clear", "Sapiens (2014) [EPUB]".
    let next = i + main.length;
    while (next < tokens.length && author.includes(tokens[next])) next++;
    if (next === tokens.length || besideTitle(next) > 0) return true;
  }
  return false;
}

/** Quality tiers in the order the profile prefers them: pickBestAllowedQuality's choice first,
 * then its choice among what's left, and so on. */
function tierPreference(qualities: string[], allowedQualities: string[], cutoff: string): string[] {
  const remaining = Array.from(new Set(qualities));
  const order: string[] = [];
  while (remaining.length > 0) {
    const next =
      allowedQualities.length > 0
        ? pickBestAllowedQuality(remaining, allowedQualities, cutoff)
        : [...remaining].sort((a, b) => qualityRank(b) - qualityRank(a))[0];
    if (!next) break;
    order.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

/**
 * Picks the best result for a target: prefers matching episode/season, drops every release that
 * is rejected (blocklist, delay profile, protocol, size bounds, allowed qualities, release
 * profiles, minimum custom format score — Sonarr/Radarr's gate) and only then picks the quality
 * tier, ranking within it by custom-format score, then seeders; a torrent with no seeders at all is
 * a last resort. Types with no quality tiers (see
 * usesQualityTiers) skip the tier step entirely and rank every surviving release that names the
 * target (options.name) together.
 */
export async function chooseBestResult(
  results: SearchResult[],
  allowedQualities: string[],
  cutoff: string,
  qualityProfileId: number | null,
  minFormatScore: number,
  target: ReleaseTarget | null,
  blocklisted: Set<string>,
  mediaType: string,
  delayProfile: DelayProfile | null = null,
  identity: TargetIdentity | null = null,
  mediaItemId: number | null = null,
  options: ChooseOptions = {}
): Promise<ChosenResult | null> {
  const { clients, upgradeFromRank = null, name = null, label = null } = options;
  const targetSuffix = target
    ? "airDate" in target
      ? ` (${target.airDate})`
      : ` S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}`
    : "";
  const forLabel = label ? ` for "${label}${targetSuffix}"` : "";
  const tiered = usesQualityTiers(mediaType);
  if (!tiered) {
    if (upgradeFromRank !== null) return null;
    allowedQualities = [];
    cutoff = "";
  }

  const withParsed = results
    .filter((r) => !blocklisted.has(r.title))
    .filter((r) => !clients || pickClientForProtocol(clients, r.protocol) !== null)
    .map((r) => ({ result: r, parsed: parseReleaseTitle(r.title), size: knownReleaseSize(r.size) }))
    .filter(({ result, parsed }) => isEligibleForDelay(parsed.quality, cutoff, result, delayProfile));

  const episodeFiltered = !target
    ? withParsed
    : "airDate" in target
    ? withParsed.filter(({ parsed }) => releaseMatchesAirDate(parsed, target.airDate))
    : withParsed.filter(({ parsed }) =>
        releaseMatchesEpisode(parsed, target.season, target.episode, target.sceneSeason, target.sceneEpisode, target.absoluteEpisode)
      );

  const allowed = new Set(allowedQualities);
  const namesMainTitleOnly = new Set<SearchResult>();
  const relevant = episodeFiltered.filter(({ result, parsed, size }) => {
    if (!tiered) {
      if (!name) return true;
      const match = releaseNameMatch(result.title, name, mediaType);
      if (match === "main") namesMainTitleOnly.add(result);
      return match !== null;
    }
    if (allowed.size > 0 && !allowed.has(parsed.quality)) return false;
    if (upgradeFromRank !== null && qualityRank(parsed.quality) <= upgradeFromRank) return false;
    // Drop releases whose size doesn't fit their claimed quality's configured size range — usually
    // a mislabeled or fake release (e.g. a 200MB file claiming to be 1080p).
    return sizeWithinQualityBounds(parsed.quality, size);
  });
  if (relevant.length === 0) {
    log.info(`[scheduler] no eligible releases among ${results.length} result(s)${forLabel}`);
    return null;
  }

  // The tier comes from releases that survived every rejection: picked first, one oversized or
  // must-not-matched release at the top tier left nothing to grab even with the next tier on offer.
  // Tiers are scored best first, stopping at the first with a survivor — scoring a release costs
  // several queries, and auto-search runs this for every missing target.
  // A torrent nobody seeds sits at 0% until the stalled cleanup gives up on it, holding its target
  // all that time, so it's only taken when no other release survives at any tier. A book release
  // naming only the title before its subtitle may be another book of that name ("Mistborn" the
  // trilogy), so it comes after every release naming the whole title.
  const unseeded = (c: { result: SearchResult }) => c.result.protocol === "torrent" && c.result.seeders === 0;
  const pools = [false, true].flatMap((mainOnly) => {
    const named = relevant.filter((c) => namesMainTitleOnly.has(c.result) === mainOnly);
    return [named.filter((c) => !unseeded(c)), named.filter(unseeded)];
  });
  let candidates: {
    result: SearchResult;
    size: number | null;
    quality: string;
    matchTier: number;
    totalScore: number;
  }[] = [];
  for (const pool of pools) {
    const tiers: (string | null)[] = tiered ? tierPreference(pool.map((c) => c.parsed.quality), allowedQualities, cutoff) : [null];
    for (const tier of tiers) {
      const inTier = tier === null ? pool : pool.filter((c) => c.parsed.quality === tier);
      candidates = (
        await Promise.all(
          inTier.map(async ({ result, parsed, size }) => ({
            result,
            size,
            quality: parsed.quality,
            matchTier: matchTierFor(result, identity),
            ...(await scoreRelease(
              result.title,
              size,
              qualityProfileId,
              mediaType,
              result.downloadVolumeFactor ?? null,
              mediaItemId,
              result.indexerId ?? null
            )),
          }))
        )
      ).filter((c) => c.totalScore >= minFormatScore && !c.rejected);
      if (candidates.length > 0) break;
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) {
    log.info(`[scheduler] ${relevant.length} eligible release(s)${forLabel}, but none met the minimum format score`);
    return null;
  }

  // getGroupReputation is now async (DB-backed) — a .sort() comparator can't await, so reputation
  // for every distinct release group in play is precomputed into a plain Map first, and the
  // comparator does a synchronous lookup against it.
  const releaseGroups = new Set(candidates.map((c) => parseReleaseTitle(c.result.title).releaseGroup));
  const reputationByGroup = new Map<string | null, number>(
    await Promise.all(Array.from(releaseGroups).map(async (g) => [g, await getGroupReputation(g)] as const))
  );

  // With no quality to rank by, the admin's indexer priority (lower first) comes before seeders and
  // then the newer release — usenet and DDL results have no seeders to tell them apart. Video types
  // keep their established order.
  const priorityById = new Map((options.indexers ?? []).map((i) => [i.id, i.priority]));
  const priorityOf = (c: { result: SearchResult }) =>
    tiered ? 0 : priorityById.get(c.result.indexerId ?? -1) ?? DEFAULT_INDEXER_PRIORITY;
  const publishedAt = (c: { result: SearchResult }) => {
    const at = !tiered && c.result.publishDate ? Date.parse(c.result.publishDate) : NaN;
    return Number.isFinite(at) ? at : 0;
  };

  candidates.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      b.matchTier - a.matchTier ||
      priorityOf(a) - priorityOf(b) ||
      (b.result.seeders ?? 0) - (a.result.seeders ?? 0) ||
      publishedAt(b) - publishedAt(a) ||
      (reputationByGroup.get(parseReleaseTitle(b.result.title).releaseGroup) ?? 0.5) -
        (reputationByGroup.get(parseReleaseTitle(a.result.title).releaseGroup) ?? 0.5) ||
      preferredSizeDistance(a.quality, a.size) - preferredSizeDistance(b.quality, b.size)
  );
  const winner = candidates[0];
  if (winner) {
    log.info(`[scheduler] picked "${winner.result.title}" (${winner.quality}, score ${winner.totalScore})${forLabel}`);
  }
  return winner ? { result: winner.result, quality: winner.quality } : null;
}

/** The download client refused the release itself (a dead .torrent link, an offline slskd peer)
 * before anything was downloaded, so trying another release can't download the target twice. */
export class ReleaseRefusedError extends Error {}

/** The download client itself failed — unreachable, timed out, or refusing AoNarr's credentials — so
 * every other release sent to it would fail the same way. */
export class DownloadClientUnavailableError extends Error {
  constructor(readonly client: DownloadClient, cause: unknown) {
    super(`Download client "${client.name}" is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const CLIENT_NETWORK_ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);
/** Clients whose addDownload fetches a non-magnet release URL itself before handing it on: a network
 * failure there may be the indexer's rather than the client's. */
const FETCHES_RELEASE_URL_TYPES = new Set(["realdebrid", "alldebrid", "torbox", "blackhole"]);

function isClientLevelError(client: DownloadClient, downloadUrl: string, err: unknown): boolean {
  // An in-process client's "network" is the source it downloads from.
  if (DIRECT_CLIENT_TYPES.has(client.type)) return false;
  const message = err instanceof Error ? err.message : String(err);
  // The release file itself couldn't be fetched: that's the indexer answering, not the client.
  if (/^Failed to (?:resolve download URL|fetch release)/i.test(message)) return false;
  // A release URL quoted in the message ("...download?apikey=...") says nothing about the client's login.
  const withoutUrls = message.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|magnet:\?)\S*/gi, " ");
  if (/\bHTTP 40[13]\b|authenticat|\blog ?in\b|\bapi ?(?:key|token)\b|unauthori[sz]ed/i.test(withoutUrls)) return true;
  if (FETCHES_RELEASE_URL_TYPES.has(client.type) && !downloadUrl.startsWith("magnet:")) return false;
  let e: any = err;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    if (typeof e.code === "string" && CLIENT_NETWORK_ERRNOS.has(e.code)) return true;
    if (e.name === "TypeError" && e.message === "fetch failed") return true;
  }
  return false;
}

/** Leaves a client that failed at the client level out of the rest of a search pass, rather than
 * trying it again (each a connect timeout) for every remaining target. True when `err` was such a
 * failure. */
function noteUnavailableClient(err: unknown, unavailable: Map<number, string>): boolean {
  if (!(err instanceof DownloadClientUnavailableError)) return false;
  if (!unavailable.has(err.client.id)) {
    unavailable.set(err.client.id, err.message);
    log.warn(`[scheduler] ${err.message}; no more grabs go to it this pass`);
  }
  return true;
}

// Grabs for one media item run one at a time. Episode searches run concurrently, and a bulk search
// can hold several episodes of one season: each grab re-checks coverage under this chain, so a
// season pack chosen for several sibling episodes at once is sent only once.
const grabChains = new Map<number, Promise<unknown>>();

function serializeForItem<T>(mediaItemId: number, fn: () => Promise<T>): Promise<T> {
  const run = (grabChains.get(mediaItemId) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  grabChains.set(mediaItemId, settled);
  void settled.then(() => {
    if (grabChains.get(mediaItemId) === settled) grabChains.delete(mediaItemId);
  });
  return run;
}

/** Sends a release to the client and records it. Resolves false without sending anything when a
 * queued download already covers the target, and false without a second queue row when the client
 * answers with a download another active row already tracks (qBittorrent drops a duplicate add). */
export async function grab(
  client: DownloadClient,
  mediaItem: MediaItem,
  episodeId: number | null,
  subItemId: number | null,
  chosen: ChosenResult,
  retryCount = 0,
  seasonNumber: number | null = null
): Promise<boolean> {
  return serializeForItem(mediaItem.id, async () => {
    const { result: best, quality } = chosen;
    if ((episodeId || subItemId || seasonNumber == null) && (await isAlreadyQueued(mediaItem.id, episodeId, subItemId))) {
      log.info(`[scheduler] not grabbing "${best.title}" for "${mediaItem.title}": a queued download already covers it`);
      return false;
    }
    // A season pack grabbed for one episode covers the rest of its season too — recording the season
    // is what lets isAlreadyQueued see that, rather than the same pack being grabbed once per episode.
    let packSeason = seasonNumber;
    const parsedBest = parseReleaseTitle(best.title);
    if (episodeId && packSeason == null && parsedBest.isFullSeason) {
      const ep = (await db.prepare("SELECT season_number FROM episodes WHERE id = ?").get(episodeId)) as { season_number: number } | undefined;
      // A scene-numbered pack of another season ("Show.S02" for TVDB S01E13) doesn't cover this one.
      if (ep && (parsedBest.seasonNumber == null || parsedBest.seasonNumber === ep.season_number)) packSeason = ep.season_number;
    }
    const adapter = getDownloadClientAdapter(client.type);
    let downloadId: string;
    try {
      ({ downloadId } = await adapter.addDownload(client, best.downloadUrl, client.category, best.title, best.protocol));
    } catch (err) {
      if (isClientLevelError(client, best.downloadUrl, err)) throw new DownloadClientUnavailableError(client, err);
      throw new ReleaseRefusedError(err instanceof Error ? err.message : String(err));
    }

    const tracked = await db
      .prepare("SELECT id FROM queue WHERE download_client_id = ? AND download_id = ? AND status NOT IN ('failed')")
      .get(client.id, downloadId);
    if (tracked) {
      log.info(`[scheduler] "${best.title}" is already being downloaded by "${client.name}" for another queue entry`);
      return false;
    }

    // queue.size is BIGINT: Postgres rejects NaN or a fraction (from an indexer's odd size field)
    // after the client has already accepted the download, leaving it untracked.
    const size = Number.isFinite(best.size) ? Math.round(best.size) : null;
    await db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, season_number, title, indexer_id, download_client_id, download_id, size, quality, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(mediaItem.id, episodeId, subItemId, packSeason, best.title, best.indexerId, client.id, downloadId, size, quality, retryCount);

    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      mediaItem.id,
      JSON.stringify(best)
    );

    await notifyGrabbed(mediaItem.title, best.title);
    notifyQueueChanged();
    log.info(`[scheduler] grabbed "${best.title}" for "${mediaItem.title}"`);
    return true;
  });
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
  const matching = clients.filter((c) => {
    if (!preferred.includes(c.type)) return false;
    if (MULTI_PROTOCOL_DEBRID_TYPES.has(c.type)) return (c.downloadTypes ?? ["torrent"]).includes(protocol);
    return true;
  });
  // Ranked by the preference order above, then by id — never by list order, which comes from an
  // unordered SELECT that Postgres reshuffles after any UPDATE, moving grabs to another client.
  matching.sort((a, b) => preferred.indexOf(a.type) - preferred.indexOf(b.type) || a.id - b.id);
  return matching[0] ?? null;
}

/** Clients that download in-process — a yt-dlp child process or a plain HTTP fetch per grab,
 * started the moment it's grabbed. */
const DIRECT_CLIENT_TYPES = new Set(["ytdlp", "http"]);
/** A channel or podcast with hundreds of missing uploads would otherwise start hundreds of yt-dlp
 * processes / HTTP downloads in a single pass. */
const MAX_ACTIVE_DIRECT_DOWNLOADS = 3;

interface DirectDownloadBudget {
  readonly available: boolean;
  /** `clients`, minus the in-process ones once the budget is spent. */
  usableClients(): DownloadClient[];
  consume(client: DownloadClient): void;
  /**
   * Synchronously checks and reserves one slot for `client` — a single check-and-decrement with no
   * `await` in between, the same way reserveSearchSlot (see runAutoSearch) guards the per-cycle
   * cap. Always true, reserving nothing, for a client whose type isn't direct-download at all,
   * since no budget applies to it; otherwise true (and one slot spent) only while a slot is free.
   * Where a plain `available` read followed by a later `consume()` can race — several of one media
   * item's own leaf candidates run concurrently (see forEachCandidateAcrossItemsSequentially) and
   * can all read `available` before any of them has awaited far enough to call `consume` — this
   * can't, since the check and the decrement happen in the same synchronous step.
   */
  reserve(client: DownloadClient): boolean;
  /** Gives back a slot `reserve` took but that turned out unused — the grab it guarded wasn't
   * actually sent (already covered by a concurrent sibling, refused, or the client threw). No-op
   * for a client whose type isn't direct-download. */
  release(client: DownloadClient): void;
}

async function directDownloadBudget(clients: DownloadClient[]): Promise<DirectDownloadBudget> {
  let running = 0;
  for (const client of clients.filter((c) => DIRECT_CLIENT_TYPES.has(c.type))) {
    const ids = (
      (await db
        .prepare("SELECT download_id FROM queue WHERE download_client_id = ? AND status IN ('queued', 'downloading') AND download_id IS NOT NULL")
        .all(client.id)) as { download_id: string }[]
    ).map((r) => r.download_id);
    if (ids.length === 0) continue;
    // Asked of the adapter rather than counted from rows: a job lost to a restart isn't running.
    try {
      const statuses = await getDownloadClientAdapter(client.type).getStatus(client, ids);
      running += statuses.filter((s) => s.status === "downloading").length;
    } catch {
      running += ids.length;
    }
  }
  let free = MAX_ACTIVE_DIRECT_DOWNLOADS - running;
  return {
    get available() {
      return free > 0;
    },
    usableClients: () => (free > 0 ? clients : clients.filter((c) => !DIRECT_CLIENT_TYPES.has(c.type))),
    consume(client) {
      if (DIRECT_CLIENT_TYPES.has(client.type)) free--;
    },
    reserve(client) {
      if (!DIRECT_CLIENT_TYPES.has(client.type)) return true;
      if (free <= 0) return false;
      free--;
      return true;
    },
    release(client) {
      if (DIRECT_CLIENT_TYPES.has(client.type)) free++;
    },
  };
}

/** Online Videos with a stored YouTube id and podcast episodes with a stored RSS enclosure aren't on
 * any indexer: they're downloaded straight from that source by an in-process client. */
function directSourceFor(item: MediaItem, sub: any): { clientType: "ytdlp" | "http"; chosen: ChosenResult } | null {
  if (!isDirectSource(item.type, sub.external_provider ?? null, sub.external_id ?? null)) return null;
  const source =
    item.type === "video"
      ? { clientType: "ytdlp" as const, indexerName: "yt-dlp", downloadUrl: `https://www.youtube.com/watch?v=${sub.external_id}` }
      : { clientType: "http" as const, indexerName: "rss", downloadUrl: String(sub.external_id) };
  return {
    clientType: source.clientType,
    chosen: {
      result: {
        indexerId: null,
        indexerName: source.indexerName,
        title: sub.title,
        size: 0,
        seeders: null,
        leechers: null,
        publishDate: null,
        downloadUrl: source.downloadUrl,
        protocol: "http",
        category: null,
      },
      quality: "",
    },
  };
}

const MAX_RELEASES_TRIED = 3;

/**
 * Chooses the best release and grabs it through a client that speaks its protocol. A release the
 * client refuses is set aside and the next-best one tried, a few at most: otherwise the same dead
 * release wins, and fails, on every pass and its target is never downloaded. Resolves null when
 * nothing was chosen; rethrows the refusal when every release tried was refused.
 */
async function grabBestRelease(
  results: SearchResult[],
  clients: DownloadClient[],
  choose: (results: SearchResult[]) => Promise<ChosenResult | null>,
  send: (client: DownloadClient, chosen: ChosenResult) => Promise<boolean>
): Promise<{ chosen: ChosenResult; client: DownloadClient; grabbed: boolean } | null> {
  let remaining = results;
  let refusal: ReleaseRefusedError | null = null;
  for (let attempt = 0; attempt < MAX_RELEASES_TRIED; attempt++) {
    const chosen = await choose(remaining);
    const client = chosen ? pickClientForProtocol(clients, chosen.result.protocol) : null;
    if (!chosen || !client) break;
    try {
      return { chosen, client, grabbed: await send(client, chosen) };
    } catch (err) {
      if (!(err instanceof ReleaseRefusedError)) throw err;
      refusal = err;
      log.warn(`[scheduler] "${client.name}" refused "${chosen.result.title}":`, err.message);
      remaining = remaining.filter((r) => r.downloadUrl !== chosen.result.downloadUrl);
    }
  }
  if (refusal) throw refusal;
  return null;
}

/** Why a search grabbed nothing, for bulk-search results and retry notifications. */
function whyNothingGrabbed(
  results: SearchResult[],
  clients: DownloadClient[],
  usableClients: DownloadClient[],
  upgradeFrom: string | null | undefined,
  unavailable: Map<number, string> = new Map()
): string {
  if (results.length > 0 && results.every((r) => !pickClientForProtocol(clients, r.protocol))) {
    const protocols = Array.from(new Set(results.map((r) => `"${r.protocol}"`)));
    return `No ${protocols.join("/")} download client configured`;
  }
  const reachable = clients.filter((c) => !unavailable.has(c.id));
  if (results.length > 0 && results.every((r) => !pickClientForProtocol(reachable, r.protocol))) {
    return Array.from(unavailable.values()).join("; ");
  }
  if (results.length > 0 && results.every((r) => !pickClientForProtocol(usableClients, r.protocol))) {
    return `${MAX_ACTIVE_DIRECT_DOWNLOADS} direct downloads are already running; search again once they finish`;
  }
  if (upgradeFrom !== undefined) return `No release found that's an upgrade over ${upgradeFrom || "the existing file"}`;
  return "No matching results";
}

/** The quality of the file a target already has: undefined when it has none, null when that
 * file's quality is unknown. */
async function existingFileQuality(item: MediaItem, episodeId: number | null, subItemId: number | null): Promise<string | null | undefined> {
  const row = (
    episodeId
      ? await db.prepare("SELECT has_file, quality FROM episodes WHERE id = ?").get(episodeId)
      : subItemId
      ? await db.prepare("SELECT has_file, quality FROM sub_items WHERE id = ?").get(subItemId)
      : { has_file: item.hasFile, quality: item.quality }
  ) as { has_file: number | boolean | null; quality: string | null } | undefined;
  return row && Number(row.has_file) ? row.quality ?? null : undefined;
}

/** existingFileQuality for a season-level grab: importing a pack replaces the file of every episode
 * it covers (the whole season, or just `episodeNumbers`), so the best quality among those files is
 * the one it has to beat. */
async function seasonFileQuality(mediaItemId: number, seasonNumber: number, episodeNumbers: number[] | null): Promise<string | null | undefined> {
  const rows = (await db
    .prepare("SELECT episode_number, quality FROM episodes WHERE media_item_id = ? AND season_number = ? AND has_file = 1")
    .all(mediaItemId, seasonNumber)) as { episode_number: number; quality: string | null }[];
  const covered = episodeNumbers ? rows.filter((r) => episodeNumbers.includes(Number(r.episode_number))) : rows;
  if (covered.length === 0) return undefined;
  return covered.reduce<string | null>((best, r) => (qualityRank(r.quality) > qualityRank(best) ? r.quality : best), null);
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

/** One leaf runAutoSearch can search this cycle: a whole single-shape item, one episode of an
 * episodic-shape item, or one sub-item of a collection-shape item. `lastSearchedAt` is that leaf's
 * own `last_auto_searched_at` column — what the fair ordering below sorts candidates by. */
interface AutoSearchCandidate {
  item: MediaItem;
  shape: "single" | "episodic" | "collection";
  episode?: any;
  subItem?: any;
  lastSearchedAt: string | null;
  /** Discovery order — the tiebreaker for candidates that tie on lastSearchedAt (typically every
   * candidate, the first time this ever runs and nothing has a timestamp yet), so behavior with an
   * empty or small-enough backlog matches today's plain per-item/per-row order exactly. */
  seq: number;
}

/** Marks `table.id` as searched this auto-search cycle, so next cycle's oldest-first ordering (see
 * AutoSearchCandidate above) naturally rotates on to whatever wasn't reached this time. */
async function stampAutoSearched(table: "media_items" | "episodes" | "sub_items", id: number): Promise<void> {
  await db.prepare(`UPDATE ${table} SET last_auto_searched_at = ${nowExpr(db)} WHERE id = ?`).run(id);
}

/** Per-item state shared by every candidate leaf of that item (its quality profile, delay profile,
 * blocklist, ...) — computed once per item no matter how many of its episodes/sub-items end up as
 * candidates, the same way the old per-item loop computed it once before fanning out to them. */
interface AutoSearchItemContext {
  allowedQualities: string[];
  cutoff: string;
  minFormatScore: number;
  delayProfile: DelayProfile | null;
  blocklisted: Set<string>;
  overQuota: boolean;
  isDaily: boolean;
  /** Video/podcast collection sub-items only — see titlesBlocklistedWithinHours. */
  recentDirectFailures: Set<string>;
}

/**
 * For each monitored, fileless target (movie / episode / album / book), search and grab the best release.
 *
 * config.ts's `autoSearchMaxPerCycle` bounds how many targets this actually searches in one pass —
 * every monitored item's own missing episodes/sub-items scale with library size, and this runs
 * unattended every `searchIntervalMinutes`, so nothing here used to bound the total volume of full
 * multi-indexer searches one cycle could issue. A flat "first N in row order" cap would be unsafe on
 * its own: with a fixed, unchanging candidate order, the same early rows would be re-searched every
 * cycle and later ones would never be reached once the backlog exceeds the cap. Instead, every
 * candidate (single item / episode / sub-item) is stamped with when it was last searched
 * (stampAutoSearched), and candidates are considered oldest-searched-first, never-searched first of
 * all (see AutoSearchCandidate's sort below), so a backlog bigger than the cap spreads its coverage
 * across multiple cycles instead of starving whatever doesn't fit in this one.
 */
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
  const directBudget = await directDownloadBudget(clients);
  let deferredDirect = 0;
  const unavailable = new Map<number, string>();
  const noClientReachable = () => clients.every((c) => unavailable.has(c.id));

  const monitoredItems = (
    (await db.prepare("SELECT * FROM media_items WHERE monitored = 1").all()) as any[]
  ).map(mediaItemFromRow) as MediaItem[];

  // Every leaf this cycle could search, across every monitored item, before any cap or ordering is
  // applied — discovered the same way the old per-item loop found its own episodes/sub-items, just
  // gathered up front instead of searched immediately, so the ordering/cap below sees the whole
  // cycle's pool at once instead of only one item's.
  let seq = 0;
  const candidates: AutoSearchCandidate[] = [];
  for (const item of monitoredItems) {
    // Cheap to check even though neither ever actually fires mid-discovery today (this map starts
    // empty and nothing populates it until the processing loop below runs) — it's a guard against
    // wasted per-item episode/sub-item queries if that ever changes, and against continuing to
    // discover once the caller's abort signal has already fired.
    if (signal?.aborted || noClientReachable()) break;
    const shape = getMediaTypeConfig(item.type).shape;
    if (shape === "single") {
      candidates.push({ item, shape, lastSearchedAt: item.lastAutoSearchedAt ?? null, seq: seq++ });
    } else if (shape === "episodic") {
      const episodes = (await db
        .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
        .all(item.id)) as any[];
      for (const episode of episodes) {
        candidates.push({ item, shape, episode, lastSearchedAt: episode.last_auto_searched_at ?? null, seq: seq++ });
      }
    } else {
      // collection shape: albums / books / comic issues / videos / lessons
      const subItems = (await db
        .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND monitored = 1 AND has_file = 0")
        .all(item.id)) as any[];
      for (const subItem of subItems) {
        candidates.push({ item, shape, subItem, lastSearchedAt: subItem.last_auto_searched_at ?? null, seq: seq++ });
      }
    }
  }

  // Oldest-searched-first, never-searched (NULL, folded to "" so it sorts first of all) ahead of
  // everything else; `seq` (discovery order) breaks ties, so with nothing stamped yet — every fresh
  // install, or any cycle whose whole backlog already fit under the cap — this is exactly today's
  // per-item/per-row order.
  candidates.sort((a, b) => {
    const aKey = a.lastSearchedAt ?? "";
    const bKey = b.lastSearchedAt ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : a.seq - b.seq;
  });

  const cap = config.autoSearchMaxPerCycle > 0 ? config.autoSearchMaxPerCycle : Infinity;
  let searchedCount = 0;
  // Reserves this cycle's next search slot for the one real search/grab-attempt call it's placed
  // right before — synchronously, with no `await` between the check and the increment. That's what
  // keeps concurrent candidates (mapWithConcurrency below) from all passing the check at once and
  // overshooting the cap: only the first of them can see the pre-increment count in the same tick.
  const reserveSearchSlot = (): boolean => {
    if (searchedCount >= cap) return false;
    searchedCount++;
    return true;
  };

  let cancelled = false;
  let clientsExhausted = false;
  const loggedItemErrors = new Set<number>();
  const itemContexts = new Map<number, Promise<AutoSearchItemContext>>();

  function getItemContext(item: MediaItem): Promise<AutoSearchItemContext> {
    let ctx = itemContexts.get(item.id);
    if (!ctx) {
      ctx = (async (): Promise<AutoSearchItemContext> => {
        if (await isRootFolderOverQuota(item.rootFolderId)) {
          log.info(`[scheduler] skipping "${item.title}": its root folder is at/over its configured quota`);
          return {
            allowedQualities: [],
            cutoff: "",
            minFormatScore: 0,
            delayProfile: null,
            blocklisted: new Set<string>(),
            overQuota: true,
            isDaily: false,
            recentDirectFailures: new Set<string>(),
          };
        }
        const profile = await getQualityProfile(item.qualityProfileId);
        const delayProfile = pickDelayProfile(delayProfiles, await tagIdsForMediaItem(item.id));
        const blocklisted = await getBlocklistedTitles(item.id);
        // A direct grab (yt-dlp, an RSS enclosure) has no other release to fall back to: re-grabbing
        // a failed one every pass would just fail and re-notify, but skipping it for good would
        // strand everything that failed during a transient outage (an outdated yt-dlp, a CDN 5xx).
        const recentDirectFailures =
          item.type === "video" || item.type === "podcast" ? await titlesBlocklistedWithinHours(item.id, 24) : new Set<string>();
        return {
          allowedQualities: profile?.allowedQualities ?? [],
          cutoff: profile?.cutoff ?? "",
          minFormatScore: profile?.minFormatScore ?? 0,
          delayProfile,
          blocklisted,
          overQuota: false,
          isDaily: item.seriesType === "daily",
          recentDirectFailures,
        };
      })();
      itemContexts.set(item.id, ctx);
    }
    return ctx;
  }

  const grabBestFor = async (
    item: MediaItem,
    ctx: AutoSearchItemContext,
    results: SearchResult[],
    target: ReleaseTarget | null,
    identity: TargetIdentity | null,
    episodeId: number | null,
    subItemId: number | null,
    name: TargetName | null
  ) => {
    const usable = directBudget.usableClients().filter((c) => !unavailable.has(c.id));
    // Reserves (and, if the grab doesn't pan out, gives back) the direct-download budget
    // synchronously around the actual grab, rather than checking `usable` once up front and
    // consuming only after grab() resolves: up to 3 of this item's own leaf candidates can be
    // attempting a grab at once (forEachCandidateAcrossItemsSequentially below), and a plain
    // check-then-consume-later would let all of them see the same pre-consumption budget — see
    // DirectDownloadBudget.reserve's own comment.
    const send = async (client: DownloadClient, chosen: ChosenResult) => {
      if (!directBudget.reserve(client)) return false;
      try {
        const grabbed = await grab(client, item, episodeId, subItemId, chosen);
        if (!grabbed) directBudget.release(client);
        return grabbed;
      } catch (err) {
        directBudget.release(client);
        throw err;
      }
    };
    let outcome: Awaited<ReturnType<typeof grabBestRelease>>;
    try {
      outcome = await grabBestRelease(
        results,
        usable,
        (remaining) =>
          chooseBestResult(
            remaining,
            ctx.allowedQualities,
            ctx.cutoff,
            item.qualityProfileId,
            ctx.minFormatScore,
            target,
            ctx.blocklisted,
            item.type,
            ctx.delayProfile,
            identity,
            item.id,
            { clients: usable, name, indexers, label: item.title }
          ),
        send
      );
    } catch (err) {
      if (noteUnavailableClient(err, unavailable)) return;
      throw err;
    }
    if (!outcome && results.length > 0 && results.every((r) => !pickClientForProtocol(clients, r.protocol))) {
      log.warn(`[scheduler] ${whyNothingGrabbed(results, clients, usable, undefined)}, skipping "${item.title}"`);
    }
  };

  async function searchSingle(item: MediaItem, ctx: AutoSearchItemContext): Promise<void> {
    if (item.hasFile || (await isAlreadyQueued(item.id, null, null))) return;
    if (!isReleaseAvailableForSearch(item)) {
      log.info(`[scheduler] skipping "${item.title}": not yet available per its minimum-availability setting`);
      return;
    }
    if (!reserveSearchSlot()) return;
    const query = item.year ? `${item.title} ${item.year}` : item.title;
    const identity: TargetIdentity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
    const results = await searchAllIndexers(indexers, query, item.type, false, identity.externalIds);
    await stampAutoSearched("media_items", item.id);
    await grabBestFor(item, ctx, results, null, identity, null, null, { title: item.title });
  }

  async function searchEpisode(item: MediaItem, ctx: AutoSearchItemContext, ep: any): Promise<void> {
    if (await isAlreadyQueued(item.id, ep.id, null)) return;
    if (ctx.isDaily && !ep.air_date) return; // nothing to search by yet (air date not known)
    // A future-dated episode has no real release to find yet — searching for one anyway just
    // returns noise (unrelated titles that happen to match the query) and risks a false-positive
    // grab. Only compare the date portion (not time-of-day) since an air date is stored as a bare
    // date with no timezone/time — "today" should still search.
    if (ep.air_date && ep.air_date.slice(0, 10) > new Date().toISOString().slice(0, 10)) return;
    if (!reserveSearchSlot()) return;
    // Scene-numbered (TheXEM) season/episode wins the search QUERY when known — that's the numbering
    // a scene-mapped show's releases actually use — while matching still accepts either numbering
    // (see releaseMatchesEpisode's OR), since not every release for such a show necessarily follows
    // the scene convention.
    const searchSeason = ep.scene_season_number ?? ep.season_number;
    const searchEpisode = ep.scene_episode_number ?? ep.episode_number;
    const query = ctx.isDaily
      ? `${item.title} ${ep.air_date}`
      : `${item.title} S${String(searchSeason).padStart(2, "0")}E${String(searchEpisode).padStart(2, "0")}`;
    const results = await searchAllIndexers(indexers, query, item.type);
    await stampAutoSearched("episodes", ep.id);
    const target: ReleaseTarget = ctx.isDaily
      ? { airDate: ep.air_date }
      : {
          season: ep.season_number,
          episode: ep.episode_number,
          sceneSeason: ep.scene_season_number,
          sceneEpisode: ep.scene_episode_number,
          absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null,
        };
    await grabBestFor(item, ctx, results, target, null, ep.id, null, null);
  }

  async function searchSubItem(item: MediaItem, ctx: AutoSearchItemContext, sub: any): Promise<void> {
    if (await isAlreadyQueued(item.id, null, sub.id)) return;

    // Online Videos and podcast episodes aren't on Torznab/Newznab indexers at all — they're
    // grabbed directly via the YouTube id / RSS enclosure URL stored at discovery time.
    const direct = directSourceFor(item, sub);
    if (direct) {
      if (ctx.recentDirectFailures.has(sub.title)) return;
      const directClient = clients.find((c) => c.type === direct.clientType);
      if (!directClient) {
        log.warn(`[scheduler] no "${direct.clientType}" download client configured, skipping "${sub.title}"`);
        return;
      }
      // Reserves the slot synchronously, before the grab, rather than checking `available` and
      // consuming only afterward: several of this channel's other sub-items can be running this
      // same check concurrently (up to 3 at once), and a plain check-then-consume-later would let
      // all of them see the same pre-consumption budget — see DirectDownloadBudget.reserve's
      // own comment.
      if (!directBudget.reserve(directClient)) {
        deferredDirect++;
        return;
      }
      if (!reserveSearchSlot()) {
        directBudget.release(directClient);
        return;
      }
      let grabbed: boolean;
      try {
        grabbed = await grab(directClient, item, null, sub.id, direct.chosen);
      } catch (err) {
        directBudget.release(directClient);
        throw err;
      }
      if (!grabbed) directBudget.release(directClient);
      await stampAutoSearched("sub_items", sub.id);
      return;
    }

    if (!reserveSearchSlot()) return;
    const results = await searchAllIndexers(indexers, `${item.title} ${sub.title}`, item.type);
    await stampAutoSearched("sub_items", sub.id);
    await grabBestFor(item, ctx, results, null, null, null, sub.id, { title: sub.title, parentTitle: item.title });
  }

  // The concurrency-3 burst throttle still applies, now across this cycle's whole selected
  // candidate pool rather than one show's episodes at a time — but, per
  // forEachCandidateAcrossItemsSequentially's own comment, never lets two DIFFERENT media items'
  // candidates run at once: only a run of up to 3 consecutive-in-order candidates that share one
  // item ever overlaps. That's strictly tighter on worst-case simultaneous indexer load than
  // before (multiple shows could each run their own 3 concurrently), never looser, and it's what
  // keeps this safe for the `unavailable` client map and the direct-download budget above, both of
  // which only ever tolerated one media item's own leaves racing each other, never two different
  // items'.
  await forEachCandidateAcrossItemsSequentially(candidates, 3, async (candidate) => {
    if (signal?.aborted) {
      cancelled = true;
      return;
    }
    if (noClientReachable()) {
      clientsExhausted = true;
      return;
    }
    const { item } = candidate;
    try {
      const ctx = await getItemContext(item);
      if (ctx.overQuota) return;
      if (candidate.shape === "single") {
        await searchSingle(item, ctx);
      } else if (candidate.shape === "episodic") {
        // Caught per episode: one failure used to reject the whole batch and skip every later
        // episode of the show, on every pass.
        try {
          await searchEpisode(item, ctx, candidate.episode);
        } catch (err) {
          log.warn(
            `[scheduler] auto-search failed for "${item.title}" S${candidate.episode.season_number}E${candidate.episode.episode_number}:`,
            (err as Error).message
          );
        }
      } else {
        try {
          await searchSubItem(item, ctx, candidate.subItem);
        } catch (err) {
          log.warn(`[scheduler] auto-search failed for "${item.title}" / "${candidate.subItem.title}":`, (err as Error).message);
        }
      }
    } catch (err) {
      // getItemContext's promise is shared by every candidate of this item — only log its failure
      // once, the same way the old per-item loop's own single try/catch only logged it once.
      if (!loggedItemErrors.has(item.id)) {
        loggedItemErrors.add(item.id);
        log.warn(`[scheduler] auto-search failed for "${item.title}":`, (err as Error).message);
      }
    }
  });

  if (cancelled) {
    log.info("[scheduler] auto-search cancelled");
    return;
  }
  if (clientsExhausted) {
    log.info("[scheduler] auto-search stopped: no download client is reachable");
    return;
  }
  if (deferredDirect > 0) {
    log.info(`[scheduler] ${deferredDirect} direct download(s) left for a later pass: ${MAX_ACTIVE_DIRECT_DOWNLOADS} already running`);
  }
}

export interface BulkSearchTarget {
  mediaItemId: number;
  episodeId?: number | null;
  subItemId?: number | null;
  /** Only a release strictly better than this quality is grabbed. A target that already has a
   * file is always held to that file's own quality, whether or not this is sent. */
  upgradeFromQuality?: string | null;
}

export interface BulkSearchResult extends BulkSearchTarget {
  grabbed: boolean;
  error?: string;
  /** Set for a show/artist/author target, which is searched episode by episode (or sub-item by
   * sub-item): how many of those were searched, and how many grabbed. */
  childrenSearched?: number;
  childrenGrabbed?: number;
}

/** How many episodes/sub-items the show/artist/author targets of one bulk search may expand to in
 * total — the route caps a call at 100 targets for the same reason: each one is a full search. */
const MAX_EXPANDED_CHILD_SEARCHES = 100;

interface BulkSearchContext {
  indexers: Indexer[];
  clients: DownloadClient[];
  delayProfiles: { tagId: number | null; profile: DelayProfile }[];
  directBudget: DirectDownloadBudget;
  /** Clients found unavailable earlier in this run (see noteUnavailableClient), with why. */
  unavailable: Map<number, string>;
}

function isBelowCutoff(quality: string | null, cutoff: string): boolean {
  const rank = qualityRank(quality);
  return rank >= 0 && rank < qualityRank(cutoff);
}

/** Sonarr/Radarr's "existing file meets cutoff": with lower tiers filtered out, the profile's best
 * pick is whatever allowed tier lies above the cutoff, so an upgrade search would otherwise replace
 * a file that's already good enough with, say, a 70 GB remux. */
function meetsCutoff(quality: string | null, cutoff: string): boolean {
  const cutoffRank = qualityRank(cutoff);
  return cutoffRank >= 0 && qualityRank(quality) >= cutoffRank;
}

/** A show/artist/author can't be grabbed as one item-level release: the importer only places a
 * download against an episode or sub-item, so such a grab never imports. Its monitored children
 * that are missing — or, for a type with quality tiers, below the profile's cutoff — are searched
 * one by one instead, missing ones first, the way Missing and Cutoff Unmet search them. */
async function searchableChildrenOf(item: MediaItem, cutoff: string): Promise<{ episodeId?: number; subItemId?: number }[]> {
  const tiered = usesQualityTiers(item.type);
  const wanted = (row: { has_file: number; quality: string | null }) => !Number(row.has_file) || (tiered && isBelowCutoff(row.quality, cutoff));
  const missingFirst = (a: { has_file: number }, b: { has_file: number }) => Number(a.has_file) - Number(b.has_file);
  if (getMediaTypeConfig(item.type).shape === "episodic") {
    const today = new Date().toISOString().slice(0, 10);
    const episodes = (await db
      .prepare("SELECT id, has_file, quality, air_date FROM episodes WHERE media_item_id = ? AND monitored = 1 ORDER BY season_number, episode_number")
      .all(item.id)) as { id: number; has_file: number; quality: string | null; air_date: string | null }[];
    return episodes
      .filter((ep) => wanted(ep) && (ep.air_date ? ep.air_date.slice(0, 10) <= today : item.seriesType !== "daily"))
      .sort(missingFirst)
      .map((ep) => ({ episodeId: ep.id }));
  }
  const subItems = (await db
    .prepare("SELECT id, has_file, quality FROM sub_items WHERE media_item_id = ? AND monitored = 1 ORDER BY id")
    .all(item.id)) as { id: number; has_file: number; quality: string | null }[];
  return subItems
    .filter(wanted)
    .sort(missingFirst)
    .map((s) => ({ subItemId: s.id }));
}

async function searchAndGrabTarget(item: MediaItem, t: BulkSearchTarget, ctx: BulkSearchContext): Promise<{ grabbed: boolean; error?: string }> {
  const episodeId = t.episodeId ?? null;
  const subItemId = t.subItemId ?? null;
  const profile = await getQualityProfile(item.qualityProfileId);
  const allowedQualities = profile?.allowedQualities ?? [];
  const cutoff = profile?.cutoff ?? "";
  const minFormatScore = profile?.minFormatScore ?? 0;

  let query: string;
  let episodeTarget: ReleaseTarget | null = null;
  let identity: TargetIdentity | null = null;
  let name: TargetName | null = null;
  let sub: any = null;
  if (episodeId) {
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
    if (!ep) return { grabbed: false, error: "Episode not found" };
    ({ query, target: episodeTarget } = await episodeSearchFor(item, ep));
  } else if (subItemId) {
    sub = await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId);
    if (!sub) return { grabbed: false, error: "Sub-item not found" };
    query = `${item.title} ${sub.title}`;
    name = { title: sub.title, parentTitle: item.title };
  } else {
    query = item.year ? `${item.title} ${item.year}` : item.title;
    identity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
    name = { title: item.title };
  }

  // Cutoff Unmet, Library and Media Analyzer searches reach here for targets that already have a
  // file: only a real upgrade may replace it, whatever the caller sent.
  const onDisk = await existingFileQuality(item, episodeId, subItemId);
  const upgradeFrom = onDisk !== undefined ? onDisk : t.upgradeFromQuality ?? undefined;
  const direct = sub ? directSourceFor(item, sub) : null;
  if (upgradeFrom !== undefined && (direct || !usesQualityTiers(item.type))) {
    return { grabbed: false, error: "Already has a file, and this media type has no quality to upgrade by" };
  }
  if (onDisk !== undefined && meetsCutoff(onDisk, cutoff)) {
    return { grabbed: false, error: `Already meets the profile's cutoff (${cutoff})` };
  }

  if (direct) {
    if ((await titlesBlocklistedWithinHours(item.id, 24)).has(sub.title)) {
      return { grabbed: false, error: "Its download failed within the last day; auto-search retries it after that" };
    }
    const directClient = ctx.clients.find((c) => c.type === direct.clientType);
    if (!directClient) return { grabbed: false, error: `No "${direct.clientType}" download client configured` };
    if (!ctx.directBudget.available) {
      return { grabbed: false, error: `${MAX_ACTIVE_DIRECT_DOWNLOADS} direct downloads are already running; search again once they finish` };
    }
    if (!(await grab(directClient, item, null, sub.id, direct.chosen))) return { grabbed: false, error: "Already queued" };
    ctx.directBudget.consume(directClient);
    return { grabbed: true };
  }

  // Searching spends indexer queries on releases nothing could be sent to.
  if (ctx.clients.length > 0 && ctx.clients.every((c) => ctx.unavailable.has(c.id))) {
    return { grabbed: false, error: Array.from(ctx.unavailable.values()).join("; ") };
  }
  const blocklisted = await getBlocklistedTitles(item.id);
  const delayProfile = pickDelayProfile(ctx.delayProfiles, await tagIdsForMediaItem(item.id));
  const searchResults = await searchAllIndexers(ctx.indexers, query, item.type, false, identity?.externalIds);
  const usable = ctx.directBudget.usableClients().filter((c) => !ctx.unavailable.has(c.id));
  let outcome: Awaited<ReturnType<typeof grabBestRelease>>;
  try {
    outcome = await grabBestRelease(
      searchResults,
      usable,
      (remaining) =>
        chooseBestResult(
          remaining,
          allowedQualities,
          cutoff,
          item.qualityProfileId,
          minFormatScore,
          episodeTarget,
          blocklisted,
          item.type,
          delayProfile,
          identity,
          item.id,
          {
            clients: usable,
            upgradeFromRank: upgradeFrom === undefined ? null : qualityRank(upgradeFrom),
            name,
            indexers: ctx.indexers,
            label: item.title,
          }
        ),
      (client, chosen) => grab(client, item, episodeId, subItemId, chosen)
    );
  } catch (err) {
    if (!noteUnavailableClient(err, ctx.unavailable)) throw err;
    return { grabbed: false, error: (err as Error).message };
  }
  if (!outcome) return { grabbed: false, error: whyNothingGrabbed(searchResults, ctx.clients, usable, upgradeFrom, ctx.unavailable) };
  if (!outcome.grabbed) return { grabbed: false, error: "Already queued" };
  ctx.directBudget.consume(outcome.client);
  return { grabbed: true };
}

/** Same search-and-grab logic as the scheduler's own auto-search, but scoped to an explicit list
 * of targets and run on demand — backs the Library/Missing pages' "bulk search" action. Ignores
 * `monitored`/`hasFile` on the target itself (the caller already chose specifically what to search
 * for), except that a target with a file only ever takes an upgrade. */
export async function searchAndGrabTargets(targets: BulkSearchTarget[]): Promise<BulkSearchResult[]> {
  const clients = await rowsToDownloadClients();
  const ctx: BulkSearchContext = {
    indexers: await rowsToIndexers(),
    clients,
    delayProfiles: await loadDelayProfiles(),
    directBudget: await directDownloadBudget(clients),
    unavailable: new Map(),
  };
  const results: BulkSearchResult[] = [];
  let childSearchesLeft = MAX_EXPANDED_CHILD_SEARCHES;

  for (const t of targets) {
    try {
      const itemRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(t.mediaItemId)) as any;
      if (!itemRow) {
        results.push({ ...t, grabbed: false, error: "Media item not found" });
        continue;
      }
      const item = mediaItemFromRow(itemRow) as MediaItem;
      const typeConfig = getMediaTypeConfig(item.type);
      if (t.episodeId || t.subItemId || typeConfig.shape === "single") {
        results.push({ ...t, ...(await searchAndGrabTarget(item, t, ctx)) });
        continue;
      }

      const profile = await getQualityProfile(item.qualityProfileId);
      const children: { episodeId?: number; subItemId?: number }[] = [];
      for (const child of await searchableChildrenOf(item, profile?.cutoff ?? "")) {
        if (!(await isAlreadyQueued(item.id, child.episodeId ?? null, child.subItemId ?? null))) children.push(child);
      }
      const label = typeConfig.shape === "episodic" ? "episodes" : `${(typeConfig.childLabel ?? "item").toLowerCase()}s`;
      if (children.length === 0) {
        results.push({ ...t, grabbed: false, error: `No monitored ${label} to search` });
        continue;
      }
      let searchedCount = 0;
      let grabbedCount = 0;
      let notReached = 0;
      const problems = new Set<string>();
      for (const child of children) {
        // A season pack grabbed for an earlier episode covers its siblings: searching them anyway
        // spends indexer queries (and query limits) on grabs that are then refused as queued.
        if (searchedCount > 0 && (await isAlreadyQueued(item.id, child.episodeId ?? null, child.subItemId ?? null))) continue;
        if (childSearchesLeft <= 0) {
          notReached++;
          continue;
        }
        childSearchesLeft--;
        searchedCount++;
        try {
          const r = await searchAndGrabTarget(item, { mediaItemId: item.id, ...child }, ctx);
          if (r.grabbed) grabbedCount++;
          else if (r.error) problems.add(r.error);
        } catch (err) {
          problems.add((err as Error).message);
        }
      }
      if (grabbedCount > 0) problems.clear();
      if (notReached > 0) {
        problems.add(`${notReached} more ${label} not searched in this run; search again for the rest`);
      }
      results.push({
        ...t,
        grabbed: grabbedCount > 0,
        childrenSearched: searchedCount,
        childrenGrabbed: grabbedCount,
        ...(problems.size > 0 ? { error: Array.from(problems).join("; ") } : {}),
      });
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
  // "Pause grabs at quota" holds here too: upgrades are usually the largest files of all.
  const overQuota = new Map<number, boolean>();
  const targets: BulkSearchTarget[] = [];
  for (const c of candidates) {
    if (await isAlreadyQueued(c.mediaItemId, c.episodeId ?? null, c.subItemId ?? null)) continue;
    if (!overQuota.has(c.mediaItemId)) {
      const row = (await db.prepare("SELECT root_folder_id FROM media_items WHERE id = ?").get(c.mediaItemId)) as
        | { root_folder_id: number | null }
        | undefined;
      overQuota.set(c.mediaItemId, await isRootFolderOverQuota(row?.root_folder_id ?? null));
    }
    if (overQuota.get(c.mediaItemId)) continue;
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
  // Videos past the direct-download budget stay monitored and missing; auto-search grabs them later.
  const budget = await directDownloadBudget(await rowsToDownloadClients());

  let newVideos = 0;
  for (const channel of channels) {
    // Not the ids merged in from other providers: a Vimeo channel with a matched YouTube id would be
    // listed as that YouTube channel, and a playlist as its channel's uploads.
    const externalIds = childListProviderIds(channel);
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

      if (ytClient && budget.available) {
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
          budget.consume(ytClient);
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
  // Episodes past the direct-download budget stay monitored and missing; auto-search grabs them later.
  const budget = await directDownloadBudget(await rowsToDownloadClients());

  let newEpisodes = 0;
  for (const podcast of podcasts) {
    const externalIds = childListProviderIds(podcast);
    if (!externalIds.podcastFeed) continue;

    let children;
    try {
      children = (await fetchCollectionChildrenFor(externalIds)).children;
    } catch (err) {
      log.warn(`[scheduler] podcast feed check failed for "${podcast.title}":`, (err as Error).message);
      continue;
    }

    const existing = (await db
      .prepare("SELECT id, title, release_date, external_id FROM sub_items WHERE media_item_id = ?")
      .all(podcast.id)) as { id: number; title: string; release_date: string | null; external_id: string | null }[];
    const existingIds = new Set(existing.map((r) => r.external_id).filter((id): id is string => !!id));
    const feedUrls = new Set(children.map((c) => c.externalId).filter((id): id is string => !!id));

    for (const child of children) {
      if (!child.externalId || existingIds.has(child.externalId)) continue;
      // Feeds that rotate enclosure URLs (tracking prefixes, signed query strings, a new host) would
      // otherwise hand every episode back as new: the same episode is the one whose old URL left the feed.
      const moved = child.releaseDate
        ? existing.find(
            (r) => r.title === child.title && r.release_date === child.releaseDate && !!r.external_id && !feedUrls.has(r.external_id)
          )
        : undefined;
      if (moved) {
        await db.prepare("UPDATE sub_items SET external_id = ? WHERE id = ?").run(child.externalId, moved.id);
        moved.external_id = child.externalId;
        existingIds.add(child.externalId);
        continue;
      }
      const insertResult = await db
        .prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
           VALUES (?, ?, ?, ?, 'rss', 1)`
        )
        .run(podcast.id, child.title, child.releaseDate, child.externalId);
      newEpisodes++;

      if (httpClient && budget.available) {
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
          budget.consume(httpClient);
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
 *
 * `releaseAtFault: false` is for a download that died through no fault of its release (an AoNarr
 * restart cut it off): nothing is blocklisted or held against its group, the same release stays
 * eligible to be grabbed again, and the attempt doesn't use up one of the automatic retries.
 * `failureRecorded: true` is for another row tracking the same download, whose failure was already
 * held against its release group for the row before it: it isn't counted twice.
 */
export async function retryFailedGrab(
  match: QueueItem,
  reason: string,
  opts: { releaseAtFault?: boolean; failureRecorded?: boolean } = {}
): Promise<void> {
  const releaseAtFault = opts.releaseAtFault ?? true;
  const recordFailure = releaseAtFault && !opts.failureRecorded;
  const mediaRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(match.mediaItemId)) as any;
  const mediaTitle = mediaRow?.title ?? match.title;

  if (recordFailure || (releaseAtFault && !(await getBlocklistedTitles(match.mediaItemId)).has(match.title))) {
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id, reason) VALUES (?, ?, ?, ?)").run(
      match.mediaItemId,
      match.title,
      match.indexerId,
      reason
    );
  }
  await db.prepare("INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'failed', ?)").run(
    match.mediaItemId,
    JSON.stringify({ title: match.title, reason })
  );
  if (recordFailure) await recordGroupFailure(parseReleaseTitle(match.title).releaseGroup);

  if (
    !mediaRow ||
    getSetting("failedDownloadBehavior") === "blocklistOnly" ||
    (releaseAtFault && match.retryCount >= maxAutoRetries())
  ) {
    await notifyFailed(mediaTitle, reason);
    return;
  }

  try {
    const item = mediaItemFromRow(mediaRow) as MediaItem;
    // A direct yt-dlp/RSS grab has no alternative release on any indexer: searching them for its
    // title grabs whatever torrent shares a few of its words. Auto-search retries it after a cooldown.
    const clientRow = match.downloadClientId
      ? ((await db.prepare("SELECT type FROM download_clients WHERE id = ?").get(match.downloadClientId)) as { type: string } | undefined)
      : undefined;
    if (clientRow?.type === "ytdlp") {
      await notifyFailed(mediaTitle, reason);
      return;
    }
    if (await isRootFolderOverQuota(item.rootFolderId)) {
      await notifyFailed(mediaTitle, `${reason} (not retried: its root folder is at its configured quota)`);
      return;
    }
    const profile = await getQualityProfile(item.qualityProfileId);
    const blocklisted = await getBlocklistedTitles(item.id);

    let episodeTarget: ReleaseTarget | null = null;
    let identity: TargetIdentity | null = null;
    let name: TargetName | null = null;
    let seasonPack: number | null = null;
    let seasonEpisodes: number[] | null = null;
    let query: string;
    if (match.episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(match.episodeId)) as any;
      if (!ep) throw new Error("episode no longer exists");
      ({ query, target: episodeTarget } = await episodeSearchFor(item, ep));
    } else if (match.subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(match.subItemId)) as any;
      if (!sub) throw new Error("sub-item no longer exists");
      if (directSourceFor(item, sub)) {
        await notifyFailed(mediaTitle, reason);
        return;
      }
      query = `${item.title} ${sub.title}`;
      name = { title: sub.title, parentTitle: item.title };
    } else if (match.seasonNumber != null && getMediaTypeConfig(item.type).shape === "episodic") {
      seasonPack = match.seasonNumber;
      // A season search can grab a single-episode release too. Its replacement only has to cover
      // the same episode(s) — a still-airing season often has no full pack to offer yet.
      const failed = parseReleaseTitle(match.title);
      if (!failed.isFullSeason && failed.episodeNumbers?.length) seasonEpisodes = failed.episodeNumbers;
      query = `${item.title} S${String(seasonPack).padStart(2, "0")}${seasonEpisodes ? `E${String(seasonEpisodes[0]).padStart(2, "0")}` : ""}`;
    } else {
      query = item.year ? `${item.title} ${item.year}` : item.title;
      identity = { year: item.year, externalIds: item.externalIds ? JSON.parse(item.externalIds) : {} };
      name = { title: item.title };
    }

    // Retrying a failed upgrade must still be an upgrade: the next-best release is often the quality
    // already on disk, or worse, and importing it would replace the existing file.
    const onDisk =
      seasonPack === null
        ? await existingFileQuality(item, match.episodeId, match.subItemId)
        : await seasonFileQuality(item.id, seasonPack, seasonEpisodes);
    if (onDisk !== undefined && !usesQualityTiers(item.type)) {
      await notifyFailed(mediaTitle, `${reason} (not retried: it already has a file)`);
      return;
    }
    if (onDisk !== undefined && meetsCutoff(onDisk, profile?.cutoff ?? "")) {
      log.info(`[scheduler] retry grabbed nothing for "${mediaTitle}": it already meets the profile's cutoff (${profile!.cutoff})`);
      await notifyFailed(mediaTitle, `${reason} (not retried: it already meets the profile's cutoff (${profile!.cutoff}))`);
      return;
    }

    const indexers = await rowsToIndexers();
    const searchResults = await searchAllIndexers(indexers, query, item.type, false, identity?.externalIds);
    // A season-search grab's replacement has to be a full pack of that same season (or cover the
    // same episodes): with no target, chooseBestResult would accept any release of the show, which
    // the importer can't place.
    const results =
      seasonPack === null
        ? searchResults
        : searchResults.filter((r) => {
            const parsed = parseReleaseTitle(r.title);
            if (parsed.seasonNumber !== seasonPack) return false;
            const range = parsed.episodeRange;
            if (parsed.isFullSeason) return !range || (!!seasonEpisodes && seasonEpisodes.every((e) => e >= range[0] && e <= range[1]));
            return !!seasonEpisodes && seasonEpisodes.every((e) => parsed.episodeNumbers?.includes(e));
          });
    const delayProfiles = await loadDelayProfiles();
    const delayProfile = pickDelayProfile(delayProfiles, await tagIdsForMediaItem(item.id));
    const clients = await rowsToDownloadClients();
    const outcome = await grabBestRelease(
      results,
      clients,
      (remaining) =>
        chooseBestResult(
          remaining,
          profile?.allowedQualities ?? [],
          profile?.cutoff ?? "",
          item.qualityProfileId,
          profile?.minFormatScore ?? 0,
          episodeTarget,
          blocklisted,
          item.type,
          delayProfile,
          identity,
          item.id,
          { clients, upgradeFromRank: onDisk === undefined ? null : qualityRank(onDisk), name, indexers, label: mediaTitle }
        ),
      (client, chosen) =>
        grab(client, item, match.episodeId, match.subItemId, chosen, match.retryCount + (releaseAtFault ? 1 : 0), seasonPack)
    );
    if (!outcome) {
      const why = whyNothingGrabbed(results, clients, clients, onDisk);
      log.info(`[scheduler] retry found nothing to grab for "${mediaTitle}" (${why}) — notifying instead`);
      const detail = why === "No matching results" ? "no other releases found" : why.charAt(0).toLowerCase() + why.slice(1);
      await notifyFailed(mediaTitle, `${reason} (retried, ${detail})`);
      return;
    }

    // Superseded either way — by the replacement grab() just queued, or by a queued download that
    // already covers the target — and would otherwise linger in the queue forever, which was the
    // other half of the queue-never-clears-out bug this fixes.
    await db.prepare("DELETE FROM queue WHERE id = ?").run(match.id);
    notifyQueueChanged();
    log.info(
      outcome.grabbed
        ? `[scheduler] retried failed grab for "${mediaTitle}" with "${outcome.chosen.result.title}"`
        : `[scheduler] failed grab for "${mediaTitle}" is already covered by another queued download`
    );
  } catch (err) {
    log.warn(`[scheduler] retry failed for "${mediaTitle}":`, (err as Error).message);
    await notifyFailed(mediaTitle, reason);
  }
}

const UNRESOLVED_TORRENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Permission, free-space and name-length failures: whichever path they name, every other release
 * would fail the same way. */
const ENVIRONMENT_ERRNOS = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "ENAMETOOLONG"]);

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Whether an import failed on the library side — the destination isn't writable, is full or
 * read-only, or is missing — rather than because of what was downloaded. Blocklisting the release
 * and grabbing another for such a failure only burned through good releases, each failing the same.
 */
async function isLibrarySideImportError(err: unknown): Promise<boolean> {
  const e = err as (NodeJS.ErrnoException & { dest?: string }) | null;
  if (!e || typeof e.code !== "string") return false;
  if (ENVIRONMENT_ERRNOS.has(e.code)) return true;
  if (e.code !== "ENOENT") return false;
  // A rename/copy/link names its source in `path`: a source that's gone (removed at the client) is
  // the download's problem, and another release may well import.
  if (e.dest) return !!e.path && fs.existsSync(e.path);
  if (!e.path) return false;
  const roots = (await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[];
  return roots.some((r) => isSameOrInside(e.path!, r.path));
}

/** When each active queue row was first seen flagged stalled by its client (qBittorrent fetching
 * metadata or finding no peers, slskd waiting on a remote queue) since it was last seen moving or
 * unflagged. Lost on a restart, which only delays spotting a stalled download. */
const stalledSince = new Map<number, number>();

function trackStalledFlag(queueId: number, flagged: boolean): void {
  if (!flagged) stalledSince.delete(queueId);
  else if (!stalledSince.has(queueId)) stalledSince.set(queueId, Date.now());
}

/** queue.import_resume_state: whether the one automatic retry of an import a restart cut off is
 * still to come (resumeInterruptedImports). A Manual import running is never retried that way: the
 * automatic importer would pick its own file and quality rather than the ones the admin chose. */
const IMPORT_RESUME_NONE = 0;
const IMPORT_RESUME_PENDING = 1;
const IMPORT_RESUME_USED = 2;
const IMPORT_RESUME_MANUAL = 3;

const INTERRUPTED_TWICE_REASON = "Import was interrupted by a restart twice — use Manual import";
const MANUAL_INTERRUPTED_REASON = "Manual import was interrupted by a restart — run it again";

/**
 * Imports a row its client reports completed as the only import of that row in flight: an admin's
 * Retry import or Manual import of it races on the same files, and whichever finishes first deletes
 * the row and the client's data while the other is still copying. Resolves true once imported.
 * `sharedDownloadImported`: another row tracking the same download was imported in this poll and
 * took its files, so this row failing says nothing about the release. The row's import_started_at
 * is already set; a successful import deletes the row, and a skip or a failure clears it.
 */
/** `keepForManual`: the row had already been left for a manual import before a restart cut off a
 * retry of it, so a failure goes back to waiting for the admin instead of blocklisting the release. */
async function importCompletedDownload(match: QueueItem, sharedDownloadImported: boolean, keepForManual = false): Promise<boolean> {
  let imported = false;
  const ran = await withQueueImportLock(match.id, async () => {
    try {
      await importQueueItem(match.id);
      imported = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const skipped = err instanceof ImportSkippedError;
      if (skipped || sharedDownloadImported || keepForManual || (await isLibrarySideImportError(err))) {
        // Left 'completed' for a manual import; pruneOldFailedQueueItems clears it if nobody acts.
        const reason = skipped
          ? message
          : sharedDownloadImported
          ? `Another queue entry for the same download was already imported: ${message}`
          : keepForManual && match.importSkippedReason
          ? `${match.importSkippedReason} (retried after a restart: ${message})`
          : `Couldn't place the file: ${message}`;
        log.info(`[scheduler] import skipped for "${match.title}": ${reason}`);
        await db.prepare("UPDATE queue SET import_started_at = NULL, import_skipped_reason = ? WHERE id = ?").run(reason, match.id);
        const mediaRow = (await db.prepare("SELECT title FROM media_items WHERE id = ?").get(match.mediaItemId)) as
          | { title: string }
          | undefined;
        notifyManualInteractionRequired(mediaRow?.title ?? match.title, reason).catch((e) =>
          log.warn("[scheduler] notification failed:", e.message)
        );
        return;
      }
      log.warn(`[scheduler] import failed for "${match.title}":`, message);
      // A row removed meanwhile, or already moved on by someone else, leaves nothing to fail or retry.
      const failed = await db
        .prepare(`UPDATE queue SET status = 'failed', import_started_at = NULL, updated_at = ${nowExpr(db)} WHERE id = ? AND status = 'completed'`)
        .run(match.id);
      if (failed.changes === 0) return;
      notifyQueueChanged();
      await retryFailedGrab(match, message);
    }
  });
  if (!ran) log.info(`[scheduler] "${match.title}" is being imported or removed from Activity; leaving it to that`);
  return imported;
}

/** A Manual import that has ended takes the row back to never having been resumed. */
const MANUAL_IMPORT_ENDED = `import_resume_state = CASE WHEN import_resume_state = ${IMPORT_RESUME_MANUAL} THEN ${IMPORT_RESUME_NONE} ELSE import_resume_state END`;

/**
 * Marks an import Activity runs on a queue row (Retry import, Manual import) as started, like the
 * poller's own, so a restart during it is caught too: a Retry import is then retried by the poller,
 * a Manual import (`manual`) left for the admin. Either stands in for an automatic retry still
 * waiting for the poller, which then doesn't run on top of it.
 */
export async function markQueueImportStarted(queueId: number, manual = false): Promise<void> {
  const resumeState = manual
    ? String(IMPORT_RESUME_MANUAL)
    : `CASE WHEN import_resume_state = ${IMPORT_RESUME_PENDING} THEN ${IMPORT_RESUME_USED}
         WHEN import_resume_state = ${IMPORT_RESUME_MANUAL} THEN ${IMPORT_RESUME_NONE} ELSE import_resume_state END`;
  await db
    .prepare(`UPDATE queue SET import_started_at = ${nowExpr(db)}, import_resume_state = ${resumeState} WHERE id = ?`)
    .run(queueId);
}

/** Clears the mark markQueueImportStarted set, for an Activity import that failed; a skip also
 * records why. */
export async function markQueueImportFailed(queueId: number, err: unknown): Promise<void> {
  if (err instanceof ImportSkippedError) {
    await db
      .prepare(`UPDATE queue SET import_started_at = NULL, import_skipped_reason = ?, ${MANUAL_IMPORT_ENDED} WHERE id = ?`)
      .run(err.message, queueId);
  } else {
    await db.prepare(`UPDATE queue SET import_started_at = NULL, ${MANUAL_IMPORT_ENDED} WHERE id = ?`).run(queueId);
  }
}

/**
 * Hands each 'completed' queue row whose import a restart or shutdown cut off (import_started_at
 * still set) back to the queue poller, which imports it once more (resumePendingImports). One cut
 * off again after that, and a Manual import cut off, are left for the admin. Rows whose import was
 * skipped, and rows from before import_started_at existed, don't have it set, so they are neither
 * re-run nor re-notified. Runs at startup, before the first poll.
 */
export async function resumeInterruptedImports(): Promise<void> {
  const manualCutOff = await db
    .prepare(
      `UPDATE queue SET import_started_at = NULL, import_skipped_reason = ?, import_resume_state = ${IMPORT_RESUME_NONE}, updated_at = ${nowExpr(db)}
       WHERE status = 'completed' AND import_started_at IS NOT NULL AND import_resume_state = ${IMPORT_RESUME_MANUAL}`
    )
    .run(MANUAL_INTERRUPTED_REASON);
  const cutOffTwice = await db
    .prepare(
      `UPDATE queue SET import_started_at = NULL, import_skipped_reason = ?, updated_at = ${nowExpr(db)}
       WHERE status = 'completed' AND import_started_at IS NOT NULL AND import_resume_state <> ${IMPORT_RESUME_NONE}`
    )
    .run(INTERRUPTED_TWICE_REASON);
  const resumed = await db
    .prepare(
      `UPDATE queue SET import_started_at = NULL, import_resume_state = ${IMPORT_RESUME_PENDING}, updated_at = ${nowExpr(db)}
       WHERE status = 'completed' AND import_started_at IS NOT NULL AND import_resume_state = ${IMPORT_RESUME_NONE}`
    )
    .run();
  // An Activity import of a failed row leaves it failed whether or not it finished.
  await db
    .prepare(`UPDATE queue SET import_started_at = NULL, ${MANUAL_IMPORT_ENDED} WHERE import_started_at IS NOT NULL AND status <> 'completed'`)
    .run();
  const leftForAdmin = manualCutOff.changes + cutOffTwice.changes;
  if (resumed.changes > 0) log.info(`[scheduler] ${resumed.changes} import(s) cut off by a restart will be retried by the queue poller`);
  if (leftForAdmin > 0) log.warn(`[scheduler] ${leftForAdmin} import(s) cut off by a restart are left for a manual import`);
  if (resumed.changes > 0 || leftForAdmin > 0) notifyQueueChanged();
}

/** Imports the rows resumeInterruptedImports handed back, through the same path as a download its
 * client has just reported complete; claiming each first makes this its one automatic retry. */
async function resumePendingImports(): Promise<void> {
  const pending = (
    (await db
      .prepare(`SELECT * FROM queue WHERE status = 'completed' AND import_resume_state = ${IMPORT_RESUME_PENDING} AND import_started_at IS NULL ORDER BY id`)
      .all()) as any[]
  ).map(queueItemFromRow) as QueueItem[];
  for (const match of pending) {
    const claimed = await db
      .prepare(
        `UPDATE queue SET import_resume_state = ${IMPORT_RESUME_USED}, import_started_at = ${nowExpr(db)}, updated_at = ${nowExpr(db)}
         WHERE id = ? AND status = 'completed' AND import_resume_state = ${IMPORT_RESUME_PENDING} AND import_started_at IS NULL`
      )
      .run(match.id);
    if (claimed.changes === 0) continue;
    notifyQueueChanged();
    log.info(`[scheduler] retrying the import of "${match.title}", which a restart cut off`);
    await importCompletedDownload(match, false, !!match.importSkippedReason);
  }
}

type PolledStatus = QueueStatusUpdate & { stalled?: boolean };

/**
 * Poll download clients for progress on active queue items, and import completed ones. Every
 * client is asked at once, so a slow or unreachable one doesn't hold up the rest; what they report
 * is then handled one client after another, so imports never run side by side.
 */
export async function pollQueue() {
  try {
    await resumePendingImports();
  } catch (err) {
    log.warn("[scheduler] retrying interrupted imports failed:", (err as Error).message);
  }

  const clients = await rowsToDownloadClients();
  const active = (
    (await db.prepare("SELECT * FROM queue WHERE status IN ('queued','downloading')").all()) as any[]
  ).map(queueItemFromRow) as QueueItem[];
  const activeIds = new Set(active.map((q) => q.id));
  for (const id of stalledSince.keys()) if (!activeIds.has(id)) stalledSince.delete(id);
  if (active.length === 0) return;

  const polled = clients
    .map((client) => ({ client, relevant: active.filter((q) => q.downloadClientId === client.id) }))
    .filter(({ relevant }) => relevant.length > 0);
  const answers = await Promise.allSettled(
    polled.map(
      async ({ client, relevant }): Promise<PolledStatus[]> =>
        getDownloadClientAdapter(client.type).getStatus(client, relevant.map((q) => q.downloadId!).filter(Boolean))
    )
  );

  for (const [i, { client, relevant }] of polled.entries()) {
    const answer = answers[i];
    if (answer.status === "rejected") {
      const reason = answer.reason instanceof Error ? answer.reason.message : String(answer.reason);
      log.warn(`[scheduler] queue poll failed for client "${client.name}":`, reason);
      continue;
    }
    try {
      await applyClientStatuses(client, relevant, answer.value);
    } catch (err) {
      log.warn(`[scheduler] queue poll failed for client "${client.name}":`, (err as Error).message);
    }
  }
}

/** Records what one client reported for its active rows, importing, failing and retrying them. */
async function applyClientStatuses(client: DownloadClient, relevant: QueueItem[], statuses: PolledStatus[]): Promise<void> {
  for (const status of statuses) {
    // Translated through any configured remote path mapping before it's ever stored, so
    // nothing downstream (importer.ts included) has to know or care whether one applies —
    // undefined (the common case: no mapping configured, or this adapter doesn't report a
    // path at all) leaves the column untouched rather than clobbering it with null.
    const downloadPath = status.remotePath
      ? await applyRemotePathMapping(client.id, status.remotePath)
      : undefined;
    // Rows grabbed before grab() refused duplicates can share one download: it's imported for each
    // of them, but a failure of it is one failure of its release, removed and held against it once.
    let sharedDownloadImported = false;
    let releaseFailureRecorded = false;

    for (const match of relevant.filter((q) => q.downloadId === status.downloadId)) {
      // Every write only applies while the row is still active: since this run read it, an admin
      // may have removed it on Activity or deleted its client (which fails the client's rows), and
      // writing it back would resurrect it, or import and retry a download nobody wants any more.
      if (status.resolvedDownloadId && status.resolvedDownloadId !== match.downloadId) {
        const rekeyed = await db
          .prepare("UPDATE queue SET download_id = ? WHERE id = ? AND status IN ('queued','downloading')")
          .run(status.resolvedDownloadId, match.id);
        if (rekeyed.changes === 0) continue;
      }

      // last_progress_at only moves forward when progress actually changed — that's the signal
      // stalled-download cleanup uses to tell "still downloading, just slow" apart from "stuck".
      const progressChanged = status.progress !== match.progress;
      const pathSet = downloadPath !== undefined ? ", download_path = ?" : "";
      const pathArgs = downloadPath !== undefined ? [downloadPath] : [];
      // Marked in the same write that completes the row, so a restart before its import even
      // starts is caught by resumeInterruptedImports too.
      const importStart = status.status === "completed" ? `, import_started_at = ${nowExpr(db)}` : "";
      const updated = progressChanged
        ? await db
            .prepare(
              `UPDATE queue SET progress = ?, status = ?, updated_at = ${nowExpr(db)}, last_progress_at = ${nowExpr(db)}${pathSet}${importStart} WHERE id = ? AND status IN ('queued','downloading')`
            )
            .run(status.progress, status.status, ...pathArgs, match.id)
        : await db
            .prepare(`UPDATE queue SET status = ?, updated_at = ${nowExpr(db)}${pathSet}${importStart} WHERE id = ? AND status IN ('queued','downloading')`)
            .run(status.status, ...pathArgs, match.id);
      if (updated.changes === 0) continue;
      trackStalledFlag(match.id, status.status === "downloading" && !progressChanged && status.stalled === true);
      notifyQueueChanged();

      if (status.status === "completed") {
        if (await importCompletedDownload(match, sharedDownloadImported)) sharedDownloadImported = true;
      } else if (status.status === "failed") {
        if (status.failureReason === DOWNLOAD_INTERRUPTED_REASON) {
          // Cut off by an AoNarr restart: the release did nothing wrong, so it's grabbed again
          // rather than blocklisted and swapped for a worse one (the adapter already dropped
          // whatever partial file the lost job left).
          await retryFailedGrab(match, status.failureReason, { releaseAtFault: false });
        } else if (releaseFailureRecorded) {
          await retryFailedGrab(match, "Download failed at the download client", { failureRecorded: true });
        } else {
          // A client-level failure (the download itself died — a bad torrent, a failed usenet
          // repair) means there's no completed data worth keeping around, unlike an import-level
          // failure (handled above), where the file did finish downloading and the "Manual
          // import..." picker needs it to still be there. Removed before retrying, not after, so
          // it happens whether or not a replacement release is found.
          releaseFailureRecorded = true;
          if (getSetting("removeFailedDownloads") !== "0") {
            await removeQueueItemDownload(match, true);
          }
          await retryFailedGrab(match, "Download failed at the download client");
        }
      }
    }
  }

  // qBittorrent fetches a .torrent URL on its own after accepting the add: when that fetch fails,
  // or it already has the torrent and drops the duplicate untagged, the placeholder id never
  // resolves and the row would sit at 'queued' forever, holding up every search for its target.
  if (client.type === "qbittorrent") {
    const cutoff = new Date(Date.now() - UNRESOLVED_TORRENT_TIMEOUT_MS).toISOString().slice(0, 19).replace("T", " ");
    const comparable = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const q of relevant) {
      if (!q.downloadId || statuses.some((s) => s.downloadId === q.downloadId)) continue;
      // A pending tag, or a .torrent URL a row was keyed by before hashes were resolved at add time.
      const legacyUrl = /^https?:\/\//i.test(q.downloadId);
      if (!q.downloadId.startsWith("tag:") && !legacyUrl) continue;
      if (!q.addedAt || q.addedAt > cutoff) continue;
      // qBittorrent drops a duplicate add (a release it's still seeding) without applying the new
      // tags, so the torrent can be there all along under its own name.
      const byName = statuses.find(
        (s) =>
          !s.resolvedDownloadId &&
          !!s.clientTitle &&
          comparable(s.clientTitle) === comparable(q.title) &&
          !relevant.some((other) => other.id !== q.id && other.downloadId === s.downloadId)
      );
      if (byName) {
        await db.prepare("UPDATE queue SET download_id = ? WHERE id = ?").run(byName.downloadId, q.id);
        continue;
      }
      const failed = await db
        .prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ? AND status IN ('queued','downloading')`)
        .run(q.id);
      if (failed.changes === 0) continue;
      notifyQueueChanged();
      // A legacy row's torrent was most likely added and may well have finished — failing it just
      // stops it holding up searches, without blocklisting a release that probably worked.
      if (!legacyUrl) await retryFailedGrab(q, "qBittorrent never added the torrent");
    }
  }
}

/**
 * Fails the active rows nothing will ever poll — their client was deleted, or they never got a
 * download id — and searches their targets again, whatever their age: they can't move again, and each
 * holds its target from every search meanwhile. Their release did nothing wrong, so it's neither
 * blocklisted nor held against its group, and there's no client left to remove anything from.
 */
async function failOrphanedDownloads(): Promise<void> {
  const rows = (await db
    .prepare(
      `SELECT q.*, c.id AS client_row_id FROM queue q LEFT JOIN download_clients c ON c.id = q.download_client_id
       WHERE q.status IN ('queued', 'downloading') AND (c.id IS NULL OR q.download_id IS NULL OR q.download_id = '')`
    )
    .all()) as any[];
  for (const row of rows) {
    const item = queueItemFromRow(row) as QueueItem;
    const moved = await db
      .prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ? AND status IN ('queued', 'downloading')`)
      .run(item.id);
    if (moved.changes === 0) continue;
    stalledSince.delete(item.id);
    notifyQueueChanged();
    const reason = row.client_row_id == null ? "Its download client no longer exists" : "Its download client never reported an id to track it by";
    await retryFailedGrab(item, reason, { releaseAtFault: false });
    log.info(`[scheduler] failed untrackable download "${item.title}": ${reason}`);
  }
}

/** Removes/retries queue items whose progress hasn't moved in longer than the configured
 * threshold — a download stuck at the client (dead peers, a paused torrent, a stalled usenet
 * connection) would otherwise sit in the queue forever since pollQueue only acts on status
 * changes the client itself reports. */
export async function cleanupStalledDownloads(): Promise<void> {
  const thresholdHours = Math.max(1, parseInt(getSetting("stalledDownloadHours") ?? "6", 10) || 6);
  await failOrphanedDownloads();
  // A download that never made any progress (a dead torrent at 0%, one deleted at the client) has
  // no last_progress_at: it ages from when it was grabbed, or it would hold its target forever.
  const rows = (await db
    .prepare(
      `SELECT * FROM queue WHERE status IN ('queued', 'downloading')
       AND COALESCE(last_progress_at, added_at) <= ${nowOffsetHoursExpr(db, -thresholdHours)}`
    )
    .all()) as any[];
  if (rows.length === 0) return;
  const neverProgressed = new Set(rows.filter((r) => r.last_progress_at == null).map((r) => Number(r.id)));
  const candidates = rows.map(queueItemFromRow) as QueueItem[];

  const clientsById = new Map(
    ((await db.prepare("SELECT * FROM download_clients").all()) as any[]).map((row) => {
      const client = downloadClientFromRow(row) as DownloadClient;
      return [client.id, client] as const;
    })
  );
  const stalled: QueueItem[] = [];
  const toConfirm = new Map<number, QueueItem[]>();
  for (const q of candidates) {
    const client = q.downloadClientId != null ? clientsById.get(q.downloadClientId) : undefined;
    // Orphaned since failOrphanedDownloads ran: the next run takes it.
    if (!client || !q.downloadId) continue;
    // A blackhole can never report progress, and a disabled client isn't asked.
    if (client.type === "blackhole" || !client.enabled) continue;
    toConfirm.set(client.id, [...(toConfirm.get(client.id) ?? []), q]);
  }
  for (const [clientId, clientRows] of toConfirm) {
    const client = clientsById.get(clientId)!;
    let statuses: (QueueStatusUpdate & { stalled?: boolean })[];
    try {
      statuses = await getDownloadClientAdapter(client.type).getStatus(client, clientRows.map((q) => q.downloadId!));
    } catch (err) {
      // An unreachable client says nothing about its downloads: failing them would blocklist every
      // release it holds.
      log.warn(`[scheduler] stalled-download check skipped for client "${client.name}":`, (err as Error).message);
      continue;
    }
    for (const q of clientRows) {
      const status = statuses.find((s) => s.downloadId === q.downloadId);
      if (status) {
        // Moving again, or finished/failed at the client: the queue poller takes it from here.
        if (status.status !== "downloading" || status.progress !== q.progress) {
          stalledSince.delete(q.id);
          continue;
        }
        // Adapters also report a download still waiting its turn in the client's own queue
        // (qBittorrent queuedDL, SABnzbd "Queued" or paused) as downloading at 0%, so a download that
        // never progressed only counts once the client itself has flagged it as active but getting
        // nothing for the whole threshold. Its age says nothing: it counts from the grab, and a
        // healthy torrent can wait in the client's queue for hours, then sit flagged at 0% for a
        // minute while it fetches its metadata.
        if (neverProgressed.has(Number(q.id))) {
          trackStalledFlag(q.id, status.stalled === true);
          const since = stalledSince.get(q.id);
          if (since === undefined || Date.now() - since < thresholdHours * 3_600_000) continue;
        }
      }
      stalled.push(q);
    }
  }

  // Rows sharing one download are one failure of its release: removed at the client and held
  // against its group once, while each row's target is still searched again.
  const failedDownloads = new Set<string>();
  for (const item of stalled) {
    // The poller may have moved the row (completed it, say) since it was read.
    const moved = await db
      .prepare(`UPDATE queue SET status = 'failed', updated_at = ${nowExpr(db)} WHERE id = ? AND status IN ('queued', 'downloading')`)
      .run(item.id);
    if (moved.changes === 0) continue;
    stalledSince.delete(item.id);
    notifyQueueChanged();
    const reason = `Stalled: no progress for over ${thresholdHours}h`;
    const downloadKey = item.downloadId ? `${item.downloadClientId}:${item.downloadId}` : null;
    if (downloadKey && failedDownloads.has(downloadKey)) {
      await retryFailedGrab(item, reason, { failureRecorded: true });
      log.info(`[scheduler] cleaned up stalled download "${item.title}"`);
      continue;
    }
    if (downloadKey) failedDownloads.add(downloadKey);
    // Not every download-client adapter can cancel a specific download at the client itself
    // (optional on the adapter interface — see downloadClient.ts) — where it can (qBittorrent,
    // SABnzbd), a stalled download is dead weight worth clearing out rather than leaving it stuck
    // at the client's own UI too; where it can't, this is still a no-op, same as before.
    if (getSetting("removeFailedDownloads") !== "0") {
      await removeQueueItemDownload(item, true);
    }
    await retryFailedGrab(item, reason);
    log.info(`[scheduler] cleaned up stalled download "${item.title}"`);
  }
}

/** A queue row at status='failed' stays visible on purpose — Retry import / Manual import... /
 * Remove all need something to act on — but if nobody ever does, it would otherwise sit there
 * forever, right back to the same "queue never clears out" problem this whole cleanup pass exists
 * to fix. Prunes any 'failed' row untouched for over a week; its own 'failed' history entry (see
 * retryFailedGrab) already recorded the permanent record, so nothing is lost by dropping the row.
 * A 'completed' row whose import was skipped (pollQueue) waits for a manual import the same way,
 * and holds its target from every search while it does, so it goes on the same terms. */
export async function pruneOldFailedQueueItems(): Promise<void> {
  const stale = (await db
    .prepare(`SELECT id FROM queue WHERE status IN ('failed', 'completed') AND updated_at <= ${nowOffsetHoursExpr(db, -24 * 7)}`)
    .all()) as { id: number }[];
  if (stale.length === 0) return;
  await db.prepare(`DELETE FROM queue WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale.map((s) => s.id));
  notifyQueueChanged();
  log.info(`[scheduler] pruned ${stale.length} week-old failed or unimported queue item(s) nobody acted on`);
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

// A cron step only counts within its own field: a minute step of 120 runs hourly at :00, and one
// that doesn't divide 60 (45 -> :00 and :45) runs more often than asked, burning indexer quota.
// Round up to a step that divides its field evenly, moving to the hour/day field past 30 minutes.
export function autoSearchCronSchedule(intervalMinutes: number): string {
  const minutes = Number.isFinite(intervalMinutes) ? Math.max(1, Math.ceil(intervalMinutes)) : 30;
  const minuteStep = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30].find((s) => s >= minutes);
  if (minuteStep) return `*/${minuteStep} * * * *`;
  const hourStep = [1, 2, 3, 4, 6, 8, 12].find((s) => s * 60 >= minutes);
  if (hourStep) return `0 */${hourStep} * * *`;
  return `0 0 */${Math.min(28, Math.ceil(minutes / 1440))} * *`;
}

let started = false;

export function startScheduler() {
  if (started) return;
  started = true;

  const autoSearchSchedule = autoSearchCronSchedule(config.searchIntervalMinutes);
  registerJob({
    key: "autoSearch",
    name: "Auto Search",
    scheduleType: "cron",
    defaultSchedule: autoSearchSchedule,
    run: (signal) => runAutoSearch(signal),
  });

  // Awaited by every poll (a manual "run now" included), so none starts before it's done.
  const interruptedImportsHandedBack = resumeInterruptedImports().catch((err) =>
    log.warn("[scheduler] couldn't hand imports cut off by a restart back to the queue poller:", (err as Error).message)
  );
  registerJob({
    key: "queuePoll",
    name: "Queue Poll",
    scheduleType: "interval",
    defaultSchedule: String(Math.max(5, config.queuePollIntervalSeconds)),
    run: async () => {
      await interruptedImportsHandedBack;
      await pollQueue();
    },
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
      // Thrown so the Jobs page records the run as failed; runTraktSync reports errors, never throws.
      if (r.error) throw new Error(r.error);
      // A partial success (some items couldn't be added) still counts as a successful run.
      const warning = (r as { warning?: string }).warning;
      if (warning) log.warn(`[scheduler] Trakt sync: ${warning}`);
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
      if (r.error) throw new Error(r.error);
      if (r.warning) log.warn(`[scheduler] Plex watchlist sync: ${r.warning}`);
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
    `[scheduler] started: auto-search "${autoSearchSchedule}" (interval ${config.searchIntervalMinutes}m), queue poll every ${config.queuePollIntervalSeconds}s`
  );
}
