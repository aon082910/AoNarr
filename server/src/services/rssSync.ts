import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { log } from "./logger.js";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { usesQualityTiers, qualityRank } from "./quality.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { fetchRecentReleases, rssFeedGroups, type RssMarker } from "./indexerClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode, type ParsedRelease } from "./releaseParser.js";
import { aliasTitlesByItem, resolveReleaseItemInLibrary } from "./releaseAliases.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import { computeAbsoluteEpisodeNumber } from "./importer.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { recordPending } from "./pendingStore.js";
import { formatCutoffNotMet, propersMode, revisionUpgrade, upgradeProfileOf, type ExistingFile, type UpgradeProfile } from "./upgradeRules.js";
import { existingFileRecord } from "./fileRelease.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
import { airedFrontierFor, episodeNotAired, episodePlanFor, seasonPlanFor } from "./searchPlan.js";
import { recordLeafOutcome, recordSeasonSearch, wakeLeaf, wakeSeason } from "./searchBackoff.js";
import {
  chooseBestResult,
  directDownloadBudget,
  existingFileQuality,
  getQualityProfile,
  grab,
  grabBestRelease,
  isAlreadyQueued,
  isBelowCutoff,
  isHeldByDelay,
  isReleaseAvailableForSearch,
  loadDelayProfiles,
  meetsCutoff,
  noteUnavailableClient,
  packContextFor,
  packsPossibleFor,
  pickDelayProfile,
  rowsToDownloadClients,
  rowsToIndexers,
  seasonGroupsOf,
  tagIdsForMediaItem,
  targetIdentityOf,
  type DelayProfile,
  type DirectDownloadBudget,
  type SeasonGroup,
} from "./scheduler.js";
import type { DownloadClient, Indexer, MediaItem, MediaType, SearchResult } from "../types/index.js";

/**
 * Sonarr's RSS sync, for AoNarr's own monitored library: each indexer's list of newest releases is
 * read (back to the newest release the last run saw), every release is matched to the item it names
 * (releaseAliases.resolveReleaseItemInLibrary, the way an IRC announce is) and, for what is wanted of
 * that item, judged with exactly the rules of a search (chooseBestResult: identity, rejections,
 * quality, formats, delay profile, season pack guards) and grabbed. Nothing is grabbed that no
 * monitored target wants.
 *
 * This is what finds a release the moment an indexer lists it, instead of the next search of every
 * missing episode of every show: searches can then come less often (searchBackoff.ts) and be left to
 * what a feed cannot show, the back catalogue. A target the sync saw a release for but could not
 * grab only because its delay profile holds it back is woken: a feed does not list a release twice,
 * so it is searched at the next cycle whatever it had missed, and found once the delay is over.
 * (A release that is simply refused, for its quality, size or name, wakes nothing.) Where a feed was
 * read to is kept only once the releases above it were judged: a run cut short (aborted, or a
 * download client down) reads them again, since a feed does not list a release twice.
 *
 * Plain RSS indexers are read here only (an automatic search leaves them out, as Sonarr's TorrentRss
 * is). Upgrades are grabbed too when `autoUpgradeEnabled` is on, the same switch as the upgrade job.
 */

const MAX_RELEASES_PER_RUN = 5000;

async function loadMarker(indexerId: number, feedKey: string): Promise<RssMarker | null> {
  const row = (await db.prepare("SELECT last_seen_url, last_seen_at FROM rss_sync_state WHERE indexer_id = ? AND feed_key = ?").get(indexerId, feedKey)) as
    | { last_seen_url: string | null; last_seen_at: string | null }
    | undefined;
  // A row with neither a release nor a date marks nothing: a feed that was empty when it was first read.
  return row && (row.last_seen_url || row.last_seen_at) ? { url: row.last_seen_url, at: row.last_seen_at } : null;
}

async function saveMarker(indexerId: number, feedKey: string, marker: RssMarker): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rss_sync_state (indexer_id, feed_key, last_seen_url, last_seen_at, last_run_at) VALUES (?, ?, ?, ?, ${nowExpr(db)})
       ON CONFLICT (indexer_id, feed_key) DO UPDATE SET last_seen_url = excluded.last_seen_url, last_seen_at = excluded.last_seen_at, last_run_at = excluded.last_run_at`
    )
    .run(indexerId, feedKey, marker.url, marker.at);
}

/** What the library wants, as far as the feeds can fill it. */
interface Wanted {
  singles: MediaItem[];
  shows: MediaItem[];
  /** Each show's wanted episodes: monitored, aired, missing (or below the cutoff, with upgrades on). */
  episodes: Map<number, any[]>;
  types: Set<MediaType>;
}

async function loadWanted(upgrades: boolean): Promise<Wanted> {
  const wanted: Wanted = { singles: [], shows: [], episodes: new Map(), types: new Set() };
  const items = ((await db.prepare("SELECT * FROM media_items WHERE monitored = 1").all()) as any[])
    .map(mediaItemFromRow)
    .filter((item) => usesQualityTiers(item.type)) as MediaItem[];
  const cutoffs = new Map<number | null, string>();
  const cutoffOf = async (item: MediaItem) => {
    if (!cutoffs.has(item.qualityProfileId)) cutoffs.set(item.qualityProfileId, (await getQualityProfile(item.qualityProfileId))?.cutoff ?? "");
    return cutoffs.get(item.qualityProfileId)!;
  };

  const showsById = new Map<number, MediaItem>();
  for (const item of items) {
    const shape = getMediaTypeConfig(item.type).shape;
    if (shape === "single") {
      const missing = !item.hasFile && isReleaseAvailableForSearch(item);
      if (missing || (upgrades && item.hasFile && isBelowCutoff(item.quality ?? null, await cutoffOf(item)))) {
        wanted.singles.push(item);
        wanted.types.add(item.type);
      }
    } else if (shape === "episodic") {
      showsById.set(item.id, item);
    }
  }
  if (showsById.size > 0) {
    const rows = (await db
      .prepare(
        `SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id
         WHERE e.monitored = 1 AND m.monitored = 1 ${upgrades ? "" : "AND e.has_file = 0"}`
      )
      .all()) as any[];
    const today = new Date().toISOString().slice(0, 10);
    const frontiers = new Map<number, Map<number, number>>();
    for (const row of rows) {
      const show = showsById.get(row.media_item_id);
      if (!show) continue;
      if (Number(row.has_file) && !isBelowCutoff(row.quality ?? null, await cutoffOf(show))) continue;
      let frontier: Map<number, number> | undefined;
      if (!row.air_date) {
        if (!frontiers.has(show.id)) frontiers.set(show.id, await airedFrontierFor(show.id, today));
        frontier = frontiers.get(show.id);
      }
      if (episodeNotAired(show, row, today, frontier)) continue;
      const list = wanted.episodes.get(show.id) ?? [];
      list.push(row);
      wanted.episodes.set(show.id, list);
      wanted.types.add(show.type);
    }
    for (const id of wanted.episodes.keys()) wanted.shows.push(showsById.get(id)!);
  }
  return wanted;
}

/** The target a release was matched to, with every release of this run that names it. */
type Group =
  | { kind: "single"; key: string; item: MediaItem; releases: SearchResult[] }
  | { kind: "episode"; key: string; item: MediaItem; ep: any; releases: SearchResult[] }
  | { kind: "season"; key: string; item: MediaItem; season: SeasonGroup; episodes: any[]; releases: SearchResult[] };

export interface RssSyncSummary {
  releases: number;
  grabbed: number;
  woken: number;
}

export async function runRssSync(signal?: AbortSignal): Promise<RssSyncSummary> {
  const summary: RssSyncSummary = { releases: 0, grabbed: 0, woken: 0 };
  const clients = await rowsToDownloadClients();
  if (clients.length === 0) {
    log.info("[rss] skipping RSS sync: no enabled download clients configured");
    return summary;
  }
  const upgrades = getSetting("autoUpgradeEnabled") === "1";
  const wanted = await loadWanted(upgrades);
  if (wanted.types.size === 0) return summary;

  // 1. the newest releases of every indexer's feeds
  const indexers = (await rowsToIndexers()).filter((i) => i.enabled && (i.protocol === "torznab" || i.protocol === "newznab" || i.protocol === "rss"));
  const releases: SearchResult[] = [];
  // Where each feed was read to. A feed does not list a release twice, so a marker is kept only once
  // the releases above it have been judged (below): a run cut short reads them again.
  const markers: { indexerId: number; key: string; marker: RssMarker }[] = [];
  for (const indexer of indexers) {
    if (signal?.aborted) return summary;
    const groups =
      indexer.protocol === "rss"
        ? [{ key: "rss", cats: "", types: [...wanted.types].filter((t) => indexer.mediaTypes.split(",").includes(t)) }]
        : rssFeedGroups(indexer, [...wanted.types]);
    for (const group of groups.filter((g) => g.types.length > 0)) {
      try {
        const marker = await loadMarker(indexer.id, group.key);
        const feed = await fetchRecentReleases(indexer, group, marker);
        releases.push(...feed.results);
        const newest = feed.newest ?? marker;
        if (newest) markers.push({ indexerId: indexer.id, key: group.key, marker: newest });
      } catch (err) {
        log.warn(`[rss] "${indexer.name}": couldn't read its newest releases:`, (err as Error).message);
      }
    }
  }
  const keepMarkers = async () => {
    for (const m of markers) await saveMarker(m.indexerId, m.key, m.marker);
  };
  summary.releases = releases.length;
  if (releases.length === 0) {
    await keepMarkers();
    return summary;
  }
  if (releases.length > MAX_RELEASES_PER_RUN) {
    log.warn(`[rss] ${releases.length} new releases: only the newest ${MAX_RELEASES_PER_RUN} are judged`);
    releases.length = MAX_RELEASES_PER_RUN;
  }

  // 2. the target each release names
  const groups = await matchReleases(releases, wanted);
  if (groups.size === 0) {
    await keepMarkers();
    return summary;
  }

  // 3. for each target, the best of its releases, grabbed
  const env: DecideEnv = {
    indexers,
    clients,
    delayProfiles: await loadDelayProfiles(),
    directBudget: await directDownloadBudget(clients),
    unavailable: new Map(),
    upgrades,
    grabbedUrls: new Set(),
  };
  let complete = true;
  for (const group of groups.values()) {
    if (signal?.aborted || clients.every((c) => env.unavailable.has(c.id))) {
      complete = false;
      break;
    }
    try {
      const result = await decide(group, env);
      if (result === "grabbed") summary.grabbed++;
      else if (result === "held") {
        summary.woken++;
        await wake(group);
      } else if (result === "unavailable") complete = false;
    } catch (err) {
      complete = false;
      log.warn(`[rss] couldn't process "${group.item.title}":`, (err as Error).message);
    }
  }
  // A client that went down during the run turned its releases away: they are judged again next time.
  if (complete && env.unavailable.size === 0) await keepMarkers();
  if (summary.grabbed > 0 || summary.woken > 0) {
    log.info(`[rss] ${releases.length} new release(s): ${summary.grabbed} grabbed, ${summary.woken} left to the next search`);
  }
  return summary;
}

/** Maps each release to the single item, episode or season it names among what is wanted. */
async function matchReleases(releases: SearchResult[], wanted: Wanted): Promise<Map<string, Group>> {
  const groups = new Map<string, Group>();
  const add = (group: Group) => {
    const existing = groups.get(group.key);
    if (existing) existing.releases.push(...group.releases);
    else groups.set(group.key, group);
  };
  const aliasesOf = await aliasTitlesByItem([...wanted.singles, ...wanted.shows].map((i) => i.id));
  const sceneIndexes = new Map<number, Awaited<ReturnType<typeof sceneIndexFor>>>();
  const absolutes = new Map<number, number>();

  for (const release of releases) {
    const parsed = parseReleaseTitle(release.title);
    if (parsed.rejected || !parsed.title) continue;
    const episodeShaped = parsed.seasonNumber != null || (parsed.episodeNumbers?.length ?? 0) > 0 || parsed.isFullSeason || !!parsed.airDate || parsed.absoluteEpisode != null;

    if (!episodeShaped) {
      const candidates = wanted.singles.filter((item) => parsed.titleYear != null || parsed.year == null || item.year == null || Math.abs(parsed.year - item.year) <= 1);
      const resolved = await resolveReleaseItemInLibrary({ title: release.title }, parsed, candidates, aliasesOf);
      if (resolved.kind === "one") add({ kind: "single", key: `item:${resolved.item.id}`, item: resolved.item, releases: [release] });
      continue;
    }

    const resolved = await resolveReleaseItemInLibrary({ title: release.title }, parsed, wanted.shows, aliasesOf);
    if (resolved.kind !== "one") continue;
    const show = resolved.item;
    const episodes = wanted.episodes.get(show.id) ?? [];
    if (parsed.isFullSeason) {
      if (!packsPossibleFor(show)) continue;
      // A pack, by the season a release calls it: the wanted episodes of that scene season.
      const season = parsed.seasonNumber == null ? null : seasonGroupsOf(episodes).find((g) => g.scene === parsed.seasonNumber);
      if (season) {
        add({ kind: "season", key: `season:${show.id}:${season.aired}:${season.scene}`, item: show, season, episodes: episodes.filter((e) => season.ids.includes(e.id)), releases: [release] });
      }
      continue;
    }
    if (!sceneIndexes.has(show.id)) sceneIndexes.set(show.id, await sceneIndexFor(show.id));
    for (const ep of episodes) {
      if (!(await releaseNamesEpisode(parsed, show, ep, sceneIndexes.get(show.id), absolutes))) continue;
      add({ kind: "episode", key: `episode:${ep.id}`, item: show, ep, releases: [release] });
    }
  }
  return groups;
}

async function releaseNamesEpisode(
  parsed: ParsedRelease,
  show: MediaItem,
  ep: any,
  sceneIndex: Awaited<ReturnType<typeof sceneIndexFor>>,
  absolutes: Map<number, number>
): Promise<boolean> {
  if (parsed.airDate) return !!ep.air_date && releaseMatchesAirDate(parsed, String(ep.air_date).slice(0, 10));
  let absolute: number | null = null;
  if (show.type === "anime" && parsed.absoluteEpisode != null) {
    if (!absolutes.has(ep.id)) absolutes.set(ep.id, await computeAbsoluteEpisodeNumber(show.id, ep.season_number, ep.episode_number));
    absolute = absolutes.get(ep.id)!;
  }
  return releaseMatchesEpisode(parsed, ep.season_number, ep.episode_number, ep.scene_season_number, ep.scene_episode_number, absolute, sceneIndex);
}

interface DecideEnv {
  indexers: Indexer[];
  clients: DownloadClient[];
  delayProfiles: { tagId: number | null; profile: DelayProfile }[];
  directBudget: DirectDownloadBudget;
  unavailable: Map<number, string>;
  upgrades: boolean;
  /** Releases sent to a client in this run: one that names several episodes is one download, not one per episode. */
  grabbedUrls: Set<string>;
}

/**
 * Judges the releases that name one target as a search of it would, and grabs the best. "unavailable"
 * is a target that could not be served because a download client was down: its releases are judged
 * again by the next run.
 */
async function decide(group: Group, env: DecideEnv): Promise<"grabbed" | "held" | "none" | "skipped" | "unavailable"> {
  const { item } = group;
  if (await isRootFolderOverQuota(item.rootFolderId)) return "skipped";
  const profile = await getQualityProfile(item.qualityProfileId);
  const cutoff = profile?.cutoff ?? "";

  let episodeId: number | null = null;
  let seasonNumber: number | null = null;
  let target = null as Awaited<ReturnType<typeof episodePlanFor>>["target"];
  let pack: ReturnType<typeof packContextFor>;
  let upgradeFromRank: number | null = null;
  let existing: { file: ExistingFile; profile: UpgradeProfile } | undefined;
  let results = group.releases.filter((r) => !env.grabbedUrls.has(r.downloadUrl));
  if (results.length === 0) return "skipped";

  /** A file the target has: replaced only when upgrades are switched on and the profile allows them. At the
   * cutoff (quality and format score) only a later revision of the file's own release can still replace it. */
  const considerUpgrade = async (onDisk: string | null, episode: number | null): Promise<boolean> => {
    if (!env.upgrades) return false;
    const file = await existingFileRecord(item, episode, null);
    const upgradeProfile = upgradeProfileOf(profile);
    if (!file || !upgradeProfile.upgradeAllowed) return false;
    if (meetsCutoff(onDisk, cutoff) && !formatCutoffNotMet(upgradeProfile, file)) {
      const mode = propersMode();
      if (!results.some((r) => revisionUpgrade(mode, file.releaseTitle, r.title))) return false;
    }
    upgradeFromRank = qualityRank(onDisk);
    existing = { file, profile: upgradeProfile };
    return true;
  };

  if (group.kind === "single") {
    if (await isAlreadyQueued(item.id, null, null)) return "skipped";
    const onDisk = await existingFileQuality(item, null, null);
    if (onDisk !== undefined && !(await considerUpgrade(onDisk, null))) return "skipped";
  } else if (group.kind === "episode") {
    episodeId = group.ep.id;
    if (await isAlreadyQueued(item.id, group.ep.id, null)) return "skipped";
    const onDisk = await existingFileQuality(item, group.ep.id, null);
    if (onDisk !== undefined && !(await considerUpgrade(onDisk, group.ep.id))) return "skipped";
    const plan = await episodePlanFor(item, group.ep);
    target = plan.target;
    pack = packContextFor(item, plan);
  } else {
    seasonNumber = group.season.aired;
    let uncovered = false;
    for (const e of group.episodes) if (!(await isAlreadyQueued(item.id, e.id, null))) uncovered = true;
    if (!uncovered) return "skipped";
    const withFiles = group.episodes.filter((e) => Number(e.has_file));
    if (withFiles.length === group.episodes.length) upgradeFromRank = Math.min(...withFiles.map((e) => qualityRank(e.quality ?? null)));
    pack = packContextFor(item, await seasonPlanFor(item, group.season.scene));
    results = results.filter((r) => {
      const parsed = parseReleaseTitle(r.title);
      return parsed.isFullSeason && (parsed.seasonNumber == null || parsed.seasonNumber === group.season.scene);
    });
  }

  const blocklisted = await getBlocklistedTitles(item.id);
  const delayProfile = pickDelayProfile(env.delayProfiles, await tagIdsForMediaItem(item.id));
  const usable = env.directBudget.usableClients().filter((c) => !env.unavailable.has(c.id));
  const choose = (remaining: SearchResult[], delay: DelayProfile | null) =>
    chooseBestResult(
      remaining,
      profile?.allowedQualities ?? [],
      cutoff,
      item.qualityProfileId,
      profile?.minFormatScore ?? 0,
      target,
      blocklisted,
      item.type,
      delay,
      targetIdentityOf(item),
      item.id,
      { clients: usable, upgradeFromRank, existing, name: { title: item.title }, indexers: env.indexers, label: item.title, pack }
    );
  let outcome: Awaited<ReturnType<typeof grabBestRelease>>;
  try {
    outcome = await grabBestRelease(
      results,
      usable,
      (remaining) => choose(remaining, delayProfile),
      (client, chosen) => grab(client, item, episodeId, null, chosen, 0, seasonNumber, "rss")
    );
  } catch (err) {
    if (noteUnavailableClient(err, env.unavailable)) return "unavailable";
    throw err;
  }
  if (!outcome) {
    // Held back by the delay profile alone: the same releases, with no delay, would have been grabbed.
    const leaf = group.kind === "episode" ? ({ table: "episodes", id: group.ep.id } as const) : group.kind === "single" ? ({ table: "media_items", id: item.id } as const) : null;
    return (await isHeldByDelay(results, cutoff, delayProfile, choose, leaf ? (release) => recordPending(leaf.table, leaf.id, item.id, release) : undefined)) ? "held" : "none";
  }
  if (!outcome.grabbed) return "skipped";
  env.grabbedUrls.add(outcome.chosen.result.downloadUrl);
  env.directBudget.consume(outcome.client);
  if (group.kind === "season") await recordSeasonSearch(item.id, group.season.scene, true);
  else await recordLeafOutcome(group.kind === "episode" ? "episodes" : "media_items", group.kind === "episode" ? group.ep.id : item.id, true);
  return "grabbed";
}

/** A target a release was listed for that could not be grabbed yet is searched at the next cycle. */
async function wake(group: Group): Promise<void> {
  if (group.kind === "single") await wakeLeaf("media_items", group.item.id);
  else if (group.kind === "episode") await wakeLeaf("episodes", group.ep.id);
  else await wakeSeason(group.item.id, group.season.scene);
}
