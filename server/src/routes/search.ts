import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import {
  downloadClientFromRow,
  indexerFromRow,
  mediaItemFromRow,
  qualityProfileFromRow,
  queueItemFromRow,
} from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { searchAllIndexers } from "../services/indexerClient.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode, type SceneIndex } from "../services/releaseParser.js";
import { sceneIndexFor } from "../services/sceneNumbering.js";
import { notifyGrabbed } from "../services/notifications.js";
import { notifyQueueChanged } from "../services/realtime.js";
import { scoreRelease } from "../services/customFormatScoring.js";
import { log } from "../services/logger.js";
import { knownReleaseSize, qualityRank, sizeWithinQualityBounds, usesQualityTiers } from "../services/quality.js";
import { releaseRuntimeMinutes, runtimeContextFor } from "../services/releaseRuntime.js";
import { compareUsenetAge, comparePeers, protocolGroup, protocolPreferenceKey } from "../services/releaseRanking.js";
import { getBlocklistedTitles, isBlocklisted } from "../services/blocklist.js";
import { isBlockedRelease } from "../services/blocklistMatch.js";
import {
  chooseBestResult,
  existingFileQuality,
  loadDelayProfiles,
  matchTierFor,
  pickDelayProfile,
  rowsToDownloadClients,
  tagIdsForMediaItem,
  targetIdentityOf,
  type TargetIdentity,
} from "../services/scheduler.js";
import { episodePlanFor, searchHintsOf, seasonPlanFor, singlePlanFor, subItemPlanFor, type SearchPlan } from "../services/searchPlan.js";
import { identityModeFor, releaseIdentifiesTarget } from "../services/releaseIdentity.js";
import { releaseRejection } from "../services/releaseRejections.js";
import { aliasTitlesFor, identityContextFor, identityTargetFor } from "../services/releaseAliases.js";
import { searchSlskd } from "../services/soulseek.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { pickClientForProtocol, searchAndGrabTargets, type BulkSearchTarget } from "../services/scheduler.js";
import { computeAbsoluteEpisodeNumber } from "../services/importer.js";
import { existingFileRecord } from "../services/fileRelease.js";
import { judgeUpgrade, propersMode, upgradeProfileOf } from "../services/upgradeRules.js";
import { getQualityProfile, releaseNameVerdict, siblingTitlesOf, yearFieldsOf, type TargetName } from "../services/scheduler.js";
import type { SearchResult } from "../types/index.js";

export const searchRouter = Router();
searchRouter.use(requireAdmin);

/** Bulk search: POST /api/search/bulk — body: { targets: BulkSearchTarget[] }. Runs sequentially
 * (each target does a full indexer search) and returns per-target results, backing the
 * Library/Missing pages' multi-select "Search selected" action. */
searchRouter.post(
  "/bulk",
  asyncHandler(async (req, res) => {
    const targets: BulkSearchTarget[] = req.body?.targets;
    if (!Array.isArray(targets) || targets.length === 0) throw new HttpError(400, "targets is required");
    if (targets.length > 100) throw new HttpError(400, "Too many targets in one bulk search (max 100)");
    const results = await searchAndGrabTargets(targets);
    res.json(results);
  })
);

/** "PROPER", "REPACK", "v2", "REAL PROPER" for a release's revision, null for the original. */
function revisionLabelOf(revision: ReturnType<typeof parseReleaseTitle>["revision"]): string | null {
  if (!revision || (revision.version <= 1 && revision.real === 0)) return null;
  const parts: string[] = [];
  if (revision.real > 0) parts.push("REAL");
  parts.push(revision.isRepack ? "REPACK" : revision.version >= 2 ? "PROPER / v" + revision.version : "");
  return parts.filter(Boolean).join(" ") || null;
}

export interface AnnotatedSearchResult extends SearchResult {
  parsedQuality: string;
  matchesTarget: boolean;
  allowedByProfile: boolean;
  sizeAllowed: boolean;
  formatScore: number;
  formatMatches: string[];
  /** 2 = this release's own reported/title-embedded external id matches the target's; 1 = its
   * parsed year matches; 0 = neither (or not applicable — a sub-item search, which confirms
   * identity by the sub-item's title instead). See scheduler.ts's matchTierFor. */
  matchTier: number;
  /** The identity gate's verdict (services/releaseIdentity.ts) for a quality-tiered type: whether
   * the release names this item at all, how it matched, and why not. Always true/null for a type
   * the gate doesn't judge (music, books, ...). Automatic search rejects a false verdict when the
   * type's `strictReleaseIdentity` mode is `enforce`; a manual grab is refused once with the reason
   * (409) and goes through when repeated with `force: true`. */
  identityOk: boolean;
  identityMatch: string | null;
  identityReason: string | null;
  /** Which check a rejected release failed: only a title rejection is something an alias can fix. */
  identityRejection: "title" | "year" | null;
  /** The title the parser read from the release name — what "add as an alias" would store. */
  parsedTitle: string;
  blocklisted: boolean;
  /** The one release an automatic search of this target would grab (same rejections, quality tier,
   * format score and tie-breaks), so the list can show it first. Always false for a season-only or
   * album/book search, which have no single automatic pick. */
  wouldAutoGrab: boolean;
  rejected: boolean;
  rejectReason?: string;
  /** For an album, book or comic issue search: whether the release names the sub-item, and why not (N18). */
  nameOk: boolean;
  nameReason: string | null;
  /** For a target that already has a file: whether this release would replace it ("yes" / "no"), by the rules of
   * upgradeRules.ts (quality below the cutoff, a later revision, a format-score gain). Null when there is no file. */
  upgrade: "yes" | "no" | null;
  /** PROPER / REPACK / v2 and the like, as the parser reads it. */
  revisionLabel: string | null;
  /** Other indexers that also carry what looks like this exact same release (same normalized
   * title + exact size) — collapsed into the best-ranked copy instead of showing N separate rows
   * for what's really one release someone happened to post to multiple trackers. */
  alsoOnIndexers?: string[];
}

/** Same normalization releaseParser.ts-adjacent code doesn't already do: lowercase, collapse all
 * whitespace/punctuation runs to a single space, trim. Deliberately coarse (not the same as
 * releaseGroup/quality parsing) — this only needs to tell "basically the same release" apart from
 * "a different release", not extract structured fields from it. */
function normalizeForDedup(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Collapses near-identical releases (same normalized title, same exact size) posted to more than
 * one indexer into a single row — keeps whichever copy sorted first (the caller's own ranking
 * already puts the best copy first), and records the rest as `alsoOnIndexers`. Size must match
 * exactly (not fuzzy) — two different releases can coincidentally share a title. A `size` of 0
 * isn't a real measured size, though — several indexer adapters use it as a "size unknown"
 * sentinel when an indexer doesn't report one — so two different size-less releases would
 * otherwise collide on title alone; fall back to the download URL to tell them apart in that case. */
function dedupeResults(results: AnnotatedSearchResult[]): AnnotatedSearchResult[] {
  const byKey = new Map<string, AnnotatedSearchResult>();
  const order: string[] = [];
  for (const r of results) {
    const key = r.size > 0 ? `${normalizeForDedup(r.title)}::${r.size}` : `${normalizeForDedup(r.title)}::0::${r.downloadUrl}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      order.push(key);
    } else if (r.indexerName && r.indexerName !== existing.indexerName) {
      (existing.alsoOnIndexers ??= []).push(r.indexerName);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Manual search: GET /api/search/:mediaItemId?episodeId=&subItemId=
 * For series/artist/author, passing episodeId or subItemId narrows the query to that specific
 * episode/album/book and flags which results actually match it (season packs still surface,
 * just annotated). Results are annotated with parsed quality and whether the profile allows it.
 */
searchRouter.get(
  "/:mediaItemId",
  asyncHandler(async (req, res) => {
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    let plan: SearchPlan;
    // What Soulseek is asked: the metadata titles as they are, not the scene-cleaned query the indexers get.
    let slskdQuery = item.year ? `${item.title} ${item.year}` : item.title;
    let targetSeason: number | null = null;
    let targetEpisode: number | null = null;
    let targetSceneSeason: number | null = null;
    let targetSceneEpisode: number | null = null;
    let targetAbsoluteEpisode: number | null = null;
    let targetSceneIndex: SceneIndex | undefined;
    let targetAirDate: string | null = null;
    /** The other plans a season search runs: a scene may have split one aired season into several. */
    const furtherPlans: SearchPlan[] = [];
    let sceneSeasons: Set<number> | null = null;
    let subName: TargetName | null = null;

    const episodeId = req.query.episodeId as string | undefined;
    const subItemId = req.query.subItemId as string | undefined;
    const seasonNumberParam = req.query.seasonNumber as string | undefined;

    if (episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
      if (!ep) throw new HttpError(404, "Episode not found");
      // The same query, typed search and target an automatic search of this episode makes: the
      // scene-numbered (TheXEM) query where the show has one, a daily show's date, an anime's
      // absolute number.
      plan = await episodePlanFor(item, ep);
      targetSeason = ep.season_number;
      targetEpisode = ep.episode_number;
      targetSceneSeason = ep.scene_season_number;
      targetSceneEpisode = ep.scene_episode_number;
      targetSceneIndex = await sceneIndexFor(item.id);
      if (plan.target && "airDate" in plan.target) targetAirDate = plan.target.airDate;
      else if (plan.target) targetAbsoluteEpisode = plan.target.absoluteEpisode ?? null;
      slskdQuery = plan.query;
    } else if (seasonNumberParam) {
      // Season-only (no specific episode) — surfaces full-season pack releases, which a
      // per-episode query wouldn't reliably match against.
      targetSeason = Number(seasonNumberParam);
      // Every season number a release may call this season by: the scene's (TheXEM) where the show has one.
      const rows = (await db
        .prepare("SELECT DISTINCT scene_season_number FROM episodes WHERE media_item_id = ? AND season_number = ?")
        .all(item.id, targetSeason)) as { scene_season_number: number | null }[];
      // Sorted here, not by the database (which puts NULL first or last by driver): the lowest is the main query.
      const scenes = Array.from(new Set(rows.map((r) => (r.scene_season_number == null ? targetSeason! : Number(r.scene_season_number))))).sort((a, b) => a - b);
      if (scenes.length === 0) scenes.push(targetSeason);
      sceneSeasons = new Set([targetSeason, ...scenes]);
      plan = await seasonPlanFor(item, scenes[0]);
      for (const scene of scenes.slice(1)) furtherPlans.push(await seasonPlanFor(item, scene));
      slskdQuery = plan.query;
    } else if (subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
      if (!sub) throw new HttpError(404, "Sub-item not found");
      plan = subItemPlanFor(item, sub);
      slskdQuery = `${item.title} ${sub.title}`;
      subName = { title: sub.title, parentTitle: item.title, siblingTitles: await siblingTitlesOf(item, sub.id), ...(await yearFieldsOf(item, sub)) };
    } else {
      // Only meaningful for the plain whole-item search (no episode/season/sub-item target) — an
      // episodic/collection search already confirms identity via season/episode/sub-item title
      // matching instead. See scheduler.ts's chooseBestResult/matchTierFor for how the ids are used:
      // a preference among already-viable results, never a filter.
      plan = await singlePlanFor(item);
    }
    const query = plan.query;

    const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(
      indexerFromRow
    );
    const rawResults = await searchAllIndexers(indexers as any, query, item.type as any, true, plan.ids, searchHintsOf(plan));
    if (furtherPlans.length > 0) {
      // The queries of a season a scene splits overlap (a pack named by both): a release is listed once.
      const seen = new Set(rawResults.map((r) => `${r.indexerId ?? r.indexerName}:${r.downloadUrl || `${r.title}:${r.size}`}`));
      for (const further of furtherPlans) {
        for (const r of await searchAllIndexers(indexers as any, further.query, item.type as any, true, further.ids, searchHintsOf(further))) {
          const key = `${r.indexerId ?? r.indexerName}:${r.downloadUrl || `${r.title}:${r.size}`}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rawResults.push(r);
        }
      }
    }

    // Soulseek has no Torznab-style indexer — a configured, enabled slskd client is queried
    // directly instead and its results merged in alongside the indexer ones. Music-shaped
    // libraries only, since (user, filename) results from Soulseek only make sense there.
    if (item.type === "artist") {
      const slskdClients = ((await db.prepare("SELECT * FROM download_clients WHERE type = 'slskd' AND enabled = 1").all()) as any[]).map(
        downloadClientFromRow
      );
      for (const client of slskdClients) {
        try {
          rawResults.push(...(await searchSlskd(client as any, slskdQuery)));
        } catch (err) {
          log.warn(`[search] slskd client "${client.name}" search failed:`, (err as Error).message);
        }
      }
    }

    let allowedQualities: string[] = [];
    let cutoff = "";
    let minFormatScore = 0;
    if (item.qualityProfileId) {
      const profileRow = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId);
      if (profileRow) {
        const profile = qualityProfileFromRow(profileRow);
        allowedQualities = profile.allowedQualities;
        cutoff = profile.cutoff;
        minFormatScore = profile.minFormatScore ?? 0;
      }
    }

    const blocklisted = await getBlocklistedTitles(item.id);
    // Same auto-grab rules as chooseBestResult: a type with no quality tiers (music, books, ...)
    // takes any quality, and a size of 0 means the indexer didn't report one.
    const tiered = usesQualityTiers(item.type);
    // The item's identity (year + ids) for whole-item and episode/season searches alike: the
    // identity gate below compares every release's title and year against it, and matchTierFor
    // prefers an id/year-confirmed release among the viable ones. A sub-item (album/book) search
    // confirms identity by the sub-item's own title instead, so identity stays null there.
    const identity: TargetIdentity | null = !subItemId ? targetIdentityOf(item) : null;
    const identityTarget = tiered && identity ? { type: item.type, title: item.title, year: identity.year, externalIds: identity.externalIds, aliases: await aliasTitlesFor(item.id), ...(await identityContextFor(item.id)) } : null;
    // What an automatic search of this target would grab, by the same decision code: the admin's own
    // search is not delayed, and the file the target already has is only replaced by a real upgrade.
    const delayProfile = pickDelayProfile(await loadDelayProfiles(), await tagIdsForMediaItem(item.id));
    const hasAutoPick = !seasonNumberParam && !subItemId && (!!plan.target || getMediaTypeConfig(item.type).shape === "single");
    let autoPick: SearchResult | null = null;
    if (hasAutoPick && rawResults.length > 0) {
      const onDisk = await existingFileQuality(item, episodeId ? Number(episodeId) : null, null);
      autoPick =
        (
          await chooseBestResult(
            rawResults,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            plan.target ?? null,
            blocklisted,
            item.type,
            delayProfile,
            identity,
            item.id,
            {
              clients: await rowsToDownloadClients(),
              upgradeFromRank: onDisk === undefined ? null : qualityRank(onDisk),
              name: { title: item.title },
              indexers,
              userInvoked: true,
              label: item.title,
            }
          )
        )?.result ?? null;
    }
    const runtimeContext = await runtimeContextFor(item.id, item.type);
    // The file the target already has and the profile's upgrade rules, for the "would replace it" label.
    const existingForUpgrade =
      tiered && !seasonNumberParam && !subItemId
        ? await existingFileRecord(item, episodeId ? Number(episodeId) : null, null)
        : null;
    const upgradeProfile = existingForUpgrade ? upgradeProfileOf(item.qualityProfileId ? await getQualityProfile(item.qualityProfileId) : null) : null;
    const revisionMode = propersMode();
    const nameFields = (title: string) => {
      const verdict = subName && !tiered ? releaseNameVerdict(title, subName, item.type) : { ok: true, reason: null };
      return { nameOk: verdict.ok, nameReason: verdict.reason };
    };
    const annotated: AnnotatedSearchResult[] = await Promise.all(rawResults.map(async (r) => {
      const parsed = parseReleaseTitle(r.title);
      const matchesTarget =
        targetAirDate !== null
          ? releaseMatchesAirDate(parsed, targetAirDate) ||
            (targetSeason !== null && targetEpisode !== null && releaseMatchesEpisode(parsed, targetSeason, targetEpisode, targetSceneSeason, targetSceneEpisode, null, targetSceneIndex))
          : targetSeason !== null && targetEpisode !== null
            ? releaseMatchesEpisode(parsed, targetSeason, targetEpisode, targetSceneSeason, targetSceneEpisode, targetAbsoluteEpisode, targetSceneIndex)
            : targetSeason !== null
              ? sceneSeasons
                ? parsed.seasonNumber != null && sceneSeasons.has(parsed.seasonNumber)
                : parsed.seasonNumber === targetSeason
              : true;
      const verdict = identityTarget ? releaseIdentifiesTarget(r, parsed, identityTarget) : null;
      const size = knownReleaseSize(r.size);
      // The same refusals an automatic grab applies (multi-season packs, split seasons, disc images,
      // samples, burned-in subtitles); the user may still pick the release by hand.
      const refusal = releaseRejection(parsed, { title: r.title, size }, item.type);
      const { totalScore, matches, rejected, rejectReason } = await scoreRelease(
        r.title,
        size,
        item.qualityProfileId,
        item.type,
        r.downloadVolumeFactor ?? null,
        item.id,
        r.indexerId ?? null
      );
      return {
        ...r,
        parsedQuality: parsed.quality,
        matchesTarget,
        allowedByProfile: !tiered || allowedQualities.length === 0 || allowedQualities.includes(parsed.quality),
        sizeAllowed: !tiered || sizeWithinQualityBounds(parsed.quality, size, runtimeContext ? releaseRuntimeMinutes(parsed, runtimeContext) : null),
        formatScore: totalScore,
        formatMatches: matches.map((m) => m.name),
        matchTier: matchTierFor(r, identity),
        identityOk: verdict ? verdict.ok : true,
        identityMatch: verdict?.matchType ?? null,
        identityReason: verdict && !verdict.ok ? verdict.detail : null,
        identityRejection: verdict && !verdict.ok ? verdict.reason : null,
        parsedTitle: parsed.title,
        blocklisted: isBlockedRelease(blocklisted, r),
        wouldAutoGrab: autoPick === r,
        ...nameFields(r.title),
        upgrade:
          existingForUpgrade && upgradeProfile
            ? judgeUpgrade(upgradeProfile, revisionMode, existingForUpgrade, { quality: parsed.quality, title: r.title, score: totalScore }) === "yes"
              ? "yes"
              : "no"
            : null,
        revisionLabel: revisionLabelOf(parsed.revision),
        rejected: rejected || parsed.rejected || !!refusal,
        rejectReason: parsed.rejected ? "The release name is a hash, so there is no title to check it against" : refusal ? refusal.reason : rejectReason,
      };
    }));

    // Previously returned in whatever order the indexer itself gave back — an indexer's own
    // relevance ranking has no idea what "matches this specific season/episode" or "meets this
    // profile" mean, so an unrelated show whose title happens to share a word (or a wrong-season
    // episode of the right show) could easily outrank the actual target. Sort by the same signals
    // an automatic grab already weighs — real match first, then profile-allowed, not blocklisted,
    // format score, then seeders — so the top of the list is what auto-search would actually pick,
    // not just whatever the indexer happened to return first.
    const priorityById = new Map(indexers.map((i: any) => [i.id, i.priority]));
    const priorityOf = (r: SearchResult) => priorityById.get(r.indexerId ?? -1) ?? 25;
    const preferredProtocol = delayProfile?.preferredProtocol ?? "none";
    annotated.sort(
      (a, b) =>
        Number(b.matchesTarget) - Number(a.matchesTarget) ||
        Number(b.identityOk) - Number(a.identityOk) ||
        Number(b.nameOk) - Number(a.nameOk) ||
        Number(b.allowedByProfile) - Number(a.allowedByProfile) ||
        Number(a.rejected) - Number(b.rejected) ||
        Number(a.blocklisted) - Number(b.blocklisted) ||
        Number(b.wouldAutoGrab) - Number(a.wouldAutoGrab) ||
        (tiered ? qualityRank(b.parsedQuality) - qualityRank(a.parsedQuality) : 0) ||
        b.formatScore - a.formatScore ||
        b.matchTier - a.matchTier ||
        protocolPreferenceKey(preferredProtocol, b.protocol) - protocolPreferenceKey(preferredProtocol, a.protocol) ||
        priorityOf(a) - priorityOf(b) ||
        protocolGroup(a.protocol) - protocolGroup(b.protocol) ||
        comparePeers(a, b) ||
        compareUsenetAge(a, b) ||
        (a.protocol === "torrent" && b.protocol === "torrent" ? (b.seeders ?? 0) - (a.seeders ?? 0) : 0)
    );

    res.json(dedupeResults(annotated));
  })
);

/** Manual grab: POST /api/search/:mediaItemId/grab */
searchRouter.post(
  "/:mediaItemId/grab",
  asyncHandler(async (req, res) => {
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    const b = req.body ?? {};
    if (!b.downloadUrl) throw new HttpError(400, "downloadUrl is required");
    if (
      b.title &&
      (await isBlocklisted(Number(req.params.mediaItemId), {
        title: b.title,
        protocol: b.protocol === "usenet" || b.protocol === "torrent" || b.protocol === "http" || b.protocol === "slskd" ? b.protocol : undefined,
        indexerId: b.indexerId ?? null,
        size: Number(b.size) || 0,
        publishDate: typeof b.publishDate === "string" ? b.publishDate : null,
        infoHash: typeof b.infoHash === "string" ? b.infoHash : null,
      }))
    ) {
      throw new HttpError(400, "This release is blocklisted for this media item");
    }

    // A manual grab records how the release matched like an automatic grab's (grab_source tells
    // the two apart). While the type's gate enforces, a release the gate would reject is refused
    // once with the reason (409) so the admin can confirm; `force: true` grabs it anyway. The
    // verdict is settled before the download client is touched, so a refused grab leaves nothing
    // in the client and the confirmed retry adds the release exactly once.
    const parsedTitle = parseReleaseTitle(b.title ?? "");
    const verdict =
      b.title && usesQualityTiers(item.type) && !b.subItemId
        ? releaseIdentifiesTarget(
            { title: b.title, imdbId: b.imdbId ?? null, tmdbId: b.tmdbId ?? null, tvdbId: b.tvdbId ?? null },
            parsedTitle,
            await identityTargetFor(item)
          )
        : null;
    if (verdict && !verdict.ok && !b.force && identityModeFor(item.type) === "enforce") {
      throw new HttpError(409, `${verdict.detail}. Grab it anyway, or add the release's title as an alias of this item.`);
    }

    // Either an explicit client id, or (the UI's normal path) the release's protocol — an NZB
    // handed to qBittorrent, or a torrent to a disabled client, just fails at the client.
    const protocol =
      b.protocol === "usenet" || b.protocol === "torrent" || b.protocol === "http" || b.protocol === "slskd" ? b.protocol : "torrent";
    let clientRow: unknown;
    if (b.downloadClientId) {
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(b.downloadClientId);
      if (!clientRow) throw new HttpError(404, "Download client not found");
    } else {
      const enabled = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1 ORDER BY id").all()) as any[]).map(downloadClientFromRow);
      if (enabled.length === 0) throw new HttpError(400, "Add and enable a download client first");
      const picked = pickClientForProtocol(enabled as any, protocol);
      if (!picked) throw new HttpError(400, `No enabled download client can handle a "${protocol}" release`);
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(picked.id);
    }
    const client = downloadClientFromRow(clientRow) as any;

    const adapter = getDownloadClientAdapter(client.type);
    const grab = await adapter.addDownload(client, b.downloadUrl, client.category, b.title, protocol);
    // queue.size is BIGINT: Postgres rejects a fractional size after the client already took the download.
    const size = b.size == null || !Number.isFinite(Number(b.size)) ? null : Math.round(Number(b.size));
    const quality = parsedTitle.quality;
    // A full-season pack grabbed for one episode is recorded against its season too, so the rest of
    // that season counts as queued (see scheduler.ts isAlreadyQueued) and the importer places it all.
    let seasonNumber: number | null = b.episodeId ? null : (b.seasonNumber ?? null);
    if (b.episodeId && parsedTitle.isFullSeason) {
      const ep = (await db.prepare("SELECT season_number FROM episodes WHERE id = ?").get(b.episodeId)) as { season_number: number } | undefined;
      if (ep && (parsedTitle.seasonNumber == null || parsedTitle.seasonNumber === ep.season_number)) seasonNumber = ep.season_number;
    }

    const result = await db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, season_number, title, indexer_id, download_client_id, download_id, size, quality, status, match_type, grab_source, protocol, publish_date, info_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'interactive', ?, ?, ?)`
      )
      .run(
        req.params.mediaItemId,
        b.episodeId ?? null,
        b.subItemId ?? null,
        seasonNumber,
        b.title ?? "Unknown release",
        b.indexerId ?? null,
        client.id,
        grab.downloadId,
        size,
        quality,
        verdict?.matchType ?? null,
        protocol,
        typeof b.publishDate === "string" ? b.publishDate : null,
        typeof b.infoHash === "string" ? b.infoHash : null
      );

    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      req.params.mediaItemId,
      JSON.stringify(b)
    );

    notifyGrabbed(item.title, b.title ?? "Unknown release").catch((err) =>
      log.warn("[search] notification failed:", err.message)
    );
    notifyQueueChanged();

    const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(queueItemFromRow(queueRow));
  })
);
