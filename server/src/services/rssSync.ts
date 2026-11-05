import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { log } from "./logger.js";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { usesQualityTiers, qualityRank, rankingOf } from "./quality.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { fetchRecentReleases, rssFeedGroups, type RssMarker } from "./indexerClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode, type ParsedRelease } from "./releaseParser.js";
import { aliasTitlesByItem, resolveReleaseItemInLibrary } from "./releaseAliases.js";
import { couldNameItem, identityKey, releaseNameTokens } from "./releaseIdentity.js";
import { editionlessTitle } from "./nonVideoMatch.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import { computeAbsoluteEpisodeNumber } from "./importer.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { recordPending } from "./pendingStore.js";
import { redactLinks } from "./linkRedaction.js";
import { formatCutoffNotMet, propersMode, revisionUpgrade, upgradeProfileOf, type ExistingFile, type UpgradeProfile } from "./upgradeRules.js";
import { existingFileRecord } from "./fileRelease.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
import { airedFrontierFor, episodeNotAired, episodePlanFor, seasonPlanFor } from "./searchPlan.js";
import { scopeAllows } from "./tagScope.js";
import { discographyGrabsEnabled, isDiscographyRelease, releaseNamesArtist, type DiscographyAlbum } from "./discography.js";
import { RSS_UNMATCHED_PER_RUN, recordRssDecisions, strongerDecision, type RssDecisionInput, type RssOutcome } from "./rssDecisions.js";
import { recordLeafOutcome, recordSeasonSearch, wakeLeaf, wakeSeason } from "./searchBackoff.js";
import {
  AUTOMATIC_DISCOGRAPHY_JUDGE,
  DISCOGRAPHY_SEARCH_KEY,
  chooseBestResult,
  discographyJudgingAlbums,
  grabDiscography,
  type TargetName,
  isNotYetReleased,
  siblingTitlesOf,
  yearFieldsOf,
  directDownloadBudget,
  existingFileQuality,
  getQualityProfile,
  grab,
  grabBestRelease,
  isAlreadyQueued,
  isHeldByDelay,
  isReleaseAvailableForSearch,
  loadDelayProfiles,
  meetsCutoff,
  noteUnavailableClient,
  packContextFor,
  packsPossibleFor,
  pickClientForProtocol,
  pickDelayProfile,
  ReleaseRefusedError,
  rowsToDownloadClients,
  rowsToIndexers,
  seasonGroupsOf,
  tagIdsForMediaItem,
  targetIdentityOf,
  type DelayProfile,
  type DirectDownloadBudget,
  type GrabSource,
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
 * Every release judged is written to rss_decisions (rssDecisions.ts) with what was decided and why, for the "Recent
 * RSS releases" list; a release that names nothing wanted can be mapped by hand there (judgeMappedRelease below).
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
  /** The artists, authors, series and the like with a missing monitored sub-item (an album, book, issue), by id. */
  collections: Map<number, { item: MediaItem; subs: any[] }>;
  /** Every monitored artist, with albums missing or not: a discography names one artist, and a complete namesake is still a second one. */
  artists: MediaItem[];
  types: Set<MediaType>;
}

const emptyWanted = (): Wanted => ({ singles: [], shows: [], episodes: new Map(), collections: new Map(), artists: [], types: new Set() });

/**
 * What the library wants. With `only`, just those items' share of it: a pushed release can name nothing else, and the rest of a
 * large library (every monitored episode of it, with upgrades on) is not read for it.
 */
async function loadWanted(upgrades: boolean, only?: ReadonlySet<number>): Promise<Wanted> {
  const wanted = emptyWanted();
  const ids = only ? [...only] : null;
  const itemFilter = ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const items = ((await db.prepare(`SELECT * FROM media_items WHERE monitored = 1${itemFilter}`).all(...(ids ?? []))) as any[])
    .map(mediaItemFromRow)
    .filter((item) => usesQualityTiers(item.type)) as MediaItem[];

  const showsById = new Map<number, MediaItem>();
  for (const item of items) {
    const shape = getMediaTypeConfig(item.type).shape;
    if (shape === "single") {
      const missing = !item.hasFile && isReleaseAvailableForSearch(item);
      // With upgrades on a film that has its file stays wanted: a later revision of the file's own release, or a
      // release adding custom-format score, can still replace it even at the cutoff (decide() judges that).
      if (missing || (upgrades && item.hasFile)) {
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
         WHERE e.monitored = 1 AND m.monitored = 1 ${upgrades ? "" : "AND e.has_file = 0"}${ids ? ` AND e.media_item_id IN (${ids.map(() => "?").join(",")})` : ""}`
      )
      .all(...(ids ?? []))) as any[];
    const today = new Date().toISOString().slice(0, 10);
    const frontiers = new Map<number, Map<number, number>>();
    for (const row of rows) {
      const show = showsById.get(row.media_item_id);
      if (!show) continue;
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
  // Albums, books, audiobooks, comic issues and manga chapters that are missing (not the ones not out yet).
  const collections = ((await db.prepare(`SELECT * FROM media_items WHERE monitored = 1${itemFilter}`).all(...(ids ?? []))) as any[])
    .map(mediaItemFromRow)
    .filter((item) => !usesQualityTiers(item.type) && getMediaTypeConfig(item.type).shape === "collection" && !["video", "podcast"].includes(item.type)) as MediaItem[];
  wanted.artists = collections.filter((item) => item.type === "artist");
  // One query for every collection's missing sub-items (a plain album before an edition of it, so a release names the plain one).
  if (collections.length > 0) {
    const rows = (await db
      .prepare(
        `SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
         WHERE s.monitored = 1 AND s.has_file = 0 AND m.monitored = 1 AND m.id IN (${collections.map(() => "?").join(",")}) ORDER BY s.id`
      )
      .all(...collections.map((c) => c.id))) as any[];
    const byItem = new Map<number, any[]>();
    for (const row of rows) byItem.set(row.media_item_id, [...(byItem.get(row.media_item_id) ?? []), row]);
    for (const item of collections) {
      const subs = (byItem.get(item.id) ?? [])
        .filter((sub) => !(["artist", "author", "audiobook"].includes(item.type) && isNotYetReleased(sub.release_date)))
        .sort((a, b) => Number(editionlessTitle(a.title) !== a.title) - Number(editionlessTitle(b.title) !== b.title));
      if (subs.length === 0) continue;
      wanted.collections.set(item.id, { item, subs });
      wanted.types.add(item.type);
    }
  }
  return wanted;
}

/** The target a release was matched to, with every release of this run that names it. */
type Group =
  | { kind: "single"; key: string; item: MediaItem; releases: SearchResult[] }
  | { kind: "episode"; key: string; item: MediaItem; ep: any; releases: SearchResult[] }
  | { kind: "sub"; key: string; item: MediaItem; sub: any; releases: SearchResult[] }
  /** A discography of an artist: many of its albums in one release (the albums are read when it is judged). */
  | { kind: "discography"; key: string; item: MediaItem; releases: SearchResult[] }
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
  const indexers = (await rowsToIndexers()).filter((i) => i.enabled && Number(i.enableRss ?? 1) !== 0 && (i.protocol === "torznab" || i.protocol === "newznab" || i.protocol === "rss"));
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
  const { groups, unmatched } = await matchReleases(releases, wanted);
  // What was decided about each release, kept for the list of recent releases (never lets the sync fail).
  const decisions = new Map<SearchResult, RssDecisionInput>();
  const note = (input: RssDecisionInput) => decisions.set(input.release, strongerDecision(decisions.get(input.release), input));
  for (const u of unmatched.slice(0, RSS_UNMATCHED_PER_RUN)) note({ release: u.release, outcome: "unmatched", reason: u.reason, mediaItemId: u.mediaItemId ?? null });
  const saveDecisions = async () => {
    try {
      await recordRssDecisions([...decisions.values()]);
    } catch (err) {
      log.warn("[rss] couldn't keep the decisions about the new releases:", (err as Error).message);
    }
  };
  if (groups.size === 0) {
    await saveDecisions();
    await keepMarkers();
    return summary;
  }

  // 3. for each target, the best of its releases, grabbed
  const env = await buildDecideEnv(indexers, clients, upgrades);
  let complete = true;
  for (const group of groups.values()) {
    if (signal?.aborted || clients.every((c) => env.unavailable.has(c.id))) {
      complete = false;
      break;
    }
    try {
      const decided = await decide(group, env);
      for (const input of decisionsFor(group, decided)) note(input);
      const result = decided.result;
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
  await saveDecisions();
  // A client that went down during the run turned its releases away: they are judged again next time.
  if (complete && env.unavailable.size === 0) await keepMarkers();
  if (summary.grabbed > 0 || summary.woken > 0) {
    log.info(`[rss] ${releases.length} new release(s): ${summary.grabbed} grabbed, ${summary.woken} left to the next search`);
  }
  return summary;
}

/** A release that names nothing the library wants, and why. */
interface Unmatched {
  release: SearchResult;
  reason: string;
  /** The item the release names when that is known (a pack of a season nothing is wanted of). */
  mediaItemId?: number;
}

/** Maps each release to the single item, episode or season it names among what is wanted. */
async function matchReleases(releases: SearchResult[], wanted: Wanted): Promise<{ groups: Map<string, Group>; unmatched: Unmatched[] }> {
  const groups = new Map<string, Group>();
  const placed = new Set<SearchResult>();
  const unmatched: Unmatched[] = [];
  const add = (group: Group) => {
    for (const r of group.releases) placed.add(r);
    const existing = groups.get(group.key);
    if (existing) existing.releases.push(...group.releases);
    else groups.set(group.key, group);
  };
  /** A release that is in no group (yet): said once, whichever way it fell through. */
  const unmatch = (release: SearchResult, reason: string, mediaItemId?: number) => {
    if (!placed.has(release) && !unmatched.some((u) => u.release === release)) unmatched.push({ release, reason, mediaItemId });
  };
  const nameOf = (parsed: ParsedRelease) => `"${parsed.title}"`;
  const aliasesOf = await aliasTitlesByItem([...wanted.singles, ...wanted.shows].map((i) => i.id));
  const sceneIndexes = new Map<number, Awaited<ReturnType<typeof sceneIndexFor>>>();
  const absolutes = new Map<number, number>();

  for (const release of releases) {
    const parsed = parseReleaseTitle(release.title);
    if (parsed.rejected || !parsed.title) {
      unmatch(release, "its name is a hash or has no title to match");
      continue;
    }
    const episodeShaped = parsed.seasonNumber != null || (parsed.episodeNumbers?.length ?? 0) > 0 || parsed.isFullSeason || !!parsed.airDate || parsed.absoluteEpisode != null;

    // A discography names an artist (it holds many of its albums), never a film or an album: the artist whose name it carries, if
    // exactly one, is judged for it. The setting turns discographies off for every way they come in.
    if (isDiscographyRelease(release.title)) {
      if (!discographyGrabsEnabled()) {
        unmatch(release, "discography grabs are switched off (Settings > Media Management)");
        continue;
      }
      // Every monitored artist counts, as it does for an announce: "Pink" complete and a namesake with albums missing are two artists.
      const artists = wanted.artists.filter((item) => releaseNamesArtist(release.title, item.title));
      const entry = artists.length === 1 ? wanted.collections.get(artists[0].id) : undefined;
      if (entry) add({ kind: "discography", key: `discography:${entry.item.id}`, item: entry.item, releases: [release] });
      else if (artists.length === 1) unmatch(release, `"${artists[0].title}" has no missing album`, artists[0].id);
      else unmatch(release, artists.length > 1 ? `${nameOf(parsed)} could be more than one artist` : `no monitored artist is named ${nameOf(parsed)}`);
      continue;
    }

    // An album, book or comic issue that the name could be: the parent is named in the release and the sub-item passes the
    // name tests of a search (chooseBestResult on this one release).
    if (wanted.collections.size > 0 && parsed.seasonNumber == null && !(parsed.episodeNumbers?.length ?? 0) && !parsed.isFullSeason && !parsed.airDate) {
      const hit = await matchCollectionRelease(release, wanted.collections.values());
      if (hit) add({ kind: "sub", key: `sub:${hit.sub.id}`, item: hit.item, sub: hit.sub, releases: [release] });
    }

    if (!episodeShaped) {
      const candidates = wanted.singles.filter((item) => parsed.titleYear != null || parsed.year == null || item.year == null || Math.abs(parsed.year - item.year) <= 1);
      const resolved = await resolveReleaseItemInLibrary({ title: release.title }, parsed, candidates, aliasesOf);
      if (resolved.kind === "one") add({ kind: "single", key: `item:${resolved.item.id}`, item: resolved.item, releases: [release] });
      else unmatch(release, resolved.kind === "ambiguous" ? `${nameOf(parsed)} could be more than one wanted title` : `no wanted title is named ${nameOf(parsed)}`);
      continue;
    }

    const resolved = await resolveReleaseItemInLibrary({ title: release.title }, parsed, wanted.shows, aliasesOf);
    if (resolved.kind !== "one") {
      unmatch(release, resolved.kind === "ambiguous" ? `${nameOf(parsed)} could be more than one show with wanted episodes` : `no show with wanted episodes is named ${nameOf(parsed)}`);
      continue;
    }
    const show = resolved.item;
    const episodes = wanted.episodes.get(show.id) ?? [];
    if (parsed.isFullSeason) {
      if (!packsPossibleFor(show)) {
        unmatch(release, "packs are not taken for this show", show.id);
        continue;
      }
      // A pack, by the season a release calls it: the wanted episodes of that scene season.
      const season = parsed.seasonNumber == null ? null : seasonGroupsOf(episodes).find((g) => g.scene === parsed.seasonNumber);
      if (season) {
        add({ kind: "season", key: `season:${show.id}:${season.aired}:${season.scene}`, item: show, season, episodes: episodes.filter((e) => season.ids.includes(e.id)), releases: [release] });
      } else {
        unmatch(release, parsed.seasonNumber == null ? "a pack that names no season" : `nothing is wanted of season ${parsed.seasonNumber} of "${show.title}"`, show.id);
      }
      continue;
    }
    if (!sceneIndexes.has(show.id)) sceneIndexes.set(show.id, await sceneIndexFor(show.id));
    for (const ep of episodes) {
      if (!(await releaseNamesEpisode(parsed, show, ep, sceneIndexes.get(show.id), absolutes))) continue;
      add({ kind: "episode", key: `episode:${ep.id}`, item: show, ep, releases: [release] });
    }
    unmatch(release, `it names no wanted episode of "${show.title}"`, show.id);
  }
  return { groups, unmatched };
}

/**
 * The album, book or comic issue a release names among these parents (artists, authors, series), each with the sub-items to
 * try in the order to try them: the parent has to be named in the release, and the sub-item has to pass the name tests of a
 * search (chooseBestResult on this one release). One release maps to at most one sub-item. The RSS sync tries the wanted ones,
 * the scan of a folder (pathScan.ts) every one the library has.
 */
export async function matchCollectionRelease(release: SearchResult, collections: Iterable<{ item: MediaItem; subs: any[] }>): Promise<{ item: MediaItem; sub: any } | null> {
  const releaseKey = ` ${identityKey(release.title)} `;
  const released = new Set(releaseKey.split(" ").filter(Boolean));
  for (const { item, subs } of collections) {
    const key = identityKey(item.title);
    if (!key || !releaseKey.includes(` ${key} `)) continue;
    for (const sub of subs) {
      // A cheap cut before the full name test: an album or book is named by (the main part of) its title, so all of
      // those words are in the release; a comic issue or chapter is named by its number and is left to the full test.
      if (["artist", "author", "audiobook"].includes(item.type)) {
        const words = identityKey(editionlessTitle(sub.title).split(/\s*:\s*/)[0].replace(/\([^)]*\)|\[[^\]]*\]/g, " ")).split(" ").filter((w) => w.length > 0);
        if (words.length > 0 && !words.every((w) => released.has(w) || ["a", "an", "the", "of", "and"].includes(w))) continue;
      }
      const name = { title: sub.title, parentTitle: item.title, siblingTitles: await siblingTitlesOf(item, sub.id), ...(await yearFieldsOf(item, sub)) };
      const named = await chooseBestResult([release], [], "", null, 0, null, new Set(), item.type, null, null, item.id, { name });
      if (named) return { item, sub };
    }
  }
  return null;
}

export async function releaseNamesEpisode(
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

async function buildDecideEnv(indexers: Indexer[], clients: DownloadClient[], upgrades: boolean, source: GrabSource = "rss"): Promise<DecideEnv> {
  return {
    source,
    indexers,
    clients,
    delayProfiles: await loadDelayProfiles(),
    directBudget: await directDownloadBudget(clients),
    unavailable: new Map(),
    upgrades,
    grabbedUrls: new Set(),
  };
}

type DecideResult = "grabbed" | "held" | "none" | "skipped" | "unavailable";

/** What decide() learned about a group of releases besides its verdict. */
interface DecideTrace {
  reason: string;
  /** The release that was sent to a client. */
  chosen?: SearchResult;
  /** Why each release was turned away (the reason a search logs for it), by its link. */
  rejections: Map<string, string>;
}

interface Decided {
  result: DecideResult;
  reason: string;
  chosen?: SearchResult;
  rejections: Map<string, string>;
}

/** What is kept about each release of a judged group. */
function decisionsFor(group: Group, decided: Decided): RssDecisionInput[] {
  const base = { mediaItemId: group.item.id, episodeId: group.kind === "episode" ? group.ep.id : null, subItemId: group.kind === "sub" ? group.sub.id : null };
  return group.releases.map((release): RssDecisionInput => {
    if (decided.result === "grabbed" && decided.chosen && release.downloadUrl === decided.chosen.downloadUrl) return { release, outcome: "grabbed", reason: "grabbed", ...base };
    const rejection = decided.rejections.get(release.downloadUrl);
    if (rejection) return { release, outcome: rejection.startsWith("not yet eligible") ? "held" : "rejected", reason: rejection, ...base };
    if (decided.result === "grabbed") return { release, outcome: "rejected", reason: `another release of this target was taken: ${decided.chosen?.title ?? ""}`, ...base };
    const outcome: RssOutcome = decided.result === "held" ? "held" : decided.result === "skipped" || decided.result === "unavailable" ? "skipped" : "rejected";
    return { release, outcome, reason: decided.reason, ...base };
  });
}

const HAS_FILE_NO_UPGRADE = "it already has a file and this release is no upgrade of it (or upgrades are off)";
const UNAVAILABLE_REASON = "no download client could take it just now; it is judged again at the next run";

interface DecideEnv {
  indexers: Indexer[];
  clients: DownloadClient[];
  delayProfiles: { tagId: number | null; profile: DelayProfile }[];
  directBudget: DirectDownloadBudget;
  unavailable: Map<number, string>;
  upgrades: boolean;
  /** Releases sent to a client in this run: one that names several episodes is one download, not one per episode. */
  grabbedUrls: Set<string>;
  /** What the grab is recorded as: the sync's own "rss", or "push" for a release another program handed over. */
  source: GrabSource;
}

/**
 * Judges the releases that name one target as a search of it would, and grabs the best. "unavailable"
 * is a target that could not be served because a download client was down: its releases are judged
 * again by the next run.
 */
async function decide(group: Group, env: DecideEnv): Promise<Decided> {
  const trace: DecideTrace = { reason: "", rejections: new Map() };
  const result = await decideGroup(group, env, trace);
  return { result, reason: trace.reason || "no release of this target could be taken", chosen: trace.chosen, rejections: trace.rejections };
}

async function decideGroup(group: Group, env: DecideEnv, trace: DecideTrace): Promise<DecideResult> {
  const { item } = group;
  const skip = (reason: string): "skipped" => {
    trace.reason = reason;
    return "skipped";
  };
  if (await isRootFolderOverQuota(item.rootFolderId)) return skip("its root folder is over its quota");
  const profile = await getQualityProfile(item.qualityProfileId);
  const cutoff = profile?.cutoff ?? "";

  let episodeId: number | null = null;
  let seasonNumber: number | null = null;
  let subItemName: TargetName | null = null;
  /** For a discography: the artist's albums as it is judged against them. */
  let discographyAlbums: DiscographyAlbum[] | undefined;
  let target = null as Awaited<ReturnType<typeof episodePlanFor>>["target"];
  let pack: ReturnType<typeof packContextFor>;
  let upgradeFromRank: number | null = null;
  let existing: { file: ExistingFile; profile: UpgradeProfile } | undefined;
  let results = group.releases.filter((r) => !env.grabbedUrls.has(r.downloadUrl));
  if (results.length === 0) return skip("already sent to a download client in this run");

  /** A file the target has: replaced only when upgrades are switched on and the profile allows them. At the
   * cutoff (quality and format score) only a later revision of the file's own release can still replace it. */
  const considerUpgrade = async (onDisk: string | null, episode: number | null): Promise<boolean> => {
    if (!env.upgrades) return false;
    const file = await existingFileRecord(item, episode, null);
    const upgradeProfile = upgradeProfileOf(profile);
    if (!file || !upgradeProfile.upgradeAllowed) return false;
    if (meetsCutoff(onDisk, cutoff, rankingOf(profile)) && !formatCutoffNotMet(upgradeProfile, file)) {
      const mode = propersMode();
      if (!results.some((r) => revisionUpgrade(mode, file.releaseTitle, r.title))) return false;
    }
    upgradeFromRank = qualityRank(onDisk);
    existing = { file, profile: upgradeProfile };
    return true;
  };

  if (group.kind === "single") {
    if (await isAlreadyQueued(item.id, null, null)) return skip("already queued");
    const onDisk = await existingFileQuality(item, null, null);
    if (onDisk !== undefined && !(await considerUpgrade(onDisk, null))) return skip(HAS_FILE_NO_UPGRADE);
  } else if (group.kind === "sub") {
    // A missing album, book or issue: a search's name tests judge it, and nothing is on disk to upgrade.
    if (await isAlreadyQueued(item.id, null, group.sub.id)) return skip("already queued");
    subItemName = { title: group.sub.title, parentTitle: item.title, siblingTitles: await siblingTitlesOf(item, group.sub.id), ...(await yearFieldsOf(item, group.sub)) };
  } else if (group.kind === "discography") {
    // The same terms as a search for one (two or more missing albums, a quarter of the albums it covers, none unreleased), against
    // the albums nothing is downloading yet: a discography already queued for them is not taken again.
    const judging = await discographyJudgingAlbums(item.id);
    if (judging.wantedCount === 0 && judging.queuedCount > 0) return skip("a download already covers every album it would add");
    discographyAlbums = judging.albums;
  } else if (group.kind === "episode") {
    episodeId = group.ep.id;
    if (await isAlreadyQueued(item.id, group.ep.id, null)) return skip("already queued");
    const onDisk = await existingFileQuality(item, group.ep.id, null);
    if (onDisk !== undefined && !(await considerUpgrade(onDisk, group.ep.id))) return skip(HAS_FILE_NO_UPGRADE);
    const plan = await episodePlanFor(item, group.ep);
    target = plan.target;
    pack = packContextFor(item, plan);
  } else {
    seasonNumber = group.season.aired;
    let uncovered = false;
    for (const e of group.episodes) if (!(await isAlreadyQueued(item.id, e.id, null))) uncovered = true;
    if (!uncovered) return skip("every episode of the season is already queued");
    // Whether a pack upgrades the files the season has is for the pack guards to say, by the upgrade rules (a PROPER or
    // REPACK of the files' own release counts at the same quality), as in a search; no minimum-rank gate applies to it.
    pack = packContextFor(item, await seasonPlanFor(item, group.season.scene));
    results = results.filter((r) => {
      const parsed = parseReleaseTitle(r.title);
      return parsed.isFullSeason && (parsed.seasonNumber == null || parsed.seasonNumber === group.season.scene);
    });
  }

  const blocklisted = await getBlocklistedTitles(item.id);
  const itemTags = await tagIdsForMediaItem(item.id);
  const delayProfile = pickDelayProfile(env.delayProfiles, itemTags);
  // An indexer scoped to tags is for titles that carry one of them, as in a search.
  results = results.filter((r) => scopeAllows(env.indexers.find((i) => i.id === r.indexerId)?.tagIds, itemTags));
  if (results.length === 0) {
    trace.reason = "its indexer is limited to tags this title does not carry";
    return "none";
  }
  const usable = env.directBudget.usableClients().filter((c) => !env.unavailable.has(c.id));
  // Every client that could take these releases is waiting out a back-off: nothing was judged, so the feed is not marked as
  // read past them (they are looked at again once a client is back).
  const takesAny = (ignoreBackoff: boolean) => results.some((r) => pickClientForProtocol(usable, r.protocol, { itemTags, ignoreBackoff }) !== null);
  if (!takesAny(false) && takesAny(true)) {
    trace.reason = UNAVAILABLE_REASON;
    return "unavailable";
  }
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
      {
        clients: usable,
        upgradeFromRank,
        existing,
        name: subItemName ?? { title: item.title },
        indexers: env.indexers,
        label: item.title,
        pack,
        // A season pack is judged by the pack guards, which count what it upgrades by the upgrade rules.
        packJudgesUpgrades: group.kind === "season",
        ...(discographyAlbums ? { discography: { albums: discographyAlbums, ...AUTOMATIC_DISCOGRAPHY_JUDGE } } : {}),
        onRejected: (r, reason) => {
          if (!trace.rejections.has(r.downloadUrl)) trace.rejections.set(r.downloadUrl, reason);
        },
      }
    );
  let outcome: Awaited<ReturnType<typeof grabBestRelease>>;
  try {
    outcome = await grabBestRelease(
      results,
      usable,
      (remaining) => choose(remaining, delayProfile),
      (client, chosen) =>
        discographyAlbums
          ? grabDiscography(client, item, chosen, discographyAlbums, AUTOMATIC_DISCOGRAPHY_JUDGE, env.source)
          : grab(client, item, episodeId, group.kind === "sub" ? group.sub.id : null, chosen, 0, seasonNumber, env.source),
      { itemId: item.id, indexers: env.indexers }
    );
  } catch (err) {
    if (noteUnavailableClient(err, env.unavailable)) {
      trace.reason = UNAVAILABLE_REASON;
      return "unavailable";
    }
    throw err;
  }
  if (!outcome) {
    // Held back by the delay profile alone: the same releases, with no delay, would have been grabbed.
    const leaf =
      group.kind === "episode"
        ? ({ table: "episodes", id: group.ep.id } as const)
        : group.kind === "sub"
        ? ({ table: "sub_items", id: group.sub.id } as const)
        : group.kind === "single" || group.kind === "discography"
        ? // A discography is kept against its artist: the pending store holds one leaf per release, and pendingReleases.ts judges a
          // release of an artist that is a discography as one, against the albums wanted when its delay has ended.
          ({ table: "media_items", id: item.id } as const)
        : null;
    const held = await isHeldByDelay(results, cutoff, delayProfile, choose, leaf ? (release) => recordPending(leaf.table, leaf.id, item.id, release) : undefined);
    trace.reason = held ? "held back by the delay profile until it is old enough" : "none of its releases passed the profile";
    return held ? "held" : "none";
  }
  if (!outcome.grabbed) return skip("a download client already has it");
  trace.chosen = outcome.chosen.result;
  env.grabbedUrls.add(outcome.chosen.result.downloadUrl);
  env.directBudget.consume(outcome.client);
  if (group.kind === "season") await recordSeasonSearch(item.id, group.season.scene, true);
  else if (group.kind === "discography") await recordSeasonSearch(item.id, DISCOGRAPHY_SEARCH_KEY, true);
  else if (group.kind === "sub") await recordLeafOutcome("sub_items", group.sub.id, true);
  else await recordLeafOutcome(group.kind === "episode" ? "episodes" : "media_items", group.kind === "episode" ? group.ep.id : item.id, true);
  return "grabbed";
}

/** A target a release was listed for that could not be grabbed yet is searched at the next cycle. */
async function wake(group: Group): Promise<void> {
  if (group.kind === "single") await wakeLeaf("media_items", group.item.id);
  else if (group.kind === "episode") await wakeLeaf("episodes", group.ep.id);
  else if (group.kind === "sub") await wakeLeaf("sub_items", group.sub.id);
  else if (group.kind === "discography") await wakeSeason(group.item.id, DISCOGRAPHY_SEARCH_KEY);
  else await wakeSeason(group.item.id, group.season.scene);
}

export interface MappedJudgement {
  outcome: RssOutcome;
  reason: string;
  mediaItemId: number;
  episodeId: number | null;
  subItemId: number | null;
}

/**
 * Judges one release again for the title the admin says it names (the "map to" step of the recent-releases list, after the
 * release's name was taught to the title as an alias): the same decision as in a sync, grabbed when it passes. With an
 * episode or a sub-item the release is held to that target whatever its numbering says; its quality, name and the rest are
 * still judged, so a release the profile refuses stays refused, with the reason.
 */
export async function judgeMappedRelease(release: SearchResult, target: { mediaItemId: number; episodeId?: number | null; subItemId?: number | null }): Promise<MappedJudgement> {
  const base = { mediaItemId: target.mediaItemId, episodeId: target.episodeId ?? null, subItemId: target.subItemId ?? null };
  const clients = await rowsToDownloadClients();
  if (clients.length === 0) return { outcome: "skipped", reason: "no enabled download client is configured", ...base };
  const upgrades = getSetting("autoUpgradeEnabled") === "1";
  const wanted = await loadWanted(upgrades);

  let groups: Group[] = [];
  if (target.episodeId != null) {
    const show = wanted.shows.find((s) => s.id === target.mediaItemId);
    const ep = (wanted.episodes.get(target.mediaItemId) ?? []).find((e) => e.id === target.episodeId);
    if (show && ep) groups = [{ kind: "episode", key: `episode:${ep.id}`, item: show, ep, releases: [release] }];
  } else if (target.subItemId != null) {
    const entry = wanted.collections.get(target.mediaItemId);
    const sub = entry?.subs.find((s) => s.id === target.subItemId);
    if (entry && sub) groups = [{ kind: "sub", key: `sub:${sub.id}`, item: entry.item, sub, releases: [release] }];
  } else {
    groups = [...(await matchReleases([release], wanted)).groups.values()].filter((g) => g.item.id === target.mediaItemId);
  }
  if (groups.length === 0) {
    return { outcome: "unmatched", reason: "still not matched to anything that is wanted of that title (it may be unmonitored, have its files already, or name another episode)", ...base };
  }

  const env = await buildDecideEnv(await rowsToIndexers(), clients, upgrades);
  const { best } = await decideGroups(groups, env);
  return { outcome: best!.outcome, reason: best!.reason ?? "", mediaItemId: target.mediaItemId, episodeId: best!.episodeId ?? null, subItemId: best!.subItemId ?? null };
}

/** Decides each group as a sync does (a held one wakes its target), and keeps what was decided about every release and the strongest of it. */
async function decideGroups(groups: Group[], env: DecideEnv): Promise<{ best: RssDecisionInput | undefined; inputs: RssDecisionInput[] }> {
  let best: RssDecisionInput | undefined;
  const inputs: RssDecisionInput[] = [];
  for (const group of groups) {
    const decided = await decide(group, env);
    if (decided.result === "held") await wake(group);
    for (const input of decisionsFor(group, decided)) {
      inputs.push(input);
      best = strongerDecision(best, input);
    }
  }
  return { best, inputs };
}

/** What judgeOneRelease says about one release. */
export interface OneReleaseJudgement {
  outcome: RssOutcome;
  /** Why it was not taken (one line each); empty for a release that was grabbed. */
  reasons: string[];
  /** Not refused for good: a delay profile holds it, or no download client could take it just now. */
  temporary: boolean;
  mediaItemId: number | null;
  episodeId: number | null;
  subItemId: number | null;
  /** The quality the release's name states. */
  quality: string | null;
}

/** Releases handed over one at a time are judged one at a time: the library's wanted list and the clients' budget are read for each. */
let judging: Promise<unknown> = Promise.resolve();

/**
 * Judges ONE release the way the RSS sync judges a feed's: which wanted title, episode, season or album it names
 * (matchReleases), then the rules of a search for that target (decide: identity, rejections, quality, formats, blocklist,
 * delay profile, pack guards, upgrade rules), and the grab when it passes. This is what `POST /release/push` runs for a
 * release a program such as autobrr hands over. A release the delay profile holds is kept as pending (the search of the target
 * takes it once it is old enough); one that names nothing wanted is answered "unmatched" and nothing is stored or grabbed.
 * `types` limits the titles it may name (a Radarr mount takes movies only). Calls queue up and run one at a time.
 */
export function judgeOneRelease(release: SearchResult, options: JudgeOneOptions = {}): Promise<OneReleaseJudgement> {
  const run = judging.then(
    () => judgeOneNow(release, options),
    () => judgeOneNow(release, options)
  );
  judging = run.catch(() => undefined);
  return run;
}

export interface JudgeOneOptions {
  source?: GrabSource;
  types?: string[];
  /** False judges the release against the whole wanted library instead of the titles it can name (the reference the narrowing is tested against). */
  narrow?: boolean;
}

/** More items than this share a word with the release: it is not narrowed, the whole library is read as before. */
const MAX_NARROWED_ITEMS = 500;

/**
 * The monitored items a release could name: the ones with a name (title or alias) that shares a word with it, which is the first
 * cut the matching makes (couldNameItem), and the artists, authors and the like whose whole title is in its name. Reading these
 * names is a lighter read than the wanted library (no episodes, no item rows), and a release for a title the library does not
 * hold, the commonest push, is then answered without reading that. An empty set: nothing can be named. Null: the release cannot
 * be narrowed this way (the sender gave an id, which names an item whatever its title says; or very many items share a word).
 */
async function itemsReleaseCouldName(release: SearchResult, types: string[] | undefined): Promise<Set<number> | null> {
  const parsed = parseReleaseTitle(release.title);
  // matchReleases turns these away before it reads the library.
  if (parsed.rejected || !parsed.title) return new Set();
  const ids = release as { imdbId?: string | null; tmdbId?: string | null; tvdbId?: string | null };
  if (ids.imdbId || ids.tmdbId || ids.tvdbId || parsed.imdbId) return null;
  if (types && types.length === 0) return new Set();

  const typeSql = (column: string) => (types ? ` AND ${column} IN (${types.map(() => "?").join(",")})` : "");
  const items = (await db.prepare(`SELECT id, type, title FROM media_items WHERE monitored = 1${typeSql("type")}`).all(...(types ?? []))) as { id: number; type: string; title: string }[];
  const aliasRows = (await db
    .prepare(`SELECT t.media_item_id AS id, t.title AS title FROM media_item_titles t JOIN media_items m ON m.id = t.media_item_id WHERE m.monitored = 1 AND t.source <> 'primary'${typeSql("m.type")}`)
    .all(...(types ?? []))) as { id: number; title: string }[];
  const aliases = new Map<number, string[]>();
  for (const row of aliasRows) {
    const list = aliases.get(row.id);
    if (list) list.push(row.title);
    else aliases.set(row.id, [row.title]);
  }

  const tokens = releaseNameTokens(parsed);
  const releaseKey = ` ${identityKey(release.title)} `;
  const discography = isDiscographyRelease(release.title);
  const near = new Set<number>();
  for (const item of items) {
    if (usesQualityTiers(item.type)) {
      if (couldNameItem(tokens, item.title, aliases.get(item.id) ?? [])) near.add(item.id);
    } else {
      // An artist, author or series is named when the whole of its title is in the name of the release (matchCollectionRelease).
      const key = identityKey(item.title);
      // A discography spells its artist as matchReleases reads it ("P!nk" as "Pink"), which is looser than the title test.
      if ((key && releaseKey.includes(` ${key} `)) || (discography && item.type === "artist" && releaseNamesArtist(release.title, item.title))) near.add(item.id);
    }
    if (near.size > MAX_NARROWED_ITEMS) return null;
  }
  return near;
}

async function judgeOneNow(release: SearchResult, options: JudgeOneOptions): Promise<OneReleaseJudgement> {
  const none = { mediaItemId: null, episodeId: null, subItemId: null, quality: parseReleaseTitle(release.title).quality ?? null };
  const clients = await rowsToDownloadClients();
  if (clients.length === 0) return { outcome: "skipped", reasons: ["no enabled download client is configured"], temporary: true, ...none };
  const upgrades = getSetting("autoUpgradeEnabled") === "1";
  // Only the titles this release can name are read; one that can name none is answered as the whole library would answer it.
  const near = options.narrow === false ? null : await itemsReleaseCouldName(release, options.types);
  const wanted = near && near.size === 0 ? emptyWanted() : await loadWanted(upgrades, near ?? undefined);
  if (options.types) restrictWanted(wanted, new Set(options.types));
  const { groups, unmatched } = await matchReleases([release], wanted);
  if (groups.size === 0) {
    return { outcome: "unmatched", reasons: [unmatched[0]?.reason ?? "it names nothing the library wants"], temporary: false, ...none, mediaItemId: unmatched[0]?.mediaItemId ?? null };
  }

  const env = await buildDecideEnv(await rowsToIndexers(), clients, upgrades, options.source ?? "rss");
  let decided: Awaited<ReturnType<typeof decideGroups>>;
  try {
    decided = await decideGroups([...groups.values()], env);
  } catch (err) {
    // The download client turned the release away (a link it cannot read, a torrent it will not take): the push says so.
    const target = [...groups.values()][0];
    // The client's message can quote the link it was given, which may carry a key.
    const said = redactLinks((err as Error).message);
    const reason = err instanceof ReleaseRefusedError ? `the download client refused it: ${said}` : `it could not be sent to a download client: ${said}`;
    log.warn(`[push] couldn't process "${release.title}":`, said);
    return { outcome: "skipped", reasons: [reason], temporary: !(err instanceof ReleaseRefusedError), ...none, mediaItemId: target.item.id };
  }
  const best = decided.best!;
  // What was decided about the release is kept for the list of recent releases, as a sync's decisions are (never fails the push).
  try {
    await recordRssDecisions(decided.inputs);
  } catch (err) {
    log.warn("[push] couldn't keep the decision about the pushed release:", (err as Error).message);
  }
  const reasons = best.outcome === "grabbed" ? [] : [...new Set(decided.inputs.filter((i) => i.outcome !== "grabbed" && i.reason).map((i) => i.reason as string))];
  if (best.outcome !== "grabbed" && reasons.length === 0) reasons.push(best.reason ?? "no release of this target could be taken");
  return {
    outcome: best.outcome,
    reasons,
    temporary: best.outcome === "held" || best.reason === UNAVAILABLE_REASON,
    mediaItemId: best.mediaItemId ?? null,
    episodeId: best.episodeId ?? null,
    subItemId: best.subItemId ?? null,
    quality: none.quality,
  };
}

/** Leaves in `wanted` only the titles of these media types. */
function restrictWanted(wanted: Wanted, types: Set<string>): void {
  wanted.singles = wanted.singles.filter((i) => types.has(i.type));
  wanted.shows = wanted.shows.filter((i) => types.has(i.type));
  for (const id of [...wanted.episodes.keys()]) if (!wanted.shows.some((s) => s.id === id)) wanted.episodes.delete(id);
  for (const [id, entry] of [...wanted.collections]) if (!types.has(entry.item.type)) wanted.collections.delete(id);
  wanted.artists = wanted.artists.filter((i) => types.has(i.type));
  wanted.types = new Set([...wanted.types].filter((t) => types.has(t)));
}
