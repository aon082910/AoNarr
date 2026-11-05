import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getMediaTypeConfig, MEDIA_TYPES } from "./mediaTypes.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode, type ParsedRelease } from "./releaseParser.js";
import { judgeSeasonPack, loadPackEpisodes, packSettings, type PackEpisode } from "./seasonPacks.js";
import { releaseRejection } from "./releaseRejections.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import { guessTitleFromText, titlesMatch } from "./libraryScan.js";
import { scoreRelease } from "./customFormatScoring.js";
import { getBlocklistedTitles } from "./blocklist.js";
import { downloadClientFromRow, mediaItemFromRow, qualityProfileFromRow } from "../db/mappers.js";
import {
  AUTOMATIC_DISCOGRAPHY_JUDGE,
  DISCOGRAPHY_SEARCH_KEY,
  chooseBestResult,
  discographyJudgingAlbums,
  existingFileQuality,
  grab,
  grabDiscography,
  isAlreadyQueued,
  isNotYetReleased,
  isReleaseAvailableForSearch,
  pickClientForProtocol,
  siblingTitlesOf,
  yearFieldsOf,
  type ChosenResult,
} from "./scheduler.js";
import { couldNameItem, identityKey, releaseNameTokens } from "./releaseIdentity.js";
import { editionlessTitle } from "./nonVideoMatch.js";
import { existingFileRecord } from "./fileRelease.js";
import { judgeUpgrade, propersMode, upgradeProfileOf } from "./upgradeRules.js";
import { getSetting } from "./settingsStore.js";
import { computeAbsoluteEpisodeNumber } from "./importer.js";
import { GLOBAL_RANKING, rankingFromRow, rankingOf, sameQualityGroup, usesQualityTiers, type ProfileRanking } from "./quality.js";
import { aliasSeasonsFor, aliasTitlesByItem, applyAliasSeason, resolveReleaseItemInLibrary, seasonEpisodeCounts } from "./releaseAliases.js";
import { isRootFolderOverQuota } from "./rootFolderSelect.js";
import { wakeLeaf, wakeSeason } from "./searchBackoff.js";
import { discographyGrabsEnabled, isDiscographyRelease, releaseNamesArtist, type DiscographyAlbum } from "./discography.js";
import type { DownloadClient, SearchResult } from "../types/index.js";

export interface IrcFeedRow {
  id: number;
  name: string;
  announce_regex: string;
  protocol: "torrent" | "usenet";
}

import { tagIdsOfItem } from "./tagScope.js";

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
  if (parsed.rejected || (!parsed.title && !baseTitle)) return;

  const clients = await rowsToDownloadClients();
  if (clients.length === 0) return;
  const targetClient = pickClientForProtocol(clients, feed.protocol);
  if (!targetClient) return;

  // A discography is a release for many albums of an artist, never a film or an episode: it is judged on its own.
  if (isDiscographyRelease(releaseTitle)) {
    await grabDiscographyAnnounce(feed, releaseTitle, downloadUrl, parsed.quality, targetClient);
    return;
  }

  // An announce is unsolicited: which item it names is decided library-wide, with aliases, and two
  // items both claiming it is a reason to grab nothing (Sonarr's MultipleSeriesFoundException).
  // With auto-upgrade on (the switch the RSS sync and the upgrade job share) an item that has its file is a candidate too:
  // tryGrabMatch grabs the release only when it would replace the file by the profile's upgrade rules.
  const upgradesOn = getSetting("autoUpgradeEnabled") === "1";
  const singleItems = ((await db.prepare(`SELECT * FROM media_items WHERE monitored = 1${upgradesOn ? "" : " AND has_file = 0"}`).all()) as any[])
    .map(mediaItemFromRow)
    .filter((item) => getMediaTypeConfig(item.type).shape === "single")
    // A film not out yet by its minimum availability is not grabbed from an announce either (a leak or a
    // fake): the scheduled search holds it back the same way.
    .filter((item) => isReleaseAvailableForSearch(item));
  // The gate only checks a year written before the quality words ("Dune.2021.1080p"). A year after
  // them ("Dune.1080p.BluRay.x264.2021-GRP") is not seen as a title year, so the old guard on the
  // first year anywhere in the name still applies to those.
  // A release shaped like an episode ("Dune.S01E01...", a season pack) names no movie; it goes to
  // the episodic path below however much its title looks like a wanted film's.
  const episodeShaped = parsed.seasonNumber != null || (parsed.episodeNumbers?.length ?? 0) > 0 || parsed.isFullSeason;
  const tieredSingles = singleItems
    .filter((item) => !episodeShaped && usesQualityTiers(item.type))
    .filter((item) => parsed.titleYear != null || parsed.year == null || item.year == null || Math.abs(parsed.year - item.year) <= 1);
  const resolvedSingle = await resolveReleaseItemInLibrary({ title: releaseTitle }, parsed, tieredSingles, await aliasTitlesByItem(tieredSingles.map((i) => i.id)));
  if (resolvedSingle.kind === "ambiguous") {
    log.info(`[irc:${feed.name}] "${releaseTitle}" names ${resolvedSingle.items.length} items (${resolvedSingle.items.map((i) => `"${i.title}"`).join(", ")}); not grabbing`);
    return;
  }
  const singleCandidates = resolvedSingle.kind === "one" ? [resolvedSingle.item] : [];
  // Types with no quality tiers (ROMs...) have no release-title grammar to parse; they keep the
  // scan-style title and year comparison.
  for (const item of singleItems) {
    if (usesQualityTiers(item.type) || !baseTitle || !titlesMatch(baseTitle, item.title)) continue;
    if (parsed.year != null && item.year != null && Math.abs(parsed.year - item.year) > 1) continue;
    singleCandidates.push(item);
  }
  // An announce carries no size, so the sample rule has nothing to judge here; the others apply as
  // they do to a search result (multi-season and partial packs, disc images, hard-coded subtitles).
  const refusal = (type: string) => {
    const rejection = releaseRejection(parsed, { title: releaseTitle }, type);
    if (rejection) log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}": ${rejection.reason}`);
    return rejection;
  };
  for (const item of singleCandidates) {
    if (refusal(item.type)) continue;
    const grabbed = await serializeForTarget(`item:${item.id}`, async () => {
      if (await isAlreadyQueued(item.id, null, null)) return false;
      return tryGrabMatch(item, null, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
    });
    if (grabbed) return; // one announce maps to at most one grab
  }

  // An album, book, audiobook, comic issue or manga chapter: the wanted sub-items of the library that the name could be
  // (N29). The scheduled search's own name test says which one it is.
  if (!episodeShaped && (await grabSubItemAnnounce(feed, releaseTitle, downloadUrl, parsed.quality, targetClient))) return;

  // An episode announce is numbered SxxEyy, by absolute number ("[Group] Show - 25"), by air date, or is a
  // pack of a season: all of them are mapped to the episodes they hold, as the RSS sync does.
  const numbered =
    (parsed.seasonNumber !== null && !!parsed.episodeNumbers?.length) ||
    (parsed.isFullSeason && parsed.seasonNumber !== null) ||
    parsed.absoluteEpisode != null ||
    !!parsed.absoluteRange ||
    !!parsed.airDate;
  if (!numbered) return;
  // Only the shows whose name (or an alias) has all its words in the release are read for episodes: the library holds
  // thousands of them, and every announce would otherwise load them all.
  const candidateShows = await showsNamedIn(parsed);
  if (candidateShows.length === 0) return;
  const episodes = (await db
    .prepare(
      `SELECT e.*, m.id AS parent_id, m.type AS parent_type, m.title AS parent_title, m.year AS parent_year, m.external_ids AS parent_external_ids,
              m.quality_profile_id AS parent_quality_profile_id, m.root_folder_id AS parent_root_folder_id, m.extra_metadata AS parent_extra_metadata
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.monitored = 1${upgradesOn ? "" : " AND e.has_file = 0"} AND m.monitored = 1 AND m.id IN (${candidateShows.map(() => "?").join(",")})`
    )
    .all(...candidateShows)) as any[];
  const parentOf = (ep: any) =>
    mediaItemFromRow({
      id: ep.parent_id,
      type: ep.parent_type,
      title: ep.parent_title,
      year: ep.parent_year,
      external_ids: ep.parent_external_ids,
      quality_profile_id: ep.parent_quality_profile_id,
      root_folder_id: ep.parent_root_folder_id,
      extra_metadata: ep.parent_extra_metadata,
    });
  const shows = new Map<number, ReturnType<typeof mediaItemFromRow>>();
  for (const ep of episodes) if (!shows.has(ep.parent_id)) shows.set(ep.parent_id, parentOf(ep));
  const showItems = Array.from(shows.values());
  const resolvedShow = await resolveReleaseItemInLibrary({ title: releaseTitle }, parsed, showItems, await aliasTitlesByItem(showItems.map((i) => i.id)));
  if (resolvedShow.kind === "ambiguous") {
    log.info(`[irc:${feed.name}] "${releaseTitle}" names ${resolvedShow.items.length} shows (${resolvedShow.items.map((i) => `"${i.title}"`).join(", ")}); not grabbing`);
    return;
  }
  if (resolvedShow.kind !== "one") return;
  const show = resolvedShow.item;
  if (refusal(show.type)) return;
  const sceneIndex = await sceneIndexFor(show.id);
  // A release counted from 1 under a season's own name (TheXEM) is that season's episode, as in the search.
  const seasonParsed = applyAliasSeason(parsed, await aliasSeasonsFor(show.id), await seasonEpisodeCounts(show.id));
  const wantsAbsolute = parsed.absoluteEpisode != null || !!parsed.absoluteRange;
  // A season pack must pass the same guards as a pack found by a search (aired, monitored, enough wanted).
  let packEpisodes: PackEpisode[] | null = null;
  const packSettingsNow = packSettings();
  const profileRow = show.qualityProfileId ? await db.prepare("SELECT cutoff, quality_groups, quality_order FROM quality_profiles WHERE id = ?").get(show.qualityProfileId) : null;
  const packCutoff = (profileRow as { cutoff?: string } | null)?.cutoff ?? "";
  const packRanking = rankingFromRow(profileRow as { quality_groups?: string | null; quality_order?: string | null } | null);
  for (const ep of episodes) {
    if (ep.parent_id !== show.id) continue;
    const absoluteEpisode = show.type === "anime" || wantsAbsolute ? await computeAbsoluteEpisodeNumber(show.id, ep.season_number, ep.episode_number) : null;
    const byDate = !!parsed.airDate && !!ep.air_date && releaseMatchesAirDate(parsed, ep.air_date);
    if (!byDate && !releaseMatchesEpisode(seasonParsed, ep.season_number, ep.episode_number, ep.scene_season_number, ep.scene_episode_number, absoluteEpisode, sceneIndex)) continue;
    if (parsed.isFullSeason) {
      packEpisodes ??= await loadPackEpisodes(show.id);
      const verdict = judgeSeasonPack({
        parsed,
        season: parsed.seasonNumber ?? ep.season_number,
        episodes: packEpisodes,
        item: show,
        packQuality: parsed.quality,
        cutoff: packCutoff,
        ranking: packRanking,
        settings: packSettingsNow,
      });
      if (!verdict.ok) {
        log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}": ${verdict.reason}`);
        return;
      }
    }
    const grabbed = await serializeForTarget(`episode:${ep.id}`, async () => {
      if (await isAlreadyQueued(show.id, ep.id, null)) return false;
      return tryGrabMatch(show, ep.id, null, releaseTitle, downloadUrl, parsed.quality, feed, targetClient);
    });
    if (grabbed) return;
  }
}



/** The ids of the monitored shows (episodic items) that the release could name (releaseIdentity.couldNameItem): a superset
 * of what library-wide resolution then picks from. */
async function showsNamedIn(parsed: ParsedRelease): Promise<number[]> {
  const released = releaseNameTokens(parsed);
  const shows = ((await db.prepare("SELECT id, type, title FROM media_items WHERE monitored = 1").all()) as { id: number; type: string; title: string }[]).filter(
    (m) => getMediaTypeConfig(m.type).shape === "episodic"
  );
  if (shows.length === 0) return [];
  const aliases = await aliasTitlesByItem(shows.map((m) => m.id));
  // The library matcher's own first cut: some name of the show shares a word with the release (run-together forms such as
  // "S.W.A.T." -> "swat" included), so nothing the matcher would name is left out.
  return shows.filter((m) => couldNameItem(released, m.title, aliases.get(m.id) ?? [])).map((m) => m.id);
}

/** Types an announce can name a sub-item of: collections with no quality tiers that are searched on indexers. */
function announceCollectionTypes(): string[] {
  return Object.values(MEDIA_TYPES)
    .filter((t) => t.shape === "collection" && !usesQualityTiers(t.key) && t.key !== "video" && t.key !== "podcast")
    .map((t) => t.key);
}

/**
 * Whether the announce names a wanted album, book, comic issue or manga chapter, and if so grabs it. The parent (artist,
 * author, series) has to be named in the release, a cheap test that keeps most of the library out; then each of its
 * missing monitored sub-items is asked the way a search asks it, by chooseBestResult's name test on this one release.
 */
async function grabSubItemAnnounce(feed: IrcFeedRow, releaseTitle: string, downloadUrl: string, quality: string, targetClient: DownloadClient): Promise<boolean> {
  const types = announceCollectionTypes();
  if (types.length === 0) return false;
  const releaseKey = ` ${identityKey(releaseTitle)} `;
  const parents = ((await db.prepare(`SELECT * FROM media_items WHERE monitored = 1 AND type IN (${types.map(() => "?").join(",")})`).all(...types)) as any[])
    .map(mediaItemFromRow)
    .filter((item) => {
      const key = identityKey(item.title);
      return key.length > 0 && releaseKey.includes(` ${key} `);
    });
  const result: SearchResult = {
    indexerId: null,
    indexerName: `irc:${feed.name}`,
    title: releaseTitle,
    size: 0,
    seeders: null,
    leechers: null,
    publishDate: null, // the announce's own time is not the post's date; blocklist entries match on size and title instead
    downloadUrl,
    protocol: feed.protocol,
    category: null,
  };
  for (const parent of parents) {
    const subItems = ((await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND monitored = 1 AND has_file = 0 ORDER BY id").all(parent.id)) as any[]).sort(
      // "Rumours" before "Rumours: Deluxe Edition": a release of the plain album names both once the edition is stripped.
      (a, b) => Number(editionlessTitle(a.title) !== a.title) - Number(editionlessTitle(b.title) !== b.title)
    );
    for (const sub of subItems) {
      // An album or book not out yet is not grabbed from an announce either.
      if (["artist", "author", "audiobook"].includes(parent.type) && isNotYetReleased(sub.release_date)) continue;
      const name = {
        title: sub.title,
        parentTitle: parent.title,
        siblingTitles: await siblingTitlesOf(parent, sub.id),
        ...(await yearFieldsOf(parent, sub)),
      };
      const named = await chooseBestResult([result], [], "", null, 0, null, new Set(), parent.type, null, null, parent.id, { name });
      if (!named) continue;
      const grabbed = await serializeForTarget(`sub:${sub.id}`, async () => {
        if (await isAlreadyQueued(parent.id, null, sub.id)) return false;
        return tryGrabMatch(parent, null, sub.id, releaseTitle, downloadUrl, quality, feed, targetClient);
      });
      if (grabbed) return true; // one announce maps to at most one grab
    }
  }
  return false;
}

/**
 * A discography announced for an artist (Lidarr's DiscographySpecification): the one monitored artist whose name the release
 * carries is judged for it as a search for a discography judges one (two or more albums missing and a quarter of the albums
 * it covers, none of them unreleased, a release that names another artist turned away), against the albums nothing is
 * downloading yet, and grabbed for those albums. The same switch as the search turns it off.
 */
async function grabDiscographyAnnounce(feed: IrcFeedRow, releaseTitle: string, downloadUrl: string, quality: string, targetClient: DownloadClient): Promise<boolean> {
  if (!discographyGrabsEnabled()) {
    log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}": discography grabs are switched off`);
    return false;
  }
  const artists = ((await db.prepare("SELECT * FROM media_items WHERE monitored = 1 AND type = 'artist'").all()) as any[])
    .map(mediaItemFromRow)
    .filter((item) => releaseNamesArtist(releaseTitle, item.title));
  if (artists.length > 1) {
    log.info(`[irc:${feed.name}] "${releaseTitle}" names ${artists.length} artists (${artists.map((a) => `"${a.title}"`).join(", ")}); not grabbing`);
    return false;
  }
  const artist = artists[0];
  if (!artist) return false;
  const result: SearchResult = {
    indexerId: null,
    indexerName: `irc:${feed.name}`,
    title: releaseTitle,
    size: 0,
    seeders: null,
    leechers: null,
    publishDate: null, // the announce's own time is not the post's date; blocklist entries match on size and title instead
    downloadUrl,
    protocol: feed.protocol,
    category: null,
  };
  return serializeForTarget(`discography:${artist.id}`, async () => {
    const { albums, wantedCount, queuedCount } = await discographyJudgingAlbums(artist.id);
    if (wantedCount === 0) {
      if (queuedCount > 0) log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}" for "${artist.title}": a download already covers every album it would add`);
      return false;
    }
    // The search's own tests of a discography judge it: the artist it names, the years it spans, the albums it would add (each
    // turned-away release is logged with its reason there).
    const named = await chooseBestResult([result], [], "", null, 0, null, new Set(), artist.type, null, null, artist.id, {
      name: { title: artist.title },
      discography: { albums, ...AUTOMATIC_DISCOGRAPHY_JUDGE },
    });
    if (!named) return false;
    return tryGrabMatch(artist, null, null, releaseTitle, downloadUrl, quality, feed, targetClient, { albums });
  });
}

/** The item's delay profile, picked the way the scheduled search picks it: the first tag-scoped
 * profile matching one of its tags (in saved order), else the untagged default. An announce is
 * seconds old, so any positive delay holds it back (the scheduled search grabs the release once it
 * has aged past the delay) unless the profile lets a cutoff-quality release bypass the delay. */
async function delayProfileHoldsBack(
  mediaItemId: number,
  protocol: IrcFeedRow["protocol"],
  quality: string,
  cutoff: string | null,
  ranking: ProfileRanking = GLOBAL_RANKING
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
  return !(profile.bypass_if_highest_quality && cutoff && sameQualityGroup(quality, cutoff, ranking));
}

async function tryGrabMatch(
  item: any,
  episodeId: number | null,
  subItemId: number | null,
  releaseTitle: string,
  downloadUrl: string,
  quality: string,
  feed: IrcFeedRow,
  targetClient: DownloadClient,
  /** A discography: the artist's albums as it is judged against them. It is for those albums, not for the artist's own file. */
  discography?: { albums: DiscographyAlbum[] }
): Promise<boolean> {
  const profileRow = item.qualityProfileId ? await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId) : null;
  const profile = profileRow ? qualityProfileFromRow(profileRow) : null;
  // Types without quality tiers (books, ROMs...) still carry a video-tier profile that no announce
  // for them could match; the scheduled search ignores it for them too.
  const tiered = usesQualityTiers(item.type);
  const allowedQualities = tiered ? profile?.allowedQualities ?? [] : [];
  if (allowedQualities.length > 0 && !allowedQualities.includes(quality)) return false;

  // A target that has its file is replaced only by a real upgrade, with auto-upgrade on and the profile allowing it.
  const onDisk = discography ? undefined : await existingFileQuality(item, episodeId, subItemId);
  const existingFile = onDisk === undefined ? null : await existingFileRecord(item, episodeId, subItemId);
  if (onDisk !== undefined && (!tiered || !existingFile || getSetting("autoUpgradeEnabled") !== "1")) return false;

  const blocklisted = await getBlocklistedTitles(item.id);
  // An announce carries only a name and the feed's protocol: no hash, date or size to compare.
  if (blocklisted.blocks({ title: releaseTitle, protocol: feed.protocol, indexerId: null, size: 0, publishDate: null, infoHash: null })) return false;

  if (await isRootFolderOverQuota(item.rootFolderId)) {
    log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}" for "${item.title}": its root folder is at/over its configured quota or below its minimum free space`);
    return false;
  }

  if (await delayProfileHoldsBack(item.id, feed.protocol, quality, tiered ? profile?.cutoff ?? null : null, rankingOf(profile))) {
    log.info(`[irc:${feed.name}] not grabbing "${releaseTitle}" for "${item.title}": held back by its delay profile`);
    // The scheduled search grabs it once it has aged, so the target must be due for one at the next cycle.
    if (discography) await wakeSeason(item.id, DISCOGRAPHY_SEARCH_KEY);
    else await wakeLeaf(episodeId ? "episodes" : subItemId ? "sub_items" : "media_items", episodeId ?? subItemId ?? item.id);
    return false;
  }

  const { totalScore, rejected } = await scoreRelease(releaseTitle, null, item.qualityProfileId, item.type, null, item.id);
  if (rejected || totalScore < (tiered ? profile?.minFormatScore ?? 0 : 0)) return false;
  if (existingFile) {
    const verdict = judgeUpgrade(upgradeProfileOf(profile), propersMode(), existingFile, { quality, title: releaseTitle, score: totalScore });
    if (verdict !== "yes") return false;
  }

  const result: SearchResult = {
    indexerId: null,
    indexerName: `irc:${feed.name}`,
    title: releaseTitle,
    size: 0,
    seeders: null,
    leechers: null,
    publishDate: null, // the announce's own time is not the post's date; blocklist entries match on size and title instead
    downloadUrl,
    protocol: feed.protocol,
    category: null,
  };
  const chosen: ChosenResult = { result, quality };
  // A client scoped to tags takes only titles carrying one of them; the one picked before the title was known may not.
  const clientForTitle = pickClientForProtocol(await rowsToDownloadClients(), feed.protocol, { itemTags: await tagIdsOfItem(item.id) }) ?? null;
  if (!clientForTitle) return false;
  const grabbed = discography
    ? await grabDiscography(clientForTitle, item, chosen, discography.albums, AUTOMATIC_DISCOGRAPHY_JUDGE, "irc")
    : await grab(clientForTitle, item, episodeId, subItemId, chosen, 0, null, "irc");
  if (grabbed) log.info(`[irc:${feed.name}] instant-grabbed "${releaseTitle}" for "${item.title}"`);
  return grabbed;
}
